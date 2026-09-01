/**
 * Campaign lifecycle and configuration.
 *
 * Every state change goes through the campaign state machine and is validated before it is
 * persisted. The distinction between pause and stop is deliberate and worth stating:
 *
 *   pause — no new calls are initiated; calls already in progress run to completion.
 *   stop  — no new calls, and everything in flight is cancelled.
 *
 * Pausing a dialer that hangs up on live conversations would be useless in practice, which
 * is why the two exist separately.
 */

import type { Clock } from '../core/clock.ts';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { ID_PREFIX, type IdGenerator } from '../core/ids.ts';
import type { AppConfig } from '../config/index.ts';
import type { CampaignRepository } from '../db/repositories/campaign-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import {
  campaignStateMachine,
  type Campaign,
  type CampaignDraft,
  type CampaignStatus,
} from '../domain/campaign.ts';
import type { DialerEngine } from './dialer-engine.ts';
import type { EventService } from './event-service.ts';

export class CampaignService {
  readonly #campaigns: CampaignRepository;
  readonly #contacts: ContactRepository;
  readonly #agents: AgentRepository;
  readonly #engine: DialerEngine;
  readonly #events: EventService;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #config: AppConfig;

  constructor(options: {
    campaigns: CampaignRepository;
    contacts: ContactRepository;
    agents: AgentRepository;
    engine: DialerEngine;
    events: EventService;
    clock: Clock;
    ids: IdGenerator;
    config: AppConfig;
  }) {
    this.#campaigns = options.campaigns;
    this.#contacts = options.contacts;
    this.#agents = options.agents;
    this.#engine = options.engine;
    this.#events = options.events;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#config = options.config;
  }

