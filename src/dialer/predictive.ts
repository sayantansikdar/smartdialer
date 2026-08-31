/**
 * Predictive dialing.
 *
 * The bet: if only ~60% of calls are answered, dialing one line per free agent leaves those
 * agents idle ~40% of the time. So dial more than you have seats for, and rely on the
 * answer rate to make the arithmetic work out.
 *
 * The bet's cost when it goes wrong is a person picking up the phone to silence — an
 * *abandoned* call. That is the harm predictive dialing regulation exists to bound, and it
 * is why this file is written defensively rather than aggressively.
 *
 * Four ideas do the work:
 *
 * 1. **The answer-rate estimate is blended and floored.** Recent behaviour matters more than
 *    lifetime history, but only once enough calls have been observed to mean anything — an
 *    early run of three no-answers must not be read as "0% answer rate", because dividing by
 *    an estimate near zero asks for an unbounded number of lines. The floor
 *    (`PREDICTIVE_MIN_ANSWER_RATE`) is what makes that division safe.
 *
 * 2. **Occupancy feedback.** If agents are busier than the target, pull back; if they are
 *    idler, lean in. This is what makes pacing adapt instead of oscillating around a
 *    constant.
 *
 * 3. **The abandon rate degrades pacing before it stops it.** Crossing the threshold does
 *    not slam the campaign to a halt on the first bad sample; it progressively reduces the
 *    multiplier, and only the safety engine's hard rule stops dialing outright.
 *
 * 4. **Nothing here is trusted.** Every number this produces is still subject to
 *    `maxLinesPerAgent` and all three concurrency ceilings, enforced per call downstream. A
 *    bug in this file cannot over-dial; it can only ask to.
 */

import type { DialerSnapshot, DialerStrategy, DialPlan } from './strategy.ts';
import { applyLimits, pct } from './strategy.ts';

export interface PredictiveTuning {
  /**
   * Recent-window sample at which the recent answer rate is fully trusted. Below it, the
   * estimate is blended proportionally towards the historical rate.
   */
  readonly blendSample: number;
  /** Hard floor on the estimated answer rate. Prevents division by ~0. */
  readonly minAnswerRate: number;
  /**
   * Answer rate assumed before any calls have completed.
   *
   * Deliberately HIGH, which is the conservative direction: the estimate is a divisor, so a
   * high assumed answer rate produces *fewer* lines. Starting at 0.9 means a campaign opens
   * at roughly one line per agent and ramps up as it learns the real rate — which is how
   * real predictive dialers behave, and the opposite of guessing low and over-dialing into
   * agents who do not exist yet. See BUG.md B-004.
   */
  readonly coldStartAnswerRate: number;
  /** How strongly occupancy error moves the multiplier. */
  readonly occupancyGain: number;
  /** Bounds on the occupancy adjustment, so feedback cannot run away. */
  readonly minOccupancyAdjustment: number;
  readonly maxOccupancyAdjustment: number;
  /**
   * Completed calls required before occupancy feedback is applied at all.
   *
   * At the start of a campaign occupancy is 0 simply because nothing has happened yet — that
   * is not evidence of under-dialing. Boosting on it compounds with an already-uncertain
   * answer-rate estimate, and compounding two guesses is exactly what produced a 3x
   * over-dial (BUG.md B-004).
   */
  readonly occupancyMinSample: number;
  /**
   * How many standard deviations of headroom to keep between expected answers and available
   * seats. This is the `safetyBuffer` signal from the specification, and it is the control
   * that actually prevents abandonment — see `varianceCap` for why an expected-value
   * calculation alone is not enough.
   *
   * 1.5 sigma leaves roughly a 7% chance of a burst exceeding capacity per batch; 0 disables
   * the guard and reverts to pacing on expectation alone.
   */
  readonly safetyBufferSigmas: number;
}

export const DEFAULT_PREDICTIVE_TUNING: PredictiveTuning = {
  blendSample: 30,
  minAnswerRate: 0.1,
  coldStartAnswerRate: 0.9,
  occupancyGain: 0.3,
  minOccupancyAdjustment: 0.5,
  maxOccupancyAdjustment: 1.2,
  occupancyMinSample: 10,
  safetyBufferSigmas: 1.5,
};

export class PredictiveDialer implements DialerStrategy {
  readonly mode = 'PREDICTIVE' as const;
  readonly #tuning: PredictiveTuning;

  constructor(tuning: Partial<PredictiveTuning> = {}) {
    this.#tuning = { ...DEFAULT_PREDICTIVE_TUNING, ...tuning };
  }

