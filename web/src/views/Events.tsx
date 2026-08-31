/**
 * The full event history, searchable.
 *
 * The live stream carries recent events; this view also queries the persisted log, so you can
 * look further back than the browser has been open.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled } from '../lib/hooks.ts';
import { count } from '../lib/format.ts';
import { Card, Empty, Stat } from '../components/ui.tsx';
import { EventLog } from '../components/EventLog.tsx';
import type { SmartDialerEvent } from '../lib/types.ts';

export function EventsView({ events }: { events: readonly SmartDialerEvent[] }): React.JSX.Element {
  const [source, setSource] = useState<'live' | 'history'>('live');
  const history = usePolled(() => api.events({ limit: 1000 }), source === 'history' ? 5000 : 0, [source]);

  const shown = source === 'live' ? events : (history.data?.events ?? []);

  const bySeverity = shown.reduce<Record<string, number>>((acc, event) => {
    acc[event.severity] = (acc[event.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">System Events</h1>
        <p className="view__subtitle">
          Every state transition the engine makes. Routine capacity backpressure is recorded at
          debug severity and hidden by default — a healthy campaign emits hundreds a minute and
          they would bury the events that matter.
        </p>
      </div>

      <div className="section grid grid--4">
        <Stat label="Shown" value={count(shown.length)} />
        <Stat label="Warnings" value={count(bySeverity.warn ?? 0)} tone={(bySeverity.warn ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Errors" value={count(bySeverity.error ?? 0)} tone={(bySeverity.error ?? 0) > 0 ? 'danger' : undefined} />
        <Stat label="Backpressure" value={count(bySeverity.debug ?? 0)} hint="routine, not a problem" />
      </div>

      <div className="toolbar">
        <button
          className={`btn btn--sm ${source === 'live' ? 'btn--primary' : ''}`}
          onClick={() => setSource('live')}
        >
          Live stream
        </button>
        <button
          className={`btn btn--sm ${source === 'history' ? 'btn--primary' : ''}`}
          onClick={() => setSource('history')}
        >
          Persisted history
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {source === 'live'
            ? 'Events received since this tab opened, newest first.'
            : 'Queried from the database — reaches back further than this session.'}
        </span>
      </div>

      <Card>
        {shown.length === 0 ? <Empty>No events yet. Start a campaign.</Empty> : <EventLog events={shown} />}
      </Card>
    </div>
  );
}
