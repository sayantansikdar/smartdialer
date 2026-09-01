/**
 * Server entry point.
 *
 * Boots in a deliberate order: validate configuration, refuse to start if the safety gate is
 * not satisfied, open the database, build the container, then listen. Configuration problems
 * surface before anything is listening, so a misconfigured dialer never reaches a state where
 * it could accept a request.
 */

import { loadConfig } from './config/index.ts';
import { createLogger } from './core/logger.ts';
import { isSmartDialerError } from './core/errors.ts';
import { SimulatedClock } from './core/clock.ts';
import { createContainer, DEFAULT_PROVIDER_ID } from './container.ts';
import { SimulationService } from './services/simulation.ts';
import { buildServer } from './api/server.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const container = createContainer({ config });
  const { logger } = container;

  for (const warning of config.warnings) {
    logger.warn(warning, { event: 'config.warning' });
  }

  // The live dashboard runs on the paced driver: virtual time advances against real time,
  // scaled by SIMULATION_SPEED. Without this the clock never moves and nothing ever dials.
  container.pacedDriver.start();

  const simulations = new SimulationService({
    baseConfig: config,
    repository: container.repositories.simulations,
    logger,
  });

  const app = buildServer({ container, simulations });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}; shutting down`, { event: 'server.shutdown' });
    container.pacedDriver.stop();
    await app.close();
    container.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.server.port, host: config.server.host });

  logger.info('SmartDialer API listening', {
    event: 'server.started',
    url: `http://${config.server.host}:${config.server.port}`,
    simulationMode: config.simulationMode,
    providerDriver: config.providerDriver,
    defaultProvider: DEFAULT_PROVIDER_ID,
    speed: container.pacedDriver.speed,
  });

  // Printed plainly as well as logged: the safety posture should be the first thing anyone
  // starting this process sees (CONSTRAINTS.md §1).
  process.stdout.write(
    `\n  SmartDialer  →  http://${config.server.host}:${config.server.port}\n` +
      `  SIMULATION MODE — mock provider "${config.providerDriver}". No real calls are placed.\n` +
      `  Clock speed ${container.pacedDriver.speed}x\n\n`,
  );
}

/**
 * Turn a startup failure into something actionable.
 *
 * The default messages for the two most common ones are actively unhelpful: `EADDRINUSE`
 * names a syscall, and SQLite's "unable to open database file" reads like corruption when it
 * usually means a missing directory or a bad path. Someone hitting these is, by definition,
 * someone who has not got the app running yet — the worst moment to hand them a stack trace.
 */
function explainStartupFailure(error: unknown): string | null {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'EADDRINUSE') {
    const port = Number(process.env['PORT'] ?? 3000);
    return [
      `Port ${port} is already in use.`,
      '',
      '  Another SmartDialer may already be running. Either stop it, or use a different port:',
      '',
      `      PORT=${port + 1} npm run dev`,
      '',
      '  To find what is holding the port:',
      '',
      `      lsof -ti:${port}`,
    ].join('\n');
  }

  if (message.includes('unable to open database file')) {
    return [
      `Could not open the database at ${process.env['DATABASE_PATH'] ?? './data/smartdialer.db'}.`,
      '',
      '  Check that DATABASE_PATH points somewhere writable, then rebuild it:',
      '',
      '      npm run db:reset && npm run seed',
    ].join('\n');
  }

  return null;
}

main().catch((error: unknown) => {
  // Startup failures print in full and exit non-zero. A dialer that half-started would be
  // worse than one that did not start at all.
  const explanation = explainStartupFailure(error);
  if (explanation !== null) {
    process.stderr.write(`\n  SmartDialer could not start.\n\n  ${explanation}\n\n`);
    process.exit(1);
  }

  // A bare clock starts at virtual zero, which stamped every startup failure 1970-01-01 and
  // made a real error look like a broken build. Configuration may itself be what failed, so
  // the epoch is read defensively rather than through loadConfig.
  const epochMs = Number(process.env['EPOCH_MS'] ?? Date.parse('2026-01-01T09:00:00.000Z'));
  const logger = createLogger({ level: 'error', clock: new SimulatedClock(), epochMs });
  if (isSmartDialerError(error)) {
    logger.error(error.message, { code: error.code, ...error.metadata });
    // A configuration refusal is a decision, not a crash — say what to do about it.
    if (error.code === 'SIMULATION_MODE_REQUIRED') {
      process.stderr.write(
        '\n  This prototype only simulates telephony and has no real-provider\n' +
          '  implementation. Set SIMULATION_MODE=true in your .env to start.\n\n',
      );
    }
  } else {
    logger.error('Failed to start', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  process.exit(1);
});
