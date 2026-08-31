/**
 * A mock carrier that behaves like a carrier: asynchronously, over time, and with outcomes
 * it decides itself.
 *
 * Everything it does is scheduled on the injected `Clock` and drawn from seeded RNG
 * streams, so a whole campaign replays identically from a seed and a ten-minute call
 * completes in microseconds under the fast driver.
 *
 * The behaviour that matters most for correctness is the one that looks like a bug: this
 * provider can be configured to accept a call and then **never send a terminal event at
 * all** (`timeoutRate`, `stuckRingingRate`). That is the failure mode that strands
 * concurrency slots and agents in a real dialer, and the engine's timeout watchdog is only
 * genuinely tested if something can actually go silent on it.
 */

import type { Clock, TimerHandle } from '../core/clock.ts';
import { ERROR_CODES, ProviderCallError } from '../core/errors.ts';
import { RNG_STREAMS, type Rng, type SeededRandom } from '../core/rng.ts';
import type {
  ProviderCallHandle,
  ProviderCallRequest,
  ProviderCallState,
  ProviderCallStatus,
  ProviderEvent,
  ProviderEventHandler,
  ProviderEventType,
  ProviderMetrics,
  ProviderUnsubscribe,
  TelecomProvider,
} from './telecom-provider.ts';

export interface MockProviderConfig {
  /**
   * Outcome distribution. These are normalised, so they do not have to sum to 1 — which
   * matters because the failure-injection UI changes one slider at a time and a config that
   * had to sum exactly would be unusable.
   */
  readonly answerRate: number;
  readonly noAnswerRate: number;
  readonly busyRate: number;
  readonly failureRate: number;

  /** Chance the provider accepts a call and then never reports a terminal outcome. */
  readonly timeoutRate: number;
  /** Chance the provider rings forever — accepted, rings, then silence. */
  readonly stuckRingingRate: number;
  /** Chance `createCall` itself is rejected with a transient provider error. */
  readonly errorRate: number;
  /** Chance the destination is rejected as permanently invalid (never retried). */
  readonly invalidNumberRate: number;

  readonly meanAcceptLatencyMs: number;
  readonly meanDialingDelayMs: number;
  readonly meanRingDurationMs: number;
  readonly meanCallDurationMs: number;
  /** Added to accept latency while a latency spike is injected. */
  readonly latencySpikeMs: number;

  readonly maxConcurrentCalls: number;
  /** While true every `createCall` is rejected with a transient outage error. */
  readonly outageActive: boolean;
}

export const DEFAULT_MOCK_CONFIG: MockProviderConfig = {
  answerRate: 0.65,
  noAnswerRate: 0.2,
  busyRate: 0.1,
  failureRate: 0.05,
  timeoutRate: 0,
  stuckRingingRate: 0,
  errorRate: 0,
  invalidNumberRate: 0,
  meanAcceptLatencyMs: 40,
  meanDialingDelayMs: 100,
  meanRingDurationMs: 4000,
  meanCallDurationMs: 25_000,
  latencySpikeMs: 0,
  maxConcurrentCalls: 40,
  outageActive: false,
};

type Outcome = 'ANSWERED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'SILENT' | 'STUCK_RINGING';

interface ActiveCall {
  readonly providerCallId: string;
  readonly callId: string;
  state: ProviderCallState;
  since: number;
  readonly timers: TimerHandle[];
}

export interface MockProviderOptions {
  readonly id: string;
  readonly clock: Clock;
  readonly random: SeededRandom;
  readonly config?: Partial<MockProviderConfig>;
}

export class MockTelecomProvider implements TelecomProvider {
  readonly id: string;
  readonly driver: string = 'mock';

  protected readonly clock: Clock;
  protected readonly random: SeededRandom;
  protected config: MockProviderConfig;

  readonly #handlers = new Set<ProviderEventHandler>();
  readonly #active = new Map<string, ActiveCall>();
  #sequence = 0;

  #requests = 0;
  #accepted = 0;
  #rejected = 0;
  #completed = 0;
  #failed = 0;
  #silent = 0;
  #totalResponseMs = 0;

  constructor(options: MockProviderOptions) {
    this.id = options.id;
    this.clock = options.clock;
    this.random = options.random;
    this.config = { ...DEFAULT_MOCK_CONFIG, ...options.config };
  }

  getConfig(): MockProviderConfig {
    return this.config;
  }

  /**
   * Change behaviour at runtime. This is what makes the dashboard's failure-injection
   * controls real: a change here takes effect on the next call the engine places
   * (CONSTRAINTS.md §5 — no faked controls).
   */
  updateConfig(patch: Partial<MockProviderConfig>): MockProviderConfig {
    this.config = { ...this.config, ...patch };
    return this.config;
  }

