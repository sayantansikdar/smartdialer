/**
 * The safety engine.
 *
 * One ordered list of named rules. There is no path from a dialer strategy's decision to
 * `provider.createCall()` that does not pass through `evaluate()` (ARCHITECTURE.md,
 * "Safety boundary").
 *
 * Two design choices are worth understanding before changing anything here.
 *
 * **Why one list instead of checks at their natural call sites.** Scattered checks cannot be
 * audited — you can never be certain you have found them all, and a newly added dialing path
 * silently skips whichever ones its author forgot. A single ordered array is readable as a
 * specification: the safety policy is literally a list you can print (`describeRules()`).
 *
 * **Why a decision object instead of a boolean.** The same result feeds the log line, the
 * emitted event, and the dashboard's "why is this campaign not dialing?" panel. `false`
 * serves none of them. `DENIED: CAMPAIGN_CONCURRENCY_LIMIT` with the current and maximum
 * values turns a mystifying demo into a self-explaining one.
 *
 * **Rule order is meaningful.** Absolute prohibitions come first, so the reason reported is
 * the most fundamental one that applies — an emergency-stopped system says so, rather than
 * reporting whichever capacity limit it happened to hit. The rate limiter comes last
 * because it is the only rule with a side effect: consuming a token and *then* being denied
 * by a later rule would waste allowance the campaign never used.
 */

import { ERROR_CODES, type ErrorCode } from '../core/errors.ts';
import type { Campaign } from '../domain/campaign.ts';
import { canCampaignDial } from '../domain/campaign.ts';
import type { Contact } from '../domain/contact.ts';

export interface SafetyRateLimiter {
  /** Consume one token if available. Called at most once per evaluation, last. */
  tryConsume(): boolean;
  available(): number;
}

export interface SafetyContext {
  readonly now: number;
  readonly campaign: Campaign;
  /** Absent when asking "may this campaign dial at all?" rather than about one contact. */
  readonly contact: Contact | null;
  readonly emergencyStopped: boolean;

  readonly concurrency: {
    readonly global: number;
    readonly globalMax: number;
    readonly campaign: number;
    readonly provider: number;
    readonly providerMax: number;
  };

  readonly agents: {
    /** Free seats right now. */
    readonly available: number;
    /** Active calls not yet connected — each one might need a seat. */
    readonly pendingConnections: number;
  };

  readonly abandon: {
    readonly rate: number;
    /** Answered calls observed. The rate is meaningless below `abandonMinSample`. */
    readonly sample: number;
  };

  /** Omit (or pass null) to evaluate without consuming rate-limit allowance. */
  readonly rateLimiter: SafetyRateLimiter | null;
}

