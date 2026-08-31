/**
 * Server-Sent Events broadcaster.
 *
 * One-way server-to-browser streaming (DECISIONS.md D-006). Commands travel the other way as
 * ordinary REST calls, so nothing here needs to read from the client.
 *
 * The two things that matter in an SSE implementation are both about not leaking:
 *
 * 1. **Subscribers must be removed when their connection closes.** A dashboard left open
 *    across a dozen reloads would otherwise accumulate dead writers, and every event would be
 *    written to sockets nobody is reading.
 *
 * 2. **A slow or broken client must not take down the emitter.** A write to a closed socket
 *    throws; if that propagated it would surface inside whatever engine transition emitted
 *    the event, and one stale browser tab could stop a campaign.
 */

import type { FastifyReply } from 'fastify';
import type { Logger } from '../core/logger.ts';
import type { SmartDialerEvent } from '../domain/events.ts';

interface Subscriber {
  readonly id: number;
  readonly reply: FastifyReply;
  /** Only events matching this campaign are sent. Undefined means everything. */
  readonly campaignId: string | undefined;
}

export class SseBroadcaster {
  readonly #subscribers = new Map<number, Subscriber>();
  readonly #logger: Logger;
  #nextId = 1;

  constructor(options: { logger: Logger }) {
    this.#logger = options.logger;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * Attach a reply as an event stream. Returns a detach function, but also wires up close
   * handlers — a client that vanishes without a clean close still gets cleaned up.
   */
  subscribe(reply: FastifyReply, options: { campaignId?: string | undefined } = {}): () => void {
    const id = this.#nextId++;
    const subscriber: Subscriber = { id, reply, campaignId: options.campaignId };
    this.#subscribers.set(id, subscriber);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this, a reverse proxy may buffer the stream and the dashboard sits blank.
      'X-Accel-Buffering': 'no',
    });
    // An initial comment flushes headers immediately, so the browser fires `onopen` rather
    // than waiting for the first real event — which may be seconds away on an idle system.
    reply.raw.write(': connected\n\n');

    const detach = (): void => {
      this.#subscribers.delete(id);
    };
    reply.raw.on('close', detach);
    reply.raw.on('error', detach);
    return detach;
  }

  broadcast(event: SmartDialerEvent): void {
    if (this.#subscribers.size === 0) return;

    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of [...this.#subscribers.values()]) {
      if (subscriber.campaignId !== undefined && event.campaignId !== subscriber.campaignId) {
        continue;
      }
      this.#write(subscriber, payload);
    }
  }

  /** A named frame for non-event payloads — metrics snapshots, system status. */
  send(name: string, data: unknown): void {
    if (this.#subscribers.size === 0) return;
    const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of [...this.#subscribers.values()]) {
      this.#write(subscriber, payload);
    }
  }

  #write(subscriber: Subscriber, payload: string): void {
    try {
      subscriber.reply.raw.write(payload);
    } catch (error) {
      // A dead socket is not an application error — but it is not silently ignored either.
      // Drop the subscriber and record why (CONSTRAINTS.md §3).
      this.#subscribers.delete(subscriber.id);
      this.#logger.debug('Dropped SSE subscriber after a failed write', {
        subscriberId: subscriber.id,
        error: String(error),
      });
    }
  }

  closeAll(): void {
    for (const subscriber of this.#subscribers.values()) {
      try {
        subscriber.reply.raw.end();
      } catch {
        // Already closed; nothing to do and nothing worth reporting.
      }
    }
    this.#subscribers.clear();
  }
}
