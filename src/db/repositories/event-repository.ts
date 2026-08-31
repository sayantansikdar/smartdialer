import type {
  EventFilter,
  EventSeverity,
  EventType,
  SmartDialerEvent,
  StoredEvent,
} from '../../domain/events.ts';
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
  seq, id, type, at, severity, message, campaign_id, contact_id, call_id, agent_id,
  provider_id, metadata
`;

const INSERT_COLUMNS = `
  id, type, at, severity, message, campaign_id, contact_id, call_id, agent_id,
  provider_id, metadata
`;

function mapRow(row: SqlRow): StoredEvent {
  return {
    seq: requireNumber(row, 'seq'),
    id: requireString(row, 'id'),
    type: requireString(row, 'type') as EventType,
    at: requireNumber(row, 'at'),
    severity: requireString(row, 'severity') as EventSeverity,
    message: requireString(row, 'message'),
    campaignId: optionalString(row, 'campaign_id') ?? undefined,
    contactId: optionalString(row, 'contact_id') ?? undefined,
    callId: optionalString(row, 'call_id') ?? undefined,
    agentId: optionalString(row, 'agent_id') ?? undefined,
    providerId: optionalString(row, 'provider_id') ?? undefined,
    metadata: fromJson<Record<string, unknown>>(row['metadata'] ?? null, {}),
  };
}

export class EventRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(event: SmartDialerEvent): void {
    this.#insertOne(event);
  }

  /**
   * Write a batch inside one transaction.
   *
   * At 100x simulation speed the engine emits thousands of events per second, and one
   * transaction per event would make disk sync — not the dialer — the thing being measured.
   * The batch boundary is the dialer tick, so an event is durable within one tick of being
   * emitted, which is well inside what the audit log needs.
   */
  insertMany(events: readonly SmartDialerEvent[]): void {
    if (events.length === 0) return;
    this.#db.transaction(() => {
      for (const event of events) this.#insertOne(event);
    });
  }

  #insertOne(event: SmartDialerEvent): void {
    this.#db.run(
      `INSERT INTO events (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.type,
      event.at,
      event.severity,
      event.message,
      event.campaignId ?? null,
      event.contactId ?? null,
      event.callId ?? null,
      event.agentId ?? null,
      event.providerId ?? null,
      toJson(event.metadata),
    );
  }

  /**
   * Query events. Every filter dimension is parameterised — none of the user-supplied
   * values are interpolated into SQL, only the fixed column names and placeholder counts.
   */
  query(filter: EventFilter = {}): StoredEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.types !== undefined && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    if (filter.severities !== undefined && filter.severities.length > 0) {
      clauses.push(`severity IN (${filter.severities.map(() => '?').join(', ')})`);
      params.push(...filter.severities);
    }
    for (const [column, value] of [
      ['campaign_id', filter.campaignId],
      ['contact_id', filter.contactId],
      ['call_id', filter.callId],
      ['agent_id', filter.agentId],
      ['provider_id', filter.providerId],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (filter.since !== undefined) {
      clauses.push('at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('at <= ?');
      params.push(filter.until);
    }
    if (filter.afterSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(filter.afterSeq);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Ordering by seq, not `at`: many events share a virtual millisecond, and seq is the
    // only total order that reflects the sequence they actually happened in.
    const order = filter.afterSeq === undefined ? 'ORDER BY seq DESC' : 'ORDER BY seq ASC';
    params.push(filter.limit ?? 200);

    return this.#db.all(`SELECT ${COLUMNS} FROM events ${where} ${order} LIMIT ?`, ...params).map(mapRow);
  }

  latestSeq(): number {
    const row = this.#db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events');
    return Number(row?.seq ?? 0);
  }

  count(): number {
    const row = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    return Number(row?.n ?? 0);
  }

  countByType(campaignId?: string): Record<string, number> {
    const rows =
      campaignId === undefined
        ? this.#db.all<{ type: string; n: number }>(
            'SELECT type, COUNT(*) AS n FROM events GROUP BY type',
          )
        : this.#db.all<{ type: string; n: number }>(
            'SELECT type, COUNT(*) AS n FROM events WHERE campaign_id = ? GROUP BY type',
            campaignId,
          );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.type)] = Number(row.n);
    return counts;
  }

  /**
   * Counts grouped by type and severity.
   *
   * Severity carries a real distinction for denials: routine capacity backpressure is
   * recorded at `debug` and genuine protective action at `warn`, so a report can separate
   * "the dialer was at capacity" from "a safety control intervened" (see `denialSeverity`).
   */
  countByTypeAndSeverity(campaignId?: string): Array<{ type: string; severity: string; n: number }> {
    const rows =
      campaignId === undefined
        ? this.#db.all<{ type: string; severity: string; n: number }>(
            'SELECT type, severity, COUNT(*) AS n FROM events GROUP BY type, severity',
          )
        : this.#db.all<{ type: string; severity: string; n: number }>(
            `SELECT type, severity, COUNT(*) AS n FROM events WHERE campaign_id = ?
             GROUP BY type, severity`,
            campaignId,
          );
    return rows.map((row) => ({
      type: String(row.type),
      severity: String(row.severity),
      n: Number(row.n),
    }));
  }

  deleteAll(): void {
    this.#db.run('DELETE FROM events');
  }
}
