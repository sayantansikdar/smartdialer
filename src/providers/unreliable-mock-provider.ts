/**
 * A mock carrier that misbehaves the way real ones do.
 *
 * The difference from `MockTelecomProvider` is not just worse numbers — it is *correlated*
 * failure. Real carriers do not fail independently per call at a fixed rate; they have bad
 * minutes. Latency climbs, a region drops, everything fails at once, and then it recovers.
 * A dialer that copes with 2% of calls failing at random can still fall over completely
 * when 100% of calls fail for thirty seconds, because that is when queues back up, slots
 * are held, and retries all come due together.
 *
 * So this provider drifts: it periodically re-rolls its own "weather", entering and leaving
 * outage windows and scaling its latency. Defaults match the failure profile in the brief
 * (5% timeout, 10% busy, 15% no-answer, 2% provider error).
 *
 * Implementation note: the weather is re-rolled lazily, when a call is placed, rather than
 * on a repeating timer. A perpetually self-rescheduling timer would mean the clock is never
 * idle, and the fast driver — which stops when nothing is scheduled — would never terminate
 * a simulation.
 */

import { RNG_STREAMS } from '../core/rng.ts';
import {
  DEFAULT_MOCK_CONFIG,
  MockTelecomProvider,
  type MockProviderConfig,
  type MockProviderOptions,
} from './mock-provider.ts';
import type { ProviderCallHandle, ProviderCallRequest } from './telecom-provider.ts';

export const DEFAULT_UNRELIABLE_CONFIG: MockProviderConfig = {
  ...DEFAULT_MOCK_CONFIG,
  answerRate: 0.68,
  noAnswerRate: 0.15,
  busyRate: 0.1,
  failureRate: 0.05,
  timeoutRate: 0.05,
  stuckRingingRate: 0.01,
  errorRate: 0.02,
  invalidNumberRate: 0.01,
};

export interface UnreliableBehaviourConfig {
  /** How often (virtual ms) the provider re-rolls its own weather. */
  readonly weatherIntervalMs: number;
  /** Chance of entering an outage at a weather check while healthy. */
  readonly outageChance: number;
  /** Chance of recovering at a weather check while in an outage. */
  readonly recoveryChance: number;
  /** Multiplier range applied to accept latency while degraded. */
  readonly maxLatencyMultiplier: number;
}

export const DEFAULT_UNRELIABLE_BEHAVIOUR: UnreliableBehaviourConfig = {
  weatherIntervalMs: 15_000,
  outageChance: 0.05,
  recoveryChance: 0.5,
  maxLatencyMultiplier: 6,
};

export interface UnreliableMockProviderOptions extends MockProviderOptions {
  readonly behaviour?: Partial<UnreliableBehaviourConfig>;
}

export class UnreliableMockTelecomProvider extends MockTelecomProvider {
  override readonly driver: string = 'unreliable-mock';

  #behaviour: UnreliableBehaviourConfig;
  #nextWeatherCheckAt = 0;
  #latencyMultiplier = 1;
  #outageEnteredAt: number | null = null;
  #outageCount = 0;

  constructor(options: UnreliableMockProviderOptions) {
    super({
      ...options,
      config: { ...DEFAULT_UNRELIABLE_CONFIG, ...options.config },
    });
    this.#behaviour = { ...DEFAULT_UNRELIABLE_BEHAVIOUR, ...options.behaviour };
  }

  getBehaviour(): UnreliableBehaviourConfig {
    return this.#behaviour;
  }

  updateBehaviour(patch: Partial<UnreliableBehaviourConfig>): UnreliableBehaviourConfig {
    this.#behaviour = { ...this.#behaviour, ...patch };
    return this.#behaviour;
  }

  /** Outages entered so far. Surfaced in the provider view and simulation reports. */
  get outageCount(): number {
    return this.#outageCount;
  }

  get outageEnteredAt(): number | null {
    return this.#outageEnteredAt;
  }

  override createCall(request: ProviderCallRequest): Promise<ProviderCallHandle> {
    this.#rollWeather();
    return super.createCall(request);
  }

  /**
   * Re-roll the provider's condition if enough virtual time has passed.
   *
   * Deliberately deterministic: the decision depends only on elapsed virtual time and the
   * seeded fault stream, so an outage that broke a run reappears at the same moment when
   * the run is replayed — which is what makes a failure reproducible enough to debug.
   */
  #rollWeather(): void {
    const now = this.clock.now();
    if (now < this.#nextWeatherCheckAt) return;
    this.#nextWeatherCheckAt = now + this.#behaviour.weatherIntervalMs;

    const faults = this.rng(RNG_STREAMS.providerFaultInjection);

    if (this.config.outageActive) {
      if (faults.bool(this.#behaviour.recoveryChance)) {
        this.updateConfig({ outageActive: false, latencySpikeMs: 0 });
        this.#outageEnteredAt = null;
        this.#latencyMultiplier = 1;
      }
      return;
    }

    if (faults.bool(this.#behaviour.outageChance)) {
      this.updateConfig({ outageActive: true });
      this.#outageEnteredAt = now;
      this.#outageCount += 1;
      return;
    }

    // Not an outage — but latency still drifts, which is the more insidious failure: the
    // dialer keeps working while every call takes longer, quietly holding slots.
    this.#latencyMultiplier = faults.float(1, this.#behaviour.maxLatencyMultiplier);
    const baseLatency = DEFAULT_UNRELIABLE_CONFIG.meanAcceptLatencyMs;
    this.updateConfig({
      latencySpikeMs: Math.round(baseLatency * (this.#latencyMultiplier - 1)),
    });
  }

  override reset(): void {
    super.reset();
    this.#nextWeatherCheckAt = 0;
    this.#latencyMultiplier = 1;
    this.#outageEnteredAt = null;
    this.#outageCount = 0;
  }
}
