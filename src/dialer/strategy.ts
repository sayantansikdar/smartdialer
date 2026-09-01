/**
 * The pacing engine interface.
 *
 * A strategy is a **pure function** of an immutable snapshot: it performs no I/O, places no
 * calls, and touches no database (DECISIONS.md D-010). That separation is the whole point —
 * pacing is the part of a dialer most likely to be subtly wrong, and it is also the part
 * most entangled with live state.
 *
 * **A pacing engine produces a request, not a decision.** It says "I think we can start 15
 * more calls" and stops. It cannot clamp itself, cannot consult a limit, and has no reference
 * to anything that could place a call. `SafetyController` decides what is actually allowed
 * (DECISIONS.md D-018).
 *
 * This used to be untrue — the strategies applied the concurrency ceilings themselves — and
 * the reason it changed is worth keeping in view: a component that both computes an
 * aggressive number and enforces the bound on it has no bound at all. Every pacing bug was
 * automatically a safety bug.
 */

import type { Campaign, DialingMode } from '../domain/campaign.ts';

export interface DialerSnapshot {
  readonly now: number;
  readonly campaign: Campaign;

  // Agents
  readonly totalAgents: number;
  /** Free seats right now. */
  readonly availableAgents: number;
  /** Seats spoken for: RESERVED, RINGING or ON_CALL. */
  readonly occupiedAgents: number;

  // Calls
  readonly activeCalls: number;
  /** Active calls not yet connected — each one might still need a seat. */
  readonly pendingConnections: number;
  readonly connectedCalls: number;

  // Observed behaviour
  readonly historicalAnswerRate: number;
  readonly recentAnswerRate: number;
  /** Calls in the recent window. The recent rate is noise below a useful sample. */
  readonly recentSample: number;
  readonly abandonRate: number;
  readonly abandonSample: number;

  // Headroom left by each hard limit, already accounting for what is in flight.
  readonly campaignHeadroom: number;
  readonly globalHeadroom: number;
  readonly providerHeadroom: number;
  /** Whole calls the rate limiter would currently allow. */
  readonly rateLimitHeadroom: number;

  readonly remainingContacts: number;
}

export interface DialPlan {
  /**
   * How many dials the pacer *believes* are warranted. This is a request, not permission —
   * nothing may act on it until `SafetyController.review` has approved a number.
   */
  readonly requested: number;
  /**
   * The arithmetic that produced the number, in order.
   *
   * Not debug output: it is rendered live in the dashboard and printed in the simulation
   * report, so "why did the system decide to make this many calls right now?" is answerable
   * without reading the source.
   */
  readonly reasoning: readonly string[];
}

export interface DialerStrategy {
  readonly mode: DialingMode;
  /** Produce a request. Deliberately has no way to consult or apply a safety limit. */
  computeDialPlan(snapshot: DialerSnapshot): DialPlan;
}

/** Rounds to two decimals for readable reasoning strings. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
