/**
 * Request validation.
 *
 * Every route validates its input here before anything reaches a service. This is the
 * boundary where untrusted input stops being untrusted: services below this line may assume
 * their arguments are well-formed, which is why they can be written without defensive checks
 * scattered through them.
 *
 * The bounds are not arbitrary. They mirror the campaign-configuration validation rules the
 * brief calls for — negative concurrency, zero attempts, an abandon threshold above 1 — so an
 * unsafe campaign cannot be created through the API at all, rather than being caught later by
 * the safety engine.
 */

import { z } from 'zod';
import { CALL_STATUSES } from '../domain/call.ts';
import { CAMPAIGN_STATUSES, DIALING_MODES } from '../domain/campaign.ts';
import { CONTACT_STATUSES } from '../domain/contact.ts';
import { EVENT_SEVERITIES, EVENT_TYPES } from '../domain/events.ts';
import { PROVIDER_DRIVERS } from '../config/index.ts';

/**
 * Phone numbers are restricted to the reserved fictional block.
 *
 * This is a safety control, not input hygiene (CONSTRAINTS.md §1). `+1-555-01xx` is the NANP
 * range set aside for fiction, so no contact created through this API can correspond to a
 * real line — even if a real provider were somehow wired in later, and even if someone pasted
 * a genuine number by mistake.
 */
export const fictionalPhoneNumber = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // Normalise to digits first, so +15550100, +1-555-0100 and +1 555 0100 are all accepted
  // and all checked against the same rule.
  .refine((value) => /^155501\d{2}$/.test(value.replace(/\D/g, '')), {
    message:
      'Only the reserved fictional range +1555-01xx is accepted. This prototype must never ' +
      'hold a real phone number.',
  });

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20),
  initialDelayMs: z.number().int().min(1).max(600_000),
  maxDelayMs: z.number().int().min(1).max(3_600_000),
  multiplier: z.number().min(1).max(10),
  jitterRatio: z.number().min(0).max(1),
});

const safetySchema = z.object({
  pacingMultiplier: z.number().min(0.1).max(5),
  targetOccupancy: z.number().min(0).max(1),
  lineRatio: z.number().min(0.1).max(5),
  maxLinesPerAgent: z.number().min(1).max(10),
  abandonTimeoutMs: z.number().int().min(100).max(60_000),
  abandonMinSample: z.number().int().min(1).max(1000),
});

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dialingMode: z.enum(DIALING_MODES),
  maxConcurrentCalls: z.number().int().min(1).max(1000),
  maxCallsPerSecond: z.number().min(0.1).max(1000),
  maxAbandonRate: z.number().min(0).max(1),
  maxAttemptsPerContact: z.number().int().min(1).max(20),
  retryPolicy: retryPolicySchema.optional(),
  safety: safetySchema.partial().optional(),
  providerId: z.string().trim().min(1).max(100).optional(),
});

export const updateCampaignSchema = createCampaignSchema.partial();

export const createContactSchema = z.object({
  campaignId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  phoneNumber: fictionalPhoneNumber,
  timezone: z.string().trim().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const importContactsSchema = z.object({
  campaignId: z.string().trim().min(1),
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        phoneNumber: fictionalPhoneNumber,
        timezone: z.string().trim().max(64).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export const createAgentSchema = z.object({
  campaignId: z.string().trim().min(1).nullable(),
  name: z.string().trim().min(1).max(200),
  online: z.boolean().optional(),
});

export const agentStatusSchema = z.object({
  status: z.enum(['OFFLINE', 'AVAILABLE', 'PAUSED']),
});

export const contactQuerySchema = z.object({
  campaignId: z.string().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const callQuerySchema = z.object({
  campaignId: z.string().optional(),
  status: z.enum(CALL_STATUSES).optional(),
  contactId: z.string().optional(),
  agentId: z.string().optional(),
  activeOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const campaignQuerySchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

/** Comma-separated list in a query string, e.g. `?types=call.answered,call.busy`. */
const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.enum(values)).min(1));

export const eventQuerySchema = z.object({
  types: csv(EVENT_TYPES as unknown as [string, ...string[]]).optional(),
  severities: csv(EVENT_SEVERITIES as unknown as [string, ...string[]]).optional(),
  campaignId: z.string().optional(),
  contactId: z.string().optional(),
  callId: z.string().optional(),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const simulationSchema = z.object({
  scenario: z.string().trim().min(1).max(100).optional(),
  contacts: z.number().int().min(1).max(5000).optional(),
  agents: z.number().int().min(1).max(500).optional(),
  dialingMode: z.enum(DIALING_MODES).optional(),
  seed: z.number().int().optional(),
  speed: z.number().min(0).max(1000).optional(),
  maxConcurrentCalls: z.number().int().min(1).max(1000).optional(),
  callsPerSecond: z.number().min(0.1).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  maxAbandonRate: z.number().min(0).max(1).optional(),
  maxLinesPerAgent: z.number().min(1).max(10).optional(),
  providerDriver: z.enum(PROVIDER_DRIVERS).optional(),
  dncContacts: z.number().int().min(0).max(5000).optional(),
  contactsWithPriorAttempts: z.number().int().min(0).max(5000).optional(),
  maxVirtualMs: z.number().int().min(1000).optional(),
  provider: z
    .object({
      answerRate: z.number().min(0).max(1).optional(),
      noAnswerRate: z.number().min(0).max(1).optional(),
      busyRate: z.number().min(0).max(1).optional(),
      failureRate: z.number().min(0).max(1).optional(),
      timeoutRate: z.number().min(0).max(1).optional(),
      stuckRingingRate: z.number().min(0).max(1).optional(),
      errorRate: z.number().min(0).max(1).optional(),
      invalidNumberRate: z.number().min(0).max(1).optional(),
      meanRingDurationMs: z.number().int().min(1).max(120_000).optional(),
      meanCallDurationMs: z.number().int().min(1).max(600_000).optional(),
      latencySpikeMs: z.number().int().min(0).max(60_000).optional(),
      outageActive: z.boolean().optional(),
      maxConcurrentCalls: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
});

/** The failure-injection payload. Every field maps to real provider behaviour. */
export const providerConfigSchema = simulationSchema.shape.provider.unwrap();

export const emergencyStopSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export const speedSchema = z.object({
  speed: z.number().min(0.1).max(1000),
});
