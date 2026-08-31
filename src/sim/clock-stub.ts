/**
 * A do-nothing clock for CLI tooling.
 *
 * The scenario runner and the migration/seed scripts need a `Clock` to construct a logger,
 * but they are not part of any simulation and have no virtual time of their own — each
 * simulation builds its own clock internally. Rather than let those tools reach for real
 * time (which ESLint forbids in engine code and which would be meaningless here anyway),
 * they get a clock that is honestly frozen at zero.
 */

import type { Clock, TimerHandle } from '../core/clock.ts';

export class SimulationClock implements Clock {
  now(): number {
    return 0;
  }

  setTimer(): TimerHandle {
    // Nothing schedules work on this clock. Returning a handle keeps the interface honest
    // without pretending a timer was armed.
    return 0;
  }

  clearTimer(): void {
    /* no timers exist to cancel */
  }
}
