import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testConfig } from '../../src/config/index.ts';
import { createContainer, DEFAULT_PROVIDER_ID, type Container } from '../../src/container.ts';
import { SimulationService } from '../../src/services/simulation.ts';
import { createSilentLogger } from '../../src/core/logger.ts';
import { buildServer } from '../../src/api/server.ts';

let app: FastifyInstance;
let container: Container;

beforeAll(async () => {
  container = createContainer({
    config: testConfig(),
    silentLogger: true,
    invariantMode: 'record',
  });
  app = buildServer({
    container,
    simulations: new SimulationService({
      baseConfig: container.config,
      repository: container.repositories.simulations,
      logger: createSilentLogger(),
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  container.close();
});

const json = (response: { body: string }): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

const validCampaign = {
  name: 'API Test Campaign',
  dialingMode: 'PROGRESSIVE' as const,
  maxConcurrentCalls: 5,
  maxCallsPerSecond: 3,
  maxAbandonRate: 0.03,
  maxAttemptsPerContact: 3,
};

async function createCampaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/campaigns',
    payload: { ...validCampaign, ...overrides },
  });
  return (json(response).campaign as { id: string }).id;
}

let phoneCounter = 0;
const nextPhone = (): string => `+155501${String(phoneCounter++ % 100).padStart(2, '0')}`;

/**
 * A campaign that can actually be started.
 *
 * `start` deliberately refuses a campaign with no agents or no contacts — such a campaign
 * would tick and do nothing, which looks exactly like a bug — so lifecycle tests must supply
 * both rather than asserting against a campaign the service is right to reject.
 */
async function createRunnableCampaign(name: string): Promise<string> {
  const id = await createCampaign({ name });
  await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: { campaignId: id, name: `${name} agent`, online: true },
  });
  await app.inject({
    method: 'POST',
    url: '/api/contacts',
    payload: { campaignId: id, name: `${name} contact`, phoneNumber: nextPhone() },
  });
  return id;
}

