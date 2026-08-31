import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/core/errors.ts';
import { agentStateMachine, isAgentAvailable, isAgentOccupied } from '../../src/domain/agent.ts';
import {
  CAMPAIGN_STATUSES,
  campaignStateMachine,
  canCampaignDial,
} from '../../src/domain/campaign.ts';
import { callStateMachine, isCallActive, isCallConnected } from '../../src/domain/call.ts';
import {
  CONTACT_STATUSES,
  contactStateMachine,
  DIALABLE_CONTACT_STATUSES,
} from '../../src/domain/contact.ts';

describe('Campaign state machine', () => {
  it('walks the normal lifecycle', () => {
    expect(campaignStateMachine.can('DRAFT', 'READY')).toBe(true);
    expect(campaignStateMachine.can('READY', 'RUNNING')).toBe(true);
    expect(campaignStateMachine.can('RUNNING', 'PAUSED')).toBe(true);
    expect(campaignStateMachine.can('PAUSED', 'RUNNING')).toBe(true);
    expect(campaignStateMachine.can('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('refuses to start a campaign that was never made ready', () => {
    expect(campaignStateMachine.can('DRAFT', 'RUNNING')).toBe(false);
    expect(() => campaignStateMachine.assertCan('DRAFT', 'RUNNING', 'camp_1')).toThrow(
      InvalidTransitionError,
    );
  });

  it('treats COMPLETED and FAILED as terminal', () => {
    expect(campaignStateMachine.isTerminal('COMPLETED')).toBe(true);
    expect(campaignStateMachine.isTerminal('FAILED')).toBe(true);
    expect(campaignStateMachine.can('COMPLETED', 'RUNNING')).toBe(false);
    expect(campaignStateMachine.can('FAILED', 'READY')).toBe(false);
  });

  it('allows a stopped campaign to be reset and re-run', () => {
    expect(campaignStateMachine.can('STOPPED', 'READY')).toBe(true);
    expect(campaignStateMachine.can('STOPPED', 'RUNNING')).toBe(false);
  });

  it('permits dialing only while RUNNING', () => {
    // The safety engine relies on this; if any other state returned true, a paused or
    // stopped campaign could place calls.
    for (const status of CAMPAIGN_STATUSES) {
      expect(canCampaignDial(status), status).toBe(status === 'RUNNING');
    }
  });
});

describe('Contact state machine', () => {
  it('follows the reservation sequence', () => {
    expect(contactStateMachine.can('READY', 'RESERVED')).toBe(true);
    expect(contactStateMachine.can('RESERVED', 'DIALING')).toBe(true);
    expect(contactStateMachine.can('DIALING', 'RINGING')).toBe(true);
    expect(contactStateMachine.can('RINGING', 'CONNECTED')).toBe(true);
    expect(contactStateMachine.can('CONNECTED', 'COMPLETED')).toBe(true);
  });

  it('cannot skip reservation', () => {
    expect(contactStateMachine.can('READY', 'DIALING')).toBe(false);
  });

  it('can always release a reservation back to READY', () => {
    // Every failure path between claiming a contact and reaching the provider depends on
    // this; without it, contacts leak out of the dialable pool.
    expect(contactStateMachine.can('RESERVED', 'READY')).toBe(true);
  });

  it('routes every failure outcome to retry or exhaustion', () => {
    for (const outcome of ['NO_ANSWER', 'BUSY', 'FAILED'] as const) {
      expect(contactStateMachine.can(outcome, 'RETRY_PENDING'), outcome).toBe(true);
      expect(contactStateMachine.can(outcome, 'EXHAUSTED'), outcome).toBe(true);
    }
    expect(contactStateMachine.can('RETRY_PENDING', 'READY')).toBe(true);
  });

  it('never leaves a DO_NOT_CALL contact', () => {
    // The most important transition table entry in the system: DO_NOT_CALL is a sink.
    expect(contactStateMachine.targetsFrom('DO_NOT_CALL')).toEqual([]);
    for (const status of CONTACT_STATUSES) {
      expect(contactStateMachine.can('DO_NOT_CALL', status), status).toBe(false);
    }
  });

  it('lets any pre-terminal state be marked DO_NOT_CALL', () => {
    for (const status of ['READY', 'RESERVED', 'NO_ANSWER', 'BUSY', 'FAILED', 'RETRY_PENDING'] as const) {
      expect(contactStateMachine.can(status, 'DO_NOT_CALL'), status).toBe(true);
    }
  });

  it('treats only READY as dialable, keeping backoff honest', () => {
    // RETRY_PENDING is deliberately excluded: a contact waiting out its backoff must be
    // promoted to READY first, so the wait cannot be skipped by a query change.
    expect(DIALABLE_CONTACT_STATUSES).toEqual(['READY']);
    expect(DIALABLE_CONTACT_STATUSES).not.toContain('RETRY_PENDING');
  });

  it('marks completion states terminal', () => {
    for (const status of ['COMPLETED', 'EXHAUSTED', 'DO_NOT_CALL'] as const) {
      expect(contactStateMachine.isTerminal(status), status).toBe(true);
    }
  });
});

describe('Agent state machine', () => {
  it('follows the allocation sequence', () => {
    expect(agentStateMachine.can('OFFLINE', 'AVAILABLE')).toBe(true);
    expect(agentStateMachine.can('AVAILABLE', 'RESERVED')).toBe(true);
    expect(agentStateMachine.can('RESERVED', 'ON_CALL')).toBe(true);
    expect(agentStateMachine.can('ON_CALL', 'WRAP_UP')).toBe(true);
    expect(agentStateMachine.can('WRAP_UP', 'AVAILABLE')).toBe(true);
  });

  it('cannot put an offline or paused agent straight on a call', () => {
    expect(agentStateMachine.can('OFFLINE', 'ON_CALL')).toBe(false);
    expect(agentStateMachine.can('PAUSED', 'RESERVED')).toBe(false);
    expect(agentStateMachine.can('AVAILABLE', 'ON_CALL')).toBe(false);
  });

  it('can always recover an agent to AVAILABLE from any occupied state', () => {
    // An agent stranded in RESERVED because its call failed is a permanently lost seat.
    for (const status of ['RESERVED', 'RINGING', 'ON_CALL', 'WRAP_UP'] as const) {
      expect(agentStateMachine.can(status, 'AVAILABLE'), status).toBe(true);
    }
  });

  it('classifies availability and occupancy consistently', () => {
    expect(isAgentAvailable('AVAILABLE')).toBe(true);
    expect(isAgentAvailable('RESERVED')).toBe(false);

    // RESERVED counts as occupied: the seat is spoken for by a call in flight, and pacing
    // that ignored that would over-dial into agents who are already committed.
    expect(isAgentOccupied('RESERVED')).toBe(true);
    expect(isAgentOccupied('RINGING')).toBe(true);
    expect(isAgentOccupied('ON_CALL')).toBe(true);
    expect(isAgentOccupied('AVAILABLE')).toBe(false);
    expect(isAgentOccupied('WRAP_UP')).toBe(false);
    expect(isAgentOccupied('PAUSED')).toBe(false);
  });
});

describe('Call state machine', () => {
  it('follows the answered path', () => {
    expect(callStateMachine.can('CREATED', 'QUEUED')).toBe(true);
    expect(callStateMachine.can('QUEUED', 'DIALING')).toBe(true);
    expect(callStateMachine.can('DIALING', 'RINGING')).toBe(true);
    expect(callStateMachine.can('RINGING', 'CONNECTED')).toBe(true);
    expect(callStateMachine.can('CONNECTED', 'ENDED')).toBe(true);
  });

  it('refuses to connect a call that never rang or dialled', () => {
    expect(callStateMachine.can('CREATED', 'CONNECTED')).toBe(false);
    expect(callStateMachine.can('QUEUED', 'CONNECTED')).toBe(false);
    expect(callStateMachine.can('QUEUED', 'RINGING')).toBe(false);
  });

  it('allows timeout from every in-flight state, including CONNECTED', () => {
    // The failure that actually strands resources is a provider that answers a call and
    // then never reports it ending, so CONNECTED -> TIMEOUT must be reachable.
    for (const status of ['QUEUED', 'DIALING', 'RINGING', 'CONNECTED', 'ON_HOLD'] as const) {
      expect(callStateMachine.can(status, 'TIMEOUT'), status).toBe(true);
    }
  });

  it('supports hold and resume', () => {
    expect(callStateMachine.can('CONNECTED', 'ON_HOLD')).toBe(true);
    expect(callStateMachine.can('ON_HOLD', 'CONNECTED')).toBe(true);
  });

  it('makes every terminal state a sink', () => {
    for (const status of ['ENDED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'TIMEOUT'] as const) {
      expect(callStateMachine.isTerminal(status), status).toBe(true);
      expect(callStateMachine.targetsFrom(status), status).toEqual([]);
    }
  });

  it('counts exactly the non-terminal states as active', () => {
    // This is what the concurrency invariants count, so it must line up with the machine.
    for (const status of ['CREATED', 'QUEUED', 'DIALING', 'RINGING', 'CONNECTED', 'ON_HOLD'] as const) {
      expect(isCallActive(status), status).toBe(true);
    }
    for (const status of ['ENDED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'TIMEOUT'] as const) {
      expect(isCallActive(status), status).toBe(false);
    }
  });

  it('counts a held call as connected, since it still occupies an agent', () => {
    expect(isCallConnected('CONNECTED')).toBe(true);
    expect(isCallConnected('ON_HOLD')).toBe(true);
    expect(isCallConnected('RINGING')).toBe(false);
  });
});
