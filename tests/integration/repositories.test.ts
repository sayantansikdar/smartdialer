import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, discoverMigrations, appliedVersions } from '../../src/db/migrator.ts';
import { Database } from '../../src/db/database.ts';
import { campaignDraft, createTestRepositories, fictionalPhoneNumber, type TestRepositories } from '../helpers/db.ts';

let repos: TestRepositories;

beforeEach(() => {
  repos = createTestRepositories();
});

afterEach(() => {
  repos.close();
});

describe('migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const db = new Database(':memory:');
    const first = migrate(db);
    expect(first.applied.length).toBe(discoverMigrations().length);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(appliedVersions(db).size).toBe(first.applied.length);
    db.close();
  });

  it('creates every table the system relies on', () => {
    const names = repos.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => String(row.name));

    for (const table of [
      'campaigns',
      'contacts',
      'agents',
      'calls',
      'call_attempts',
      'events',
      'provider_configs',
      'simulation_runs',
      'schema_migrations',
    ]) {
      expect(names, table).toContain(table);
    }
  });
});

describe('Database transactions', () => {
  it('rolls back on failure', () => {
    const campaign = repos.campaigns.insert('camp_1', campaignDraft(), 0);
    expect(() =>
      repos.db.transaction(() => {
        repos.campaigns.updateStatus(campaign.id, 'DRAFT', 'READY', 10);
        throw new Error('abort');
      }),
    ).toThrow('abort');

    expect(repos.campaigns.findById('camp_1')?.status).toBe('DRAFT');
  });

  it('supports nesting via savepoints, rolling back only the inner unit', () => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);

    repos.db.transaction(() => {
      repos.campaigns.updateStatus('camp_1', 'DRAFT', 'READY', 10);
      try {
        repos.db.transaction(() => {
          repos.campaigns.setPredictivePausedReason('camp_1', 'inner change', 11);
          throw new Error('inner abort');
        });
      } catch {
        // Swallowed on purpose: the point of this test is that the outer transaction
        // survives an inner rollback.
      }
    });

    const campaign = repos.campaigns.findById('camp_1');
    expect(campaign?.status).toBe('READY');
    expect(campaign?.predictivePausedReason).toBeNull();
  });
});

describe('CampaignRepository', () => {
  it('round-trips a campaign including nested JSON config', () => {
    const draft = campaignDraft({ dialingMode: 'PREDICTIVE', maxConcurrentCalls: 25 });
    const created = repos.campaigns.insert('camp_1', draft, 100);

    expect(created.status).toBe('DRAFT');
    expect(created.dialingMode).toBe('PREDICTIVE');
    expect(created.maxConcurrentCalls).toBe(25);
    expect(created.retryPolicy).toEqual(draft.retryPolicy);
    expect(created.safety).toEqual(draft.safety);
    expect(created.predictivePausedReason).toBeNull();
    expect(repos.campaigns.findById('camp_1')).toEqual(created);
  });

  it('returns null for an unknown id', () => {
    expect(repos.campaigns.findById('nope')).toBeNull();
  });

  it('updates status only from the expected current status', () => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);

    expect(repos.campaigns.updateStatus('camp_1', 'DRAFT', 'READY', 10)).toBe(true);
    // Compare-and-set: a second caller working from a stale read must not clobber.
    expect(repos.campaigns.updateStatus('camp_1', 'DRAFT', 'RUNNING', 20)).toBe(false);
    expect(repos.campaigns.findById('camp_1')?.status).toBe('READY');
  });

  it('records and clears the predictive pause reason', () => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
    repos.campaigns.setPredictivePausedReason('camp_1', 'abandon rate 0.09 > 0.03', 50);
    expect(repos.campaigns.findById('camp_1')?.predictivePausedReason).toContain('abandon rate');

    repos.campaigns.setPredictivePausedReason('camp_1', null, 60);
    expect(repos.campaigns.findById('camp_1')?.predictivePausedReason).toBeNull();
  });

  it('patches settings without disturbing untouched fields', () => {
    repos.campaigns.insert('camp_1', campaignDraft({ name: 'Original' }), 0);
    const updated = repos.campaigns.updateSettings('camp_1', { maxConcurrentCalls: 42 }, 10);

    expect(updated?.maxConcurrentCalls).toBe(42);
    expect(updated?.name).toBe('Original');
    expect(updated?.retryPolicy.maxAttempts).toBe(3);
  });

  it('lists campaigns and filters by status', () => {
    repos.campaigns.insert('camp_1', campaignDraft({ name: 'A' }), 1);
    repos.campaigns.insert('camp_2', campaignDraft({ name: 'B' }), 2);
    repos.campaigns.updateStatus('camp_2', 'DRAFT', 'READY', 3);

    expect(repos.campaigns.list().map((c) => c.id)).toEqual(['camp_1', 'camp_2']);
    expect(repos.campaigns.listByStatus('READY').map((c) => c.id)).toEqual(['camp_2']);
  });

  it('cascades deletion to contacts', () => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
    repos.contacts.insert('cont_1', { campaignId: 'camp_1', name: 'A', phoneNumber: fictionalPhoneNumber(1) }, 0);

    expect(repos.campaigns.deleteById('camp_1')).toBe(true);
    expect(repos.contacts.findById('cont_1')).toBeNull();
  });
});

