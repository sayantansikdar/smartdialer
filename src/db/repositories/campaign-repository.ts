import type { Campaign, CampaignDraft, CampaignSafetyConfig, CampaignStatus, RetryPolicy } from '../../domain/campaign.ts';
import {
  fromJson,
  optionalString,
  requireNumber,
  requireString,
  toJson,
  type Database,
  type SqlRow,
} from '../database.ts';

const COLUMNS = `
  id, name, status, dialing_mode, max_concurrent_calls, max_calls_per_second,
  max_abandon_rate, max_attempts_per_contact, retry_policy, safety, provider_id,
  predictive_paused_reason, created_at, updated_at
`;

function mapRow(row: SqlRow): Campaign {
  return {
    id: requireString(row, 'id'),
    name: requireString(row, 'name'),
    status: requireString(row, 'status') as CampaignStatus,
    dialingMode: requireString(row, 'dialing_mode') as Campaign['dialingMode'],
    maxConcurrentCalls: requireNumber(row, 'max_concurrent_calls'),
    maxCallsPerSecond: requireNumber(row, 'max_calls_per_second'),
    maxAbandonRate: requireNumber(row, 'max_abandon_rate'),
    maxAttemptsPerContact: requireNumber(row, 'max_attempts_per_contact'),
    retryPolicy: fromJson<RetryPolicy>(row['retry_policy'] ?? null, {
      maxAttempts: 1,
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitterRatio: 0.2,
    }),
    safety: fromJson<CampaignSafetyConfig>(row['safety'] ?? null, {
      pacingMultiplier: 1,
      targetOccupancy: 0.85,
      lineRatio: 1,
      maxLinesPerAgent: 3,
      abandonTimeoutMs: 2000,
      abandonMinSample: 20,
    }),
    providerId: requireString(row, 'provider_id'),
    predictivePausedReason: optionalString(row, 'predictive_paused_reason'),
    createdAt: requireNumber(row, 'created_at'),
    updatedAt: requireNumber(row, 'updated_at'),
  };
}

export class CampaignRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(id: string, draft: CampaignDraft, now: number): Campaign {
    this.#db.run(
      `INSERT INTO campaigns (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      draft.name,
      'DRAFT',
      draft.dialingMode,
      draft.maxConcurrentCalls,
      draft.maxCallsPerSecond,
      draft.maxAbandonRate,
      draft.maxAttemptsPerContact,
      toJson(draft.retryPolicy),
      toJson(draft.safety),
      draft.providerId,
      null,
      now,
      now,
    );
    return this.findById(id) as Campaign;
  }

  findById(id: string): Campaign | null {
    const row = this.#db.get(`SELECT ${COLUMNS} FROM campaigns WHERE id = ?`, id);
    return row === undefined ? null : mapRow(row);
  }

  list(): Campaign[] {
    return this.#db
      .all(`SELECT ${COLUMNS} FROM campaigns ORDER BY created_at ASC, id ASC`)
      .map(mapRow);
  }

  listByStatus(status: CampaignStatus): Campaign[] {
    return this.#db
      .all(`SELECT ${COLUMNS} FROM campaigns WHERE status = ? ORDER BY id ASC`, status)
      .map(mapRow);
  }

  /**
   * Move a campaign to a new status, but only if it is still in the status the caller
   * observed. The `AND status = ?` clause makes this a compare-and-set: if something else
   * changed the campaign in between (an operator pausing while a tick was mid-flight, say),
   * this reports 0 changes and the caller re-reads rather than clobbering the newer state.
   */
  updateStatus(id: string, from: CampaignStatus, to: CampaignStatus, now: number): boolean {
    const result = this.#db.run(
      'UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
      to,
      now,
      id,
      from,
    );
    return result.changes === 1;
  }

  setPredictivePausedReason(id: string, reason: string | null, now: number): void {
    this.#db.run(
      'UPDATE campaigns SET predictive_paused_reason = ?, updated_at = ? WHERE id = ?',
      reason,
      now,
      id,
    );
  }

  updateSettings(
    id: string,
    patch: Partial<Omit<CampaignDraft, 'providerId'>>,
    now: number,
  ): Campaign | null {
    const current = this.findById(id);
    if (current === null) return null;

    this.#db.run(
      `UPDATE campaigns SET
         name = ?, dialing_mode = ?, max_concurrent_calls = ?, max_calls_per_second = ?,
         max_abandon_rate = ?, max_attempts_per_contact = ?, retry_policy = ?, safety = ?,
         updated_at = ?
       WHERE id = ?`,
      patch.name ?? current.name,
      patch.dialingMode ?? current.dialingMode,
      patch.maxConcurrentCalls ?? current.maxConcurrentCalls,
      patch.maxCallsPerSecond ?? current.maxCallsPerSecond,
      patch.maxAbandonRate ?? current.maxAbandonRate,
      patch.maxAttemptsPerContact ?? current.maxAttemptsPerContact,
      toJson(patch.retryPolicy ?? current.retryPolicy),
      toJson(patch.safety ?? current.safety),
      now,
      id,
    );
    return this.findById(id);
  }

  deleteById(id: string): boolean {
    return this.#db.run('DELETE FROM campaigns WHERE id = ?', id).changes === 1;
  }
}
