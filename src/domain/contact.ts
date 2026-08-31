/**
 * Contact — a person to be reached, and the retry bookkeeping that goes with them.
 *
 * A note on `RESERVED`. The specification mentions both a `QUEUED` state and a
 * `READY -> RESERVED -> DIALING` locking sequence; these are one concept, and having two
 * names for it would guarantee that half the code checked the wrong one. This implementation
 * uses `RESERVED`, the name from the locking requirement, and the events that accompany it
 * (`contact.reserved` / `contact.released`) match.
 *
 * `RESERVED` is the load-bearing state: it is claimed by a single conditional UPDATE whose
 * `changes` count decides which worker won (DECISIONS.md D-002). Everything else about
 * contact concurrency follows from that one statement.
 */

import { StateMachine } from '../core/state-machine.ts';

export const CONTACT_STATUSES = [
  'READY',
  'RESERVED',
  'DIALING',
  'RINGING',
  'CONNECTED',
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'COMPLETED',
  'RETRY_PENDING',
  'EXHAUSTED',
  'DO_NOT_CALL',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const contactStateMachine = new StateMachine<ContactStatus>({
  name: 'Contact',
  initial: 'READY',
  transitions: {
    // A reservation can always be released back to READY — every failure path between
    // acquiring the lock and reaching the provider must be able to undo it, or contacts
    // leak out of the dialable pool one bug at a time.
    READY: ['RESERVED', 'DO_NOT_CALL', 'EXHAUSTED'],
    RESERVED: ['DIALING', 'READY', 'FAILED', 'DO_NOT_CALL'],
    DIALING: ['RINGING', 'NO_ANSWER', 'BUSY', 'FAILED', 'CONNECTED'],
    RINGING: ['CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED'],
    CONNECTED: ['COMPLETED', 'FAILED'],
    NO_ANSWER: ['RETRY_PENDING', 'EXHAUSTED', 'DO_NOT_CALL'],
    BUSY: ['RETRY_PENDING', 'EXHAUSTED', 'DO_NOT_CALL'],
    FAILED: ['RETRY_PENDING', 'EXHAUSTED', 'DO_NOT_CALL'],
    RETRY_PENDING: ['READY', 'EXHAUSTED', 'DO_NOT_CALL'],
    COMPLETED: [],
    EXHAUSTED: [],
    DO_NOT_CALL: [],
  },
  terminal: ['COMPLETED', 'EXHAUSTED', 'DO_NOT_CALL'],
});

/**
 * Statuses from which a contact may be picked up for a new dial. Deliberately narrow:
 * `RETRY_PENDING` is NOT included, because a contact waiting out its backoff must first be
 * promoted to READY once `nextAttemptAt` has passed. Folding those two conditions together
 * is how a backoff quietly stops being honoured.
 */
export const DIALABLE_CONTACT_STATUSES: readonly ContactStatus[] = ['READY'];

export function isContactTerminal(status: ContactStatus): boolean {
  return contactStateMachine.isTerminal(status);
}

export interface Contact {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly phoneNumber: string;
  readonly status: ContactStatus;
  readonly attemptCount: number;
  readonly lastAttemptAt: number | null;
  /** Earliest virtual time at which this contact may be dialled again. */
  readonly nextAttemptAt: number | null;
  readonly timezone: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactDraft {
  readonly campaignId: string;
  readonly name: string;
  readonly phoneNumber: string;
  readonly status?: ContactStatus;
  readonly attemptCount?: number;
  readonly lastAttemptAt?: number | null;
  readonly nextAttemptAt?: number | null;
  readonly timezone?: string;
  readonly metadata?: Record<string, unknown>;
}
