/**
 * System-wide state: the emergency stop.
 *
 * Kept as a single flag consulted by the first safety rule, rather than something that tries
 * to reach into every campaign and turn it off. That matters: engaging the stop must be
 * instantaneous and cannot fail partway through. A flag flips atomically; iterating over
 * campaigns to pause each one could fail on the third of ten and leave the system in a state
 * nobody designed.
 *
 * In-flight calls are deliberately allowed to finish. Cutting a live conversation off
 * mid-sentence serves nobody — the point of the control is that *no new call is initiated*,
 * which the safety rule guarantees from the instant the flag is set.
 */

import type { Clock } from '../core/clock.ts';
import type { EventService } from './event-service.ts';

export interface SystemStatus {
  readonly emergencyStopped: boolean;
  readonly emergencyStoppedAt: number | null;
  readonly reason: string | null;
  readonly simulationMode: boolean;
  readonly providerDriver: string;
}

export class SystemService {
  readonly #clock: Clock;
  readonly #events: EventService;
  readonly #simulationMode: boolean;
  readonly #providerDriver: string;

  #emergencyStopped = false;
  #emergencyStoppedAt: number | null = null;
  #reason: string | null = null;

  constructor(options: {
    clock: Clock;
    events: EventService;
    simulationMode: boolean;
    providerDriver: string;
  }) {
    this.#clock = options.clock;
    this.#events = options.events;
    this.#simulationMode = options.simulationMode;
    this.#providerDriver = options.providerDriver;
  }

  isEmergencyStopped(): boolean {
    return this.#emergencyStopped;
  }

  engage(reason = 'Manual emergency stop'): SystemStatus {
    if (this.#emergencyStopped) return this.status();

    this.#emergencyStopped = true;
    this.#emergencyStoppedAt = this.#clock.now();
    this.#reason = reason;

    this.#events.emit({
      type: 'safety.emergency_stop',
      severity: 'error',
      message: `EMERGENCY STOP engaged: ${reason}`,
      metadata: { reason },
    });
    this.#events.flush();
    return this.status();
  }

  release(): SystemStatus {
    if (!this.#emergencyStopped) return this.status();

    this.#emergencyStopped = false;
    this.#emergencyStoppedAt = null;
    this.#reason = null;

    this.#events.emit({
      type: 'safety.emergency_resume',
      severity: 'warn',
      message: 'Emergency stop released; campaigns may dial again',
    });
    this.#events.flush();
    return this.status();
  }

  status(): SystemStatus {
    return {
      emergencyStopped: this.#emergencyStopped,
      emergencyStoppedAt: this.#emergencyStoppedAt,
      reason: this.#reason,
      simulationMode: this.#simulationMode,
      providerDriver: this.#providerDriver,
    };
  }
}