describe('ContactRepository', () => {
  beforeEach(() => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
  });

  const addContact = (id: string, overrides: Record<string, unknown> = {}): void => {
    repos.contacts.insert(
      id,
      {
        campaignId: 'camp_1',
        name: `Contact ${id}`,
        phoneNumber: fictionalPhoneNumber(Number(id.split('_')[1] ?? 0)),
        ...overrides,
      },
      0,
    );
  };

  it('round-trips a contact with metadata', () => {
    repos.contacts.insert(
      'cont_1',
      {
        campaignId: 'camp_1',
        name: 'Alex',
        phoneNumber: fictionalPhoneNumber(1),
        timezone: 'Europe/Berlin',
        metadata: { source: 'import', priority: 2 },
      },
      100,
    );

    const contact = repos.contacts.findById('cont_1');
    expect(contact?.status).toBe('READY');
    expect(contact?.attemptCount).toBe(0);
    expect(contact?.timezone).toBe('Europe/Berlin');
    expect(contact?.metadata).toEqual({ source: 'import', priority: 2 });
  });

  describe('reserveNext', () => {
    it('claims a READY contact and marks it RESERVED', () => {
      addContact('cont_1');
      const reserved = repos.contacts.reserveNext('camp_1', 1000);

      expect(reserved?.id).toBe('cont_1');
      expect(reserved?.status).toBe('RESERVED');
      expect(repos.contacts.findById('cont_1')?.status).toBe('RESERVED');
    });

    it('never hands the same contact to two callers', () => {
      // The core mutual-exclusion property. The conditional UPDATE is what guarantees it —
      // the preceding SELECT is only a hint.
      addContact('cont_1');

      const first = repos.contacts.reserveNext('camp_1', 1000);
      const second = repos.contacts.reserveNext('camp_1', 1000);

      expect(first?.id).toBe('cont_1');
      expect(second).toBeNull();
    });

    it('returns null when nothing is dialable', () => {
      expect(repos.contacts.reserveNext('camp_1', 1000)).toBeNull();
    });

    it('never claims a DO_NOT_CALL contact', () => {
      addContact('cont_1', { status: 'DO_NOT_CALL' });
      expect(repos.contacts.reserveNext('camp_1', 1000)).toBeNull();
    });

    it('never claims a contact in a non-READY state', () => {
      for (const status of ['RESERVED', 'DIALING', 'CONNECTED', 'COMPLETED', 'EXHAUSTED', 'RETRY_PENDING'] as const) {
        addContact(`cont_${status}`, { status });
      }
      expect(repos.contacts.reserveNext('camp_1', 1000)).toBeNull();
    });

    it('respects a backoff that has not yet elapsed', () => {
      addContact('cont_1', { nextAttemptAt: 5000 });
      expect(repos.contacts.reserveNext('camp_1', 1000)).toBeNull();
      expect(repos.contacts.reserveNext('camp_1', 5000)?.id).toBe('cont_1');
    });

    it('prefers contacts never attempted, then the longest-waiting retry', () => {
      addContact('cont_3', { nextAttemptAt: 900 });
      addContact('cont_2', { nextAttemptAt: 500 });
      addContact('cont_1');

      expect(repos.contacts.reserveNext('camp_1', 1000)?.id).toBe('cont_1');
      expect(repos.contacts.reserveNext('camp_1', 1000)?.id).toBe('cont_2');
      expect(repos.contacts.reserveNext('camp_1', 1000)?.id).toBe('cont_3');
    });

    it('honours the exclusion list so one tick can claim several contacts', () => {
      addContact('cont_1');
      addContact('cont_2');

      const first = repos.contacts.reserveNext('camp_1', 1000, []);
      const second = repos.contacts.reserveNext('camp_1', 1000, [first?.id ?? '']);

      expect(first?.id).toBe('cont_1');
      expect(second?.id).toBe('cont_2');
    });

    it('does not cross campaign boundaries', () => {
      repos.campaigns.insert('camp_2', campaignDraft(), 0);
      addContact('cont_1');
      expect(repos.contacts.reserveNext('camp_2', 1000)).toBeNull();
    });
  });

  it('releases a reservation, and only from RESERVED', () => {
    addContact('cont_1');
    repos.contacts.reserveNext('camp_1', 1000);

    expect(repos.contacts.releaseReservation('cont_1', 1100)).toBe(true);
    expect(repos.contacts.findById('cont_1')?.status).toBe('READY');
    // Releasing twice must not resurrect a contact that has since moved on.
    expect(repos.contacts.releaseReservation('cont_1', 1200)).toBe(false);
  });

  it('records attempts', () => {
    addContact('cont_1');
    repos.contacts.recordAttempt('cont_1', 500);
    repos.contacts.recordAttempt('cont_1', 900);

    const contact = repos.contacts.findById('cont_1');
    expect(contact?.attemptCount).toBe(2);
    expect(contact?.lastAttemptAt).toBe(900);
  });

  it('schedules retries and promotes only those whose backoff elapsed', () => {
    addContact('cont_1');
    addContact('cont_2');
    repos.contacts.scheduleRetry('cont_1', 2000, 1000);
    repos.contacts.scheduleRetry('cont_2', 9000, 1000);

    expect(repos.contacts.findById('cont_1')?.status).toBe('RETRY_PENDING');

    const promoted = repos.contacts.promoteDueRetries('camp_1', 3000);
    expect(promoted).toBe(1);
    expect(repos.contacts.findById('cont_1')?.status).toBe('READY');
    expect(repos.contacts.findById('cont_2')?.status).toBe('RETRY_PENDING');
  });

  it('counts contacts by status, remaining and in flight', () => {
    addContact('cont_1');
    addContact('cont_2', { status: 'COMPLETED' });
    addContact('cont_3', { status: 'DO_NOT_CALL' });
    addContact('cont_4', { status: 'DIALING' });

    const counts = repos.contacts.counts('camp_1');
    expect(counts.total).toBe(4);
    expect(counts.byStatus['READY']).toBe(1);

    // Remaining excludes terminal states; in-flight counts only work under way.
    expect(repos.contacts.remainingCount('camp_1')).toBe(2);
    expect(repos.contacts.inFlightCount('camp_1')).toBe(1);
  });

  it('searches by name and phone number safely', () => {
    addContact('cont_1', { name: 'Alexandra' });
    addContact('cont_2', { name: 'Bob' });

    expect(repos.contacts.search({ campaignId: 'camp_1', query: 'Alex' }).map((c) => c.id)).toEqual([
      'cont_1',
    ]);
    // A SQL metacharacter in user input must be treated as data, not syntax.
    expect(repos.contacts.search({ campaignId: 'camp_1', query: "'; DROP TABLE contacts; --" })).toEqual([]);
    expect(repos.contacts.counts('camp_1').total).toBe(2);
  });

  it('marks a contact do-not-call from any state', () => {
    addContact('cont_1');
    repos.contacts.markDoNotCall('cont_1', 100);
    expect(repos.contacts.findById('cont_1')?.status).toBe('DO_NOT_CALL');
    expect(repos.contacts.reserveNext('camp_1', 1000)).toBeNull();
  });
});

