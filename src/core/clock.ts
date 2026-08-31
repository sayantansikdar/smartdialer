/**
 * Virtual time.
 *
 * This is the ONLY file in the backend permitted to touch real time (`Date.now`,
 * `setInterval`). ESLint enforces that everywhere else — see `eslint.config.js` and
 * DECISIONS.md D-003/D-011. Keeping the exemption to exactly one file is deliberate: the
 * conversion from real time to virtual time happens here and nowhere else, so there is a
 * single place to look when reasoning about determinism.
 *
 * There is one `Clock` implementation, `SimulatedClock`. What differs between a test run
 * and the live dashboard is only which *driver* advances it:
 *
 *   FastDriver  — drains the timer queue as fast as the CPU allows (tests, instant sims)
 *   PacedDriver — advances virtual time on a real interval, scaled (live dashboard, 1x-100x)
 *
 * Because both drive the same clock, the dashboard and the test suite exercise the same
 * engine code. A green simulation test is therefore evidence about what a user will see.
 */

export type TimerHandle = number;

export interface Clock {
  /** Current virtual time in milliseconds since the run's epoch. */
  now(): number;
  /** Schedule `callback` to run `delayMs` of virtual time from now. */
  setTimer(delayMs: number, callback: () => void, label?: string): TimerHandle;
  /** Cancel a scheduled timer. Cancelling an already-fired or unknown handle is a no-op. */
  clearTimer(handle: TimerHandle): void;
}

interface TimerEntry {
  readonly id: TimerHandle;
  readonly dueAt: number;
  /**
   * Insertion sequence. Two timers due at the same virtual millisecond fire in the order
   * they were scheduled — never in whatever order a hash structure happens to yield.
   * This is what makes replay reproducible when many things are scheduled for the same
   * instant, which happens constantly at high dial rates.
   */
  readonly seq: number;
  readonly callback: () => void;
  readonly label: string;
}

/**
 * Binary min-heap ordered by (dueAt, seq).
 *
 * A sorted array would be simpler, but a predictive campaign schedules thousands of timers
 * and re-sorting on every insert turns the hot path quadratic. Cancellation uses lazy
 * deletion (a cancelled id is skipped when popped) rather than sift-down removal, because
 * cancellation is rare relative to insertion.
 */
class TimerHeap {
  readonly #items: TimerEntry[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(entry: TimerEntry): void {
    this.#items.push(entry);
    this.#siftUp(this.#items.length - 1);
  }

  peek(): TimerEntry | undefined {
    return this.#items[0];
  }

  pop(): TimerEntry | undefined {
    const top = this.#items[0];
    if (top === undefined) return undefined;
    const last = this.#items.pop() as TimerEntry;
    if (this.#items.length > 0) {
      this.#items[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  #before(a: TimerEntry, b: TimerEntry): boolean {
    return a.dueAt !== b.dueAt ? a.dueAt < b.dueAt : a.seq < b.seq;
  }

  #siftUp(start: number): void {
    let i = start;
    const item = this.#items[i] as TimerEntry;
    while (i > 0) {
      const parentIndex = (i - 1) >> 1;
      const parent = this.#items[parentIndex] as TimerEntry;
      if (!this.#before(item, parent)) break;
      this.#items[i] = parent;
      i = parentIndex;
    }
    this.#items[i] = item;
  }

  #siftDown(start: number): void {
    let i = start;
    const length = this.#items.length;
    const item = this.#items[i] as TimerEntry;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= length) break;
      const right = left + 1;
      let child = left;
      if (right < length && this.#before(this.#items[right] as TimerEntry, this.#items[left] as TimerEntry)) {
        child = right;
      }
      const childItem = this.#items[child] as TimerEntry;
      if (!this.#before(childItem, item)) break;
      this.#items[i] = childItem;
      i = child;
    }
    this.#items[i] = item;
  }
}

export interface SimulatedClockOptions {
  /** Virtual time the run starts at. Defaults to 0. */
  readonly startTime?: number;
  /**
   * Called when a timer callback throws. If omitted the error propagates to whoever
   * advanced the clock. The paced driver supplies a handler so that one bad callback
   * cannot silently kill the live dashboard's interval — but the error is still recorded,
   * never swallowed (CONSTRAINTS.md §3).
   */
  readonly onTimerError?: (error: unknown, label: string) => void;
  /**
   * Guard against a callback that schedules a zero-delay timer which schedules another,
   * forever. Without it such a bug hangs the process with no diagnostic.
   */
  readonly maxTimersPerAdvance?: number;
}

