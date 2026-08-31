import { describe, expect, it, vi } from 'vitest';
import { SAFETY_RULES, SafetyEngine } from '../../src/services/safety.ts';
import { makeCampaign, makeContact, makeSafetyContext } from '../helpers/fixtures.ts';

const engine = new SafetyEngine();

describe('SafetyEngine — the happy path', () => {
  it('allows a dial when every rule passes', () => {
    const decision = engine.canInitiateCall(makeSafetyContext());
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('ALLOWED');
  });
});

describe('SafetyEngine — absolute prohibitions', () => {
  it('denies everything while emergency stop is engaged', () => {
    const decision = engine.canInitiateCall(makeSafetyContext({ emergencyStopped: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('EMERGENCY_STOP');
  });

  it('reports emergency stop even when other rules would also deny', () => {
    // Rule order is a design decision: the reason surfaced should be the most fundamental
    // one, not whichever incidental limit happened to be hit.
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        emergencyStopped: true,
        concurrency: { global: 50, globalMax: 50, campaign: 99, provider: 99, providerMax: 40 },
        contact: makeContact({ status: 'DO_NOT_CALL' }),
      }),
    );
    expect(decision.code).toBe('EMERGENCY_STOP');
  });

  it('denies a campaign that is not RUNNING', () => {
    for (const status of ['DRAFT', 'READY', 'PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'] as const) {
      const decision = engine.canInitiateCall(
        makeSafetyContext({ campaign: makeCampaign({ status }) }),
      );
      expect(decision.allowed, status).toBe(false);
      expect(decision.code, status).toBe('CAMPAIGN_NOT_RUNNING');
    }
  });

  it('never dials a DO_NOT_CALL contact', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({ contact: makeContact({ status: 'DO_NOT_CALL' }) }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('CONTACT_DO_NOT_CALL');
  });

  it('denies a DO_NOT_CALL contact even with capacity to spare and nothing else wrong', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        contact: makeContact({ status: 'DO_NOT_CALL', attemptCount: 0 }),
        agents: { available: 100, pendingConnections: 0 },
        concurrency: { global: 0, globalMax: 999, campaign: 0, provider: 0, providerMax: 999 },
      }),
    );
    expect(decision.code).toBe('CONTACT_DO_NOT_CALL');
  });

  it('keeps predictive dialing paused until explicitly resumed', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        campaign: makeCampaign({ predictivePausedReason: 'abandon rate 9% exceeded 3%' }),
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('ABANDON_RATE_EXCEEDED');
    expect(decision.metadata['requiresExplicitResume']).toBe(true);
  });
});

describe('SafetyEngine — contact eligibility', () => {
  it('accepts a reserved contact', () => {
    expect(
      engine.canInitiateCall(makeSafetyContext({ contact: makeContact({ status: 'RESERVED' }) }))
        .allowed,
    ).toBe(true);
  });

  it('rejects a contact in any other state', () => {
    for (const status of ['DIALING', 'CONNECTED', 'COMPLETED', 'EXHAUSTED', 'RETRY_PENDING'] as const) {
      const decision = engine.canInitiateCall(
        makeSafetyContext({ contact: makeContact({ status }) }),
      );
      expect(decision.allowed, status).toBe(false);
      expect(decision.code, status).toBe('CONTACT_NOT_ELIGIBLE');
    }
  });

  it('stops at the attempt limit', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({ contact: makeContact({ attemptCount: 3 }) }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(decision.metadata).toMatchObject({ attemptCount: 3, maxAttempts: 3 });
  });

  it('allows the final permitted attempt', () => {
    expect(
      engine.canInitiateCall(makeSafetyContext({ contact: makeContact({ attemptCount: 2 }) }))
        .allowed,
    ).toBe(true);
  });

  it('honours a backoff that has not elapsed', () => {
    const notDue = engine.canInitiateCall(
      makeSafetyContext({ now: 1000, contact: makeContact({ nextAttemptAt: 5000 }) }),
    );
    expect(notDue.code).toBe('RETRY_NOT_DUE');

    const due = engine.canInitiateCall(
      makeSafetyContext({ now: 5000, contact: makeContact({ nextAttemptAt: 5000 }) }),
    );
    expect(due.allowed).toBe(true);
  });

  it('skips contact rules when asked about the campaign alone', () => {
    expect(engine.canInitiateCall(makeSafetyContext({ contact: null })).allowed).toBe(true);
  });
});

