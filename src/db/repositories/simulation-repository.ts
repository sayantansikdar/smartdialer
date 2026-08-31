import {
  fromJson,
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  toJson,
  type Database,
  type SqlRow,
} from '../database.ts';

export const SIMULATION_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'STOPPED'] as const;
export type SimulationStatus = (typeof SIMULATION_STATUSES)[number];

export interface SimulationRun {
  readonly id: string;
  readonly scenario: string;
  readonly seed: number;
  readonly config: Record<string, unknown>;
  readonly status: SimulationStatus;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly report: Record<string, unknown> | null;
}

const COLUMNS = 'id, scenario, seed, config, status, started_at, finished_at, report';

function mapRow(row: SqlRow): SimulationRun {
  const reportRaw = optionalString(row, 'report');
  return {
    id: requireString(row, 'id'),
    scenario: requireString(row, 'scenario'),
    seed: requireNumber(row, 'seed'),
    config: fromJson<Record<string, unknown>>(row['config'] ?? null, {}),
    status: requireString(row, 'status') as SimulationStatus,
    startedAt: requireNumber(row, 'started_at'),
    finishedAt: optionalNumber(row, 'finished_at'),
    report: reportRaw === null ? null : fromJson<Record<string, unknown>>(reportRaw, {}),
  };
}

export class SimulationRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  start(input: {
    id: string;
    scenario: string;
    seed: number;
    config: Record<string, unknown>;
    startedAt: number;
  }): SimulationRun {
    this.#db.run(
      `INSERT INTO simulation_runs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.scenario,
      input.seed,
      toJson(input.config),
      'RUNNING',
      input.startedAt,
      null,
      null,
    );
    return this.findById(input.id) as SimulationRun;
  }

  finish(
    id: string,
    status: SimulationStatus,
    finishedAt: number,
    report: Record<string, unknown>,
  ): void {
    this.#db.run(
      'UPDATE simulation_runs SET status = ?, finished_at = ?, report = ? WHERE id = ?',
      status,
      finishedAt,
      toJson(report),
      id,
    );
  }

  findById(id: string): SimulationRun | null {
    const row = this.#db.get(`SELECT ${COLUMNS} FROM simulation_runs WHERE id = ?`, id);
    return row === undefined ? null : mapRow(row);
  }

  list(limit = 50): SimulationRun[] {
    return this.#db
      .all(`SELECT ${COLUMNS} FROM simulation_runs ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
      .map(mapRow);
  }

  listRunning(): SimulationRun[] {
    return this.#db
      .all(`SELECT ${COLUMNS} FROM simulation_runs WHERE status = 'RUNNING' ORDER BY id ASC`)
      .map(mapRow);
  }
}
