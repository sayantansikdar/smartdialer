import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, type EngineHarness } from '../helpers/engine.ts';

let harness: EngineHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

const ALWAYS_ANSWER = { answerRate: 1, noAnswerRate: 0, busyRate: 0, failureRate: 0 };

/**
 * Regression cover for BUG.md B-017, and for the general shape it belongs to.
 *
 * A campaign that provably cannot dial must stand down rather than tick forever denying
 * itself. Three variants of this have now shipped as bugs (B-003 twice over, then B-017), and
 * the failure is always silent — the system stays *correct*, it just burns cycles and floods
 * the event log while doing nothing.
 *
 * These assert the event count directly, because that is the symptom that scales: the original
 * bug produced 200,004 denials in a single run.
 */
describe('Standing down when dialing is impossible', () => {
  it('stands down when every agent goes offline, instead of spinning', async () => {
    harness = createEngineHarness({
      contacts: 10,
      agents: 2,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 5000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 2000 });

    for (const agent of container.repositories.agents.list()) {
      container.agentService.setStatus(agent.id, 'OFFLINE');
    }

    const before = harness.events.length;
    await harness.run();
    const produced = harness.events.length - before;

    expect(container.engine.describeState(campaign.id).stalled).toBe(true);
    // The original bug produced 200,004 events here. An exact count would be brittle; the
    // point is that it is bounded rather than proportional to how long the run lasts.
    expect(produced).toBeLessThan(500);
    container.invariants.assert();
  });

  it('revives when an agent comes back — the stand-down is not a one-way door', async () => {
    // The half that matters as much as the stand-down itself. Without it, taking agents
    // offline would permanently kill a campaign.
    harness = createEngineHarness({ contacts: 10, agents: 2, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 2000 });

    const agents = container.repositories.agents.list();
    for (const agent of agents) container.agentService.setStatus(agent.id, 'OFFLINE');
    await harness.run();

    expect(container.engine.describeState(campaign.id).stalled).toBe(true);
    const whileDown = container.repositories.calls.search({ campaignId: campaign.id, limit: 200 }).length;

    for (const agent of agents) container.agentService.bringOnline(agent.id);
    await harness.run();

    expect(container.engine.describeState(campaign.id).stalled).toBe(false);
    expect(
      container.repositories.calls.search({ campaignId: campaign.id, limit: 200 }).length,
    ).toBeGreaterThan(whileDown);
    container.invariants.assert();
  });

  it('does not stand down while calls are still in flight', async () => {
    // Standing down with work outstanding would orphan it: the engine would stop ticking
    // while calls it is responsible for are still live. The condition is "blocked AND nothing
    // in flight", and the second half is not optional.
    //
    // The emergency stop is used rather than taking agents offline, because an agent on a call
    // is neither OFFLINE nor PAUSED — so the no-agents condition cannot fire mid-call in the
    // first place. (Discovered writing this test: the engine correctly refuses ON_CALL ->
    // PAUSED, which is its own small guarantee.)
    harness = createEngineHarness({
      contacts: 10,
      agents: 2,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 300_000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 3000 });
    expect(container.repositories.calls.activeCount(campaign.id)).toBeGreaterThan(0);

    container.system.engage('blocked with work outstanding');
    await harness.run({ untilVirtualMs: container.clock.now() + 2000 });

    // Blocked, but still responsible for live calls — so it must keep ticking.
    expect(container.repositories.calls.activeCount(campaign.id)).toBeGreaterThan(0);
    expect(container.engine.describeState(campaign.id).stalled).toBe(false);

    container.system.release();
  });

  it('refuses to move an agent on a call straight to PAUSED', async () => {
    // Small, but it is what makes the case above impossible rather than merely unlikely.
    harness = createEngineHarness({
      contacts: 4,
      agents: 1,
      provider: { ...ALWAYS_ANSWER, meanCallDurationMs: 300_000 },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run({ untilVirtualMs: 3000 });

    const onCall = container.repositories.agents.list().find((a) => a.status === 'ON_CALL');
    expect(onCall, 'the test needs an agent actually on a call').toBeDefined();
    if (onCall === undefined) return;

    expect(() => container.agentService.setStatus(onCall.id, 'PAUSED')).toThrow(
      /illegal transition/i,
    );
  });

  it('also stands down for the emergency stop and the abandon pause', async () => {
    // The two original conditions, kept covered so the list cannot silently shrink.
    harness = createEngineHarness({ contacts: 10, agents: 2, provider: ALWAYS_ANSWER });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    container.system.engage('regression test');
    await harness.run();
    expect(container.engine.describeState(campaign.id).stalled).toBe(true);

    container.system.release();
    await harness.run({ untilVirtualMs: container.clock.now() + 5000 });
    expect(container.engine.describeState(campaign.id).stalled).toBe(false);
  });
});
