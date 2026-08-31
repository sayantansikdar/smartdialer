/**
 * `npm run db:reset` — delete the database and rebuild it from migrations.
 *
 * This is the documented recovery for any schema or data problem (ROLLBACK.md): the database
 * is a disposable local artifact, never a source of truth.
 */
import { rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { Database } = await import('../src/db/database.ts');
const { migrate } = await import('../src/db/migrator.ts');
const { loadConfig } = await import('../src/config/index.ts');

const config = loadConfig();
if (config.databasePath === ':memory:') {
  console.log('DATABASE_PATH is :memory: — nothing to reset.');
  process.exit(0);
}

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${config.databasePath}${suffix}`, { force: true });
}
mkdirSync(dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
const result = migrate(db);
db.close();
console.log(`Reset ${config.databasePath} and applied ${result.applied.length} migration(s).`);
