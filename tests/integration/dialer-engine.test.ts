import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, eventDigest, type EngineHarness } from '../helpers/engine.ts';
import type { MockProviderConfig } from '../../src/providers/mock-provider.ts';

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

const ALWAYS_ANSWER: Partial<MockProviderConfig> = {
  answerRate: 1,
  noAnswerRate: 0,
  busyRate: 0,
  failureRate: 0,
  meanRingDurationMs: 2000,
  meanCallDurationMs: 5000,
};

const NEVER_ANSWER: Partial<MockProviderConfig> = {
  answerRate: 0,
  noAnswerRate: 1,
  busyRate: 0,
  failureRate: 0,
  meanRingDurationMs: 2000,
};

describe('Progressive dialing', () => {
  it('dials every contact and completes the campaign', async () => {
    harness = createEngineHarness({ agents: 3, contacts: 12, provider: ALWAYS_ANSWER });
    harness.container.campaignService.start(harness.campaign.id);

    await harness.run();

    expect(harness.reload().status).toBe('COMPLETED');
    const counts = harness.container.repositories.contacts.counts(harness.campaign.id);
    expect(counts.byStatus['COMPLETED']).toBe(12);
    harness.container.invariants.assert();
  });

  it('never exceeds one call per available agent', async () => {
    // The defining property of progressive dialing. Checked continuously rather than at the
    // end, because a violation that resolves before the run finishes would otherwise pass.
    harness = createEngineHarness({ agents: 3, contacts: 20, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    let peakActive = 0;
    container.events.subscribe(() => {
      peakActive = Math.max(peakActive, container.concurrency.activeForCampaign(campaign.id));
    });

    container.campaignService.start(campaign.id);
    await harness.run();

    expect(peakActive).toBeLessThanOrEqual(3);
    container.invariants.assert();
  });

  it('paces to agent availability rather than firing everything at once', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 10, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    // Stop early: with only 2 agents and 10 contacts, most contacts must still be waiting.
    await harness.run({ untilVirtualMs: 3000 });

    const counts = container.repositories.contacts.counts(campaign.id);
    expect(counts.byStatus['READY'] ?? 0).toBeGreaterThan(0);
    expect(container.concurrency.activeForCampaign(campaign.id)).toBeLessThanOrEqual(2);
  });

  it('assigns an agent to every answered call and frees them afterwards', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 4, provider: ALWAYS_ANSWER });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const agents = harness.container.repositories.agents.listByCampaign(harness.campaign.id);
    expect(agents.every((agent) => agent.status === 'AVAILABLE')).toBe(true);
    expect(agents.reduce((sum, agent) => sum + agent.callsHandled, 0)).toBe(4);
    expect(agents.every((agent) => agent.currentCallId === null)).toBe(true);
  });

  it('records an attempt row per dial, with outcomes', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 3, provider: ALWAYS_ANSWER });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    for (const contact of harness.container.repositories.contacts.listByCampaign(harness.campaign.id)) {
      const attempts = harness.container.repositories.calls.listAttemptsForContact(contact.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('ANSWERED');
      expect(attempts[0]?.endedAt).not.toBeNull();
    }
  });

  it('emits the full call lifecycle in order', async () => {
    harness = createEngineHarness({ agents: 1, contacts: 1, provider: ALWAYS_ANSWER });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const types = harness.eventTypes();
    const lifecycle = types.filter((type) => type.startsWith('call.'));
    expect(lifecycle).toEqual([
      'call.created',
      'call.dialing',
      'call.ringing',
      'call.answered',
      'call.completed',
    ]);
    expect(types).toContain('contact.reserved');
    expect(types).toContain('agent.reserved');
    expect(types).toContain('agent.busy');
    expect(types).toContain('agent.available');
    expect(types).toContain('campaign.completed');
  });
});

