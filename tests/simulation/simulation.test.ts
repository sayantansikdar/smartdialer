import { describe, expect, it } from 'vitest';
import { runSimulation } from '../helpers/simulation.ts';
import { SCENARIOS, findScenario, scenarioNames } from '../../src/sim/scenarios.ts';

describe('Determinism', () => {
  it('replays a run identically from the same seed', async () => {
    // The claim the whole simulation story rests on (DECISIONS.md D-003/D-004). A digest of
    // every event in order proves the two runs did the same things at the same moments —
    // not merely that their totals agreed.
    const config = { scenario: 'determinism', contacts: 60, agents: 4, seed: 4242 };
    const first = await runSimulation(config);
    const second = await runSimulation(config);

    expect(first.digest).toBe(second.digest);
    expect(first.events.length).toBe(second.events.length);
    expect(first.report.totalAttempts).toBe(second.report.totalAttempts);
    expect(first.report.virtualDurationMs).toBe(second.report.virtualDurationMs);
  });

  it('produces a different run for a different seed', async () => {
    // Otherwise the determinism test above would pass trivially.
    const base = { scenario: 'determinism', contacts: 60, agents: 4 };
    const a = await runSimulation({ ...base, seed: 1 });
    const b = await runSimulation({ ...base, seed: 2 });
    expect(a.digest).not.toBe(b.digest);
  });

  it('is deterministic in progressive mode too', async () => {
    const config = {
      scenario: 'determinism-progressive',
      contacts: 40,
      agents: 3,
      dialingMode: 'PROGRESSIVE' as const,
      seed: 999,
    };
    expect((await runSimulation(config)).digest).toBe((await runSimulation(config)).digest);
  });

  it('is deterministic with failures and retries in play', async () => {
    // Failure paths involve more timers, more retry jitter and more interleaving than the
    // happy path — exactly where non-determinism would hide.
    const config = {
      scenario: 'determinism-chaos',
      contacts: 50,
      agents: 4,
      seed: 31_337,
      maxAttempts: 3,
      provider: {
        answerRate: 0.4,
        noAnswerRate: 0.25,
        busyRate: 0.2,
        failureRate: 0.15,
        timeoutRate: 0.08,
        errorRate: 0.05,
      },
    };
    expect((await runSimulation(config)).digest).toBe((await runSimulation(config)).digest);
  });
});

describe('Aggregate behaviour', () => {
  it('processes every contact to a terminal state', async () => {
    const { report } = await runSimulation({
      scenario: 'aggregate',
      contacts: 80,
      agents: 5,
      seed: 7,
    });

    const terminal =
      (report.contactsByStatus['COMPLETED'] ?? 0) +
      (report.contactsByStatus['EXHAUSTED'] ?? 0) +
      (report.contactsByStatus['DO_NOT_CALL'] ?? 0);
    expect(terminal).toBe(80);

    // Nothing may be left mid-flight when the run settles.
    for (const stuck of ['READY', 'RESERVED', 'DIALING', 'RINGING', 'CONNECTED', 'RETRY_PENDING']) {
      expect(report.contactsByStatus[stuck] ?? 0, stuck).toBe(0);
    }
  });

  it('reflects the provider answer rate it was configured with', async () => {
    const { report } = await runSimulation({
      scenario: 'aggregate-answer',
      contacts: 150,
      agents: 8,
      seed: 11,
      provider: { answerRate: 0.7, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0 },
    });

    expect(report.answerRate).toBeGreaterThan(0.6);
    expect(report.answerRate).toBeLessThan(0.8);
  });

  it('makes more than one attempt per contact when calls fail', async () => {
    const { report } = await runSimulation({
      scenario: 'aggregate-retry',
      contacts: 40,
      agents: 4,
      seed: 5,
      maxAttempts: 3,
      provider: { answerRate: 0.2, noAnswerRate: 0.5, busyRate: 0.3, failureRate: 0 },
    });

    expect(report.averageAttemptsPerContact).toBeGreaterThan(1);
    expect(report.retries).toBeGreaterThan(0);
  });

  it('never exceeds the attempt limit however badly calls go', async () => {
    const { report } = await runSimulation({
      scenario: 'aggregate-limit',
      contacts: 30,
      agents: 3,
      seed: 6,
      maxAttempts: 2,
      provider: { answerRate: 0, noAnswerRate: 1, busyRate: 0, failureRate: 0 },
    });

    expect(report.averageAttemptsPerContact).toBeLessThanOrEqual(2);
    expect(report.invariantsPassed).toBe(true);
  });
});

describe('Safety under simulation', () => {
  it('never dials a DO_NOT_CALL contact', async () => {
    const { report } = await runSimulation({
      scenario: 'sim-dnc',
      contacts: 50,
      agents: 4,
      seed: 3,
      dncContacts: 15,
    });

    expect(report.contactsByStatus['DO_NOT_CALL']).toBe(15);
    expect(report.invariantsPassed).toBe(true);
    // 35 dialable contacts, so no more than 35 can ever have been connected.
    expect(report.successfulConnections).toBeLessThanOrEqual(35);
  });

  it('holds concurrency within the campaign limit at all times', async () => {
    const { report } = await runSimulation({
      scenario: 'sim-concurrency',
      contacts: 200,
      agents: 20,
      seed: 8,
      maxConcurrentCalls: 12,
      callsPerSecond: 50,
    });

    expect(report.peakConcurrency).toBeLessThanOrEqual(12);
    expect(report.invariantsPassed).toBe(true);
  });

  it('reports invariant violations rather than hiding them', async () => {
    // The report must be capable of saying FAILED, or PASSED means nothing.
    const { report } = await runSimulation({ scenario: 'sim-clean', contacts: 20, agents: 3, seed: 2 });
    expect(report).toHaveProperty('invariantsPassed');
    expect(report).toHaveProperty('invariantViolations');
    expect(report.invariantsPassed).toBe(true);
    expect(report.invariantViolations).toEqual([]);
  });

  it('finishes rather than running until the virtual-time guard', async () => {
    // A run that only ends because it hit its safety valve has not demonstrated anything.
    const { report } = await runSimulation({
      scenario: 'sim-settles',
      contacts: 60,
      agents: 5,
      seed: 9,
    });
    expect(report.stopReason).toBe('idle');
    expect(report.virtualDurationMs).toBeLessThan(30 * 60_000);
  });
});

describe('Predefined scenarios', () => {
  it('exposes every scenario by name', () => {
    expect(scenarioNames().length).toBe(SCENARIOS.length);
    for (const name of scenarioNames()) {
      expect(findScenario(name)?.name).toBe(name);
    }
  });

  it('gives every scenario something it claims to demonstrate', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.demonstrates.length, scenario.name).toBeGreaterThan(20);
    }
  });

  // Each predefined scenario must hold up its own claim, not merely avoid crashing.
  for (const scenario of SCENARIOS) {
    it(`scenario "${scenario.name}" meets its expectations and holds every invariant`, async () => {
      const { report } = await runSimulation(scenario.config);

      expect(report.invariantViolations, scenario.name).toEqual([]);
      expect(report.invariantsPassed, scenario.name).toBe(true);
      expect(scenario.expect(report), scenario.name).toEqual([]);
    });
  }
});