describe('AgentRepository', () => {
  beforeEach(() => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
  });

  it('round-trips an agent', () => {
    const agent = repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'Ada' }, 100);
    expect(agent.status).toBe('OFFLINE');
    expect(agent.currentCallId).toBeNull();
    expect(agent.callsHandled).toBe(0);
  });

  describe('reserveAvailable', () => {
    it('claims an available agent and attaches the call', () => {
      repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'Ada', status: 'AVAILABLE' }, 0);

      const agent = repos.agents.reserveAvailable('camp_1', 'call_1', 500);
      expect(agent?.status).toBe('RESERVED');
      expect(agent?.currentCallId).toBe('call_1');
    });

    it('never gives the same agent to two calls', () => {
      // Without this, two answered calls route to one seat and one is abandoned — exactly
      // what abandon-rate regulation exists to prevent.
      repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'Ada', status: 'AVAILABLE' }, 0);

      expect(repos.agents.reserveAvailable('camp_1', 'call_1', 100)?.id).toBe('agent_1');
      expect(repos.agents.reserveAvailable('camp_1', 'call_2', 101)).toBeNull();
    });

    it('ignores agents who are not AVAILABLE', () => {
      for (const status of ['OFFLINE', 'PAUSED', 'ON_CALL', 'WRAP_UP', 'RESERVED'] as const) {
        repos.agents.insert(`agent_${status}`, { campaignId: 'camp_1', name: status, status }, 0);
      }
      expect(repos.agents.reserveAvailable('camp_1', 'call_1', 100)).toBeNull();
    });

    it('picks the agent idle longest, deterministically', () => {
      repos.agents.insert('agent_2', { campaignId: 'camp_1', name: 'B', status: 'AVAILABLE' }, 200);
      repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'A', status: 'AVAILABLE' }, 100);

      expect(repos.agents.reserveAvailable('camp_1', 'call_1', 500)?.id).toBe('agent_1');
      expect(repos.agents.reserveAvailable('camp_1', 'call_2', 501)?.id).toBe('agent_2');
    });

    it('does not cross campaign boundaries', () => {
      repos.campaigns.insert('camp_2', campaignDraft(), 0);
      repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'A', status: 'AVAILABLE' }, 0);
      expect(repos.agents.reserveAvailable('camp_2', 'call_1', 100)).toBeNull();
    });
  });

  it('releases an agent and accumulates handle time', () => {
    repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'Ada', status: 'AVAILABLE' }, 0);
    repos.agents.reserveAvailable('camp_1', 'call_1', 100);

    repos.agents.release('agent_1', 5000, 4000);
    let agent = repos.agents.findById('agent_1');
    expect(agent?.status).toBe('AVAILABLE');
    expect(agent?.currentCallId).toBeNull();
    expect(agent?.callsHandled).toBe(1);
    expect(agent?.totalHandleTimeMs).toBe(4000);

    // Releasing without a handled call (an abandoned or failed call) must not inflate stats.
    repos.agents.reserveAvailable('camp_1', 'call_2', 6000);
    repos.agents.release('agent_1', 7000, null);
    agent = repos.agents.findById('agent_1');
    expect(agent?.callsHandled).toBe(1);
  });

  it('counts agents by status', () => {
    repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'A', status: 'AVAILABLE' }, 0);
    repos.agents.insert('agent_2', { campaignId: 'camp_1', name: 'B', status: 'AVAILABLE' }, 0);
    repos.agents.insert('agent_3', { campaignId: 'camp_1', name: 'C', status: 'ON_CALL' }, 0);

    const counts = repos.agents.countByStatus('camp_1');
    expect(counts.AVAILABLE).toBe(2);
    expect(counts.ON_CALL).toBe(1);
    expect(counts.OFFLINE).toBe(0);
    expect(repos.agents.availableCount('camp_1')).toBe(2);
  });
});

