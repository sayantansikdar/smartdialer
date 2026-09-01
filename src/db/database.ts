/**
 * Thin wrapper over `node:sqlite`.
 *
 * Two things this buys us beyond convenience:
 *
 * 1. **Statement caching.** A predictive campaign runs the same handful of statements
 *    thousands of times per simulated minute; re-preparing them each time is pure waste.
 *
 * 2. **Nested transactions via savepoints.** Repositories compose — writing a call also
 *    writes an attempt and an event — and a naive BEGIN/COMMIT wrapper would either fail or,
 *    worse, silently commit an inner unit of work when an outer one later rolled back.
 *
 * SQL lives here and in the repositories, nowhere else (CONSTRAINTS.md §3).
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;
  #closed = false;

  constructor(path: string) {
    // SQLite will not create a missing parent directory, and its failure message —
    // "unable to open database file" — says nothing about which file or why. On a fresh
    // clone `data/` does not exist yet, so without this the very first `npm run dev` fails
    // with an error that reads like corruption rather than a missing folder (BUG.md B-008).
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.#db = new DatabaseSync(path);

    // WAL lets the event writer and the API's readers proceed without blocking each other.
    // It is a no-op for `:memory:`, which tests use.
    if (path !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL');
    }
    this.#db.exec('PRAGMA foreign_keys = ON');
    // NORMAL trades an fsync per commit for one per checkpoint. At 100x simulation speed
    // the event log commits constantly, and FULL would make disk latency the thing being
    // measured rather than the dialer.
    this.#db.exec('PRAGMA synchronous = NORMAL');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    const result = this.#prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  /**
   * Run `fn` inside a transaction, using a savepoint when already inside one.
   *
   * Note this is synchronous by design — `fn` must not be async. An `await` inside a
   * transaction would let unrelated work interleave between BEGIN and COMMIT, which is
   * precisely the interleaving the atomic contact reservation depends on not happening
   * (DECISIONS.md D-002).
   */
  transaction<T>(fn: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = `sp_${depth}`;

    if (depth === 0) this.#db.exec('BEGIN');
    else this.#db.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth = depth + 1;

    try {
      const result = fn();
      if (depth === 0) this.#db.exec('COMMIT');
      else this.#db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      // Roll back and rethrow. Never swallow: a failed transaction that looks successful is
      // how a database quietly diverges from what the application believes (CONSTRAINTS §3).
      if (depth === 0) this.#db.exec('ROLLBACK');
      else this.#db.exec(`ROLLBACK TO ${savepoint}`);
      throw error;
    } finally {
      this.#transactionDepth = depth;
    }
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#statements.clear();
    this.#db.close();
    this.#closed = true;
  }
}

/** JSON helpers — several columns store structured data as TEXT. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: SqlValue, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as T | null;
    return parsed ?? fallback;
  } catch {
    // A malformed JSON column means a bad write happened earlier. Returning the fallback
    // keeps the read path alive; the write path is where this should have been caught.
    return fallback;
  }
}

/** SQLite has no boolean type; these keep the intent readable at call sites. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqlBool(value: SqlValue): boolean {
  return value === 1 || value === 1n || value === '1';
}

export function toNullableNumber(value: SqlValue): number | null {
  return typeof value === 'number' ? value : value === null ? null : Number(value);
}

export function requireString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Expected column "${column}" to be TEXT, got ${typeof value}`);
  }
  return value;
}

export function requireNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`Expected column "${column}" to be numeric, got ${typeof value}`);
}

export function optionalString(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

export function optionalNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}
