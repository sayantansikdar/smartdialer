import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, type EngineHarness } from '../helpers/engine.ts';
import { DEFAULT_PROVIDER_ID } from '../../src/container.ts';
import type { ProviderEvent } from '../../src/providers/telecom-provider.ts';

let harness: EngineHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

const ALWAYS_ANSWER = { answerRate: 1, noAnswerRate: 0, busyRate: 0, failureRate: 0 };

/**
 * These are the assignment's explicit questions:
 *
 *   "the telecom provider sends ANSWERED, ANSWERED, ANSWERED, COMPLETED"
 *   "or COMPLETED, ANSWERED, RINGING"
 *   "Does your system create multiple state transitions? Does your system break?"
 *
 * The answer rests on one mechanism: every call state change is a compare-and-set against
 * the state the engine believes the call is in. A duplicate arrives, finds the call already
 * past that state, matches nothing, and changes nothing. There is no separate de-duplication
 * layer and no event-id bookkeeping — idempotency falls out of the transition being
 * conditional, which is why it also covers events nobody anticipated.
 */
describe('Duplicate provider events', () => {
  it('three ANSWERED events reserve one agent, not three', () => {
    // The failure this prevents is expensive and silent: three agents pulled out of the pool
    // for one conversation, two of them never spoken to.
    harness = createEngineHarness({ contacts: 1, agents: 3, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;
    container.campaignService.start(campaign.id);

    // Drive the lifecycle by hand so the duplicates are exact, not probabilistic.
    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID);
    const seen: ProviderEvent[] = [];
    provider.onEvent((e) => seen.push(e));

    return harness.run({ untilVirtualMs: 6000 }).then(() => {
      const answered = seen.find((e) => e.type === 'call.answered');
      expect(answered, 'a call must have been answered to replay').toBeDefined();
      if (answered === undefined) return;

      const agentsBefore = container.repositories.agents.list().filter((a) => a.status === 'ON_CALL').length;

      // Replay the same ANSWERED twice more, byte-identical, as a retried webhook would be.
      container.engine.handleProviderEvent(answered);
      container.engine.handleProviderEvent(answered);

      const agentsAfter = container.repositories.agents.list().filter((a) => a.status === 'ON_CALL').length;
      expect(agentsAfter).toBe(agentsBefore);

      const call = container.repositories.calls.findById(answered.callId);
      expect(call?.status).toBe('CONNECTED');
      container.invariants.assert();
    });
  });

  it('a duplicated terminal event does not double-release the concurrency slot', async () => {
    // A double release is the classic capacity-corruption bug: the ledger drifts below
    // reality and the system quietly begins exceeding its own limit.
    harness = createEngineHarness({ contacts: 2, agents: 2, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID);
    const seen: ProviderEvent[] = [];
    provider.onEvent((e) => seen.push(e));

    container.campaignService.start(campaign.id);
    await harness.run();

    const completed = seen.filter((e) => e.type === 'call.completed');
    expect(completed.length).toBeGreaterThan(0);

    const ledgerBefore = container.concurrency.activeGlobal;
    for (const event of completed) {
      container.engine.handleProviderEvent(event);
      container.engine.handleProviderEvent(event);
    }
    expect(container.concurrency.activeGlobal).toBe(ledgerBefore);
    container.invariants.assert();
  });

  it('survives a provider that duplicates events at random, across a whole campaign', async () => {
    harness = createEngineHarness({
      contacts: 25,
      agents: 4,
      seed: 7,
      env: { PROVIDER_DRIVER: 'unreliable-mock' },
      provider: { ...ALWAYS_ANSWER, timeoutRate: 0, stuckRingingRate: 0, errorRate: 0, invalidNumberRate: 0 },
    });
    const { container, campaign } = harness;
    container.campaignService.start(campaign.id);
    await harness.run();

    expect(container.repositories.calls.agentsWithMultipleActiveCalls()).toEqual([]);
    expect(container.repositories.calls.contactsWithMultipleActiveCalls()).toEqual([]);
    expect(container.concurrency.activeGlobal).toBe(0);
    container.invariants.assert();
  });
});

describe('Out-of-order provider events', () => {
  it('ignores an event that would move a call backwards', async () => {
    // COMPLETED then ANSWERED then RINGING. The call must end up where the *latest* real
    // state put it, not wherever the last-delivered message claimed.
    harness = createEngineHarness({ contacts: 1, agents: 1, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID);
    const seen: ProviderEvent[] = [];
    provider.onEvent((e) => seen.push(e));

    container.campaignService.start(campaign.id);
    await harness.run();

    const call = container.repositories.calls.search({ campaignId: campaign.id, limit: 10 })[0];
    expect(call?.status).toBe('ENDED');

    // Now replay the earlier events, late.
    for (const type of ['call.ringing', 'call.answered'] as const) {
      const stale = seen.find((e) => e.type === type && e.callId === call?.id);
      if (stale !== undefined) container.engine.handleProviderEvent(stale);
    }

    expect(container.repositories.calls.findById(call?.id ?? '')?.status).toBe('ENDED');
    expect(container.concurrency.activeGlobal).toBe(0);
    container.invariants.assert();
  });

  it('does not crash on an event for a call it has never seen', async () => {
    // A restarted worker receives webhooks for calls that belong to a previous process.
    harness = createEngineHarness({ contacts: 1, agents: 1, provider: ALWAYS_ANSWER });
    const { container } = harness;

    expect(() =>
      container.engine.handleProviderEvent({
        type: 'call.answered',
        providerCallId: 'ghost-provider-call',
        callId: 'call_999999',
        at: 0,
      }),
    ).not.toThrow();
    container.invariants.assert();
  });

  it('survives a provider that reorders and duplicates simultaneously', async () => {
    // Both faults at once, over a full campaign — the realistic version of a bad carrier.
    harness = createEngineHarness({
      contacts: 30,
      agents: 5,
      seed: 31_337,
      env: { PROVIDER_DRIVER: 'unreliable-mock' },
      provider: { answerRate: 0.7, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0 },
    });
    const { container, campaign } = harness;
    container.campaignService.start(campaign.id);
    await harness.run();

    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID) as unknown as {
      duplicatesSent: number;
      reorderedEvents: number;
    };
    // The test is only meaningful if the faults actually fired.
    expect(provider.duplicatesSent + provider.reorderedEvents).toBeGreaterThan(0);

    expect(container.repositories.calls.agentsWithMultipleActiveCalls()).toEqual([]);
    expect(container.repositories.calls.contactsWithMultipleActiveCalls()).toEqual([]);
    expect(container.concurrency.activeGlobal).toBe(0);
    for (const agent of container.repositories.agents.list()) {
      expect(agent.currentCallId, agent.id).toBeNull();
    }
    container.invariants.assert();
  });
});
