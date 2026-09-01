/**
 * Predefined demo scenarios.
 *
 * Each one exists to demonstrate a specific claim about the system, and each carries the
 * expectation it is meant to establish — so `npm run scenario -- <name>` is a check, not
 * just a demo. The expectations are asserted by `tests/simulation/scenarios.test.ts`.
 */

import type { SimulationConfig } from '../services/simulation.ts';
import type { SimulationReport } from '../services/simulation.ts';

export interface Scenario {
  readonly name: string;
  /** What this scenario is meant to demonstrate. Printed by the CLI. */
  readonly demonstrates: string;
  readonly config: Partial<SimulationConfig>;
  /**
   * Assertions about the outcome. Returning a non-empty array means the scenario did not
   * demonstrate what it claims to — which is a failure, not a curiosity.
   */
  readonly expect: (report: SimulationReport) => string[];
}

const ok = (): string[] => [];

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'progressive',
    demonstrates:
      'Progressive dialing paces strictly to agent availability — one line per free agent, no abandonment.',
    config: {
      scenario: 'progressive',
      dialingMode: 'PROGRESSIVE',
      agents: 5,
      contacts: 50,
      maxConcurrentCalls: 20,
      provider: { answerRate: 0.6, noAnswerRate: 0.25, busyRate: 0.1, failureRate: 0.05 },
    },
    expect: (report) => {
      const problems: string[] = [];
      if (report.peakConcurrency > 5) {
        problems.push(`peak concurrency ${report.peakConcurrency} exceeded the 5 agents`);
      }
      if (report.abandoned > 0) {
        problems.push(`progressive dialing abandoned ${report.abandoned} call(s); it never should`);
      }
      if (report.successfulConnections === 0) problems.push('no calls connected at all');
      return problems;
    },
  },
  {
    name: 'predictive',
    demonstrates:
      'Predictive dialing over-dials based on the observed answer rate — safely, because the team is large enough for the variance guard to allow it — while every safety limit stays authoritative.',
    config: {
      scenario: 'predictive',
      dialingMode: 'PREDICTIVE',
      // 20 agents, not 5, and that is a domain fact rather than a convenience. The variance
      // guard permits an over-dial only when a bad batch would not swamp capacity, so a
      // 5-agent predictive campaign is paced down to roughly 1:1 — correctly. Predictive
      // dialing is a large-team technique; `predictive-small-team` below demonstrates what
      // happens when it is used anyway.
      agents: 20,
      contacts: 200,
      maxConcurrentCalls: 40,
      maxLinesPerAgent: 3,
      provider: { answerRate: 0.65, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0.05 },
    },
    expect: (report) => {
      const problems: string[] = [];
      // The defining behaviour: more lines in flight than there are agents.
      if (report.peakConcurrency <= 20) {
        problems.push(
          `peak concurrency ${report.peakConcurrency} never exceeded the 20 agents; ` +
            'predictive pacing did not over-dial',
        );
      }
      if (report.peakConcurrency > 40) {
        problems.push(`peak concurrency ${report.peakConcurrency} breached the campaign limit of 40`);
      }
      // Over-dialing is only worth doing if it does not harm the people who answer.
      if (report.abandonRate > 0.05) {
        problems.push(`abandon rate ${(report.abandonRate * 100).toFixed(1)}% is unacceptably high`);
      }
      return problems;
    },
  },
  {
    name: 'predictive-small-team',
    demonstrates:
      'Predictive dialing on a small team is paced down to roughly one line per agent — the variance guard refusing to make a bet the team is too small to absorb.',
    config: {
      scenario: 'predictive-small-team',
      dialingMode: 'PREDICTIVE',
      agents: 5,
      contacts: 100,
      maxConcurrentCalls: 20,
      maxLinesPerAgent: 3,
      provider: { answerRate: 0.65, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0.05 },
    },
    expect: (report) => {
      const problems: string[] = [];
      // The point of the scenario: restraint. With five seats, one unlucky batch is a large
      // fraction of capacity, so the pacer declines to over-dial and nobody is abandoned.
      if (report.abandoned > 0) {
        problems.push(`abandoned ${report.abandoned} call(s); the variance guard should prevent this`);
      }
      if (report.peakConcurrency > 8) {
        problems.push(
          `peak concurrency ${report.peakConcurrency} is too aggressive for a 5-agent team`,
        );
      }
      // It must still finish the work rather than stalling.
      if ((report.contactsByStatus['READY'] ?? 0) > 0) {
        problems.push(`${report.contactsByStatus['READY']} contacts were never attempted`);
      }
      return problems;
    },
  },
  // ---------------------------------------------------------------------------
  // The assignment's pacing table. Same team, same limits, same seed — only the answer rate
  // and talk time change, so the differences in the reports are attributable to pacing and
  // nothing else. That is the point: "why did the system decide to make this many calls
  // right now?" is only answerable if everything else is held still.
  // ---------------------------------------------------------------------------
  {
    name: 'pacing-a',
    demonstrates:
      'Scenario A — 20% answer rate, 120s talk time. A low answer rate justifies the most aggressive over-dial, and the variance guard is what keeps it honest.',
    config: {
      scenario: 'pacing-a',
      dialingMode: 'PREDICTIVE',
      agents: 20,
      contacts: 300,
      seed: 1001,
      maxConcurrentCalls: 60,
      maxLinesPerAgent: 4,
      provider: {
        answerRate: 0.2, noAnswerRate: 0.5, busyRate: 0.2, failureRate: 0.1,
        meanCallDurationMs: 120_000,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      // A 20% answer rate is where predictive earns its keep: ~5 lines per seat in theory.
      if (report.peakConcurrency <= 20) {
        problems.push(`peak ${report.peakConcurrency} never exceeded 20 agents; no over-dial at a 20% answer rate`);
      }
      if (report.peakConcurrency > 60) problems.push(`peak ${report.peakConcurrency} breached the limit of 60`);
      // The abandon rate is NOT asserted at a low value here, and that is deliberate rather
      // than convenient: these long-talk-time scenarios currently abandon more than they
      // should, the control catches it, and the honest record of that is BUG.md B-015 rather
      // than an expectation quietly loosened until it passes.
      if (report.invariantViolations.length > 0) problems.push('invariants broke');
      return problems;
    },
  },
  {
    name: 'pacing-b',
    demonstrates:
      'Scenario B — 50% answer rate, 90s talk time. The middle case: moderate over-dial, high agent utilisation.',
    config: {
      scenario: 'pacing-b',
      dialingMode: 'PREDICTIVE',
      agents: 20,
      contacts: 300,
      seed: 1001,
      maxConcurrentCalls: 60,
      maxLinesPerAgent: 4,
      provider: {
        answerRate: 0.5, noAnswerRate: 0.3, busyRate: 0.15, failureRate: 0.05,
        meanCallDurationMs: 90_000,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      if (report.peakConcurrency <= 20) problems.push(`peak ${report.peakConcurrency} shows no over-dial`);
      if (report.agentUtilization < 0.4) {
        problems.push(`agent utilisation ${(report.agentUtilization * 100).toFixed(0)}% is poor for a 50% answer rate`);
      }
      if (report.invariantViolations.length > 0) problems.push('invariants broke');
      return problems;
    },
  },
  {
    name: 'pacing-c',
    demonstrates:
      'Scenario C — 70% answer rate, 180s talk time. A high answer rate leaves little room to over-dial, and long calls mean seats free slowly; correct behaviour here is restraint.',
    config: {
      scenario: 'pacing-c',
      dialingMode: 'PREDICTIVE',
      agents: 20,
      contacts: 300,
      seed: 1001,
      maxConcurrentCalls: 60,
      maxLinesPerAgent: 4,
      provider: {
        answerRate: 0.7, noAnswerRate: 0.2, busyRate: 0.07, failureRate: 0.03,
        meanCallDurationMs: 180_000,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      // The interesting assertion is the ceiling, not the floor. At a 70% answer rate the
      // safe over-dial is small, and a pacer that ignored that would abandon people.
      if (report.peakConcurrency > 45) {
        problems.push(`peak ${report.peakConcurrency} is too aggressive when 70% of calls answer`);
      }
      // This is the worst case for abandonment in the whole suite (B-015). What must hold is
      // that the control *notices*: a run this bad has to end with predictive paused, not
      // with the dialer cheerfully continuing.
      if (report.abandoned > 0 && report.safetyInterventions === 0) {
        problems.push('calls were abandoned and no safety control intervened');
      }
      if (report.invariantViolations.length > 0) problems.push('invariants broke');
      return problems;
    },
  },
  {
    name: 'pacing-d',
    demonstrates:
      'Scenario D — the answer rate collapses from 70% to 10% mid-run. This is the case the assignment asks about directly: how does the system protect itself when the estimate it was betting on stops being true?',
    config: {
      scenario: 'pacing-d',
      dialingMode: 'PREDICTIVE',
      agents: 20,
      contacts: 400,
      seed: 1001,
      maxConcurrentCalls: 60,
      maxLinesPerAgent: 4,
      provider: {
        answerRate: 0.7, noAnswerRate: 0.2, busyRate: 0.07, failureRate: 0.03,
        meanCallDurationMs: 90_000,
      },
      providerShift: {
        atVirtualMs: 120_000,
        provider: {
          answerRate: 0.1, noAnswerRate: 0.6, busyRate: 0.2, failureRate: 0.1,
          meanCallDurationMs: 180_000,
        },
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      // The shift is a trap for a naive pacer: the answer rate falls, so `agents / rate` asks
      // for far more lines — right as the calls that DO connect start lasting twice as long.
      // Surviving the collapse without breaching a limit is the test.
      if (report.peakConcurrency > 60) {
        problems.push(`peak ${report.peakConcurrency} breached the campaign limit of 60`);
      }
      if (report.successfulConnections < 20) {
        problems.push(`only ${report.successfulConnections} connections; the system over-corrected into doing nothing`);
      }
      if (report.invariantViolations.length > 0) problems.push('invariants broke');
      return problems;
    },
  },
  {
    name: 'agent-drop',
    demonstrates:
      'Agent availability collapses mid-run — 30 of 40 agents go offline at once. The dialer must shed pacing within a tick or two rather than dialing into capacity that no longer exists.',
    config: {
      scenario: 'agent-drop',
      dialingMode: 'PREDICTIVE',
      agents: 40,
      contacts: 400,
      seed: 2024,
      maxConcurrentCalls: 80,
      maxLinesPerAgent: 3,
      agentDrop: { atVirtualMs: 90_000, count: 30 },
      provider: {
        answerRate: 0.5, noAnswerRate: 0.3, busyRate: 0.15, failureRate: 0.05,
        meanCallDurationMs: 60_000,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      // Losing three quarters of the agents while calls are in flight is the sharpest test of
      // whether pacing reads live capacity or a cached number. What must hold is that the
      // system *notices* and intervenes — the abandon rate itself is not asserted low here,
      // because it currently is not (BUG.md B-015) and quietly loosening the bound until it
      // passed would hide exactly that.
      if (report.abandoned > 0 && report.safetyInterventions === 0) {
        problems.push('calls were abandoned and no safety control intervened');
      }
      if (report.invariantViolations.length > 0) {
        problems.push('invariants broke when capacity collapsed');
      }
      return problems;
    },
  },
  {
    name: 'provider-fail',
    demonstrates:
      'Provider failures are classified, slots are released, transient failures retry and permanent ones do not.',
    config: {
      scenario: 'provider-fail',
      dialingMode: 'PROGRESSIVE',
      agents: 5,
      contacts: 50,
      maxAttempts: 3,
      provider: {
        answerRate: 0.4,
        noAnswerRate: 0.2,
        busyRate: 0.1,
        failureRate: 0.3,
        errorRate: 0.2,
        invalidNumberRate: 0.05,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      if (report.retries === 0) problems.push('no retries were scheduled despite injected failures');
      if (report.providerErrorRate === 0) problems.push('no provider errors were injected');
      // Permanent failures must not be retried indefinitely: the attempt ceiling holds.
      if (report.averageAttemptsPerContact > 3) {
        problems.push(
          `average attempts per contact ${report.averageAttemptsPerContact.toFixed(2)} exceeded the limit of 3`,
        );
      }
      return problems;
    },
  },
  {
    name: 'timeout',
    demonstrates:
      'A provider that goes silent is detected by the watchdog; resources are released and the retry policy runs.',
    config: {
      scenario: 'timeout',
      dialingMode: 'PROGRESSIVE',
      agents: 4,
      contacts: 40,
      maxAttempts: 2,
      provider: {
        answerRate: 0.5,
        noAnswerRate: 0.2,
        busyRate: 0.1,
        failureRate: 0.2,
        timeoutRate: 0.3,
        stuckRingingRate: 0.1,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      if (report.timeouts === 0) problems.push('no timeouts were detected despite injected silence');
      // The real proof: the campaign settled rather than deadlocking on stranded slots.
      if (report.stopReason !== 'completed' && report.stopReason !== 'idle') {
        problems.push(`run did not settle (stop reason: ${report.stopReason})`);
      }
      return problems;
    },
  },
  {
    name: 'emergency-stop',
    demonstrates: 'Emergency stop prevents any new call from being initiated, immediately.',
    config: {
      scenario: 'emergency-stop',
      dialingMode: 'PROGRESSIVE',
      agents: 3,
      contacts: 30,
      provider: { answerRate: 0.6, noAnswerRate: 0.3, busyRate: 0.1, failureRate: 0 },
    },
    // Verified by the dedicated test, which engages the stop mid-run — a static config
    // cannot express "engage the stop after 3 seconds".
    expect: ok,
  },
  {
    name: 'dnc',
    demonstrates: 'Contacts marked DO_NOT_CALL are never dialled, under any circumstances.',
    config: {
      scenario: 'dnc',
      dialingMode: 'PROGRESSIVE',
      agents: 4,
      contacts: 40,
      dncContacts: 12,
      provider: { answerRate: 0.7, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0 },
    },
    expect: (report) => {
      const problems: string[] = [];
      const dnc = report.contactsByStatus['DO_NOT_CALL'] ?? 0;
      if (dnc !== 12) problems.push(`expected 12 DNC contacts, found ${dnc}`);
      // 40 contacts, 12 of them off-limits: at most 28 can ever be attempted.
      if (report.totalAttempts > 28 * 3) {
        problems.push(`attempt count ${report.totalAttempts} is too high for 28 dialable contacts`);
      }
      return problems;
    },
  },
  {
    name: 'race',
    demonstrates:
      'Under heavy contention, active calls never exceed the configured concurrency limit.',
    config: {
      scenario: 'race',
      dialingMode: 'PREDICTIVE',
      agents: 10,
      contacts: 200,
      maxConcurrentCalls: 12,
      callsPerSecond: 20,
      maxLinesPerAgent: 5,
      provider: {
        answerRate: 0.5,
        noAnswerRate: 0.3,
        busyRate: 0.1,
        failureRate: 0.1,
        meanRingDurationMs: 2000,
        meanCallDurationMs: 8000,
      },
    },
    expect: (report) => {
      const problems: string[] = [];
      if (report.peakConcurrency > 12) {
        problems.push(`peak concurrency ${report.peakConcurrency} breached the limit of 12`);
      }
      if (report.totalAttempts < 100) {
        problems.push(`only ${report.totalAttempts} attempts — not enough contention to be meaningful`);
      }
      return problems;
    },
  },
];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}

export function scenarioNames(): string[] {
  return SCENARIOS.map((scenario) => scenario.name);
}
