/**
 * Campaign — the unit of dialing work.
 *
 * States and dialing modes are `const` arrays plus derived union types rather than TS
 * `enum`s, because the backend runs under Node's type stripping which cannot emit the
 * runtime object an enum needs (DECISIONS.md D-005). This is also the better shape here:
 * the values are stored verbatim as strings in SQLite.
 */

import { StateMachine } from '../core/state-machine.ts';

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'READY',
  'RUNNING',
  'PAUSED',
  'STOPPED',
  'COMPLETED',
  'FAILED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const DIALING_MODES = ['PROGRESSIVE', 'PREDICTIVE'] as const;
export type DialingMode = (typeof DIALING_MODES)[number];

/**
 * A campaign can always be reset back to READY, from any state it has finished in.
 *
 * The distinction that matters is between *resuming* and *resetting*. Nothing may go directly
 * back to RUNNING — a campaign that exhausted its contacts or failed structurally must not
 * silently pick up where it left off. But an operator may explicitly reset it, which discards
 * the previous run's outcomes and returns unsuccessful contacts to the pool
 * (`CampaignService.reset`). READY still requires a deliberate start afterwards.
 *
 * `COMPLETED` and `FAILED` remain in `terminal` because that set means "the dialer will not
 * advance this on its own" — which is still true. Terminal describes automatic progress, not
 * the absence of every possible edge.
 */
export const campaignStateMachine = new StateMachine<CampaignStatus>({
  name: 'Campaign',
  initial: 'DRAFT',
  transitions: {
    DRAFT: ['READY', 'FAILED'],
    READY: ['RUNNING', 'DRAFT', 'STOPPED'],
    RUNNING: ['PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'],
    PAUSED: ['RUNNING', 'STOPPED', 'COMPLETED', 'FAILED'],
    STOPPED: ['READY'],
    // Reset-only edges: explicit operator action, never automatic, and never straight to
    // RUNNING. See CampaignService.reset.
    COMPLETED: ['READY'],
    FAILED: ['READY'],
  },
  terminal: ['COMPLETED', 'FAILED'],
});

/** Campaign states in which the dialer engine is permitted to initiate new calls. */
export function canCampaignDial(status: CampaignStatus): boolean {
  return status === 'RUNNING';
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Exponential base. 2 doubles the delay each attempt. */
  readonly multiplier: number;
  /**
   * Fraction of the computed delay to vary by, drawn from a seeded stream. Without jitter,
   * a batch of contacts that failed together retries together — a thundering herd that
   * makes a transient provider problem worse at exactly the wrong moment.
   */
  readonly jitterRatio: number;
}

/**
 * Tuning knobs that are not themselves hard safety limits. The hard limits live as
 * top-level campaign fields because the safety engine reads them on every dial and they
 * are what an operator actually reasons about.
 */
export interface CampaignSafetyConfig {
  /** Predictive: how aggressively to over-dial relative to the answer-rate estimate. */
  readonly pacingMultiplier: number;
  /** Predictive: agent occupancy the pacing feedback aims for. */
  readonly targetOccupancy: number;
  /** Progressive: calls to place per available agent. 1.0 = strictly one line per agent. */
  readonly lineRatio: number;
  /**
   * Predictive: the absolute ceiling on calls in flight per free agent seat, enforced by
   * the safety engine rather than by the pacing algorithm.
   *
   * The distinction matters. The strategy decides how many calls to place; this decides how
   * many are *permitted*. If a pacing bug or a collapsed answer-rate estimate asked for 50
   * lines per agent, pacing alone would happily comply and every answered call beyond
   * capacity would be abandoned. This ceiling is what makes that impossible.
   */
  readonly maxLinesPerAgent: number;
  /** An answered call with no agent within this window counts as abandoned. */
  readonly abandonTimeoutMs: number;
  /** Minimum answered-call sample before the abandon-rate control may act. */
  readonly abandonMinSample: number;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly dialingMode: DialingMode;

  // Hard limits, enforced by the safety engine on every dial.
  readonly maxConcurrentCalls: number;
  readonly maxCallsPerSecond: number;
  readonly maxAbandonRate: number;
  readonly maxAttemptsPerContact: number;

  readonly retryPolicy: RetryPolicy;
  readonly safety: CampaignSafetyConfig;

  readonly providerId: string;

  /**
   * Set when the abandon-rate control pauses predictive dialing. Non-null means an operator
   * must explicitly resume — the system deliberately does not un-pause itself, because the
   * condition that tripped it is exactly the condition that would trip it again.
   */
  readonly predictivePausedReason: string | null;

  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CampaignDraft {
  readonly name: string;
  readonly dialingMode: DialingMode;
  readonly maxConcurrentCalls: number;
  readonly maxCallsPerSecond: number;
  readonly maxAbandonRate: number;
  readonly maxAttemptsPerContact: number;
  readonly retryPolicy: RetryPolicy;
  readonly safety: CampaignSafetyConfig;
  readonly providerId: string;
}
