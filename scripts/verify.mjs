/**
 * `npm run verify` — run the whole verification checklist and report honestly.
 *
 * TEST_CHECKLIST.md describes what must pass; this executes it. Having the checklist as prose
 * only means it gets run selectively, and the row nobody re-ran is the row that breaks.
 *
 * Every step runs even if an earlier one fails, because "typecheck failed" and "typecheck
 * failed AND four scenarios regressed" call for very different responses, and stopping at the
 * first failure hides the difference. Exit code is non-zero if anything failed, so this is
 * usable directly in CI.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const quick = args.has('--quick'); // skip the build and the scenario sweep

const steps = [
  { name: 'typecheck', cmd: 'npm', args: ['run', '--silent', 'typecheck'] },
  { name: 'lint', cmd: 'npx', args: ['eslint', '.'] },
  { name: 'unit tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'server', 'tests/unit'] },
  { name: 'integration tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'server', 'tests/integration'] },
  { name: 'concurrency tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'server', 'tests/concurrency'] },
  { name: 'failure tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'server', 'tests/failure'] },
  { name: 'simulation tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'server', 'tests/simulation'] },
  { name: 'web tests', cmd: 'npx', args: ['vitest', 'run', '--project', 'web'] },
];

if (!quick) {
  steps.push({ name: 'build', cmd: 'npx', args: ['vite', 'build'] });
  steps.push({
    name: 'migrate',
    cmd: 'node',
    args: ['--experimental-strip-types', '--env-file-if-exists=.env', 'scripts/migrate.mjs'],
    env: { DATABASE_PATH: './data/verify.db' },
  });
  steps.push({
    name: 'seed',
    cmd: 'node',
    args: ['--experimental-strip-types', '--env-file-if-exists=.env', 'scripts/seed.mjs'],
    env: { DATABASE_PATH: './data/verify.db' },
  });

  // The scenarios are the highest-value check: each asserts both that its invariants held and
  // that it actually demonstrated the behaviour it claims.
  for (const scenario of [
    'progressive', 'predictive', 'predictive-small-team', 'provider-fail',
    'timeout', 'emergency-stop', 'dnc', 'race',
  ]) {
    steps.push({
      name: `scenario: ${scenario}`,
      cmd: 'node',
      args: ['--experimental-strip-types', '--env-file-if-exists=.env', 'src/sim/scenario-cli.ts', scenario],
    });
  }
}

const results = [];
const verbose = args.has('--verbose');
const defaultNodeOptions = [process.env.NODE_OPTIONS, '--experimental-strip-types'].filter(Boolean).join(' ');

for (const step of steps) {
  process.stdout.write(`  ${step.name.padEnd(28)} `);
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args, {
    stdio: verbose ? 'inherit' : 'pipe',
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: defaultNodeOptions, ...step.env },
  });
  const ms = Date.now() - started;
  const ok = result.status === 0;
  results.push({ ...step, ok, ms, output: `${result.stdout ?? ''}${result.stderr ?? ''}` });
  console.log(ok ? `PASS  ${ms}ms` : `FAIL  ${ms}ms`);
}

rmSync('./data/verify.db', { force: true });
for (const suffix of ['-wal', '-shm']) rmSync(`./data/verify.db${suffix}`, { force: true });

const failed = results.filter((r) => !r.ok);

if (failed.length > 0) {
  console.log(`\n${'─'.repeat(60)}\nFAILURES\n${'─'.repeat(60)}`);
  for (const step of failed) {
    console.log(`\n### ${step.name}`);
    // Tail rather than the whole log: the useful part of a test or tsc failure is at the end.
    console.log((step.output || '(no output captured; re-run with --verbose)').trim().split('\n').slice(-25).join('\n'));
  }
}

const total = results.reduce((sum, r) => sum + r.ms, 0);
console.log(`\n${'─'.repeat(60)}`);
console.log(
  failed.length === 0
    ? `VERIFICATION PASSED — ${results.length} steps in ${(total / 1000).toFixed(1)}s`
    : `VERIFICATION FAILED — ${failed.length} of ${results.length} steps: ${failed.map((f) => f.name).join(', ')}`,
);
process.exit(failed.length === 0 ? 0 : 1);
