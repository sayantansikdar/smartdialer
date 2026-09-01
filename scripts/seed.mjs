/**
 * `npm run seed` — load demo data.
 *
 * Produces the dataset the README's demo flow assumes: a progressive campaign, a predictive
 * one, a paused one to show controls against, agents, contacts including DNC entries and
 * contacts that already have attempts on the clock.
 *
 * Every number is drawn from a fixed seed and every phone number comes from the reserved
 * `+1-555-01xx` fictional block, so seeding is reproducible and cannot introduce a real
 * number into the database (CONSTRAINTS.md §1).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { loadConfig } = await import('../src/config/index.ts');
const { assertServerNotRunning } = await import('./guard-running-server.mjs');
const { createContainer, DEFAULT_PROVIDER_ID } = await import('../src/container.ts');
const { SeededRandom } = await import('../src/core/rng.ts');

const config = loadConfig();
await assertServerNotRunning('seed');
if (config.databasePath !== ':memory:') {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

const container = createContainer({ config, seed: 20_260_831 });
const random = new SeededRandom(20_260_831).stream('seed.data');

const FIRST = ['Alex', 'Bianca', 'Chen', 'Dara', 'Emeka', 'Freya', 'Gita', 'Hugo', 'Ines', 'Jonas',
  'Kira', 'Liam', 'Mira', 'Noor', 'Omar', 'Petra', 'Quinn', 'Rosa', 'Sami', 'Tariq'];
const LAST = ['Adeyemi', 'Bauer', 'Costa', 'Dubois', 'Eriksen', 'Fontaine', 'Grimaldi', 'Haddad',
  'Ivanov', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okonkwo', 'Pereira'];

let phoneCounter = 0;
/** Always inside +1-555-01xx. Cycles the last two digits; duplicates are harmless. */
const nextPhone = () => `+1555010${String(phoneCounter++ % 100).padStart(2, '0')}`;
const personName = () => `${random.pick(FIRST)} ${random.pick(LAST)}`;

function campaign(overrides) {
  return container.campaignService.create({
    name: 'Campaign',
    dialingMode: 'PROGRESSIVE',
    maxConcurrentCalls: 10,
    maxCallsPerSecond: 5,
    maxAbandonRate: 0.03,
    maxAttemptsPerContact: 3,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 5000, maxDelayMs: 60_000, multiplier: 2, jitterRatio: 0.2 },
    safety: {
      pacingMultiplier: 1, targetOccupancy: 0.85, lineRatio: 1,
      maxLinesPerAgent: 3, abandonTimeoutMs: 2000, abandonMinSample: 20,
    },
    providerId: DEFAULT_PROVIDER_ID,
    ...overrides,
  });
}

function addAgents(campaignId, count, prefix) {
  for (let i = 0; i < count; i += 1) {
    const agent = container.repositories.agents.insert(
      `agent_${prefix}_${String(i + 1).padStart(2, '0')}`,
      { campaignId, name: personName(), status: 'OFFLINE' },
      container.clock.now(),
    );
    container.agentService.bringOnline(agent.id);
  }
}

function addContacts(campaignId, count, options = {}) {
  const { dnc = 0, withPriorAttempts = 0 } = options;
  const created = [];
  for (let i = 0; i < count; i += 1) {
    created.push(
      container.contactService.create({
        campaignId,
        name: personName(),
        phoneNumber: nextPhone(),
        timezone: random.pick(['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata']),
        metadata: { source: random.pick(['import', 'web-form', 'referral']) },
      }),
    );
  }

  // DNC contacts exist in the seed data on purpose: the protection is only convincing if the
  // demo has contacts it must refuse to dial.
  for (let i = 0; i < dnc; i += 1) {
    const contact = created[i];
    if (contact) container.contactService.markDoNotCall(contact.id, 'Seeded do-not-call');
  }

  // Contacts partway through their attempt budget, so retry limits are visible immediately
  // rather than only after a campaign has been running for a while.
  for (let i = dnc; i < dnc + withPriorAttempts; i += 1) {
    const contact = created[i];
    if (!contact) continue;
    const attempts = random.int(1, 3);
    for (let a = 0; a < attempts; a += 1) {
      container.repositories.contacts.recordAttempt(contact.id, container.clock.now());
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// 1. Progressive campaign — READY to start, the safe default to demo first.
// ---------------------------------------------------------------------------
const progressive = campaign({
  name: 'Q3 Renewals (Progressive)',
  dialingMode: 'PROGRESSIVE',
  maxConcurrentCalls: 8,
  maxCallsPerSecond: 4,
});
addAgents(progressive.id, 5, 'prog');
addContacts(progressive.id, 50, { dnc: 4, withPriorAttempts: 6 });
container.campaignService.markReady(progressive.id);

// ---------------------------------------------------------------------------
// 2. Predictive campaign — 20 agents, because the variance guard correctly paces a
//    small team down to roughly 1:1 and the over-dial would not be visible.
// ---------------------------------------------------------------------------
const predictive = campaign({
  name: 'New Product Outreach (Predictive)',
  dialingMode: 'PREDICTIVE',
  maxConcurrentCalls: 40,
  maxCallsPerSecond: 15,
  maxAbandonRate: 0.03,
});
addAgents(predictive.id, 20, 'pred');
addContacts(predictive.id, 200, { dnc: 8, withPriorAttempts: 12 });
container.campaignService.markReady(predictive.id);

// ---------------------------------------------------------------------------
// 3. A small campaign left in DRAFT, so the configuration UI has something to edit
//    without disturbing a campaign someone might want to run.
// ---------------------------------------------------------------------------
const draft = campaign({
  name: 'Customer Survey (Draft)',
  dialingMode: 'PROGRESSIVE',
  maxConcurrentCalls: 4,
  maxCallsPerSecond: 2,
  maxAttemptsPerContact: 2,
});
addAgents(draft.id, 3, 'draft');
addContacts(draft.id, 25, { dnc: 3 });

container.repositories.providerConfigs.upsert(
  DEFAULT_PROVIDER_ID,
  config.providerDriver,
  container.providers.getMock(DEFAULT_PROVIDER_ID).getConfig(),
  container.clock.now(),
);

const summary = container.campaignService.list().map((c) => ({
  campaign: c.name,
  status: c.status,
  mode: c.dialingMode,
  agents: container.agentService.listByCampaign(c.id).length,
  contacts: container.contactService.counts(c.id).total,
  dnc: container.contactService.counts(c.id).byStatus.DO_NOT_CALL ?? 0,
}));

container.close();

console.log('\nSeeded SmartDialer demo data:\n');
console.table(summary);
console.log(`Database: ${config.databasePath}`);
console.log('Run `npm run dev` and open the dashboard.\n');
