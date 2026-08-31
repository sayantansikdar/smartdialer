import type { FastifyInstance } from 'fastify';
import { parse, type ApiContext } from '../server.ts';
import { eventQuerySchema } from '../schemas.ts';
import type { EventFilter } from '../../domain/events.ts';

export function registerEventRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container, sse } = ctx;

  app.get('/api/events', async (request) => {
    const query = parse(eventQuerySchema, request.query, 'query');
    const events = container.repositories.events.query(query as EventFilter);
    return { events, latestSeq: container.repositories.events.latestSeq() };
  });

  app.get('/api/campaigns/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    const query = parse(eventQuerySchema, request.query, 'query');
    return {
      events: container.repositories.events.query({ ...query, campaignId: id } as EventFilter),
    };
  });

  /**
   * The live event stream.
   *
   * Held open for the life of the connection, so this handler never returns. `reply.hijack()`
   * tells Fastify to stop managing the response — without it Fastify would try to serialise
   * and end a response the broadcaster is still writing to.
   */
  app.get('/api/events/stream', (request, reply) => {
    const campaignId = (request.query as { campaignId?: string }).campaignId;
    reply.hijack();
    sse.subscribe(reply, { campaignId });
  });
}
