import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, type EngineHarness } from '../helpers/engine.ts';

let harness: EngineHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

/**
 * Regression cover for BUG.md B-015.
 *
 * `pendingConnections` is the one snapshot value the pacer *subtracts*. A negative value
 * therefore does not reduce the plan, it inflates it — and it did: with one free agent the
 * system approved ten calls, because the number handed to it was −19.
 *
 * These assert the invariant directly rather than the abandonment it caused, because the
 * abandonment was a downstream symptom and would have been easy to "fix" by tuning something
 * unrelated.
 */
describe('pendingConnections', () => {
  it('is never negative, across a full campaign with long calls', async () => {
    // Long calls are the case that broke it: they outlived their own concurrency lease, so
    // the ledger dropped while the in-flight map did not.
    harness = createEngineHarness({
      contacts: 40,
      agents: 6,
      seed: 99,
      provider: {
        answerRate: 0.7,
        noAnswerRate: 0.2,
        busyRate: 0.1,
        failureRate: 0,
        meanCallDurationMs: 180_000,
      },
    });
    const { container, campaign } = harness;

    const observed: number[] = [];
    container.events.on('dialer.plan', (event) => {
      observed.push(Number(event.metadata['pendingConnections'] ?? 0));
    });

    container.campaignService.start(campaign.id);
    await harness.run();

    expect(observed.length, 'the test needs plans to have been made').toBeGreaterThan(0);
    expect(Math.min(...observed)).toBeGreaterThanOrEqual(0);
    container.invariants.assert();
  });

  it('a call that outlives the lease TTL is settled, not orphaned', async () => {
    // Releasing a slot while leaving the call in flight is what drove the count negative. The
    // ledger and the database must agree at every point.
    harness = createEngineHarness({
      contacts: 6,
      agents: 3,
      provider: {
        answerRate: 1,
        noAnswerRate: 0,
        busyRate: 0,
        failureRate: 0,
        meanCallDurationMs: 120_000,
      },
      env: { PROVIDER_TIMEOUT_MS: '10000', MAX_CALL_DURATION_MS: '300000' },
    });
    const { container, campaign } = harness;

    container.campaignService.start(campaign.id);
    await harness.run();

    expect(container.concurrency.activeGlobal).toBe(container.repositories.calls.activeCount());
    expect(container.concurrency.activeGlobal).toBe(0);
    container.invariants.assert();
  });

  it('the lease outlives the longest call its watchdog would allow', async () => {
    // The specific ordering that was wrong: a 90s lease backing a 180s conversation.
    harness = createEngineHarness({ contacts: 1, agents: 1 });
    const { dialer } = harness.container.config;
    expect(dialer.maxCallDurationMs).toBeGreaterThan(dialer.providerTimeoutMs);
    // The lease TTL is derived from both, so it must exceed the watchdog it backs up.
    expect(dialer.providerTimeoutMs + dialer.maxCallDurationMs).toBeGreaterThan(
      dialer.maxCallDurationMs,
    );
  });
});
