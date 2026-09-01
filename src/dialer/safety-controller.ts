/**
 * The Safety Controller.
 *
 * This is the component the assignment calls "the important part", and the reason it exists
 * is structural rather than functional:
 *
 *     Campaign > Pacing Engine > Safety Controller > Call Allocator > Telecom Provider
 *
 * A pacing engine says *"I think we can start 15 more calls"*. It does not get to act on that.
 * The controller decides what is actually allowed, and it is the only component in the system
 * that can produce an approved call count.
 *
 * **Why this is not the same as the pacer applying its own limits.** It previously did, and
 * that was wrong for a reason worth stating plainly: a component that both computes an
 * aggressive number and enforces the bound on it has no bound. Any bug in the pacer — a
 * collapsed answer-rate estimate, a runaway feedback loop, a future contributor "optimising"
 * a clamp — silently becomes a bug in the safety limit. Separating them means the pacer can
 * be as wrong as it likes and the ceiling still holds, because the ceiling is computed by
 * code that never sees the pacer's intent.
 *
 * The controller can do four things, and it reports which:
 *
 *   APPROVED              the request was safe as asked
 *   REDUCED               a ceiling cut it; the controller says which and by how much
 *   REJECTED              nothing may be dialled right now, and why
 *   FALLBACK_PROGRESSIVE  predictive pacing is not currently trustworthy, so the request is
 *                         replaced by the progressive number — one line per free agent
 *
 * The fourth is the interesting one. Predictive dialing is a bet on an estimate; when the
 * estimate stops being credible (too little evidence, abandonment climbing, the provider
 * misbehaving) the safe move is not to stop dialing, it is to stop *betting* — degrade to the
 * mode that cannot abandon anyone and keep working.
 *
 * There is deliberately no flag, option or parameter that disables any of this.
 */

import type { Campaign, DialingMode } from '../domain/campaign.ts';

/** What a pacing engine produces. A request, never a decision. */
export interface PacingRequest {
  readonly campaignId: string;
  readonly mode: DialingMode;
  /** "I think we can start this many more calls." Unclamped and untrusted. */
  readonly requested: number;
  /** How the pacer arrived at the number, for the operator and the report. */
  readonly reasoning: readonly string[];
}

export type SafetyVerdict = 'APPROVED' | 'REDUCED' | 'REJECTED' | 'FALLBACK_PROGRESSIVE';

/** One ceiling that actually bit, and what it cut the number to. */
export interface SafetyReduction {
  readonly control: string;
  readonly ceiling: number;
  readonly from: number;
  readonly to: number;
}

export interface SafetyControllerDecision {
  readonly verdict: SafetyVerdict;
  readonly requested: number;
  /** The only number the allocator is permitted to act on. */
  readonly approved: number;
  readonly reductions: readonly SafetyReduction[];
  /** Present when the verdict is REJECTED or FALLBACK_PROGRESSIVE. */
  readonly cause: string | null;
  readonly explanation: string;
}

/**
 * Everything the controller reasons over. Assembled by the engine; the controller performs
 * no I/O of its own, so its decisions are a pure function of this and are directly testable.
 */
export interface SafetyControllerContext {
  readonly campaign: Campaign;
  readonly emergencyStopped: boolean;

  /** Free seats right now. */
  readonly availableAgents: number;
  /** Active calls not yet connected — each could still need a seat. */
  readonly pendingConnections: number;

  readonly campaignHeadroom: number;
  readonly globalHeadroom: number;
  readonly providerHeadroom: number;
  readonly rateLimitHeadroom: number;
  readonly remainingContacts: number;

  readonly abandonRate: number;
  readonly abandonSample: number;
  /** Completed calls behind the answer-rate estimate. Thin evidence is itself a risk. */
  readonly answerRateSample: number;

  /**
   * Recent provider rejection rate. A provider that is refusing or timing out is not a
   * provider whose answer statistics mean anything, so predictive pacing stops being
   * justified before the provider stops working entirely.
   */
  readonly providerFailureRate: number;

  /**
   * The answer rate the controller should assume when bounding abandonment.
   *
   * The controller needs this because the variance bound is a *safety* property, not a
   * pacing preference — see `varianceCeiling`.
   */
  readonly estimatedAnswerRate: number;
}

export interface SafetyControllerTuning {
  /** Completed calls required before a predictive over-dial is trusted at all. */
  readonly minAnswerRateSample: number;
  /**
   * Standard deviations of headroom the controller keeps between expected answers and free
   * seats.
   *
   * Deliberately *stricter* than the pacer's own guard (2.0 against 1.5). They are answering
   * different questions: the pacer asks "what is a reasonable bet?", the controller asks
   * "what will I permit?". 1.5 sigma leaves roughly a 7% chance of a batch overshooting
   * capacity, which compounds across many batches; 2 sigma leaves about 2.3%. Paying a little
   * throughput for that is the right trade when the cost of the tail is a person hearing
   * silence.
   */
  readonly safetyBufferSigmas: number;
  /** Provider rejection rate above which predictive degrades to progressive. */
  readonly maxProviderFailureRate: number;
  /** Fraction of the campaign's abandon limit at which predictive degrades. */
  readonly abandonFallbackRatio: number;
}

