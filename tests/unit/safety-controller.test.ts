import { describe, expect, it } from 'vitest';
import {
  SafetyController,
  type PacingRequest,
  type SafetyControllerContext,
} from '../../src/dialer/safety-controller.ts';
import { PredictiveDialer } from '../../src/dialer/predictive.ts';
import type { DialerSnapshot } from '../../src/dialer/strategy.ts';
import { makeCampaign } from '../helpers/fixtures.ts';

const controller = new SafetyController();

/** A context where nothing binds, so a test can constrain exactly one thing. */
function context(overrides: Partial<SafetyControllerContext> = {}): SafetyControllerContext {
  return {
    campaign: makeCampaign({ status: 'RUNNING' }),
    emergencyStopped: false,
    availableAgents: 50,
    pendingConnections: 0,
    campaignHeadroom: 999,
    globalHeadroom: 999,
    providerHeadroom: 999,
    rateLimitHeadroom: 999,
    remainingContacts: 999,
    abandonRate: 0,
    abandonSample: 0,
    answerRateSample: 500,
    providerFailureRate: 0,
    estimatedAnswerRate: 0.5,
    ...overrides,
  };
}

const ask = (requested: number, mode: 'PROGRESSIVE' | 'PREDICTIVE' = 'PREDICTIVE'): PacingRequest => ({
  campaignId: 'camp_1',
  mode,
  requested,
  reasoning: ['test'],
});

describe('SafetyController — the four verdicts', () => {
  it('APPROVES a request that is safe as asked', () => {
    const decision = controller.review(ask(15), context());
    expect(decision.verdict).toBe('APPROVED');
    expect(decision.approved).toBe(15);
    expect(decision.reductions).toEqual([]);
  });

  it('REDUCES a request that exceeds a ceiling, and says which one', () => {
    // "I think we can start 15 more calls" -> "you may start 4, because of the campaign limit".
    const decision = controller.review(ask(15), context({ campaignHeadroom: 4 }));
    expect(decision.verdict).toBe('REDUCED');
    expect(decision.approved).toBe(4);
    expect(decision.reductions.map((r) => r.control)).toContain('campaign concurrency');
    expect(decision.explanation).toContain('Reduced 15 to 4');
  });

  it('REJECTS when nothing may be dialled, with a cause', () => {
    const decision = controller.review(ask(15), context({ emergencyStopped: true }));
    expect(decision.verdict).toBe('REJECTED');
    expect(decision.approved).toBe(0);
    expect(decision.cause).toBe('EMERGENCY_STOP');
  });

  it('FALLS BACK to progressive when the predictive estimate is not trustworthy', () => {
    // Not a halt — a degrade. Progressive cannot abandon anyone, so it is the safe answer
    // when the bet underlying predictive stops being credible.
    const decision = controller.review(
      ask(40),
      context({ availableAgents: 10, answerRateSample: 3 }),
    );
    expect(decision.verdict).toBe('FALLBACK_PROGRESSIVE');
    expect(decision.cause).toBe('INSUFFICIENT_ANSWER_RATE_EVIDENCE');
    expect(decision.approved).toBe(10); // one line per free agent
  });
});

describe('SafetyController — absolute prohibitions come first', () => {
  it('reports emergency stop ahead of any capacity limit', () => {
    const decision = controller.review(
      ask(15),
      context({ emergencyStopped: true, campaignHeadroom: 0, globalHeadroom: 0 }),
    );
    expect(decision.cause).toBe('EMERGENCY_STOP');
  });

  it('rejects a campaign that is not RUNNING', () => {
    for (const status of ['DRAFT', 'READY', 'PAUSED', 'STOPPED', 'COMPLETED'] as const) {
      const decision = controller.review(ask(5), context({ campaign: makeCampaign({ status }) }));
      expect(decision.verdict, status).toBe('REJECTED');
      expect(decision.cause, status).toBe('CAMPAIGN_NOT_RUNNING');
    }
  });

  it('rejects while an abandon-rate pause is latched', () => {
    const decision = controller.review(
      ask(5),
      context({ campaign: makeCampaign({ status: 'RUNNING', predictivePausedReason: 'abandon 9%' }) }),
    );
    expect(decision.verdict).toBe('REJECTED');
    expect(decision.cause).toBe('ABANDON_RATE_EXCEEDED');
  });
});

