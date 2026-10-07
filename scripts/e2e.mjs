/**
 * `npm run e2e` — browser end-to-end tests against a real, isolated stack.
 *
 * Boots its own API and its own dashboard rather than reusing whatever `npm run dev` has
 * running. The scenarios start campaigns, engage the emergency stop and inject provider
 * faults; doing that against a developer's live database would leave it in a state nobody
 * chose. The database is rebuilt from nothing on every run, so a run can never depend on
 * leftovers from the previous one.
 *
 *   npm run e2e                          headless, every feature
 *   npm run e2e -- --expose tags=@safety  headless, tagged subset
 *   npm run e2e:open                     the interactive Cypress runner
 *
 * Any extra arguments are passed straight through to `cypress run` / `cypress open`.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const DATABASE_PATH = './data/e2e.db';

const args = process.argv.slice(2);
const open = args[0] === '--open';
const cypressArgs = open ? args.slice(1) : args;

for (const suffix of ['', '-wal', '-shm']) rmSync(`${DATABASE_PATH}${suffix}`, { force: true });
// Screenshots from a previous run would otherwise sit beside this run's and look like new failures.
rmSync('cypress/screenshots', { recursive: true, force: true });
// Allure builds its report from every file in the results folder, so stale results would be
// reported as if this run had produced them.
rmSync('allure-results', { recursive: true, force: true });

const apiUrl = `http://127.0.0.1:${API_PORT}`;
const webUrl = `http://127.0.0.1:${WEB_PORT}`;

const children = [
  spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      SIMULATION_MODE: 'true',
      PORT: String(API_PORT),
      DATABASE_PATH,
      LOG_LEVEL: 'error',
      // Fast enough that the 45s provider watchdog fires in a couple of real seconds, slow
      // enough that a 100-contact campaign is still running when the next step looks at it.
      SIMULATION_SPEED: '20',
    },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, API_PROXY_TARGET: apiUrl },
  }),
];

let finished = false;
const shutdown = (code) => {
  finished = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

// A server that dies before the tests finish would otherwise surface as forty confusing
// "cy.request failed" errors. Say what actually happened instead.
for (const child of children) {
  child.on('exit', (code) => {
    if (finished) return;
    console.error(`\n  e2e: a server process exited early (code ${code}). Is port ${API_PORT} or ${WEB_PORT} in use?\n`);
    shutdown(1);
  });
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`\n  e2e: ${label} did not come up at ${url} within 30s.\n`);
  shutdown(1);
}

await waitFor(`${apiUrl}/api/health`, 'the API');
// Through the dashboard's proxy, so a misrouted proxy fails here rather than mid-suite.
await waitFor(`${webUrl}/api/health`, 'the dashboard');
console.log(`\n  e2e stack up — API ${apiUrl} · dashboard ${webUrl} · database ${DATABASE_PATH}\n`);

const cypress = spawn('npx', ['cypress', open ? 'open' : 'run', '--e2e', ...cypressArgs], {
  stdio: 'inherit',
  env: { ...process.env, CYPRESS_BASE_URL: webUrl },
});
cypress.on('exit', (code) => shutdown(code ?? 1));