export const DEFAULT_CONTROLLER_TUNING: SafetyControllerTuning = {
  minAnswerRateSample: 20,
  safetyBufferSigmas: 1.5,
  maxProviderFailureRate: 0.25,
  abandonFallbackRatio: 0.75,
};

export class SafetyController {
  readonly #tuning: SafetyControllerTuning;

  constructor(tuning: Partial<SafetyControllerTuning> = {}) {
    this.#tuning = { ...DEFAULT_CONTROLLER_TUNING, ...tuning };
  }

  /**
   * Review a pacing request. This is the only path to an approved call count.
   *
   * Evaluated in three stages: absolute prohibitions, then trust in the pacing mode, then
   * capacity ceilings. Order matters — an emergency-stopped system should say so rather
   * than reporting whichever ceiling it happened to hit first.
   */
  review(request: PacingRequest, context: SafetyControllerContext): SafetyControllerDecision {
    const reject = (cause: string, explanation: string): SafetyControllerDecision => ({
      verdict: 'REJECTED',
      requested: request.requested,
      approved: 0,
      reductions: [],
      cause,
      explanation,
    });

    // ---- Stage 1: absolute prohibitions. No number survives these.
    if (context.emergencyStopped) {
      return reject('EMERGENCY_STOP', 'Emergency stop is engaged; no calls may be initiated.');
    }
    if (context.campaign.status !== 'RUNNING') {
      return reject('CAMPAIGN_NOT_RUNNING', `Campaign is ${context.campaign.status}, not RUNNING.`);
    }
    if (context.campaign.predictivePausedReason !== null) {
      return reject(
        'ABANDON_RATE_EXCEEDED',
        `Predictive dialing is paused and requires an explicit resume: ${context.campaign.predictivePausedReason}`,
      );
    }
    if (request.requested <= 0) {
      return {
        verdict: 'APPROVED',
        requested: request.requested,
        approved: 0,
        reductions: [],
        cause: null,
        explanation: 'The pacing engine asked for nothing.',
      };
    }

    // ---- Stage 2: is predictive pacing currently trustworthy?
    //
    // The progressive number is the floor the system falls back to: one line per free seat,
    // minus what is already in flight. It cannot abandon anyone, which is precisely why it is
    // the safe answer when the predictive estimate is not credible.
    const progressiveCeiling = Math.max(
      0,
      Math.floor(context.availableAgents * context.campaign.safety.lineRatio) -
        context.pendingConnections,
    );

    let ceiling = request.requested;
    let verdict: SafetyVerdict = 'APPROVED';
    let cause: string | null = null;
    const reductions: SafetyReduction[] = [];

    if (request.mode === 'PREDICTIVE') {
      const fallback = this.#assessPredictiveTrust(context);
      if (fallback !== null && progressiveCeiling < request.requested) {
        verdict = 'FALLBACK_PROGRESSIVE';
        cause = fallback.code;
        reductions.push({
          control: `fallback-to-progressive (${fallback.code})`,
          ceiling: progressiveCeiling,
          from: ceiling,
          to: progressiveCeiling,
        });
        ceiling = progressiveCeiling;
      } else if (fallback !== null) {
        // The pacer was already asking for no more than progressive would, so the fallback
        // changes nothing. Recorded anyway so the reason is visible in the report.
        cause = fallback.code;
      }
    }

    // ---- Stage 3: capacity ceilings. Every one applies, in this order, and each records
    // itself if it actually bit — so "why only 4?" is answerable without reading the source.
    const ceilings: ReadonlyArray<{ control: string; value: number }> = [
      {
        /**
         * The abandonment bound, enforced here rather than trusted to the pacer.
         *
         * `maxLinesPerAgent` is a blunt per-seat cap and it is not the quantity that governs
         * abandonment. What governs abandonment is whether the *answers* a batch produces fit
         * the seats available, and answers are binomial — so the bound has to account for
         * variance, not just the mean.
         *
         * The pacer applies the same guard on its own account, and this duplication is
         * deliberate. A safety limit that exists only inside the component it is meant to
         * constrain is not a limit (D-018). Without this the controller happily approved 10
         * lines into 3 free seats at a 70% answer rate, and abandoned 30% of the people who
         * picked up (BUG.md B-013).
         */
        control: 'abandonment variance bound',
        value:
          request.mode === 'PREDICTIVE'
            ? this.varianceCeiling(context.availableAgents, context.estimatedAnswerRate) -
              context.pendingConnections
            : Number.POSITIVE_INFINITY,
      },
      {
        control: 'agent capacity',
        value: Math.max(
          0,
          Math.floor(
            context.availableAgents *
              (request.mode === 'PROGRESSIVE'
                ? context.campaign.safety.lineRatio
                : context.campaign.safety.maxLinesPerAgent),
          ) - context.pendingConnections,
        ),
      },
      { control: 'campaign concurrency', value: context.campaignHeadroom },
      { control: 'global concurrency', value: context.globalHeadroom },
      { control: 'provider concurrency', value: context.providerHeadroom },
      { control: 'rate limit', value: context.rateLimitHeadroom },
      { control: 'contacts remaining', value: context.remainingContacts },
    ];

    for (const limit of ceilings) {
      const bound = Math.max(0, Math.floor(limit.value));
      if (bound < ceiling) {
        reductions.push({ control: limit.control, ceiling: bound, from: ceiling, to: bound });
        ceiling = bound;
      }
    }

    const approved = Math.max(0, ceiling);

    if (approved === 0) {
      const last = reductions.at(-1);
      return reject(
        last === undefined ? 'NO_CAPACITY' : last.control.toUpperCase().replace(/[ ()-]+/g, '_'),
        last === undefined
          ? 'No capacity to dial right now.'
          : `Reduced to zero by ${last.control}.`,
      );
    }

    if (verdict !== 'FALLBACK_PROGRESSIVE') {
      verdict = approved < request.requested ? 'REDUCED' : 'APPROVED';
    }

    return {
      verdict,
      requested: request.requested,
      approved,
      reductions,
      cause,
      explanation: describe(verdict, request.requested, approved, reductions, cause),
    };
  }