  create(draft: CampaignDraft): Campaign {
    this.validateDraft(draft);
    const campaign = this.#campaigns.insert(
      this.#ids.next(ID_PREFIX.campaign),
      draft,
      this.#clock.now(),
    );
    this.#events.emit({
      type: 'campaign.created',
      message: `Campaign "${campaign.name}" created`,
      campaignId: campaign.id,
      metadata: { dialingMode: campaign.dialingMode },
    });
    this.#events.flush();
    return campaign;
  }

  /**
   * Reject configurations that are unsafe or self-contradictory.
   *
   * A campaign limit above the global ceiling is rejected rather than silently clamped: an
   * operator who typed 500 should be told the system will never honour it, not left to
   * discover later that their configuration was quietly ignored.
   */
  validateDraft(draft: Partial<CampaignDraft>): void {
    const problems: string[] = [];

    if (draft.name !== undefined && draft.name.trim() === '') {
      problems.push('name must not be empty');
    }
    if (draft.maxConcurrentCalls !== undefined) {
      if (!Number.isInteger(draft.maxConcurrentCalls) || draft.maxConcurrentCalls < 1) {
        problems.push('maxConcurrentCalls must be a positive integer');
      } else if (draft.maxConcurrentCalls > this.#config.limits.globalMaxConcurrentCalls) {
        problems.push(
          `maxConcurrentCalls (${draft.maxConcurrentCalls}) exceeds the global limit ` +
            `(${this.#config.limits.globalMaxConcurrentCalls})`,
        );
      }
    }
    if (draft.maxCallsPerSecond !== undefined && draft.maxCallsPerSecond <= 0) {
      problems.push('maxCallsPerSecond must be greater than zero');
    }
    if (
      draft.maxCallsPerSecond !== undefined &&
      draft.maxCallsPerSecond > this.#config.limits.globalCallsPerSecond
    ) {
      problems.push(
        `maxCallsPerSecond (${draft.maxCallsPerSecond}) exceeds the global rate ` +
          `(${this.#config.limits.globalCallsPerSecond})`,
      );
    }
    if (draft.maxAttemptsPerContact !== undefined) {
      if (!Number.isInteger(draft.maxAttemptsPerContact) || draft.maxAttemptsPerContact < 1) {
        problems.push('maxAttemptsPerContact must be at least 1');
      }
    }
    if (draft.maxAbandonRate !== undefined) {
      if (draft.maxAbandonRate < 0 || draft.maxAbandonRate > 1) {
        problems.push('maxAbandonRate must be between 0 and 1');
      }
    }
    if (draft.safety !== undefined) {
      if (draft.safety.lineRatio <= 0) problems.push('lineRatio must be greater than zero');
      if (draft.safety.maxLinesPerAgent < 1) problems.push('maxLinesPerAgent must be at least 1');
      if (draft.safety.targetOccupancy <= 0 || draft.safety.targetOccupancy > 1) {
        problems.push('targetOccupancy must be between 0 and 1');
      }
      if (draft.safety.abandonTimeoutMs <= 0) {
        problems.push('abandonTimeoutMs must be greater than zero');
      }
    }
    if (draft.retryPolicy !== undefined) {
      const policy = draft.retryPolicy;
      if (policy.maxAttempts < 1) problems.push('retryPolicy.maxAttempts must be at least 1');
      if (policy.initialDelayMs <= 0) problems.push('retryPolicy.initialDelayMs must be positive');
      if (policy.maxDelayMs < policy.initialDelayMs) {
        problems.push('retryPolicy.maxDelayMs must be at least initialDelayMs');
      }
      if (policy.multiplier < 1) problems.push('retryPolicy.multiplier must be at least 1');
      if (policy.jitterRatio < 0 || policy.jitterRatio > 1) {
        problems.push('retryPolicy.jitterRatio must be between 0 and 1');
      }
    }

    if (problems.length > 0) {
      throw new ValidationError(`Invalid campaign configuration: ${problems.join('; ')}`, {
        problems,
      });
    }
  }

  update(id: string, patch: Partial<CampaignDraft>): Campaign {
    const campaign = this.#require(id);
    if (campaign.status === 'RUNNING') {
      throw new ConflictError('Pause the campaign before changing its configuration', {
        campaignId: id,
        status: campaign.status,
      });
    }
    this.validateDraft(patch);
    return this.#campaigns.updateSettings(id, patch, this.#clock.now()) as Campaign;
  }

  /** Move DRAFT -> READY after checking the campaign can actually do anything. */
  markReady(id: string): Campaign {
    const campaign = this.#require(id);
    this.#transition(campaign, 'READY');
    return this.#require(id);
  }

  start(id: string): Campaign {
    const campaign = this.#require(id);

    // A campaign with no contacts or no agents would start, tick, and do nothing — which
    // looks identical to a bug. Refusing with a clear reason is more useful than a silent
    // idle campaign.
    if (this.#contacts.remainingCount(id) === 0) {
      throw new ConflictError('Campaign has no contacts left to dial', { campaignId: id });
    }
    if (this.#agents.listByCampaign(id).length === 0) {
      throw new ConflictError('Campaign has no agents assigned', { campaignId: id });
    }

    if (campaign.status === 'DRAFT') this.#transition(campaign, 'READY');
    const ready = this.#require(id);
    this.#transition(ready, 'RUNNING');

    this.#engine.start(id);
    this.#events.emit({
      type: 'campaign.started',
      message: `Campaign "${campaign.name}" started`,
      campaignId: id,
      metadata: { dialingMode: campaign.dialingMode },
    });
    this.#events.flush();
    return this.#require(id);
  }

  /** No new calls; calls already in progress continue to completion. */
  pause(id: string): Campaign {
    const campaign = this.#require(id);
    this.#transition(campaign, 'PAUSED');
    this.#engine.stop(id);

    this.#events.emit({
      type: 'campaign.paused',
      message: `Campaign "${campaign.name}" paused`,
      campaignId: id,
      metadata: { callsStillInFlight: this.#engine.activeCallCount(id) },
    });
    this.#events.flush();
    return this.#require(id);
  }

  resume(id: string): Campaign {
    const campaign = this.#require(id);
    this.#transition(campaign, 'RUNNING');
    this.#engine.start(id);

    this.#events.emit({
      type: 'campaign.resumed',
      message: `Campaign "${campaign.name}" resumed`,
      campaignId: id,
    });
    this.#events.flush();
    return this.#require(id);
  }

  /** No new calls, and everything in flight is cancelled. */
  stop(id: string): Campaign {
    const campaign = this.#require(id);
    this.#transition(campaign, 'STOPPED');
    this.#engine.stop(id);
    const cancelled = this.#engine.cancelAllForCampaign(id, 'CAMPAIGN_STOPPED');

    this.#events.emit({
      type: 'campaign.stopped',
      message: `Campaign "${campaign.name}" stopped`,
      campaignId: id,
      metadata: { cancelledCalls: cancelled },
    });
    this.#events.flush();
    return this.#require(id);
  }

  /**
   * Clear an abandon-rate pause.
   *
   * Only ever operator-initiated. The engine never calls this: whatever caused the
   * abandonment is still true, and auto-resuming would reproduce the harm the threshold
   * exists to prevent.
   */
  resumePredictive(id: string): Campaign {
    const campaign = this.#require(id);
    if (campaign.predictivePausedReason === null) return campaign;

    this.#campaigns.setPredictivePausedReason(id, null, this.#clock.now());
    // The engine stands down while predictive is paused, so clearing the reason is not
    // enough on its own — it has to be told to start ticking again.
    this.#engine.resumeStalled();
    this.#engine.start(id);
    this.#events.emit({
      type: 'campaign.resumed',
      severity: 'warn',
      message: 'Predictive dialing resumed by operator after an abandon-rate pause',
      campaignId: id,
      metadata: { previousReason: campaign.predictivePausedReason },
    });
    this.#events.flush();
    return this.#require(id);
  }

  /**
   * Reset a finished campaign so it can be run again.
   *
   * Deliberately distinct from `resume`. Resuming continues a run; this *discards* the
   * previous run's outcomes and puts unsuccessful contacts back in the pool — which is why
   * `COMPLETED` is a legal starting point for it even though `COMPLETED -> RUNNING` is not.
   * Without this, a demo campaign that finished its contacts is inert with no way back
   * except the command line.
   *
   * Contacts marked DO_NOT_CALL are never restored, and neither are contacts already
   * reached. See `ContactRepository.resetForReplay`.
   */
  reset(id: string): { campaign: Campaign; contactsRestored: number } {
    const campaign = this.#require(id);

    if (this.#engine.isRunning(id)) {
      throw new ConflictError('Stop the campaign before resetting it', {
        campaignId: id,
        status: campaign.status,
      });
    }
    if (campaign.status === 'RUNNING' || campaign.status === 'PAUSED') {
      throw new ConflictError('Stop the campaign before resetting it', {
        campaignId: id,
        status: campaign.status,
      });
    }

    const now = this.#clock.now();
    const contactsRestored = this.#contacts.resetForReplay(id, now);

    // Goes through the state machine, not around it. COMPLETED and FAILED have an explicit
    // reset-only edge to READY for exactly this (see the campaign transition table) — a raw
    // status write here would have made the machine a description of some transitions rather
    // than all of them, which is the property that makes it worth having.
    const current = this.#require(id);
    if (current.status !== 'READY' && current.status !== 'DRAFT') {
      this.#transition(current, 'READY');
    }

    // A reset also clears an abandon-rate pause: the rate that tripped it was measured
    // against a run that no longer exists.
    this.#campaigns.setPredictivePausedReason(id, null, now);

    this.#events.emit({
      type: 'campaign.stopped',
      severity: 'warn',
      message: `Campaign "${campaign.name}" reset for replay — ${contactsRestored} contact(s) restored`,
      campaignId: id,
      metadata: { contactsRestored, previousStatus: campaign.status, reset: true },
    });
    this.#events.flush();

    return { campaign: this.#require(id), contactsRestored };
  }

  list(): Campaign[] {
    return this.#campaigns.list();
  }

  get(id: string): Campaign {
    return this.#require(id);
  }

  #require(id: string): Campaign {
    const campaign = this.#campaigns.findById(id);
    if (campaign === null) throw new NotFoundError('Campaign', id);
    return campaign;
  }

  #transition(campaign: Campaign, to: CampaignStatus): void {
    if (campaign.status === to) return;
    campaignStateMachine.assertCan(campaign.status, to, campaign.id);
    const changed = this.#campaigns.updateStatus(campaign.id, campaign.status, to, this.#clock.now());
    if (!changed) {
      // The compare-and-set failed, meaning something else changed the campaign between our
      // read and our write. Reporting a conflict is right; clobbering would lose that change.
      throw new ConflictError('Campaign changed while the transition was in progress', {
        campaignId: campaign.id,
        expected: campaign.status,
        to,
      });
    }
  }
}
