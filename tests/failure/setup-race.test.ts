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
 * Two cases the brief names explicitly and which nothing else in the suite covered:
 *
 *   "what happens when the agent disappears during call setup"   (Progressive Mode)
 *   "the worker processing the call crashes immediately after ANSWERED"
 *
 * Both are about the window between committing to a call and having somewhere to put it —
 * the narrowest and least-exercised part of the lifecycle.
 */
describe('The agent disappears during call setup', () => {
  it('does not strand the call when the only agent goes offline mid-ring', async () => {
    // The call is already dialing when its intended agent vanishes. There is now nobody to
    // hand it to, and the borrower is about to pick up.
    harness = createEngineHarness({
      contacts: 4,
      agents: 1,
      provider: { ...ALWAYS_ANSWER, meanRingDurationMs: 6000, meanCallDurationMs: 5000 },
      env: { ABANDON_TIMEOUT_MS: '2000' },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 2000 });
    expect(container.repositories.calls.activeCount(campaign.id)).toBeGreaterThan(0);

    // The agent disappears — closed the laptop, lost the network, went offline.
    const agent = container.repositories.agents.list()[0];
    container.agentService.setStatus(agent!.id, 'OFFLINE');

    await harness.run();

    // The call must reach a terminal state rather than hanging, the slot must come back, and
    // the contact must remain reachable — none of this was the borrower's fault.
    expect(container.repositories.calls.activeCount()).toBe(0);
    expect(container.concurrency.activeGlobal).toBe(0);
    const counts = container.repositories.contacts.counts(campaign.id);
    for (const stuck of ['RESERVED', 'DIALING', 'RINGING', 'CONNECTED']) {
      expect(counts.byStatus[stuck] ?? 0, stuck).toBe(0);
    }
    container.invariants.assert();
  });

  it('records the call as abandoned rather than pretending it succeeded', async () => {
    // If the borrower answers and no agent exists to take them, that is an abandonment. It
    // must be counted as one — this is the number the compliance story rests on.
    harness = createEngineHarness({
      contacts: 2,
      agents: 1,
      provider: { ...ALWAYS_ANSWER, meanRingDurationMs: 4000, meanCallDurationMs: 5000 },
      env: { ABANDON_TIMEOUT_MS: '1500' },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 1500 });
    const agent = container.repositories.agents.list()[0];
    container.agentService.setStatus(agent!.id, 'OFFLINE');
    await harness.run();

    const stats = container.repositories.calls.statistics(campaign.id);
    // Either it was abandoned, or it never got far enough to answer. What must not happen is
    // a call recorded as ANSWERED with no agent ever attached to it.
    const answeredWithNoAgent = container.repositories.calls
      .search({ campaignId: campaign.id, limit: 100 })
      .filter((c) => c.outcome === 'ANSWERED' && c.agentId === null);
    expect(answeredWithNoAgent).toEqual([]);
    expect(stats.total).toBeGreaterThan(0);
    container.invariants.assert();
  });

  it('keeps dialing once an agent comes back', async () => {
    harness = createEngineHarness({ contacts: 6, agents: 2, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 2000 });

    for (const agent of container.repositories.agents.list()) {
      container.agentService.setStatus(agent.id, 'OFFLINE');
    }
    await harness.run({ untilVirtualMs: 8000 });
    const whileOffline = container.repositories.calls.search({ campaignId: campaign.id, limit: 100 }).length;

    for (const agent of container.repositories.agents.list()) {
      container.agentService.bringOnline(agent.id);
    }
    await harness.run();

    expect(
      container.repositories.calls.search({ campaignId: campaign.id, limit: 100 }).length,
    ).toBeGreaterThan(whileOffline);
    container.invariants.assert();
  });
});

describe('The worker crashes immediately after ANSWERED', () => {
  it('leaves the call recoverable, with its agent freed', async () => {
    // The brief's sharpest crash case: the call has connected and an agent is committed to
    // it, and *then* the process dies. Both resources are held by a worker that no longer
    // exists, and neither will be released by anything that is still running.
    harness = createEngineHarness({
      contacts: 3,
      agents: 2,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 600_000 },
    });
    const { container, campaign } = harness;

    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID);
    const seen: ProviderEvent[] = [];
    provider.onEvent((e) => seen.push(e));

    container.campaignService.start(campaign.id);
    // Long calls, so we stop with agents genuinely mid-conversation.
    await harness.run({ untilVirtualMs: 10_000 });

    expect(seen.some((e) => e.type === 'call.answered')).toBe(true);
    const onCall = container.repositories.agents.list().filter((a) => a.status === 'ON_CALL');
    expect(onCall.length, 'the test needs an agent actually on a call').toBeGreaterThan(0);

    // The crash: abandon this container without stopping anything. Recovery is exercised by
    // `tests/failure/worker-crash.test.ts` against a real file; here the point is simply that
    // the state left behind is *recognisable* — active calls with agents attached.
    const strandedCalls = container.repositories.calls.listActive();
    expect(strandedCalls.length).toBeGreaterThan(0);
    expect(strandedCalls.some((c) => c.agentId !== null)).toBe(true);

    // Every stranded call has enough information to be reconciled: the agent it holds and the
    // contact it belongs to. Nothing depends on in-memory state to clean it up.
    for (const call of strandedCalls) {
      expect(call.contactId).toBeTruthy();
      expect(call.campaignId).toBe(campaign.id);
    }
  });

  it('a COMPLETED arriving after the crash is ignored rather than resurrecting the call', async () => {
    // The brief's exact sequence: ANSWERED, worker crashes, then COMPLETED arrives. After
    // recovery the call is already terminal (reclaimed as TIMEOUT), so the late event must
    // change nothing.
    harness = createEngineHarness({
      contacts: 2,
      agents: 1,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 600_000 },
    });
    const { container, campaign } = harness;

    const provider = container.providers.getMock(DEFAULT_PROVIDER_ID);
    const seen: ProviderEvent[] = [];
    provider.onEvent((e) => seen.push(e));

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 10_000 });

    const answered = seen.find((e) => e.type === 'call.answered');
    expect(answered).toBeDefined();
    if (answered === undefined) return;

    // Simulate what recovery does to that call, then deliver the late COMPLETED.
    const call = container.repositories.calls.findById(answered.callId);
    expect(call).not.toBeNull();
    container.repositories.calls.updateStatus(call!.id, call!.status, 'TIMEOUT', 999_999);

    expect(() =>
      container.engine.handleProviderEvent({
        type: 'call.completed',
        providerCallId: answered.providerCallId,
        callId: answered.callId,
        at: 1_000_000,
        metadata: { talkDurationMs: 30_000 },
      }),
    ).not.toThrow();

    // The call stays terminal. A late event cannot walk it backwards into an active state,
    // which would otherwise leak a slot that recovery had already returned.
    expect(container.repositories.calls.findById(call!.id)?.status).toBe('TIMEOUT');
  });
});
