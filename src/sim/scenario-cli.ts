/**
 * `npm run scenario -- <name> [--seed N]`
 *
 * Runs one predefined scenario to completion and prints its report, ending with the line
 * that actually matters:
 *
 *     INVARIANTS: PASSED
 *
 * The process exits non-zero if an invariant was violated or the scenario failed to
 * demonstrate what it claims — so this is usable directly in a verification checklist, not
 * just as something pretty to watch.
 */

import { loadConfig } from '../config/index.ts';
import { createLogger } from '../core/logger.ts';
import { SimulationClock } from './clock-stub.ts';
import { Database } from '../db/database.ts';
import { migrate } from '../db/migrator.ts';
import { SimulationRepository } from '../db/repositories/simulation-repository.ts';
import { SimulationService, type SimulationReport } from '../services/simulation.ts';
import { findScenario, scenarioNames } from './scenarios.ts';

function parseArgs(argv: readonly string[]): { name: string; seed: number | null } {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const seedFlag = argv.find((arg) => arg.startsWith('--seed='));
  const seedIndex = argv.indexOf('--seed');
  const seedRaw =
    seedFlag !== undefined ? seedFlag.slice('--seed='.length) : argv[seedIndex + 1] ?? null;

  return {
    name: positional[0] ?? '',
    seed: seedIndex >= 0 || seedFlag !== undefined ? Number(seedRaw) : null,
  };
}

function row(label: string, value: string | number): string {
  return `  ${label.padEnd(28)} ${String(value)}`;
}

function formatReport(report: SimulationReport): string {
  const lines = [
    '',
    `Scenario: ${report.scenario}   seed: ${report.seed}   mode: ${report.dialingMode}`,
    '─'.repeat(62),
    row('Total contacts', report.totalContacts),
    row('Total attempts', report.totalAttempts),
    row('Successful connections', report.successfulConnections),
    row('No answers', report.noAnswers),
    row('Busy', report.busy),
    row('Failures', report.failures),
    row('Timeouts', report.timeouts),
    row('Abandoned', report.abandoned),
    row('Cancelled', report.cancelled),
    row('Retries scheduled', report.retries),
    '',
    row('Avg attempts / contact', report.averageAttemptsPerContact.toFixed(2)),
    row('Avg call duration', `${(report.averageCallDurationMs / 1000).toFixed(1)}s`),
    row('Peak concurrency', report.peakConcurrency),
    row('Average concurrency', report.averageConcurrency),
    row('Agent utilization', `${(report.agentUtilization * 100).toFixed(1)}%`),
    row('Answer rate', `${(report.answerRate * 100).toFixed(1)}%`),
    row('Abandon rate', `${(report.abandonRate * 100).toFixed(1)}%`),
    row('Provider error rate', `${(report.providerErrorRate * 100).toFixed(1)}%`),
    row('Safety interventions', report.safetyInterventions),
    row('Capacity backpressure', report.capacityBackpressure),
    '',
    row('Simulated duration', `${(report.virtualDurationMs / 1000).toFixed(1)}s`),
    row('Real duration', `${report.realDurationMs}ms`),
    row('Events recorded', report.totalEvents),
    row('Stop reason', report.stopReason),
    row('Contacts by status', JSON.stringify(report.contactsByStatus)),
    '─'.repeat(62),
  ];
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { name, seed } = parseArgs(process.argv.slice(2));

  const scenario = findScenario(name);
  if (scenario === undefined) {
    console.error(
      name === ''
        ? `Usage: npm run scenario -- <name> [--seed N]\nAvailable: ${scenarioNames().join(', ')}`
        : `Unknown scenario "${name}". Available: ${scenarioNames().join(', ')}`,
    );
    return 2;
  }

  const config = loadConfig();
  const clock = new SimulationClock();
  const logger = createLogger({ level: 'warn', clock, epochMs: config.epochMs });

  // The scenario runner keeps its own throwaway database for the run record; every
  // simulation builds its own isolated in-memory system regardless.
  const db = new Database(':memory:');
  migrate(db);

  const service = new SimulationService({
    baseConfig: config,
    repository: new SimulationRepository(db),
    logger,
  });

  console.log(`\n${scenario.demonstrates}`);
  const report = await service.runToCompletion({
    ...scenario.config,
    ...(seed === null || Number.isNaN(seed) ? {} : { seed }),
  });

  console.log(formatReport(report));

  const unmet = scenario.expect(report);
  if (unmet.length > 0) {
    console.log('\nEXPECTATIONS: FAILED');
    for (const problem of unmet) console.log(`  - ${problem}`);
  } else {
    console.log('\nEXPECTATIONS: PASSED');
  }

  if (report.invariantsPassed) {
    console.log('INVARIANTS: PASSED\n');
  } else {
    console.log('INVARIANTS: FAILED');
    for (const violation of report.invariantViolations) {
      console.log(`  - [${violation.invariant}] ${violation.detail}`);
    }
    console.log('');
  }

  db.close();
  return report.invariantsPassed && unmet.length === 0 ? 0 : 1;
}

process.exitCode = await main();