describe('CallRepository', () => {
  beforeEach(() => {
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
    repos.contacts.insert(
      'cont_1',
      { campaignId: 'camp_1', name: 'Alex', phoneNumber: fictionalPhoneNumber(1) },
      0,
    );
  });

  const createCall = (callId = 'call_1', attemptId = 'att_1', attemptNumber = 1): void => {
    repos.calls.createCallWithAttempt({
      callId,
      attemptId,
      campaignId: 'camp_1',
      contactId: 'cont_1',
      providerId: 'mock-provider',
      attemptNumber,
      now: 1000,
    });
  };

  it('creates a call and its attempt together', () => {
    createCall();
    const call = repos.calls.findById('call_1');
    const attempt = repos.calls.findAttemptById('att_1');

    expect(call?.status).toBe('CREATED');
    expect(call?.attemptId).toBe('att_1');
    expect(call?.abandoned).toBe(false);
    expect(call?.failureClass).toBe('NONE');
    expect(attempt?.callId).toBe('call_1');
    expect(attempt?.attemptNumber).toBe(1);
  });

  it('stamps the right timestamp on each status transition', () => {
    createCall();
    repos.calls.updateStatus('call_1', 'CREATED', 'QUEUED', 1100);
    repos.calls.updateStatus('call_1', 'QUEUED', 'DIALING', 1200);
    repos.calls.updateStatus('call_1', 'DIALING', 'RINGING', 1300);
    repos.calls.updateStatus('call_1', 'RINGING', 'CONNECTED', 1400);

    const call = repos.calls.findById('call_1');
    expect(call?.status).toBe('CONNECTED');
    expect(call?.dialingAt).toBe(1200);
    expect(call?.ringingAt).toBe(1300);
    expect(call?.connectedAt).toBe(1400);
  });

  it('refuses a status update from an unexpected current status', () => {
    createCall();
    expect(repos.calls.updateStatus('call_1', 'RINGING', 'CONNECTED', 1400)).toBe(false);
    expect(repos.calls.findById('call_1')?.status).toBe('CREATED');
  });

  it('finalises call and attempt together', () => {
    createCall();
    repos.calls.finalize({
      callId: 'call_1',
      attemptId: 'att_1',
      outcome: 'NO_ANSWER',
      failureCode: 'PROVIDER_NO_ANSWER',
      failureClass: 'TRANSIENT',
      endedAt: 5000,
      talkDurationMs: null,
    });

    expect(repos.calls.findById('call_1')?.outcome).toBe('NO_ANSWER');
    expect(repos.calls.findAttemptById('att_1')?.outcome).toBe('NO_ANSWER');
    expect(repos.calls.findAttemptById('att_1')?.failureClass).toBe('TRANSIENT');
  });

  it('keeps each attempt for a contact independently', () => {
    // The reason attempts are separate rows: the history is what retry policy, analytics
    // and debugging all depend on, and it would be overwritten if it lived on the contact.
    createCall('call_1', 'att_1', 1);
    repos.calls.finalize({
      callId: 'call_1',
      attemptId: 'att_1',
      outcome: 'NO_ANSWER',
      failureCode: null,
      failureClass: 'TRANSIENT',
      endedAt: 2000,
      talkDurationMs: null,
    });
    createCall('call_2', 'att_2', 2);
    repos.calls.finalize({
      callId: 'call_2',
      attemptId: 'att_2',
      outcome: 'BUSY',
      failureCode: null,
      failureClass: 'TRANSIENT',
      endedAt: 3000,
      talkDurationMs: null,
    });

    const attempts = repos.calls.listAttemptsForContact('cont_1');
    expect(attempts.map((a) => a.outcome)).toEqual(['NO_ANSWER', 'BUSY']);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it('counts only non-terminal calls as active', () => {
    createCall('call_1', 'att_1', 1);
    createCall('call_2', 'att_2', 2);
    repos.calls.updateStatus('call_2', 'CREATED', 'FAILED', 2000);

    expect(repos.calls.activeCount('camp_1')).toBe(1);
    expect(repos.calls.activeCount()).toBe(1);
    expect(repos.calls.listActive('camp_1').map((c) => c.id)).toEqual(['call_1']);
  });

  it('summarises outcomes and abandonment', () => {
    createCall('call_1', 'att_1', 1);
    repos.calls.markAbandoned('call_1');
    repos.calls.finalize({
      callId: 'call_1',
      attemptId: 'att_1',
      outcome: 'ABANDONED',
      failureCode: null,
      failureClass: 'NONE',
      endedAt: 4000,
      talkDurationMs: null,
    });
    createCall('call_2', 'att_2', 2);
    repos.calls.finalize({
      callId: 'call_2',
      attemptId: 'att_2',
      outcome: 'ANSWERED',
      failureCode: null,
      failureClass: 'NONE',
      endedAt: 9000,
      talkDurationMs: 6000,
    });

    const stats = repos.calls.statistics('camp_1');
    expect(stats.total).toBe(2);
    expect(stats.answered).toBe(1);
    expect(stats.abandoned).toBe(1);
    expect(stats.averageTalkMs).toBe(6000);
    expect(repos.calls.outcomeCounts('camp_1')).toEqual({ ABANDONED: 1, ANSWERED: 1 });
  });
});

describe('EventRepository', () => {
  const event = (seqHint: number, overrides: Record<string, unknown> = {}) =>
    ({
      id: `evt_${seqHint}`,
      type: 'call.created' as const,
      at: seqHint * 100,
      severity: 'info' as const,
      message: `event ${seqHint}`,
      metadata: {},
      ...overrides,
    });

  it('persists and returns events with a monotonic sequence', () => {
    repos.events.insertMany([event(1), event(2), event(3)]);

    expect(repos.events.count()).toBe(3);
    expect(repos.events.latestSeq()).toBe(3);
    // Default order is newest first, by seq — not by `at`, since many events share a
    // virtual millisecond.
    expect(repos.events.query().map((e) => e.id)).toEqual(['evt_3', 'evt_2', 'evt_1']);
  });

  it('round-trips correlation fields and metadata', () => {
    repos.events.insert(
      event(1, {
        campaignId: 'camp_1',
        callId: 'call_1',
        agentId: 'agent_1',
        metadata: { reason: 'CAMPAIGN_CONCURRENCY_LIMIT', current: 10 },
      }),
    );

    const [stored] = repos.events.query();
    expect(stored?.campaignId).toBe('camp_1');
    expect(stored?.callId).toBe('call_1');
    expect(stored?.contactId).toBeUndefined();
    expect(stored?.metadata).toEqual({ reason: 'CAMPAIGN_CONCURRENCY_LIMIT', current: 10 });
  });

  it('filters by type, severity, correlation id and time', () => {
    repos.events.insertMany([
      event(1, { type: 'call.created', campaignId: 'camp_1' }),
      event(2, { type: 'call.answered', campaignId: 'camp_1', severity: 'warn' }),
      event(3, { type: 'call.created', campaignId: 'camp_2' }),
    ]);

    expect(repos.events.query({ types: ['call.answered'] }).map((e) => e.id)).toEqual(['evt_2']);
    expect(repos.events.query({ severities: ['warn'] }).map((e) => e.id)).toEqual(['evt_2']);
    expect(repos.events.query({ campaignId: 'camp_2' }).map((e) => e.id)).toEqual(['evt_3']);
    expect(repos.events.query({ since: 200, until: 250 }).map((e) => e.id)).toEqual(['evt_2']);
  });

  it('supports resuming a stream from a sequence, in ascending order', () => {
    repos.events.insertMany([event(1), event(2), event(3)]);
    expect(repos.events.query({ afterSeq: 1 }).map((e) => e.id)).toEqual(['evt_2', 'evt_3']);
  });

  it('honours the limit', () => {
    repos.events.insertMany([event(1), event(2), event(3), event(4)]);
    expect(repos.events.query({ limit: 2 })).toHaveLength(2);
  });

  it('counts by type', () => {
    repos.events.insertMany([
      event(1, { type: 'call.created' }),
      event(2, { type: 'call.created' }),
      event(3, { type: 'call.answered' }),
    ]);
    expect(repos.events.countByType()).toEqual({ 'call.created': 2, 'call.answered': 1 });
  });
});

describe('SimulationRepository and ProviderConfigRepository', () => {
  it('records a simulation run and its report', () => {
    repos.simulations.start({
      id: 'sim_1',
      scenario: 'predictive',
      seed: 12_345,
      config: { agents: 5, contacts: 100 },
      startedAt: 0,
    });
    expect(repos.simulations.listRunning().map((r) => r.id)).toEqual(['sim_1']);

    repos.simulations.finish('sim_1', 'COMPLETED', 60_000, { invariantsPassed: true, attempts: 140 });

    const run = repos.simulations.findById('sim_1');
    expect(run?.status).toBe('COMPLETED');
    expect(run?.finishedAt).toBe(60_000);
    expect(run?.report).toEqual({ invariantsPassed: true, attempts: 140 });
    expect(run?.config).toEqual({ agents: 5, contacts: 100 });
    expect(repos.simulations.listRunning()).toEqual([]);
  });

  it('upserts provider configuration so failure injection can be changed live', () => {
    repos.providerConfigs.upsert('mock-provider', 'unreliable-mock', { timeoutRate: 0.05 }, 100);
    expect(repos.providerConfigs.findById('mock-provider')?.config).toEqual({ timeoutRate: 0.05 });

    repos.providerConfigs.upsert('mock-provider', 'unreliable-mock', { timeoutRate: 0.5 }, 200);
    expect(repos.providerConfigs.findById('mock-provider')?.config).toEqual({ timeoutRate: 0.5 });
    expect(repos.providerConfigs.list()).toHaveLength(1);
  });
});
