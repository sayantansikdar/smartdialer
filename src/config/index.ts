/**
 * Configuration: parsed once, validated once, then immutable.
 *
 * This is the only module that reads `process.env` (CONSTRAINTS.md §3). Everything else
 * receives an `AppConfig`, which makes configuration explicit in every constructor and
 * makes tests able to construct a system with whatever limits they want to exercise.
 *
 * Validation is fail-fast. A dialer running with a misparsed concurrency limit is more
 * dangerous than one that refuses to start, so an invalid value aborts startup with a
 * message naming the variable rather than defaulting to something plausible.
 */

import { z } from 'zod';
import { ConfigError, ERROR_CODES, SmartDialerError } from '../core/errors.ts';
import { LOG_LEVELS } from '../core/logger.ts';

/**
 * The only provider drivers that exist. There is no real-telecom implementation in this
 * repository, and this enum is one of the reasons adding one cannot happen by accident —
 * a new driver name has to be added here, in the registry, and pass review against
 * CONSTRAINTS.md §1.
 */
export const PROVIDER_DRIVERS = ['mock', 'unreliable-mock'] as const;
export type ProviderDriver = (typeof PROVIDER_DRIVERS)[number];

const booleanish = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeNumber = z.coerce.number().min(0);
const ratio = z.coerce.number().min(0).max(1);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Safety
  SIMULATION_MODE: booleanish.default(true),
  PROVIDER_DRIVER: z.enum(PROVIDER_DRIVERS).default('mock'),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // Persistence
  DATABASE_PATH: z.string().min(1).default('./data/smartdialer.db'),

  // Global ceilings
  GLOBAL_MAX_CONCURRENT_CALLS: positiveInt.default(50),
  GLOBAL_CALLS_PER_SECOND: z.coerce.number().positive().default(20),
  PROVIDER_MAX_CONCURRENT_CALLS: positiveInt.default(40),

  // Dialer defaults
  DEFAULT_MAX_ATTEMPTS: positiveInt.default(3),
  DEFAULT_RETRY_INITIAL_DELAY_MS: positiveInt.default(1000),
  DEFAULT_RETRY_MAX_DELAY_MS: positiveInt.default(30_000),
  DEFAULT_RETRY_MULTIPLIER: z.coerce.number().min(1).default(2),
  PROVIDER_TIMEOUT_MS: positiveInt.default(45_000),
  ABANDON_TIMEOUT_MS: positiveInt.default(2000),
  DIALER_TICK_INTERVAL_MS: positiveInt.default(250),

  // Predictive pacing
  PREDICTIVE_PACING_MULTIPLIER: z.coerce.number().positive().default(1),
  PREDICTIVE_TARGET_OCCUPANCY: ratio.default(0.85),
  PREDICTIVE_MIN_ANSWER_RATE: z.coerce.number().min(0.01).max(1).default(0.1),
  MAX_ABANDON_RATE: ratio.default(0.03),

  // Simulation
  SIMULATION_SPEED: z.coerce.number().positive().default(10),
  SIMULATION_SEED: z.coerce.number().int().default(12_345),

  // Virtual time 0 maps to this instant when rendering timestamps. Fixed so logs replay.
  EPOCH_MS: nonNegativeNumber.default(Date.parse('2026-01-01T09:00:00.000Z')),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly simulationMode: boolean;
  readonly providerDriver: ProviderDriver;
  readonly server: {
    readonly port: number;
    readonly host: string;
    readonly logLevel: (typeof LOG_LEVELS)[number];
  };
  readonly databasePath: string;
  readonly limits: {
    readonly globalMaxConcurrentCalls: number;
    readonly globalCallsPerSecond: number;
    readonly providerMaxConcurrentCalls: number;
  };
  readonly dialer: {
    readonly defaultMaxAttempts: number;
    readonly retryInitialDelayMs: number;
    readonly retryMaxDelayMs: number;
    readonly retryMultiplier: number;
    readonly providerTimeoutMs: number;
    readonly abandonTimeoutMs: number;
    readonly tickIntervalMs: number;
  };
  readonly predictive: {
    readonly pacingMultiplier: number;
    readonly targetOccupancy: number;
    readonly minAnswerRate: number;
    readonly maxAbandonRate: number;
  };
  readonly simulation: {
    readonly speed: number;
    readonly seed: number;
  };
  readonly epochMs: number;
  /**
   * Non-fatal configuration concerns, logged once at startup. Kept on the config object
   * rather than logged from here so that `loadConfig` stays free of I/O and testable.
   */
  readonly warnings: readonly string[];
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Parse and validate configuration.
 *
 * @param env Raw environment. Defaults to `process.env`; tests pass a literal.
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      variable: issue.path.join('.') || '(root)',
      problem: issue.message,
    }));
    throw new ConfigError(
      `Invalid configuration: ${details.map((d) => `${d.variable} — ${d.problem}`).join('; ')}`,
      { issues: details },
    );
  }

  const raw = parsed.data;

  // ---------------------------------------------------------------------------
  // Safety gate. This is the single most important line in the file.
  //
  // The prototype must never be capable of placing a real call. Requiring an explicit
  // affirmative — rather than defaulting to safe — means a stale `.env` copied from
  // elsewhere, or an environment variable inherited from another service, cannot quietly
  // put this process into a mode it was never meant to have. See CONSTRAINTS.md §1.
  // ---------------------------------------------------------------------------
  if (!raw.SIMULATION_MODE) {
    throw new SmartDialerError(
      ERROR_CODES.SIMULATION_MODE_REQUIRED,
      'SIMULATION_MODE must be true. This prototype only simulates telephony and has no ' +
        'real-provider implementation; refusing to start.',
      { metadata: { SIMULATION_MODE: env.SIMULATION_MODE ?? '(unset)' } },
    );
  }

  // Cross-field checks — individually valid values that make no sense together.
  //
  // Fatal only where the combination is genuinely unsafe or self-contradictory. A
  // combination that is merely redundant gets a warning: over-strict startup validation
  // that blocks harmless configurations trains people to work around the validator, which
  // costs more safety than it buys.
  const problems: string[] = [];
  if (raw.DEFAULT_RETRY_INITIAL_DELAY_MS > raw.DEFAULT_RETRY_MAX_DELAY_MS) {
    problems.push(
      `DEFAULT_RETRY_INITIAL_DELAY_MS (${raw.DEFAULT_RETRY_INITIAL_DELAY_MS}) exceeds ` +
        `DEFAULT_RETRY_MAX_DELAY_MS (${raw.DEFAULT_RETRY_MAX_DELAY_MS})`,
    );
  }
  if (raw.ABANDON_TIMEOUT_MS >= raw.PROVIDER_TIMEOUT_MS) {
    // If a call could be "abandoned" only after the provider watchdog already fired, the
    // abandon-rate control could never observe anything and would silently do nothing.
    problems.push(
      `ABANDON_TIMEOUT_MS (${raw.ABANDON_TIMEOUT_MS}) must be well below ` +
        `PROVIDER_TIMEOUT_MS (${raw.PROVIDER_TIMEOUT_MS})`,
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`, { problems });
  }

  const warnings: string[] = [];
  if (raw.PROVIDER_MAX_CONCURRENT_CALLS > raw.GLOBAL_MAX_CONCURRENT_CALLS) {
    // Safe — the stricter global limit still binds, and the safety engine always applies
    // the minimum. Worth saying out loud because it is usually unintentional.
    warnings.push(
      `PROVIDER_MAX_CONCURRENT_CALLS (${raw.PROVIDER_MAX_CONCURRENT_CALLS}) exceeds ` +
        `GLOBAL_MAX_CONCURRENT_CALLS (${raw.GLOBAL_MAX_CONCURRENT_CALLS}), so the provider ` +
        `limit can never bind. The global limit remains authoritative.`,
    );
  }
  if (raw.MAX_ABANDON_RATE > 0.05) {
    warnings.push(
      `MAX_ABANDON_RATE is ${raw.MAX_ABANDON_RATE}. Real predictive dialing is typically ` +
        `held at or below 0.03 by regulation; this prototype does not enforce any ` +
        `jurisdiction's rule.`,
    );
  }

  return {
    nodeEnv: raw.NODE_ENV,
    simulationMode: raw.SIMULATION_MODE,
    providerDriver: raw.PROVIDER_DRIVER,
    server: { port: raw.PORT, host: raw.HOST, logLevel: raw.LOG_LEVEL },
    databasePath: raw.DATABASE_PATH,
    limits: {
      globalMaxConcurrentCalls: raw.GLOBAL_MAX_CONCURRENT_CALLS,
      globalCallsPerSecond: raw.GLOBAL_CALLS_PER_SECOND,
      providerMaxConcurrentCalls: raw.PROVIDER_MAX_CONCURRENT_CALLS,
    },
    dialer: {
      defaultMaxAttempts: raw.DEFAULT_MAX_ATTEMPTS,
      retryInitialDelayMs: raw.DEFAULT_RETRY_INITIAL_DELAY_MS,
      retryMaxDelayMs: raw.DEFAULT_RETRY_MAX_DELAY_MS,
      retryMultiplier: raw.DEFAULT_RETRY_MULTIPLIER,
      providerTimeoutMs: raw.PROVIDER_TIMEOUT_MS,
      abandonTimeoutMs: raw.ABANDON_TIMEOUT_MS,
      tickIntervalMs: raw.DIALER_TICK_INTERVAL_MS,
    },
    predictive: {
      pacingMultiplier: raw.PREDICTIVE_PACING_MULTIPLIER,
      targetOccupancy: raw.PREDICTIVE_TARGET_OCCUPANCY,
      minAnswerRate: raw.PREDICTIVE_MIN_ANSWER_RATE,
      maxAbandonRate: raw.MAX_ABANDON_RATE,
    },
    simulation: { speed: raw.SIMULATION_SPEED, seed: raw.SIMULATION_SEED },
    epochMs: raw.EPOCH_MS,
    warnings,
  };
}

/** A valid config for tests, with any field overridable. */
export function testConfig(overrides: Partial<EnvSource> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SIMULATION_MODE: 'true',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'error',
    ...overrides,
  });
}
