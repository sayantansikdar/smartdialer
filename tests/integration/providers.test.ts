import { describe, expect, it } from 'vitest';
import { ProviderCallError } from '../../src/core/errors.ts';
import { SeededRandom } from '../../src/core/rng.ts';
import { MockTelecomProvider, type MockProviderConfig } from '../../src/providers/mock-provider.ts';
import { createProvider, ProviderRegistry } from '../../src/providers/registry.ts';
import type { ProviderEvent } from '../../src/providers/telecom-provider.ts';
import { UnreliableMockTelecomProvider } from '../../src/providers/unreliable-mock-provider.ts';
import { createTestRuntime, type TestRuntime } from '../helpers/runtime.ts';
import { fictionalPhoneNumber } from '../helpers/db.ts';

interface Harness {
  readonly runtime: TestRuntime;
  readonly provider: MockTelecomProvider;
  readonly events: ProviderEvent[];
}

function harness(config: Partial<MockProviderConfig> = {}, seed = 12_345): Harness {
  const runtime = createTestRuntime(seed);
  const provider = new MockTelecomProvider({
    id: 'mock-1',
    clock: runtime.clock,
    random: runtime.random,
    config,
  });
  const events: ProviderEvent[] = [];
  provider.onEvent((event) => events.push(event));
  return { runtime, provider, events };
}

const request = (callId = 'call_1') => ({
  callId,
  campaignId: 'camp_1',
  phoneNumber: fictionalPhoneNumber(1),
});

/** Deterministic single-outcome configs, so a test asserts one behaviour at a time. */
const ALWAYS_ANSWER: Partial<MockProviderConfig> = {
  answerRate: 1,
  noAnswerRate: 0,
  busyRate: 0,
  failureRate: 0,
};
const ALWAYS_BUSY: Partial<MockProviderConfig> = {
  answerRate: 0,
  noAnswerRate: 0,
  busyRate: 1,
  failureRate: 0,
};

describe('MockTelecomProvider — accepting calls', () => {
  it('returns a handle rather than an outcome', async () => {
    // The core of the abstraction: a carrier accepts a request, it does not tell you what
    // happened. Anything else would let the engine be written against a fantasy.
    const { runtime, provider } = harness(ALWAYS_ANSWER);

    const pending = provider.createCall(request());
    await runtime.drain();
    const handle = await pending;

    expect(handle.providerCallId).toMatch(/^mock-1-call-\d+$/);
    expect(handle.acceptedAt).toBeGreaterThan(0);
  });

  it('takes time to accept, so the engine is genuinely asynchronous here', async () => {
    const { runtime, provider } = harness({ ...ALWAYS_ANSWER, meanAcceptLatencyMs: 500 });

    let resolved = false;
    const pending = provider.createCall(request()).then((handle) => {
      resolved = true;
      return handle;
    });

    // Nothing has advanced the clock yet, so the accept cannot have completed.
    await Promise.resolve();
    expect(resolved).toBe(false);

    await runtime.drain();
    await pending;
    expect(resolved).toBe(true);
  });
});

