import type { FastifyInstance } from 'fastify';
import { parse, parseId, type ApiContext } from '../server.ts';
import {
  campaignQuerySchema,
  createCampaignSchema,
  updateCampaignSchema,
} from '../schemas.ts';
import { DEFAULT_PROVIDER_ID } from '../../container.ts';
import type { CampaignDraft } from '../../domain/campaign.ts';

/** Fill in the parts of a campaign a caller need not specify. */
function toDraft(input: ReturnType<typeof createCampaignSchema.parse>): CampaignDraft {
  return {
    name: input.name,
    dialingMode: input.dialingMode,
    maxConcurrentCalls: input.maxConcurrentCalls,
    maxCallsPerSecond: input.maxCallsPerSecond,
    maxAbandonRate: input.maxAbandonRate,
    maxAttemptsPerContact: input.maxAttemptsPerContact,
    retryPolicy: input.retryPolicy ?? {
      maxAttempts: input.maxAttemptsPerContact,
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
      ...input.safety,
    },
    providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
  };
}

export function registerCampaignRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  app.get('/api/campaigns', async (request) => {
    const query = parse(campaignQuerySchema, request.query, 'query');
    const campaigns = container.campaignService.list();
    return {
      campaigns:
        query.status === undefined ? campaigns : campaigns.filter((c) => c.status === query.status),
    };
  });

  app.post('/api/campaigns', async (request, reply) => {
    const input = parse(createCampaignSchema, request.body, 'campaign');
    const campaign = container.campaignService.create(toDraft(input));
    return reply.code(201).send({ campaign });
  });

  app.get('/api/campaigns/:id', async (request) => {
    const campaign = container.campaignService.get(parseId(request));
    return {
      campaign,
      metrics: container.metrics.campaignMetrics(campaign),
      agents: container.agentService.listByCampaign(campaign.id),
      contactCounts: container.contactService.counts(campaign.id),
      running: container.engine.isRunning(campaign.id),
    };
  });

  app.patch('/api/campaigns/:id', async (request) => {
    const id = parseId(request);
    const patch = parse(updateCampaignSchema, request.body, 'campaign update');
    const current = container.campaignService.get(id);

    // `safety` is patched field by field rather than replaced wholesale. Sending one tuning
    // value must not silently reset the others to defaults — that is how a campaign ends up
    // with a maxLinesPerAgent nobody chose.
    const { safety, ...rest } = patch;
    return {
      campaign: container.campaignService.update(id, {
        ...rest,
        ...(safety === undefined ? {} : { safety: { ...current.safety, ...safety } }),
      }),
    };
  });

  // Lifecycle. Each of these performs the real transition — a paused campaign genuinely
  // stops dialing (CONSTRAINTS.md §5: no control may be decorative).
  app.post('/api/campaigns/:id/ready', async (request) => ({
    campaign: container.campaignService.markReady(parseId(request)),
  }));

  app.post('/api/campaigns/:id/start', async (request) => ({
    campaign: container.campaignService.start(parseId(request)),
  }));

  app.post('/api/campaigns/:id/pause', async (request) => ({
    campaign: container.campaignService.pause(parseId(request)),
  }));

  app.post('/api/campaigns/:id/resume', async (request) => ({
    campaign: container.campaignService.resume(parseId(request)),
  }));

  app.post('/api/campaigns/:id/stop', async (request) => ({
    campaign: container.campaignService.stop(parseId(request)),
  }));

  /**
   * Clear a predictive pause caused by the abandon-rate control.
   *
   * Separate from `resume` on purpose: the system never clears this by itself, because the
   * condition that tripped it is exactly the condition that would trip it again. Restarting
   * has to be a deliberate act by someone who has looked at why.
   */
  app.post('/api/campaigns/:id/resume-predictive', async (request) => ({
    campaign: container.campaignService.resumePredictive(parseId(request)),
  }));

  app.get('/api/campaigns/:id/metrics', async (request) => {
    const campaign = container.campaignService.get(parseId(request));
    return {
      campaign: container.metrics.campaignMetrics(campaign),
      agents: container.metrics.agentMetrics(campaign.id),
      dialer: container.engine.describeState(campaign.id),
    };
  });

  /**
   * Why is this campaign not dialing?
   *
   * Returns every safety rule currently denying, not just the first. Evaluated without
   * consuming rate-limit allowance, so asking the question does not perturb the campaign
   * being asked about.
   */
  app.get('/api/campaigns/:id/safety', async (request) => {
    const campaign = container.campaignService.get(parseId(request));
    return {
      rules: container.safety.describeRules(),
      denials: container.engine.explainSafety(campaign.id),
    };
  });
}
