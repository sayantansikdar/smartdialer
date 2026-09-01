/**
 * The HTTP surface.
 *
 * Deliberately thin: routes validate input, call one service method, and shape a response.
 * No business logic lives here (ARCHITECTURE.md — nothing under `src/services/` may import
 * from `src/api/`, and the reverse dependency is the only one allowed).
 *
 * Errors are translated in one place, at the bottom of this file. A `SmartDialerError`
 * already carries a machine-readable code, an HTTP status and typed metadata, so the handler
 * simply forwards it — which is why no route needs its own try/catch.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { AppConfig } from '../config/index.ts';
import { isSmartDialerError, NotFoundError, ValidationError } from '../core/errors.ts';
import type { Container } from '../container.ts';
import type { SimulationService } from '../services/simulation.ts';
import { SseBroadcaster } from './sse.ts';
import { registerCampaignRoutes } from './routes/campaigns.ts';
import { registerContactRoutes } from './routes/contacts.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerCallRoutes } from './routes/calls.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerProviderRoutes } from './routes/providers.ts';
import { registerSimulationRoutes } from './routes/simulation.ts';

export interface ApiContext {
  readonly container: Container;
  readonly config: AppConfig;
  readonly sse: SseBroadcaster;
  readonly simulations: SimulationService;
}

/** Parse with a schema, converting a failure into a structured 400. */
export function parse<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    problem: issue.message,
  }));
  throw new ValidationError(
    `Invalid ${what}: ${issues.map((i) => `${i.field} — ${i.problem}`).join('; ')}`,
    { issues },
  );
}

const idParams = z.object({ id: z.string().trim().min(1).max(100) });

export function parseId(request: FastifyRequest): string {
  return parse(idParams, request.params, 'path parameter').id;
}

export interface BuildServerOptions {
  readonly container: Container;
  readonly simulations: SimulationService;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { container } = options;
  const app = Fastify({
    // The application has its own structured logger wired to virtual time; Fastify's would
    // interleave wall-clock lines with it and make the two impossible to read together.
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  /**
   * Treat an empty JSON body as `{}`.
   *
   * Several endpoints take no body at all — `/start`, `/pause`, `/emergency-resume`. Browsers
   * and fetch wrappers routinely set `content-type: application/json` on every request
   * regardless, and Fastify's default parser rejects an empty body outright, which surfaced
   * as a 500 on a request that was perfectly valid.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new ValidationError('Request body is not valid JSON'), undefined);
    }
  });

  const sse = new SseBroadcaster({ logger: container.logger });
  const context: ApiContext = {
    container,
    config: container.config,
    sse,
    simulations: options.simulations,
  };

  // Every event the engine emits reaches every connected dashboard. This subscription is the
  // entire live-update mechanism.
  container.events.subscribe((event) => sse.broadcast(event));

  app.addHook('onClose', async () => {
    sse.closeAll();
  });

  // The dashboard is served from Vite on a different port in development, so the API must
  // accept its requests. Scoped to local origins: this prototype binds to localhost and has
  // no authentication, so a permissive CORS policy would be handing the browser of anyone
  // who visits a hostile page a remote control for the dialer.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type');
    }
    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    simulationMode: container.config.simulationMode,
    providerDriver: container.config.providerDriver,
    virtualTime: container.clock.now(),
    // Which database this process has open. Reported so the seed and reset scripts can tell
    // whether they are about to write behind a *running* server's back, rather than refusing
    // whenever any server happens to be listening.
    databasePath: container.config.databasePath,
  }));

  registerCampaignRoutes(app, context);
  registerContactRoutes(app, context);
  registerAgentRoutes(app, context);
  registerCallRoutes(app, context);
  registerEventRoutes(app, context);
  registerSystemRoutes(app, context);
  registerProviderRoutes(app, context);
  registerSimulationRoutes(app, context);

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url}`,
        metadata: {},
      },
    });
  });

  app.setErrorHandler((error, request, reply: FastifyReply) => {
    if (isSmartDialerError(error)) {
      // Expected, classified failures: a safety denial, a bad transition, a missing entity.
      // The status and code come from the error itself, so the UI can branch on them.
      if (error.httpStatus >= 500) {
        container.logger.error(error.message, { code: error.code, ...error.metadata });
      }
      void reply.code(error.httpStatus).send({ error: error.toJSON() });
      return;
    }

    // Framework-level errors (malformed body, unsupported media type) already know they are
    // the client's fault and carry a 4xx status. Reporting them as 500s would send someone
    // hunting for a server bug that does not exist.
    const framework = error as { statusCode?: number; code?: string; message?: string };
    const status = framework.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      void reply.code(status).send({
        error: {
          code: framework.code ?? 'BAD_REQUEST',
          message: framework.message ?? 'Bad request',
          metadata: {},
        },
      });
      return;
    }

    // Anything else is a genuine bug. Log it in full, but do not leak internals to the
    // client (CONSTRAINTS.md §5 — no silent failures, and no exposed internals either).
    container.logger.error('Unhandled error in API handler', {
      method: request.method,
      url: request.url,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    void reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', metadata: {} },
    });
  });

  return app;
}

export { NotFoundError };