export class SimulatedClock implements Clock {
  readonly #heap = new TimerHeap();
  readonly #cancelled = new Set<TimerHandle>();
  readonly #onTimerError: ((error: unknown, label: string) => void) | undefined;
  readonly #maxTimersPerAdvance: number;
  #currentTime: number;
  #nextId: TimerHandle = 1;
  #seq = 0;

  constructor(options: SimulatedClockOptions = {}) {
    this.#currentTime = options.startTime ?? 0;
    this.#onTimerError = options.onTimerError;
    this.#maxTimersPerAdvance = options.maxTimersPerAdvance ?? 1_000_000;
  }

  now(): number {
    return this.#currentTime;
  }

  setTimer(delayMs: number, callback: () => void, label = 'timer'): TimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`setTimer requires a finite, non-negative delay; got ${delayMs}`);
    }
    const id = this.#nextId++;
    this.#heap.push({
      id,
      dueAt: this.#currentTime + delayMs,
      seq: this.#seq++,
      callback,
      label,
    });
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    this.#cancelled.add(handle);
  }

  /** Virtual time of the next pending timer, or `null` if nothing is scheduled. */
  get nextDueTime(): number | null {
    this.#discardCancelledHead();
    return this.#heap.peek()?.dueAt ?? null;
  }

  /** Number of live (non-cancelled) pending timers. */
  get pendingCount(): number {
    this.#discardCancelledHead();
    return this.#heap.size;
  }

  /**
   * Advance to `target`, firing every timer due at or before it, in (dueAt, seq) order.
   *
   * Timers scheduled *by* a firing callback are picked up within the same advance if they
   * fall at or before `target` — that is what lets a whole cascade of call-lifecycle
   * transitions resolve inside one step. Returns the number of callbacks fired.
   */
  advanceTo(target: number): number {
    if (target < this.#currentTime) {
      throw new RangeError(
        `Cannot move virtual time backwards: now=${this.#currentTime}, target=${target}`,
      );
    }
    let fired = 0;
    for (;;) {
      this.#discardCancelledHead();
      const next = this.#heap.peek();
      if (next === undefined || next.dueAt > target) break;

      this.#heap.pop();
      this.#currentTime = next.dueAt;
      fired += 1;
      if (fired > this.#maxTimersPerAdvance) {
        throw new Error(
          `SimulatedClock fired ${fired} timers in one advance (limit ${this.#maxTimersPerAdvance}). ` +
            `Likely a timer that reschedules itself with no delay. Last label: "${next.label}".`,
        );
      }

      try {
        next.callback();
      } catch (error) {
        if (this.#onTimerError === undefined) throw error;
        this.#onTimerError(error, next.label);
      }
    }
    this.#currentTime = target;
    return fired;
  }

  advanceBy(deltaMs: number): number {
    return this.advanceTo(this.#currentTime + deltaMs);
  }

  /**
   * Jump straight to the next scheduled timer and fire everything due at that instant.
   * Returns false when nothing is pending. This is how the fast driver skips over the
   * dead time between events instead of stepping through it.
   */
  advanceToNextTimer(): boolean {
    const next = this.nextDueTime;
    if (next === null) return false;
    this.advanceTo(next);
    return true;
  }

  #discardCancelledHead(): void {
    for (;;) {
      const head = this.#heap.peek();
      if (head === undefined || !this.#cancelled.has(head.id)) return;
      this.#heap.pop();
      this.#cancelled.delete(head.id);
    }
  }
}

/**
 * Yield to the runtime so pending promise continuations and I/O callbacks can run.
 *
 * This is the hinge between virtual time and asynchronous code. The engine is genuinely
 * async — `provider.createCall()` returns a promise — so simply draining the timer heap
 * would fire timers before the promise chains that schedule the *next* timers had settled.
 * `setImmediate` runs after the microtask queue and after pending I/O, which is exactly
 * the boundary we need. (`setImmediate` is not a wall-clock timer, so it does not
 * reintroduce real-time dependence.)
 */
function yieldToRuntime(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export interface FastDriverOptions {
  /** Stop once virtual time would pass this point. */
  readonly untilVirtualMs?: number;
  /** Stop when this returns true, checked between timer batches. */
  readonly isDone?: () => boolean;
  /**
   * How many consecutive empty-queue yields count as "idle". More than one is required
   * because an in-flight promise may still be about to schedule the next timer; a single
   * empty check would end the run early and make a passing test meaningless.
   */
  readonly quietRounds?: number;
  /** Hard ceiling on batches, so a runaway simulation fails loudly instead of hanging. */
  readonly maxBatches?: number;
  /** Wall-clock escape hatch, in real milliseconds. */
  readonly maxRealMs?: number;
}

/**
 * Drains a `SimulatedClock` as fast as possible, interleaving runtime yields so that async
 * work keeps up. Used by tests and by "instant" simulation runs: ten minutes of campaign
 * time completes in milliseconds.
 */
export class FastDriver {
  readonly #clock: SimulatedClock;

  constructor(clock: SimulatedClock) {
    this.#clock = clock;
  }

  async run(options: FastDriverOptions = {}): Promise<FastDriverResult> {
    const quietRounds = options.quietRounds ?? 3;
    const maxBatches = options.maxBatches ?? 5_000_000;
    const startedAt = Date.now();
    let batches = 0;
    let quiet = 0;
    let stopReason: FastDriverResult['stopReason'];

    for (;;) {
      await yieldToRuntime();

      if (options.isDone?.() === true) {
        stopReason = 'done';
        break;
      }
      if (options.maxRealMs !== undefined && Date.now() - startedAt > options.maxRealMs) {
        stopReason = 'real-time-limit';
        break;
      }
      if (batches >= maxBatches) {
        stopReason = 'batch-limit';
        break;
      }

      const next = this.#clock.nextDueTime;
      if (next === null) {
        // Nothing scheduled — but an awaited promise may be about to schedule something.
        // Only call it idle after several consecutive quiet yields.
        quiet += 1;
        if (quiet >= quietRounds) {
          stopReason = 'idle';
          break;
        }
        continue;
      }
      quiet = 0;

      if (options.untilVirtualMs !== undefined && next > options.untilVirtualMs) {
        this.#clock.advanceTo(options.untilVirtualMs);
        stopReason = 'virtual-time-limit';
        break;
      }

      this.#clock.advanceTo(next);
      batches += 1;
    }

    return { batches, stopReason, virtualTime: this.#clock.now() };
  }
}

export interface FastDriverResult {
  readonly batches: number;
  readonly virtualTime: number;
  readonly stopReason: 'idle' | 'done' | 'virtual-time-limit' | 'real-time-limit' | 'batch-limit';
}

export interface PacedDriverOptions {
  /** Virtual milliseconds per real millisecond. 1 = real time, 100 = 100x faster. */
  readonly speed?: number;
  /** Real interval between advances. 50ms is smooth on screen without busy-looping. */
  readonly realIntervalMs?: number;
  readonly onError?: (error: unknown, label: string) => void;
}

/**
 * Advances a `SimulatedClock` against real time, scaled by a speed multiplier. This is what
 * the live dashboard runs on, and the speed control is simply this multiplier.
 *
 * Async continuations settle naturally in the gaps between real intervals, so unlike the
 * fast driver this needs no explicit yielding.
 */
export class PacedDriver {
  readonly #clock: SimulatedClock;
  readonly #realIntervalMs: number;
  #speed: number;
  #handle: ReturnType<typeof setInterval> | null = null;

  constructor(clock: SimulatedClock, options: PacedDriverOptions = {}) {
    this.#clock = clock;
    this.#speed = options.speed ?? 1;
    this.#realIntervalMs = options.realIntervalMs ?? 50;
    if (this.#speed <= 0) throw new RangeError(`PacedDriver speed must be > 0, got ${this.#speed}`);
  }

  get speed(): number {
    return this.#speed;
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`PacedDriver speed must be a finite number > 0, got ${speed}`);
    }
    this.#speed = speed;
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  start(): void {
    if (this.#handle !== null) return;
    this.#handle = setInterval(() => {
      this.#clock.advanceBy(this.#realIntervalMs * this.#speed);
    }, this.#realIntervalMs);
    // Do not hold the process open purely to tick an idle clock.
    this.#handle.unref?.();
  }

  stop(): void {
    if (this.#handle === null) return;
    clearInterval(this.#handle);
    this.#handle = null;
  }
}
