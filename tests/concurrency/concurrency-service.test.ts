/**
 * Concurrency correctness.
 *
 * A note on what "concurrent" means here. Node is single-threaded, so races in this system
 * do not come from preemption — they come from `await` boundaries, where one logical worker
 * yields and another runs to completion before the first resumes. That is a faithful model
 * of how this system can actually break, and it is what these tests reproduce: workers that
 * deliberately yield at the dangerous points.
 *
 * The properties under test are the ones that would let the dialer exceed its limits, dial
 * one contact twice, or route two calls to one agent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../src/core/clock.ts';
import { ConcurrencyService, type Lease } from '../../src/services/concurrency.ts';
import { campaignDraft, createTestRepositories, fictionalPhoneNumber, type TestRepositories } from '../helpers/db.ts';

const yieldToRuntime = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const acquireRequest = (callId: string, overrides: Record<string, unknown> = {}) => ({
  callId,
  campaignId: 'camp_1',
  providerId: 'mock-provider',
  campaignMaxConcurrentCalls: 100,
  ttlMs: 60_000,
  ...overrides,
});

describe('ConcurrencyService — the fundamental race', () => {
  it('never grants more slots than the global limit, however many workers ask', () => {
    // The canonical failure: two workers each observe "1 slot free" and each start a call.
    // Acquisition is synchronous with no await between the check and the increment, so the
    // second worker cannot observe the pre-increment state.
    const clock = new SimulatedClock();
    const service = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 1,
      providerMaxConcurrentCalls: 100,
    });

    const first = service.tryAcquire(acquireRequest('call_1'));
    const second = service.tryAcquire(acquireRequest('call_2'));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe('GLOBAL_CONCURRENCY_LIMIT');
    expect(service.activeGlobal).toBe(1);
  });

  it('grants exactly the limit when many workers compete', () => {
    const clock = new SimulatedClock();
    const service = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 7,
      providerMaxConcurrentCalls: 100,
    });

    const results = Array.from({ length: 50 }, (_, i) => service.tryAcquire(acquireRequest(`call_${i}`)));
    const granted = results.filter((r) => r.ok).length;

    expect(granted).toBe(7);
    expect(service.activeGlobal).toBe(7);
  });

  it('holds the limit across interleaved async workers', async () => {
    // The realistic shape: each worker acquires, then awaits (as it would while the provider
    // call is in flight), then releases. The peak must never exceed the limit.
    const clock = new SimulatedClock();
    const limit = 5;
    const service = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: limit,
      providerMaxConcurrentCalls: 100,
    });

    let peak = 0;
    let granted = 0;

    // Each worker retries until it gets a slot, which is what makes the slots actually
    // recycle. Without the retry, every worker would reach `tryAcquire` before any release
    // happened and the test would only prove the first five succeed.
    const worker = async (index: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await yieldToRuntime();
        const result = service.tryAcquire(acquireRequest(`call_${index}`));
        if (!result.ok) continue;

        granted += 1;
        peak = Math.max(peak, service.activeGlobal);
        // Yield while "the call is in progress" — the window another worker runs in.
        await yieldToRuntime();
        await yieldToRuntime();
        expect(service.activeGlobal).toBeLessThanOrEqual(limit);
        service.release(result.lease);
        return;
      }
      throw new Error(`worker ${index} never acquired a slot`);
    };

    const workerCount = 40;
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    expect(peak).toBe(limit);
    // Every worker was eventually served, so the slots were genuinely reused rather than
    // handed out once and exhausted.
    expect(granted).toBe(workerCount);
    expect(service.activeGlobal).toBe(0);
  });
});

describe('ConcurrencyService — scope limits', () => {
  const service = (overrides: { global?: number; provider?: number } = {}): ConcurrencyService =>
    new ConcurrencyService({
      clock: new SimulatedClock(),
      globalMaxConcurrentCalls: overrides.global ?? 100,
      providerMaxConcurrentCalls: overrides.provider ?? 100,
    });

  it('enforces the campaign limit independently per campaign', () => {
    const concurrency = service();

    for (let i = 0; i < 3; i += 1) {
      expect(
        concurrency.tryAcquire(acquireRequest(`call_${i}`, { campaignMaxConcurrentCalls: 3 })).ok,
      ).toBe(true);
    }
    const denied = concurrency.tryAcquire(acquireRequest('call_x', { campaignMaxConcurrentCalls: 3 }));
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.code).toBe('CAMPAIGN_CONCURRENCY_LIMIT');

    // A different campaign is unaffected.
    expect(
      concurrency.tryAcquire(
        acquireRequest('call_other', { campaignId: 'camp_2', campaignMaxConcurrentCalls: 3 }),
      ).ok,
    ).toBe(true);
    expect(concurrency.activeForCampaign('camp_1')).toBe(3);
    expect(concurrency.activeForCampaign('camp_2')).toBe(1);
  });

  it('enforces the provider limit across campaigns', () => {
    const concurrency = service({ provider: 2 });

    expect(concurrency.tryAcquire(acquireRequest('call_1')).ok).toBe(true);
    expect(concurrency.tryAcquire(acquireRequest('call_2', { campaignId: 'camp_2' })).ok).toBe(true);

    const denied = concurrency.tryAcquire(acquireRequest('call_3', { campaignId: 'camp_3' }));
    expect(denied.ok === false && denied.code).toBe('PROVIDER_CONCURRENCY_LIMIT');

    // A different provider still has room.
    expect(concurrency.tryAcquire(acquireRequest('call_4', { providerId: 'other' })).ok).toBe(true);
  });

  it('acquires all three scopes or none', () => {
    // A partial acquisition would leak capacity in whichever scope was incremented first.
    const concurrency = service({ global: 1 });

    concurrency.tryAcquire(acquireRequest('call_1'));
    const denied = concurrency.tryAcquire(acquireRequest('call_2', { campaignId: 'camp_2' }));

    expect(denied.ok).toBe(false);
    expect(concurrency.activeForCampaign('camp_2')).toBe(0);
    expect(concurrency.activeForProvider('mock-provider')).toBe(1);
  });

  it('reports the most global applicable limit first', () => {
    const concurrency = service({ global: 1, provider: 1 });
    concurrency.tryAcquire(acquireRequest('call_1'));

    const denied = concurrency.tryAcquire(acquireRequest('call_2', { campaignMaxConcurrentCalls: 0 }));
    expect(denied.ok === false && denied.code).toBe('GLOBAL_CONCURRENCY_LIMIT');
  });
});

describe('ConcurrencyService — releasing', () => {
  const build = (): ConcurrencyService =>
    new ConcurrencyService({
      clock: new SimulatedClock(),
      globalMaxConcurrentCalls: 2,
      providerMaxConcurrentCalls: 10,
    });

  it('frees the slot in every scope', () => {
    const concurrency = build();
    const result = concurrency.tryAcquire(acquireRequest('call_1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(concurrency.release(result.lease)).toBe(true);
    expect(concurrency.activeGlobal).toBe(0);
    expect(concurrency.activeForCampaign('camp_1')).toBe(0);
    expect(concurrency.activeForProvider('mock-provider')).toBe(0);
  });

  it('is idempotent — a double release cannot inflate capacity', () => {
    // The classic dialer bug (DECISIONS.md D-008). With a bare counter decrement the second
    // release would push the count below reality and the system would silently begin
    // exceeding its limit, with the symptom appearing far from the cause.
    const concurrency = build();
    const result = concurrency.tryAcquire(acquireRequest('call_1'));
    if (!result.ok) throw new Error('expected acquisition');

    expect(concurrency.release(result.lease)).toBe(true);
    expect(concurrency.release(result.lease)).toBe(false);
    expect(concurrency.release(result.lease)).toBe(false);

    expect(concurrency.activeGlobal).toBe(0);
    // The limit must still be exactly 2, not 4.
    expect(concurrency.tryAcquire(acquireRequest('a')).ok).toBe(true);
    expect(concurrency.tryAcquire(acquireRequest('b')).ok).toBe(true);
    expect(concurrency.tryAcquire(acquireRequest('c')).ok).toBe(false);
  });

  it('marks the lease released', () => {
    const concurrency = build();
    const result = concurrency.tryAcquire(acquireRequest('call_1'));
    if (!result.ok) throw new Error('expected acquisition');

    expect(result.lease.released).toBe(false);
    concurrency.release(result.lease);
    expect(result.lease.released).toBe(true);
  });

  it('ignores a lease it does not know about', () => {
    const concurrency = build();
    const foreign: Lease = {
      id: 'lease_999999',
      callId: 'call_x',
      campaignId: 'camp_1',
      providerId: 'mock-provider',
      acquiredAt: 0,
      expiresAt: 1,
      released: false,
    };
    expect(concurrency.release(foreign)).toBe(false);
    expect(concurrency.activeGlobal).toBe(0);
  });

  it('survives concurrent releases of the same lease', async () => {
    const concurrency = build();
    const result = concurrency.tryAcquire(acquireRequest('call_1'));
    if (!result.ok) throw new Error('expected acquisition');

    const releaser = async (): Promise<boolean> => {
      await yieldToRuntime();
      return concurrency.release(result.lease);
    };
    const outcomes = await Promise.all([releaser(), releaser(), releaser(), releaser()]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(concurrency.activeGlobal).toBe(0);
  });

  it('releases every lease for a campaign, leaving others alone', () => {
    const concurrency = new ConcurrencyService({
      clock: new SimulatedClock(),
      globalMaxConcurrentCalls: 100,
      providerMaxConcurrentCalls: 100,
    });
    concurrency.tryAcquire(acquireRequest('call_1'));
    concurrency.tryAcquire(acquireRequest('call_2'));
    concurrency.tryAcquire(acquireRequest('call_3', { campaignId: 'camp_2' }));

    expect(concurrency.releaseAllForCampaign('camp_1')).toHaveLength(2);
    expect(concurrency.activeForCampaign('camp_1')).toBe(0);
    expect(concurrency.activeForCampaign('camp_2')).toBe(1);
  });
});

describe('ConcurrencyService — leaked lease reclamation', () => {
  it('reclaims leases past their expiry', () => {
    // The backstop for a provider that accepts a call and never reports its end. Without
    // this, one silent call permanently costs a slot.
    const clock = new SimulatedClock();
    const concurrency = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 5,
      providerMaxConcurrentCalls: 5,
    });

    concurrency.tryAcquire(acquireRequest('call_1', { ttlMs: 10_000 }));
    concurrency.tryAcquire(acquireRequest('call_2', { ttlMs: 60_000 }));

    clock.advanceBy(20_000);
    const reclaimed = concurrency.sweepExpired();

    expect(reclaimed.map((lease) => lease.callId)).toEqual(['call_1']);
    expect(concurrency.activeGlobal).toBe(1);
  });

  it('returns what it reclaimed so the caller can record the fault', () => {
    // Silent reclamation would hide a genuine provider problem (CONSTRAINTS.md §3).
    const clock = new SimulatedClock();
    const concurrency = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 5,
      providerMaxConcurrentCalls: 5,
    });
    concurrency.tryAcquire(acquireRequest('call_1', { ttlMs: 1000 }));

    clock.advanceBy(2000);
    const reclaimed = concurrency.sweepExpired();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.expiresAt).toBe(1000);
  });

  it('reclaims nothing when everything is still live', () => {
    const clock = new SimulatedClock();
    const concurrency = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 5,
      providerMaxConcurrentCalls: 5,
    });
    concurrency.tryAcquire(acquireRequest('call_1', { ttlMs: 60_000 }));

    clock.advanceBy(1000);
    expect(concurrency.sweepExpired()).toEqual([]);
    expect(concurrency.activeGlobal).toBe(1);
  });

  it('reclaims deterministically when several expire together', () => {
    const clock = new SimulatedClock();
    const concurrency = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 10,
      providerMaxConcurrentCalls: 10,
    });
    for (let i = 0; i < 5; i += 1) concurrency.tryAcquire(acquireRequest(`call_${i}`, { ttlMs: 1000 }));

    clock.advanceBy(5000);
    const reclaimed = concurrency.sweepExpired();
    expect(reclaimed.map((l) => l.callId)).toEqual(['call_0', 'call_1', 'call_2', 'call_3', 'call_4']);
  });
});

describe('Contact reservation under concurrency', () => {
  let repos: TestRepositories;

  beforeEach(() => {
    repos = createTestRepositories();
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
  });

  afterEach(() => {
    repos.close();
  });

  const addContacts = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      repos.contacts.insert(
        `cont_${String(i).padStart(3, '0')}`,
        { campaignId: 'camp_1', name: `C${i}`, phoneNumber: fictionalPhoneNumber(i) },
        0,
      );
    }
  };

  it('gives one contact to exactly one of many interleaved workers', async () => {
    addContacts(1);

    const worker = async (): Promise<string | null> => {
      await yieldToRuntime();
      const contact = repos.contacts.reserveNext('camp_1', 1000);
      await yieldToRuntime();
      return contact?.id ?? null;
    };

    const results = await Promise.all(Array.from({ length: 20 }, () => worker()));
    const claimed = results.filter((id): id is string => id !== null);

    expect(claimed).toEqual(['cont_000']);
  });

  it('never gives the same contact to two workers across a whole pool', async () => {
    addContacts(30);

    const worker = async (): Promise<string[]> => {
      const claimed: string[] = [];
      for (let i = 0; i < 15; i += 1) {
        await yieldToRuntime();
        const contact = repos.contacts.reserveNext('camp_1', 1000);
        if (contact !== null) claimed.push(contact.id);
      }
      return claimed;
    };

    const results = await Promise.all([worker(), worker(), worker(), worker()]);
    const allClaimed = results.flat();

    expect(allClaimed).toHaveLength(30);
    expect(new Set(allClaimed).size).toBe(30);
  });

  it('lets a released contact be claimed again, but only once', async () => {
    addContacts(1);
    repos.contacts.reserveNext('camp_1', 1000);
    repos.contacts.releaseReservation('cont_000', 1100);

    const worker = async (): Promise<string | null> => {
      await yieldToRuntime();
      return repos.contacts.reserveNext('camp_1', 2000)?.id ?? null;
    };
    const results = await Promise.all([worker(), worker(), worker()]);

    expect(results.filter((id) => id !== null)).toEqual(['cont_000']);
  });

  it('never dials a DO_NOT_CALL contact however many workers try', async () => {
    addContacts(3);
    repos.contacts.markDoNotCall('cont_001', 0);

    const worker = async (): Promise<Array<string | null>> => {
      const claimed: Array<string | null> = [];
      for (let i = 0; i < 5; i += 1) {
        await yieldToRuntime();
        claimed.push(repos.contacts.reserveNext('camp_1', 1000)?.id ?? null);
      }
      return claimed;
    };

    const results = (await Promise.all([worker(), worker(), worker()])).flat();
    expect(results).not.toContain('cont_001');
    expect(results.filter((id) => id !== null).sort()).toEqual(['cont_000', 'cont_002']);
  });
});

describe('Agent allocation under concurrency', () => {
  let repos: TestRepositories;

  beforeEach(() => {
    repos = createTestRepositories();
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
  });

  afterEach(() => {
    repos.close();
  });

  it('never assigns one agent to two calls', async () => {
    // Two answered calls routed to one seat means one of them is abandoned — exactly what
    // abandon-rate regulation exists to prevent.
    repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'A', status: 'AVAILABLE' }, 0);

    const worker = async (callId: string): Promise<string | null> => {
      await yieldToRuntime();
      const agent = repos.agents.reserveAvailable('camp_1', callId, 1000);
      await yieldToRuntime();
      return agent?.id ?? null;
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => worker(`call_${i}`)),
    );
    expect(results.filter((id) => id !== null)).toEqual(['agent_1']);
  });

  it('distributes a pool of agents exactly once each', async () => {
    for (let i = 0; i < 6; i += 1) {
      repos.agents.insert(
        `agent_${i}`,
        { campaignId: 'camp_1', name: `A${i}`, status: 'AVAILABLE' },
        i,
      );
    }

    const worker = async (offset: number): Promise<Array<string>> => {
      const claimed: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        await yieldToRuntime();
        const agent = repos.agents.reserveAvailable('camp_1', `call_${offset}_${i}`, 1000);
        if (agent !== null) claimed.push(agent.id);
      }
      return claimed;
    };

    const claimed = (await Promise.all([worker(0), worker(1), worker(2)])).flat();
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed).size).toBe(6);
    expect(repos.agents.availableCount('camp_1')).toBe(0);
  });

  it('makes a released agent available to exactly one waiting worker', async () => {
    repos.agents.insert('agent_1', { campaignId: 'camp_1', name: 'A', status: 'AVAILABLE' }, 0);
    repos.agents.reserveAvailable('camp_1', 'call_1', 100);
    repos.agents.release('agent_1', 5000, 4000);

    const worker = async (callId: string): Promise<string | null> => {
      await yieldToRuntime();
      return repos.agents.reserveAvailable('camp_1', callId, 6000)?.id ?? null;
    };

    const results = await Promise.all([worker('call_2'), worker('call_3'), worker('call_4')]);
    expect(results.filter((id) => id !== null)).toEqual(['agent_1']);
  });
});

describe('Combined reservation + slot acquisition', () => {
  let repos: TestRepositories;

  beforeEach(() => {
    repos = createTestRepositories();
    repos.campaigns.insert('camp_1', campaignDraft(), 0);
  });

  afterEach(() => {
    repos.close();
  });

  it('holds every limit when workers race through the full dial sequence', async () => {
    // The sequence the engine actually performs: reserve the contact, then acquire the
    // slot, releasing both on any failure. Yields are inserted at each boundary to force
    // the interleavings that would break a naive implementation.
    const clock = new SimulatedClock();
    const concurrency = new ConcurrencyService({
      clock,
      globalMaxConcurrentCalls: 4,
      providerMaxConcurrentCalls: 10,
    });

    for (let i = 0; i < 40; i += 1) {
      repos.contacts.insert(
        `cont_${String(i).padStart(3, '0')}`,
        { campaignId: 'camp_1', name: `C${i}`, phoneNumber: fictionalPhoneNumber(i) },
        0,
      );
    }

    let peak = 0;
    const dialled: string[] = [];

    const worker = async (): Promise<void> => {
      for (let i = 0; i < 15; i += 1) {
        await yieldToRuntime();

        const contact = repos.contacts.reserveNext('camp_1', 1000);
        if (contact === null) return;

        const result = concurrency.tryAcquire(acquireRequest(`call_${contact.id}`, {
          campaignMaxConcurrentCalls: 3,
        }));
        if (!result.ok) {
          // Every failure path must give the contact back, or contacts leak out of the pool.
          repos.contacts.releaseReservation(contact.id, 1000);
          continue;
        }

        dialled.push(contact.id);
        peak = Math.max(peak, concurrency.activeGlobal);

        await yieldToRuntime();
        expect(concurrency.activeGlobal).toBeLessThanOrEqual(4);
        expect(concurrency.activeForCampaign('camp_1')).toBeLessThanOrEqual(3);

        concurrency.release(result.lease);
        repos.contacts.setStatus(contact.id, 'COMPLETED', 1000);
      }
    };

    await Promise.all([worker(), worker(), worker(), worker(), worker()]);

    // The campaign limit (3) is stricter than the global limit (4), so it is what binds.
    expect(peak).toBeLessThanOrEqual(3);
    expect(new Set(dialled).size).toBe(dialled.length);
    expect(concurrency.activeGlobal).toBe(0);
    // No contact was stranded in RESERVED by a failed acquisition.
    expect(repos.contacts.counts('camp_1').byStatus['RESERVED']).toBeUndefined();
  });
});
