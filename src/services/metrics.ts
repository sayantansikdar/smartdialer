/**
 * Metrics.
 *
 * Two different kinds live here, and the distinction matters:
 *
 * **Lifetime metrics** are derived from the database on demand — total calls, answer counts,
 * average talk time. They are exact, they survive a restart, and they are what a report
 * should quote.
 *
 * **Rolling metrics** are in-memory windows over the most recent outcomes — the recent
 * answer rate and the abandon rate. These are what the predictive pacer steers by, and they
 * are deliberately *not* lifetime figures: a campaign that answered well an hour ago and is
 * answering badly now must pace on the second fact, not an average that hides it.
 *
 * Both are needed. Pacing on lifetime numbers reacts far too slowly; reporting on a rolling
 * window would be misleading.
 */

import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import type { CallRepository } from '../db/repositories/call-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import type { EventRepository } from '../db/repositories/event-repository.ts';
import type { Campaign } from '../domain/campaign.ts';
import { averageHandleTime, type Agent } from '../domain/agent.ts';

/**
 * A fixed-size window of boolean outcomes.
 *
 * Implemented as a circular buffer rather than an array with `shift()`, because this is
 * updated on every completed call in the hot path and `shift()` on a 200-element array
 * thousands of times per simulated minute is avoidable work.
 */
export class RollingRate {
  readonly #buffer: boolean[];
  #index = 0;
  #filled = 0;
  #hits = 0;

  constructor(size: number) {
    if (size <= 0) throw new RangeError(`RollingRate size must be > 0, got ${size}`);
    this.#buffer = new Array<boolean>(size).fill(false);
  }

  record(hit: boolean): void {
    if (this.#filled === this.#buffer.length) {
      // Evict the value being overwritten before counting the new one.
      if (this.#buffer[this.#index] === true) this.#hits -= 1;
    } else {
      this.#filled += 1;
    }
    this.#buffer[this.#index] = hit;
    if (hit) this.#hits += 1;
    this.#index = (this.#index + 1) % this.#buffer.length;
  }

  get sample(): number {
    return this.#filled;
  }

  get rate(): number {
    return this.#filled === 0 ? 0 : this.#hits / this.#filled;
  }

  reset(): void {
    this.#buffer.fill(false);
    this.#index = 0;
    this.#filled = 0;
    this.#hits = 0;
  }
}

export interface CampaignMetrics {
  readonly campaignId: string;
  readonly status: Campaign['status'];
  readonly dialingMode: Campaign['dialingMode'];

  readonly contactsTotal: number;
  readonly contactsRemaining: number;
  readonly contactsByStatus: Readonly<Record<string, number>>;

  readonly callsActive: number;
  readonly callsTotal: number;
  readonly callsAnswered: number;
  readonly callsAbandoned: number;
  readonly outcomes: Readonly<Record<string, number>>;

  readonly answerRate: number;
  readonly recentAnswerRate: number;
  readonly noAnswerRate: number;
  readonly busyRate: number;
  readonly failureRate: number;
  readonly abandonRate: number;
  readonly averageTalkMs: number;
  readonly retriesScheduled: number;
}

export interface AgentMetrics {
  readonly total: number;
  readonly available: number;
  readonly occupied: number;
  readonly paused: number;
  readonly offline: number;
  readonly onCall: number;
  readonly wrapUp: number;
  /** Occupied seats as a fraction of agents who are not offline. */
  readonly utilization: number;
  readonly averageHandleTimeMs: number;
}

export class MetricsService {
  readonly #calls: CallRepository;
  readonly #contacts: ContactRepository;
  readonly #agents: AgentRepository;
  readonly #events: EventRepository;
  readonly #windowSize: number;

  readonly #answerWindows = new Map<string, RollingRate>();
  readonly #abandonWindows = new Map<string, RollingRate>();

  constructor(options: {
    calls: CallRepository;
    contacts: ContactRepository;
    agents: AgentRepository;
    events: EventRepository;
    windowSize?: number;
  }) {
    this.#calls = options.calls;
    this.#contacts = options.contacts;
    this.#agents = options.agents;
    this.#events = options.events;
    this.#windowSize = options.windowSize ?? 100;
  }

  /**
   * Record a completed call attempt into the rolling windows.
   *
   * `abandoned` is tracked over *answered* calls only. An abandon rate measured over all
   * dials would fall simply because more calls went unanswered, which is precisely backwards
   * — the metric exists to measure harm done to people who picked up.
   */
  recordOutcome(campaignId: string, outcome: { answered: boolean; abandoned: boolean }): void {
    this.#window(this.#answerWindows, campaignId).record(outcome.answered);
    if (outcome.answered) {
      this.#window(this.#abandonWindows, campaignId).record(outcome.abandoned);
    }
  }

  recentAnswerRate(campaignId: string): { rate: number; sample: number } {
    const window = this.#answerWindows.get(campaignId);
    return { rate: window?.rate ?? 0, sample: window?.sample ?? 0 };
  }

