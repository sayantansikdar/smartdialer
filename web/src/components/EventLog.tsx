/**
 * The live event stream.
 *
 * Filterable by severity, type and correlation id, because the interesting question is almost
 * never "what happened" but "what happened to call_000042".
 *
 * Debug events — which is where routine capacity backpressure lives (D-014) — are hidden by
 * default. A healthy campaign emits hundreds of them per minute and they would bury the
 * events that matter.
 */

import { useMemo, useState } from 'react';
import type { SmartDialerEvent } from '../lib/types.ts';
import { virtualTime } from '../lib/format.ts';
import { Empty } from './ui.tsx';

export function EventLog({
  events,
  showFilters = true,
}: {
  events: readonly SmartDialerEvent[];
  showFilters?: boolean;
}): React.JSX.Element {
  const [severity, setSeverity] = useState<'all' | 'info' | 'warn' | 'error'>('info');
  const [typeFilter, setTypeFilter] = useState('');
  const [idFilter, setIdFilter] = useState('');

  const filtered = useMemo(() => {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    const floor = severity === 'all' ? 0 : rank[severity];
    const type = typeFilter.trim().toLowerCase();
    const id = idFilter.trim().toLowerCase();

    return events.filter((event) => {
      if (rank[event.severity] < floor) return false;
      if (type !== '' && !event.type.toLowerCase().includes(type)) return false;
      if (id !== '') {
        const haystack = [event.campaignId, event.contactId, event.callId, event.agentId, event.providerId]
          .filter((value): value is string => value !== undefined)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(id)) return false;
      }
      return true;
    });
  }, [events, severity, typeFilter, idFilter]);

  return (
    <div>
      {showFilters && (
        <div className="toolbar">
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
            aria-label="Minimum severity"
          >
            <option value="all">All severities (incl. backpressure)</option>
            <option value="info">Info and above</option>
            <option value="warn">Warnings and above</option>
            <option value="error">Errors only</option>
          </select>
          <input
            placeholder="Filter by event type…"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter by event type"
          />
          <input
            placeholder="Filter by campaign / call / contact / agent id…"
            value={idFilter}
            onChange={(e) => setIdFilter(e.target.value)}
            aria-label="Filter by correlation id"
            style={{ minWidth: 260 }}
          />
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            {filtered.length} of {events.length}
          </span>
        </div>
      )}

      <div className="eventlog">
        {filtered.length === 0 ? (
          <Empty>No events match. Start a campaign, or widen the filter.</Empty>
        ) : (
          filtered.map((event) => (
            <div key={event.id} className={`eventlog__row eventlog__row--${event.severity}`}>
              <span className="eventlog__time">{virtualTime(event.at)}</span>
              <span className="eventlog__type">{event.type}</span>
              <span className="eventlog__msg">{event.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
