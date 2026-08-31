import { FastDriver, SimulatedClock } from '../../src/core/clock.ts';
import { SeededRandom } from '../../src/core/rng.ts';

export interface TestRuntime {
  readonly clock: SimulatedClock;
  readonly driver: FastDriver;
  readonly random: SeededRandom;
  /** Drain every scheduled timer, letting async continuations keep up. */
  drain(options?: { untilVirtualMs?: number; isDone?: () => boolean }): Promise<void>;
}

export function createTestRuntime(seed = 12_345): TestRuntime {
  const clock = new SimulatedClock();
  const driver = new FastDriver(clock);
  return {
    clock,
    driver,
    random: new SeededRandom(seed),
    drain: async (options = {}) => {
      await driver.run({ maxRealMs: 5000, ...options });
    },
  };
}