describe('MockTelecomProvider — call lifecycle', () => {
  it('progresses through dialing, ringing, answered and completed', async () => {
    const { runtime, provider, events } = harness(ALWAYS_ANSWER);

    void provider.createCall(request());
    await runtime.drain();

    expect(events.map((e) => e.type)).toEqual([
      'call.dialing',
      'call.ringing',
      'call.answered',
      'call.completed',
    ]);
  });

  it('emits events in ascending virtual time, with real gaps between them', async () => {
    const { runtime, provider, events } = harness({
      ...ALWAYS_ANSWER,
      meanRingDurationMs: 4000,
      meanCallDurationMs: 20_000,
    });

    void provider.createCall(request());
    await runtime.drain();

    const times = events.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // The conversation must actually take time, or nothing downstream that depends on call
    // duration (agent occupancy, handle time, abandon windows) is being exercised.
    const answered = events.find((e) => e.type === 'call.answered')?.at ?? 0;
    const completed = events.find((e) => e.type === 'call.completed')?.at ?? 0;
    expect(completed - answered).toBeGreaterThan(10_000);
  });

  it('reports talk duration on completion', async () => {
    const { runtime, provider, events } = harness(ALWAYS_ANSWER);
    void provider.createCall(request());
    await runtime.drain();

    const completed = events.find((e) => e.type === 'call.completed');
    expect(completed?.metadata?.['talkDurationMs']).toBeGreaterThan(0);
  });

  it('ends a busy call at ringing, with no answer or completion', async () => {
    const { runtime, provider, events } = harness(ALWAYS_BUSY);
    void provider.createCall(request());
    await runtime.drain();

    expect(events.map((e) => e.type)).toEqual(['call.dialing', 'call.ringing', 'call.busy']);
  });

  it('marks call failures transient', async () => {
    const { runtime, provider, events } = harness({
      answerRate: 0,
      noAnswerRate: 0,
      busyRate: 0,
      failureRate: 1,
    });
    void provider.createCall(request());
    await runtime.drain();

    const failure = events.find((e) => e.type === 'call.failed');
    expect(failure?.transient).toBe(true);
    expect(failure?.code).toBe('PROVIDER_ERROR');
  });

  it('echoes our call id on every event so the engine can correlate', async () => {
    const { runtime, provider, events } = harness(ALWAYS_ANSWER);
    void provider.createCall(request('call_abc'));
    await runtime.drain();

    expect(events.every((e) => e.callId === 'call_abc')).toBe(true);
  });

  it('runs several calls concurrently without mixing them up', async () => {
    const { runtime, provider, events } = harness(ALWAYS_ANSWER);

    void provider.createCall(request('call_1'));
    void provider.createCall(request('call_2'));
    void provider.createCall(request('call_3'));
    await runtime.drain();

    for (const callId of ['call_1', 'call_2', 'call_3']) {
      const forCall = events.filter((e) => e.callId === callId);
      expect(forCall.map((e) => e.type), callId).toEqual([
        'call.dialing',
        'call.ringing',
        'call.answered',
        'call.completed',
      ]);
      expect(new Set(forCall.map((e) => e.providerCallId)).size, callId).toBe(1);
    }
  });
});

describe('MockTelecomProvider — going silent', () => {
  it('accepts a call and then never reports a terminal outcome', async () => {
    // The failure that strands slots and agents in a real dialer. If nothing here could go
    // silent, the engine's timeout watchdog would never actually be tested.
    const { runtime, provider, events } = harness({ ...ALWAYS_ANSWER, timeoutRate: 1 });

    const handle = provider.createCall(request());
    await runtime.drain();
    await handle;

    expect(events.map((e) => e.type)).toEqual(['call.dialing']);
    expect(provider.metrics().silent).toBe(1);
    // Crucially the clock is now idle: nothing further will ever arrive on its own.
    expect(runtime.clock.pendingCount).toBe(0);
  });

  it('can ring forever', async () => {
    const { runtime, provider, events } = harness({ ...ALWAYS_ANSWER, stuckRingingRate: 1 });

    void provider.createCall(request());
    await runtime.drain();

    expect(events.map((e) => e.type)).toEqual(['call.dialing', 'call.ringing']);
    expect(runtime.clock.pendingCount).toBe(0);
  });

  it('keeps a silent call occupying provider capacity', async () => {
    // Which is exactly why the watchdog must exist: the provider will not free it.
    const { runtime, provider } = harness({ ...ALWAYS_ANSWER, timeoutRate: 1 });
    void provider.createCall(request());
    await runtime.drain();

    expect(provider.activeCallCount()).toBe(1);
  });
});

