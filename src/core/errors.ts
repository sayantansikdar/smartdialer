/**
 * Structured errors.
 *
 * Every failure carries a stable machine-readable `code` and typed `metadata`, because
 * three different consumers need it: the log line, the API response, and the dashboard.
 * A bare `Error('too many calls')` serves none of them well — the UI cannot branch on a
 * message string, and a log aggregator cannot count one.
 *
 * See CONSTRAINTS.md §3: no silent failures. Every `catch` must handle intentionally,
 * rethrow, or record.
 */

export const ERROR_CODES = {
  // Configuration and startup
  INVALID_CONFIG: 'INVALID_CONFIG',
  SIMULATION_MODE_REQUIRED: 'SIMULATION_MODE_REQUIRED',
  UNKNOWN_PROVIDER_DRIVER: 'UNKNOWN_PROVIDER_DRIVER',

  // Validation and lookup
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // Domain
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // Safety denials — these are the codes the safety engine returns, and they are surfaced
  // verbatim in the UI so an operator can see exactly why dialing stopped.
  EMERGENCY_STOP: 'EMERGENCY_STOP',
  CAMPAIGN_NOT_RUNNING: 'CAMPAIGN_NOT_RUNNING',
  CONTACT_DO_NOT_CALL: 'CONTACT_DO_NOT_CALL',
  CONTACT_NOT_ELIGIBLE: 'CONTACT_NOT_ELIGIBLE',
  MAX_ATTEMPTS_EXCEEDED: 'MAX_ATTEMPTS_EXCEEDED',
  RETRY_NOT_DUE: 'RETRY_NOT_DUE',
  GLOBAL_CONCURRENCY_LIMIT: 'GLOBAL_CONCURRENCY_LIMIT',
  CAMPAIGN_CONCURRENCY_LIMIT: 'CAMPAIGN_CONCURRENCY_LIMIT',
  PROVIDER_CONCURRENCY_LIMIT: 'PROVIDER_CONCURRENCY_LIMIT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  AGENT_CAPACITY_EXCEEDED: 'AGENT_CAPACITY_EXCEEDED',
  ABANDON_RATE_EXCEEDED: 'ABANDON_RATE_EXCEEDED',

  // Provider
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_OUTAGE: 'PROVIDER_OUTAGE',
  INVALID_PHONE_NUMBER: 'INVALID_PHONE_NUMBER',
  UNSUPPORTED_DESTINATION: 'UNSUPPORTED_DESTINATION',

  // Internal
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ErrorMetadata = Record<string, unknown>;

export interface SerializedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly metadata: ErrorMetadata;
}

export class SmartDialerError extends Error {
  readonly code: ErrorCode;
  readonly metadata: ErrorMetadata;
  readonly httpStatus: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { metadata?: ErrorMetadata; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.metadata = options.metadata ?? {};
    this.httpStatus = options.httpStatus ?? 500;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message, metadata: this.metadata };
  }
}

export class ConfigError extends SmartDialerError {
  constructor(message: string, metadata: ErrorMetadata = {}) {
    super(ERROR_CODES.INVALID_CONFIG, message, { metadata, httpStatus: 500 });
  }
}

export class ValidationError extends SmartDialerError {
  constructor(message: string, metadata: ErrorMetadata = {}) {
    super(ERROR_CODES.VALIDATION_FAILED, message, { metadata, httpStatus: 400 });
  }
}

export class NotFoundError extends SmartDialerError {
  constructor(entity: string, id: string) {
    super(ERROR_CODES.NOT_FOUND, `${entity} not found: ${id}`, {
      metadata: { entity, id },
      httpStatus: 404,
    });
  }
}

export class ConflictError extends SmartDialerError {
  constructor(message: string, metadata: ErrorMetadata = {}) {
    super(ERROR_CODES.CONFLICT, message, { metadata, httpStatus: 409 });
  }
}

/**
 * Thrown when something attempts a transition the state machine does not allow — for
 * example moving a call straight from CREATED to CONNECTED without ringing.
 *
 * This throws rather than returning false on purpose (CONSTRAINTS.md §3): an illegal
 * transition means a caller's model of the world is wrong, and silently ignoring it would
 * let the call, the agent and the concurrency ledger drift out of agreement — which shows
 * up much later as an inexplicable capacity leak.
 */
export class InvalidTransitionError extends SmartDialerError {
  constructor(machine: string, from: string, to: string, entityId?: string) {
    super(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `${machine}: illegal transition ${from} -> ${to}`,
      { metadata: { machine, from, to, entityId }, httpStatus: 409 },
    );
  }
}

/**
 * A provider-side failure. `transient` decides whether the retry policy may act — see
 * `RetryService` and FLOW.md. Getting this classification wrong in either direction is
 * costly: retrying a permanent failure wastes attempts on a number that will never work,
 * and treating a transient blip as permanent discards a reachable contact.
 */
export class ProviderCallError extends SmartDialerError {
  readonly transient: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { transient: boolean; metadata?: ErrorMetadata; cause?: unknown },
  ) {
    super(code, message, {
      metadata: { ...options.metadata, transient: options.transient },
      httpStatus: 502,
      cause: options.cause,
    });
    this.transient = options.transient;
  }
}

export class InvariantViolationError extends SmartDialerError {
  constructor(invariant: string, detail: string, metadata: ErrorMetadata = {}) {
    super(ERROR_CODES.INVARIANT_VIOLATION, `Invariant violated [${invariant}]: ${detail}`, {
      metadata: { invariant, ...metadata },
      httpStatus: 500,
    });
  }
}

/** Narrowing helper for `catch` blocks, which receive `unknown`. */
export function isSmartDialerError(error: unknown): error is SmartDialerError {
  return error instanceof SmartDialerError;
}

/** Turns anything thrown into a serialisable shape without losing information. */
export function toSerializedError(error: unknown): SerializedError {
  if (isSmartDialerError(error)) return error.toJSON();
  if (error instanceof Error) {
    return {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: error.message,
      metadata: { name: error.name },
    };
  }
  return {
    code: ERROR_CODES.INTERNAL_ERROR,
    message: String(error),
    metadata: {},
  };
}
