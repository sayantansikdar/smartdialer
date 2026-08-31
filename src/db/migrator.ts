/**
 * Forward-only numbered migrations.
 *
 * There are deliberately no down-migrations (ROLLBACK.md explains why): for a prototype
 * whose database is disposable, a down-migration is code that is written, never exercised,
 * and wrong the one time it is finally needed. Undoing a schema change here means
 * `npm run db:reset`.
 *
 * Migration files are plain `.sql` read from disk rather than embedded strings, so the
 * schema is readable and diffable on its own terms.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILENAME_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
}

export interface MigrationResult {
  readonly applied: readonly MigrationFile[];
  readonly alreadyApplied: number;
}

export function discoverMigrations(directory: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(directory)
    .map((filename) => {
      const match = FILENAME_PATTERN.exec(filename);
      if (match === null) return null;
      return {
        version: Number(match[1]),
        name: match[2] as string,
        filename,
      } satisfies MigrationFile;
    })
    .filter((entry): entry is MigrationFile => entry !== null)
    .sort((a, b) => a.version - b.version);
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

export function appliedVersions(db: Database): Set<number> {
  ensureMigrationsTable(db);
  const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => Number(row.version)));
}

/**
 * Apply every migration not yet recorded.
 *
 * @param appliedAt Timestamp recorded against each migration. Callers pass virtual time
 *   where one exists; the CLI passes 0, since a migration's wall-clock time is not
 *   something anything in this system reasons about.
 */
export function migrate(
  db: Database,
  options: { directory?: string; appliedAt?: number } = {},
): MigrationResult {
  const directory = options.directory ?? MIGRATIONS_DIR;
  const appliedAt = options.appliedAt ?? 0;

  ensureMigrationsTable(db);
  const already = appliedVersions(db);
  const pending = discoverMigrations(directory).filter((m) => !already.has(m.version));

  const applied: MigrationFile[] = [];
  for (const migration of pending) {
    const sql = readFileSync(join(directory, migration.filename), 'utf8');
    // Each migration is its own transaction: a failure leaves the database at the last
    // complete version rather than half-migrated.
    db.transaction(() => {
      db.exec(sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        appliedAt,
      );
    });
    applied.push(migration);
  }

  return { applied, alreadyApplied: already.size };
}
