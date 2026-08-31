import type { Agent, AgentDraft, AgentStatus } from '../../domain/agent.ts';
import {
  optionalString,
  requireNumber,
  requireString,
  type Database,
  type SqlRow,
} from '../database.ts';

const COLUMNS = `
  id, campaign_id, name, status, current_call_id, calls_handled, total_handle_time_ms,
  last_state_change, created_at, updated_at
`;

function mapRow(row: SqlRow): Agent {
  return {
    id: requireString(row, 'id'),
    campaignId: optionalString(row, 'campaign_id'),
    name: requireString(row, 'name'),
    status: requireString(row, 'status') as AgentStatus,
    currentCallId: optionalString(row, 'current_call_id'),
    callsHandled: requireNumber(row, 'calls_handled'),
    totalHandleTimeMs: requireNumber(row, 'total_handle_time_ms'),
    lastStateChange: requireNumber(row, 'last_state_change'),
    createdAt: requireNumber(row, 'created_at'),
    updatedAt: requireNumber(row, 'updated_at'),
  };
}

export class AgentRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(id: string, draft: AgentDraft, now: number): Agent {
    this.#db.run(
      `INSERT INTO agents (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      draft.campaignId,
      draft.name,
      draft.status ?? 'OFFLINE',
      null,
      0,
      0,
      now,
      now,
      now,
    );
    return this.findById(id) as Agent;
  }

  findById(id: string): Agent | null {
    const row = this.#db.get(`SELECT ${COLUMNS} FROM agents WHERE id = ?`, id);
    return row === undefined ? null : mapRow(row);
  }

  list(): Agent[] {
    return this.#db.all(`SELECT ${COLUMNS} FROM agents ORDER BY id ASC`).map(mapRow);
  }

  listByCampaign(campaignId: string): Agent[] {
    return this.#db
      .all(`SELECT ${COLUMNS} FROM agents WHERE campaign_id = ? ORDER BY id ASC`, campaignId)
      .map(mapRow);
  }

  /**
   * Claim one available agent for a campaign, atomically.
   *
   * Same compare-and-set shape as contact reservation, and for the same reason: the
   * `AND status = 'AVAILABLE'` clause is what makes it impossible for two answered calls to
   * be routed to the same seat. `ORDER BY last_state_change` distributes work to whoever has
   * been idle longest, which is both fairer and deterministic (ties broken by id).
   */
  reserveAvailable(campaignId: string, callId: string, now: number): Agent | null {
    const candidate = this.#db.get<{ id: string }>(
      `SELECT id FROM agents
       WHERE campaign_id = ? AND status = 'AVAILABLE'
       ORDER BY last_state_change ASC, id ASC
       LIMIT 1`,
      campaignId,
    );
    if (candidate === undefined) return null;

    const claimed = this.#db.run(
      `UPDATE agents
       SET status = 'RESERVED', current_call_id = ?, last_state_change = ?, updated_at = ?
       WHERE id = ? AND status = 'AVAILABLE'`,
      callId,
      now,
      now,
      candidate.id,
    );
    if (claimed.changes !== 1) return null;

    return this.findById(candidate.id);
  }

  /** Compare-and-set status transition; false if the agent moved underneath us. */
  updateStatus(id: string, from: AgentStatus, to: AgentStatus, now: number): boolean {
    return (
      this.#db.run(
        `UPDATE agents SET status = ?, last_state_change = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
        to,
        now,
        now,
        id,
        from,
      ).changes === 1
    );
  }

  setStatus(id: string, to: AgentStatus, now: number): void {
    this.#db.run(
      `UPDATE agents SET status = ?, last_state_change = ?, updated_at = ? WHERE id = ?`,
      to,
      now,
      now,
      id,
    );
  }

  attachCall(id: string, callId: string | null, now: number): void {
    this.#db.run(
      'UPDATE agents SET current_call_id = ?, updated_at = ? WHERE id = ?',
      callId,
      now,
      id,
    );
  }

  /** Release an agent back to AVAILABLE and, if the call was handled, record the time. */
  release(id: string, now: number, handleTimeMs: number | null): void {
    if (handleTimeMs === null) {
      this.#db.run(
        `UPDATE agents
         SET status = 'AVAILABLE', current_call_id = NULL, last_state_change = ?, updated_at = ?
         WHERE id = ?`,
        now,
        now,
        id,
      );
      return;
    }
    this.#db.run(
      `UPDATE agents
       SET status = 'AVAILABLE', current_call_id = NULL, calls_handled = calls_handled + 1,
           total_handle_time_ms = total_handle_time_ms + ?, last_state_change = ?, updated_at = ?
       WHERE id = ?`,
      handleTimeMs,
      now,
      now,
      id,
    );
  }

  countByStatus(campaignId?: string): Record<AgentStatus, number> {
    const rows =
      campaignId === undefined
        ? this.#db.all<{ status: string; n: number }>(
            'SELECT status, COUNT(*) AS n FROM agents GROUP BY status',
          )
        : this.#db.all<{ status: string; n: number }>(
            'SELECT status, COUNT(*) AS n FROM agents WHERE campaign_id = ? GROUP BY status',
            campaignId,
          );

    const counts = {
      OFFLINE: 0,
      AVAILABLE: 0,
      RESERVED: 0,
      RINGING: 0,
      ON_CALL: 0,
      WRAP_UP: 0,
      PAUSED: 0,
    } satisfies Record<AgentStatus, number>;

    for (const row of rows) {
      const status = String(row.status) as AgentStatus;
      if (status in counts) counts[status] = Number(row.n);
    }
    return counts;
  }

  availableCount(campaignId: string): number {
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents WHERE campaign_id = ? AND status = 'AVAILABLE'`,
      campaignId,
    );
    return Number(row?.n ?? 0);
  }

  deleteById(id: string): boolean {
    return this.#db.run('DELETE FROM agents WHERE id = ?', id).changes === 1;
  }
}
