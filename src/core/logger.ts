/**
 * Structured logging.
 *
 * Log lines are JSON objects carrying the correlation fields that make a dialer debuggable:
 * campaign, contact, call, agent, provider. Grepping "why did call_000042 fail" should be
 * one query, not an exercise in reading prose.
 *
 * Timestamps come from the injected clock, so log output is deterministic and lines up
 * exactly with the event stream. `epochMs` converts virtual milliseconds into a readable
 * ISO timestamp; it is a fixed configured constant, so this stays reproducible.
 */

import type { Clock } from './clock.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  readonly campaignId?: string;
  readonly contactId?: string;
  readonly callId?: string;
  readonly agentId?: string;
  readonly provider?: string;
  readonly event?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that merges `fields` into everything it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly clock: Clock;
  /** Virtual time 0 corresponds to this wall-clock instant. Fixed, so output stays stable. */
  readonly epochMs?: number;
  /** Defaults to writing JSON lines on stdout/stderr. Tests capture instead. */
  readonly sink?: (level: LogLevel, line: string) => void;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const epochMs = options.epochMs ?? 0;
  const threshold = LEVEL_RANK[options.level];

  function build(base: LogFields): Logger {
    function write(level: LogLevel, message: string, fields?: LogFields): void {
      // Checked before serialising: at 100x speed the dialer emits a lot of debug lines,
      // and formatting ones nobody will read is pure overhead (CONSTRAINTS: no excessive
      // logging in tight loops).
      if (LEVEL_RANK[level] < threshold) return;

      const virtualMs = options.clock.now();
      const record = {
        timestamp: new Date(epochMs + virtualMs).toISOString(),
        virtualMs,
        level,
        message,
        ...base,
        ...fields,
      };
      sink(level, JSON.stringify(record));
    }

    return {
      debug: (message, fields) => write('debug', message, fields),
      info: (message, fields) => write('info', message, fields),
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  }

  return build({});
}

/** A logger that discards everything. Used by tests that do not assert on log output. */
export function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
