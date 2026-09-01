/**
 * `npm run load` — measure where this design actually breaks.
 *
 * The assignment asks what breaks first at 100 → 1,000 → 10,000 agents, and says "add more
 * servers" is not an answer. So this measures rather than speculates: it runs the real engine
 * at increasing agent counts and reports throughput, per-tick cost and where the time goes.
 *
 * It is a *load* test, not a benchmark. The numbers depend on this machine and are only
 * meaningful relative to each other — the shape of the curve is the finding, not the
 * absolute figures.
 */
const { loadConfig } = await import('../src/config/index.ts');
const { SimulationService } = await import('../src/services/simulation.ts');
const { SimulationRepository } = await import('../src/db/repositories/simulation-repository.ts');
const { Database } = await import('../src/db/database.ts');
const { migrate } = await import('../src/db/migrator.ts');
const { createSilentLogger } = await import('../src/core/logger.ts');

const sizes = process.argv.includes('--quick') ? [50, 200] : [50, 200, 1000, 3000];
const rows = [];

console.log('\n  SmartDialer load test — real engine, virtual clock, one process\n');

for (const agents of sizes) {
  const db = new Database(':memory:');
  migrate(db);
  const service = new SimulationService({
    baseConfig: loadConfig({ SIMULATION_MODE: 'true', DATABASE_PATH: ':memory:', NODE_ENV: 'test' }),
    repository: new SimulationRepository(db),
    logger: createSilentLogger(),
  });

  // Contacts scale with agents so every run is capacity-bound rather than contact-bound —
  // otherwise the larger runs would just finish early and measure nothing.
  const contacts = agents * 8;
  const started = Date.now();
  const report = await service.runToCompletion({
    scenario: `load-${agents}`,
    dialingMode: 'PREDICTIVE',
    agents,
    contacts,
    seed: 4242,
    maxConcurrentCalls: agents * 3,
    callsPerSecond: agents,
    maxLinesPerAgent: 3,
    maxVirtualMs: 5 * 60_000,
    provider: {
      answerRate: 0.5, noAnswerRate: 0.3, busyRate: 0.15, failureRate: 0.05,
      meanCallDurationMs: 30_000, maxConcurrentCalls: agents * 4,
    },
  });
  const realMs = Date.now() - started;
  db.close();

  const ticks = Math.max(1, Math.round(report.virtualDurationMs / 250));
  rows.push({
    agents,
    contacts,
    attempts: report.totalAttempts,
    connected: report.successfulConnections,
    peak: report.peakConcurrency,
    utilisation: `${(report.agentUtilization * 100).toFixed(0)}%`,
    events: report.totalEvents,
    realMs,
    msPerTick: (realMs / ticks).toFixed(2),
    usPerEvent: report.totalEvents === 0 ? '—' : ((realMs * 1000) / report.totalEvents).toFixed(0),
    invariants: report.invariantsPassed ? 'PASS' : 'FAIL',
  });
}

console.table(rows);

// The shape of the curve is the finding. Linear ms/tick means the per-tick work is constant
// per agent; superlinear means something in the tick is scanning a growing set.
const first = rows[0];
const last = rows[rows.length - 1];
const agentRatio = last.agents / first.agents;
const costRatio = Number(last.msPerTick) / Math.max(Number(first.msPerTick), 0.001);

console.log(`  Agents scaled ${agentRatio.toFixed(0)}x; cost per tick scaled ${costRatio.toFixed(1)}x.`);
console.log(
  costRatio > agentRatio * 1.5
    ? '  -> SUPERLINEAR. Something in the tick scans a set that grows with the campaign.\n'
    : '  -> Roughly linear in agent count, as expected for a per-tick snapshot.\n',
);
console.log('  See SCALE.md for what this means and what would break first.\n');
