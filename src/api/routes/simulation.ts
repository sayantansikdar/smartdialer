import type { FastifyInstance } from 'fastify';
import { parse, type ApiContext } from '../server.ts';
import { simulationSchema } from '../schemas.ts';
import { SCENARIOS, findScenario } from '../../sim/scenarios.ts';

export function registerSimulationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { container, simulations } = ctx;

  app.get('/api/simulation/scenarios', async () => ({
    scenarios: SCENARIOS.map((scenario) => ({
      name: scenario.name,
      demonstrates: scenario.demonstrates,
      config: scenario.config,
    })),
  }));

  app.get('/api/simulation/runs', async () => ({
    runs: container.repositories.simulations.list(),
  }));

  app.get('/api/simulation/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { run: container.repositories.simulations.findById(id) };
  });

  /**
   * Run a simulation to completion and return its report.
   *
   * Each run builds its own isolated container — its own in-memory database, clock, RNG and
   * provider — so it cannot disturb the live campaigns the dashboard is showing. That
   * isolation is what makes it safe to run a chaos scenario from a UI button.
   */
  app.post('/api/simulation/start', async (request) => {
    const input = parse(simulationSchema, request.body ?? {}, 'simulation configuration');
    const report = await simulations.runToCompletion(input);
    return { report };
  });

  /** Run one of the predefined scenarios, and report whether it demonstrated its claim. */
  app.post('/api/simulation/scenario/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const scenario = findScenario(name);
    if (scenario === undefined) {
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Unknown scenario "${name}"`,
          metadata: { known: SCENARIOS.map((s) => s.name) },
        },
      });
    }

    const report = await simulations.runToCompletion(scenario.config);
    const problems = scenario.expect(report);
    return {
      scenario: scenario.name,
      demonstrates: scenario.demonstrates,
      report,
      expectationsMet: problems.length === 0,
      problems,
    };
  });

  app.post('/api/simulation/stop', async (request) => {
    const { id } = (request.body ?? {}) as { id?: string };
    if (id !== undefined) return { stopped: simulations.stop(id) ? 1 : 0 };

    // No id: stop every run still marked RUNNING. Reads the durable record rather than
    // in-memory state so a run left behind by an earlier process is also cleared.
    let stopped = 0;
    for (const run of container.repositories.simulations.listRunning()) {
      if (simulations.stop(run.id)) stopped += 1;
    }
    return { stopped };
  });
}