describe('MockTelecomProvider — rejections', () => {
  const expectRejection = async (
    config: Partial<MockProviderConfig>,
    expected: { code: string; transient: boolean },
  ): Promise<void> => {
    const { runtime, provider } = harness(config);

    // Capture the rejection in the same turn the promise is created. These rejections are
    // synchronous, so draining the clock first would leave the promise unhandled for a tick
    // and Node would report an unhandled rejection.
    const settled = provider.createCall(request()).then(
      () => null,
      (error: unknown) => error as ProviderCallError,
    );
    await runtime.drain();

    const error = await settled;
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error?.code).toBe(expected.code);
    expect(error?.transient).toBe(expected.transient);
  };

  it('rejects transiently during an outage', async () => {
    await expectRejection({ outageActive: true }, { code: 'PROVIDER_OUTAGE', transient: true });
  });

  it('rejects transiently on a provider error', async () => {
    await expectRejection({ errorRate: 1 }, { code: 'PROVIDER_ERROR', transient: true });
  });

  it('rejects an invalid number permanently, so it is never retried', async () => {
    // Retrying an unroutable number burns attempts on a contact that can never be reached.
    await expectRejection(
      { invalidNumberRate: 1 },
      { code: 'INVALID_PHONE_NUMBER', transient: false },
    );
  });

  it('rejects transiently at provider capacity', async () => {
    const { runtime, provider } = harness({ ...ALWAYS_ANSWER, maxConcurrentCalls: 2 });

    void provider.createCall(request('call_1'));
    void provider.createCall(request('call_2'));
    await runtime.drain({ untilVirtualMs: 200 });

    const third = provider.createCall(request('call_3'));
    await expect(third).rejects.toThrow(/at capacity/);
  });

  it('does not schedule any lifecycle for a rejected call', async () => {
    const { runtime, provider, events } = harness({ errorRate: 1 });
    await provider.createCall(request()).catch(() => undefined);
    await runtime.drain();

    expect(events).toEqual([]);
    expect(provider.activeCallCount()).toBe(0);
  });
});

describe('MockTelecomProvider — cancellation', () => {
  it('stops all further events', async () => {
    const { runtime, provider, events } = harness(ALWAYS_ANSWER);

    const handle = await (async () => {
      const pending = provider.createCall(request());
      await runtime.drain({ untilVirtualMs: 100 });
      return pending;
    })();

    await provider.cancelCall(handle.providerCallId);
    await runtime.drain();

    expect(events.some((e) => e.type === 'call.answered')).toBe(false);
    expect(provider.activeCallCount()).toBe(0);
  });

  it('is idempotent and safe for an unknown call', async () => {
    const { provider } = harness();
    await expect(provider.cancelCall('nope')).resolves.toBeUndefined();
    await expect(provider.cancelCall('nope')).resolves.toBeUndefined();
  });
});

describe('MockTelecomProvider — status and metrics', () => {
  it('reports call status, and UNKNOWN once a call has finished', async () => {
    const { runtime, provider } = harness(ALWAYS_ANSWER);
    const pending = provider.createCall(request());
    await runtime.drain({ untilVirtualMs: 200 });
    const handle = await pending;

    expect((await provider.getCallStatus(handle.providerCallId)).state).not.toBe('UNKNOWN');

    await runtime.drain();
    expect((await provider.getCallStatus(handle.providerCallId)).state).toBe('UNKNOWN');
  });

  it('accumulates request, acceptance and outcome metrics', async () => {
    const { runtime, provider } = harness(ALWAYS_ANSWER);
    void provider.createCall(request('call_1'));
    void provider.createCall(request('call_2'));
    await runtime.drain();

    const metrics = provider.metrics();
    expect(metrics.requests).toBe(2);
    expect(metrics.accepted).toBe(2);
    expect(metrics.rejected).toBe(0);
    expect(metrics.completed).toBe(2);
    expect(metrics.averageResponseTimeMs).toBeGreaterThan(0);
    expect(metrics.activeCalls).toBe(0);
  });

  it('counts rejections separately from failures', async () => {
    const { runtime, provider } = harness({ errorRate: 1 });
    await provider.createCall(request()).catch(() => undefined);
    await runtime.drain();

    expect(provider.metrics().rejected).toBe(1);
    expect(provider.metrics().accepted).toBe(0);
    expect(provider.metrics().failed).toBe(0);
  });

  it('reset clears state and timers', async () => {
    const { runtime, provider } = harness(ALWAYS_ANSWER);
    void provider.createCall(request());
    await runtime.drain({ untilVirtualMs: 150 });

    provider.reset();
    expect(provider.activeCallCount()).toBe(0);
    expect(provider.metrics().requests).toBe(0);
  });
});