describe('Health and system', () => {
  it('reports health with the safety posture', async () => {
    const body = json(await app.inject({ method: 'GET', url: '/api/health' }));
    expect(body.status).toBe('ok');
    expect(body.simulationMode).toBe(true);
    expect(body.providerDriver).toBe('mock');
  });

  it('reports system status including concurrency and safety', async () => {
    const body = json(await app.inject({ method: 'GET', url: '/api/system/status' }));
    expect(body.system).toMatchObject({ emergencyStopped: false, simulationMode: true });
    expect(body.concurrency).toMatchObject({ globalMax: 50 });
    expect(body.safety).toMatchObject({ providerDriver: 'mock' });
  });

  it('publishes the safety policy so the UI can show what is enforced', async () => {
    const body = json(await app.inject({ method: 'GET', url: '/api/system/safety-rules' }));
    const rules = body.rules as Array<{ name: string }>;
    expect(rules[0]?.name).toBe('emergency-stop');
    expect(rules.at(-1)?.name).toBe('rate-limit');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect((json(response).error as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('Campaign validation', () => {
  it('creates a campaign in DRAFT', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: validCampaign,
    });
    expect(response.statusCode).toBe(201);
    expect((json(response).campaign as { status: string }).status).toBe('DRAFT');
  });

  it('rejects unsafe or nonsensical configuration with a 400 naming the field', async () => {
    // Every one of these is a configuration the brief calls out as invalid. Rejecting them
    // at the boundary means an unsafe campaign cannot exist, rather than being caught later.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['negative concurrency', { maxConcurrentCalls: -1 }],
      ['zero concurrency', { maxConcurrentCalls: 0 }],
      ['zero attempts', { maxAttemptsPerContact: 0 }],
      ['negative rate', { maxCallsPerSecond: -5 }],
      ['abandon rate above 1', { maxAbandonRate: 1.5 }],
      ['abandon rate below 0', { maxAbandonRate: -0.1 }],
      ['unknown dialing mode', { dialingMode: 'AGGRESSIVE' }],
      ['empty name', { name: '' }],
    ];

    for (const [label, patch] of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        payload: { ...validCampaign, ...patch },
      });
      expect(response.statusCode, label).toBe(400);
      expect((json(response).error as { code: string }).code, label).toBe('VALIDATION_FAILED');
    }
  });

  it('patches settings without resetting untouched safety tuning', async () => {
    const id = await createCampaign();
    const before = json(await app.inject({ method: 'GET', url: `/api/campaigns/${id}` }));
    const originalSafety = (before.campaign as { safety: Record<string, number> }).safety;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${id}`,
      payload: { safety: { lineRatio: 2 } },
    });

    const safety = (json(response).campaign as { safety: Record<string, number> }).safety;
    expect(safety.lineRatio).toBe(2);
    // The fields not mentioned must survive; silently resetting them is how a campaign ends
    // up with limits nobody chose.
    expect(safety.maxLinesPerAgent).toBe(originalSafety.maxLinesPerAgent);
    expect(safety.abandonTimeoutMs).toBe(originalSafety.abandonTimeoutMs);
  });
});

describe('Campaign lifecycle', () => {
  it('walks DRAFT -> READY -> RUNNING -> PAUSED -> RUNNING -> STOPPED', async () => {
    const id = await createRunnableCampaign('Lifecycle');
    const post = async (action: string): Promise<string> => {
      const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/${action}` });
      expect(response.statusCode, action).toBe(200);
      return (json(response).campaign as { status: string }).status;
    };

    expect(await post('ready')).toBe('READY');
    expect(await post('start')).toBe('RUNNING');
    expect(await post('pause')).toBe('PAUSED');
    expect(await post('resume')).toBe('RUNNING');
    expect(await post('stop')).toBe('STOPPED');
  });

  it('treats starting an already-running campaign as a no-op, not an error', async () => {
    // Deliberate idempotency: a double-clicked Start button should not produce an error, and
    // the transition helper short-circuits a same-state move.
    //
    // This is also the regression for BUG.md B-005 — the same request used to return an
    // opaque 500 because an id collision escaped as an unclassified exception.
    const id = await createRunnableCampaign('Idempotent start');
    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/start` });

    const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/start` });
    expect(response.statusCode).toBe(200);
    expect((json(response).campaign as { status: string }).status).toBe('RUNNING');

    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/stop` });
  });

  it('refuses a genuinely illegal transition with a classified 409, not a 500', async () => {
    // Pausing a DRAFT campaign is not a state the machine allows, and the refusal must carry
    // a code the UI can branch on rather than an opaque internal error.
    const id = await createRunnableCampaign('Illegal transition');
    const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/pause` });

    expect(response.statusCode).toBe(409);
    const error = json(response).error as { code: string; message: string };
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.message).toContain('DRAFT');
  });

  it('refuses to start a campaign with no agents or contacts', async () => {
    // Such a campaign would tick and do nothing, which is indistinguishable from a bug.
    const id = await createCampaign({ name: 'Empty' });
    const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/start` });
    expect(response.statusCode).toBe(409);
    expect((json(response).error as { code: string }).code).toBe('CONFLICT');
  });

  it('404s for an unknown campaign', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/campaigns/camp_missing' });
    expect(response.statusCode).toBe(404);
  });

  it('explains why a campaign is not dialing', async () => {
    const id = await createCampaign({ name: 'Explain' });
    const body = json(await app.inject({ method: 'GET', url: `/api/campaigns/${id}/safety` }));

    const denials = body.denials as Array<{ code: string }>;
    // A DRAFT campaign with no agents should report both reasons, not just the first.
    expect(denials.map((d) => d.code)).toContain('CAMPAIGN_NOT_RUNNING');
    expect((body.rules as unknown[]).length).toBeGreaterThan(5);
  });
});

describe('Contacts', () => {
  it('creates a contact in the fictional range', async () => {
    const campaignId = await createCampaign({ name: 'Contacts' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      payload: { campaignId, name: 'Test Person', phoneNumber: '+15550142' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses a phone number outside the reserved fictional block', async () => {
    // A safety control, not input hygiene: this prototype must never hold a real number
    // (CONSTRAINTS.md §1).
    const campaignId = await createCampaign({ name: 'Real number guard' });
    for (const phoneNumber of ['+14155551234', '+442071234567', '+15550200', '5551234']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/contacts',
        payload: { campaignId, name: 'Nope', phoneNumber },
      });
      expect(response.statusCode, phoneNumber).toBe(400);
      expect(json(response).error).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('imports many contacts at once', async () => {
    const campaignId = await createCampaign({ name: 'Import' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/contacts/import',
      payload: {
        campaignId,
        contacts: Array.from({ length: 10 }, (_, i) => ({
          name: `Imported ${i}`,
          phoneNumber: `+155501${String(i).padStart(2, '0')}`,
        })),
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('rejects an import containing any real-looking number', async () => {
    const campaignId = await createCampaign({ name: 'Import guard' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/contacts/import',
      payload: {
        campaignId,
        contacts: [
          { name: 'Fine', phoneNumber: '+15550100' },
          { name: 'Not fine', phoneNumber: '+14155551234' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('marks a contact do-not-call, and offers no route to undo it', async () => {
    const campaignId = await createCampaign({ name: 'DNC' });
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/contacts',
        payload: { campaignId, name: 'Do not call me', phoneNumber: '+15550177' },
      }),
    );
    const contactId = (created.contact as { id: string }).id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contactId}/do-not-call`,
    });
    expect((json(response).contact as { status: string }).status).toBe('DO_NOT_CALL');

    // DNC is a one-way door. An endpoint that could clear it would make the guarantee
    // conditional on nobody calling it by mistake.
    const undo = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contactId}/allow-calls`,
    });
    expect(undo.statusCode).toBe(404);
  });

  it('returns the full attempt history for a contact', async () => {
    const campaignId = await createCampaign({ name: 'Attempts' });
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/contacts',
        payload: { campaignId, name: 'History', phoneNumber: '+15550188' },
      }),
    );
    const contactId = (created.contact as { id: string }).id;
    const body = json(await app.inject({ method: 'GET', url: `/api/contacts/${contactId}` }));
    expect(body).toHaveProperty('attempts');
    expect(Array.isArray(body.attempts)).toBe(true);
  });
});

describe('Agents', () => {
  it('creates an agent offline by default', async () => {
    const campaignId = await createCampaign({ name: 'Agents' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { campaignId, name: 'Agent Smith' },
    });
    expect(response.statusCode).toBe(201);
    // Offline by default so a new agent never silently becomes capacity mid-campaign.
    expect((json(response).agent as { status: string }).status).toBe('OFFLINE');
  });

  it('brings an agent online and back offline', async () => {
    const campaignId = await createCampaign({ name: 'Agent status' });
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { campaignId, name: 'Toggler', online: true },
      }),
    );
    const agentId = (created.agent as { id: string }).id;
    expect((created.agent as { status: string }).status).toBe('AVAILABLE');

    const paused = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/status`,
      payload: { status: 'PAUSED' },
    });
    expect((json(paused).agent as { status: string }).status).toBe('PAUSED');
  });

  it('rejects an agent status the API does not allow a human to set', async () => {
    const campaignId = await createCampaign({ name: 'Agent status guard' });
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { campaignId, name: 'Guard' },
      }),
    );
    const agentId = (created.agent as { id: string }).id;

    // ON_CALL is owned by the engine. Letting an operator set it directly would desynchronise
    // the agent from the call it is supposedly handling.
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/status`,
      payload: { status: 'ON_CALL' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('Emergency stop', () => {
  it('engages, blocks dialing, and releases', async () => {
    const engage = json(
      await app.inject({
        method: 'POST',
        url: '/api/system/emergency-stop',
        payload: { reason: 'API test' },
      }),
    );
    expect((engage.system as { emergencyStopped: boolean }).emergencyStopped).toBe(true);
    expect((engage.system as { reason: string }).reason).toBe('API test');

    // A running campaign must now be denied by the first safety rule.
    const id = await createRunnableCampaign('Stopped');
    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/ready` });
    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/start` });
    const safety = json(await app.inject({ method: 'GET', url: `/api/campaigns/${id}/safety` }));
    expect((safety.denials as Array<{ code: string }>).map((d) => d.code)).toContain(
      'EMERGENCY_STOP',
    );

    const release = json(await app.inject({ method: 'POST', url: '/api/system/emergency-resume' }));
    expect((release.system as { emergencyStopped: boolean }).emergencyStopped).toBe(false);
    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/stop` });
  });

  it('is idempotent', async () => {
    await app.inject({ method: 'POST', url: '/api/system/emergency-stop', payload: {} });
    const second = await app.inject({
      method: 'POST',
      url: '/api/system/emergency-stop',
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/system/emergency-resume' });
  });
});

