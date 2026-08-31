/**
 * `npm run db:migrate` — apply pending migrations.
 *
 * Deliberately a plain `.mjs` script rather than TypeScript: it must be able to run before
 * anything else in the project is known to work, including the typechecker.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { Database } = await import('../src/db/database.ts');
const { migrate, discoverMigrations } = await import('../src/db/migrator.ts');
const { loadConfig } = await import('../src/config/index.ts');

const config = loadConfig();
if (config.databasePath !== ':memory:') {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

const db = new Database(config.databasePath);
const result = migrate(db);
db.close();

const total = discoverMigrations().length;
if (result.applied.length === 0) {
  console.log(`Database is up to date (${total} migration(s) already applied).`);
} else {
  for (const m of result.applied) console.log(`Applied ${m.version} ${m.name}`);
  console.log(`Applied ${result.applied.length} of ${total} migration(s) → ${config.databasePath}`);
}
