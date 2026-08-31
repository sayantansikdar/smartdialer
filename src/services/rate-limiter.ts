/**
 * Token-bucket rate limiting, measured in virtual time.
 *
 * A concurrency limit caps how many calls exist at once; a rate limit caps how fast they
 * are created. They are different controls and a dialer needs both: 50 concurrent calls is
 * fine, but creating all 50 in the same millisecond is a burst no carrier would thank you
 * for, and it makes the answer-rate estimate meaningless because everything resolves at
 * once.
 *
 * Refill is lazy and driven by the injected clock, so the limiter behaves identically at
 * 1x and 100x simulation speed. A limiter reading wall-clock time would let a 100x run
 * place a hundred times more calls per simulated second than a 1x run — the simulation
 * would stop being a simulation of the same system.
 */

import type { Clock } from '../core/clock.ts';

export interface RateLimiterOptions {
  readonly clock: Clock;
  readonly ratePerSecond: number;
  /**
   * Bucket capacity. Defaults to one second's worth, so a campaign that has been idle can
   * place a normal second's calls immediately rather than trickling.
   */
  readonly burst?: number;
}

export class TokenBucketRateLimiter {
  readonly #clock: Clock;
  readonly #ratePerSecond: number;
  readonly #capacity: number;
  #tokens: number;
  #lastRefillAt: number;

  constructor(options: RateLimiterOptions) {
    if (options.ratePerSecond <= 0) {
      throw new RangeError(`ratePerSecond must be > 0, got ${options.ratePerSecond}`);
    }
    this.#clock = options.clock;
    this.#ratePerSecond = options.ratePerSecond;
    this.#capacity = Math.max(1, options.burst ?? options.ratePerSecond);
    this.#tokens = this.#capacity;
    this.#lastRefillAt = options.clock.now();
  }

  get ratePerSecond(): number {
    return this.#ratePerSecond;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Tokens available right now, after accounting for elapsed virtual time. */
  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Consume a token if one is available. Returns false without consuming otherwise. */
  tryConsume(tokens = 1): boolean {
    this.#refill();
    if (this.#tokens < tokens) return false;
    this.#tokens -= tokens;
    return true;
  }

  /** Virtual milliseconds until `tokens` are available. 0 when they already are. */
  timeUntilAvailable(tokens = 1): number {
    this.#refill();
    if (this.#tokens >= tokens) return 0;
    return Math.ceil(((tokens - this.#tokens) / this.#ratePerSecond) * 1000);
  }

  #refill(): void {
    const now = this.#clock.now();
    const elapsed = now - this.#lastRefillAt;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsed / 1000) * this.#ratePerSecond);
    this.#lastRefillAt = now;
  }

  reset(): void {
    this.#tokens = this.#capacity;
    this.#lastRefillAt = this.#clock.now();
  }
}

/**
 * The global limiter plus one per campaign.
 *
 * Both apply to every dial: a single campaign must not exceed its own configured rate, and
 * all campaigns together must not exceed the system's.
 */
export class RateLimiterRegistry {
  readonly #clock: Clock;
  readonly #global: TokenBucketRateLimiter;
  readonly #byCampaign = new Map<string, { limiter: TokenBucketRateLimiter; rate: number }>();

  constructor(options: { clock: Clock; globalRatePerSecond: number }) {
    this.#clock = options.clock;
    this.#global = new TokenBucketRateLimiter({
      clock: options.clock,
      ratePerSecond: options.globalRatePerSecond,
    });
  }

  get global(): TokenBucketRateLimiter {
    return this.#global;
  }

  /**
   * The limiter for a campaign, rebuilt if its configured rate has changed — so editing a
   * campaign's calls-per-second in the UI takes effect immediately rather than at restart.
   */
  forCampaign(campaignId: string, ratePerSecond: number): TokenBucketRateLimiter {
    const existing = this.#byCampaign.get(campaignId);
    if (existing !== undefined && existing.rate === ratePerSecond) return existing.limiter;

    const limiter = new TokenBucketRateLimiter({ clock: this.#clock, ratePerSecond });
    this.#byCampaign.set(campaignId, { limiter, rate: ratePerSecond });
    return limiter;
  }

  /**
   * Consume from the campaign bucket and the global bucket together, or neither.
   *
   * Consuming one and then failing on the other would silently drain the first, and a
   * campaign blocked by the global limit would fall progressively further behind its own
   * allowance for no reason.
   */
  tryConsume(campaignId: string, ratePerSecond: number): boolean {
    const campaignLimiter = this.forCampaign(campaignId, ratePerSecond);
    if (campaignLimiter.available < 1) return false;
    if (this.#global.available < 1) return false;
    return campaignLimiter.tryConsume() && this.#global.tryConsume();
  }

  reset(): void {
    this.#global.reset();
    this.#byCampaign.clear();
  }
}
