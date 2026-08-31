import {
  fromJson,
  requireNumber,
  requireString,
  toJson,
  type Database,
  type SqlRow,
} from '../database.ts';

/**
 * Persisted mock-provider behaviour.
 *
 * This is what makes the dashboard's failure-injection panel real rather than cosmetic: the
 * UI writes here, the provider reads from here, and the change takes effect on the next
 * call the engine places (CONSTRAINTS.md §5 — no faked controls).
 */
export interface ProviderConfigRecord {
  readonly id: string;
  readonly driver: string;
  readonly config: Record<string, unknown>;
  readonly updatedAt: number;
}

const COLUMNS = 'id, driver, config, updated_at';

function mapRow(row: SqlRow): ProviderConfigRecord {
  return {
    id: requireString(row, 'id'),
    driver: requireString(row, 'driver'),
    config: fromJson<Record<string, unknown>>(row['config'] ?? null, {}),
    updatedAt: requireNumber(row, 'updated_at'),
  };
}

export class ProviderConfigRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  upsert(
    id: string,
    driver: string,
    config: Record<string, unknown>,
    now: number,
  ): ProviderConfigRecord {
    this.#db.run(
      `INSERT INTO provider_configs (${COLUMNS}) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET driver = excluded.driver, config = excluded.config,
                                     updated_at = excluded.updated_at`,
      id,
      driver,
      toJson(config),
      now,
    );
    return this.findById(id) as ProviderConfigRecord;
  }

  findById(id: string): ProviderConfigRecord | null {
    const row = this.#db.get(`SELECT ${COLUMNS} FROM provider_configs WHERE id = ?`, id);
    return row === undefined ? null : mapRow(row);
  }

  list(): ProviderConfigRecord[] {
    return this.#db.all(`SELECT ${COLUMNS} FROM provider_configs ORDER BY id ASC`).map(mapRow);
  }
}
