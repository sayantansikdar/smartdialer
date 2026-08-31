/**
 * Agent lifecycle.
 *
 * Every status change goes through the agent state machine, so an agent cannot be put on a
 * call it was never reserved for, and cannot be stranded in a state it has no way out of.
 * An agent stuck in RESERVED because its call failed is a permanently lost seat — and with
 * a small team, losing two or three seats quietly halves throughput with no error anywhere.
 */

import type { Clock } from '../core/clock.ts';
import { agentStateMachine, type Agent, type AgentStatus } from '../domain/agent.ts';
import type { AgentRepository } from '../db/repositories/agent-repository.ts';
import type { EventService } from './event-service.ts';

const EVENT_FOR_STATUS = {
  AVAILABLE: 'agent.available',
  RESERVED: 'agent.reserved',
  RINGING: 'agent.reserved',
  ON_CALL: 'agent.busy',
  WRAP_UP: 'agent.wrap_up',
  PAUSED: 'agent.paused',
  OFFLINE: 'agent.offline',
} as const satisfies Record<AgentStatus, string>;

export class AgentService {
  readonly #agents: AgentRepository;
  readonly #events: EventService;
  readonly #clock: Clock;

  constructor(options: { agents: AgentRepository; events: EventService; clock: Clock }) {
    this.#agents = options.agents;
    this.#events = options.events;
    this.#clock = options.clock;
  }

  /**
   * Claim a free agent for a call.
   *
   * Returns null when nobody is available — a normal outcome in predictive mode, and the
   * point at which the caller must decide between waiting and abandoning.
   */
  reserveForCall(campaignId: string, callId: string): Agent | null {
    const agent = this.#agents.reserveAvailable(campaignId, callId, this.#clock.now());
    if (agent === null) return null;

    this.#events.emit({
      type: 'agent.reserved',
      message: `Agent ${agent.name} reserved for call`,
      campaignId,
      agentId: agent.id,
      callId,
    });
    return agent;
  }

  /** Move a reserved agent onto the call they were reserved for. */
  connect(agentId: string, callId: string): Agent | null {
    return this.#transition(agentId, 'ON_CALL', { callId });
  }

  /**
   * Return an agent to the pool.
   *
   * Goes through WRAP_UP rather than straight to AVAILABLE so the transition is visible in
   * the event stream — an operator watching the dashboard should see the same sequence a
   * real agent experiences. `handleTimeMs` is null when no conversation happened (an
   * abandoned or failed call), so those do not inflate handle-time statistics.
   */
  release(agentId: string, handleTimeMs: number | null): Agent | null {
    const agent = this.#agents.findById(agentId);
    if (agent === null) return null;

    if (agentStateMachine.can(agent.status, 'WRAP_UP')) {
      this.#transition(agentId, 'WRAP_UP', { callId: agent.currentCallId });
    }

    this.#agents.release(agentId, this.#clock.now(), handleTimeMs);
    this.#events.emit({
      type: 'agent.available',
      message: `Agent ${agent.name} is available`,
      campaignId: agent.campaignId ?? undefined,
      agentId,
      metadata: handleTimeMs === null ? {} : { handleTimeMs },
    });
    return this.#agents.findById(agentId);
  }

  setStatus(agentId: string, to: AgentStatus): Agent | null {
    return this.#transition(agentId, to, {});
  }

  /** Bring agents on shift. Used by seeding and by the agents view. */
  bringOnline(agentId: string): Agent | null {
    return this.#transition(agentId, 'AVAILABLE', {});
  }

  #transition(
    agentId: string,
    to: AgentStatus,
    context: { callId?: string | null },
  ): Agent | null {
    const agent = this.#agents.findById(agentId);
    if (agent === null) return null;
    if (agent.status === to) return agent;

    // Throws InvalidTransitionError on an illegal move — reaching one means a caller's model
    // of the world is wrong, and continuing would let agent and call state drift apart.
    agentStateMachine.assertCan(agent.status, to, agentId);

    this.#agents.updateStatus(agentId, agent.status, to, this.#clock.now());
    if (context.callId !== undefined) {
      this.#agents.attachCall(agentId, context.callId, this.#clock.now());
    }

    this.#events.emit({
      type: EVENT_FOR_STATUS[to],
      message: `Agent ${agent.name} -> ${to}`,
      campaignId: agent.campaignId ?? undefined,
      agentId,
      callId: context.callId ?? undefined,
      metadata: { from: agent.status, to },
    });

    return this.#agents.findById(agentId);
  }

  availableCount(campaignId: string): number {
    return this.#agents.availableCount(campaignId);
  }

  listByCampaign(campaignId: string): Agent[] {
    return this.#agents.listByCampaign(campaignId);
  }
}