  protected rng(stream: string): Rng {
    return this.random.stream(stream);
  }

  async createCall(request: ProviderCallRequest): Promise<ProviderCallHandle> {
    this.#requests += 1;
    const startedAt = this.clock.now();

    // Rejections are decided before any latency is simulated, in a fixed order, so the
    // reason a call was refused is deterministic for a given seed.
    if (this.config.outageActive) {
      this.#rejected += 1;
      throw new ProviderCallError(ERROR_CODES.PROVIDER_OUTAGE, `Provider ${this.id} is in an outage`, {
        transient: true,
        metadata: { providerId: this.id, callId: request.callId },
      });
    }

    if (this.#active.size >= this.config.maxConcurrentCalls) {
      this.#rejected += 1;
      throw new ProviderCallError(
        ERROR_CODES.PROVIDER_CONCURRENCY_LIMIT,
        `Provider ${this.id} is at capacity (${this.config.maxConcurrentCalls})`,
        {
          transient: true,
          metadata: { providerId: this.id, active: this.#active.size },
        },
      );
    }

    if (this.rng(RNG_STREAMS.providerFaultInjection).bool(this.config.invalidNumberRate)) {
      this.#rejected += 1;
      // Permanent: retrying an unroutable number burns attempts for nothing.
      throw new ProviderCallError(ERROR_CODES.INVALID_PHONE_NUMBER, 'Destination is not routable', {
        transient: false,
        metadata: { providerId: this.id, callId: request.callId },
      });
    }

    if (this.rng(RNG_STREAMS.providerFaultInjection).bool(this.config.errorRate)) {
      this.#rejected += 1;
      throw new ProviderCallError(ERROR_CODES.PROVIDER_ERROR, 'Provider rejected the request', {
        transient: true,
        metadata: { providerId: this.id, callId: request.callId },
      });
    }

    // A real API call takes time to be accepted. Awaiting a clock timer (rather than
    // resolving immediately) means the engine is genuinely asynchronous here, which is what
    // gives the concurrency tests something real to interleave.
    const latency =
      this.rng(RNG_STREAMS.providerLatency).durationAround(
        Math.max(1, this.config.meanAcceptLatencyMs),
      ) + this.config.latencySpikeMs;
    await this.#sleep(latency);

    const providerCallId = `${this.id}-call-${++this.#sequence}`;
    const call: ActiveCall = {
      providerCallId,
      callId: request.callId,
      state: 'ACCEPTED',
      since: this.clock.now(),
      timers: [],
    };
    this.#active.set(providerCallId, call);

    this.#accepted += 1;
    this.#totalResponseMs += this.clock.now() - startedAt;

    this.scheduleLifecycle(call);
    return { providerCallId, acceptedAt: call.since };
  }

  /**
   * Lay out the whole call lifecycle on the clock up front.
   *
   * Scheduling everything at accept time — rather than chaining each step from the previous
   * one — keeps the timer ordering a pure function of the draws made at this instant, so
   * two runs with the same seed produce byte-identical event streams. `protected` so the
   * unreliable variant can add correlated faults on top.
   */
  protected scheduleLifecycle(call: ActiveCall): void {
    const outcome = this.chooseOutcome();
    const dialingDelay = this.rng(RNG_STREAMS.providerLatency).durationAround(
      Math.max(1, this.config.meanDialingDelayMs),
    );
    const ringDuration = this.rng(RNG_STREAMS.providerRingDuration).durationAround(
      Math.max(1, this.config.meanRingDurationMs),
    );

    // A call that will go silent still emits the events leading up to the silence — that is
    // precisely what makes it indistinguishable from a healthy call until the watchdog
    // fires, and therefore a real test of the watchdog.
    this.#scheduleEmit(call, dialingDelay, 'call.dialing', 'DIALING');

    if (outcome === 'SILENT') {
      this.#silent += 1;
      return;
    }

    const ringAt = dialingDelay + 1;
    this.#scheduleEmit(call, ringAt, 'call.ringing', 'RINGING');

    if (outcome === 'STUCK_RINGING') {
      this.#silent += 1;
      return;
    }

    const outcomeAt = ringAt + ringDuration;
    if (outcome === 'ANSWERED') {
      this.#scheduleEmit(call, outcomeAt, 'call.answered', 'ANSWERED');
      const talkDuration = this.rng(RNG_STREAMS.providerCallDuration).durationAround(
        Math.max(1, this.config.meanCallDurationMs),
      );
      this.#scheduleEmit(call, outcomeAt + talkDuration, 'call.completed', 'COMPLETED', {
        talkDurationMs: talkDuration,
      });
      return;
    }