describe('MockTelecomProvider — determinism', () => {
  it('replays identically from the same seed', async () => {
    // The property the entire simulation story rests on (DECISIONS.md D-003/D-004).
    const run = async (seed: number): Promise<string> => {
      const { runtime, provider, events } = harness({}, seed);
      for (let i = 0; i < 25; i += 1) void provider.createCall(request(`call_${i}`));
      await runtime.drain();
      return events.map((e) => `${e.at}:${e.type}:${e.callId}`).join('|');
    };

    expect(await run(4242)).toBe(await run(4242));
  });

  it('produces a different run for a different seed', async () => {
    const run = async (seed: number): Promise<string> => {
      const { runtime, provider, events } = harness({}, seed);
      for (let i = 0; i < 25; i += 1) void provider.createCall(request(`call_${i}`));
      await runtime.drain();
      return events.map((e) => `${e.at}:${e.type}`).join('|');
    };

    expect(await run(1)).not.toBe(await run(2));
  });

  it('honours the configured outcome distribution', async () => {
    const { runtime, provider, events } = harness({
      answerRate: 0.7,
      noAnswerRate: 0.2,
      busyRate: 0.1,
      failureRate: 0,
      meanCallDurationMs: 100,
    });

    const total = 400;
    for (let i = 0; i < total; i += 1) void provider.createCall(request(`call_${i}`));
    await runtime.drain();

    const answered = events.filter((e) => e.type === 'call.answered').length;
    expect(answered / total).toBeGreaterThan(0.6);
    expect(answered / total).toBeLessThan(0.8);
  });

  it('normalises a distribution that does not sum to one', async () => {
    // The failure-injection UI moves one slider at a time; a config that had to sum exactly
    // would be unusable.
    const { runtime, provider, events } = harness({
      answerRate: 3,
      noAnswerRate: 1,
      busyRate: 0,
      failureRate: 0,
      meanCallDurationMs: 100,
    });

    for (let i = 0; i < 200; i += 1) void provider.createCall(request(`call_${i}`));
    await runtime.drain();

    const answered = events.filter((e) => e.type === 'call.answered').length;
    expect(answered).toBeGreaterThan(120);
    expect(answered).toBeLessThan(180);
  });
});

