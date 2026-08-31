/**
 * Automated invariant checking.
 *
 * These are the properties that must hold at every observable moment (CONSTRAINTS.md §4).
 * They are checked against the **database**, independently of the in-memory ledger that
 * admission control uses — because the most valuable thing this can catch is the two
 * disagreeing. A concurrency counter that has drifted below reality is the signature of a
 * double-release bug, and it is silent until something over-dials.
 *
 * Two modes, deliberately:
 *   'throw'  — tests. A violation must fail the test at the moment it appears.
 *   'record' — simulations and production paths. Collect violations into the report so a
 *              long run surfaces every problem rather than aborting at the first.
 */

import { InvariantViolationError } from '../core/errors.ts';
import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import type { CallRepository } from '../db/repositories/call-repository.ts';
import type { CampaignRepository } from '../db/repositories/campaign-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import type { ConcurrencyService } from './concurrency.ts';

export interface InvariantViolation {
  readonly invariant: string;
  readonly detail: string;
  readonly metadata: Record<string, unknown>;
}

export type InvariantMode = 'throw' | 'record';

export interface InvariantCheckerOptions {
  readonly campaigns: CampaignRepository;
  readonly contacts: ContactRepository;
  readonly agents: AgentRepository;
  readonly calls: CallRepository;
  readonly concurrency: ConcurrencyService;
  readonly mode?: InvariantMode;
}

export class InvariantChecker {
  readonly #campaigns: CampaignRepository;
  readonly #contacts: ContactRepository;
  readonly #agents: AgentRepository;
  readonly #calls: CallRepository;
  readonly #concurrency: ConcurrencyService;
  readonly #mode: InvariantMode;
  readonly #recorded: InvariantViolation[] = [];

  constructor(options: InvariantCheckerOptions) {
    this.#campaigns = options.campaigns;
    this.#contacts = options.contacts;
    this.#agents = options.agents;
    this.#calls = options.calls;
    this.#concurrency = options.concurrency;
    this.#mode = options.mode ?? 'record';
  }

  get mode(): InvariantMode {
    return this.#mode;
  }

  /** Every violation recorded so far, for the simulation report. */
  violations(): readonly InvariantViolation[] {
    return this.#recorded;
  }

  get passed(): boolean {
    return this.#recorded.length === 0;
  }

  clear(): void {
    this.#recorded.length = 0;
  }

  /**
   * Run every check. In 'throw' mode the first violation raises; in 'record' mode all are
   * collected and returned.
   */
  check(): readonly InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const report = (invariant: string, detail: string, metadata: Record<string, unknown>): void => {
      const violation = { invariant, detail, metadata };
      violations.push(violation);
      this.#recorded.push(violation);
      if (this.#mode === 'throw') {
        throw new InvariantViolationError(invariant, detail, metadata);
      }
    };

    this.#checkGlobalConcurrency(report);
    this.#checkLedgerAgreement(report);
    this.#checkCampaignConcurrency(report);
    this.#checkProviderConcurrency(report);
    this.#checkAgents(report);
    this.#checkContacts(report);
    this.#checkDoNotCall(report);
    this.#checkStoppedCampaigns(report);