  computeDialPlan(snapshot: DialerSnapshot): DialPlan {
    const reasoning: string[] = [];
    const { campaign } = snapshot;

    if (snapshot.availableAgents <= 0) {
      reasoning.push('no available agents; predictive pacing requires at least one free seat');
      return { attempts: 0, reasoning };
    }

    const answerRate = this.estimateAnswerRate(snapshot, reasoning);
    const occupancyAdjustment = this.occupancyAdjustment(snapshot, reasoning);
    const abandonAdjustment = this.abandonAdjustment(snapshot, reasoning);

    const multiplier = campaign.safety.pacingMultiplier * occupancyAdjustment * abandonAdjustment;
    reasoning.push(
      `pacing multiplier ${campaign.safety.pacingMultiplier} x occupancy ${occupancyAdjustment.toFixed(2)} ` +
        `x abandon ${abandonAdjustment.toFixed(2)} = ${multiplier.toFixed(2)}`,
    );

    const targetLines = Math.ceil((snapshot.availableAgents * multiplier) / answerRate);
    reasoning.push(
      `ceil(${snapshot.availableAgents} agents x ${multiplier.toFixed(2)} / ${answerRate.toFixed(2)} answer rate) ` +
        `= ${targetLines} line(s)`,
    );

    let desired = targetLines;

    // Variance guard — the control that actually prevents abandonment.
    //
    // `targetLines` balances the *expected* number of answers against available seats, and
    // expectation is not enough: 8 lines at a 50% answer rate averages 4 answers, but the
    // outcome is binomial, and roughly one batch in seven produces more answers than there
    // are agents. Every one of those excess answers is a real person hearing silence.
    //
    // So instead of pacing to the mean, pace to mean + k*sigma <= seats (BUG.md B-004).
    const varianceCapped = this.varianceCap(snapshot.availableAgents, answerRate);
    if (varianceCapped < desired) {
      reasoning.push(
        `clamped to ${varianceCapped} by the ${this.#tuning.safetyBufferSigmas}-sigma safety buffer ` +
          `(expected answers plus variance must fit the available seats)`,
      );
      desired = varianceCapped;
    }

    // The per-agent ceiling is applied here as well as in the safety engine. Not redundant:
    // clamping in the plan means the dashboard shows an honest target rather than a number
    // that would be silently refused call by call.
    const ceiling = Math.floor(snapshot.availableAgents * campaign.safety.maxLinesPerAgent);
    if (desired > ceiling) {
      reasoning.push(
        `clamped to ${ceiling} by maxLinesPerAgent ${campaign.safety.maxLinesPerAgent}`,
      );
      desired = ceiling;
    }

    desired -= snapshot.pendingConnections;
    reasoning.push(
      `minus ${snapshot.pendingConnections} call(s) already in flight = ${Math.max(0, desired)}`,
    );

    if (desired <= 0) {
      reasoning.push('target already met by calls in flight');
      return { attempts: 0, reasoning };
    }

    const attempts = applyLimits(desired, snapshot, reasoning);
    if (attempts === 0) reasoning.push('a hard limit reduced the plan to zero');
    return { attempts, reasoning };
  }