describe('Predictive dialing', () => {
  it('places more calls than there are agents', async () => {
    // The whole point of predictive mode. With a 50% answer rate and 4 agents it should be
    // running roughly 8 lines, where progressive would run 4.
    harness = createEngineHarness({
      agents: 4,
      contacts: 60,
      campaign: { dialingMode: 'PREDICTIVE', maxConcurrentCalls: 20 },
      provider: {
        answerRate: 0.5,
        noAnswerRate: 0.5,
        busyRate: 0,
        failureRate: 0,
        meanRingDurationMs: 3000,
        meanCallDurationMs: 4000,
      },
    });
    const { container, campaign } = harness;

    let peakActive = 0;
    container.events.subscribe(() => {
      peakActive = Math.max(peakActive, container.concurrency.activeForCampaign(campaign.id));
    });

    container.campaignService.start(campaign.id);
    await harness.run();

    expect(peakActive).toBeGreaterThan(4);
    container.invariants.assert();
  });

  it('still respects the campaign concurrency limit while over-dialing', async () => {
    // Pacing may ask for more; the limit is what decides.
    harness = createEngineHarness({
      agents: 5,
      contacts: 60,
      campaign: { dialingMode: 'PREDICTIVE', maxConcurrentCalls: 6 },
      provider: { answerRate: 0.3, noAnswerRate: 0.7, busyRate: 0, failureRate: 0 },
    });
    const { container, campaign } = harness;

    let peakActive = 0;
    container.events.subscribe(() => {
      peakActive = Math.max(peakActive, container.concurrency.activeForCampaign(campaign.id));
    });

    container.campaignService.start(campaign.id);
    await harness.run();

    expect(peakActive).toBeLessThanOrEqual(6);
    container.invariants.assert();
  });

  it('never exceeds maxLinesPerAgent however low the answer rate falls', async () => {
    // A collapsed answer-rate estimate is what makes a predictive dialer dangerous; the
    // per-agent ceiling is what stops it.
    harness = createEngineHarness({
      agents: 2,
      contacts: 40,
      campaign: {
        dialingMode: 'PREDICTIVE',
        maxConcurrentCalls: 40,
        safety: {
          pacingMultiplier: 3,
          targetOccupancy: 0.9,
          lineRatio: 1,
          maxLinesPerAgent: 2,
          abandonTimeoutMs: 2000,
          abandonMinSample: 1000,
        },
      },
      provider: { answerRate: 0, noAnswerRate: 1, busyRate: 0, failureRate: 0 },
    });
    const { container, campaign } = harness;

    let peakActive = 0;
    container.events.subscribe(() => {
      peakActive = Math.max(peakActive, container.concurrency.activeForCampaign(campaign.id));
    });

    container.campaignService.start(campaign.id);
    await harness.run();

    // 2 agents x 2 lines each.
    expect(peakActive).toBeLessThanOrEqual(4);
  });
});

