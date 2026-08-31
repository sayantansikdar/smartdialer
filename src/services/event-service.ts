/**
 * Event emission and persistence.
 *
 * Emission is synchronous — subscribers (the SSE broadcaster, metrics, the invariant
 * checker) see an event the instant it happens, so a violation surfaces at the transition
 * that caused it rather than a tick later.
 *
 * Persistence is batched. At 100x simulation speed the engine emits thousands of events per
 * real second, and one transaction per event would make disk sync, rather than the dialer,
 * the thing being measured. The batch is flushed on every dialer tick, so an event is
 * durable within one tick of being emitted — comfortably inside what an audit log needs, and
 * the tradeoff is recorded here rather than discovered later.
 */

import type { Clock } from '../core/clock.ts';
import type { EventBus } from '../core/event-bus.ts';
import { ID_PREFIX, type IdGenerator } from '../core/ids.ts';
import type { Logger } from '../core/logger.ts';
import type { EventRepository } from '../db/repositories/event-repository.ts';
import type { EventSeverity, EventType, SmartDialerEvent } from '../domain/events.ts';

export interface EmitInput {
  readonly type: EventType;
  readonly message: string;
  readonly severity?: EventSeverity;
  readonly campaignId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly callId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly metadata?: Record<string, unknown>;
}

export interface EventServiceOptions {
  readonly bus: EventBus<SmartDialerEvent>;
  readonly repository: EventRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Flush automatically once the buffer reaches this size. */
  readonly maxBufferSize?: number;
  /** Set false in tests that assert on the bus alone. */
  readonly persist?: boolean;
}

export class EventService {
  readonly #bus: EventBus<SmartDialerEvent>;
  readonly #repository: EventRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: Logger;
  readonly #maxBufferSize: number;
  readonly #persist: boolean;
  #buffer: SmartDialerEvent[] = [];

  constructor(options: EventServiceOptions) {
    this.#bus = options.bus;
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#logger = options.logger;
    this.#maxBufferSize = options.maxBufferSize ?? 500;
    this.#persist = options.persist ?? true;
  }

  emit(input: EmitInput): SmartDialerEvent {
    const event: SmartDialerEvent = {
      id: this.#ids.next(ID_PREFIX.event),
      type: input.type,
      at: this.#clock.now(),
      severity: input.severity ?? 'info',
      message: input.message,
      campaignId: input.campaignId,
      contactId: input.contactId,
      callId: input.callId,
      agentId: input.agentId,
      providerId: input.providerId,
      metadata: input.metadata ?? {},
    };

    if (this.#persist) {
      this.#buffer.push(event);
      if (this.#buffer.length >= this.#maxBufferSize) this.flush();
    }

    // Emitted after buffering so a subscriber that immediately queries the repository during
    // a flush cannot observe a half-written batch.
    this.#bus.emit(event);

    if (event.severity === 'error' || event.severity === 'warn') {
      this.#logger[event.severity](event.message, {
        event: event.type,
        campaignId: event.campaignId,
        contactId: event.contactId,
        callId: event.callId,
        agentId: event.agentId,
        provider: event.providerId,
        ...event.metadata,
      });
    }

    return event;
  }

  /** Write buffered events. Called on every dialer tick and before any read of the log. */
  flush(): number {
    if (this.#buffer.length === 0) return 0;
    const batch = this.#buffer;
    // Swap before writing: if the insert throws, the events are not silently retried
    // forever, and the error propagates rather than being swallowed.
    this.#buffer = [];
    this.#repository.insertMany(batch);
    return batch.length;
  }

  get pendingCount(): number {
    return this.#buffer.length;
  }

  subscribe(handler: (event: SmartDialerEvent) => void): () => void {
    return this.#bus.subscribe(handler);
  }

  on(type: EventType, handler: (event: SmartDialerEvent) => void): () => void {
    return this.#bus.on(type, handler);
  }
}
