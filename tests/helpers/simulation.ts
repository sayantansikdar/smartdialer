import { createHash } from 'node:crypto';
import { loadConfig } from '../../src/config/index.ts';
import { createSilentLogger } from '../../src/core/logger.ts';
import { Database } from '../../src/db/database.ts';
import { migrate } from '../../src/db/migrator.ts';
import { SimulationRepository } from '../../src/db/repositories/simulation-repository.ts';
import type { SmartDialerEvent } from '../../src/domain/events.ts';
import {
  SimulationService,
  type SimulationConfig,
  type SimulationReport,
} from '../../src/services/simulation.ts';

export interface SimulationRunResult {
  readonly report: SimulationReport;
  /**
   * A SHA-256 over the ordered event stream.
   *
   * This is the determinism proof. Comparing reports would only show that the aggregates
   * matched; comparing a digest of every event, in order, with its virtual timestamp, shows
   * that the two runs did the *same things at the same moments*. It catches
   * non-determinism anywhere in the engine — iteration order, timer ties, an unseeded draw
   * — not just in the RNG.
   */
  readonly digest: string;
  readonly events: readonly SmartDialerEvent[];
}

export async function runSimulation(
  config: Partial<SimulationConfig>,
): Promise<SimulationRunResult> {
  const db = new Database(':memory:');
  migrate(db);

  const events: SmartDialerEvent[] = [];
  const service = new SimulationService({
    baseConfig: loadConfig({ SIMULATION_MODE: 'true', DATABASE_PATH: ':memory:', NODE_ENV: 'test' }),
    repository: new SimulationRepository(db),
    logger: createSilentLogger(),
    onEvent: (_id, event) => events.push(event),
  });

  try {
    const report = await service.runToCompletion(config);
    const hash = createHash('sha256');
    for (const event of events) {
      // Ids are excluded deliberately: they are sequential, so including them would make the
      // digest pass trivially. Type, virtual time and correlation are the substance.
      hash.update(
        `${event.at}|${event.type}|${event.campaignId ?? ''}|${event.contactId ?? ''}|` +
          `${event.callId ?? ''}|${event.agentId ?? ''}\n`,
      );
    }
    return { report, digest: hash.digest('hex'), events };
  } finally {
    db.close();
  }
}
