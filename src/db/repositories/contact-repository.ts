import type { Contact, ContactDraft, ContactStatus } from '../../domain/contact.ts';
import {
  fromJson,
  optionalNumber,
  requireNumber,
  requireString,
  toJson,
  type Database,
  type SqlRow,
} from '../database.ts';

const COLUMNS = `
  id, campaign_id, name, phone_number, status, attempt_count, last_attempt_at,
  next_attempt_at, timezone, metadata, created_at, updated_at
`;

function mapRow(row: SqlRow): Contact {
  return {
    id: requireString(row, 'id'),
    campaignId: requireString(row, 'campaign_id'),
    name: requireString(row, 'name'),
    phoneNumber: requireString(row, 'phone_number'),
    status: requireString(row, 'status') as ContactStatus,
    attemptCount: requireNumber(row, 'attempt_count'),
    lastAttemptAt: optionalNumber(row, 'last_attempt_at'),
    nextAttemptAt: optionalNumber(row, 'next_attempt_at'),
    timezone: requireString(row, 'timezone'),
    metadata: fromJson<Record<string, unknown>>(row['metadata'] ?? null, {}),
    createdAt: requireNumber(row, 'created_at'),
    updatedAt: requireNumber(row, 'updated_at'),
  };
}

export interface ContactCounts {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export class ContactRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(id: string, draft: ContactDraft, now: number): Contact {
    this.#db.run(
      `INSERT INTO contacts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      draft.campaignId,
      draft.name,
      draft.phoneNumber,
      draft.status ?? 'READY',
      draft.attemptCount ?? 0,
      draft.lastAttemptAt ?? null,
      draft.nextAttemptAt ?? null,
      draft.timezone ?? 'UTC',
      toJson(draft.metadata ?? {}),
      now,
      now,
    );
    return this.findById(id) as Contact;
  }

  findById(id: string): Contact | null {
    const row = this.#db.get(`SELECT ${COLUMNS} FROM contacts WHERE id = ?`, id);
    return row === undefined ? null : mapRow(row);
  }

  /**
   * Atomically claim the next dialable contact for a campaign.
   *
   * This is the most important query in the system, and its correctness rests on one thing:
   * the `AND status = 'READY'` clause on the UPDATE. Two workers may well select the same
   * candidate id — but only one UPDATE can find the row still READY, so exactly one gets
   * `changes === 1` and the loser gets `0` and moves on. The preceding SELECT is only a
   * candidate hint; it is not where correctness comes from.
   *
   * Because `node:sqlite` is synchronous and Node is single-threaded, there is no `await`
   * anywhere in this method — nothing can interleave between the select and the update
   * within a process, and the conditional update covers the cross-process case anyway
   * (DECISIONS.md D-002, D-007).
   *
   * `excludeIds` lets one dialer tick claim several contacts without re-selecting a row it
   * has already taken in the same pass.
   */
  reserveNext(campaignId: string, now: number, excludeIds: readonly string[] = []): Contact | null {
    const placeholders = excludeIds.map(() => '?').join(', ');
    const exclusion = excludeIds.length > 0 ? `AND id NOT IN (${placeholders})` : '';

    const candidate = this.#db.get<{ id: string }>(
      `SELECT id FROM contacts
       WHERE campaign_id = ?
         AND status = 'READY'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ${exclusion}
       -- NULLs first is what we want (never-attempted contacts before those waiting out a
       -- backoff), and SQLite already sorts NULL below every value in ASC. An explicit
       -- CASE expression here achieved the same ordering but defeated the index: the query
       -- plan degraded to USE TEMP B-TREE FOR ORDER BY, sorting every dialable contact in
       -- the campaign on every single dial attempt. That was the system's scaling
       -- bottleneck — 712us per reservation at 1500 agents (BUG.md B-016, SCALE.md).
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT 1`,
      campaignId,
      now,
      ...excludeIds,
    );
    if (candidate === undefined) return null;

    const claimed = this.#db.run(
      `UPDATE contacts SET status = 'RESERVED', updated_at = ?
       WHERE id = ? AND status = 'READY'`,
      now,
      candidate.id,
    );
    if (claimed.changes !== 1) return null;

    return this.findById(candidate.id);
  }

  /**
   * Give a reservation back. Every failure path between claiming a contact and handing it
   * to the provider must call this, or contacts leak out of the dialable pool one bug at a
   * time and the campaign quietly stalls with work remaining.
   */
  releaseReservation(id: string, now: number): boolean {
    return (
      this.#db.run(
        `UPDATE contacts SET status = 'READY', updated_at = ?
         WHERE id = ? AND status = 'RESERVED'`,
        now,
        id,
      ).changes === 1
    );
  }

  /** Compare-and-set status transition; returns false if the contact moved underneath us. */
  updateStatus(id: string, from: ContactStatus, to: ContactStatus, now: number): boolean {
    return (
      this.#db.run(
        'UPDATE contacts SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
        to,
        now,
        id,
        from,
      ).changes === 1
    );
  }

  setStatus(id: string, to: ContactStatus, now: number): void {
    this.#db.run('UPDATE contacts SET status = ?, updated_at = ? WHERE id = ?', to, now, id);
  }

  recordAttempt(id: string, now: number): void {
    this.#db.run(
      `UPDATE contacts
       SET attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      now,
      now,
      id,
    );
  }

  scheduleRetry(id: string, nextAttemptAt: number, now: number): void {
    this.#db.run(
      `UPDATE contacts SET status = 'RETRY_PENDING', next_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      nextAttemptAt,
      now,
      id,
    );
  }

  /**
   * Promote contacts whose backoff has elapsed back into the dialable pool.
   *
   * Kept as an explicit step rather than folding `RETRY_PENDING` into the reservation
   * query. The two conditions — "is eligible" and "has waited long enough" — are different
   * ideas, and merging them is how a backoff quietly stops being honoured after someone
   * edits the WHERE clause.
   */
  promoteDueRetries(campaignId: string, now: number): number {
    return this.#db.run(
      `UPDATE contacts SET status = 'READY', updated_at = ?
       WHERE campaign_id = ? AND status = 'RETRY_PENDING' AND next_attempt_at <= ?`,
      now,
      campaignId,
      now,
    ).changes;
  }

  listByCampaign(campaignId: string, limit = 500, offset = 0): Contact[] {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM contacts WHERE campaign_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`,
        campaignId,
        limit,
        offset,
      )
      .map(mapRow);
  }

  search(filter: {
    campaignId?: string;
    status?: ContactStatus;
    query?: string;
    limit?: number;
    offset?: number;
  }): Contact[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.campaignId !== undefined) {
      clauses.push('campaign_id = ?');
      params.push(filter.campaignId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.query !== undefined && filter.query !== '') {
      // Parameterised LIKE — the value never reaches the SQL string itself.
      clauses.push('(name LIKE ? OR phone_number LIKE ?)');
      params.push(`%${filter.query}%`, `%${filter.query}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 100, filter.offset ?? 0);

    return this.#db
      .all(`SELECT ${COLUMNS} FROM contacts ${where} ORDER BY id ASC LIMIT ? OFFSET ?`, ...params)
      .map(mapRow);
  }

  counts(campaignId: string): ContactCounts {
    const rows = this.#db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM contacts WHERE campaign_id = ? GROUP BY status',
      campaignId,
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.n);
      byStatus[String(row.status)] = count;
      total += count;
    }
    return { total, byStatus };
  }

  /**
   * Contacts dialable right now. One indexed count, for the dialer's per-tick snapshot —
   * the grouped `counts()` is too expensive on that path (BUG.md B-002).
   */
  readyCount(campaignId: string): number {
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contacts WHERE campaign_id = ? AND status = 'READY'`,
      campaignId,
    );
    return Number(row?.n ?? 0);
  }

  /** Contacts that could still be dialled at some point — drives campaign completion. */
  remainingCount(campaignId: string): number {
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contacts
       WHERE campaign_id = ?
         AND status NOT IN ('COMPLETED', 'EXHAUSTED', 'DO_NOT_CALL')`,
      campaignId,
    );
    return Number(row?.n ?? 0);
  }

  /** Contacts with work in flight right now. Used to decide a campaign has truly finished. */
  inFlightCount(campaignId: string): number {
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contacts
       WHERE campaign_id = ? AND status IN ('RESERVED', 'DIALING', 'RINGING', 'CONNECTED')`,
      campaignId,
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Return a campaign's finished contacts to the dialable pool.
   *
   * The one thing this must never touch is `DO_NOT_CALL`. That state is a one-way door
   * everywhere else in the system, and a reset that quietly reopened it would be the single
   * most damaging bug this codebase could have — the whole DNC guarantee would hold right up
   * until someone pressed a button labelled "run it again".
   *
   * `COMPLETED` is also preserved: someone already reached that person, and a demo reset is
   * not a reason to call them a second time. Only unsuccessful outcomes become dialable
   * again, with their attempt counters cleared.
   */
  resetForReplay(campaignId: string, now: number): number {
    return this.#db.run(
      `UPDATE contacts
       SET status = 'READY', attempt_count = 0, next_attempt_at = NULL,
           last_attempt_at = NULL, updated_at = ?
       WHERE campaign_id = ?
         AND status IN ('EXHAUSTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'RETRY_PENDING',
                        'RESERVED', 'DIALING', 'RINGING', 'CONNECTED')`,
      now,
      campaignId,
    ).changes;
  }

  /**
   * Contacts held mid-flight with no call row to explain it.
   *
   * These are the ones a crash between reserving a contact and creating its call leaves
   * behind — a narrow window, and precisely the one the assignment's worker-crash case
   * describes. Without this sweep they are unreachable forever: not READY, so never
   * selected, and with no call whose completion would release them.
   */
  listStranded(limit = 500): Contact[] {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM contacts c
         WHERE c.status IN ('RESERVED', 'DIALING', 'RINGING', 'CONNECTED')
           AND NOT EXISTS (
             SELECT 1 FROM calls WHERE calls.contact_id = c.id
               AND calls.status NOT IN ('ENDED','NO_ANSWER','BUSY','FAILED','CANCELLED','TIMEOUT')
           )
         ORDER BY id ASC LIMIT ?`,
        limit,
      )
      .map(mapRow);
  }

  markDoNotCall(id: string, now: number): void {
    this.#db.run(
      `UPDATE contacts SET status = 'DO_NOT_CALL', updated_at = ? WHERE id = ?`,
      now,
      id,
    );
  }
}
