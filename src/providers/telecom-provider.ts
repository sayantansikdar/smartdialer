/**
 * The telecom boundary.
 *
 * This is the only place the system talks about phone carriers. Everything above it deals
 * in `ProviderCallHandle` and `ProviderEvent`, which is what lets the entire dialer be
 * demonstrated and tested with zero telecom risk — and what a real integration would slot
 * into later without touching the engine.
 *
 * The interface is deliberately event-driven rather than request/response. A real carrier
 * does not tell you the outcome of a call when you place it; it accepts the request and
 * tells you what happened over the following seconds. Modelling that honestly is the whole
 * point: an implementation that returned `{ answered: true }` from `createCall()` would let
 * the engine be written against a fantasy, and every timeout and abandonment bug would be
 * discovered in production instead of here.
 *
 * CONSTRAINTS.md §1: only mock implementations of this interface exist in this repository.
 */

import type { ErrorCode } from '../core/errors.ts';

export interface ProviderCallRequest {
  /** Our call id, echoed back on every event so the engine can correlate. */
  readonly callId: string;
  readonly campaignId: string;
  readonly phoneNumber: string;
}

export interface ProviderCallHandle {
  readonly providerCallId: string;
  readonly acceptedAt: number;
}

export const PROVIDER_EVENT_TYPES = [
  'call.dialing',
  'call.ringing',
  'call.answered',
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

export interface ProviderEvent {
  readonly type: ProviderEventType;
  readonly providerCallId: string;
  readonly callId: string;
  /** Virtual time of the event. */
  readonly at: number;
  readonly code?: ErrorCode | undefined;
  /** Whether a failure may be retried. Absent for non-failure events. */
  readonly transient?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const PROVIDER_CALL_STATES = [
  'ACCEPTED',
  'DIALING',
  'RINGING',
  'ANSWERED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type ProviderCallState = (typeof PROVIDER_CALL_STATES)[number];

export interface ProviderCallStatus {
  readonly providerCallId: string;
  readonly state: ProviderCallState;
  readonly since: number;
}

export interface ProviderMetrics {
  readonly requests: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly completed: number;
  readonly failed: number;
  /** Calls the provider deliberately went silent on — no terminal event was ever sent. */
  readonly silent: number;
  readonly averageResponseTimeMs: number;
  readonly activeCalls: number;
  readonly outageActive: boolean;
}

export type ProviderEventHandler = (event: ProviderEvent) => void;
export type ProviderUnsubscribe = () => void;

export interface TelecomProvider {
  readonly id: string;
  readonly driver: string;

  /**
   * Ask the provider to place a call. Resolves once the request is *accepted* — never with
   * the call's outcome, which arrives later as events. Rejects with `ProviderCallError`
   * when the request itself fails (outage, provider capacity, invalid number).
   */
  createCall(request: ProviderCallRequest): Promise<ProviderCallHandle>;

  /** Abandon a call in progress. Idempotent; cancelling an unknown call is a no-op. */
  cancelCall(providerCallId: string): Promise<void>;

  getCallStatus(providerCallId: string): Promise<ProviderCallStatus>;

  onEvent(handler: ProviderEventHandler): ProviderUnsubscribe;

  metrics(): ProviderMetrics;
  activeCallCount(): number;

  /** Cancel everything in flight and release timers. Used on shutdown and between runs. */
  reset(): void;
}
