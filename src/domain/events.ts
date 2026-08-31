/**
 * The event vocabulary.
 *
 * One emission serves four consumers: the durable audit log, the live dashboard feed, the
 * metrics windows, and the invariant checker (ARCHITECTURE.md, "Event flow"). That is why
 * events carry generous correlation metadata — an event you cannot trace back to a call, a
 * contact and a campaign is not much use at 2am.
 */

export const EVENT_TYPES = [
  // Campaign lifecycle
  'campaign.created',
  'campaign.started',
  'campaign.paused',
  'campaign.resumed',
  'campaign.stopped',
  'campaign.completed',

  // Contact lifecycle
  'contact.reserved',
  'contact.released',
  'contact.attempted',
  'contact.exhausted',

  // Call lifecycle
  'call.created',
  'call.dialing',
  'call.ringing',
  'call.answered',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.timeout',
  'call.completed',
  'call.cancelled',
  'call.abandoned',

  // Agent lifecycle
  'agent.available',
  'agent.reserved',
  'agent.busy',
  'agent.wrap_up',
  'agent.paused',
  'agent.offline',

  // Safety
  'safety.denied',
  'safety.limit_reached',
  'safety.emergency_stop',
  'safety.emergency_resume',
  'safety.abandon_threshold_exceeded',

  // Provider
  'provider.error',
  'provider.timeout',
  'provider.outage_started',
  'provider.outage_ended',
  'provider.fault_injected',

  // Retry
  'retry.scheduled',
  'retry.exhausted',

  // Dialer
  'dialer.tick',
  'dialer.plan',

  // Simulation
  'simulation.started',
  'simulation.finished',
  'invariant.violated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export interface SmartDialerEvent {
  readonly id: string;
  readonly type: EventType;
  /** Virtual time of emission. */
  readonly at: number;
  readonly severity: EventSeverity;
  readonly message: string;

  // Correlation. All optional because not every event has every dimension, but emitters
  // should populate as many as they legitimately know.
  readonly campaignId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly callId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly providerId?: string | undefined;

  readonly metadata: Record<string, unknown>;
}

/** Filter accepted by the event repository and the `/api/events` endpoints. */
export interface EventFilter {
  readonly types?: readonly EventType[];
  readonly severities?: readonly EventSeverity[];
  readonly campaignId?: string;
  readonly contactId?: string;
  readonly callId?: string;
  readonly agentId?: string;
  readonly providerId?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  /** Return events with sequence greater than this. Used to resume an SSE stream. */
  readonly afterSeq?: number;
}

/** A persisted event, carrying the monotonic sequence assigned on write. */
export interface StoredEvent extends SmartDialerEvent {
  readonly seq: number;
}
