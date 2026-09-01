/**
 * The simulation engine.
 *
 * A simulation builds a **completely isolated SmartDialer** — its own in-memory database,
 * its own virtual clock, its own seeded RNG, its own provider — runs a campaign to
 * completion, and produces a report.
 *
 * Isolation is the important choice. Running simulations inside the live system would let a
 * demo scribble over real campaign data, and two simulations could not run at once. An
 * isolated container also means a simulation is genuinely reproducible: nothing outside it
 * can perturb the run, so the same seed really does replay the same campaign.
 *
 * Two run modes, driving the *same* engine (DECISIONS.md D-003):
 *
 *   instant — the fast driver. Ten simulated minutes finish in milliseconds. Used by tests,
 *             by `npm run scenario`, and when an operator just wants the answer.
 *   paced   — the paced driver, at 1x-100x. Used by the dashboard, so a campaign can be
 *             watched unfolding. Same engine, same code path, same results.
 */

import { ID_PREFIX, IdGenerator } from '../core/ids.ts';
import type { Logger } from '../core/logger.ts';
import { loadConfig, type AppConfig, type ProviderDriver } from '../config/index.ts';
import { createContainer, DEFAULT_PROVIDER_ID, type Container } from '../container.ts';
import type { DialingMode } from '../domain/campaign.ts';
import type { SmartDialerEvent } from '../domain/events.ts';
import type { MockProviderConfig } from '../providers/mock-provider.ts';
import type { SimulationRepository, SimulationRun } from '../db/repositories/simulation-repository.ts';
import type { InvariantViolation } from './invariants.ts';

export interface SimulationConfig {
  readonly scenario: string;
  readonly contacts: number;
  readonly agents: number;
  readonly dialingMode: DialingMode;
  readonly seed: number;
  /** 0 means instant (fast driver); anything above 0 is a paced multiplier. */
  readonly speed: number;
  readonly maxConcurrentCalls: number;
  readonly callsPerSecond: number;
  readonly maxAttempts: number;
  readonly maxAbandonRate: number;
  readonly maxLinesPerAgent: number;
  readonly providerDriver: ProviderDriver;
  readonly provider: Partial<MockProviderConfig>;
  /** Contacts pre-marked DO_NOT_CALL, so the protection is visibly exercised. */
  readonly dncContacts: number;
  /** Contacts seeded with prior attempts, so retry limits are visibly exercised. */
  readonly contactsWithPriorAttempts: number;
  /** Safety valve for a run that cannot settle. */
  readonly maxVirtualMs: number;

  /**
   * Take agents offline part-way through the run.
   *
   * The assignment asks: "100 agents are available and 40 disappear within a few seconds —
   * how quickly does the dialer react?" Without a way to actually remove agents mid-run there
   * is no way to answer that with evidence rather than assertion.
   */
  readonly agentDrop?: { readonly atVirtualMs: number; readonly count: number } | undefined;

  /**
   * Change provider behaviour part-way through, for the assignment's scenario D — an answer
   * rate and talk time that shift underneath a running campaign, which is the case that
   * actually exercises the pacer's feedback loops rather than its steady state.
   */
  readonly providerShift?:
    | { readonly atVirtualMs: number; readonly provider: Partial<MockProviderConfig> }
    | undefined;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  scenario: 'custom',
  contacts: 100,
  agents: 5,
  dialingMode: 'PREDICTIVE',
  seed: 12_345,
  speed: 0,
  maxConcurrentCalls: 20,
  callsPerSecond: 10,
  maxAttempts: 3,
  maxAbandonRate: 0.03,
  maxLinesPerAgent: 3,
  providerDriver: 'mock',
  provider: {},
  dncContacts: 0,
  contactsWithPriorAttempts: 0,
  maxVirtualMs: 30 * 60_000,
  agentDrop: undefined,
  providerShift: undefined,
};

