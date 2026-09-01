import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, type EngineHarness } from '../helpers/engine.ts';

let harness: EngineHarness | null = null;

/**
 * A campaign that works through all its contacts transitions to COMPLETED on its own, and
 * COMPLETED -> STOPPED is not a legal move. Tests must not assume they are the ones who
 * finished it.
 */
function stopIfRunning(h: EngineHarness): void {
  const status = h.reload().status;
  if (status === 'RUNNING' || status === 'PAUSED') h.container.campaignService.stop(h.campaign.id);
}
afterEach(() => {
  harness?.close();
  harness = null;
});

const ALWAYS_BUSY = { answerRate: 0, noAnswerRate: 0, busyRate: 1, failureRate: 0 };
const ALWAYS_ANSWER = { answerRate: 1, noAnswerRate: 0, busyRate: 0, failureRate: 0 };

describe('Campaign reset', () => {
  it('never restores a DO_NOT_CALL contact', async () => {
    // The single most important assertion about this feature. DNC is a one-way door
    // everywhere else in the system; a reset that quietly reopened it would mean the whole
    // guarantee held right up until someone pressed a button labelled "run it again".
    harness = createEngineHarness({
      contacts: 6,
      agents: 2,
      campaign: { maxAttemptsPerContact: 1 },
      provider: ALWAYS_BUSY,
    });
    const { container, campaign } = harness;

    for (const id of ['cont_000001', 'cont_000003']) container.contactService.markDoNotCall(id);

    container.campaignService.start(campaign.id);
    await harness.run();
    stopIfRunning(harness);

    const { contactsRestored } = container.campaignService.reset(campaign.id);
    expect(contactsRestored).toBeGreaterThan(0);

    for (const id of ['cont_000001', 'cont_000003']) {
      expect(container.repositories.contacts.findById(id)?.status, id).toBe('DO_NOT_CALL');
    }

    // And they must still be undialable after a full second run.
    container.campaignService.start(campaign.id);
    await harness.run();
    expect(container.repositories.calls.callsToDoNotCallContacts()).toEqual([]);
    container.invariants.assert();
  });

  it('does not re-dial someone who was already reached', async () => {
    // A demo reset is not a reason to call a person a second time.
    harness = createEngineHarness({ contacts: 4, agents: 4, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run();

    const completed = container.repositories.contacts
      .listByCampaign(campaign.id, 100)
      .filter((c) => c.status === 'COMPLETED')
      .map((c) => c.id);
    expect(completed.length).toBeGreaterThan(0);

    stopIfRunning(harness);
    container.campaignService.reset(campaign.id);

    for (const id of completed) {
      expect(container.repositories.contacts.findById(id)?.status, id).toBe('COMPLETED');
    }
  });

  it('returns exhausted contacts to the pool with their attempts cleared', async () => {
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      campaign: { maxAttemptsPerContact: 2 },
      provider: ALWAYS_BUSY,
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run();

    const before = container.repositories.contacts.counts(campaign.id);
    expect(before.byStatus['EXHAUSTED']).toBeGreaterThan(0);

    stopIfRunning(harness);
    const { campaign: reset, contactsRestored } = container.campaignService.reset(campaign.id);

    expect(reset.status).toBe('READY');
    expect(contactsRestored).toBe(before.byStatus['EXHAUSTED']);

    const after = container.repositories.contacts.counts(campaign.id);
    expect(after.byStatus['EXHAUSTED'] ?? 0).toBe(0);
    expect(after.byStatus['READY']).toBe(contactsRestored);

    // Attempt counters must be cleared, or the restored contacts would be immediately
    // exhausted again by the max-attempts rule and the reset would achieve nothing.
    for (const contact of container.repositories.contacts.listByCampaign(campaign.id, 100)) {
      if (contact.status === 'READY') expect(contact.attemptCount, contact.id).toBe(0);
    }
  });

  it('lets a completed campaign run again', async () => {
    // The dead-end this exists to remove: before it, a finished demo campaign was inert with
    // no way back except the command line.
    harness = createEngineHarness({
      contacts: 4,
      agents: 2,
      campaign: { maxAttemptsPerContact: 1 },
      provider: ALWAYS_BUSY,
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run();
    stopIfRunning(harness);

    const firstRunCalls = container.repositories.calls.search({ campaignId: campaign.id, limit: 500 }).length;
    expect(firstRunCalls).toBeGreaterThan(0);

    container.campaignService.reset(campaign.id);
    container.campaignService.start(campaign.id);
    await harness.run();

    expect(
      container.repositories.calls.search({ campaignId: campaign.id, limit: 500 }).length,
    ).toBeGreaterThan(firstRunCalls);
    container.invariants.assert();
  });

  it('refuses to reset a campaign that is still running', async () => {
    // Resetting mid-flight would clear contacts out from under live calls.
    harness = createEngineHarness({
      contacts: 20,
      agents: 2,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 10_000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 3000 });

    expect(() => container.campaignService.reset(campaign.id)).toThrow(/Stop the campaign/);
    container.campaignService.stop(campaign.id);
  });

  it('clears an abandon-rate pause, since it measured a run that no longer exists', async () => {
    harness = createEngineHarness({ contacts: 4, agents: 2, provider: ALWAYS_BUSY });
    const { container, campaign } = harness;

    container.repositories.campaigns.setPredictivePausedReason(campaign.id, 'abandon rate 9%', 0);
    expect(harness.reload().predictivePausedReason).not.toBeNull();

    container.campaignService.reset(campaign.id);
    expect(harness.reload().predictivePausedReason).toBeNull();
  });

  it('emits an auditable event recording what it did', async () => {
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      campaign: { maxAttemptsPerContact: 1 },
      provider: ALWAYS_BUSY,
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run();
    stopIfRunning(harness);
    container.campaignService.reset(campaign.id);

    const resetEvent = harness.events.find((e) => e.metadata['reset'] === true);
    expect(resetEvent).toBeDefined();
    expect(resetEvent?.message).toContain('reset for replay');
    expect(resetEvent?.metadata['contactsRestored']).toBeGreaterThan(0);
  });
});
