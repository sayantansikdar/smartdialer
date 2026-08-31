/**
 * Restore id counters from the database on startup.
 *
 * Sequential ids (DECISIONS.md D-004) are readable and make simulation runs comparable, but
 * they are only unique within a process unless the generator is told what already exists.
 * Without this, a server restarted against a persistent database reopens every counter at 1
 * and the first insert fails on a UNIQUE constraint — taking the dialer tick down with it,
 * because events are written on every state transition (BUG.md B-005).
 *
 * A fresh in-memory database yields no rows and every counter starts at 1, so tests and
 * simulations remain exactly as deterministic as before.
 */

import { ID_PREFIX, type IdGenerator } from '../core/ids.ts';
import type { Database } from './database.ts';

/** Table and prefix pairs for every id this system generates. */
const SOURCES: ReadonlyArray<{ table: string; prefix: string }> = [
  { table: 'campaigns', prefix: ID_PREFIX.campaign },
  { table: 'contacts', prefix: ID_PREFIX.contact },
  { table: 'agents', prefix: ID_PREFIX.agent },
  { table: 'calls', prefix: ID_PREFIX.call },
  { table: 'call_attempts', prefix: ID_PREFIX.attempt },
  { table: 'events', prefix: ID_PREFIX.event },
  { table: 'simulation_runs', prefix: ID_PREFIX.simulation },
];

export function restoreIdCounters(db: Database, ids: IdGenerator): Record<string, number> {
  const restored: Record<string, number> = {};

  for (const { table, prefix } of SOURCES) {
    // Only rows whose id is exactly `<prefix>_<digits>` are considered. Seed data and
    // fixtures may use readable custom ids such as `agent_prog_01`; those are not part of
    // the generated sequence and must not be allowed to skew the counter.
    const row = db.get<{ highest: number | null }>(
      `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS highest
       FROM ${table}
       WHERE id GLOB ?`,
      prefix.length + 2,
      `${prefix}_[0-9]*`,
    );
    const highest = Number(row?.highest ?? 0);
    if (highest > 0) {
      ids.restore(prefix, highest);
      restored[prefix] = highest;
    }
  }

  return restored;
}