describe('SafetyController — fallback triggers', () => {
  it('degrades when the provider is unhealthy', () => {
    // A provider that is refusing calls is not a provider whose answer statistics mean
    // anything, so the bet stops being justified before the provider stops working.
    const decision = controller.review(
      ask(40),
      context({ availableAgents: 8, providerFailureRate: 0.5 }),
    );
    expect(decision.verdict).toBe('FALLBACK_PROGRESSIVE');
    expect(decision.cause).toBe('PROVIDER_UNHEALTHY');
  });

  it('degrades as abandonment approaches the limit, before the hard stop', () => {
    const campaign = makeCampaign({ status: 'RUNNING', maxAbandonRate: 0.04 });
    const decision = controller.review(
      ask(40),
      context({ campaign, availableAgents: 8, abandonRate: 0.035, abandonSample: 100 }),
    );
    expect(decision.verdict).toBe('FALLBACK_PROGRESSIVE');
    expect(decision.cause).toBe('ABANDON_RATE_APPROACHING_LIMIT');
  });

  it('ignores an abandon rate below the minimum sample', () => {
    const campaign = makeCampaign({ status: 'RUNNING', maxAbandonRate: 0.03 });
    const decision = controller.review(
      ask(20),
      context({ campaign, abandonRate: 1, abandonSample: 2 }),
    );
    expect(decision.verdict).toBe('APPROVED');
  });

  it('never falls back for a progressive campaign — there is nothing to fall back to', () => {
    const decision = controller.review(
      ask(10, 'PROGRESSIVE'),
      context({ availableAgents: 10, answerRateSample: 0, providerFailureRate: 0.9 }),
    );
    expect(decision.verdict).not.toBe('FALLBACK_PROGRESSIVE');
  });
});

describe('SafetyController — ceilings', () => {
  it('applies every ceiling, not just the first that binds', () => {
    const decision = controller.review(
      ask(100),
      context({ campaignHeadroom: 40, globalHeadroom: 20, rateLimitHeadroom: 8, remainingContacts: 3 }),
    );
    expect(decision.approved).toBe(3);
    // Each ceiling that actually cut the number records itself, so "why only 3?" is
    // answerable from the decision alone.
    expect(decision.reductions.map((r) => r.control)).toContain('campaign concurrency');
    expect(decision.reductions.map((r) => r.control)).toContain('contacts remaining');
    expect(decision.reductions.at(-1)?.to).toBe(3);
  });

  it('bounds predictive by abandonment variance before any per-agent cap', () => {
    // The variance bound is tighter than `maxLinesPerAgent` in most realistic conditions, and
    // that ordering is the point: the limit that binds should be the one that actually
    // governs abandonment, not a blunt per-seat cap.
    const campaign = makeCampaign({
      status: 'RUNNING',
      safety: { ...makeCampaign().safety, maxLinesPerAgent: 3 },
    });
    const decision = controller.review(
      ask(100),
      context({ campaign, availableAgents: 5, estimatedAnswerRate: 0.5 }),
    );
    expect(decision.reductions[0]?.control).toBe('abandonment variance bound');
    expect(decision.approved).toBeLessThan(15);
    expect(decision.approved).toBeGreaterThanOrEqual(5);
  });

  it('falls back to the per-agent cap when the variance bound is looser', () => {
    // A very low answer rate makes the variance bound permissive; `maxLinesPerAgent` is then
    // the backstop that stops an unbounded over-dial.
    const campaign = makeCampaign({
      status: 'RUNNING',
      safety: { ...makeCampaign().safety, maxLinesPerAgent: 2 },
    });
    const decision = controller.review(
      ask(500),
      context({ campaign, availableAgents: 10, estimatedAnswerRate: 0.02 }),
    );
    expect(decision.approved).toBe(20);
    expect(decision.reductions.map((r) => r.control)).toContain('agent capacity');
  });

  it('caps progressive at one line per free agent', () => {
    // And the variance bound does not apply: progressive dials one line per seat, which
    // cannot abandon anyone, so there is no bet to bound.
    const decision = controller.review(
      ask(100, 'PROGRESSIVE'),
      context({ availableAgents: 5, estimatedAnswerRate: 0.5 }),
    );
    expect(decision.approved).toBe(5);
    expect(decision.reductions.map((r) => r.control)).not.toContain('abandonment variance bound');
  });

  it('subtracts calls already in flight from agent capacity', () => {
    const decision = controller.review(
      ask(100, 'PROGRESSIVE'),
      context({ availableAgents: 5, pendingConnections: 3 }),
    );
    expect(decision.approved).toBe(2);
  });

  it('rejects rather than approving zero', () => {
    const decision = controller.review(ask(10), context({ globalHeadroom: 0 }));
    expect(decision.verdict).toBe('REJECTED');
    expect(decision.approved).toBe(0);
  });

  it('approves nothing when nothing was asked for', () => {
    const decision = controller.review(ask(0), context());
    expect(decision.approved).toBe(0);
    expect(decision.verdict).toBe('APPROVED');
  });
});

