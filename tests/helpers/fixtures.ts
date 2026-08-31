import type { Campaign } from '../../src/domain/campaign.ts';
import type { Contact } from '../../src/domain/contact.ts';
import type { SafetyContext } from '../../src/services/safety.ts';

export function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp_1',
    name: 'Test Campaign',
    status: 'RUNNING',
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
    predictivePausedReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'cont_1',
    campaignId: 'camp_1',
    name: 'Test Contact',
    phoneNumber: '+15550100',
    status: 'RESERVED',
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    timezone: 'UTC',
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A context in which every rule passes, so a test can break exactly one thing. */
export function makeSafetyContext(overrides: Partial<SafetyContext> = {}): SafetyContext {
  return {
    now: 1000,
    campaign: makeCampaign(),
    contact: makeContact(),
    emergencyStopped: false,
    concurrency: { global: 0, globalMax: 50, campaign: 0, provider: 0, providerMax: 40 },
    agents: { available: 5, pendingConnections: 0 },
    abandon: { rate: 0, sample: 0 },
    rateLimiter: { tryConsume: () => true, available: () => 10 },
    ...overrides,
  };
}
