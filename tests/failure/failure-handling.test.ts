import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, type EngineHarness } from '../helpers/engine.ts';
import { DEFAULT_PROVIDER_ID } from '../../src/container.ts';

let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/** Outcome configs that make one failure mode certain, so a test asserts one thing. */
const ALWAYS = {
  answer: { answerRate: 1, noAnswerRate: 0, busyRate: 0, failureRate: 0 },
  busy: { answerRate: 0, noAnswerRate: 0, busyRate: 1, failureRate: 0 },
  noAnswer: { answerRate: 0, noAnswerRate: 1, busyRate: 0, failureRate: 0 },
  fail: { answerRate: 0, noAnswerRate: 0, busyRate: 0, failureRate: 1 },
} as const;

describe('Provider timeout — the call that never comes back', () => {
  it('detects a silent call, releases its slot and frees the agent', async () => {
    // The failure that actually strands resources: the provider accepts a call and then
    // never reports a terminal outcome. Nothing arrives to clean it up, so the engine's own
    // watchdog is the only thing that can.
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      provider: { ...ALWAYS.answer, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '10000' },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('call.timeout');

    // Everything must be given back, or the campaign deadlocks with slots it cannot use.
    expect(harness.container.concurrency.activeGlobal).toBe(0);
    expect(harness.container.repositories.calls.activeCount()).toBe(0);
    for (const agent of harness.container.repositories.agents.list()) {
      expect(agent.status, agent.id).not.toBe('ON_CALL');
      expect(agent.currentCallId, agent.id).toBeNull();
    }
    harness.container.invariants.assert();
  });

  it('does not deadlock — the campaign still finishes its contacts', async () => {
    harness = createEngineHarness({
      contacts: 4,
      agents: 2,
      campaign: { maxAttemptsPerContact: 2 },
      provider: { ...ALWAYS.answer, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '8000' },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const counts = harness.container.repositories.contacts.counts(harness.campaign.id);
    // No contact may be left stuck mid-flight.
    for (const stuck of ['RESERVED', 'DIALING', 'RINGING', 'CONNECTED']) {
      expect(counts.byStatus[stuck] ?? 0, stuck).toBe(0);
    }
    expect(counts.byStatus['EXHAUSTED'] ?? 0).toBeGreaterThan(0);
  });

  it('treats a timeout as transient and retries it', async () => {
    harness = createEngineHarness({
      contacts: 1,
      agents: 1,
      campaign: { maxAttemptsPerContact: 3 },
      provider: { ...ALWAYS.answer, timeoutRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '5000' },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('retry.scheduled');
    const attempts = harness.container.repositories.calls.listAttemptsForContact('cont_000001');
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.every((a) => a.failureClass === 'TRANSIENT')).toBe(true);
  });

  it('cancels the watchdog when the call resolves normally', async () => {
    // A watchdog that fired after a successful call would mark a completed call as timed out
    // and release a slot that was already released.
    harness = createEngineHarness({
      contacts: 2,
      agents: 2,
      provider: { ...ALWAYS.answer, meanCallDurationMs: 2000 },
      env: { PROVIDER_TIMEOUT_MS: '60000' },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).not.toContain('call.timeout');
    expect(harness.container.concurrency.activeGlobal).toBe(0);
  });
});

describe('Stuck ringing', () => {
  it('is caught by the watchdog like any other silence', async () => {
    harness = createEngineHarness({
      contacts: 2,
      agents: 1,
      provider: { ...ALWAYS.answer, stuckRingingRate: 1 },
      env: { PROVIDER_TIMEOUT_MS: '9000' },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('call.ringing');
    expect(harness.eventTypes()).toContain('call.timeout');
    expect(harness.container.concurrency.activeGlobal).toBe(0);
    harness.container.invariants.assert();
  });
});

describe('Provider errors and outages', () => {
  it('releases the contact and the slot when the provider rejects the request', async () => {
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      campaign: { maxAttemptsPerContact: 2 },
      provider: { errorRate: 1 },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.eventTypes()).toContain('provider.error');
    expect(harness.container.concurrency.activeGlobal).toBe(0);
    // A rejected request must not leave a contact reserved — that is how a pool leaks away.
    const counts = harness.container.repositories.contacts.counts(harness.campaign.id);
    expect(counts.byStatus['RESERVED'] ?? 0).toBe(0);
    harness.container.invariants.assert();
  });

  it('survives a total outage and leaves every contact retriable', async () => {
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      campaign: { maxAttemptsPerContact: 2 },
      provider: { outageActive: true },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.container.concurrency.activeGlobal).toBe(0);
    const counts = harness.container.repositories.contacts.counts(harness.campaign.id);
    const stalled = (counts.byStatus['RESERVED'] ?? 0) + (counts.byStatus['DIALING'] ?? 0);
    expect(stalled).toBe(0);
    harness.container.invariants.assert();
  });

  it('recovers and completes the campaign once the outage lifts', async () => {
    // The backoff is deliberately long relative to the outage window, so contacts are still
    // waiting to retry when the provider comes back rather than having already exhausted
    // their attempts against a dead provider.
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      campaign: {
        maxAttemptsPerContact: 5,
        retryPolicy: {
          maxAttempts: 5,
          initialDelayMs: 20_000,
          maxDelayMs: 60_000,
          multiplier: 2,
          jitterRatio: 0,
        },
      },
      provider: { ...ALWAYS.answer, outageActive: true },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run({ untilVirtualMs: 5000 });

    expect(harness.container.repositories.calls.statistics(harness.campaign.id).answered).toBe(0);
    expect(harness.reload().status).toBe('RUNNING');

    // Lift the outage — the same control the dashboard's failure-injection panel writes to.
    harness.container.providers.getMock(DEFAULT_PROVIDER_ID).updateConfig({ outageActive: false });
    await harness.run();

    expect(
      harness.container.repositories.calls.statistics(harness.campaign.id).answered,
    ).toBeGreaterThan(0);
    harness.container.invariants.assert();
  });
});

describe('Permanent failures are not retried', () => {
  it('stops after an invalid number rather than burning attempts', async () => {
    // Retrying an unroutable number wastes a contact's whole attempt budget on a call that
    // can never succeed.
    harness = createEngineHarness({
      contacts: 2,
      agents: 2,
      campaign: { maxAttemptsPerContact: 5 },
      provider: { invalidNumberRate: 1 },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const attempts = harness.container.repositories.calls.listAttemptsForContact('cont_000001');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.failureClass).toBe('PERMANENT');
    expect(harness.eventTypes()).not.toContain('retry.scheduled');

    const contact = harness.container.repositories.contacts.findById('cont_000001');
    expect(contact?.status).toBe('EXHAUSTED');
    expect(contact?.attemptCount).toBe(1);
  });
});

describe('Retry exhaustion', () => {
  it('retries transient failures up to the limit and then stops', async () => {
    harness = createEngineHarness({
      contacts: 1,
      agents: 1,
      campaign: { maxAttemptsPerContact: 3 },
      provider: ALWAYS.busy,
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const contact = harness.container.repositories.contacts.findById('cont_000001');
    expect(contact?.status).toBe('EXHAUSTED');
    expect(contact?.attemptCount).toBe(3);
    expect(harness.eventTypes()).toContain('retry.exhausted');

    // The attempt limit is a safety control, not a guideline.
    expect(contact?.attemptCount).toBeLessThanOrEqual(3);
    harness.container.invariants.assert();
  });

  it('records every attempt independently for the audit trail', async () => {
    harness = createEngineHarness({
      contacts: 1,
      agents: 1,
      campaign: { maxAttemptsPerContact: 3 },
      provider: ALWAYS.noAnswer,
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const attempts = harness.container.repositories.calls.listAttemptsForContact('cont_000001');
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.every((a) => a.outcome === 'NO_ANSWER')).toBe(true);
    // Each attempt has its own call row — the history is not overwritten.
    expect(new Set(attempts.map((a) => a.callId)).size).toBe(3);
  });

  it('honours backoff between attempts', async () => {
    harness = createEngineHarness({
      contacts: 1,
      agents: 1,
      campaign: {
        maxAttemptsPerContact: 3,
        retryPolicy: {
          maxAttempts: 3,
          initialDelayMs: 5000,
          maxDelayMs: 60_000,
          multiplier: 2,
          jitterRatio: 0,
        },
      },
      provider: ALWAYS.busy,
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    const attempts = harness.container.repositories.calls.listAttemptsForContact('cont_000001');
    const first = attempts[0];
    const second = attempts[1];
    expect(first?.endedAt).not.toBeNull();
    expect(second?.startedAt).not.toBeNull();
    // The second attempt must not start before the first attempt's backoff elapsed.
    expect((second?.startedAt ?? 0) - (first?.endedAt ?? 0)).toBeGreaterThanOrEqual(5000);
  });
});

describe('DO_NOT_CALL is absolute', () => {
  it('never places a call to a DNC contact', async () => {
    harness = createEngineHarness({ contacts: 6, agents: 2, provider: ALWAYS.answer });

    for (const id of ['cont_000001', 'cont_000003', 'cont_000005']) {
      harness.container.contactService.markDoNotCall(id);
    }

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run();

    expect(harness.container.repositories.calls.callsToDoNotCallContacts()).toEqual([]);
    for (const id of ['cont_000001', 'cont_000003', 'cont_000005']) {
      expect(harness.container.repositories.calls.listAttemptsForContact(id), id).toEqual([]);
    }
    harness.container.invariants.assert();
  });

  it('stops calling a contact marked DNC mid-campaign', async () => {
    harness = createEngineHarness({
      contacts: 8,
      agents: 1,
      provider: { ...ALWAYS.answer, meanCallDurationMs: 3000 },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run({ untilVirtualMs: 5000 });

    harness.container.contactService.markDoNotCall('cont_000008');
    await harness.run();

    expect(harness.container.repositories.calls.listAttemptsForContact('cont_000008')).toEqual([]);
  });
});

describe('Campaign pause mid-dial', () => {
  it('stops initiating new calls but lets calls in flight finish', async () => {
    harness = createEngineHarness({
      contacts: 20,
      agents: 3,
      provider: { ...ALWAYS.answer, meanCallDurationMs: 5000 },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run({ untilVirtualMs: 4000 });

    const attemptsBefore = harness.container.repositories.calls.search({
      campaignId: harness.campaign.id,
      limit: 1000,
    }).length;
    expect(attemptsBefore).toBeGreaterThan(0);

    harness.container.campaignService.pause(harness.campaign.id);
    await harness.run();

    const attemptsAfter = harness.container.repositories.calls.search({
      campaignId: harness.campaign.id,
      limit: 1000,
    }).length;

    // The calls that were already in flight resolved; no new ones were started beyond them.
    expect(attemptsAfter).toBeLessThanOrEqual(attemptsBefore + 3);
    expect(harness.reload().status).toBe('PAUSED');
    expect(harness.container.repositories.calls.activeCount()).toBe(0);
    harness.container.invariants.assert();
  });

  it('resumes dialing the remaining contacts', async () => {
    harness = createEngineHarness({ contacts: 10, agents: 2, provider: ALWAYS.answer });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run({ untilVirtualMs: 3000 });
    harness.container.campaignService.pause(harness.campaign.id);
    await harness.run();

    const midway = harness.container.repositories.contacts.remainingCount(harness.campaign.id);
    expect(midway).toBeGreaterThan(0);

    harness.container.campaignService.resume(harness.campaign.id);
    await harness.run();

    expect(
      harness.container.repositories.contacts.remainingCount(harness.campaign.id),
    ).toBeLessThan(midway);
  });
});

describe('Emergency stop mid-dial', () => {
  it('prevents any new call from being initiated', async () => {
    harness = createEngineHarness({
      contacts: 30,
      agents: 3,
      provider: { ...ALWAYS.answer, meanCallDurationMs: 4000 },
    });

    harness.container.campaignService.start(harness.campaign.id);
    await harness.run({ untilVirtualMs: 3000 });

    const before = harness.container.repositories.calls.search({
      campaignId: harness.campaign.id,
      limit: 1000,
    }).length;

    harness.container.system.engage('test');
    await harness.run();

    const after = harness.container.repositories.calls.search({
      campaignId: harness.campaign.id,
      limit: 1000,
    }).length;

    expect(harness.eventTypes()).toContain('safety.emergency_stop');
    expect(after).toBe(before);
    expect(harness.container.system.status().emergencyStopped).toBe(true);
    harness.container.invariants.assert();
  });

  it('allows dialing again only after an explicit resume', async () => {
    harness = createEngineHarness({ contacts: 12, agents: 2, provider: ALWAYS.answer });

    harness.container.campaignService.start(harness.campaign.id);
    harness.container.system.engage('test');
    await harness.run();

    expect(harness.container.repositories.calls.activeCount()).toBe(0);
    const stopped = harness.container.repositories.calls.search({
      campaignId: harness.campaign.id,
      limit: 1000,
    }).length;

    harness.container.system.release();
    await harness.run();

    expect(
      harness.container.repositories.calls.search({ campaignId: harness.campaign.id, limit: 1000 })
        .length,
    ).toBeGreaterThan(stopped);
    expect(harness.eventTypes()).toContain('safety.emergency_resume');
  });
});

describe('Resource release under every failure mode', () => {
  // The property that matters most across all of them: whatever goes wrong, the system must
  // give back what it took. A leak here is invisible until the campaign deadlocks.
  const modes = [
    ['busy', ALWAYS.busy],
    ['no answer', ALWAYS.noAnswer],
    ['provider call failure', ALWAYS.fail],
    ['request rejection', { errorRate: 1 }],
    ['silence', { ...ALWAYS.answer, timeoutRate: 1 }],
    ['stuck ringing', { ...ALWAYS.answer, stuckRingingRate: 1 }],
    ['invalid number', { invalidNumberRate: 1 }],
  ] as const;

  for (const [name, provider] of modes) {
    it(`releases every slot and agent after ${name}`, async () => {
      harness = createEngineHarness({
        contacts: 4,
        agents: 2,
        campaign: { maxAttemptsPerContact: 2 },
        provider,
        env: { PROVIDER_TIMEOUT_MS: '8000' },
      });

      harness.container.campaignService.start(harness.campaign.id);
      await harness.run();

      expect(harness.container.concurrency.activeGlobal, name).toBe(0);
      expect(harness.container.concurrency.activeLeases(), name).toEqual([]);
      expect(harness.container.repositories.calls.activeCount(), name).toBe(0);
      for (const agent of harness.container.repositories.agents.list()) {
        expect(agent.currentCallId, `${name}/${agent.id}`).toBeNull();
      }
      harness.container.invariants.assert();
    });
  }
});
