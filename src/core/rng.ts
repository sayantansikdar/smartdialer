/**
 * Seeded randomness.
 *
 * `Math.random()` is banned repo-wide by ESLint. Every random draw in the system comes from
 * here, so a simulation replays identically from its seed (DECISIONS.md D-004).
 *
 * The important design point is **named streams**. The obvious approach — one global seeded
 * generator everyone draws from — has a failure mode that only shows up later: adding a new
 * random consumer anywhere shifts the draw sequence for every existing consumer, so a seed
 * recorded in a bug report stops reproducing the run it was filed against. Instead each
 * consumer names its own stream, whose seed is derived from the root seed and the name.
 * Streams are independent, so adding one perturbs nobody else.
 *
 * The cost: stream names are part of the reproducibility contract. Renaming a stream
 * changes its results.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** True with the given probability (clamped to [0, 1]). */
  bool(probability: number): boolean;
  /** Uniform real in [min, max). */
  float(min: number, max: number): number;
  /** Uniform choice from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /**
   * A draw around `mean` with +/- `spreadRatio` variation, floored at 1ms. Used for ring
   * and conversation durations, where a fixed duration would make a simulation look fake
   * and would hide ordering bugs that only appear when events interleave.
   */
  durationAround(meanMs: number, spreadRatio?: number): number;
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG. Six lines is not worth a
 * dependency, and having the algorithm visible here means the reproducibility guarantee is
 * auditable rather than delegated.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a. Mixes a stream name into the root seed so each stream starts independently. */
function hashStreamName(rootSeed: number, name: string): number {
  let hash = 0x811c9dc5 ^ (rootSeed >>> 0);
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) return minInclusive;
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive));
    },
    bool(probability: number): boolean {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return next() < probability;
    },
    float(min: number, max: number): number {
      return min + next() * (max - min);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('Rng.pick requires a non-empty array');
      return items[Math.floor(next() * items.length)] as T;
    },
    durationAround(meanMs: number, spreadRatio = 0.4): number {
      const spread = meanMs * Math.min(Math.max(spreadRatio, 0), 1);
      const value = meanMs - spread + next() * spread * 2;
      return Math.max(1, Math.round(value));
    },
  };
}

/**
 * Root of a run's randomness. One of these per simulation run; every consumer asks it for
 * its own named stream.
 */
export class SeededRandom {
  readonly #rootSeed: number;
  readonly #streams = new Map<string, Rng>();

  constructor(rootSeed: number) {
    if (!Number.isInteger(rootSeed)) {
      throw new TypeError(`Seed must be an integer, got ${rootSeed}`);
    }
    this.#rootSeed = rootSeed >>> 0;
  }

  get seed(): number {
    return this.#rootSeed;
  }

  /**
   * The stream for `name`, created on first use and memoised thereafter — so repeated
   * lookups continue one sequence rather than restarting it.
   */
  stream(name: string): Rng {
    const existing = this.#streams.get(name);
    if (existing !== undefined) return existing;
    const created = createRng(hashStreamName(this.#rootSeed, name));
    this.#streams.set(name, created);
    return created;
  }

  /** Stream names drawn from so far. Useful when diagnosing a determinism failure. */
  activeStreams(): readonly string[] {
    return [...this.#streams.keys()].sort();
  }
}

/**
 * Canonical stream names. Centralised because they are part of the reproducibility
 * contract (D-004) — a typo would silently create a second, differently-seeded stream
 * rather than failing.
 */
export const RNG_STREAMS = {
  providerOutcome: 'provider.outcome',
  providerRingDuration: 'provider.ringDuration',
  providerCallDuration: 'provider.callDuration',
  providerLatency: 'provider.latency',
  providerFaultInjection: 'provider.faultInjection',
  retryJitter: 'retry.jitter',
  agentHandleTime: 'agent.handleTime',
  agentBehaviour: 'agent.behaviour',
  seedData: 'seed.data',
} as const;

export type RngStreamName = (typeof RNG_STREAMS)[keyof typeof RNG_STREAMS];
