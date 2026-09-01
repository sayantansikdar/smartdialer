import type { FastifyInstance } from 'fastify';
import { parse, parseId, type ApiContext } from '../server.ts';
import { providerConfigSchema } from '../schemas.ts';

export function registerProviderRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  /**
   * Fault counters the unreliable driver keeps but the base one does not.
   *
   * Surfaced so the chaos is visible rather than mysterious: a dashboard showing an odd event
   * stream should be able to say "the provider duplicated 40 events" rather than leaving
   * someone to wonder whether the engine is broken.
   */
  const faults = (provider: { duplicatesSent?: number; reorderedEvents?: number; outageCount?: number }) => ({
    duplicatesSent: provider.duplicatesSent ?? 0,
    reorderedEvents: provider.reorderedEvents ?? 0,
    outageCount: provider.outageCount ?? 0,
  });

  app.get('/api/providers', async () => ({
    providers: container.providers.list().map((provider) => ({
      id: provider.id,
      driver: provider.driver,
      config: provider.getConfig(),
      metrics: provider.metrics(),
      faults: faults(provider as unknown as Parameters<typeof faults>[0]),
    })),
  }));

  app.get('/api/providers/:id', async (request) => {
    const provider = container.providers.getMock(parseId(request));
    return {
      id: provider.id,
      driver: provider.driver,
      config: provider.getConfig(),
      metrics: provider.metrics(),
      faults: faults(provider as unknown as Parameters<typeof faults>[0]),
    };
  });

  /**
   * Failure injection.
   *
   * This is a real control, not a demo affordance: the patch is applied to the live provider
   * and takes effect on the very next call the engine places. Raising `timeoutRate` here
   * makes calls genuinely go silent and genuinely trip the watchdog (CONSTRAINTS.md §5).
   */
  app.post('/api/providers/:id/config', async (request) => {
    const id = parseId(request);
    const patch = parse(providerConfigSchema, request.body, 'provider configuration');
    const provider = container.providers.getMock(id);
    const config = provider.updateConfig(patch);

    // Persisted so the injected behaviour survives a restart and is visible as a record of
    // what the demo was configured to do.
    container.repositories.providerConfigs.upsert(
      id,
      provider.driver,
      config as unknown as Record<string, unknown>,
      container.clock.now(),
    );

    container.events.emit({
      type: 'provider.fault_injected',
      severity: 'warn',
      message: `Provider ${id} configuration changed`,
      providerId: id,
      metadata: { patch },
    });
    container.events.flush();

    return { id, config, metrics: provider.metrics() };
  });
}
