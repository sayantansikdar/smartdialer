import type { FastifyInstance } from 'fastify';
import { parse, type ApiContext } from '../server.ts';
import { emergencyStopSchema, speedSchema } from '../schemas.ts';

export function registerSystemRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container } = ctx;

  app.get('/api/system/status', async () => ({
    system: container.system.status(),
    concurrency: {
      ...container.concurrency.counts(),
      globalMax: container.concurrency.globalMax,
      providerMax: container.concurrency.providerMax,
    },
    clock: {
      virtualMs: container.clock.now(),
      speed: container.pacedDriver.speed,
      running: container.pacedDriver.running,
      pendingTimers: container.clock.pendingCount,
    },
    agents: container.metrics.agentMetrics(),
    campaigns: container.campaignService.list().length,
    activeCalls: container.repositories.calls.activeCount(),
    sseSubscribers: ctx.sse.subscriberCount,
    // What this process reclaimed from a previous one at startup. Surfaced because a crash
    // that silently tidies up after itself is a crash nobody notices.
    recovery: container.recoveryReport,
    // Surfaced so the dashboard can display the safety posture prominently rather than
    // making an operator infer it (CONSTRAINTS.md §1).
    safety: {
      simulationMode: container.config.simulationMode,
      providerDriver: container.config.providerDriver,
      configWarnings: container.config.warnings,
    },
  }));

  /**
   * The emergency stop. This genuinely prevents new calls — it is the first rule the safety
   * engine evaluates, so every dial path is blocked by it.
   */
  app.post('/api/system/emergency-stop', async (request) => {
    const input = parse(emergencyStopSchema, request.body ?? {}, 'emergency stop');
    return { system: container.system.engage(input.reason ?? 'Manual emergency stop') };
  });

  app.post('/api/system/emergency-resume', async () => {
    // Releasing also restarts campaigns that stood down while stopped — otherwise the
    // control would be one-way in practice, leaving RUNNING campaigns that never dial again.
    const status = container.system.release();
    container.engine.resumeStalled();
    return { system: status };
  });

  app.get('/api/system/invariants', async () => {
    const violations = container.invariants.check();
    return { passed: violations.length === 0, violations };
  });

  app.get('/api/system/safety-rules', async () => ({
    rules: container.safety.describeRules(),
  }));

  /** Simulation speed for the live clock: 1x to 100x. */
  app.post('/api/system/speed', async (request) => {
    const input = parse(speedSchema, request.body, 'speed');
    container.pacedDriver.setSpeed(input.speed);
    return { speed: container.pacedDriver.speed };
  });
}
