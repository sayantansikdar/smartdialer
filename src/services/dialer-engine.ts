/**
 * The dialer engine — where the plan becomes calls.
 *
 * On each tick it asks a strategy how many calls to place, then tries to place exactly that
 * many. The ordering inside `#attemptDial` is the load-bearing part of the whole system:
 *
 *     reserve contact (atomic CAS)   -- fails => someone else has it, skip
 *       -> evaluate safety           -- denied => release contact
 *         -> acquire concurrency lease -- fails => release contact
 *           -> create call + attempt rows
 *             -> provider.createCall() -- throws => release lease + contact, classify, retry
 *
 * Two rules govern every path through this file:
 *
 * 1. **Reserve before you dial.** The contact is claimed before anything expensive or
 *    asynchronous happens, so two workers cannot select the same person.
 *
 * 2. **Every failure path releases everything it took.** A contact left in RESERVED silently
 *    leaves the dialable pool; a lease left unreleased silently reduces capacity. Neither
 *    raises an error — the campaign just gets slower and eventually stalls with work
 *    remaining. This is why every branch below releases explicitly rather than relying on a
 *    later sweep, even though the sweep exists as a backstop.
 *
 * The engine is asynchronous (the provider is), but the *decisions* are synchronous: there
 * is no `await` between checking capacity and claiming it.
 */

import type { Clock, TimerHandle } from '../core/clock.ts';
import { ERROR_CODES, ProviderCallError, isSmartDialerError } from '../core/errors.ts';
import { ID_PREFIX, type IdGenerator } from '../core/ids.ts';
import type { Logger } from '../core/logger.ts';
import { redactPhoneNumber } from '../core/redact.ts';
import type { AppConfig } from '../config/index.ts';
import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import type { CallRepository } from '../db/repositories/call-repository.ts';
import type { CampaignRepository } from '../db/repositories/campaign-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import { isAgentOccupied } from '../domain/agent.ts';
import type { Campaign } from '../domain/campaign.ts';
import {
  callStateMachine,
  type CallOutcome,
  type CallStatus,
  type FailureClass,
} from '../domain/call.ts';
import type { Contact, ContactStatus } from '../domain/contact.ts';
import { ProgressiveDialer } from '../dialer/progressive.ts';
import { PredictiveDialer } from '../dialer/predictive.ts';
import type { DialerSnapshot, DialerStrategy, DialPlan } from '../dialer/strategy.ts';
import {
  SafetyController,
  type SafetyControllerContext,
  type SafetyControllerDecision,
} from '../dialer/safety-controller.ts';
import type { ProviderEvent, TelecomProvider } from '../providers/telecom-provider.ts';
import { AgentService } from './agent-service.ts';
import type { ConcurrencyService, Lease } from './concurrency.ts';
import type { EventService } from './event-service.ts';
import type { MetricsService } from './metrics.ts';
import type { RateLimiterRegistry } from './rate-limiter.ts';
import { classifyFailure, RetryService } from './retry.ts';
import {
  denialSeverity,
  SafetyEngine,
  type SafetyContext,
  type SafetyDecision,
  type SafetyRateLimiter,
} from './safety.ts';

/** In-memory bookkeeping for a call in flight. Discarded once the call settles. */
interface CallContext {
  readonly callId: string;
  readonly attemptId: string;
  readonly contactId: string;
  readonly campaignId: string;
  readonly providerId: string;
  readonly attemptNumber: number;
  readonly lease: Lease;
  providerCallId: string | null;
  agentId: string | null;
  status: CallStatus;
  answeredAt: number | null;
  watchdog: TimerHandle | null;
  abandonTimer: TimerHandle | null;
  settled: boolean;
}

export interface DialerEngineOptions {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly campaigns: CampaignRepository;
  readonly contacts: ContactRepository;
  readonly agents: AgentRepository;
  readonly calls: CallRepository;
  readonly concurrency: ConcurrencyService;
  readonly rateLimiters: RateLimiterRegistry;
  readonly safety: SafetyEngine;
  readonly retry: RetryService;
  readonly metrics: MetricsService;
  readonly events: EventService;
  readonly agentService: AgentService;
  readonly getProvider: (providerId: string) => TelecomProvider;
  readonly isEmergencyStopped: () => boolean;
}

export interface TickResult {
  readonly campaignId: string;
  readonly plan: DialPlan;
  readonly dialled: number;
  readonly denials: readonly SafetyDecision[];
}

export class DialerEngine {
  readonly #options: DialerEngineOptions;
  readonly #strategies: Record<Campaign['dialingMode'], DialerStrategy>;
  /**
   * The Safety Controller sits between the pacing engines and the allocator. It is the only
   * component that can turn a pacing *request* into an approved call count — the engines
   * below have no reference to it and no way to bypass it.
   */
  readonly #safetyController: SafetyController;

  /** Live call contexts, keyed by our call id. */
  readonly #inFlight = new Map<string, CallContext>();
  /** Provider call id -> our call id, for correlating provider events. */
  readonly #byProviderCallId = new Map<string, string>();
  /** Answered calls with no agent yet, per campaign, oldest first. */
  readonly #awaitingAgent = new Map<string, string[]>();
  /** Campaigns currently ticking, and their scheduled timer. */
  readonly #ticking = new Map<string, TimerHandle>();
  /** Provider event subscriptions, so they can be released on shutdown. */
  readonly #providerSubscriptions = new Map<string, () => void>();
  /**
   * Campaigns that are still RUNNING but stopped ticking because they provably cannot dial
   * — predictive paused by the abandon control, or the emergency stop engaged. They resume
   * when the blocking condition is lifted.
   */
  readonly #stalled = new Set<string>();
  /**
   * Calls in flight that have not yet connected, counted per campaign.
   *
   * Maintained incrementally rather than derived by scanning `#inFlight`, because the derived
   * version was the system's scaling bottleneck: it is needed once per dial attempt, and with
   * N attempts against N in-flight calls that is O(N^2) work every tick. Measured at 60x the
   * agents, per-tick cost grew 243x (SCALE.md, BUG.md B-016).
   *
   * The three places this changes are the three places a call enters flight, connects, or
   * leaves — kept adjacent to those transitions so the counter cannot drift unnoticed, and
   * cross-checked by `#assertPendingConsistent` under test.
   */
  readonly #pendingByCampaign = new Map<string, number>();
  /**
   * The most recent dial plan per campaign, kept purely for observability.
   *
   * The plan's `reasoning` is the honest answer to "why is the dialer placing this many
   * calls?", and it is worth surfacing live rather than only in a simulation report — that
   * question is exactly what an operator watching an idle-looking campaign is asking.
   */
  readonly #lastPlan = new Map<string, { plan: DialPlan; decision: SafetyControllerDecision; at: number }>();

  constructor(options: DialerEngineOptions) {
    this.#options = options;
    this.#strategies = {
      PROGRESSIVE: new ProgressiveDialer(),
      PREDICTIVE: new PredictiveDialer({
        minAnswerRate: options.config.predictive.minAnswerRate,
      }),
    };
    this.#safetyController = new SafetyController();

