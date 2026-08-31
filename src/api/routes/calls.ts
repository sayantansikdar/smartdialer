import type { FastifyInstance } from 'fastify';
import { parse, parseId, type ApiContext } from '../server.ts';
import { callQuerySchema } from '../schemas.ts';

export function registerCallRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  app.get('/api/calls', async (request) => {
    const query = parse(callQuerySchema, request.query, 'query');
    return {
      calls: container.repositories.calls.search(query),
      activeCount: container.repositories.calls.activeCount(query.campaignId),
    };
  });

  app.get('/api/calls/:id', async (request) => {
    const call = container.repositories.calls.findById(parseId(request));
    if (call === null) return { call: null, attempt: null, contact: null };
    return {
      call,
      attempt: container.repositories.calls.findAttemptById(call.attemptId),
      contact: container.repositories.contacts.findById(call.contactId),
      agent: call.agentId === null ? null : container.repositories.agents.findById(call.agentId),
    };
  });
}