describe('Retry and failure handling', () => {
  it('retries a no-answer and eventually exhausts the contact', async () => {
    harness = createEngineHarness({
      agents: 1,
      contacts: 1,
      campaign: { maxAttemptsPerContact: 3 },
      provider: NEVER_ANSWER,
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const contact = harness.container.repositories.contacts.listByCampaign(harness.campaign.id)[0];
    expect(contact?.status).toBe('EXHAUSTED');
    expect(contact?.attemptCount).toBe(3);

    const attempts = harness.container.repositories.calls.listAttemptsForContact(contact?.id ?? '');
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.outcome === 'NO_ANSWER')).toBe(true);

    const types = harness.eventTypes();
    expect(types.filter((t) => t === 'retry.scheduled')).toHaveLength(2);
    expect(types).toContain('retry.exhausted');
  });

  it('never exceeds the attempt limit', async () => {
    harness = createEngineHarness({
      agents: 2,
      contacts: 5,
      campaign: { maxAttemptsPerContact: 2 },
      provider: NEVER_ANSWER,
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    for (const contact of harness.container.repositories.contacts.listByCampaign(harness.campaign.id)) {
      expect(contact.attemptCount).toBeLessThanOrEqual(2);
    }
    harness.container.invariants.assert();
  });

  it('does not retry a permanent failure', async () => {
    // An unroutable number would fail identically every time; retrying burns attempts.
    harness = createEngineHarness({
      agents: 1,
      contacts: 2,
      campaign: { maxAttemptsPerContact: 3 },
      provider: { invalidNumberRate: 1 },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    for (const contact of harness.container.repositories.contacts.listByCampaign(harness.campaign.id)) {
      expect(contact.status).toBe('EXHAUSTED');
      expect(contact.attemptCount).toBe(1);
    }
    expect(harness.eventTypes()).not.toContain('retry.scheduled');
  });

  it('retries a transient provider rejection and releases the slot each time', async () => {
    harness = createEngineHarness({
      agents: 1,
      contacts: 1,
      campaign: { maxAttemptsPerContact: 2 },
      provider: { errorRate: 1 },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('provider.error');
    expect(harness.eventTypes()).toContain('retry.scheduled');
    // Every rejected dial must give its slot back, or capacity leaks away one failure at a
    // time until the campaign silently stalls.
    expect(harness.container.concurrency.activeGlobal).toBe(0);
    harness.container.invariants.assert();
  });

  it('honours the backoff before retrying', async () => {
    harness = createEngineHarness({
      agents: 1,
      contacts: 1,
      campaign: {
        maxAttemptsPerContact: 2,
        retryPolicy: {
          maxAttempts: 2,
          initialDelayMs: 20_000,
          maxDelayMs: 20_000,
          multiplier: 1,
          jitterRatio: 0,
        },
      },
      provider: NEVER_ANSWER,
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const contact = harness.container.repositories.contacts.listByCampaign(harness.campaign.id)[0];
    const attempts = harness.container.repositories.calls.listAttemptsForContact(contact?.id ?? '');
    const first = attempts[0];
    const second = attempts[1];

    expect(attempts).toHaveLength(2);
    expect(second?.startedAt ?? 0).toBeGreaterThanOrEqual((first?.endedAt ?? 0) + 20_000);
  });
});

describe('Timeout handling', () => {
  it('fires the watchdog when the provider never reports an outcome', async () => {
    // The failure that strands resources: the provider accepts the call and goes silent.
    harness = createEngineHarness({
      agents: 1,
      contacts: 1,
      campaign: { maxAttemptsPerContact: 1 },
      provider: { ...ALWAYS_ANSWER, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '10000' },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('provider.timeout');
    expect(harness.eventTypes()).toContain('call.timeout');

    const calls = harness.container.repositories.calls.search({ campaignId: harness.campaign.id });
    expect(calls[0]?.status).toBe('TIMEOUT');
    expect(calls[0]?.outcome).toBe('TIMEOUT');
  });

  it('releases the concurrency slot on timeout, so the campaign does not deadlock', async () => {
    harness = createEngineHarness({
      agents: 2,
      contacts: 6,
      campaign: { maxAttemptsPerContact: 1, maxConcurrentCalls: 2 },
      provider: { ...ALWAYS_ANSWER, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '10000' },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    // Every contact was attempted despite every call timing out — which can only happen if
    // slots were released each time.
    const contacts = harness.container.repositories.contacts.listByCampaign(harness.campaign.id);
    expect(contacts.every((contact) => contact.attemptCount === 1)).toBe(true);
    expect(harness.container.concurrency.activeGlobal).toBe(0);
    harness.container.invariants.assert();
  });

  it('treats a timeout as transient and retries it', async () => {
    harness = createEngineHarness({
      agents: 1,
      contacts: 1,
      campaign: { maxAttemptsPerContact: 2 },
      provider: { ...ALWAYS_ANSWER, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '10000' },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const contact = harness.container.repositories.contacts.listByCampaign(harness.campaign.id)[0];
    expect(contact?.attemptCount).toBe(2);
    expect(harness.eventTypes()).toContain('retry.scheduled');
  });

  it('recovers a call stuck ringing', async () => {
    harness = createEngineHarness({
      agents: 1,
      contacts: 2,
      campaign: { maxAttemptsPerContact: 1 },
      provider: { ...ALWAYS_ANSWER, stuckRingingRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '10000' },
    });
    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('call.timeout');
    expect(harness.container.concurrency.activeGlobal).toBe(0);
  });
});

describe('Do-not-call protection', () => {
  it('never places a call to a DNC contact', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 6, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    const contacts = container.repositories.contacts.listByCampaign(campaign.id);
    const blocked = [contacts[1], contacts[3]].filter((c) => c !== undefined);
    for (const contact of blocked) container.contactService.markDoNotCall(contact.id);

    container.campaignService.start(campaign.id);
    await harness.run();

    for (const contact of blocked) {
      expect(container.repositories.calls.search({ contactId: contact.id })).toEqual([]);
      expect(container.repositories.contacts.findById(contact.id)?.status).toBe('DO_NOT_CALL');
      expect(container.repositories.contacts.findById(contact.id)?.attemptCount).toBe(0);
    }
    expect(container.repositories.calls.callsToDoNotCallContacts()).toEqual([]);
    container.invariants.assert();
  });

  it('completes the campaign even though DNC contacts are never dialled', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 4, provider: ALWAYS_ANSWER });
    const contacts = harness.container.repositories.contacts.listByCampaign(harness.campaign.id);
    harness.container.contactService.markDoNotCall(contacts[0]?.id ?? '');

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.reload().status).toBe('COMPLETED');
  });
});

describe('Campaign controls', () => {
  it('pause stops new dialing but lets calls in flight finish', async () => {
    harness = createEngineHarness({
      agents: 2,
      contacts: 20,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 20_000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 4000 });

    const inFlightBefore = container.engine.activeCallCount(campaign.id);
    expect(inFlightBefore).toBeGreaterThan(0);

    container.campaignService.pause(campaign.id);
    const attemptsAtPause = container.repositories.calls.search({ campaignId: campaign.id }).length;

    await harness.run();

    expect(harness.reload().status).toBe('PAUSED');
    // No new calls were created after the pause...
    expect(container.repositories.calls.search({ campaignId: campaign.id })).toHaveLength(
      attemptsAtPause,
    );
    // ...but the ones already running were allowed to complete.
    expect(container.engine.activeCallCount(campaign.id)).toBe(0);
    container.invariants.assert();
  });

  it('resume continues dialing the remaining contacts', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 8, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 3000 });
    container.campaignService.pause(campaign.id);
    await harness.run();

    const remainingBefore = container.repositories.contacts.remainingCount(campaign.id);
    expect(remainingBefore).toBeGreaterThan(0);

    container.campaignService.resume(campaign.id);
    await harness.run();

    expect(container.repositories.contacts.remainingCount(campaign.id)).toBe(0);
    expect(harness.reload().status).toBe('COMPLETED');
  });

  it('stop cancels everything in flight', async () => {
    harness = createEngineHarness({
      agents: 2,
      contacts: 20,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 30_000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 4000 });
    expect(container.engine.activeCallCount(campaign.id)).toBeGreaterThan(0);

    container.campaignService.stop(campaign.id);

    expect(harness.reload().status).toBe('STOPPED');
    expect(container.engine.activeCallCount(campaign.id)).toBe(0);
    expect(container.concurrency.activeForCampaign(campaign.id)).toBe(0);
    expect(harness.eventTypes()).toContain('call.cancelled');

    await harness.run();
    container.invariants.assert();
  });

  it('refuses to start a campaign with no agents', () => {
    harness = createEngineHarness({ agents: 0, contacts: 5 });
    expect(() => harness?.container.campaignService.start(harness.campaign.id)).toThrow(
      /no agents/i,
    );
  });

  it('refuses to start a campaign with nothing to dial', () => {
    harness = createEngineHarness({ agents: 2, contacts: 0 });
    expect(() => harness?.container.campaignService.start(harness.campaign.id)).toThrow(
      /no contacts/i,
    );
  });
});

describe('Emergency stop', () => {
  it('prevents new calls immediately', async () => {
    harness = createEngineHarness({
      agents: 2,
      contacts: 20,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 8000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 3000 });

    const callsBefore = container.repositories.calls.search({ campaignId: campaign.id }).length;
    container.system.engage('test');

    await harness.run({ untilVirtualMs: 60_000 });

    expect(container.repositories.calls.search({ campaignId: campaign.id })).toHaveLength(
      callsBefore,
    );
    expect(container.system.status().emergencyStopped).toBe(true);
    expect(harness.eventTypes()).toContain('safety.emergency_stop');
    expect(harness.eventTypes()).toContain('safety.denied');
  });

  it('lets dialing resume once released', async () => {
    harness = createEngineHarness({ agents: 2, contacts: 6, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.system.engage('test');
    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 5000 });
    expect(container.repositories.calls.search({ campaignId: campaign.id })).toEqual([]);

    container.system.release();
    await harness.run();

    expect(container.repositories.contacts.remainingCount(campaign.id)).toBe(0);
    container.invariants.assert();
  });
});

describe('Determinism', () => {
  it('two runs with the same seed produce identical event streams', async () => {
    // The property the entire simulation story rests on (DECISIONS.md D-003/D-004).
    const run = async (seed: number): Promise<string> => {
      const local = createEngineHarness({
        agents: 3,
        contacts: 25,
        seed,
        campaign: { dialingMode: 'PREDICTIVE', maxConcurrentCalls: 10 },
        provider: { answerRate: 0.6, noAnswerRate: 0.25, busyRate: 0.1, failureRate: 0.05 },
      });
      local.container.campaignService.start(local.campaign.id);
      await local.run();
      const digest = eventDigest(local.events);
      local.close();
      return digest;
    };

    const first = await run(4242);
    const second = await run(4242);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(100);
  });

  it('a different seed produces a different run', async () => {
    const run = async (seed: number): Promise<string> => {
      const local = createEngineHarness({
        agents: 3,
        contacts: 25,
        seed,
        provider: { answerRate: 0.6, noAnswerRate: 0.25, busyRate: 0.1, failureRate: 0.05 },
      });
      local.container.campaignService.start(local.campaign.id);
      await local.run();
      const digest = eventDigest(local.events);
      local.close();
      return digest;
    };

    expect(await run(1)).not.toBe(await run(2));
  });
});
