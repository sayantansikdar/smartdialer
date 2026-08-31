import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../src/core/clock.ts';
import { RateLimiterRegistry, TokenBucketRateLimiter } from '../../src/services/rate-limiter.ts';

describe('TokenBucketRateLimiter', () => {
  it('starts full and drains one token per call', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 5 });

    for (let i = 0; i < 5; i += 1) expect(limiter.tryConsume(), `call ${i}`).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refills from the clock, not from wall time', () => {
    // A limiter reading real time would let a 100x simulation place a hundred times more
    // calls per simulated second than a 1x run — the simulation would stop simulating the
    // same system.
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 10 });

    for (let i = 0; i < 10; i += 1) limiter.tryConsume();
    expect(limiter.tryConsume()).toBe(false);

    clock.advanceBy(500);
    expect(Math.floor(limiter.available)).toBe(5);
    expect(limiter.tryConsume()).toBe(true);
  });

  it('never refills beyond capacity', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 4 });

    clock.advanceBy(60_000);
    expect(limiter.available).toBe(4);
  });

  it('honours an explicit burst larger than the rate', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 2, burst: 10 });

    expect(limiter.capacity).toBe(10);
    for (let i = 0; i < 10; i += 1) expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('reports how long until a token is available', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 2 });

    while (limiter.tryConsume()) {
      /* drain */
    }
    expect(limiter.timeUntilAvailable()).toBe(500);

    clock.advanceBy(500);
    expect(limiter.timeUntilAvailable()).toBe(0);
  });

  it('enforces an average rate over a long window', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 10 });

    let consumed = 0;
    for (let ms = 0; ms < 10_000; ms += 10) {
      if (limiter.tryConsume()) consumed += 1;
      clock.advanceBy(10);
    }

    // 10 seconds at 10/s, plus the initial full bucket.
    expect(consumed).toBeGreaterThan(95);
    expect(consumed).toBeLessThanOrEqual(111);
  });

  it('rejects a non-positive rate', () => {
    const clock = new SimulatedClock();
    expect(() => new TokenBucketRateLimiter({ clock, ratePerSecond: 0 })).toThrow(RangeError);
  });

  it('resets to full', () => {
    const clock = new SimulatedClock();
    const limiter = new TokenBucketRateLimiter({ clock, ratePerSecond: 3 });
    while (limiter.tryConsume()) {
      /* drain */
    }
    limiter.reset();
    expect(limiter.available).toBe(3);
  });
});

describe('RateLimiterRegistry', () => {
  it('applies the campaign and global limits together', () => {
    const clock = new SimulatedClock();
    const registry = new RateLimiterRegistry({ clock, globalRatePerSecond: 3 });

    expect(registry.tryConsume('camp_1', 10)).toBe(true);
    expect(registry.tryConsume('camp_1', 10)).toBe(true);
    expect(registry.tryConsume('camp_1', 10)).toBe(true);
    // The campaign still has allowance, but the global bucket is empty.
    expect(registry.tryConsume('camp_1', 10)).toBe(false);
  });

  it('does not drain one bucket when the other refuses', () => {
    // Otherwise a campaign blocked by the global limit would fall progressively further
    // behind its own allowance for no reason.
    const clock = new SimulatedClock();
    const registry = new RateLimiterRegistry({ clock, globalRatePerSecond: 1 });

    expect(registry.tryConsume('camp_1', 5)).toBe(true);
    expect(registry.tryConsume('camp_1', 5)).toBe(false);

    // The campaign bucket should have lost exactly one token, not two.
    expect(Math.round(registry.forCampaign('camp_1', 5).available)).toBe(4);
  });

  it('keeps campaigns independent', () => {
    const clock = new SimulatedClock();
    const registry = new RateLimiterRegistry({ clock, globalRatePerSecond: 100 });

    expect(registry.tryConsume('camp_1', 1)).toBe(true);
    expect(registry.tryConsume('camp_1', 1)).toBe(false);
    expect(registry.tryConsume('camp_2', 1)).toBe(true);
  });

  it('rebuilds a campaign limiter when its configured rate changes', () => {
    // So editing calls-per-second in the UI takes effect immediately, not at restart.
    const clock = new SimulatedClock();
    const registry = new RateLimiterRegistry({ clock, globalRatePerSecond: 100 });

    const before = registry.forCampaign('camp_1', 5);
    expect(registry.forCampaign('camp_1', 5)).toBe(before);
    expect(registry.forCampaign('camp_1', 20)).not.toBe(before);
    expect(registry.forCampaign('camp_1', 20).capacity).toBe(20);
  });
});
