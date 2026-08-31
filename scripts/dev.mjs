/**
 * `npm run dev` — API and dashboard together.
 *
 * A ten-line supervisor rather than a `concurrently` dependency. Both children inherit stdio
 * so their logs interleave in one terminal, and killing either takes down the other — a dev
 * command that leaves an orphaned API server listening is worse than no dev command.
 */
import { spawn } from 'node:child_process';

const children = [
  spawn('node', ['--watch', 'src/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env: process.env }),
];

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code ?? 0);
};

for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
  child.on('error', (error) => {
    console.error('Failed to start dev process:', error.message);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