export interface SafetyDecision {
  readonly allowed: boolean;
  /** Which rule decided. `'allowed'` when every rule passed. */
  readonly rule: string;
  readonly code: ErrorCode | 'ALLOWED';
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

const ALLOWED: SafetyDecision = {
  allowed: true,
  rule: 'allowed',
  code: 'ALLOWED',
  message: 'All safety rules passed',
  metadata: {},
};

function deny(
  rule: string,
  code: ErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): SafetyDecision {
  return { allowed: false, rule, code, message, metadata };
}

export interface SafetyRule {
  readonly name: string;
  readonly description: string;
  /** Return a denial, or null to pass. */
  readonly evaluate: (context: SafetyContext) => SafetyDecision | null;
}

/**
 * The policy. Order matters — see the module comment.
 */
export const SAFETY_RULES: readonly SafetyRule[] = [
  {
    name: 'emergency-stop',
    description: 'No call may be initiated while the global emergency stop is engaged.',
    evaluate: (ctx) =>
      ctx.emergencyStopped
        ? deny(
            'emergency-stop',
            ERROR_CODES.EMERGENCY_STOP,
            'Emergency stop is engaged; no new calls may be initiated.',
            {},
          )
        : null,
  },
  {
    name: 'campaign-status',
    description: 'Only a RUNNING campaign may initiate calls.',
    evaluate: (ctx) =>
      canCampaignDial(ctx.campaign.status)
        ? null
        : deny(
            'campaign-status',
            ERROR_CODES.CAMPAIGN_NOT_RUNNING,
            `Campaign is ${ctx.campaign.status}, not RUNNING.`,
            { campaignId: ctx.campaign.id, status: ctx.campaign.status },
          ),
  },
  {
    name: 'predictive-paused',
    description:
      'Predictive dialing paused by the abandon-rate control stays paused until explicitly resumed.',
    evaluate: (ctx) =>
      ctx.campaign.predictivePausedReason === null
        ? null
        : deny(
            'predictive-paused',
            ERROR_CODES.ABANDON_RATE_EXCEEDED,
            `Predictive dialing is paused: ${ctx.campaign.predictivePausedReason}`,
            {
              campaignId: ctx.campaign.id,
              reason: ctx.campaign.predictivePausedReason,
              requiresExplicitResume: true,
            },
          ),
  },
  {
    name: 'abandon-rate',
    description:
      'Abandonment above the configured threshold blocks further dialing, once enough calls have been observed.',
    evaluate: (ctx) => {
      // Below the minimum sample the rate is noise — one abandoned call out of one would
      // otherwise read as 100% and stop a campaign that is behaving perfectly.
      if (ctx.abandon.sample < ctx.campaign.safety.abandonMinSample) return null;
      if (ctx.abandon.rate <= ctx.campaign.maxAbandonRate) return null;
      return deny(
        'abandon-rate',
        ERROR_CODES.ABANDON_RATE_EXCEEDED,
        `Abandon rate ${(ctx.abandon.rate * 100).toFixed(1)}% exceeds the maximum ` +
          `${(ctx.campaign.maxAbandonRate * 100).toFixed(1)}%.`,
        {
          campaignId: ctx.campaign.id,
          abandonRate: ctx.abandon.rate,
          maxAbandonRate: ctx.campaign.maxAbandonRate,
          sample: ctx.abandon.sample,
        },
      );
    },
  },
  {
    name: 'contact-do-not-call',
    description: 'A contact marked DO_NOT_CALL is never dialled, under any circumstances.',
    evaluate: (ctx) =>
      ctx.contact?.status === 'DO_NOT_CALL'
        ? deny(
            'contact-do-not-call',
            ERROR_CODES.CONTACT_DO_NOT_CALL,
            'Contact is marked DO_NOT_CALL.',
            { contactId: ctx.contact.id },
          )
        : null,
  },
  {
    name: 'contact-eligible',
    description: 'Only a contact the engine has reserved may be dialled.',
    evaluate: (ctx) => {
      if (ctx.contact === null) return null;
      // RESERVED is the expected state: the engine claims the contact before evaluating
      // safety. READY is tolerated so the rule can also answer hypothetical questions from
      // the UI without a reservation having been made.
      if (ctx.contact.status === 'RESERVED' || ctx.contact.status === 'READY') return null;
      return deny(
        'contact-eligible',
        ERROR_CODES.CONTACT_NOT_ELIGIBLE,
        `Contact is ${ctx.contact.status} and not eligible to be dialled.`,
        { contactId: ctx.contact.id, status: ctx.contact.status },
      );
    },
  },
  {
    name: 'max-attempts',
    description: 'A contact is never dialled beyond the campaign attempt limit.',
    evaluate: (ctx) => {
      if (ctx.contact === null) return null;
      if (ctx.contact.attemptCount < ctx.campaign.maxAttemptsPerContact) return null;
      return deny(
        'max-attempts',
        ERROR_CODES.MAX_ATTEMPTS_EXCEEDED,
        `Contact has used all ${ctx.campaign.maxAttemptsPerContact} attempts.`,
        {
          contactId: ctx.contact.id,
          attemptCount: ctx.contact.attemptCount,
          maxAttempts: ctx.campaign.maxAttemptsPerContact,
        },
      );
    },
  },
  {
    name: 'retry-not-due',
    description: 'A contact in backoff is not dialled before its next-attempt time.',
    evaluate: (ctx) => {
      const nextAttemptAt = ctx.contact?.nextAttemptAt;
      if (ctx.contact === null || nextAttemptAt == null || nextAttemptAt <= ctx.now) return null;
      return deny(
        'retry-not-due',
        ERROR_CODES.RETRY_NOT_DUE,
        `Contact is in backoff until ${nextAttemptAt}.`,
        { contactId: ctx.contact.id, nextAttemptAt, now: ctx.now },
      );
    },
  },
  {
    name: 'agent-capacity',
    description:
      'Calls in flight may not exceed the per-agent line ceiling for the dialing mode.',
    evaluate: (ctx) => {
      const linesPerAgent =
        ctx.campaign.dialingMode === 'PROGRESSIVE'
          ? ctx.campaign.safety.lineRatio
          : ctx.campaign.safety.maxLinesPerAgent;
      const ceiling = Math.floor(ctx.agents.available * linesPerAgent);

      // With no free seats the ceiling is zero in both modes. Dialing into zero capacity is
      // how calls get answered with nobody to take them.
      if (ctx.agents.pendingConnections < ceiling) return null;
      return deny(
        'agent-capacity',
        ERROR_CODES.AGENT_CAPACITY_EXCEEDED,
        `No agent capacity: ${ctx.agents.pendingConnections} call(s) already in flight for ` +
          `${ctx.agents.available} available agent(s).`,
        {
          campaignId: ctx.campaign.id,
          availableAgents: ctx.agents.available,
          pendingConnections: ctx.agents.pendingConnections,
          linesPerAgent,
          ceiling,
        },
      );
    },
  },
  {
    name: 'global-concurrency',
    description: 'Total active calls across all campaigns may not exceed the global limit.',
    evaluate: (ctx) =>
      ctx.concurrency.global < ctx.concurrency.globalMax
        ? null
        : deny(
            'global-concurrency',
            ERROR_CODES.GLOBAL_CONCURRENCY_LIMIT,
            `Global concurrent call limit reached (${ctx.concurrency.globalMax}).`,
            { current: ctx.concurrency.global, maximum: ctx.concurrency.globalMax },
          ),
  },
  {
    name: 'campaign-concurrency',
    description: 'Active calls for one campaign may not exceed its configured limit.',
    evaluate: (ctx) =>
      ctx.concurrency.campaign < ctx.campaign.maxConcurrentCalls
        ? null
        : deny(
            'campaign-concurrency',
            ERROR_CODES.CAMPAIGN_CONCURRENCY_LIMIT,
            'Campaign has reached its maximum concurrent call limit.',
            {
              campaignId: ctx.campaign.id,
              currentConcurrency: ctx.concurrency.campaign,
              maximumConcurrency: ctx.campaign.maxConcurrentCalls,
            },
          ),
  },
  {
    name: 'provider-concurrency',
    description: 'Active calls through one provider may not exceed its limit.',
    evaluate: (ctx) =>
      ctx.concurrency.provider < ctx.concurrency.providerMax
        ? null
        : deny(
            'provider-concurrency',
            ERROR_CODES.PROVIDER_CONCURRENCY_LIMIT,
            `Provider concurrent call limit reached (${ctx.concurrency.providerMax}).`,
            {
              providerId: ctx.campaign.providerId,
              current: ctx.concurrency.provider,
              maximum: ctx.concurrency.providerMax,
            },
          ),
  },
  {
    name: 'rate-limit',
    description: 'Dial initiation rate may not exceed the configured calls per second.',
    // LAST, and the only rule with a side effect. Consuming a token and then being denied by
    // a later rule would waste allowance the campaign never actually used.
    evaluate: (ctx) => {
      if (ctx.rateLimiter === null) return null;
      if (ctx.rateLimiter.tryConsume()) return null;
      return deny(
        'rate-limit',
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        `Dial rate limit of ${ctx.campaign.maxCallsPerSecond}/s reached.`,
        {
          campaignId: ctx.campaign.id,
          maxCallsPerSecond: ctx.campaign.maxCallsPerSecond,
          tokensAvailable: ctx.rateLimiter.available(),
        },
      );
    },
  },
];

/**
 * Denials that mean "wait", not "something is wrong".
 *
 * A dialer at capacity is a dialer working correctly: the pacer asks on every tick and is
 * told there is no room, hundreds of times a minute. Recording those at the same level as a
 * DNC block or an emergency stop has two costs — it buries the events that matter under
 * routine chatter in the event log, and it inflates a "safety interventions" figure that
 * then reads alarmingly when nothing has gone wrong at all.
 *
 * So denials are classified here, next to the rules that produce them, and the classification
 * drives both the emitted event severity and the simulation report's split between
 * backpressure and genuine protective action.
 */
const BACKPRESSURE_CODES: ReadonlySet<string> = new Set<string>([
  ERROR_CODES.AGENT_CAPACITY_EXCEEDED,
  ERROR_CODES.GLOBAL_CONCURRENCY_LIMIT,
  ERROR_CODES.CAMPAIGN_CONCURRENCY_LIMIT,
  ERROR_CODES.PROVIDER_CONCURRENCY_LIMIT,
  ERROR_CODES.RATE_LIMIT_EXCEEDED,
  ERROR_CODES.RETRY_NOT_DUE,
]);

/** True when a denial is ordinary flow control rather than a protective intervention. */
export function isBackpressure(code: ErrorCode | 'ALLOWED'): boolean {
  return BACKPRESSURE_CODES.has(code);
}

/** Event severity for a denial: routine backpressure is debug, real protection is a warning. */
export function denialSeverity(code: ErrorCode | 'ALLOWED'): 'debug' | 'warn' {
  return isBackpressure(code) ? 'debug' : 'warn';
}

export class SafetyEngine {
  readonly #rules: readonly SafetyRule[];

