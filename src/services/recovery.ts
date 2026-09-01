/**
 * Crash recovery.
 *
 * The assignment's first failure case:
 *
 *     Agent reserved > Borrower reserved > Call initiated > Worker crashes.
 *     What happens when the system comes back?
 *
 * Without this, nothing good. The concurrency ledger is in-memory and dies with the process
 * (DECISIONS.md D-007), but the database survives — so a restart inherits contacts stuck in
 * RESERVED, agents stuck in ON_CALL for calls nobody is watching, and call rows that will
 * never reach a terminal state because the timer that would have timed them out died too.
 *
 * Every one of those is a permanent leak. The contact never gets dialled again, the agent
 * seat is gone for the life of the process, and the invariant checker reports a ledger that
 * disagrees with the database from the first second.
 *
 * **The recovery rule is: on startup, this process owns everything, so anything mid-flight
 * belongs to a worker that no longer exists.** That is sound precisely because the design is
 * single-process (D-007). In a genuinely multi-worker deployment the same reconciliation
 * would need a lease or heartbeat column to tell *my* in-flight work from a peer's — noted in
 * SCALE.md as one of the first things that would have to change.
 *
 * Nothing here is silent. Every reclamation emits an event, because a system that quietly
 * tidies up after a crash is a system where crashes go unnoticed.
 */

import type { Clock } from '../core/clock.ts';
import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import type { CallRepository } from '../db/repositories/call-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import type { Logger } from '../core/logger.ts';
import type { EventService } from './event-service.ts';

export interface RecoveryReport {
  readonly callsReclaimed: number;
  readonly contactsReleased: number;
  readonly agentsReleased: number;
  readonly clean: boolean;
}

export interface RecoveryServiceOptions {
  readonly calls: CallRepository;
  readonly contacts: ContactRepository;
  readonly agents: AgentRepository;
  readonly events: EventService;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class RecoveryService {
  readonly #options: RecoveryServiceOptions;

  constructor(options: RecoveryServiceOptions) {
    this.#options = options;
  }

  /**
   * Reconcile orphaned state left by a previous process.
   *
   * Order matters: calls first, because releasing a call is what frees its contact and its
   * agent. Doing agents first would free a seat that the call-reclamation step then tries to
   * free again.
   */
  recover(): RecoveryReport {
    const { calls, contacts, agents, events, clock, logger } = this.#options;
    const now = clock.now();

    // 1. Calls that were in flight when the process died.
    //
    // TIMEOUT rather than FAILED, and the distinction is deliberate: we genuinely do not know
    // what happened to these calls. The provider may have connected them. TIMEOUT is the
    // honest description — "we stopped being able to observe this" — and it classifies as
    // transient, so the contacts remain retriable rather than being burned by a crash that
    // was our fault, not theirs.
    const orphanedCalls = calls.listActive();
    for (const call of orphanedCalls) {
      calls.updateStatus(call.id, call.status, 'TIMEOUT', now);
      calls.finalize({
        callId: call.id,
        attemptId: call.attemptId,
        outcome: 'TIMEOUT',
        failureCode: 'WORKER_CRASH',
        failureClass: 'TRANSIENT',
        endedAt: now,
        talkDurationMs: null,
      });
      events.emit({
        type: 'call.timeout',
        severity: 'warn',
        message: `Reclaimed call ${call.id} left in ${call.status} by a previous process`,
        campaignId: call.campaignId,
        contactId: call.contactId,
        callId: call.id,
        metadata: { recoveredFrom: call.status, reason: 'worker-crash' },
      });
    }

    // 2. Contacts stranded mid-flight. Back to READY — never to a terminal state, because a
    //    contact that was never actually reached must not be written off by our crash.
    //    `resetForReplay` is deliberately not used: it clears attempt counters, and these
    //    attempts genuinely happened.
    let contactsReleased = 0;
    for (const call of orphanedCalls) {
      const contact = contacts.findById(call.contactId);
      if (contact === null) continue;
      if (['RESERVED', 'DIALING', 'RINGING', 'CONNECTED'].includes(contact.status)) {
        contacts.setStatus(contact.id, 'READY', now);
        contactsReleased += 1;
        events.emit({
          type: 'contact.released',
          severity: 'warn',
          message: `Released contact ${contact.id} stranded in ${contact.status}`,
          campaignId: contact.campaignId,
          contactId: contact.id,
          metadata: { recoveredFrom: contact.status, reason: 'worker-crash' },
        });
      }
    }

    // A contact can be stranded without a call row at all — the crash may have landed between
    // reserving it and creating the call. That window is small and it is exactly the one the
    // assignment describes, so it is swept explicitly rather than assumed away.
    for (const contact of contacts.listStranded(1000)) {
      contacts.setStatus(contact.id, 'READY', now);
      contactsReleased += 1;
      events.emit({
        type: 'contact.released',
        severity: 'warn',
        message: `Released contact ${contact.id} reserved with no call`,
        campaignId: contact.campaignId,
        contactId: contact.id,
        metadata: { recoveredFrom: contact.status, reason: 'worker-crash' },
      });
    }

    // 3. Agents holding a seat for a call that no longer exists.
    let agentsReleased = 0;
    for (const agent of agents.list()) {
      const occupied = ['RESERVED', 'RINGING', 'ON_CALL', 'WRAP_UP'].includes(agent.status);
      if (!occupied) continue;

      agents.release(agent.id, now, null);
      agentsReleased += 1;
      events.emit({
        type: 'agent.available',
        severity: 'warn',
        message: `Released agent ${agent.id} from ${agent.status} after a previous process ended`,
        agentId: agent.id,
        metadata: { recoveredFrom: agent.status, reason: 'worker-crash' },
      });
    }

    events.flush();

    const report: RecoveryReport = {
      callsReclaimed: orphanedCalls.length,
      contactsReleased,
      agentsReleased,
      clean: orphanedCalls.length === 0 && contactsReleased === 0 && agentsReleased === 0,
    };

    if (!report.clean) {
      // Loud on purpose. A crash that leaves work behind is worth noticing.
      logger.warn('Recovered state left by a previous process', {
        event: 'recovery.completed',
        ...report,
      });
    }
    return report;
  }
}
