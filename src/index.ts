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

main().catch((error: unknown) => {
  // Startup failures print in full and exit non-zero. A dialer that half-started would be
  // worse than one that did not start at all.
  const logger = createLogger({ level: 'error', clock: new SimulatedClock() });
  if (isSmartDialerError(error)) {
    logger.error(error.message, { code: error.code, ...error.metadata });
  } else {
    logger.error('Failed to start', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  process.exit(1);
});
