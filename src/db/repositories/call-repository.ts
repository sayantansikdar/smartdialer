import type {
  Call,
  CallAttempt,
  CallOutcome,
  CallStatus,
  FailureClass,
} from '../../domain/call.ts';
import {
  fromSqlBool,
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  toSqlBool,
  type Database,
  type SqlRow,
} from '../database.ts';

const CALL_COLUMNS = `
  id, campaign_id, contact_id, attempt_id, agent_id, provider_id, provider_call_id, status,
  created_at, dialing_at, ringing_at, connected_at, ended_at, talk_duration_ms,
  outcome, failure_code, failure_class, abandoned
`;

const ATTEMPT_COLUMNS = `
  id, call_id, contact_id, campaign_id, attempt_number, started_at, ended_at,
  outcome, failure_code, failure_class, retry_scheduled_for
`;

function mapCall(row: SqlRow): Call {
  return {
    id: requireString(row, 'id'),
    campaignId: requireString(row, 'campaign_id'),
    contactId: requireString(row, 'contact_id'),
    attemptId: requireString(row, 'attempt_id'),
    agentId: optionalString(row, 'agent_id'),
    providerId: requireString(row, 'provider_id'),
    providerCallId: optionalString(row, 'provider_call_id'),
    status: requireString(row, 'status') as CallStatus,
    createdAt: requireNumber(row, 'created_at'),
    dialingAt: optionalNumber(row, 'dialing_at'),
    ringingAt: optionalNumber(row, 'ringing_at'),
    connectedAt: optionalNumber(row, 'connected_at'),
    endedAt: optionalNumber(row, 'ended_at'),
    talkDurationMs: optionalNumber(row, 'talk_duration_ms'),
    outcome: optionalString(row, 'outcome') as CallOutcome | null,
    failureCode: optionalString(row, 'failure_code'),
    failureClass: requireString(row, 'failure_class') as FailureClass,
    abandoned: fromSqlBool(row['abandoned'] ?? 0),
  };
}

function mapAttempt(row: SqlRow): CallAttempt {
  return {
    id: requireString(row, 'id'),
    callId: requireString(row, 'call_id'),
    contactId: requireString(row, 'contact_id'),
    campaignId: requireString(row, 'campaign_id'),
    attemptNumber: requireNumber(row, 'attempt_number'),
    startedAt: requireNumber(row, 'started_at'),
    endedAt: optionalNumber(row, 'ended_at'),
    outcome: optionalString(row, 'outcome') as CallOutcome | null,
    failureCode: optionalString(row, 'failure_code'),
    failureClass: requireString(row, 'failure_class') as FailureClass,
    retryScheduledFor: optionalNumber(row, 'retry_scheduled_for'),
  };
}

export interface CreateCallInput {
  readonly callId: string;
  readonly attemptId: string;
  readonly campaignId: string;
  readonly contactId: string;
  readonly providerId: string;
  readonly attemptNumber: number;
  readonly now: number;
}

