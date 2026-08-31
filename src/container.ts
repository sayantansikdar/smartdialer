/**
 * The composition root.
 *
 * Everything is constructed here and nowhere else. There are no module-level singletons and
 * no service that reaches out for its own dependencies (CONSTRAINTS.md §3) — which is what
 * lets a test build an entire, isolated SmartDialer with its own in-memory database, its own
 * clock and its own seed, and run a hundred of them in the same process without interference.
 *
 * It is also the one place that decides which clock driver is in play: the fast driver for
 * tests and instant simulations, the paced driver for the live dashboard. Both drive the
 * same engine (DECISIONS.md D-003).
 */

import { FastDriver, PacedDriver, SimulatedClock } from './core/clock.ts';
import { EventBus } from './core/event-bus.ts';
import { IdGenerator } from './core/ids.ts';
import { createLogger, createSilentLogger, type Logger } from './core/logger.ts';
import { RNG_STREAMS, SeededRandom } from './core/rng.ts';
import type { AppConfig } from './config/index.ts';
import { Database } from './db/database.ts';
import { migrate } from './db/migrator.ts';
import { restoreIdCounters } from './db/id-recovery.ts';
import { AgentRepository } from './db/repositories/agent-repository.ts';
import { CallRepository } from './db/repositories/call-repository.ts';
import { CampaignRepository } from './db/repositories/campaign-repository.ts';
import { ContactRepository } from './db/repositories/contact-repository.ts';
import { EventRepository } from './db/repositories/event-repository.ts';
import { ProviderConfigRepository } from './db/repositories/provider-config-repository.ts';
import { SimulationRepository } from './db/repositories/simulation-repository.ts';
import type { SmartDialerEvent } from './domain/events.ts';
import { createProvider, ProviderRegistry } from './providers/registry.ts';
import type { MockProviderConfig } from './providers/mock-provider.ts';
import { AgentService } from './services/agent-service.ts';
import { CampaignService } from './services/campaign-service.ts';
import { ConcurrencyService } from './services/concurrency.ts';
import { ContactService } from './services/contact-service.ts';
import { DialerEngine } from './services/dialer-engine.ts';
import { EventService } from './services/event-service.ts';
import { InvariantChecker, type InvariantMode } from './services/invariants.ts';
import { MetricsService } from './services/metrics.ts';
import { RateLimiterRegistry } from './services/rate-limiter.ts';
import { RetryService } from './services/retry.ts';
import { SafetyEngine } from './services/safety.ts';
import { SystemService } from './services/system-service.ts';

/** The default provider every seeded campaign uses. */
export const DEFAULT_PROVIDER_ID = 'mock-provider';

export interface ContainerOptions {
  readonly config: AppConfig;
  /** Overrides `config.simulation.seed`. */
  readonly seed?: number;
  /** 'throw' in tests so a violation fails at the transition that caused it. */
  readonly invariantMode?: InvariantMode;
  readonly silentLogger?: boolean;
  readonly providerConfig?: Partial<MockProviderConfig>;
}

export interface Container {
  readonly config: AppConfig;
  readonly clock: SimulatedClock;
  readonly fastDriver: FastDriver;
  readonly pacedDriver: PacedDriver;
  readonly random: SeededRandom;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly db: Database;
  readonly bus: EventBus<SmartDialerEvent>;

  readonly repositories: {
    readonly campaigns: CampaignRepository;
    readonly contacts: ContactRepository;
    readonly agents: AgentRepository;
    readonly calls: CallRepository;
    readonly events: EventRepository;
    readonly simulations: SimulationRepository;
    readonly providerConfigs: ProviderConfigRepository;
  };

  readonly providers: ProviderRegistry;
  readonly concurrency: ConcurrencyService;
  readonly rateLimiters: RateLimiterRegistry;
  readonly safety: SafetyEngine;
  readonly retry: RetryService;
  readonly metrics: MetricsService;
  readonly events: EventService;
  readonly system: SystemService;
  readonly agentService: AgentService;
  readonly contactService: ContactService;
  readonly engine: DialerEngine;
  readonly campaignService: CampaignService;
  readonly invariants: InvariantChecker;

  close(): void;
}

