import { describe, expect, it } from 'vitest';
import { FastDriver, PacedDriver, SimulatedClock } from '../../src/core/clock.ts';

describe('SimulatedClock', () => {
  it('starts at zero and only moves forward when advanced', () => {
    const clock = new SimulatedClock();
    expect(clock.now()).toBe(0);
    clock.advanceBy(500);
    expect(clock.now()).toBe(500);
    expect(() => clock.advanceTo(100)).toThrow(/backwards/);
  });

  it('fires timers in due-time order, not scheduling order', () => {
    const clock = new SimulatedClock();
    const fired: string[] = [];
    clock.setTimer(300, () => fired.push('third'));
    clock.setTimer(100, () => fired.push('first'));
    clock.setTimer(200, () => fired.push('second'));

    clock.advanceBy(1000);
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('breaks ties by insertion order so replay is reproducible', () => {
    // This is the property that keeps a run deterministic at high dial rates, where many
    // timers land on the same virtual millisecond (DECISIONS.md D-003).
    const clock = new SimulatedClock();
    const fired: number[] = [];
    for (let i = 0; i < 20; i += 1) clock.setTimer(50, () => fired.push(i));

    clock.advanceBy(50);
    expect(fired).toEqual([...Array(20).keys()]);
  });

  it('sets virtual time to each timer’s due time as it fires', () => {
    const clock = new SimulatedClock();
    const observed: number[] = [];
    clock.setTimer(100, () => observed.push(clock.now()));
    clock.setTimer(250, () => observed.push(clock.now()));

    clock.advanceBy(1000);
    expect(observed).toEqual([100, 250]);
    expect(clock.now()).toBe(1000);
  });

  it('runs timers scheduled by a firing callback within the same advance', () => {
    // A call's lifecycle is a cascade of timers scheduling further timers; if a nested
    // timer were deferred to the next advance, an "instant" simulation would stall.
    const clock = new SimulatedClock();
    const fired: string[] = [];
    clock.setTimer(10, () => {
      fired.push('outer');
      clock.setTimer(10, () => fired.push('inner'));
    });

    clock.advanceBy(100);
    expect(fired).toEqual(['outer', 'inner']);
  });

  it('does not fire timers beyond the advance target', () => {
    const clock = new SimulatedClock();
    const fired: string[] = [];
    clock.setTimer(100, () => fired.push('due'));
    clock.setTimer(500, () => fired.push('later'));

    clock.advanceTo(200);
    expect(fired).toEqual(['due']);
    expect(clock.pendingCount).toBe(1);
  });

  it('cancels timers, and cancelling twice or after firing is harmless', () => {
    const clock = new SimulatedClock();
    const fired: string[] = [];
    const handle = clock.setTimer(100, () => fired.push('cancelled'));
    clock.setTimer(100, () => fired.push('kept'));

    clock.clearTimer(handle);
    clock.clearTimer(handle);
    clock.advanceBy(200);
    clock.clearTimer(handle);

    expect(fired).toEqual(['kept']);
  });

  it('reports the next due time and pending count, ignoring cancelled timers', () => {
    const clock = new SimulatedClock();
    expect(clock.nextDueTime).toBeNull();

    const first = clock.setTimer(100, () => {});
    clock.setTimer(300, () => {});
    expect(clock.nextDueTime).toBe(100);
    expect(clock.pendingCount).toBe(2);

    clock.clearTimer(first);
    expect(clock.nextDueTime).toBe(300);
    expect(clock.pendingCount).toBe(1);
  });

  it('advanceToNextTimer jumps over dead time', () => {
    const clock = new SimulatedClock();
    clock.setTimer(9_999, () => {});

    expect(clock.advanceToNextTimer()).toBe(true);
    expect(clock.now()).toBe(9_999);
    expect(clock.advanceToNextTimer()).toBe(false);
  });

  it('rejects negative and non-finite delays', () => {
    const clock = new SimulatedClock();
    expect(() => clock.setTimer(-1, () => {})).toThrow(RangeError);
    expect(() => clock.setTimer(Number.NaN, () => {})).toThrow(RangeError);
  });

  it('fails loudly on a self-rescheduling timer instead of hanging', () => {
    const clock = new SimulatedClock({ maxTimersPerAdvance: 100 });
    const reschedule = (): void => {
      clock.setTimer(0, reschedule);
    };
    clock.setTimer(0, reschedule);

    expect(() => clock.advanceBy(1)).toThrow(/reschedules itself/);
  });

  it('propagates timer errors by default and routes them when a handler is given', () => {
    const boom = new Error('handler exploded');

    const strict = new SimulatedClock();
    strict.setTimer(1, () => {
      throw boom;
    });
    expect(() => strict.advanceBy(10)).toThrow(boom);

    const captured: Array<{ error: unknown; label: string }> = [];
    const lenient = new SimulatedClock({
      onTimerError: (error, label) => captured.push({ error, label }),
    });
    lenient.setTimer(
      1,
      () => {
        throw boom;
      },
      'call-watchdog',
    );
    const survivor: string[] = [];
    lenient.setTimer(2, () => survivor.push('still ran'));

    expect(() => lenient.advanceBy(10)).not.toThrow();
    expect(captured).toEqual([{ error: boom, label: 'call-watchdog' }]);
    // The point of the handler: one bad callback must not stop the clock.
    expect(survivor).toEqual(['still ran']);
  });
});

describe('FastDriver', () => {
  it('drains a chain of timers and reports why it stopped', async () => {
    const clock = new SimulatedClock();
    const fired: number[] = [];
    let remaining = 5;
    const schedule = (): void => {
      clock.setTimer(1000, () => {
        fired.push(clock.now());
        remaining -= 1;
        if (remaining > 0) schedule();
      });
    };
    schedule();

    const result = await new FastDriver(clock).run();

    expect(fired).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(result.stopReason).toBe('idle');
    expect(result.virtualTime).toBe(5000);
  });

  it('keeps up with asynchronous work that schedules the next timer', async () => {
    // The reason FastDriver yields to the runtime between batches. If it simply drained the
    // heap synchronously it would declare itself idle while an awaited promise was still
    // about to schedule the next timer — and a passing test would mean nothing.
    const clock = new SimulatedClock();
    const observed: number[] = [];

    const step = async (n: number): Promise<void> => {
      await Promise.resolve();
      observed.push(n);
      if (n < 3) {
        clock.setTimer(500, () => {
          void step(n + 1);
        });
      }
    };
    clock.setTimer(500, () => {
      void step(1);
    });

    const result = await new FastDriver(clock).run();

    expect(observed).toEqual([1, 2, 3]);
    expect(result.stopReason).toBe('idle');
  });

  it('stops at a virtual-time limit without firing later timers', async () => {
    const clock = new SimulatedClock();
    const fired: string[] = [];
    clock.setTimer(1000, () => fired.push('inside'));
    clock.setTimer(9000, () => fired.push('outside'));

    const result = await new FastDriver(clock).run({ untilVirtualMs: 5000 });

    expect(fired).toEqual(['inside']);
    expect(result.stopReason).toBe('virtual-time-limit');
    expect(clock.now()).toBe(5000);
  });

  it('stops when isDone becomes true', async () => {
    const clock = new SimulatedClock();
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      clock.setTimer(100, tick);
    };
    clock.setTimer(100, tick);

    const result = await new FastDriver(clock).run({ isDone: () => ticks >= 4 });

    expect(result.stopReason).toBe('done');
    expect(ticks).toBe(4);
  });

  it('stops at the batch limit rather than looping forever', async () => {
    const clock = new SimulatedClock();
    const tick = (): void => {
      clock.setTimer(100, tick);
    };
    clock.setTimer(100, tick);

    const result = await new FastDriver(clock).run({ maxBatches: 25 });

    expect(result.stopReason).toBe('batch-limit');
    expect(result.batches).toBe(25);
  });
});

describe('PacedDriver', () => {
  it('advances virtual time by realInterval x speed on each tick', async () => {
    const clock = new SimulatedClock();
    const driver = new PacedDriver(clock, { speed: 10, realIntervalMs: 10 });

    driver.start();
    expect(driver.running).toBe(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    driver.stop();

    // At least a few 10ms real intervals elapsed; each should add 100ms of virtual time.
    // Asserting a lower bound rather than an exact value keeps this from being flaky on a
    // loaded machine, while still proving the multiplier is applied.
    expect(clock.now()).toBeGreaterThanOrEqual(200);
    expect(clock.now() % 100).toBe(0);
    expect(driver.running).toBe(false);
  });

  it('validates and updates speed', () => {
    const clock = new SimulatedClock();
    expect(() => new PacedDriver(clock, { speed: 0 })).toThrow(RangeError);

    const driver = new PacedDriver(clock, { speed: 1 });
    driver.setSpeed(50);
    expect(driver.speed).toBe(50);
    expect(() => driver.setSpeed(-1)).toThrow(RangeError);
  });

  it('start is idempotent and stop is safe when not running', () => {
    const clock = new SimulatedClock();
    const driver = new PacedDriver(clock, { realIntervalMs: 1000 });

    driver.stop();
    driver.start();
    driver.start();
    expect(driver.running).toBe(true);
    driver.stop();
    expect(driver.running).toBe(false);
  });
});
