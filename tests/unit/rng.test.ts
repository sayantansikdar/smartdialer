import { describe, expect, it } from 'vitest';
import { RNG_STREAMS, SeededRandom } from '../../src/core/rng.ts';

describe('SeededRandom', () => {
  it('reproduces the same sequence for the same seed', () => {
    const first = new SeededRandom(12_345).stream('a');
    const second = new SeededRandom(12_345).stream('a');
    const a = Array.from({ length: 50 }, () => first.next());
    const b = Array.from({ length: 50 }, () => second.next());

    expect(a).toEqual(b);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, () => new SeededRandom(1).stream('x').next());
    const b = Array.from({ length: 20 }, () => new SeededRandom(2).stream('x').next());
    expect(a).not.toEqual(b);
  });

  it('gives each named stream an independent sequence', () => {
    const random = new SeededRandom(999);
    const outcome = Array.from({ length: 10 }, () => random.stream('provider.outcome').next());
    const ring = Array.from({ length: 10 }, () => random.stream('provider.ringDuration').next());
    expect(outcome).not.toEqual(ring);
  });

  it('memoises a stream so repeated lookups continue rather than restart it', () => {
    const random = new SeededRandom(7);
    const first = random.stream('s').next();
    const second = random.stream('s').next();
    expect(first).not.toBe(second);
  });

  it('leaves existing streams untouched when a new consumer is added', () => {
    // The whole reason for named streams (DECISIONS.md D-004). A seed recorded in a bug
    // report must keep reproducing its run even after someone adds a new random consumer
    // somewhere else in the system.
    const before = new SeededRandom(2024);
    const baseline = Array.from({ length: 10 }, () => before.stream('provider.outcome').next());

    const after = new SeededRandom(2024);
    after.stream('a.brand.new.consumer').next();
    after.stream('another.new.one').next();
    const later = Array.from({ length: 10 }, () => after.stream('provider.outcome').next());

    expect(later).toEqual(baseline);
  });

  it('reports which streams have been used', () => {
    const random = new SeededRandom(5);
    random.stream('zeta').next();
    random.stream('alpha').next();
    expect(random.activeStreams()).toEqual(['alpha', 'zeta']);
  });

  it('rejects a non-integer seed', () => {
    expect(() => new SeededRandom(1.5)).toThrow(TypeError);
  });
});

describe('Rng draws', () => {
  const rng = (): ReturnType<SeededRandom['stream']> => new SeededRandom(4242).stream('t');

  it('next() stays within [0, 1)', () => {
    const r = rng();
    for (let i = 0; i < 1000; i += 1) {
      const value = r.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int() stays within bounds and covers the range', () => {
    const r = rng();
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const value = r.int(5, 10);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(10);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
  });

  it('int() collapses to the lower bound for an empty range', () => {
    expect(rng().int(3, 3)).toBe(3);
    expect(rng().int(3, 1)).toBe(3);
  });

  it('bool() honours certain probabilities exactly and is roughly fair in between', () => {
    const r = rng();
    expect(r.bool(0)).toBe(false);
    expect(r.bool(1)).toBe(true);

    let trues = 0;
    const runs = 10_000;
    for (let i = 0; i < runs; i += 1) if (r.bool(0.3)) trues += 1;
    expect(trues / runs).toBeGreaterThan(0.27);
    expect(trues / runs).toBeLessThan(0.33);
  });

  it('pick() returns a member and rejects an empty array', () => {
    const r = rng();
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i += 1) expect(items).toContain(r.pick(items));
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it('durationAround() varies around the mean and never returns less than 1ms', () => {
    const r = rng();
    const values = Array.from({ length: 500 }, () => r.durationAround(1000, 0.4));

    expect(Math.min(...values)).toBeGreaterThanOrEqual(600);
    expect(Math.max(...values)).toBeLessThanOrEqual(1400);
    expect(new Set(values).size).toBeGreaterThan(50);

    expect(r.durationAround(0)).toBe(1);
    expect(r.durationAround(1, 1)).toBeGreaterThanOrEqual(1);
  });

  it('durationAround() with zero spread is exact', () => {
    expect(rng().durationAround(750, 0)).toBe(750);
  });
});

describe('RNG_STREAMS', () => {
  it('has unique stream names', () => {
    const names = Object.values(RNG_STREAMS);
    expect(new Set(names).size).toBe(names.length);
  });
});
