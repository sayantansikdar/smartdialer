/**
 * Refuse to rewrite the database underneath a running server.
 *
 * Ids are sequential and their counters are restored from the database once, at startup
 * (BUG.md B-005). A script that writes new rows while the server is up leaves those counters
 * stale, and the server's next insert collides — surfacing as an opaque 500 on an unrelated
 * request, long after the actual mistake.
 *
 * Detecting it here turns a baffling runtime failure into a sentence telling you what to do.
 */
export async function assertServerNotRunning(action, databasePath) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';

  let health;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    const response = await fetch(`http://${host}:${port}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    health = response.ok ? await response.json() : null;
  } catch {
    // Nothing listening, or not our server. Either way, safe to proceed.
    health = null;
  }

  if (health === null) return;

  // The hazard is writing to a database a running process has already cached id counters
  // from — not the mere existence of a server. Seeding a *different* database while the dev
  // server runs is perfectly safe, and refusing it would make `npm run verify` fail for
  // anyone with the app open.
  if (databasePath !== undefined && health.databasePath !== undefined) {
    if (health.databasePath !== databasePath) return;
  }

  console.error(
    `\n  Refusing to ${action}: a SmartDialer is running on ${host}:${port}.\n\n` +
      `  It restored its id counters from the database when it started, so rows written\n` +
      `  now would collide with the ones it issues next (see BUG.md B-005).\n\n` +
      `  Stop it first, then re-run:\n\n` +
      `      lsof -ti:${port} | xargs kill\n`,
  );
  process.exit(1);
}
