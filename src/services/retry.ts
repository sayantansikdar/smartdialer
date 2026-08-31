/**
 * Failure classification and retry scheduling.
 *
 * The classification is the part that matters, and it is costly to get wrong in both
 * directions: retrying a permanent failure burns a contact's attempts on a number that will
 * never work, while treating a transient blip as permanent discards someone who was
 * perfectly reachable. So classification is explicit and centralised rather than inferred
 * at each call site.
 */

import { ERROR_CODES, type ErrorCode } from '../core/errors.ts';
import type { Rng } from '../core/rng.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { CallOutcome, FailureClass } from '../domain/call.ts';

/**
 * Failures that may be retried: the destination was reachable in principle and something
 * temporary got in the way.
 */
const TRANSIENT_CODES = new Set<string>([
  ERROR_CODES.PROVIDER_ERROR,
  ERROR_CODES.PROVIDER_TIMEOUT,
  ERROR_CODES.PROVIDER_OUTAGE,
  ERROR_CODES.PROVIDER_CONCURRENCY_LIMIT,
  ERROR_CODES.RATE_LIMIT_EXCEEDED,
  ERROR_CODES.GLOBAL_CONCURRENCY_LIMIT,
  ERROR_CODES.CAMPAIGN_CONCURRENCY_LIMIT,
]);

/**
 * Failures that must not be retried: the outcome would be identical every time, or retrying
 * would violate a safety rule.
 */
const PERMANENT_CODES = new Set<string>([
  ERROR_CODES.INVALID_PHONE_NUMBER,
  ERROR_CODES.UNSUPPORTED_DESTINATION,
  ERROR_CODES.CONTACT_DO_NOT_CALL,
  ERROR_CODES.MAX_ATTEMPTS_EXCEEDED,
]);

/**
 * Classify an outcome.
 *
 * NO_ANSWER and BUSY are transient by definition — they are the ordinary reasons to call
 * someone back later, and they are what a retry policy exists for. An unrecognised code is
 * treated as **permanent**: the safe default is to stop, because a retry loop on an
 * unrecognised failure is unbounded work against a destination nobody understands.
 */
export function classifyFailure(input: {
  outcome: CallOutcome | null;
  failureCode: string | null;
}): FailureClass {
  if (input.outcome === 'ANSWERED') return 'NONE';
  if (input.outcome === 'NO_ANSWER' || input.outcome === 'BUSY') return 'TRANSIENT';
  if (input.outcome === 'TIMEOUT') return 'TRANSIENT';
  if (input.outcome === 'ABANDONED') return 'TRANSIENT';
  if (input.outcome === 'CANCELLED') return 'PERMANENT';

  if (input.failureCode === null) return 'PERMANENT';
  if (TRANSIENT_CODES.has(input.failureCode)) return 'TRANSIENT';
  if (PERMANENT_CODES.has(input.failureCode)) return 'PERMANENT';
  return 'PERMANENT';
}

export interface RetryDecision {
  readonly retry: boolean;
  /** Human-readable reason, recorded on the retry event so decisions are auditable. */
  readonly reason: string;
  readonly code: ErrorCode | null;
  readonly nextAttemptAt: number | null;
  readonly delayMs: number | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
}

export interface RetryInput {
  readonly campaign: Campaign;
  readonly failureClass: FailureClass;
  readonly failureCode: string | null;
  /** Attempts already used, including the one that just failed. */
  readonly attemptCount: number;
  readonly now: number;
}

export class RetryService {
  readonly #jitter: Rng;

  constructor(options: { jitterRng: Rng }) {
    this.#jitter = options.jitterRng;
  }

  decide(input: RetryInput): RetryDecision {
    const policy = input.campaign.retryPolicy;
    // The campaign's attempt limit is authoritative; the retry policy's own limit is a
    // secondary bound. Taking the minimum means neither can be bypassed by editing only one.
    const maxAttempts = Math.min(policy.maxAttempts, input.campaign.maxAttemptsPerContact);

    const base = {
      attemptsUsed: input.attemptCount,
      maxAttempts,
    };

    if (input.failureClass === 'NONE') {
      return {
        ...base,
        retry: false,
        reason: 'Call succeeded; nothing to retry.',
        code: null,
        nextAttemptAt: null,
        delayMs: null,
      };
    }

    if (input.failureClass === 'PERMANENT') {
      return {
        ...base,
        retry: false,
        reason: `Permanent failure (${input.failureCode ?? 'unclassified'}); retrying would fail identically.`,
        code: (input.failureCode as ErrorCode | null) ?? null,
        nextAttemptAt: null,
        delayMs: null,
      };
    }

    if (input.attemptCount >= maxAttempts) {
      return {
        ...base,
        retry: false,
        reason: `All ${maxAttempts} attempts used.`,
        code: ERROR_CODES.MAX_ATTEMPTS_EXCEEDED,
        nextAttemptAt: null,
        delayMs: null,
      };
    }

    const delayMs = this.computeBackoff(input.campaign, input.attemptCount);
    return {
      ...base,
      retry: true,
      reason: `Transient failure; attempt ${input.attemptCount + 1} of ${maxAttempts} scheduled in ${delayMs}ms.`,
      code: null,
      delayMs,
      nextAttemptAt: input.now + delayMs,
    };
  }

  /**
   * Exponential backoff with jitter.
   *
   * The jitter is not decoration. A batch of contacts that failed together — which is what a
   * provider outage produces — would otherwise retry in lockstep, hitting the provider with
   * a synchronised burst at exactly the moment it is least able to cope. Spreading the
   * retries is what keeps a transient failure transient.
   *
   * Drawn from a seeded stream, so runs still replay identically (DECISIONS.md D-004).
   */
  computeBackoff(campaign: Campaign, attemptCount: number): number {
    const policy = campaign.retryPolicy;
    const exponent = Math.max(0, attemptCount - 1);
    const raw = policy.initialDelayMs * Math.pow(policy.multiplier, exponent);
    const capped = Math.min(raw, policy.maxDelayMs);

    if (policy.jitterRatio <= 0) return Math.round(capped);

    const spread = capped * Math.min(policy.jitterRatio, 1);
    const jittered = capped - spread + this.#jitter.next() * spread * 2;
    // Never below 1ms, and never above the configured ceiling even after jitter — a jittered
    // delay that exceeded maxDelay would quietly break the policy's stated guarantee.
    return Math.max(1, Math.min(Math.round(jittered), policy.maxDelayMs));
  }
}