  /**
   * A pessimistic view of the abandon rate, for the safety control.
   *
   * The plain rate needs a large sample before it means anything, and "wait for 20 samples"
   * is a strange thing to say about a metric where every sample is a person picking up the
   * phone to silence. So the control acts on the **lower bound of the Wilson score interval**
   * instead: the most optimistic rate still consistent with what has been observed. When even
   * that exceeds the threshold, the evidence is sufficient regardless of sample size.
   *
   * Concretely: 3 abandons out of 5 answered gives a Wilson lower bound around 23% — enough
   * to act on immediately. 1 out of 5 gives around 4%, which is not, and the control
   * correctly waits. It reacts fast when the problem is real and stays quiet when it is not,
   * which a fixed minimum sample cannot do (BUG.md B-013).
   */
  abandonRateLowerBound(campaignId: string, confidenceZ = 1.96): { rate: number; sample: number } {
    const { rate, sample } = this.abandonRate(campaignId);
    if (sample === 0) return { rate: 0, sample: 0 };

    const z2 = confidenceZ * confidenceZ;
    const denominator = 1 + z2 / sample;
    const centre = rate + z2 / (2 * sample);
    const margin =
      confidenceZ * Math.sqrt((rate * (1 - rate)) / sample + z2 / (4 * sample * sample));
    return { rate: Math.max(0, (centre - margin) / denominator), sample };
  }

  abandonRate(campaignId: string): { rate: number; sample: number } {
    const window = this.#abandonWindows.get(campaignId);
    return { rate: window?.rate ?? 0, sample: window?.sample ?? 0 };
  }

  #window(map: Map<string, RollingRate>, campaignId: string): RollingRate {
    let window = map.get(campaignId);
    if (window === undefined) {
      window = new RollingRate(this.#windowSize);
      map.set(campaignId, window);
    }
    return window;
  }

  campaignMetrics(campaign: Campaign): CampaignMetrics {
    const counts = this.#contacts.counts(campaign.id);
    const stats = this.#calls.statistics(campaign.id);
    const outcomes = this.#calls.outcomeCounts(campaign.id);
    const eventCounts = this.#events.countByType(campaign.id);

    const finished = Object.values(outcomes).reduce((sum, n) => sum + n, 0);
    const rate = (n: number): number => (finished === 0 ? 0 : n / finished);

    return {
      campaignId: campaign.id,
      status: campaign.status,
      dialingMode: campaign.dialingMode,

      contactsTotal: counts.total,
      contactsRemaining: this.#contacts.remainingCount(campaign.id),
      contactsByStatus: counts.byStatus,

      callsActive: this.#calls.activeCount(campaign.id),
      callsTotal: stats.total,
      callsAnswered: stats.answered,
      callsAbandoned: stats.abandoned,
      outcomes,

      answerRate: rate(outcomes['ANSWERED'] ?? 0),
      recentAnswerRate: this.recentAnswerRate(campaign.id).rate,
      noAnswerRate: rate(outcomes['NO_ANSWER'] ?? 0),
      busyRate: rate(outcomes['BUSY'] ?? 0),
      failureRate: rate((outcomes['FAILED'] ?? 0) + (outcomes['TIMEOUT'] ?? 0)),
      // Over answered calls, for the reason given on `recordOutcome`.
      // Denominator is everyone who picked up, which includes the abandoned calls. Dividing
      // by `answered` alone excluded the very calls being counted: a campaign where every
      // answered call was abandoned reported 0%, because `answered` was zero (BUG.md B-011).
      // This is the number a human reads to judge whether the system is behaving safely.
      abandonRate:
        stats.answered + stats.abandoned === 0
          ? 0
          : stats.abandoned / (stats.answered + stats.abandoned),
      averageTalkMs: stats.averageTalkMs,
      retriesScheduled: eventCounts['retry.scheduled'] ?? 0,
    };
  }

  agentMetrics(campaignId?: string): AgentMetrics {
    const agents: Agent[] =
      campaignId === undefined ? this.#agents.list() : this.#agents.listByCampaign(campaignId);

    const counts = { available: 0, occupied: 0, paused: 0, offline: 0, onCall: 0, wrapUp: 0 };
    let handleTimeTotal = 0;
    let handled = 0;

    for (const agent of agents) {
      switch (agent.status) {
        case 'AVAILABLE':
          counts.available += 1;
          break;
        case 'RESERVED':
        case 'RINGING':
          counts.occupied += 1;
          break;
        case 'ON_CALL':
          counts.occupied += 1;
          counts.onCall += 1;
          break;
        case 'WRAP_UP':
          counts.wrapUp += 1;
          break;
        case 'PAUSED':
          counts.paused += 1;
          break;
        case 'OFFLINE':
          counts.offline += 1;
          break;
      }
      handleTimeTotal += agent.totalHandleTimeMs;
      handled += agent.callsHandled;
    }

    // Utilization is measured against agents who are actually on shift. Counting offline
    // agents would make a campaign look under-utilised simply because people logged off.
    const onShift = agents.length - counts.offline;

    return {
      total: agents.length,
      available: counts.available,
      occupied: counts.occupied,
      paused: counts.paused,
      offline: counts.offline,
      onCall: counts.onCall,
      wrapUp: counts.wrapUp,
      utilization: onShift === 0 ? 0 : counts.occupied / onShift,
      averageHandleTimeMs: handled === 0 ? 0 : Math.round(handleTimeTotal / handled),
    };
  }

  /** Average handle time for one agent. Exposed for the agents view. */
  static agentAverageHandleTime(agent: Agent): number {
    return averageHandleTime(agent);
  }

  reset(campaignId?: string): void {
    if (campaignId === undefined) {
      this.#answerWindows.clear();
      this.#abandonWindows.clear();
      return;
    }
    this.#answerWindows.delete(campaignId);
    this.#abandonWindows.delete(campaignId);
  }
}
