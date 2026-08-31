import type { FastifyInstance } from 'fastify';
import { parse, parseId, type ApiContext } from '../server.ts';
import { agentStatusSchema, createAgentSchema } from '../schemas.ts';
import { ID_PREFIX } from '../../core/ids.ts';

export function registerAgentRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  app.get('/api/agents', async (request) => {
    const campaignId = (request.query as { campaignId?: string }).campaignId;
    const agents =
      campaignId === undefined
        ? container.repositories.agents.list()
        : container.agentService.listByCampaign(campaignId);
    return { agents, metrics: container.metrics.agentMetrics(campaignId) };
  });

  app.post('/api/agents', async (request, reply) => {
    const input = parse(createAgentSchema, request.body, 'agent');
    const agent = container.repositories.agents.insert(
      container.ids.next(ID_PREFIX.agent),
      { campaignId: input.campaignId, name: input.name, status: 'OFFLINE' },
      container.clock.now(),
    );
    // Agents are created offline and brought online explicitly, so a newly added agent never
    // silently becomes dialable capacity in the middle of a running campaign.
    if (input.online === true) container.agentService.bringOnline(agent.id);
    return reply.code(201).send({ agent: container.repositories.agents.findById(agent.id) });
  });

  app.get('/api/agents/:id', async (request) => {
    const id = parseId(request);
    const agent = container.repositories.agents.findById(id);
    if (agent === null) {
      return { agent: null, currentCall: null };
    }
    return {
      agent,
      currentCall:
        agent.currentCallId === null ? null : container.repositories.calls.findById(agent.currentCallId),
    };
  });

  app.post('/api/agents/:id/status', async (request) => {
    const input = parse(agentStatusSchema, request.body, 'agent status');
    const id = parseId(request);
    const agent =
      input.status === 'AVAILABLE'
        ? container.agentService.bringOnline(id)
        : container.agentService.setStatus(id, input.status);
    return { agent };
  });
}