export interface SimulationReport {
  readonly scenario: string;
  readonly seed: number;
  readonly dialingMode: DialingMode;

  readonly totalContacts: number;
  readonly totalAttempts: number;
  readonly successfulConnections: number;
  readonly noAnswers: number;
  readonly busy: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly abandoned: number;
  readonly cancelled: number;
  readonly retries: number;

  readonly averageAttemptsPerContact: number;
  readonly averageCallDurationMs: number;
  readonly peakConcurrency: number;
  readonly averageConcurrency: number;
  readonly agentUtilization: number;
  readonly answerRate: number;
  readonly abandonRate: number;
  readonly providerErrorRate: number;
  /**
   * Genuine protective actions: a DNC block, an attempt limit, the emergency stop, the
   * abandon-rate control. Deliberately separate from `capacityBackpressure` — a dialer being
   * told "no room right now" hundreds of times is correct operation, and counting it here
   * would make a healthy run look alarming.
   */
  readonly safetyInterventions: number;
  /**
   * What the Safety Controller actually did, by verdict.
   *
   * The brief asks to see "safety-controller decisions" alongside utilisation and pacing, and
   * these four counts are the honest summary: how often the pacer's request was taken as-is,
   * cut down, refused outright, or replaced by the progressive number because the predictive
   * estimate had stopped being trustworthy.
   */
  readonly safetyDecisions: {
    readonly approved: number;
    readonly reduced: number;
    readonly rejected: number;
    readonly fallbackToProgressive: number;
    /** Total calls the pacer asked for, against the total the controller allowed. */
    readonly totalRequested: number;
    readonly totalApproved: number;
  };
  /** Routine flow control: at capacity, at the concurrency limit, or rate limited. */
  readonly capacityBackpressure: number;

  readonly contactsByStatus: Readonly<Record<string, number>>;
  readonly providerMetrics: Record<string, unknown>;

  readonly virtualDurationMs: number;
  readonly realDurationMs: number;
  readonly totalEvents: number;

  /** The headline result. False means the run broke a rule it must never break. */
  readonly invariantsPassed: boolean;
  readonly invariantViolations: readonly InvariantViolation[];
  readonly stopReason: string;
}

export interface SimulationHandle {
  readonly id: string;
  readonly config: SimulationConfig;
  readonly container: Container;
  readonly campaignId: string;
  stop(): void;
}

export interface SimulationServiceOptions {
  readonly baseConfig: AppConfig;
  readonly repository: SimulationRepository;
  readonly logger: Logger;
  /** Forwards simulation events so the dashboard can watch a run unfold. */
  readonly onEvent?: (simulationId: string, event: SmartDialerEvent) => void;
}

export class SimulationService {
  readonly #baseConfig: AppConfig;
  readonly #repository: SimulationRepository;
  readonly #logger: Logger;
  readonly #onEvent: ((simulationId: string, event: SmartDialerEvent) => void) | undefined;
  readonly #ids = new IdGenerator();
  readonly #active = new Map<string, SimulationHandle>();

  constructor(options: SimulationServiceOptions) {
    this.#baseConfig = options.baseConfig;
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#onEvent = options.onEvent;
  }

  /** Run to completion and return the report. Used by tests and the scenario CLI. */
  async runToCompletion(input: Partial<SimulationConfig> = {}): Promise<SimulationReport> {
    const { id, report } = await this.#run({ ...DEFAULT_SIMULATION_CONFIG, ...input, speed: 0 });
    this.#logger.info('Simulation finished', { simulationId: id, invariantsPassed: report.invariantsPassed });
    return report;
  }

  /**
   * Start a run. Instant runs are awaited; paced runs return immediately and complete in the
   * background so the dashboard can watch.
   */
  async start(input: Partial<SimulationConfig> = {}): Promise<{ run: SimulationRun; report: SimulationReport | null }> {
    const config = { ...DEFAULT_SIMULATION_CONFIG, ...input };

    if (config.speed <= 0) {
      const { id, report } = await this.#run(config);
      return { run: this.#repository.findById(id) as SimulationRun, report };
    }

    const id = this.#ids.next(ID_PREFIX.simulation);
    const run = this.#repository.start({
      id,
      scenario: config.scenario,
      seed: config.seed,
      config: config as unknown as Record<string, unknown>,
      startedAt: 0,
    });

