import type { FastifyInstance } from 'fastify';
import { parse, parseId, type ApiContext } from '../server.ts';
import { contactQuerySchema, createContactSchema, importContactsSchema } from '../schemas.ts';

export function registerContactRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  app.get('/api/contacts', async (request) => {
    const query = parse(contactQuerySchema, request.query, 'query');
    return { contacts: container.contactService.search(query) };
  });

  app.post('/api/contacts', async (request, reply) => {
    const input = parse(createContactSchema, request.body, 'contact');
    return reply.code(201).send({ contact: container.contactService.create(input) });
  });

  app.post('/api/contacts/import', async (request, reply) => {
    const input = parse(importContactsSchema, request.body, 'contact import');
    const result = container.contactService.importMany(
      input.contacts.map((contact) => ({ ...contact, campaignId: input.campaignId })),
    );
    return reply.code(201).send(result);
  });

  app.get('/api/contacts/:id', async (request) => {
    const id = parseId(request);
    return {
      contact: container.contactService.get(id),
      // The attempt history is the point of separating contacts from attempts: four rows
      // showing no-answer, busy, timeout, connected rather than one row showing "connected".
      attempts: container.contactService.attempts(id),
    };
  });

  /**
   * Mark a contact do-not-call. Irreversible by design — there is no route to undo it.
   *
   * DNC is a one-way door in this system (see the contact state machine: it is a sink).
   * An API that could clear it would make the guarantee conditional on nobody calling that
   * endpoint by mistake.
   */
  app.post('/api/contacts/:id/do-not-call', async (request) => ({
    contact: container.contactService.markDoNotCall(parseId(request)),
  }));
}