describe('Provider failure injection', () => {
  it('applies a config patch to the live provider', async () => {
    // Not a demo affordance: this changes real behaviour on the next call placed.
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${DEFAULT_PROVIDER_ID}/config`,
      payload: { timeoutRate: 0.5, outageActive: true },
    });
    expect(response.statusCode).toBe(200);

    const live = container.providers.getMock(DEFAULT_PROVIDER_ID).getConfig();
    expect(live.timeoutRate).toBe(0.5);
    expect(live.outageActive).toBe(true);

    await app.inject({
      method: 'POST',
      url: `/api/providers/${DEFAULT_PROVIDER_ID}/config`,
      payload: { timeoutRate: 0, outageActive: false },
    });
  });

  it('rejects an out-of-range injection value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${DEFAULT_PROVIDER_ID}/config`,
      payload: { timeoutRate: 5 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s for an unknown provider', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/providers/twilio' });
    expect(response.statusCode).toBe(404);
  });
});

describe('Events', () => {
  it('returns events with filtering', async () => {
    const body = json(await app.inject({ method: 'GET', url: '/api/events?limit=5' }));
    expect(Array.isArray(body.events)).toBe(true);
    expect((body.events as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it('filters by event type', async () => {
    const body = json(
      await app.inject({ method: 'GET', url: '/api/events?types=campaign.created&limit=50' }),
    );
    for (const event of body.events as Array<{ type: string }>) {
      expect(event.type).toBe('campaign.created');
    }
  });

  it('rejects an unknown event type rather than silently returning nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/events?types=not.a.real.event' });
    expect(response.statusCode).toBe(400);
  });
});

describe('Simulation', () => {
  it('lists the predefined scenarios', async () => {
    const body = json(await app.inject({ method: 'GET', url: '/api/simulation/scenarios' }));
    const names = (body.scenarios as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain('progressive');
    expect(names).toContain('predictive');
    expect(names).toContain('dnc');
  });

  it('runs a simulation and returns a report with the invariant verdict', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/simulation/start',
      payload: { scenario: 'api-test', contacts: 20, agents: 3, seed: 99 },
    });
    expect(response.statusCode).toBe(200);
    const report = json(response).report as Record<string, unknown>;
    expect(report.invariantsPassed).toBe(true);
    expect(report.totalContacts).toBe(20);
  });

  it('404s for an unknown scenario', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/simulation/scenario/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an out-of-range simulation configuration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/simulation/start',
      payload: { contacts: 999_999 },
    });
    expect(response.statusCode).toBe(400);
  });
});