describe('UnreliableMockTelecomProvider', () => {
  const unreliable = (
    behaviour: Partial<ConstructorParameters<typeof UnreliableMockTelecomProvider>[0]['behaviour']> = {},
    seed = 777,
  ) => {
    const runtime = createTestRuntime(seed);
    const provider = new UnreliableMockTelecomProvider({
      id: 'flaky',
      clock: runtime.clock,
      random: runtime.random,
      behaviour: { ...behaviour },
    });
    return { runtime, provider };
  };

  it('defaults to the failure profile from the specification', () => {
    const { provider } = unreliable();
    const config = provider.getConfig();
    expect(config.timeoutRate).toBe(0.05);
    expect(config.busyRate).toBe(0.1);
    expect(config.noAnswerRate).toBe(0.15);
    expect(config.errorRate).toBe(0.02);
  });

  it('enters correlated outages rather than failing independently', async () => {
    // Real carriers have bad minutes, and a dialer that survives 2% random failure can
    // still collapse when everything fails at once.
    const { runtime, provider } = unreliable({ outageChance: 1, weatherIntervalMs: 1000 });

    await expect(provider.createCall(request('call_1'))).rejects.toThrow(/outage/);
    expect(provider.outageCount).toBe(1);
    expect(provider.getConfig().outageActive).toBe(true);
    expect(provider.outageEnteredAt).not.toBeNull();
    await runtime.drain();
  });

  it('recovers from an outage at a later weather check', async () => {
    const { runtime, provider } = unreliable({
      outageChance: 1,
      recoveryChance: 1,
      weatherIntervalMs: 1000,
    });

    await expect(provider.createCall(request('call_1'))).rejects.toThrow(/outage/);

    runtime.clock.advanceBy(2000);
    void provider.createCall(request('call_2')).catch(() => undefined);
    expect(provider.getConfig().outageActive).toBe(false);
    await runtime.drain();
  });

  it('drifts latency while healthy', async () => {
    const { runtime, provider } = unreliable({
      outageChance: 0,
      weatherIntervalMs: 1000,
      maxLatencyMultiplier: 10,
    });

    void provider.createCall(request('call_1'));
    await runtime.drain({ untilVirtualMs: 5000 });
    expect(provider.getConfig().latencySpikeMs).toBeGreaterThan(0);
  });

  it('does not schedule perpetual timers, so a simulation can still finish', async () => {
    // The weather is re-rolled lazily on createCall. A repeating timer would mean the clock
    // is never idle and the fast driver would never terminate a run.
    const { runtime, provider } = unreliable({ outageChance: 0 });

    void provider.createCall(request('call_1'));
    await runtime.drain();

    expect(runtime.clock.pendingCount).toBe(0);
  });

  it('replays identically from the same seed, outages included', async () => {
    const run = async (seed: number): Promise<string> => {
      const runtime = createTestRuntime(seed);
      const provider = new UnreliableMockTelecomProvider({
        id: 'flaky',
        clock: runtime.clock,
        random: runtime.random,
      });
      const events: ProviderEvent[] = [];
      provider.onEvent((event) => events.push(event));

      for (let i = 0; i < 40; i += 1) {
        void provider.createCall(request(`call_${i}`)).catch(() => undefined);
        runtime.clock.advanceBy(500);
      }
      await runtime.drain();
      return `${provider.outageCount}|${events.map((e) => `${e.at}:${e.type}`).join(',')}`;
    };

    expect(await run(31_337)).toBe(await run(31_337));
  });
});

describe('ProviderRegistry', () => {
  it('creates both mock drivers and nothing else', () => {
    const runtime = createTestRuntime();
    const random = new SeededRandom(1);

    const mock = createProvider({ id: 'a', driver: 'mock', clock: runtime.clock, random });
    const flaky = createProvider({
      id: 'b',
      driver: 'unreliable-mock',
      clock: runtime.clock,
      random,
    });

    expect(mock.driver).toBe('mock');
    expect(flaky.driver).toBe('unreliable-mock');
    expect(flaky).toBeInstanceOf(UnreliableMockTelecomProvider);
  });

  it('rejects an unknown driver at runtime as well as at compile time', () => {
    const runtime = createTestRuntime();
    expect(() =>
      createProvider({
        id: 'x',
        // Deliberately bypassing the type system to prove the runtime guard holds — this is
        // the boundary that keeps the system incapable of placing a real call.
        driver: 'twilio' as unknown as 'mock',
        clock: runtime.clock,
        random: new SeededRandom(1),
      }),
    ).toThrow(/Only mock drivers exist/);
  });

  it('registers, looks up and lists providers', () => {
    const runtime = createTestRuntime();
    const registry = new ProviderRegistry();
    const provider = createProvider({
      id: 'mock-1',
      driver: 'mock',
      clock: runtime.clock,
      random: new SeededRandom(1),
    });

    registry.register(provider);
    expect(registry.has('mock-1')).toBe(true);
    expect(registry.get('mock-1').id).toBe('mock-1');
    expect(registry.list().map((p) => p.id)).toEqual(['mock-1']);
    expect(() => registry.get('missing')).toThrow(/No provider registered/);
  });
});
