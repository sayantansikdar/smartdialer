import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from '../../src/config/index.ts';
import { createContainer, DEFAULT_PROVIDER_ID } from '../../src/container.ts';
import { IdGenerator } from '../../src/core/ids.ts';
import { campaignDraft } from '../helpers/db.ts';

const dbPath = join(tmpdir(), `smartdialer-id-recovery-${process.pid}.db`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
}

afterEach(cleanup);

describe('IdGenerator.restore', () => {
  it('moves a counter forward', () => {
    const ids = new IdGenerator();
    ids.restore('call', 41);
    expect(ids.next('call')).toBe('call_000042');
  });

  it('never moves a counter backwards', () => {
    // Restoring a lower value than already issued would reintroduce the very collision this
    // exists to prevent.
    const ids = new IdGenerator();
    ids.next('call');
    ids.next('call');
    ids.restore('call', 1);
    expect(ids.next('call')).toBe('call_000003');
  });

  it('ignores meaningless values', () => {
    const ids = new IdGenerator();
    ids.restore('call', 0);
    ids.restore('call', -5);
    ids.restore('call', Number.NaN);
    expect(ids.next('call')).toBe('call_000001');
  });
});

describe('Restarting against a persistent database', () => {
  it('does not reissue ids that already exist', async () => {
    // Regression for BUG.md B-005. Before the fix the second container reopened every
    // counter at 1 and the first event insert failed with a UNIQUE constraint violation —
    // which, because events are written on every state transition, took the dialer with it.
    cleanup();
    const config = testConfig({ DATABASE_PATH: dbPath });

    const first = createContainer({ config, silentLogger: true, invariantMode: 'throw' });
    const campaign = first.campaignService.create(
      campaignDraft({ providerId: DEFAULT_PROVIDER_ID }),
    );
    first.contactService.create({
      campaignId: campaign.id,
      name: 'Seeded Contact',
      phoneNumber: '+15550100',
    });
    const eventsAfterFirst = first.repositories.events.count();
    expect(eventsAfterFirst).toBeGreaterThan(0);
    first.close();

    // Restart against the same file, exactly as `npm run seed && npm run dev` does.
    const second = createContainer({ config, silentLogger: true, invariantMode: 'throw' });

    expect(() => {
      second.contactService.create({
        campaignId: campaign.id,
        name: 'Post-restart Contact',
        phoneNumber: '+15550101',
      });
      // Campaign creation emits `campaign.created`, so this is what actually exercises the
      // event-id collision that broke the live server.
      second.campaignService.create(campaignDraft({ providerId: DEFAULT_PROVIDER_ID }));
      second.events.flush();
    }).not.toThrow();

    expect(second.repositories.events.count()).toBeGreaterThan(eventsAfterFirst);

    // Ids continue rather than restarting, across every generated entity.
    const contacts = second.repositories.contacts.listByCampaign(campaign.id);
    expect(new Set(contacts.map((c) => c.id)).size).toBe(contacts.length);
    expect(second.campaignService.list().map((c) => c.id)).toEqual(['camp_000001', 'camp_000002']);
    second.close();
  });

  it('keeps a fresh in-memory database starting from one, so runs stay deterministic', () => {
    const container = createContainer({
      config: testConfig(),
      silentLogger: true,
      invariantMode: 'throw',
    });
    const campaign = container.campaignService.create(
      campaignDraft({ providerId: DEFAULT_PROVIDER_ID }),
    );
    expect(campaign.id).toBe('camp_000001');
    container.close();
  });
});