export function createContainer(options: ContainerOptions): Container {
  const { config } = options;

  const clock = new SimulatedClock({
    // The paced driver must survive one bad callback: a thrown error inside a timer would
    // otherwise stop the live dashboard's clock entirely. Recorded, never swallowed.
    onTimerError: (error, label) => {
      logger.error('Timer callback failed', { label, error: String(error) });
    },
  });
  const fastDriver = new FastDriver(clock);
  const pacedDriver = new PacedDriver(clock, { speed: config.simulation.speed });

  const logger: Logger =
    options.silentLogger === true
      ? createSilentLogger()
      : createLogger({ level: config.server.logLevel, clock, epochMs: config.epochMs });

  const random = new SeededRandom(options.seed ?? config.simulation.seed);
  const ids = new IdGenerator();

  const db = new Database(config.databasePath);
  migrate(db);

  // Sequential ids are only unique within a process unless the generator is told what the
  // database already holds. Against a persistent database a restart would otherwise reopen
  // every counter at 1 and collide on the first insert (BUG.md B-005). A fresh in-memory
  // database restores nothing, so tests and simulations stay byte-for-byte deterministic.
  const restoredIds = restoreIdCounters(db, ids);
  if (Object.keys(restoredIds).length > 0) {
    logger.debug('Restored id counters from the database', {
      event: 'ids.restored',
      ...restoredIds,
    });
  }

  const repositories = {
    campaigns: new CampaignRepository(db),
    contacts: new ContactRepository(db),
    agents: new AgentRepository(db),
    calls: new CallRepository(db),
    events: new EventRepository(db),
    simulations: new SimulationRepository(db),
    providerConfigs: new ProviderConfigRepository(db),
  };

  const bus = new EventBus<SmartDialerEvent>({
    onHandlerError: (error, event) => {
      logger.error('Event subscriber failed', { event: event.type, error: String(error) });
    },
  });

  const events = new EventService({ bus, repository: repositories.events, clock, ids, logger });

  const providers = new ProviderRegistry();
  providers.register(
    createProvider({
      id: DEFAULT_PROVIDER_ID,
      driver: config.providerDriver,
      clock,
      random,
      ...(options.providerConfig === undefined ? {} : { config: options.providerConfig }),
    }),
  );

  const concurrency = new ConcurrencyService({
    clock,
    globalMaxConcurrentCalls: config.limits.globalMaxConcurrentCalls,
    providerMaxConcurrentCalls: config.limits.providerMaxConcurrentCalls,
  });
  const rateLimiters = new RateLimiterRegistry({
    clock,
    globalRatePerSecond: config.limits.globalCallsPerSecond,
  });
  const safety = new SafetyEngine();
  const retry = new RetryService({ jitterRng: random.stream(RNG_STREAMS.retryJitter) });
  const metrics = new MetricsService({
    calls: repositories.calls,
    contacts: repositories.contacts,
    agents: repositories.agents,
    events: repositories.events,
  });

  const system = new SystemService({
    clock,
    events,
    simulationMode: config.simulationMode,
    providerDriver: config.providerDriver,
  });

  const agentService = new AgentService({ agents: repositories.agents, events, clock });
  const contactService = new ContactService({
    contacts: repositories.contacts,
    calls: repositories.calls,
    events,
    clock,
    ids,
  });

  const engine = new DialerEngine({
    config,
    clock,
    ids,
    logger,
    campaigns: repositories.campaigns,
    contacts: repositories.contacts,
    agents: repositories.agents,
    calls: repositories.calls,
    concurrency,
    rateLimiters,
    safety,
    retry,
    metrics,
    events,
    agentService,
    getProvider: (providerId) => providers.get(providerId),
    isEmergencyStopped: () => system.isEmergencyStopped(),
  });

  const campaignService = new CampaignService({
    campaigns: repositories.campaigns,
    contacts: repositories.contacts,
    agents: repositories.agents,
    engine,
    events,
    clock,
    ids,
    config,
  });

  const invariants = new InvariantChecker({
    campaigns: repositories.campaigns,
    contacts: repositories.contacts,
    agents: repositories.agents,
    calls: repositories.calls,
    concurrency,
    mode: options.invariantMode ?? 'record',
  });

  return {
    config,
    clock,
    fastDriver,
    pacedDriver,
    random,
    ids,
    logger,
    db,
    bus,
    repositories,
    providers,
    concurrency,
    rateLimiters,
    safety,
    retry,
    metrics,
    events,
    system,
    agentService,
    contactService,
    engine,
    campaignService,
    invariants,
    close: () => {
      engine.shutdown();
      pacedDriver.stop();
      events.flush();
      providers.resetAll();
      db.close();
    },
  };
}
