import { Database } from '../../src/db/database.ts';
import { migrate } from '../../src/db/migrator.ts';
import { AgentRepository } from '../../src/db/repositories/agent-repository.ts';
import { CallRepository } from '../../src/db/repositories/call-repository.ts';
import { CampaignRepository } from '../../src/db/repositories/campaign-repository.ts';
import { ContactRepository } from '../../src/db/repositories/contact-repository.ts';
import { EventRepository } from '../../src/db/repositories/event-repository.ts';
import { ProviderConfigRepository } from '../../src/db/repositories/provider-config-repository.ts';
import { SimulationRepository } from '../../src/db/repositories/simulation-repository.ts';
import type { CampaignDraft } from '../../src/domain/campaign.ts';

export interface TestRepositories {
  readonly db: Database;
  readonly campaigns: CampaignRepository;
  readonly contacts: ContactRepository;
  readonly agents: AgentRepository;
  readonly calls: CallRepository;
  readonly events: EventRepository;
  readonly simulations: SimulationRepository;
  readonly providerConfigs: ProviderConfigRepository;
  close(): void;
}

/** A migrated in-memory database with every repository wired up. */
export function createTestRepositories(): TestRepositories {
  const db = new Database(':memory:');
  migrate(db);
  return {
    db,
    campaigns: new CampaignRepository(db),
    contacts: new ContactRepository(db),
    agents: new AgentRepository(db),
    calls: new CallRepository(db),
    events: new EventRepository(db),
    simulations: new SimulationRepository(db),
    providerConfigs: new ProviderConfigRepository(db),
    close: () => db.close(),
  };
}

export function campaignDraft(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    name: 'Test Campaign',
    dialingMode: 'PROGRESSIVE',
    maxConcurrentCalls: 10,
    maxCallsPerSecond: 5,
    maxAbandonRate: 0.03,
    maxAttemptsPerContact: 3,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitterRatio: 0.2,
    },
    safety: {
      pacingMultiplier: 1,
      targetOccupancy: 0.85,
      lineRatio: 1,
      maxLinesPerAgent: 3,
      abandonTimeoutMs: 2000,
      abandonMinSample: 20,
    },
    providerId: 'mock-provider',
    ...overrides,
  };
}

/**
 * Fictional numbers only. `+1-555-01xx` is the NANP block reserved for fiction, so no
 * seeded or generated contact in this repository can correspond to a real line
 * (CONSTRAINTS.md §1).
 */
export function fictionalPhoneNumber(index: number): string {
  return `+1555010${String(index % 100).padStart(2, '0')}`;
}