describe('The pacing engine cannot bypass the controller', () => {
  /**
   * The structural property the assignment asks for. These are not tests of a behaviour so
   * much as tests of a *shape*: if a future change let a pacer clamp itself again, or gave it
   * a reference to something that could dial, these would still pass — which is why the last
   * one checks the source of the pacing modules directly.
   */
  function snapshot(overrides: Partial<DialerSnapshot> = {}): DialerSnapshot {
    return {
      now: 0,
      campaign: makeCampaign({ status: 'RUNNING' }),
      totalAgents: 50,
      availableAgents: 50,
      occupiedAgents: 0,
      activeCalls: 0,
      pendingConnections: 0,
      connectedCalls: 0,
      historicalAnswerRate: 0.1,
      recentAnswerRate: 0.1,
      recentSample: 500,
      abandonRate: 0,
      abandonSample: 0,
      campaignHeadroom: 999,
      globalHeadroom: 999,
      providerHeadroom: 999,
      rateLimitHeadroom: 999,
      remainingContacts: 999,
      ...overrides,
    };
  }

  it('a pacer asking far beyond every limit is still cut to the limit', () => {
    // A 10% answer rate makes predictive ask for a large number. None of it reaches a dial.
    const plan = new PredictiveDialer().computeDialPlan(snapshot());
    expect(plan.requested).toBeGreaterThan(50);

    const decision = controller.review(
      { campaignId: 'camp_1', mode: 'PREDICTIVE', requested: plan.requested, reasoning: plan.reasoning },
      context({ availableAgents: 50, campaignHeadroom: 6 }),
    );
    expect(decision.approved).toBe(6);
  });

  it('a deliberately broken pacer cannot over-dial', () => {
    // Stand-in for any future pacing bug: a runaway estimate, a bad feedback loop, an
    // "optimised" clamp. The ceiling holds because it is computed by code that never sees
    // the pacer's intent.
    const decision = controller.review(ask(1_000_000), context({ campaignHeadroom: 12 }));
    expect(decision.approved).toBe(12);
    expect(decision.verdict).toBe('REDUCED');
  });

  /**
   * Comments are stripped before these checks. The pacing modules discuss the controller at
   * length — that is the documentation doing its job — and a test that failed on the word
   * "enforces" appearing in prose would be measuring nothing.
   */
  const codeOnly = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  it('the pacing modules import nothing that could place a call or apply a limit', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/dialer/predictive.ts', 'src/dialer/progressive.ts']) {
      const source = readFileSync(file, 'utf8');

      // The only module a pacer may import is its own interface.
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => i !== './strategy.ts'), file).toEqual([]);

      // And its executable code must not name the controller, a provider, a repository or
      // the concurrency ledger — it has no legitimate reason to know any of them exist.
      const code = codeOnly(source);
      for (const forbidden of ['SafetyController', 'Provider', 'Repository', 'concurrency']) {
        expect(code.includes(forbidden), `${file} code must not reference ${forbidden}`).toBe(false);
      }
    }
  });

  it('the controller has no option that disables it', async () => {
    const { readFileSync } = await import('node:fs');
    const code = codeOnly(readFileSync('src/dialer/safety-controller.ts', 'utf8'));

    // Whole identifiers, not substrings — `force` must not match `enforces`.
    for (const escape of ['disabled', 'disable', 'bypass', 'skipSafety', 'force', 'override', 'unsafe']) {
      const pattern = new RegExp(`\\b${escape}\\b`, 'i');
      expect(pattern.test(code), `no \`${escape}\` escape hatch in the controller`).toBe(false);
    }
  });
});
