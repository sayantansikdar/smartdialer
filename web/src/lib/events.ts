/**
 * The live event stream.
 *
 * A thin wrapper over `EventSource` with two jobs the browser does not do for us:
 *
 * 1. **Report connection state.** The dashboard must be able to say "live" or "reconnecting"
 *    honestly. A dashboard that silently stops updating is worse than one that says it has
 *    lost the connection, because the numbers on screen keep looking authoritative.
 *
 * 2. **Bound the buffer.** Events arrive continuously and a tab left open for an hour would
 *    otherwise accumulate every one of them. The log keeps the most recent N.
 */

import type { SmartDialerEvent } from './types.ts';

export type ConnectionState = 'connecting' | 'live' | 'down';

export interface EventStreamOptions {
  readonly campaignId?: string | undefined;
  readonly onEvent: (event: SmartDialerEvent) => void;
  readonly onStateChange: (state: ConnectionState) => void;
}

export function openEventStream(options: EventStreamOptions): () => void {
  const url =
    options.campaignId === undefined
      ? '/api/events/stream'
      : `/api/events/stream?campaignId=${encodeURIComponent(options.campaignId)}`;

  options.onStateChange('connecting');
  const source = new EventSource(url);

  source.onopen = () => options.onStateChange('live');

  // `EventSource` reconnects on its own, so `onerror` means "not connected right now" rather
  // than "give up". Reporting it as `down` and letting the browser retry is both simpler and
  // more robust than reimplementing backoff.
  source.onerror = () => {
    options.onStateChange(source.readyState === EventSource.CLOSED ? 'down' : 'connecting');
  };

  // The server names every frame after its event type, so there is no default-`message`
  // handler to attach to — each type must be subscribed individually.
  const handler = (raw: MessageEvent<string>): void => {
    try {
      options.onEvent(JSON.parse(raw.data) as SmartDialerEvent);
    } catch {
      // A malformed frame is not worth tearing the stream down for; skip it.
    }
  };

  for (const type of STREAMED_EVENT_TYPES) {
    source.addEventListener(type, handler as EventListener);
  }

  return () => {
    source.close();
    options.onStateChange('down');
  };
}

/** Must stay in step with `EVENT_TYPES` in `src/domain/events.ts`. */
export const STREAMED_EVENT_TYPES = [
  'campaign.created', 'campaign.started', 'campaign.paused', 'campaign.resumed',
  'campaign.stopped', 'campaign.completed',
  'contact.reserved', 'contact.released', 'contact.attempted', 'contact.exhausted',
  'call.created', 'call.dialing', 'call.ringing', 'call.answered', 'call.no_answer',
  'call.busy', 'call.failed', 'call.timeout', 'call.completed', 'call.cancelled',
  'call.abandoned',
  'agent.available', 'agent.reserved', 'agent.busy', 'agent.wrap_up', 'agent.paused',
  'agent.offline',
  'safety.denied', 'safety.limit_reached', 'safety.emergency_stop',
  'safety.emergency_resume', 'safety.abandon_threshold_exceeded',
  'provider.error', 'provider.timeout', 'provider.outage_started', 'provider.outage_ended',
  'provider.fault_injected',
  'retry.scheduled', 'retry.exhausted',
  'dialer.tick', 'dialer.plan',
  'simulation.started', 'simulation.finished', 'invariant.violated',
] as const;

/** A bounded ring of the most recent events, newest first. */
export function appendBounded(
  existing: readonly SmartDialerEvent[],
  incoming: SmartDialerEvent,
  max = 500,
): SmartDialerEvent[] {
  const next = [incoming, ...existing];
  return next.length > max ? next.slice(0, max) : next;
}