  constructor(rules: readonly SafetyRule[] = SAFETY_RULES) {
    this.#rules = rules;
  }

  /**
   * Evaluate every rule in order and return the first denial, or `ALLOWED`.
   *
   * Short-circuits: later rules are not evaluated once one denies. That matters because the
   * final rule consumes a rate-limit token.
   */
  canInitiateCall(context: SafetyContext): SafetyDecision {
    for (const rule of this.#rules) {
      const decision = rule.evaluate(context);
      if (decision !== null) return decision;
    }
    return ALLOWED;
  }

  /**
   * Evaluate every rule and collect *all* denials, without consuming rate-limit allowance.
   *
   * For the dashboard: an operator asking why a campaign is idle wants every reason, not
   * just the first one, and asking must not perturb the system being asked about.
   */
  explain(context: SafetyContext): readonly SafetyDecision[] {
    const readOnly: SafetyContext = { ...context, rateLimiter: null };
    const denials: SafetyDecision[] = [];
    for (const rule of this.#rules) {
      const decision = rule.evaluate(readOnly);
      if (decision !== null) denials.push(decision);
    }
    return denials;
  }

  /** The policy, in order. Printed by the API so the UI can show what is enforced. */
  describeRules(): ReadonlyArray<{ name: string; description: string }> {
    return this.#rules.map((rule) => ({ name: rule.name, description: rule.description }));
  }
}
