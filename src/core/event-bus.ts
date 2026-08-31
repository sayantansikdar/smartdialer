/**
 * Synchronous in-process event dispatch.
 *
 * Events are the system's nervous system: the same emission feeds the audit log, the live
 * dashboard, the metrics windows and the invariant checker (ARCHITECTURE.md, "Event flow").
 *
 * Dispatch is synchronous on purpose. If events were queued, an invariant violation would
 * surface a tick after the transition that caused it, and the stack trace would point at
 * the queue drain rather than at the bug. Synchronous dispatch means the failure appears
 * exactly where it was created.
 */

export interface BusEvent {
  readonly type: string;
}

export type EventHandler<E extends BusEvent> = (event: E) => void;
export type Unsubscribe = () => void;

export class EventBus<E extends BusEvent> {
  readonly #all = new Set<EventHandler<E>>();
  readonly #byType = new Map<string, Set<EventHandler<E>>>();
  readonly #onHandlerError: ((error: unknown, event: E) => void) | undefined;

  constructor(options: { onHandlerError?: (error: unknown, event: E) => void } = {}) {
    this.#onHandlerError = options.onHandlerError;
  }

  /** Subscribe to every event. */
  subscribe(handler: EventHandler<E>): Unsubscribe {
    this.#all.add(handler);
    return () => this.#all.delete(handler);
  }

  /** Subscribe to one event type. */
  on(type: E['type'], handler: EventHandler<E>): Unsubscribe {
    let handlers = this.#byType.get(type);
    if (handlers === undefined) {
      handlers = new Set();
      this.#byType.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  emit(event: E): void {
    // Snapshot before dispatch: a handler that subscribes or unsubscribes while an event is
    // in flight must not mutate the set being iterated, or the run becomes order-dependent
    // in a way that would break replay.
    const targeted = this.#byType.get(event.type);
    const handlers = targeted === undefined ? [...this.#all] : [...this.#all, ...targeted];

    let errors: unknown[] | undefined;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        // One misbehaving subscriber must not starve the others — persistence and the
        // invariant checker both listen here. But nothing is swallowed: errors are
        // collected and reported after dispatch completes (CONSTRAINTS.md §3).
        (errors ??= []).push(error);
      }
    }

    if (errors === undefined) return;
    if (this.#onHandlerError !== undefined) {
      for (const error of errors) this.#onHandlerError(error, event);
      return;
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} handlers failed for event ${event.type}`);
  }

  /** Total registered handlers. Used by tests to assert teardown released subscriptions. */
  get handlerCount(): number {
    let count = this.#all.size;
    for (const handlers of this.#byType.values()) count += handlers.size;
    return count;
  }

  removeAll(): void {
    this.#all.clear();
    this.#byType.clear();
  }
}
