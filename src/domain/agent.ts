/**
 * Agent — the scarce resource the whole dialer exists to keep busy without overwhelming.
 *
 * `RESERVED` matters more than it looks. A predictive dialer decides to place calls
 * *before* it knows which will be answered, so an agent must be earmarked for a call that
 * may never connect. Without a distinct reserved state, two answered calls could both be
 * routed to the same nominally-available agent, and one of them would be abandoned — the
 * exact outcome abandon-rate regulation exists to prevent.
 */

import { StateMachine } from '../core/state-machine.ts';

export const AGENT_STATUSES = [
  'OFFLINE',
  'AVAILABLE',
  'RESERVED',
  'RINGING',
  'ON_CALL',
  'WRAP_UP',
  'PAUSED',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const agentStateMachine = new StateMachine<AgentStatus>({
  name: 'Agent',
  initial: 'OFFLINE',
  transitions: {
    OFFLINE: ['AVAILABLE'],
    // Every state that holds a call can fall back to AVAILABLE, because a call can fail at
    // any point and the agent must always be recoverable. An agent stuck in RESERVED is a
    // permanently lost seat.
    AVAILABLE: ['RESERVED', 'PAUSED', 'OFFLINE'],
    RESERVED: ['RINGING', 'ON_CALL', 'AVAILABLE', 'OFFLINE'],
    RINGING: ['ON_CALL', 'AVAILABLE', 'OFFLINE'],
    ON_CALL: ['WRAP_UP', 'AVAILABLE', 'OFFLINE'],
    WRAP_UP: ['AVAILABLE', 'PAUSED', 'OFFLINE'],
    PAUSED: ['AVAILABLE', 'OFFLINE'],
  },
});

/** An agent that can be earmarked for a new call right now. */
export function isAgentAvailable(status: AgentStatus): boolean {
  return status === 'AVAILABLE';
}

/**
 * An agent occupying capacity — either handling a call or spoken for by one in flight.
 * Used by the pacing calculation and by the `agentBusy <= agentCount` invariant.
 */
export function isAgentOccupied(status: AgentStatus): boolean {
  return status === 'RESERVED' || status === 'RINGING' || status === 'ON_CALL';
}

export interface Agent {
  readonly id: string;
  readonly campaignId: string | null;
  readonly name: string;
  readonly status: AgentStatus;
  readonly currentCallId: string | null;
  readonly callsHandled: number;
  /** Cumulative talk + wrap time, used to derive average handle time. */
  readonly totalHandleTimeMs: number;
  readonly lastStateChange: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function averageHandleTime(agent: Agent): number {
  return agent.callsHandled === 0 ? 0 : Math.round(agent.totalHandleTimeMs / agent.callsHandled);
}

export interface AgentDraft {
  readonly campaignId: string | null;
  readonly name: string;
  readonly status?: AgentStatus;
}