  /**
   * The largest number of simultaneous lines whose answers are unlikely to exceed capacity.
   *
   * For `L` lines at answer rate `p`, the number answering has mean `Lp` and standard
   * deviation `sqrt(Lp(1-p))`. We require
   *
   *     Lp + k*sqrt(Lp(1-p)) <= seats
   *
   * which is a quadratic in `sqrt(L)`, solved in closed form. Never returns fewer lines than
   * there are free seats: one line per seat is progressive dialing, which abandons nobody, so
   * the bound must never push below it.
   */
  varianceCeiling(availableAgents: number, answerRate: number): number {
    const k = this.#tuning.safetyBufferSigmas;
    const p = Math.min(Math.max(answerRate, 0.01), 1);
    if (availableAgents <= 0) return 0;
    if (k <= 0) return Math.ceil(availableAgents / p);

    const b = k * Math.sqrt(p * (1 - p));
    const x = (-b + Math.sqrt(b * b + 4 * p * availableAgents)) / (2 * p);
    return Math.max(availableAgents, Math.floor(x * x));
  }

  /**
   * Decide whether a predictive over-dial is currently justified.
   *
   * Each of these says the same thing in a different way: the estimate the bet rests on is
   * not currently believable. Returning a reason rather than a boolean means the operator
   * sees *why* the system stopped over-dialing, which is otherwise indistinguishable from
   * the dialer having quietly broken.
   */
  #assessPredictiveTrust(context: SafetyControllerContext): { code: string } | null {
    if (context.answerRateSample < this.#tuning.minAnswerRateSample) {
      return { code: 'INSUFFICIENT_ANSWER_RATE_EVIDENCE' };
    }
    if (context.providerFailureRate > this.#tuning.maxProviderFailureRate) {
      return { code: 'PROVIDER_UNHEALTHY' };
    }
    // Degrade before the hard abandon limit stops the campaign outright — the point is to
    // keep dialing safely, not to sawtooth between full speed and a halt.
    const threshold = context.campaign.maxAbandonRate * this.#tuning.abandonFallbackRatio;
    if (context.abandonSample >= context.campaign.safety.abandonMinSample && context.abandonRate > threshold) {
      return { code: 'ABANDON_RATE_APPROACHING_LIMIT' };
    }
    return null;
  }
}

function describe(
  verdict: SafetyVerdict,
  requested: number,
  approved: number,
  reductions: readonly SafetyReduction[],
  cause: string | null,
): string {
  const trail = reductions.map((r) => `${r.control} -> ${r.to}`).join('; ');
  switch (verdict) {
    case 'APPROVED':
      return `Approved ${approved} of ${requested} requested.`;
    case 'REDUCED':
      return `Reduced ${requested} to ${approved}: ${trail}.`;
    case 'FALLBACK_PROGRESSIVE':
      return `Predictive pacing not currently trusted (${cause ?? 'unknown'}); fell back to progressive: ${requested} -> ${approved}. ${trail}`;
    case 'REJECTED':
      return `Rejected: ${cause ?? 'no capacity'}.`;
  }
}