    // Releasing the emergency stop must actually bring stalled campaigns back, or the
    // control would be one-way in practice: the UI would show RUNNING campaigns that never
    // dial again.
    options.events.on('safety.emergency_resume', () => {
      this.resumeStalled();
    });

    // An agent returning is the other way a stood-down campaign becomes dialable again.
    // Without this the "no agents online" stand-down would be permanent, which is a worse
    // bug than the spinning it replaced.
    options.events.on('agent.available', () => {
      this.resumeStalled();
    });
  }

  /**
   * Restart campaigns that stood down for a now-resolved reason.
   *
   * Called when the emergency stop is released and when an operator resumes predictive
   * dialing after an abandon-rate pause.
   */
  resumeStalled(): void {
    for (const campaignId of [...this.#stalled]) {
      this.#stalled.delete(campaignId);
      const campaign = this.#options.campaigns.findById(campaignId);
      if (campaign?.status === 'RUNNING') this.start(campaignId);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Begin ticking a campaign.
   *
   * The tick timer is the only thing keeping the clock busy for a running campaign, which is
   * deliberate: when the campaign stops, the clock goes idle and a simulation terminates on
   * its own rather than needing an external stop signal.
   */
  start(campaignId: string): void {
    if (this.#ticking.has(campaignId)) return;
    this.#subscribeToProvider(campaignId);
    this.#scheduleTick(campaignId);
  }

  stop(campaignId: string): void {
    const timer = this.#ticking.get(campaignId);
    if (timer !== undefined) this.#options.clock.clearTimer(timer);
    this.#ticking.delete(campaignId);
    // A campaign that was deliberately stopped must not be revived by a later
    // emergency-stop release.
    this.#stalled.delete(campaignId);
  }

  isRunning(campaignId: string): boolean {
    return this.#ticking.has(campaignId);
  }

  /**
   * A snapshot of what the dialer is doing and why, for the dashboard.
   *
   * Returns the live pacing inputs alongside the most recent plan and its reasoning, so the
   * "current dialing rate / target concurrency / safety buffer" panel shows the numbers the
   * engine actually used rather than a recomputation that might disagree with it.
   */
  describeState(campaignId: string): {
    running: boolean;
    stalled: boolean;
    inFlight: number;
    awaitingAgent: number;
    snapshot: DialerSnapshot | null;
    lastPlan: {
      requested: number;
      approved: number;
      verdict: string;
      reasoning: readonly string[];
      safety: string;
      reductions: readonly { control: string; ceiling: number; from: number; to: number }[];
      at: number;
    } | null;
  } {
    const campaign = this.#options.campaigns.findById(campaignId);
    const recorded = this.#lastPlan.get(campaignId);
    return {
      running: this.#ticking.has(campaignId),
      stalled: this.#stalled.has(campaignId),
      inFlight: [...this.#inFlight.values()].filter((c) => c.campaignId === campaignId).length,
      awaitingAgent: this.#awaitingAgent.get(campaignId)?.length ?? 0,
      snapshot: campaign === null ? null : this.buildSnapshot(campaign),
      lastPlan:
        recorded === undefined
          ? null
          : {
              requested: recorded.plan.requested,
              approved: recorded.decision.approved,
              verdict: recorded.decision.verdict,
              reasoning: recorded.plan.reasoning,
              safety: recorded.decision.explanation,
              reductions: recorded.decision.reductions,
              at: recorded.at,
            },
    };
  }

  /**
   * Every safety rule currently denying this campaign, not just the first.
   *
   * Evaluated in read-only mode, so asking why a campaign is idle never consumes rate-limit
   * allowance — the question must not perturb the thing being asked about.
   */
  explainSafety(campaignId: string): readonly SafetyDecision[] {
    const campaign = this.#options.campaigns.findById(campaignId);
    if (campaign === null) return [];
    return this.#options.safety.explain(this.#safetyContext(campaign, null, null));
  }

  #scheduleTick(campaignId: string): void {
    const handle = this.#options.clock.setTimer(
      this.#options.config.dialer.tickIntervalMs,
      () => {
        this.#ticking.delete(campaignId);
        void this.#runTick(campaignId);
      },
      `dialer-tick:${campaignId}`,
    );
    this.#ticking.set(campaignId, handle);
  }

  async #runTick(campaignId: string): Promise<void> {
    let shouldContinue: boolean;
    try {
      shouldContinue = await this.tick(campaignId);
    } catch (error) {
      // A tick that throws must not silently stop the campaign with no explanation.
      this.#options.events.emit({
        type: 'dialer.tick',
        severity: 'error',
        message: `Dialer tick failed: ${error instanceof Error ? error.message : String(error)}`,
        campaignId,
        metadata: { error: String(error) },
      });
      shouldContinue = false;
    }
    if (shouldContinue) this.#scheduleTick(campaignId);
  }

  // ---------------------------------------------------------------------------
  // The tick
  // ---------------------------------------------------------------------------

  /**
   * Run one dialing cycle. Returns whether the campaign should keep ticking.
   *
   * Public so tests can drive the engine one deterministic step at a time rather than
   * through the timer loop.
   */
  async tick(campaignId: string): Promise<boolean> {
    const { clock, campaigns, contacts, events } = this.#options;
    const now = clock.now();

    const campaign = campaigns.findById(campaignId);
    if (campaign === null) return false;

    // Housekeeping first, so the snapshot the strategy sees is current: promote contacts
    // whose backoff elapsed, and reclaim any slot whose call went silent.
    contacts.promoteDueRetries(campaignId, now);
    this.#reclaimExpiredLeases();

    if (campaign.status !== 'RUNNING') {
      events.flush();
      return false;
    }

    // Evaluate the abandon threshold every tick, not only when an abandon happens.
    //
    // This ordering is load-bearing (BUG.md B-003). The safety engine *denies* dialing as
    // soon as the abandon rate is breached, which means no further calls are placed, which
    // means no further calls can be abandoned. If the durable pause were only latched from
    // the abandon handler it would never be reached: the campaign would sit RUNNING and
    // spin, denying every dial forever, with nothing in the UI explaining why.
    this.#checkAbandonThreshold(campaign);
    const current = campaigns.findById(campaignId) ?? campaign;

    // Stand down rather than spin. Both of these conditions require a deliberate operator
    // action to clear, so continuing to tick would burn cycles denying every dial — for
    // minutes on the dashboard, and forever in a simulation, which would never go idle and
    // so would never finish.
    // Conditions that provably prevent dialing and require something outside the engine to
    // change before it could resume. Ticking through them achieves nothing but noise.
    const blockedReason =
      current.predictivePausedReason !== null
        ? 'predictive dialing is paused by the abandon-rate control'
        : this.#options.isEmergencyStopped()
          ? 'the emergency stop is engaged'
          : this.#options.agentService.listByCampaign(campaignId).every(
                (agent) => agent.status === 'OFFLINE' || agent.status === 'PAUSED',
              )
            ? 'no agents are online'
            : null;

    if (blockedReason !== null && this.activeCallCount(campaignId) === 0) {
      this.#stalled.add(campaignId);
      events.emit({
        type: 'dialer.tick',
        severity: 'warn',
        message: `Dialer stood down: ${blockedReason}. It will resume when that is cleared.`,
        campaignId,
        metadata: { blockedReason },
      });
      events.flush();
      return false;
    }

    // Campaign-level gate, evaluated once per tick with no contact and no rate-limit
    // consumption. Without this, a campaign blocked for a reason that has nothing to do with
    // any particular contact would still reserve a contact, fail the same check, and release
    // it again — once per attempt, per tick. That churn is invisible in behaviour but floods
    // the event log and wastes the whole tick (BUG.md B-003).
    const gate = this.#campaignGate(current);
    if (!gate.allowed) {
      events.emit({
        type: 'safety.denied',
        severity: denialSeverity(gate.code),
        message: `DENIED: ${gate.message}`,
        campaignId,
        metadata: { rule: gate.rule, code: gate.code, ...gate.metadata },
      });
      events.flush();
      return true;
    }

    const snapshot = this.buildSnapshot(current);
    // Stage 1 — the pacing engine produces a REQUEST. It cannot clamp itself and has no
    // reference to any limit (DECISIONS.md D-018).
    const plan = this.#strategies[current.dialingMode].computeDialPlan(snapshot);

    // Stage 2 — the Safety Controller decides what is actually allowed. This is the only
    // path from a pacing number to an approved call count.
    const decision = this.#safetyController.review(
      {
        campaignId,
        mode: current.dialingMode,
        requested: plan.requested,
        reasoning: plan.reasoning,
      },
      this.#controllerContext(current, snapshot),
    );
    this.#lastPlan.set(campaignId, { plan, decision, at: snapshot.now });

    events.emit({
      type: 'dialer.plan',
      severity: 'debug',
      message:
        `${campaign.dialingMode} pacing requested ${plan.requested}; ` +
        `safety controller ${decision.verdict} ${decision.approved}`,
      campaignId,
      metadata: {
        requested: plan.requested,
        approved: decision.approved,
        verdict: decision.verdict,
        safetyExplanation: decision.explanation,
        reductions: decision.reductions,
        reasoning: plan.reasoning,
        availableAgents: snapshot.availableAgents,
        pendingConnections: snapshot.pendingConnections,
      },
    });

    const denials: SafetyDecision[] = [];
    let dialled = 0;
    const claimedThisTick: string[] = [];

    // Stage 3 — the allocator acts on the APPROVED number, never the requested one.
    for (let i = 0; i < decision.approved; i += 1) {
      const outcome = await this.#attemptDial(current, claimedThisTick);
      if (outcome.kind === 'dialled') {
        dialled += 1;
        continue;
      }
      if (outcome.kind === 'denied') denials.push(outcome.decision);
      // A denial or an empty pool applies to every remaining attempt this tick, so stop
      // rather than hammering the same rule N times and filling the event log.
      break;
    }

    // Recorded rather than discarded: "the plan asked for 5 and 2 were placed, because the
    // rate limiter denied the third" is the question an operator actually asks when a
    // campaign looks slower than expected.
    if (dialled > 0 || denials.length > 0) {
      events.emit({
        type: 'dialer.tick',
        severity: 'debug',
        message: `Tick placed ${dialled} of ${decision.approved} approved call(s)`,
        campaignId,
        metadata: {
          requested: plan.requested,
          approved: decision.approved,
          verdict: decision.verdict,
          dialled,
          denials: denials.map((denial) => denial.code),
        },
      });
    }

    events.flush();

    if (this.#isCampaignComplete(campaignId)) {
      this.#completeCampaign(current);
      return false;
    }

    return true;
  }

  /**
   * Assemble the immutable snapshot a strategy reasons over.
   *
   * Every input the pacing algorithms may use appears here explicitly — which is the point:
   * a strategy cannot quietly depend on something that is not in this type.
   */
  buildSnapshot(campaign: Campaign): DialerSnapshot {
    const { clock, agents, calls, concurrency, metrics, rateLimiters, config } = this.#options;

    const agentRows = agents.listByCampaign(campaign.id);
    const availableAgents = agentRows.filter((agent) => agent.status === 'AVAILABLE').length;
    const occupiedAgents = agentRows.filter((agent) => isAgentOccupied(agent.status)).length;

    const activeCalls = concurrency.activeForCampaign(campaign.id);
    let connectedCalls = 0;
    let pendingConnections = 0;
    for (const context of this.#inFlight.values()) {
      if (context.campaignId !== campaign.id) continue;
      if (context.status === 'CONNECTED' || context.status === 'ON_HOLD') connectedCalls += 1;
      else pendingConnections += 1;
    }

    // Deliberately NOT `metrics.campaignMetrics()`: that bundle aggregates the events table,
    // which grows for the whole run, so calling it once per tick made every tick slower than
    // the last (BUG.md B-002). The snapshot needs one number from the database, so it asks
    // for exactly that.
    const answers = calls.answerStatistics(campaign.id);
    const historicalAnswerRate = answers.finished === 0 ? 0 : answers.answered / answers.finished;
    const recent = metrics.recentAnswerRate(campaign.id);
    const abandon = metrics.abandonRate(campaign.id);

    return {
      now: clock.now(),
      campaign,
      totalAgents: agentRows.length,
      availableAgents,
      occupiedAgents,
      activeCalls,
      // Calls that could still connect and would then need a seat. Counting only connected
      // calls here would turn a progressive dialer into an accidental predictive one.
      // Derived from the in-flight map alone. It used to be `ledgerActiveCalls -
      // connectedCalls` — two different sources subtracted from each other, which went
      // *negative* whenever a lease was released while its call was still in flight. The
      // pacer subtracts this value, so a negative one silently *added* phantom capacity: with
      // one free agent it approved ten calls (BUG.md B-015). Clamped as well as unified,
      // because a count of things in flight has no meaningful negative value.
      pendingConnections: Math.max(0, pendingConnections),
      connectedCalls,
      historicalAnswerRate,
      recentAnswerRate: recent.rate,
      recentSample: recent.sample,
      abandonRate: abandon.rate,
      abandonSample: abandon.sample,
      campaignHeadroom: campaign.maxConcurrentCalls - activeCalls,
      globalHeadroom: config.limits.globalMaxConcurrentCalls - concurrency.activeGlobal,
      providerHeadroom:
        config.limits.providerMaxConcurrentCalls - concurrency.activeForProvider(campaign.providerId),
      rateLimitHeadroom: Math.floor(
        rateLimiters.forCampaign(campaign.id, campaign.maxCallsPerSecond).available,
      ),
      remainingContacts: this.#options.contacts.readyCount(campaign.id),
    };
  }

  /**
   * Evaluate the campaign-wide safety rules once, with no contact and without consuming
   * rate-limit allowance. Contact-specific rules are still evaluated per dial in
   * `#attemptDial`; this only avoids reserving a contact when the campaign as a whole is
   * not permitted to dial at all.
   */
  /**
   * Assemble what the Safety Controller reasons over.
   *
   * Built here rather than inside the controller so the controller stays a pure function of
   * its input — which is what makes its four verdicts directly unit-testable without a
   * database, a clock or a provider.
   */
  #controllerContext(campaign: Campaign, snapshot: DialerSnapshot): SafetyControllerContext {
    const providerMetrics = this.#options.getProvider(campaign.providerId).metrics();
    const providerFailureRate =
      providerMetrics.requests === 0
        ? 0
        : (providerMetrics.rejected + providerMetrics.silent) / providerMetrics.requests;

    return {
      campaign,
      emergencyStopped: this.#options.isEmergencyStopped(),
      availableAgents: snapshot.availableAgents,
      pendingConnections: snapshot.pendingConnections,
      campaignHeadroom: snapshot.campaignHeadroom,
      globalHeadroom: snapshot.globalHeadroom,
      providerHeadroom: snapshot.providerHeadroom,
      rateLimitHeadroom: snapshot.rateLimitHeadroom,
      remainingContacts: snapshot.remainingContacts,
      abandonRate: snapshot.abandonRate,
      abandonSample: snapshot.abandonSample,
      answerRateSample: snapshot.recentSample,
      providerFailureRate,
      // Blended the same way the pacer blends it, and floored, so the controller's bound is
      // computed from the same belief about the world rather than a different one.
      estimatedAnswerRate: Math.max(
        this.#options.config.predictive.minAnswerRate,
        snapshot.recentSample === 0
          ? 0.9
          : snapshot.historicalAnswerRate * 0.3 + snapshot.recentAnswerRate * 0.7,
      ),
    };
  }

  #campaignGate(campaign: Campaign): SafetyDecision {
    return this.#options.safety.canInitiateCall(this.#safetyContext(campaign, null, null));
  }

  /**
   * Assemble the context the safety engine reasons over.
   *
   * Shared by the per-tick campaign gate, the per-dial check and the dashboard's
   * explanation endpoint. Building it in one place is what guarantees all three are judging
   * the campaign against the same facts — three hand-rolled copies would eventually
   * disagree, and the one that disagreed would be the one making the real decision.
   *
   * `rateLimiter` is null for read-only evaluations, so asking a question never consumes
   * allowance the campaign would otherwise have spent on a real call.
   */
  #safetyContext(
    campaign: Campaign,
    contact: Contact | null,
    rateLimiter: SafetyRateLimiter | null,
  ): SafetyContext {
    const { concurrency, config, metrics, agentService, clock } = this.#options;
    return {
      now: clock.now(),
      campaign,
      contact,
      emergencyStopped: this.#options.isEmergencyStopped(),
      concurrency: {
        global: concurrency.activeGlobal,
        globalMax: config.limits.globalMaxConcurrentCalls,
        campaign: concurrency.activeForCampaign(campaign.id),
        provider: concurrency.activeForProvider(campaign.providerId),
        providerMax: config.limits.providerMaxConcurrentCalls,
      },
      agents: {
        available: agentService.availableCount(campaign.id),
        pendingConnections: this.#pendingConnections(campaign.id),
      },
      abandon: metrics.abandonRate(campaign.id),
      rateLimiter,
    };
  }

  // ---------------------------------------------------------------------------
  // Placing one call
  // ---------------------------------------------------------------------------

  async #attemptDial(
    campaign: Campaign,
    claimedThisTick: string[],
  ): Promise<
    | { kind: 'dialled' }
    | { kind: 'denied'; decision: SafetyDecision }
    | { kind: 'no-contact' }
    | { kind: 'error' }
  > {
    const { clock, contacts, concurrency, safety, rateLimiters, events, ids, config } =
      this.#options;
    const now = clock.now();

    // 1. Claim the contact first. Nothing expensive or asynchronous happens before this, so
    //    two workers cannot both be working on the same person.
    const contact = contacts.reserveNext(campaign.id, now, claimedThisTick);
    if (contact === null) return { kind: 'no-contact' };
    claimedThisTick.push(contact.id);

    events.emit({
      type: 'contact.reserved',
      severity: 'debug',
      message: `Contact reserved for dialing`,
      campaignId: campaign.id,
      contactId: contact.id,
      metadata: { attemptCount: contact.attemptCount },
    });

    // 2. Safety. Evaluated after reservation because some rules are about this contact.
    //    This is the only evaluation that passes a live rate limiter, so it is the only one
    //    that spends allowance.
    const decision = safety.canInitiateCall(
      this.#safetyContext(campaign, contact, {
        tryConsume: () => rateLimiters.tryConsume(campaign.id, campaign.maxCallsPerSecond),
        available: () => rateLimiters.forCampaign(campaign.id, campaign.maxCallsPerSecond).available,
      }),
    );

    if (!decision.allowed) {
      this.#releaseContact(contact, now);
      events.emit({
        type: 'safety.denied',
        severity: denialSeverity(decision.code),
        message: `DENIED: ${decision.message}`,
        campaignId: campaign.id,
        contactId: contact.id,
        metadata: { rule: decision.rule, code: decision.code, ...decision.metadata },
      });
      return { kind: 'denied', decision };
    }

    // 3. Reserve the concurrency slot BEFORE creating the provider call. This ordering is
    //    what prevents two scheduler workers from observing the same available capacity and
    //    both proceeding — the acquisition is synchronous and all-or-nothing.
    const acquisition = concurrency.tryAcquire({
      callId: 'pending',
      campaignId: campaign.id,
      providerId: campaign.providerId,
      campaignMaxConcurrentCalls: campaign.maxConcurrentCalls,
      // The lease must outlive the provider watchdog, or the sweep would reclaim slots for
      // calls that are still legitimately running.
      // The lease is the backstop for a *lost watchdog*, so it must outlive the longest call
      // the watchdog itself would tolerate — setup plus conversation, with margin. It was
      // `providerTimeoutMs * 2` (90s), which is shorter than a 180-second conversation: every
      // long call had its slot reclaimed mid-conversation while the call was still live
      // (BUG.md B-015).
      ttlMs: (config.dialer.providerTimeoutMs + config.dialer.maxCallDurationMs) * 2,
    });

    if (!acquisition.ok) {
      this.#releaseContact(contact, now);
      const denial: SafetyDecision = {
        allowed: false,
        rule: 'concurrency-acquire',
        code: acquisition.code,
        message: acquisition.message,
        metadata: acquisition.metadata,
      };
      events.emit({
        type: 'safety.limit_reached',
        message: `DENIED: ${acquisition.message}`,
        campaignId: campaign.id,
        contactId: contact.id,
        metadata: { code: acquisition.code, ...acquisition.metadata },
      });
      return { kind: 'denied', decision: denial };
    }

    // 4. Persist the call and its attempt.
    const callId = ids.next(ID_PREFIX.call);
    const attemptId = ids.next(ID_PREFIX.attempt);
    const attemptNumber = contact.attemptCount + 1;

    this.#options.calls.createCallWithAttempt({
      callId,
      attemptId,
      campaignId: campaign.id,
      contactId: contact.id,
      providerId: campaign.providerId,
      attemptNumber,
      now,
    });
    contacts.recordAttempt(contact.id, now);
    contacts.updateStatus(contact.id, 'RESERVED', 'DIALING', now);

    const context: CallContext = {
      callId,
      attemptId,
      contactId: contact.id,
      campaignId: campaign.id,
      providerId: campaign.providerId,
      attemptNumber,
      lease: acquisition.lease,
      providerCallId: null,
      agentId: null,
      status: 'CREATED',
      answeredAt: null,
      watchdog: null,
      abandonTimer: null,
      settled: false,
    };
    this.#inFlight.set(callId, context);
    this.#adjustPending(context.campaignId, 1);

    events.emit({
      type: 'call.created',
      message: `Call created for ${redactPhoneNumber(contact.phoneNumber)}`,
      campaignId: campaign.id,
      contactId: contact.id,
      callId,
      providerId: campaign.providerId,
      metadata: { attemptNumber },
    });
    events.emit({
      type: 'contact.attempted',
      severity: 'debug',
      message: `Attempt ${attemptNumber} for contact`,
      campaignId: campaign.id,
      contactId: contact.id,
      callId,
      metadata: { attemptNumber },
    });

    this.#transitionCall(context, 'QUEUED');

    // 5. Arm the watchdog before the provider is called, so a provider that never responds
    //    at all is still covered.
    this.#armWatchdog(context);

    // 6. Hand it to the provider.
    try {
      const provider = this.#options.getProvider(campaign.providerId);
      const handle = await provider.createCall({
        callId,
        campaignId: campaign.id,
        phoneNumber: contact.phoneNumber,
      });

      context.providerCallId = handle.providerCallId;
      this.#byProviderCallId.set(handle.providerCallId, callId);
      this.#options.calls.setProviderCallId(callId, handle.providerCallId);
      return { kind: 'dialled' };
    } catch (error) {
      this.#handleCreateCallFailure(context, campaign, error);
      return { kind: 'error' };
    }
  }

  #releaseContact(contact: Contact, now: number): void {
    this.#options.contacts.releaseReservation(contact.id, now);
    this.#options.events.emit({
      type: 'contact.released',
      severity: 'debug',
      message: 'Contact reservation released',
      campaignId: contact.campaignId,
      contactId: contact.id,
    });
  }

  #handleCreateCallFailure(context: CallContext, campaign: Campaign, error: unknown): void {
    const providerError = error instanceof ProviderCallError ? error : null;
    const code = isSmartDialerError(error) ? error.code : ERROR_CODES.PROVIDER_ERROR;
    const transient = providerError?.transient ?? true;

    this.#options.events.emit({
      type: 'provider.error',
      severity: 'warn',
      message: `Provider rejected the call: ${error instanceof Error ? error.message : String(error)}`,
      campaignId: campaign.id,
      contactId: context.contactId,
      callId: context.callId,
      providerId: context.providerId,
      metadata: { code, transient },
    });

    this.#settle(context, {
      campaign,
      outcome: 'FAILED',
      callStatus: 'FAILED',
      failureCode: code,
      failureClass: transient ? 'TRANSIENT' : 'PERMANENT',
    });
  }

  // ---------------------------------------------------------------------------
  // Provider events
  // ---------------------------------------------------------------------------

  #subscribeToProvider(campaignId: string): void {
    const campaign = this.#options.campaigns.findById(campaignId);
    if (campaign === null) return;
    if (this.#providerSubscriptions.has(campaign.providerId)) return;

    const provider = this.#options.getProvider(campaign.providerId);
    const unsubscribe = provider.onEvent((event) => {
      this.handleProviderEvent(event);
    });
    this.#providerSubscriptions.set(campaign.providerId, unsubscribe);
  }

  /** Public so tests can inject provider events directly. */
  handleProviderEvent(event: ProviderEvent): void {
    const callId = this.#byProviderCallId.get(event.providerCallId) ?? event.callId;
    const context = this.#inFlight.get(callId);
    // A call that already settled (watchdog fired, campaign stopped) may still receive a
    // late provider event. Ignoring it is correct — but only because settling already
    // released everything this event would have released.
    if (context === undefined || context.settled) return;

    const campaign = this.#options.campaigns.findById(context.campaignId);
    if (campaign === null) return;

    switch (event.type) {
      case 'call.dialing':
        this.#transitionCall(context, 'DIALING');
        break;
      case 'call.ringing':
        this.#transitionCall(context, 'RINGING');
        break;
      case 'call.answered':
        this.#handleAnswered(context, campaign);
        break;
      case 'call.completed':
        this.#handleCompleted(context, campaign, event);
        break;
      case 'call.no_answer':
        this.#settle(context, {
          campaign,
          outcome: 'NO_ANSWER',
          callStatus: 'NO_ANSWER',
          failureCode: null,
          failureClass: 'TRANSIENT',
        });
        break;
      case 'call.busy':
        this.#settle(context, {
          campaign,
          outcome: 'BUSY',
          callStatus: 'BUSY',
          failureCode: null,
          failureClass: 'TRANSIENT',
        });
        break;
      case 'call.failed':
        this.#settle(context, {
          campaign,
          outcome: 'FAILED',
          callStatus: 'FAILED',
          failureCode: event.code ?? ERROR_CODES.PROVIDER_ERROR,
          failureClass: event.transient === false ? 'PERMANENT' : 'TRANSIENT',
        });
        break;
    }
  }

  /**
   * Someone picked up.
   *
   * From here the clock is running on a real person's patience. Either an agent is put on
   * the call now, or it joins the queue with a hard deadline — and if that deadline passes
   * the call is abandoned, which is the harm the abandon-rate control measures.
   */
  #handleAnswered(context: CallContext, campaign: Campaign): void {
    // The idempotency guard. A provider that retries a webhook delivers ANSWERED two or three
    // times; only the delivery that actually moves the call may allocate an agent. Without
    // this check every redelivery pulled another agent out of the pool for a conversation
    // that already had one — three agents for one call (BUG.md B-010).
    const wasPending = context.status !== 'CONNECTED' && context.status !== 'ON_HOLD';
    if (!this.#transitionCall(context, 'CONNECTED')) return;
    if (wasPending) this.#adjustPending(context.campaignId, -1);
    context.answeredAt = this.#options.clock.now();

    // The call has entered its conversation phase, where silence is expected. Re-arm against
    // the call-duration ceiling rather than the setup timeout (B-012).
    this.#armWatchdog(context);

    this.#options.events.emit({
      type: 'call.answered',
      message: 'Call answered',
      campaignId: campaign.id,
      contactId: context.contactId,
      callId: context.callId,
    });

    if (this.#assignAgent(context, campaign)) return;

    // No free agent. Queue the call and start the abandon countdown.
    const queue = this.#awaitingAgent.get(campaign.id) ?? [];
    queue.push(context.callId);
    this.#awaitingAgent.set(campaign.id, queue);

    context.abandonTimer = this.#options.clock.setTimer(
      campaign.safety.abandonTimeoutMs,
      () => this.#abandon(context, campaign),
      `abandon:${context.callId}`,
    );
  }

  #assignAgent(context: CallContext, campaign: Campaign): boolean {
    const agent = this.#options.agentService.reserveForCall(campaign.id, context.callId);
    if (agent === null) return false;

    context.agentId = agent.id;
    this.#options.calls.assignAgent(context.callId, agent.id);
    this.#options.agentService.connect(agent.id, context.callId);

    if (context.abandonTimer !== null) {
      this.#options.clock.clearTimer(context.abandonTimer);
      context.abandonTimer = null;
    }
    this.#dequeueAwaiting(campaign.id, context.callId);
    return true;
  }

  /**
   * Try to place queued calls onto a freed agent.
   *
   * Called whenever an agent becomes available. Oldest waiting call first — the one closest
   * to its abandon deadline is the one most worth saving.
   */
  #serviceAwaitingQueue(campaignId: string): void {
    const queue = this.#awaitingAgent.get(campaignId);
    if (queue === undefined || queue.length === 0) return;

    const campaign = this.#options.campaigns.findById(campaignId);
    if (campaign === null) return;

    for (const callId of [...queue]) {
      const context = this.#inFlight.get(callId);
      if (context === undefined || context.settled) {
        this.#dequeueAwaiting(campaignId, callId);
        continue;
      }
      if (!this.#assignAgent(context, campaign)) return; // No more free agents.
    }
  }

  #dequeueAwaiting(campaignId: string, callId: string): void {
    const queue = this.#awaitingAgent.get(campaignId);
    if (queue === undefined) return;
    const index = queue.indexOf(callId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#awaitingAgent.delete(campaignId);
  }

  #abandon(context: CallContext, campaign: Campaign): void {
    if (context.settled) return;
    this.#dequeueAwaiting(campaign.id, context.callId);
    context.abandonTimer = null;

    // No `call.abandoned` emission here: `#settle` emits it from EVENT_FOR_OUTCOME, and
    // doing both logged every abandonment twice — which matters because this is the metric
    // the compliance story rests on, and a doubled event log is a doubled apparent problem
    // (BUG.md B-014).
    this.#options.calls.markAbandoned(context.callId);

    // Hang up on the provider side too, or the mock keeps a slot occupied for a call nobody
    // is on.
    void this.#cancelProviderCall(context);

    this.#settle(context, {
      campaign,
      outcome: 'ABANDONED',
      callStatus: 'ENDED',
      failureCode: null,
      failureClass: 'TRANSIENT',
      abandoned: true,
    });

    this.#checkAbandonThreshold(campaign);
  }

  /**
   * Pause predictive dialing if abandonment has crossed the configured threshold.
   *
   * Requires an explicit resume. The system deliberately does not un-pause itself: whatever
   * caused the abandonment is still true, and auto-resuming would produce exactly the
   * sawtooth of harm the threshold exists to prevent.
   */
  #checkAbandonThreshold(campaign: Campaign): void {
    if (campaign.dialingMode !== 'PREDICTIVE') return;
    if (campaign.predictivePausedReason !== null) return;

    // Acts on the Wilson lower bound rather than the raw rate and a fixed minimum sample.
    // Waiting for 20 samples meant up to 20 people heard silence before the control engaged
    // — in the assignment's 70%-answer-rate scenario it fired 22 seconds and 13 abandons
    // late (BUG.md B-013). The bound reacts as soon as the evidence is strong, whatever the
    // sample size, and stays quiet when it is not.
    const abandon = this.#options.metrics.abandonRate(campaign.id);
    const bound = this.#options.metrics.abandonRateLowerBound(campaign.id);
    if (abandon.sample === 0) return;
    if (bound.rate <= campaign.maxAbandonRate) return;

    const reason =
      `abandon rate ${(abandon.rate * 100).toFixed(1)}% over ${abandon.sample} answered calls ` +
      `(95% lower bound ${(bound.rate * 100).toFixed(1)}%) exceeded the maximum ` +
      `${(campaign.maxAbandonRate * 100).toFixed(1)}%`;

    this.#options.campaigns.setPredictivePausedReason(campaign.id, reason, this.#options.clock.now());
    this.#options.events.emit({
      type: 'safety.abandon_threshold_exceeded',
      severity: 'error',
      message: `Predictive dialing paused: ${reason}`,
      campaignId: campaign.id,
      metadata: {
        abandonRate: abandon.rate,
        maxAbandonRate: campaign.maxAbandonRate,
        sample: abandon.sample,
        requiresExplicitResume: true,
      },
    });
  }

  #handleCompleted(context: CallContext, campaign: Campaign, event: ProviderEvent): void {
    const talkDurationMs =
      typeof event.metadata?.['talkDurationMs'] === 'number'
        ? (event.metadata['talkDurationMs'] as number)
        : context.answeredAt === null
          ? null
          : this.#options.clock.now() - context.answeredAt;

    this.#settle(context, {
      campaign,
      outcome: 'ANSWERED',
      callStatus: 'ENDED',
      failureCode: null,
      failureClass: 'NONE',
      talkDurationMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Timeouts
  // ---------------------------------------------------------------------------

  /**
   * Arm (or re-arm) the stuck-call watchdog for the phase the call is now in.
   *
   * Two phases, two very different timeouts, and conflating them was a real bug (B-012):
   *
   *   setup      created -> answered.  A provider that has not rung or answered within
   *                                    `providerTimeoutMs` has gone silent on us.
   *   conversation  answered -> ended. Silence here is *expected* — nothing is emitted while
   *                                    two people talk — so the only sensible bound is a
   *                                    generous ceiling on call length.
   *
   * Measuring a conversation against the setup timeout killed every call longer than 45
   * seconds and reported it as a provider failure. It went unnoticed because the default
   * simulated talk time was 25 seconds; the assignment's 120s and 180s scenarios exposed it
   * immediately.
   */
  #armWatchdog(context: CallContext): void {
    if (context.watchdog !== null) this.#options.clock.clearTimer(context.watchdog);

    const connected = context.status === 'CONNECTED' || context.status === 'ON_HOLD';
    const timeout = connected
      ? this.#options.config.dialer.maxCallDurationMs
      : this.#options.config.dialer.providerTimeoutMs;

    context.watchdog = this.#options.clock.setTimer(
      timeout,
      () => this.#onTimeout(context),
      `watchdog:${connected ? 'conversation' : 'setup'}:${context.callId}`,
    );
  }

  /**
   * The provider never reported a terminal outcome.
   *
   * Everything this call holds must be released here: the concurrency slot, the agent if one
   * was assigned, and the contact's eligibility for a retry. Without this a single silent
   * call permanently costs a seat and a slot, and enough of them deadlock the campaign with
   * work still to do.
   */
  #onTimeout(context: CallContext): void {
    if (context.settled) return;
    const campaign = this.#options.campaigns.findById(context.campaignId);
    if (campaign === null) return;

    this.#options.events.emit({
      type: 'provider.timeout',
      severity: 'warn',
      message: `Provider did not report an outcome within ${this.#options.config.dialer.providerTimeoutMs}ms`,
      campaignId: campaign.id,
      contactId: context.contactId,
      callId: context.callId,
      providerId: context.providerId,
      metadata: { lastStatus: context.status },
    });

    void this.#cancelProviderCall(context);

    this.#settle(context, {
      campaign,
      outcome: 'TIMEOUT',
      callStatus: 'TIMEOUT',
      failureCode: ERROR_CODES.PROVIDER_TIMEOUT,
      failureClass: 'TRANSIENT',
    });
  }

  async #cancelProviderCall(context: CallContext): Promise<void> {
    if (context.providerCallId === null) return;
    try {
      await this.#options.getProvider(context.providerId).cancelCall(context.providerCallId);
    } catch (error) {
      // Cancellation is best-effort — the call is being torn down regardless. Recorded
      // rather than swallowed.
      this.#options.logger.warn('Provider cancel failed', {
        callId: context.callId,
        provider: context.providerId,
        error: String(error),
      });
    }
  }

  /** Reclaim slots whose leases outlived their call entirely. */
  #reclaimExpiredLeases(): void {
    for (const lease of this.#options.concurrency.sweepExpired()) {
      this.#options.events.emit({
        type: 'safety.limit_reached',
        severity: 'error',
        message: 'Reclaimed a leaked concurrency slot',
        campaignId: lease.campaignId,
        callId: lease.callId,
        metadata: { leaseId: lease.id, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt },
      });

      // Reclaiming the slot means we have given up on this call, so the call must be given up
      // on too. Releasing the lease while leaving the context alive left the ledger and the
      // in-flight map describing different worlds — which is precisely the divergence the
      // invariant checker exists to catch, and which fed a negative `pendingConnections`
      // straight into the pacer (BUG.md B-015).
      const context = this.#inFlight.get(lease.callId);
      if (context === undefined || context.settled) continue;

      const campaign = this.#options.campaigns.findById(context.campaignId);
      if (campaign === null) continue;

      void this.#cancelProviderCall(context);
      this.#settle(context, {
        campaign,
        outcome: 'TIMEOUT',
        callStatus: 'TIMEOUT',
        failureCode: ERROR_CODES.PROVIDER_TIMEOUT,
        failureClass: 'TRANSIENT',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Settling a call
  // ---------------------------------------------------------------------------

  /**
   * Terminate a call and release everything it holds, exactly once.
   *
   * The `settled` flag is what makes this safe to reach from several directions at once — a
   * provider event and a watchdog can both fire for the same call, and releasing its lease
   * or its agent twice would corrupt capacity.
   */
  #settle(
    context: CallContext,
    input: {
      campaign: Campaign;
      outcome: CallOutcome;
      callStatus: CallStatus;
      failureCode: string | null;
      failureClass: FailureClass;
      talkDurationMs?: number | null;
      abandoned?: boolean;
    },
  ): void {
    if (context.settled) return;

    // Check the terminal transition is reachable BEFORE committing to settle.
    //
    // An out-of-order delivery can try to settle a call into a state it cannot reach — a
    // stale NO_ANSWER for a call that has since connected, say. That event is describing an
    // outcome that did not happen, and the call is fine. Committing first and discovering the
    // illegality afterwards is what produces the worst failure in this system: the lease is
    // released while the call row stays active, and the in-memory ledger silently disagrees
    // with the database (BUG.md B-001, and again as B-010).
    //
    // Terminal states reachable from every in-flight state — TIMEOUT, CANCELLED — are
    // deliberately always legal, so the watchdog and campaign-stop paths can never be
    // blocked by this check.
    if (
      context.status !== input.callStatus &&
      !callStateMachine.can(context.status, input.callStatus)
    ) {
      this.#options.events.emit({
        type: 'call.failed',
        severity: 'warn',
        message: `Ignored stale ${input.outcome} for a call already ${context.status}`,
        campaignId: context.campaignId,
        contactId: context.contactId,
        callId: context.callId,
        metadata: { from: context.status, attempted: input.callStatus, outcome: input.outcome },
      });
      return;
    }

    context.settled = true;

    const { clock, calls, concurrency, events, metrics, agentService } = this.#options;
    const now = clock.now();

    if (context.watchdog !== null) {
      clock.clearTimer(context.watchdog);
      context.watchdog = null;
    }
    if (context.abandonTimer !== null) {
      clock.clearTimer(context.abandonTimer);
      context.abandonTimer = null;
    }
    this.#dequeueAwaiting(context.campaignId, context.callId);

    this.#transitionCall(context, input.callStatus);

    calls.finalize({
      callId: context.callId,
      attemptId: context.attemptId,
      outcome: input.outcome,
      failureCode: input.failureCode,
      failureClass: input.failureClass,
      endedAt: now,
      talkDurationMs: input.talkDurationMs ?? null,
    });

    // Release the agent before the slot: the agent is the scarcer resource and the one whose
    // idleness is immediately visible.
    if (context.agentId !== null) {
      const handleTime =
        input.outcome === 'ANSWERED' && context.answeredAt !== null ? now - context.answeredAt : null;
      agentService.release(context.agentId, handleTime);
    }

    concurrency.release(context.lease);
    if (context.status !== 'CONNECTED' && context.status !== 'ON_HOLD') {
      this.#adjustPending(context.campaignId, -1);
    }
    this.#inFlight.delete(context.callId);
    if (context.providerCallId !== null) this.#byProviderCallId.delete(context.providerCallId);

    metrics.recordOutcome(context.campaignId, {
      answered: input.outcome === 'ANSWERED' || input.abandoned === true,
      abandoned: input.abandoned === true,
    });

    events.emit({
      type: EVENT_FOR_OUTCOME[input.outcome],
      severity: input.outcome === 'ANSWERED' ? 'info' : 'info',
      message: `Call ${input.outcome.toLowerCase().replace('_', ' ')}`,
      campaignId: context.campaignId,
      contactId: context.contactId,
      callId: context.callId,
      agentId: context.agentId ?? undefined,
      metadata: {
        outcome: input.outcome,
        failureCode: input.failureCode,
        talkDurationMs: input.talkDurationMs ?? null,
      },
    });

    this.#resolveContact(context, input);

    // A freed agent may be exactly what a queued answered call is waiting for.
    this.#serviceAwaitingQueue(context.campaignId);
  }

  /** Decide the contact's fate: retry, exhausted, or done. */
  #resolveContact(
    context: CallContext,
    input: { campaign: Campaign; outcome: CallOutcome; failureCode: string | null; failureClass: FailureClass },
  ): void {
    const { clock, contacts, calls, events, retry } = this.#options;
    const now = clock.now();

    const contact = contacts.findById(context.contactId);
    if (contact === null) return;

    // A contact marked DO_NOT_CALL mid-call must not be resurrected by retry logic.
    if (contact.status === 'DO_NOT_CALL') return;

    if (input.outcome === 'ANSWERED') {
      contacts.setStatus(context.contactId, 'COMPLETED', now);
      return;
    }

    const failureClass =
      input.failureClass === 'NONE'
        ? classifyFailure({ outcome: input.outcome, failureCode: input.failureCode })
        : input.failureClass;

    const decision = retry.decide({
      campaign: input.campaign,
      failureClass,
      failureCode: input.failureCode,
      attemptCount: contact.attemptCount,
      now,
    });

    if (decision.retry && decision.nextAttemptAt !== null) {
      contacts.scheduleRetry(context.contactId, decision.nextAttemptAt, now);
      calls.setRetryScheduled(context.attemptId, decision.nextAttemptAt);
      events.emit({
        type: 'retry.scheduled',
        message: decision.reason,
        campaignId: context.campaignId,
        contactId: context.contactId,
        callId: context.callId,
        metadata: {
          nextAttemptAt: decision.nextAttemptAt,
          delayMs: decision.delayMs,
          attemptsUsed: decision.attemptsUsed,
          maxAttempts: decision.maxAttempts,
          failureClass,
        },
      });
      return;
    }

    contacts.setStatus(context.contactId, 'EXHAUSTED', now);
    events.emit({
      type: 'retry.exhausted',
      severity: 'info',
      message: decision.reason,
      campaignId: context.campaignId,
      contactId: context.contactId,
      callId: context.callId,
      metadata: {
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
        failureClass,
        failureCode: input.failureCode,
      },
    });
    events.emit({
      type: 'contact.exhausted',
      severity: 'debug',
      message: 'Contact will not be dialled again',
      campaignId: context.campaignId,
      contactId: context.contactId,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Move a call, reporting whether the move actually happened.
   *
   * The return value is the idempotency signal, and callers **must** honour it. A duplicate
   * ANSWERED finds the call already CONNECTED and returns false; a caller that ignored that
   * and carried on with the side effects would reserve a second agent for a conversation
   * that already has one (BUG.md B-010).
   */
  #transitionCall(context: CallContext, to: CallStatus): boolean {
    // Already there. A redelivered event, not a new fact.
    if (context.status === to) return false;
    if (!callStateMachine.can(context.status, to)) {
      // Not thrown: a provider may legitimately report events out of order or late, and a
      // hard failure here would take down a whole campaign for one odd event. Recorded so it
      // is visible rather than silent (CONSTRAINTS.md §3).
      this.#options.events.emit({
        type: 'call.failed',
        severity: 'warn',
        message: `Ignored illegal call transition ${context.status} -> ${to}`,
        campaignId: context.campaignId,
        callId: context.callId,
        metadata: { from: context.status, to },
      });
      return false;
    }

    const now = this.#options.clock.now();
    // Compare-and-set against the state we believe the call is in. If another delivery of
    // the same event got here first, this changes zero rows and we must not proceed.
    const applied = this.#options.calls.updateStatus(context.callId, context.status, to, now);
    if (!applied) return false;
    const from = context.status;
    context.status = to;

    const eventType = EVENT_FOR_CALL_STATUS[to];
    if (eventType !== undefined) {
      this.#options.events.emit({
        type: eventType,
        severity: 'debug',
        message: `Call ${to.toLowerCase()}`,
        campaignId: context.campaignId,
        contactId: context.contactId,
        callId: context.callId,
        metadata: { from, to },
      });
    }

    // Contact status mirrors the call for the states they share, so the contacts view shows
    // what is actually happening rather than a stale RESERVED.
    const contactStatus = CONTACT_STATUS_FOR_CALL_STATUS[to];
    if (contactStatus !== undefined) {
      this.#options.contacts.setStatus(context.contactId, contactStatus, now);
    }
    return true;
  }

  #pendingConnections(campaignId: string): number {
    return this.#pendingByCampaign.get(campaignId) ?? 0;
  }

  #adjustPending(campaignId: string, delta: number): void {
    const next = (this.#pendingByCampaign.get(campaignId) ?? 0) + delta;
    if (next <= 0) this.#pendingByCampaign.delete(campaignId);
    else this.#pendingByCampaign.set(campaignId, next);
  }

  /**
   * Recompute the counter from scratch and compare. An incrementally maintained count that
   * silently drifts would under-report calls in flight, which is the input the pacer uses to
   * avoid over-dialing — so the cheap version is verified against the honest one in tests.
   */
  pendingConnectionsAudit(campaignId: string): { counter: number; scanned: number } {
    let scanned = 0;
    for (const context of this.#inFlight.values()) {
      if (context.campaignId !== campaignId) continue;
      if (context.status !== 'CONNECTED' && context.status !== 'ON_HOLD') scanned += 1;
    }
    return { counter: this.#pendingConnections(campaignId), scanned };
  }

  #isCampaignComplete(campaignId: string): boolean {
    if (this.#options.contacts.remainingCount(campaignId) > 0) return false;
    return this.#options.concurrency.activeForCampaign(campaignId) === 0;
  }

  #completeCampaign(campaign: Campaign): void {
    const now = this.#options.clock.now();
    this.#options.campaigns.updateStatus(campaign.id, 'RUNNING', 'COMPLETED', now);
    this.stop(campaign.id);
    this.#options.events.emit({
      type: 'campaign.completed',
      message: `Campaign "${campaign.name}" completed`,
      campaignId: campaign.id,
    });
    this.#options.events.flush();
  }

  /** Cancel every in-flight call for a campaign. Used by stop and emergency stop. */
  cancelAllForCampaign(campaignId: string, reason: string): number {
    const campaign = this.#options.campaigns.findById(campaignId);
    let cancelled = 0;

    for (const context of [...this.#inFlight.values()]) {
      if (context.campaignId !== campaignId) continue;
      void this.#cancelProviderCall(context);
      if (campaign !== null) {
        this.#settle(context, {
          campaign,
          outcome: 'CANCELLED',
          callStatus: 'CANCELLED',
          failureCode: reason,
          failureClass: 'PERMANENT',
        });
      }
      cancelled += 1;
    }
    return cancelled;
  }

  activeCallCount(campaignId?: string): number {
    if (campaignId === undefined) return this.#inFlight.size;
    let count = 0;
    for (const context of this.#inFlight.values()) {
      if (context.campaignId === campaignId) count += 1;
    }
    return count;
  }

  /** Release provider subscriptions and timers. */
  shutdown(): void {
    for (const campaignId of [...this.#ticking.keys()]) this.stop(campaignId);
    for (const unsubscribe of this.#providerSubscriptions.values()) unsubscribe();
    this.#providerSubscriptions.clear();
  }
}

const EVENT_FOR_OUTCOME = {
  ANSWERED: 'call.completed',
  NO_ANSWER: 'call.no_answer',
  BUSY: 'call.busy',
  FAILED: 'call.failed',
  CANCELLED: 'call.cancelled',
  TIMEOUT: 'call.timeout',
  ABANDONED: 'call.abandoned',
} as const satisfies Record<CallOutcome, string>;

const EVENT_FOR_CALL_STATUS: Partial<Record<CallStatus, 'call.dialing' | 'call.ringing'>> = {
  DIALING: 'call.dialing',
  RINGING: 'call.ringing',
};

/**
 * The call states a contact mirrors, so the contacts view shows what is actually happening
 * rather than a stale RESERVED. Terminal states are deliberately absent — a contact's final
 * state is decided by the retry policy in `#resolveContact`, not by the call's outcome.
 */
const CONTACT_STATUS_FOR_CALL_STATUS: Partial<Record<CallStatus, ContactStatus>> = {
  DIALING: 'DIALING',
  RINGING: 'RINGING',
  CONNECTED: 'CONNECTED',
};