describe('SafetyEngine — agent capacity', () => {
  it('denies dialing with no free agents', () => {
    // Dialing into zero capacity is how calls get answered with nobody to take them.
    const decision = engine.canInitiateCall(
      makeSafetyContext({ agents: { available: 0, pendingConnections: 0 } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('AGENT_CAPACITY_EXCEEDED');
  });

  it('allows one line per free agent in progressive mode', () => {
    const context = (pendingConnections: number) =>
      makeSafetyContext({
        campaign: makeCampaign({ dialingMode: 'PROGRESSIVE' }),
        agents: { available: 3, pendingConnections },
      });

    expect(engine.canInitiateCall(context(2)).allowed).toBe(true);
    expect(engine.canInitiateCall(context(3)).allowed).toBe(false);
    expect(engine.canInitiateCall(context(3)).code).toBe('AGENT_CAPACITY_EXCEEDED');
  });

  it('allows over-dialing up to the ceiling in predictive mode', () => {
    const context = (pendingConnections: number) =>
      makeSafetyContext({
        campaign: makeCampaign({
          dialingMode: 'PREDICTIVE',
          safety: { ...makeCampaign().safety, maxLinesPerAgent: 3 },
        }),
        agents: { available: 2, pendingConnections },
      });

    // 2 agents x 3 lines = 6 permitted.
    expect(engine.canInitiateCall(context(5)).allowed).toBe(true);
    expect(engine.canInitiateCall(context(6)).allowed).toBe(false);
  });

  it('caps a runaway pacing request regardless of what the strategy asked for', () => {
    // The strategy decides how many to place; this decides how many are permitted. A pacing
    // bug must not be able to over-dial past the ceiling.
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        campaign: makeCampaign({ dialingMode: 'PREDICTIVE' }),
        agents: { available: 1, pendingConnections: 50 },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.metadata['ceiling']).toBe(3);
  });
});

describe('SafetyEngine — concurrency ceilings', () => {
  it('denies at the global limit', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        concurrency: { global: 50, globalMax: 50, campaign: 0, provider: 0, providerMax: 40 },
      }),
    );
    expect(decision.code).toBe('GLOBAL_CONCURRENCY_LIMIT');
    expect(decision.metadata).toMatchObject({ current: 50, maximum: 50 });
  });

  it('denies at the campaign limit, and says so explainably', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        campaign: makeCampaign({ maxConcurrentCalls: 4 }),
        concurrency: { global: 10, globalMax: 50, campaign: 4, provider: 0, providerMax: 40 },
      }),
    );
    expect(decision.code).toBe('CAMPAIGN_CONCURRENCY_LIMIT');
    expect(decision.message).toContain('maximum concurrent call limit');
    expect(decision.metadata).toMatchObject({
      campaignId: 'camp_1',
      currentConcurrency: 4,
      maximumConcurrency: 4,
    });
  });

  it('denies at the provider limit', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        concurrency: { global: 10, globalMax: 50, campaign: 1, provider: 40, providerMax: 40 },
      }),
    );
    expect(decision.code).toBe('PROVIDER_CONCURRENCY_LIMIT');
  });

  it('reports the most global limit first when several apply', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({
        campaign: makeCampaign({ maxConcurrentCalls: 1 }),
        concurrency: { global: 50, globalMax: 50, campaign: 1, provider: 40, providerMax: 40 },
      }),
    );
    expect(decision.code).toBe('GLOBAL_CONCURRENCY_LIMIT');
  });
});

