import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from '../../src/config/index.ts';
import { createContainer, DEFAULT_PROVIDER_ID, type Container } from '../../src/container.ts';
import { campaignDraft, fictionalPhoneNumber } from '../helpers/db.ts';
import { FastDriver } from '../../src/core/clock.ts';

/**
 * The assignment's first failure case, verbatim:
 *
 *     Agent reserved > Borrower reserved > Call initiated > Worker crashes.
 *     What happens when the system comes back?
 *
 * A crash is simulated the only honest way: build a container against a real file, drive it
 * until work is genuinely in flight, then abandon it *without* stopping the campaign or
 * closing anything gracefully — exactly what `kill -9` leaves behind. A second container then
 * opens the same database, as a restarted process would.
 */

const dbPath = join(tmpdir(), `smartdialer-crash-${process.pid}.db`);
const cleanup = (): void => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
};
afterEach(cleanup);

function boot(): Container {
  return createContainer({
    config: testConfig({ DATABASE_PATH: dbPath, PROVIDER_TIMEOUT_MS: '45000' }),
    silentLogger: true,
    invariantMode: 'record',
    providerConfig: { answerRate: 1, noAnswerRate: 0, busyRate: 0, failureRate: 0, meanCallDurationMs: 600_000 },
  });
}

async function crashMidDial(): Promise<{ campaignId: string; inFlight: number }> {
  cleanup();
  const container = boot();
  const campaign = container.campaignService.create(
    campaignDraft({ providerId: DEFAULT_PROVIDER_ID, maxConcurrentCalls: 5 }),
  );

  for (let i = 0; i < 3; i += 1) {
    const agent = container.repositories.agents.insert(
      `agent_${i}`,
      { campaignId: campaign.id, name: `Agent ${i}`, status: 'OFFLINE' },
      0,
    );
    container.agentService.bringOnline(agent.id);
  }
  for (let i = 0; i < 10; i += 1) {
    container.contactService.create({
      campaignId: campaign.id,
      name: `Contact ${i}`,
      phoneNumber: fictionalPhoneNumber(i),
    });
  }

  container.campaignService.start(campaign.id);
  // Long calls, so work is still in flight when we pull the plug.
  await new FastDriver(container.clock).run({ untilVirtualMs: 8000, maxRealMs: 5000 });

  const inFlight = container.repositories.calls.activeCount(campaign.id);
  expect(inFlight, 'the test needs calls actually in flight to be meaningful').toBeGreaterThan(0);

  // The crash. No stop, no close, no graceful shutdown — the in-memory ledger, the timers and
  // the call contexts all simply cease to exist.
  return { campaignId: campaign.id, inFlight };
}

describe('Worker crash', () => {
  it('leaves the database inconsistent when the process dies mid-dial', async () => {
    // Establishing the problem before testing the fix. Without recovery this state is what a
    // restart inherits, and every piece of it is a permanent leak.
    const { campaignId } = await crashMidDial();

    const inspector = createContainer({
      config: testConfig({ DATABASE_PATH: dbPath }),
      silentLogger: true,
      invariantMode: 'record',
    });
    // The inspector itself recovers on boot, so read its report rather than the raw state.
    expect(inspector.recoveryReport.clean).toBe(false);
    expect(inspector.recoveryReport.callsReclaimed).toBeGreaterThan(0);
    expect(campaignId).toBeTruthy();
    inspector.close();
  });

  it('reclaims every orphaned call, contact and agent on restart', async () => {
    const { campaignId } = await crashMidDial();

    const restarted = boot();
    const report = restarted.recoveryReport;

    expect(report.clean).toBe(false);
    expect(report.callsReclaimed).toBeGreaterThan(0);
    expect(report.agentsReleased).toBeGreaterThan(0);

    // Nothing may be left mid-flight.
    expect(restarted.repositories.calls.activeCount()).toBe(0);
    for (const agent of restarted.repositories.agents.list()) {
      expect(agent.status, agent.id).toBe('AVAILABLE');
      expect(agent.currentCallId, agent.id).toBeNull();
    }
    const counts = restarted.repositories.contacts.counts(campaignId);
    for (const stuck of ['RESERVED', 'DIALING', 'RINGING', 'CONNECTED']) {
      expect(counts.byStatus[stuck] ?? 0, stuck).toBe(0);
    }

    // And the ledger agrees with the database from the very first check.
    expect(restarted.invariants.check()).toEqual([]);
    restarted.close();
  });

  it('does not burn the contacts it could not observe', async () => {
    // The crash was our fault, not the borrower's. Reclaimed calls are classified TIMEOUT —
    // transient — so their contacts stay retriable rather than being written off.
    const { campaignId } = await crashMidDial();

    const restarted = boot();
    const counts = restarted.repositories.contacts.counts(campaignId);
    expect(counts.byStatus['EXHAUSTED'] ?? 0).toBe(0);
    expect(counts.byStatus['READY'] ?? 0).toBeGreaterThan(0);

    const reclaimed = restarted.repositories.calls
      .search({ campaignId, limit: 100 })
      .filter((c) => c.failureCode === 'WORKER_CRASH');
    expect(reclaimed.length).toBeGreaterThan(0);
    expect(reclaimed.every((c) => c.failureClass === 'TRANSIENT')).toBe(true);
    restarted.close();
  });

  it('can resume the campaign after recovery', async () => {
    // The point of all of it: the work continues.
    const { campaignId } = await crashMidDial();

    const restarted = boot();
    const before = restarted.repositories.calls.search({ campaignId, limit: 200 }).length;

    restarted.campaignService.resume(campaignId);
    await new FastDriver(restarted.clock).run({ untilVirtualMs: 60_000, maxRealMs: 5000 });

    expect(
      restarted.repositories.calls.search({ campaignId, limit: 200 }).length,
    ).toBeGreaterThan(before);
    expect(restarted.invariants.check()).toEqual([]);
    restarted.close();
  });

  it('records every reclamation as an event rather than tidying up silently', async () => {
    await crashMidDial();

    const restarted = boot();
    const events = restarted.repositories.events.query({ limit: 500 });
    const recovery = events.filter((e) => e.metadata['reason'] === 'worker-crash');

    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.every((e) => e.severity === 'warn')).toBe(true);
    restarted.close();
  });

  it('is a no-op on a clean start', async () => {
    cleanup();
    const fresh = boot();
    expect(fresh.recoveryReport).toEqual({
      callsReclaimed: 0,
      contactsReleased: 0,
      agentsReleased: 0,
      clean: true,
    });
    fresh.close();
  });
});