export class CallRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Create a call and its attempt together.
   *
   * One transaction, because a call without its attempt row is a call whose history cannot
   * be reconstructed — and the attempt is what the retry policy counts. The call is inserted
   * first so the attempt's foreign key is satisfied; `calls.attempt_id` deliberately carries
   * no constraint to avoid a cycle between the two tables.
   */
  createCallWithAttempt(input: CreateCallInput): { call: Call; attempt: CallAttempt } {
    return this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO calls (${CALL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.callId,
        input.campaignId,
        input.contactId,
        input.attemptId,
        null,
        input.providerId,
        null,
        'CREATED',
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        'NONE',
        toSqlBool(false),
      );
      this.#db.run(
        `INSERT INTO call_attempts (${ATTEMPT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.attemptId,
        input.callId,
        input.contactId,
        input.campaignId,
        input.attemptNumber,
        input.now,
        null,
        null,
        null,
        'NONE',
        null,
      );
      return {
        call: this.findById(input.callId) as Call,
        attempt: this.findAttemptById(input.attemptId) as CallAttempt,
      };
    });
  }

  findById(id: string): Call | null {
    const row = this.#db.get(`SELECT ${CALL_COLUMNS} FROM calls WHERE id = ?`, id);
    return row === undefined ? null : mapCall(row);
  }

  findAttemptById(id: string): CallAttempt | null {
    const row = this.#db.get(`SELECT ${ATTEMPT_COLUMNS} FROM call_attempts WHERE id = ?`, id);
    return row === undefined ? null : mapAttempt(row);
  }

  /** Compare-and-set status transition; false if the call moved underneath us. */
  updateStatus(id: string, from: CallStatus, to: CallStatus, now: number): boolean {
    const timestampColumn = TIMESTAMP_COLUMN_FOR_STATUS[to];
    const sql =
      timestampColumn === undefined
        ? 'UPDATE calls SET status = ? WHERE id = ? AND status = ?'
        : `UPDATE calls SET status = ?, ${timestampColumn} = ? WHERE id = ? AND status = ?`;

    const result =
      timestampColumn === undefined
        ? this.#db.run(sql, to, id, from)
        : this.#db.run(sql, to, now, id, from);
    return result.changes === 1;
  }

  setProviderCallId(id: string, providerCallId: string): void {
    this.#db.run('UPDATE calls SET provider_call_id = ? WHERE id = ?', providerCallId, id);
  }

  assignAgent(id: string, agentId: string | null): void {
    this.#db.run('UPDATE calls SET agent_id = ? WHERE id = ?', agentId, id);
  }

  markAbandoned(id: string): void {
    this.#db.run('UPDATE calls SET abandoned = 1 WHERE id = ?', id);
  }

  /** Record the terminal outcome on both the call and its attempt, in one transaction. */
  finalize(input: {
    callId: string;
    attemptId: string;
    outcome: CallOutcome;
    failureCode: string | null;
    failureClass: FailureClass;
    endedAt: number;
    talkDurationMs: number | null;
  }): void {
    this.#db.transaction(() => {
      this.#db.run(
        `UPDATE calls
         SET outcome = ?, failure_code = ?, failure_class = ?, ended_at = ?, talk_duration_ms = ?
         WHERE id = ?`,
        input.outcome,
        input.failureCode,
        input.failureClass,
        input.endedAt,
        input.talkDurationMs,
        input.callId,
      );
      this.#db.run(
        `UPDATE call_attempts
         SET outcome = ?, failure_code = ?, failure_class = ?, ended_at = ?
         WHERE id = ?`,
        input.outcome,
        input.failureCode,
        input.failureClass,
        input.endedAt,
        input.attemptId,
      );
    });
  }

  setRetryScheduled(attemptId: string, retryAt: number | null): void {
    this.#db.run(
      'UPDATE call_attempts SET retry_scheduled_for = ? WHERE id = ?',
      retryAt,
      attemptId,
    );
  }

  listAttemptsForContact(contactId: string): CallAttempt[] {
    return this.#db
      .all(
        `SELECT ${ATTEMPT_COLUMNS} FROM call_attempts WHERE contact_id = ?
         ORDER BY attempt_number ASC`,
        contactId,
      )
      .map(mapAttempt);
  }

  search(filter: {
    campaignId?: string;
    status?: CallStatus;
    contactId?: string;
    agentId?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Call[] {
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
    if (filter.contactId !== undefined) {
      clauses.push('contact_id = ?');
      params.push(filter.contactId);
    }
    if (filter.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.activeOnly === true) {
      clauses.push(`status NOT IN (${TERMINAL_STATUS_LIST})`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 100, filter.offset ?? 0);

    return this.#db
      .all(
        `SELECT ${CALL_COLUMNS} FROM calls ${where} ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        ...params,
      )
      .map(mapCall);
  }

  /**
   * Calls still occupying a concurrency slot, according to the database.
   *
   * The in-memory ledger is authoritative for admission control (D-007); this exists so the
   * invariant checker can compare the two and catch a drift between them, which is exactly
   * the symptom a double-release bug produces.
   */
  activeCount(campaignId?: string): number {
    const row =
      campaignId === undefined
        ? this.#db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM calls WHERE status NOT IN (${TERMINAL_STATUS_LIST})`,
          )
        : this.#db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM calls
             WHERE campaign_id = ? AND status NOT IN (${TERMINAL_STATUS_LIST})`,
            campaignId,
          );
    return Number(row?.n ?? 0);
  }

  listActive(campaignId?: string): Call[] {
    return campaignId === undefined
      ? this.#db
          .all(`SELECT ${CALL_COLUMNS} FROM calls WHERE status NOT IN (${TERMINAL_STATUS_LIST})`)
          .map(mapCall)
      : this.#db
          .all(
            `SELECT ${CALL_COLUMNS} FROM calls
             WHERE campaign_id = ? AND status NOT IN (${TERMINAL_STATUS_LIST})`,
            campaignId,
          )
          .map(mapCall);
  }

  /**
   * Queries backing the correctness invariants (CONSTRAINTS.md §4).
   *
   * These deliberately ask the database rather than the in-memory ledger. The ledger is what
   * admission control uses; asking the durable record independently is what catches a drift
   * between the two, which is exactly the symptom a double-release bug produces.
   */
  agentsWithMultipleActiveCalls(): Array<{ agentId: string; count: number }> {
    return this.#db
      .all<{ agent_id: string; n: number }>(
        `SELECT agent_id, COUNT(*) AS n FROM calls
         WHERE agent_id IS NOT NULL AND status NOT IN (${TERMINAL_STATUS_LIST})
         GROUP BY agent_id HAVING n > 1`,
      )
      .map((row) => ({ agentId: String(row.agent_id), count: Number(row.n) }));
  }

  contactsWithMultipleActiveCalls(): Array<{ contactId: string; count: number }> {
    return this.#db
      .all<{ contact_id: string; n: number }>(
        `SELECT contact_id, COUNT(*) AS n FROM calls
         WHERE status NOT IN (${TERMINAL_STATUS_LIST})
         GROUP BY contact_id HAVING n > 1`,
      )
      .map((row) => ({ contactId: String(row.contact_id), count: Number(row.n) }));
  }

  /** Any call ever placed to a contact marked DO_NOT_CALL. Must always be empty. */
  callsToDoNotCallContacts(): Array<{ callId: string; contactId: string }> {
    return this.#db
      .all<{ id: string; contact_id: string }>(
        `SELECT c.id, c.contact_id FROM calls c
         JOIN contacts ct ON ct.id = c.contact_id
         WHERE ct.status = 'DO_NOT_CALL'`,
      )
      .map((row) => ({ callId: String(row.id), contactId: String(row.contact_id) }));
  }

  activeCountByProvider(): Record<string, number> {
    const rows = this.#db.all<{ provider_id: string; n: number }>(
      `SELECT provider_id, COUNT(*) AS n FROM calls
       WHERE status NOT IN (${TERMINAL_STATUS_LIST}) GROUP BY provider_id`,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.provider_id)] = Number(row.n);
    return counts;
  }

  /**
   * Finished-call and answered counts in one query.
   *
   * Exists specifically for the dialer's per-tick snapshot. The full `campaignMetrics`
   * bundle is far too expensive there — it aggregates the events table, which grows all run
   * long, so using it per tick made each tick slower than the last (BUG.md B-002).
   */
  answerStatistics(campaignId: string): { finished: number; answered: number } {
    const row = this.#db.get<{ finished: number; answered: number }>(
      `SELECT
         COUNT(*) AS finished,
         SUM(CASE WHEN outcome = 'ANSWERED' THEN 1 ELSE 0 END) AS answered
       FROM calls WHERE campaign_id = ? AND outcome IS NOT NULL`,
      campaignId,
    );
    return { finished: Number(row?.finished ?? 0), answered: Number(row?.answered ?? 0) };
  }

  outcomeCounts(campaignId: string): Record<string, number> {
    const rows = this.#db.all<{ outcome: string | null; n: number }>(
      'SELECT outcome, COUNT(*) AS n FROM calls WHERE campaign_id = ? GROUP BY outcome',
      campaignId,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (row.outcome === null) continue;
      counts[String(row.outcome)] = Number(row.n);
    }
    return counts;
  }

  statistics(campaignId: string): {
    total: number;
    answered: number;
    abandoned: number;
    averageTalkMs: number;
  } {
    const row = this.#db.get<{
      total: number;
      answered: number;
      abandoned: number;
      avg_talk: number | null;
    }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'ANSWERED' THEN 1 ELSE 0 END) AS answered,
         SUM(abandoned) AS abandoned,
         AVG(talk_duration_ms) AS avg_talk
       FROM calls WHERE campaign_id = ?`,
      campaignId,
    );
    return {
      total: Number(row?.total ?? 0),
      answered: Number(row?.answered ?? 0),
      abandoned: Number(row?.abandoned ?? 0),
      averageTalkMs: Math.round(Number(row?.avg_talk ?? 0)),
    };
  }
}

/**
 * Which timestamp column a status transition stamps. Keeping this as a lookup rather than
 * a switch at each call site means a new call state cannot silently forget its timestamp.
 */
const TIMESTAMP_COLUMN_FOR_STATUS: Partial<Record<CallStatus, string>> = {
  DIALING: 'dialing_at',
  RINGING: 'ringing_at',
  CONNECTED: 'connected_at',
};

const TERMINAL_STATUS_LIST = `'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'TIMEOUT'`;
