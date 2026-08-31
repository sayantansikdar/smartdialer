/**
 * The dialing strategy interface.
 *
 * A strategy is a **pure function** of an immutable snapshot: it performs no I/O, places no
 * calls, and touches no database (DECISIONS.md D-010). That separation is the whole point —
 * pacing is the part of a dialer most likely to be subtly wrong, and it is also the part
 * most entangled with live state. Testing it through a running engine would be slow,
 * fragile, and would confuse a pacing bug with a scheduling bug.
 *
 * The strategy decides *how many* calls to place. The engine decides how to place them, and
 * the safety engine decides whether each one is permitted. A strategy asking for more than
 * is safe is not a safety hole: `maxLinesPerAgent` and the concurrency ceilings are enforced
 * independently, per call, downstream.
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
  /** How many dials to attempt this tick. Never negative. */
  readonly attempts: number;
  /**
   * The arithmetic and every clamp that was applied, in order.
   *
   * This is not debug output — it is rendered in the dashboard and printed by the
   * simulation report, so "why is the dialer only placing two calls?" is answerable without
   * reading the source.
   */
  readonly reasoning: readonly string[];
}

export interface DialerStrategy {
  readonly mode: DialingMode;
  computeDialPlan(snapshot: DialerSnapshot): DialPlan;
}

/**
 * Apply every hard ceiling to a desired dial count, recording each clamp that bites.
 *
 * Shared by both strategies so that a limit added here cannot be forgotten by one of them —
 * the commonest way a safety control quietly stops applying to half the system.
 */
export function applyLimits(
  desired: number,
  snapshot: DialerSnapshot,
  reasoning: string[],
): number {
  let attempts = Math.max(0, Math.floor(desired));

  const limits: ReadonlyArray<{ name: string; value: number }> = [
    { name: 'campaign concurrency headroom', value: snapshot.campaignHeadroom },
    { name: 'global concurrency headroom', value: snapshot.globalHeadroom },
    { name: 'provider concurrency headroom', value: snapshot.providerHeadroom },
    { name: 'rate limit', value: snapshot.rateLimitHeadroom },
    { name: 'contacts remaining', value: snapshot.remainingContacts },
  ];

  for (const limit of limits) {
    const bound = Math.max(0, Math.floor(limit.value));
    if (bound < attempts) {
      reasoning.push(`clamped to ${bound} by ${limit.name}`);
      attempts = bound;
    }
  }

  return attempts;
}

/** Rounds to two decimals for readable reasoning strings. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
