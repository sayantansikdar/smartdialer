/**
 * Call and CallAttempt.
 *
 * A contact and an attempt to reach them are different things, and conflating them is the
 * single most common modelling mistake in a dialer. One contact may accumulate:
 *
 *     attempt 1 -> no answer     attempt 3 -> provider timeout
 *     attempt 2 -> busy          attempt 4 -> connected
 *
 * Retry policy, analytics, debugging and auditability all need those four rows to exist
 * independently. If the outcome lived on the contact, each attempt would overwrite the last
 * and the history — the thing you most need when a campaign misbehaves — would be gone.
 */

import { StateMachine } from '../core/state-machine.ts';

export const CALL_STATUSES = [
  'CREATED',
  'QUEUED',
  'DIALING',
  'RINGING',
  'CONNECTED',
  'ON_HOLD',
  'ENDED',
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const callStateMachine = new StateMachine<CallStatus>({
  name: 'Call',
  initial: 'CREATED',
  transitions: {
    CREATED: ['QUEUED', 'CANCELLED', 'FAILED'],
    QUEUED: ['DIALING', 'CANCELLED', 'FAILED', 'TIMEOUT'],
    DIALING: ['RINGING', 'NO_ANSWER', 'BUSY', 'FAILED', 'TIMEOUT', 'CANCELLED'],
    RINGING: ['CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'TIMEOUT', 'CANCELLED'],
    // TIMEOUT is reachable from CONNECTED on purpose: the failure mode that actually
    // strands resources is a provider that answers a call and then never reports it ending.
    //
    // CANCELLED is reachable too, and that is not merely permissive. Stopping a campaign or
    // engaging the emergency stop must be able to terminate a live conversation. Without
    // this edge the transition is refused, the call row stays active while its concurrency
    // lease is released, and the ledger silently drifts from the database — see BUG.md B-001.
    CONNECTED: ['ON_HOLD', 'ENDED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
    ON_HOLD: ['CONNECTED', 'ENDED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
    ENDED: [],
    NO_ANSWER: [],
    BUSY: [],
    FAILED: [],
    CANCELLED: [],
    TIMEOUT: [],
  },
  terminal: ['ENDED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'TIMEOUT'],
});

/** A call occupying a concurrency slot. Exactly the set the invariants count. */
export function isCallActive(status: CallStatus): boolean {
  return !callStateMachine.isTerminal(status);
}

export function isCallConnected(status: CallStatus): boolean {
  return status === 'CONNECTED' || status === 'ON_HOLD';
}

/** How an attempt finished. Mirrors the terminal call states, minus the in-flight ones. */
export const CALL_OUTCOMES = [
  'ANSWERED',
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'ABANDONED',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * Whether a failure may be retried. Getting this wrong is expensive in both directions:
 * retrying a permanent failure burns attempts on a number that will never work, and
 * treating a transient blip as permanent discards a reachable contact for good.
 */
export const FAILURE_CLASSES = ['TRANSIENT', 'PERMANENT', 'NONE'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface Call {
  readonly id: string;
  readonly campaignId: string;
  readonly contactId: string;
  readonly attemptId: string;
  readonly agentId: string | null;
  readonly providerId: string;
  readonly providerCallId: string | null;
  readonly status: CallStatus;

  readonly createdAt: number;
  readonly dialingAt: number | null;
  readonly ringingAt: number | null;
  readonly connectedAt: number | null;
  readonly endedAt: number | null;
  /** Connected-to-ended duration in virtual ms. Null unless the call was answered. */
  readonly talkDurationMs: number | null;

  readonly outcome: CallOutcome | null;
  readonly failureCode: string | null;
  readonly failureClass: FailureClass;
  /** Answered but no agent could take it within the abandon window. */
  readonly abandoned: boolean;
}

export interface CallAttempt {
  readonly id: string;
  readonly callId: string;
  readonly contactId: string;
  readonly campaignId: string;
  /** 1-based. Compared against `campaign.maxAttemptsPerContact`. */
  readonly attemptNumber: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: CallOutcome | null;
  readonly failureCode: string | null;
  readonly failureClass: FailureClass;
  /** Virtual time the retry was scheduled for, or null if none was scheduled. */
  readonly retryScheduledFor: number | null;
}
