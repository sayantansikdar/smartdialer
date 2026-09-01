import { describe, expect, it } from 'vitest';
import { runSimulation } from '../helpers/simulation.ts';

/**
 * Regression cover for BUG.md B-018.
 *
 * The mock provider has its own internal concurrency limit, defaulting to 40. The simulation
 * scaled the *global* and *per-provider* safety ceilings to each scenario but not that one, so
 * every predictive scenario silently ran into a 40-call wall: peak concurrency pinned at ~41
 * regardless of team size or campaign configuration.
 *
 * The consequence was worse than a wrong number. It meant the pacing scenarios were measuring
 * the provider's ceiling rather than the pacer, and it *masked* B-015 — the cap limited the
 * over-dial, so it limited the abandonment too. Lifting it made the real problem visible.
 */
describe('Scenario provider capacity', () => {
  it('scales with the campaign, so peak concurrency reflects the pacer not the provider', async () => {
    // Identical except for team size. If the provider's ceiling were binding, both would peak
    // at the same number — which is exactly the symptom that hid B-015.
    const base = {
      dialingMode: 'PREDICTIVE' as const,
      seed: 4242,
      maxLinesPerAgent: 3,
      callsPerSecond: 200,
      maxVirtualMs: 5 * 60_000,
      provider: {
        answerRate: 0.3,
        noAnswerRate: 0.5,
        busyRate: 0.15,
        failureRate: 0.05,
        meanCallDurationMs: 30_000,
      },
    };

    const small = await runSimulation({
      ...base, scenario: 'cap-small', agents: 10, contacts: 200, maxConcurrentCalls: 40,
    });
    const large = await runSimulation({
      ...base, scenario: 'cap-large', agents: 60, contacts: 900, maxConcurrentCalls: 200,
    });

    // The large campaign must actually be able to exceed the provider's old 40-call default.
    expect(large.report.peakConcurrency).toBeGreaterThan(45);
    // And it must clearly exceed the small one, rather than both hitting a shared wall.
    expect(large.report.peakConcurrency).toBeGreaterThan(small.report.peakConcurrency * 1.5);
  });

  /**
   * A subtlety worth stating, because it looks like an off-by-one bug and is not.
   *
   * Two different counters are in play. The provider's limit governs calls it has *accepted*.
   * Our concurrency ledger governs calls we have *created a lease for* — and a call holds its
   * lease while `provider.createCall()` is still awaiting acceptance. So the ledger
   * legitimately reads one higher than the provider's limit at the moment of handover, and
   * drops back when the provider rejects.
   *
   * The window is bounded at exactly one because the engine dials sequentially within a tick
   * (`await` per attempt), so only one handover is ever outstanding per campaign.
   */
  const HANDOVER_ALLOWANCE = 1;

  it('still honours a capacity the scenario sets deliberately', async () => {
    // Scaling the default must not override an explicit choice — a scenario that wants to
    // exercise provider-capacity rejection has to be able to say so.
    const { report } = await runSimulation({
      scenario: 'cap-explicit',
      dialingMode: 'PREDICTIVE',
      agents: 40,
      contacts: 400,
      seed: 7,
      maxConcurrentCalls: 120,
      callsPerSecond: 200,
      maxVirtualMs: 3 * 60_000,
      provider: {
        answerRate: 0.4, noAnswerRate: 0.4, busyRate: 0.15, failureRate: 0.05,
        meanCallDurationMs: 20_000,
        maxConcurrentCalls: 12,
      },
    });

    // The provider's own limit is the binding one here, and it must bind.
    expect(report.peakConcurrency).toBeLessThanOrEqual(12 + HANDOVER_ALLOWANCE);
    // Proof it actually bound, rather than simply never being reached.
    const provider = Object.values(report.providerMetrics)[0] as { rejected: number };
    expect(provider.rejected).toBeGreaterThan(0);
    expect(report.invariantsPassed).toBe(true);
  });

  it('never lets the provider limit be breached, whatever it is set to', async () => {
    const { report } = await runSimulation({
      scenario: 'cap-invariant',
      dialingMode: 'PREDICTIVE',
      agents: 30,
      contacts: 300,
      seed: 11,
      maxConcurrentCalls: 90,
      callsPerSecond: 200,
      maxVirtualMs: 3 * 60_000,
      provider: {
        answerRate: 0.35, noAnswerRate: 0.45, busyRate: 0.15, failureRate: 0.05,
        meanCallDurationMs: 25_000,
        maxConcurrentCalls: 25,
      },
    });

    expect(report.peakConcurrency).toBeLessThanOrEqual(25 + HANDOVER_ALLOWANCE);
    expect(report.invariantViolations).toEqual([]);

    // The provider never exceeds its own limit — it refuses instead, and every refusal
    // releases the lease that was held for the attempt.
    const provider = Object.values(report.providerMetrics)[0] as {
      rejected: number;
      activeCalls: number;
    };
    expect(provider.rejected).toBeGreaterThan(0);
    expect(provider.activeCalls).toBeLessThanOrEqual(25);
  });
});