    // Deliberately not awaited: a paced run takes real time by design.
    void this.#run(config, id).catch((error: unknown) => {
      this.#logger.error('Paced simulation failed', { simulationId: id, error: String(error) });
      this.#repository.finish(id, 'FAILED', 0, { error: String(error) });
    });

    return { run, report: null };
  }

  stop(id: string): boolean {
    const handle = this.#active.get(id);
    if (handle === undefined) return false;
    handle.stop();
    return true;
  }

  get(id: string): SimulationRun | null {
    return this.#repository.findById(id);
  }

  list(limit = 50): SimulationRun[] {
    return this.#repository.list(limit);
  }

  async #run(config: SimulationConfig, existingId?: string): Promise<{ id: string; report: SimulationReport }> {
    const id = existingId ?? this.#ids.next(ID_PREFIX.simulation);
    if (existingId === undefined) {
      this.#repository.start({
        id,
        scenario: config.scenario,
        seed: config.seed,
        config: config as unknown as Record<string, unknown>,
        startedAt: 0,
      });
    }

    const container = this.#buildContainer(config);
    const campaignId = this.#seedCampaign(container, config);

    // Concurrency is sampled on every event rather than on a timer: a timer would itself be
    // scheduled on the simulated clock and would change the run it is trying to measure.
    let peakConcurrency = 0;
    let concurrencySum = 0;
    let utilizationSum = 0;
    let samples = 0;
    let totalEvents = 0;

    container.events.subscribe((event) => {
      totalEvents += 1;
      const active = container.concurrency.activeForCampaign(campaignId);
      peakConcurrency = Math.max(peakConcurrency, active);
      concurrencySum += active;
      // Utilization must be averaged over the run, not read at the end — by the time a
      // campaign completes every agent is idle again, so a final snapshot always reports 0%.
      utilizationSum += container.metrics.agentMetrics(campaignId).utilization;
      samples += 1;
      this.#onEvent?.(id, event);
    });

    const handle: SimulationHandle = {
      id,
      config,
      container,
      campaignId,
      stop: () => {
        container.pacedDriver.stop();
        try {
          container.campaignService.stop(campaignId);
        } catch {
          // Already terminal — stopping an already-stopped campaign is not an error here.
        }
      },
    };
    this.#active.set(id, handle);

    // Real wall-clock time, deliberately. This measures how long the simulation took to
    // execute — an observation *about* the run, never an input *to* it. No dialer decision
    // reads this value, so determinism is unaffected (DECISIONS.md D-011).
    // eslint-disable-next-line no-restricted-syntax
    const startedReal = Date.now();
    container.events.emit({
      type: 'simulation.started',
      message: `Simulation "${config.scenario}" started (seed ${config.seed})`,
      campaignId,
      metadata: { simulationId: id, ...config },
    });

    let stopReason: string;
    try {
      container.campaignService.start(campaignId);

      // Mid-run disruptions, scheduled on the same virtual clock as everything else so they
      // land at a reproducible moment rather than whenever the CPU got round to them.
      if (config.agentDrop !== undefined) {
        const drop = config.agentDrop;
        container.clock.setTimer(
          drop.atVirtualMs,
          () => {
            // Take the *available* seats first: that is the disruption that actually hurts,
            // because it removes capacity the pacer has already counted on.
            const online = container.agentService
              .listByCampaign(campaignId)
              .filter((a) => a.status === 'AVAILABLE' || a.status === 'PAUSED')
              .slice(0, drop.count);
            for (const agent of online) container.agentService.setStatus(agent.id, 'OFFLINE');
            container.events.emit({
              type: 'agent.offline',
              severity: 'warn',
              message: `${online.length} agent(s) went offline`,
              campaignId,
              metadata: { dropped: online.length, requested: drop.count },
            });
            container.events.flush();
          },
          'sim:agent-drop',
        );
      }

      if (config.providerShift !== undefined) {
        const shift = config.providerShift;
        container.clock.setTimer(
          shift.atVirtualMs,
          () => {
            container.providers.getMock(DEFAULT_PROVIDER_ID).updateConfig(shift.provider);
            container.events.emit({
              type: 'provider.fault_injected',
              severity: 'warn',
              message: 'Provider behaviour shifted mid-run',
              campaignId,
              metadata: { ...shift.provider },
            });
            container.events.flush();
          },
          'sim:provider-shift',
        );
      }

      stopReason = 'completed';
      if (config.speed <= 0) {
        const result = await container.fastDriver.run({
          untilVirtualMs: config.maxVirtualMs,
          maxRealMs: 30_000,
          maxBatches: 5_000_000,
        });
        stopReason = result.stopReason;
      } else {
        stopReason = await this.#runPaced(container, campaignId, config);
      }
    } finally {
      container.pacedDriver.stop();
    }

    const report = this.#buildReport(container, campaignId, config, {
      peakConcurrency,
      averageConcurrency: samples === 0 ? 0 : concurrencySum / samples,
      averageUtilization: samples === 0 ? 0 : utilizationSum / samples,
      totalEvents,
      // eslint-disable-next-line no-restricted-syntax
      realDurationMs: Date.now() - startedReal,
      stopReason,
    });

    container.events.emit({
      type: 'simulation.finished',
      severity: report.invariantsPassed ? 'info' : 'error',
      message: `Simulation "${config.scenario}" finished — INVARIANTS: ${report.invariantsPassed ? 'PASSED' : 'FAILED'}`,
      campaignId,
      metadata: { simulationId: id, invariantsPassed: report.invariantsPassed },
    });
    container.events.flush();

    this.#repository.finish(
      id,
      report.invariantsPassed ? 'COMPLETED' : 'FAILED',
      container.clock.now(),
      report as unknown as Record<string, unknown>,
    );

    this.#active.delete(id);
    container.close();
    return { id, report };
  }

  /** Advance in real time until the campaign settles or the virtual budget is spent. */
  async #runPaced(container: Container, campaignId: string, config: SimulationConfig): Promise<string> {
    container.pacedDriver.setSpeed(config.speed);
    container.pacedDriver.start();

    return new Promise<string>((resolve) => {
      const poll = (): void => {
        const campaign = container.repositories.campaigns.findById(campaignId);
        const finished =
          campaign === null ||
          campaign.status === 'COMPLETED' ||
          campaign.status === 'STOPPED' ||
          campaign.status === 'FAILED';

        if (finished) {
          container.pacedDriver.stop();
          resolve('completed');
          return;
        }
        if (container.clock.now() >= config.maxVirtualMs) {
          container.pacedDriver.stop();
          resolve('virtual-time-limit');
          return;
        }
        // A real timer, deliberately: this polls the simulation from outside it, and must not
        // be scheduled on the clock it is observing — a poll scheduled on that clock could
        // only run when the clock advanced, which is the thing it is waiting to detect.
        // eslint-disable-next-line no-restricted-syntax
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  #buildContainer(config: SimulationConfig): Container {
    return createContainer({
      config: loadConfig({
        NODE_ENV: 'test',
        SIMULATION_MODE: 'true',
        DATABASE_PATH: ':memory:',
        LOG_LEVEL: 'error',
        PROVIDER_DRIVER: config.providerDriver,
        GLOBAL_MAX_CONCURRENT_CALLS: String(
          Math.max(config.maxConcurrentCalls, this.#baseConfig.limits.globalMaxConcurrentCalls),
        ),
        GLOBAL_CALLS_PER_SECOND: String(
          Math.max(config.callsPerSecond, this.#baseConfig.limits.globalCallsPerSecond),
        ),
        PROVIDER_MAX_CONCURRENT_CALLS: String(
          Math.max(config.maxConcurrentCalls, this.#baseConfig.limits.providerMaxConcurrentCalls),
        ),
        SIMULATION_SEED: String(config.seed),
      }),
      seed: config.seed,
      silentLogger: true,
      // 'record' rather than 'throw': a simulation should finish and report every violation
      // it found, not abort at the first one.
      invariantMode: 'record',
      providerConfig: config.provider,
    });
  }

  #seedCampaign(container: Container, config: SimulationConfig): string {
    const campaign = container.campaignService.create({
      name: `Simulation: ${config.scenario}`,
      dialingMode: config.dialingMode,
      maxConcurrentCalls: config.maxConcurrentCalls,
      maxCallsPerSecond: config.callsPerSecond,
      maxAbandonRate: config.maxAbandonRate,
      maxAttemptsPerContact: config.maxAttempts,
      retryPolicy: {
        maxAttempts: config.maxAttempts,
        initialDelayMs: 1000,
        maxDelayMs: 30_000,
        multiplier: 2,
        jitterRatio: 0.2,
      },
      safety: {
        pacingMultiplier: this.#baseConfig.predictive.pacingMultiplier,
        targetOccupancy: this.#baseConfig.predictive.targetOccupancy,
        lineRatio: 1,
        maxLinesPerAgent: config.maxLinesPerAgent,
        abandonTimeoutMs: this.#baseConfig.dialer.abandonTimeoutMs,
        abandonMinSample: 20,
      },
      providerId: DEFAULT_PROVIDER_ID,
    });

    for (let i = 0; i < config.agents; i += 1) {
      const agent = container.repositories.agents.insert(
        `agent_${String(i).padStart(3, '0')}`,
        { campaignId: campaign.id, name: `Agent ${i + 1}`, status: 'OFFLINE' },
        0,
      );
      container.agentService.bringOnline(agent.id);
    }

    for (let i = 0; i < config.contacts; i += 1) {
      const contact = container.contactService.create({
        campaignId: campaign.id,
        // Reserved fictional block only — CONSTRAINTS.md §1.
        phoneNumber: `+1555${String(1000 + i).padStart(4, '0')}`,
        name: `Contact ${i + 1}`,
      });

      if (i < config.dncContacts) {
        container.contactService.markDoNotCall(contact.id, 'Seeded do-not-call contact');
      } else if (i < config.dncContacts + config.contactsWithPriorAttempts) {
        // Seeded partway through their attempt budget, so exhaustion is reached during the
        // run rather than only in theory.
        container.repositories.contacts.recordAttempt(contact.id, 0);
      }
    }

    return campaign.id;
  }

  #buildReport(
    container: Container,
    campaignId: string,
    config: SimulationConfig,
    observed: {
      peakConcurrency: number;
      averageConcurrency: number;
      averageUtilization: number;
      totalEvents: number;
      realDurationMs: number;
      stopReason: string;
    },
  ): SimulationReport {
    const campaign = container.repositories.campaigns.findById(campaignId);
    const metrics = campaign === null ? null : container.metrics.campaignMetrics(campaign);
    const counts = container.repositories.contacts.counts(campaignId);
    const outcomes = container.repositories.calls.outcomeCounts(campaignId);
    const eventCounts = container.repositories.events.countByType(campaignId);

    // Split denials by the severity the safety classifier assigned: routine backpressure is
    // debug, genuine protective action is a warning. Reporting them as one number made a
    // perfectly healthy run look like it had intervened a thousand times.
    // Every tick emits a `dialer.plan` carrying the request, the approval and the verdict, so
    // the controller's behaviour over a whole run can be summarised from the event log rather
    // than instrumented separately.
    const planEvents = container.repositories.events.query({
      campaignId,
      types: ['dialer.plan'],
      limit: 100_000,
    });
    const safetyDecisions = planEvents.reduce(
      (acc, event) => {
        const verdict = String(event.metadata['verdict'] ?? '');
        if (verdict === 'APPROVED') acc.approved += 1;
        else if (verdict === 'REDUCED') acc.reduced += 1;
        else if (verdict === 'REJECTED') acc.rejected += 1;
        else if (verdict === 'FALLBACK_PROGRESSIVE') acc.fallbackToProgressive += 1;
        acc.totalRequested += Number(event.metadata['requested'] ?? 0);
        acc.totalApproved += Number(event.metadata['approved'] ?? 0);
        return acc;
      },
      { approved: 0, reduced: 0, rejected: 0, fallbackToProgressive: 0, totalRequested: 0, totalApproved: 0 },
    );

    const denialCounts = container.repositories.events
      .countByTypeAndSeverity(campaignId)
      .filter((row) => row.type === 'safety.denied')
      .reduce(
        (acc, row) => {
          if (row.severity === 'debug') acc.backpressure += row.n;
          else acc.interventions += row.n;
          return acc;
        },
        { backpressure: 0, interventions: 0 },
      );
    const stats = container.repositories.calls.statistics(campaignId);

    // Run the invariants one final time against the settled state.
    container.invariants.check();
    const violations = container.invariants.violations();

    const totalAttempts = stats.total;
    const providerRequests = Object.values(container.providers.list()).reduce(
      (sum, provider) => sum + provider.metrics().requests,
      0,
    );
    const providerRejections = container.providers
      .list()
      .reduce((sum, provider) => sum + provider.metrics().rejected, 0);

    return {
      scenario: config.scenario,
      seed: config.seed,
      dialingMode: config.dialingMode,

      totalContacts: counts.total,
      totalAttempts,
      successfulConnections: outcomes['ANSWERED'] ?? 0,
      noAnswers: outcomes['NO_ANSWER'] ?? 0,
      busy: outcomes['BUSY'] ?? 0,
      failures: outcomes['FAILED'] ?? 0,
      timeouts: outcomes['TIMEOUT'] ?? 0,
      abandoned: outcomes['ABANDONED'] ?? 0,
      cancelled: outcomes['CANCELLED'] ?? 0,
      retries: eventCounts['retry.scheduled'] ?? 0,

      averageAttemptsPerContact: counts.total === 0 ? 0 : totalAttempts / counts.total,
      averageCallDurationMs: stats.averageTalkMs,
      peakConcurrency: observed.peakConcurrency,
      averageConcurrency: Number(observed.averageConcurrency.toFixed(2)),
      agentUtilization: Number(observed.averageUtilization.toFixed(3)),
      answerRate: metrics?.answerRate ?? 0,
      abandonRate: metrics?.abandonRate ?? 0,
      providerErrorRate: providerRequests === 0 ? 0 : providerRejections / providerRequests,
      // Denials are split by the severity the safety classifier assigned them, so routine
      // backpressure never inflates the intervention count.
      safetyInterventions:
        denialCounts.interventions +
        (eventCounts['safety.limit_reached'] ?? 0) +
        (eventCounts['safety.abandon_threshold_exceeded'] ?? 0) +
        (eventCounts['safety.emergency_stop'] ?? 0),
      capacityBackpressure: denialCounts.backpressure,
      safetyDecisions,

      contactsByStatus: counts.byStatus,
      providerMetrics: Object.fromEntries(
        container.providers.list().map((provider) => [provider.id, provider.metrics()]),
      ),

      virtualDurationMs: container.clock.now(),
      realDurationMs: observed.realDurationMs,
      totalEvents: observed.totalEvents,

      invariantsPassed: violations.length === 0,
      invariantViolations: violations,
      stopReason: observed.stopReason,
    };
  }
}