describe('SafetyEngine — abandon rate', () => {
  it('ignores the rate below the minimum sample', () => {
    // One abandoned call out of one would otherwise read as 100% and stop a healthy campaign.
    const decision = engine.canInitiateCall(
      makeSafetyContext({ abandon: { rate: 1, sample: 1 } }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies once the rate exceeds the threshold with enough samples', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({ abandon: { rate: 0.09, sample: 50 } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('ABANDON_RATE_EXCEEDED');
    expect(decision.message).toContain('9.0%');
  });

  it('allows a rate exactly at the threshold', () => {
    expect(
      engine.canInitiateCall(makeSafetyContext({ abandon: { rate: 0.03, sample: 100 } })).allowed,
    ).toBe(true);
  });
});

describe('SafetyEngine — rate limiting', () => {
  it('denies when the bucket is empty', () => {
    const decision = engine.canInitiateCall(
      makeSafetyContext({ rateLimiter: { tryConsume: () => false, available: () => 0 } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('consumes exactly one token when the dial is allowed', () => {
    const tryConsume = vi.fn(() => true);
    engine.canInitiateCall(makeSafetyContext({ rateLimiter: { tryConsume, available: () => 5 } }));
    expect(tryConsume).toHaveBeenCalledTimes(1);
  });

  it('does not consume a token when an earlier rule denies', () => {
    // The reason the rate limiter is evaluated last. Consuming allowance for a dial that was
    // never permitted would make a campaign fall progressively behind its own rate for no
    // reason.
    const tryConsume = vi.fn(() => true);
    engine.canInitiateCall(
      makeSafetyContext({
        emergencyStopped: true,
        rateLimiter: { tryConsume, available: () => 5 },
      }),
    );
    expect(tryConsume).not.toHaveBeenCalled();
  });

  it('skips the rule entirely when no limiter is supplied', () => {
    expect(engine.canInitiateCall(makeSafetyContext({ rateLimiter: null })).allowed).toBe(true);
  });
});

describe('SafetyEngine — explain', () => {
  it('returns every reason, not just the first', () => {
    const denials = engine.explain(
      makeSafetyContext({
        emergencyStopped: true,
        campaign: makeCampaign({ status: 'PAUSED' }),
        contact: makeContact({ status: 'DO_NOT_CALL' }),
        agents: { available: 0, pendingConnections: 0 },
      }),
    );

    const codes = denials.map((d) => d.code);
    expect(codes).toContain('EMERGENCY_STOP');
    expect(codes).toContain('CAMPAIGN_NOT_RUNNING');
    expect(codes).toContain('CONTACT_DO_NOT_CALL');
    expect(codes).toContain('AGENT_CAPACITY_EXCEEDED');
  });

  it('returns nothing when everything passes', () => {
    expect(engine.explain(makeSafetyContext())).toEqual([]);
  });

  it('never consumes rate-limit allowance', () => {
    // Asking why a campaign is idle must not perturb the campaign being asked about.
    const tryConsume = vi.fn(() => true);
    engine.explain(makeSafetyContext({ rateLimiter: { tryConsume, available: () => 5 } }));
    expect(tryConsume).not.toHaveBeenCalled();
  });
});

describe('SafetyEngine — the policy itself', () => {
  it('publishes its rules in evaluation order', () => {
    const names = engine.describeRules().map((rule) => rule.name);
    expect(names[0]).toBe('emergency-stop');
    expect(names.at(-1)).toBe('rate-limit');
    expect(names).toContain('contact-do-not-call');
  });

  it('has a unique name and a description for every rule', () => {
    const names = SAFETY_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
    for (const rule of SAFETY_RULES) {
      expect(rule.description.length, rule.name).toBeGreaterThan(10);
    }
  });

  it('supports a custom rule set, so a campaign type could add a control', () => {
    const alwaysDeny = new SafetyEngine([
      {
        name: 'test-only',
        description: 'Denies everything.',
        evaluate: () => ({
          allowed: false,
          rule: 'test-only',
          code: 'CONFLICT',
          message: 'nope',
          metadata: {},
        }),
      },
    ]);
    expect(alwaysDeny.canInitiateCall(makeSafetyContext()).allowed).toBe(false);
  });
});