    const failureEvent: ProviderEventType =
      outcome === 'NO_ANSWER' ? 'call.no_answer' : outcome === 'BUSY' ? 'call.busy' : 'call.failed';
    const code =
      outcome === 'NO_ANSWER'
        ? undefined
        : outcome === 'BUSY'
          ? undefined
          : ERROR_CODES.PROVIDER_ERROR;

    this.#scheduleEmit(call, outcomeAt, failureEvent, 'FAILED', undefined, code, true);
  }

  /**
   * Pick an outcome. Silence and stuck-ringing are drawn first and independently of the
   * outcome distribution, so turning up `timeoutRate` in the UI does not silently distort
   * the answer/busy/no-answer mix an operator is also looking at.
   */
  protected chooseOutcome(): Outcome {
    const faults = this.rng(RNG_STREAMS.providerFaultInjection);
    if (faults.bool(this.config.timeoutRate)) return 'SILENT';
    if (faults.bool(this.config.stuckRingingRate)) return 'STUCK_RINGING';

    const { answerRate, noAnswerRate, busyRate, failureRate } = this.config;
    const total = answerRate + noAnswerRate + busyRate + failureRate;
    if (total <= 0) return 'NO_ANSWER';

    const roll = this.rng(RNG_STREAMS.providerOutcome).next() * total;
    if (roll < answerRate) return 'ANSWERED';
    if (roll < answerRate + noAnswerRate) return 'NO_ANSWER';
    if (roll < answerRate + noAnswerRate + busyRate) return 'BUSY';
    return 'FAILED';
  }

  #scheduleEmit(
    call: ActiveCall,
    delayMs: number,
    type: ProviderEventType,
    state: ProviderCallState,
    metadata?: Record<string, unknown>,
    code?: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    transient?: boolean,
  ): void {
    const handle = this.clock.setTimer(
      delayMs,
      () => {
        // A cancelled call may still have timers queued; dropping them here is what makes
        // cancellation actually stop the call rather than merely mark it.
        if (!this.#active.has(call.providerCallId)) return;

        call.state = state;
        call.since = this.clock.now();

        if (state === 'COMPLETED') this.#completed += 1;
        if (state === 'FAILED') this.#failed += 1;
        if (state === 'COMPLETED' || state === 'FAILED') {
          this.#active.delete(call.providerCallId);
        }

        this.#emit({
          type,
          providerCallId: call.providerCallId,
          callId: call.callId,
          at: this.clock.now(),
          code,
          transient,
          metadata,
        });
      },
      `${this.id}:${type}:${call.providerCallId}`,
    );
    call.timers.push(handle);
  }

  #emit(event: ProviderEvent): void {
    for (const handler of [...this.#handlers]) handler(event);
  }

  #sleep(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clock.setTimer(delayMs, resolve, `${this.id}:accept-latency`);
    });
  }

  cancelCall(providerCallId: string): Promise<void> {
    const call = this.#active.get(providerCallId);
    if (call === undefined) return Promise.resolve();

    for (const timer of call.timers) this.clock.clearTimer(timer);
    call.state = 'CANCELLED';
    this.#active.delete(providerCallId);
    return Promise.resolve();
  }

  getCallStatus(providerCallId: string): Promise<ProviderCallStatus> {
    const call = this.#active.get(providerCallId);
    if (call === undefined) {
      return Promise.resolve({ providerCallId, state: 'UNKNOWN', since: this.clock.now() });
    }
    return Promise.resolve({ providerCallId, state: call.state, since: call.since });
  }

  onEvent(handler: ProviderEventHandler): ProviderUnsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  activeCallCount(): number {
    return this.#active.size;
  }

  metrics(): ProviderMetrics {
    return {
      requests: this.#requests,
      accepted: this.#accepted,
      rejected: this.#rejected,
      completed: this.#completed,
      failed: this.#failed,
      silent: this.#silent,
      averageResponseTimeMs:
        this.#accepted === 0 ? 0 : Math.round(this.#totalResponseMs / this.#accepted),
      activeCalls: this.#active.size,
      outageActive: this.config.outageActive,
    };
  }

  reset(): void {
    for (const call of this.#active.values()) {
      for (const timer of call.timers) this.clock.clearTimer(timer);
    }
    this.#active.clear();
    this.#handlers.clear();
    this.#requests = 0;
    this.#accepted = 0;
    this.#rejected = 0;
    this.#completed = 0;
    this.#failed = 0;
    this.#silent = 0;
    this.#totalResponseMs = 0;
    this.#sequence = 0;
  }
}