  /**
   * Blend the recent and historical answer rates, then floor the result.
   *
   * The floor is the load-bearing part. `agents / answerRate` with an estimate near zero
   * asks for an effectively unbounded number of lines, and an early run of no-answers is
   * exactly how an estimate gets near zero.
   */
  estimateAnswerRate(snapshot: DialerSnapshot, reasoning: string[]): number {
    const floor = Math.max(this.#tuning.minAnswerRate, 0.01);
    const prior = Math.max(floor, Math.min(1, this.#tuning.coldStartAnswerRate));

    if (snapshot.recentSample === 0) {
      reasoning.push(`no completed calls yet; assuming ${pct(prior)} (conservative prior)`);
      return prior;
    }

    // Observed behaviour, weighted towards the recent window — a campaign that answered well
    // an hour ago and badly now must pace on the second fact.
    const observed = snapshot.historicalAnswerRate * 0.3 + snapshot.recentAnswerRate * 0.7;

    // Blend the observation against the conservative prior in proportion to how much
    // evidence there is. This is the guard that matters: the estimate is a *divisor*, so an
    // early run of two no-answers would otherwise read as a near-zero answer rate and ask
    // for an enormous number of lines (BUG.md B-004). Confidence ramps in over
    // `blendSample` calls, so the campaign eases from ~1 line per agent into true
    // predictive pacing.
    const confidence = Math.min(1, snapshot.recentSample / this.#tuning.blendSample);
    const blended = prior * (1 - confidence) + observed * confidence;

    if (blended < floor) {
      reasoning.push(
        `answer rate estimate ${pct(blended)} floored to ${pct(floor)} to bound the line count`,
      );
      return floor;
    }

    reasoning.push(
      `answer rate ${pct(blended)} (observed ${pct(observed)} at ${(confidence * 100).toFixed(0)}% ` +
        `confidence over ${snapshot.recentSample} calls, prior ${pct(prior)})`,
    );
    return Math.min(1, blended);
  }

  /**
   * The largest number of simultaneous lines whose answers are unlikely to exceed capacity.
   *
   * Answers are binomial: for `L` lines at answer rate `p`, the number answering has mean
   * `Lp` and standard deviation `sqrt(Lp(1-p))`. We want
   *
   *     Lp + k*sqrt(Lp(1-p)) <= seats
   *
   * Substituting `x = sqrt(L)` makes this a quadratic in `x`, solved in closed form below.
   *
   * The behaviour this produces is the interesting part, and it matches how real predictive
   * dialing works: **the safe over-dial ratio grows with team size.** With 5 seats at a 50%
   * answer rate it permits about 6 lines (1.2x); with 20 seats it permits about 31 (1.55x).
   * Small teams cannot safely over-dial much, because a single unlucky batch is a large
   * fraction of their capacity — which is exactly why predictive dialing is a large-team
   * technique, and why a 5-agent predictive campaign trips the abandon control so easily.
   */
  varianceCap(availableAgents: number, answerRate: number): number {
    const k = this.#tuning.safetyBufferSigmas;
    const p = Math.min(Math.max(answerRate, 0.01), 1);
    if (availableAgents <= 0) return 0;
    if (k <= 0) return Math.ceil(availableAgents / p);

    const b = k * Math.sqrt(p * (1 - p));
    const x = (-b + Math.sqrt(b * b + 4 * p * availableAgents)) / (2 * p);
    // At least one line per free agent: the guard must never pace below progressive dialing,
    // which places one call per seat and abandons nobody.
    return Math.max(availableAgents, Math.floor(x * x));
  }

  /**
   * Nudge pacing toward the target occupancy.
   *
   * Bounded on both sides so the feedback loop cannot run away: an unbounded correction
   * would oscillate — over-dial, abandon, pull back hard, leave agents idle, over-dial again.
   */
  occupancyAdjustment(snapshot: DialerSnapshot, reasoning: string[]): number {
    if (snapshot.totalAgents === 0) return 1;

    // Not enough evidence yet. Occupancy of 0 at the start of a campaign means "nothing has
    // happened", not "we are under-dialing" (BUG.md B-004).
    if (snapshot.recentSample < this.#tuning.occupancyMinSample) {
      reasoning.push(
        `occupancy feedback held at 1.00 until ${this.#tuning.occupancyMinSample} calls complete ` +
          `(${snapshot.recentSample} so far)`,
      );
      return 1;
    }

    const occupancy = snapshot.occupiedAgents / snapshot.totalAgents;
    const target = snapshot.campaign.safety.targetOccupancy;
    const error = target - occupancy;

    const raw = 1 + error * this.#tuning.occupancyGain;
    const adjustment = Math.min(
      this.#tuning.maxOccupancyAdjustment,
      Math.max(this.#tuning.minOccupancyAdjustment, raw),
    );

    reasoning.push(
      `occupancy ${pct(occupancy)} vs target ${pct(target)} -> adjustment ${adjustment.toFixed(2)}`,
    );
    return adjustment;
  }

  /**
   * Degrade pacing as abandonment approaches and exceeds the threshold.
   *
   * Deliberately gradual. The safety engine stops the campaign outright when the threshold
   * is genuinely breached; this exists so that pacing backs off *before* it gets there,
   * which is what keeps a campaign running instead of sawtoothing between full speed and a
   * hard stop.
   */
  abandonAdjustment(snapshot: DialerSnapshot, reasoning: string[]): number {
    const { campaign } = snapshot;
    if (snapshot.abandonSample < campaign.safety.abandonMinSample) return 1;

    const ratio = snapshot.abandonRate / Math.max(campaign.maxAbandonRate, 0.0001);
    if (ratio <= 0.5) return 1;

    // Full pacing at half the threshold, down to a quarter speed at twice it.
    const adjustment = Math.min(1, Math.max(0.25, 1.5 - ratio));
    reasoning.push(
      `abandon rate ${pct(snapshot.abandonRate)} vs max ${pct(campaign.maxAbandonRate)} ` +
        `-> pacing reduced to ${adjustment.toFixed(2)}`,
    );
    return adjustment;
  }
}
