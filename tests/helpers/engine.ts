import { createContainer, DEFAULT_PROVIDER_ID, type Container } from '../../src/container.ts';
import { testConfig } from '../../src/config/index.ts';
import type { MockProviderConfig } from '../../src/providers/mock-provider.ts';
import type { Campaign, CampaignDraft } from '../../src/domain/campaign.ts';
import type { SmartDialerEvent } from '../../src/domain/events.ts';
import { campaignDraft, fictionalPhoneNumber } from './db.ts';

export interface EngineHarnessOptions {
  readonly campaign?: Partial<CampaignDraft>;
  readonly contacts?: number;
  readonly agents?: number;
  readonly seed?: number;
  readonly provider?: Partial<MockProviderConfig>;
  readonly env?: Record<string, string>;
  /** Tests default to throwing on any invariant violation, at the transition that caused it. */
  readonly invariantMode?: 'throw' | 'record';
}

export interface EngineHarness {
  readonly container: Container;
  readonly campaign: Campaign;
  readonly events: SmartDialerEvent[];
  /** Run until the clock is idle (campaign finished) or the guards trip. */
  run(options?: { untilVirtualMs?: number; isDone?: () => boolean }): Promise<void>;
  reload(): Campaign;
  eventTypes(): string[];
  close(): void;
}

/**
 * Builds a complete, isolated SmartDialer: in-memory database, seeded RNG, virtual clock,
 * one campaign with agents and contacts, ready to start.
 *
 * Contacts use the reserved `+1-555-01xx` fictional block (CONSTRAINTS.md §1).
 */
export function createEngineHarness(options: EngineHarnessOptions = {}): EngineHarness {
  const container = createContainer({
    config: testConfig({
      DIALER_TICK_INTERVAL_MS: '250',
      PROVIDER_TIMEOUT_MS: '45000',
      ABANDON_TIMEOUT_MS: '2000',
      ...options.env,
    }),
    seed: options.seed ?? 12_345,
    silentLogger: true,
    invariantMode: options.invariantMode ?? 'throw',
    ...(options.provider === undefined ? {} : { providerConfig: options.provider }),
  });

  const campaign = container.campaignService.create(
    campaignDraft({ providerId: DEFAULT_PROVIDER_ID, ...options.campaign }),
  );

  const agentCount = options.agents ?? 3;
  for (let i = 0; i < agentCount; i += 1) {
    const agent = container.repositories.agents.insert(
      `agent_${String(i).padStart(3, '0')}`,
      { campaignId: campaign.id, name: `Agent ${i}`, status: 'OFFLINE' },
      container.clock.now(),
    );
    container.agentService.bringOnline(agent.id);
  }

  const contactCount = options.contacts ?? 10;
  for (let i = 0; i < contactCount; i += 1) {
    container.contactService.create({
      campaignId: campaign.id,
      name: `Contact ${i}`,
      phoneNumber: fictionalPhoneNumber(i),
    });
  }

  const events: SmartDialerEvent[] = [];
  container.events.subscribe((event) => events.push(event));

  return {
    container,
    campaign,
    events,
    run: async (runOptions = {}) => {
      await container.fastDriver.run({
        maxRealMs: 10_000,
        maxBatches: 200_000,
        ...runOptions,
      });
      container.events.flush();
    },
    reload: () => container.repositories.campaigns.findById(campaign.id) as Campaign,
    eventTypes: () => events.map((event) => event.type),
    close: () => container.close(),
  };
}

/** A stable digest of the ordered event stream, used to prove two runs are identical. */
export function eventDigest(events: readonly SmartDialerEvent[]): string {
  return events
    .filter((event) => event.type !== 'dialer.plan' && event.type !== 'dialer.tick')
    .map((event) => `${event.at}:${event.type}:${event.callId ?? ''}:${event.contactId ?? ''}`)
    .join('\n');
}