    return violations;
  }

  /** Convenience for tests: run the checks and throw on any violation. */
  assert(): void {
    const violations = this.check();
    const first = violations[0];
    if (first !== undefined) {
      throw new InvariantViolationError(first.invariant, first.detail, first.metadata);
    }
  }

  #checkGlobalConcurrency(report: ReportFn): void {
    const active = this.#calls.activeCount();
    const max = this.#concurrency.globalMax;
    if (active > max) {
      report('activeCalls <= globalMaxConcurrentCalls', `${active} active calls exceeds ${max}`, {
        active,
        max,
      });
    }
  }

  /**
   * The ledger and the database must agree on how many calls are active.
   *
   * This is the check most likely to catch a real bug. A lease released twice, or a call
   * finalised without releasing its lease, shows up here long before it shows up as
   * over-dialing — and by then the cause is far away.
   */
  #checkLedgerAgreement(report: ReportFn): void {
    const ledger = this.#concurrency.activeGlobal;
    const database = this.#calls.activeCount();
    if (ledger !== database) {
      report(
        'concurrency ledger matches persisted active calls',
        `ledger reports ${ledger} active call(s) but the database has ${database}`,
        { ledger, database, leases: this.#concurrency.activeLeases().map((l) => l.callId) },
      );
    }
  }

  #checkCampaignConcurrency(report: ReportFn): void {
    for (const campaign of this.#campaigns.list()) {
      const active = this.#calls.activeCount(campaign.id);
      if (active > campaign.maxConcurrentCalls) {
        report(
          'campaignActiveCalls <= campaignMaxConcurrentCalls',
          `campaign ${campaign.id} has ${active} active calls, limit ${campaign.maxConcurrentCalls}`,
          { campaignId: campaign.id, active, max: campaign.maxConcurrentCalls },
        );
      }
    }
  }

  #checkProviderConcurrency(report: ReportFn): void {
    const max = this.#concurrency.providerMax;
    for (const [providerId, active] of Object.entries(this.#calls.activeCountByProvider())) {
      if (active > max) {
        report(
          'providerActiveCalls <= providerMaxConcurrentCalls',
          `provider ${providerId} has ${active} active calls, limit ${max}`,
          { providerId, active, max },
        );
      }
    }
  }

  #checkAgents(report: ReportFn): void {
    const all = this.#agents.list();
    const occupied = all.filter(
      (agent) => agent.status === 'RESERVED' || agent.status === 'RINGING' || agent.status === 'ON_CALL',
    ).length;
    if (occupied > all.length) {
      report('agentBusyCalls <= numberOfAgents', `${occupied} occupied of ${all.length} agents`, {
        occupied,
        total: all.length,
      });
    }

    for (const { agentId, count } of this.#calls.agentsWithMultipleActiveCalls()) {
      report(
        'one agent cannot have two simultaneous active calls',
        `agent ${agentId} is on ${count} active calls`,
        { agentId, count },
      );
    }
  }

  #checkContacts(report: ReportFn): void {
    for (const { contactId, count } of this.#calls.contactsWithMultipleActiveCalls()) {
      report(
        'one contact cannot have two active call attempts',
        `contact ${contactId} has ${count} active calls`,
        { contactId, count },
      );
    }

    for (const campaign of this.#campaigns.list()) {
      for (const contact of this.#contacts.listByCampaign(campaign.id, 10_000)) {
        if (contact.attemptCount > campaign.maxAttemptsPerContact) {
          report(
            'attemptCount <= maxAttempts',
            `contact ${contact.id} has ${contact.attemptCount} attempts, limit ${campaign.maxAttemptsPerContact}`,
            {
              contactId: contact.id,
              attemptCount: contact.attemptCount,
              max: campaign.maxAttemptsPerContact,
            },
          );
        }
      }
    }
  }

  #checkDoNotCall(report: ReportFn): void {
    for (const { callId, contactId } of this.#calls.callsToDoNotCallContacts()) {
      report('DNC contacts are never dialled', `call ${callId} exists for DNC contact ${contactId}`, {
        callId,
        contactId,
      });
    }
  }

  #checkStoppedCampaigns(report: ReportFn): void {
    for (const campaign of this.#campaigns.list()) {
      if (campaign.status !== 'STOPPED' && campaign.status !== 'COMPLETED' && campaign.status !== 'DRAFT') {
        continue;
      }
      const active = this.#calls.activeCount(campaign.id);
      if (active > 0) {
        report(
          'a stopped campaign has no active calls',
          `campaign ${campaign.id} is ${campaign.status} but has ${active} active call(s)`,
          { campaignId: campaign.id, status: campaign.status, active },
        );
      }
    }
  }
}

type ReportFn = (invariant: string, detail: string, metadata: Record<string, unknown>) => void;
