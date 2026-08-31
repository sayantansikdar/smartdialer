/**
 * The application shell.
 *
 * Owns three pieces of state every view needs: system status (polled), the live event stream
 * (SSE), and the connection state. Views receive what they need as props rather than each
 * opening its own stream — nine EventSource connections to the same endpoint would be nine
 * subscribers on the server for no benefit.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.ts';
import { appendBounded, openEventStream, type ConnectionState } from './lib/events.ts';
import { navigate, useRoute } from './lib/router.ts';
import { usePolled, useAction } from './lib/hooks.ts';
import type { SmartDialerEvent } from './lib/types.ts';
import { virtualTime } from './lib/format.ts';

import { DashboardView } from './views/Dashboard.tsx';
import { CampaignsView } from './views/Campaigns.tsx';
import { CampaignDetailView } from './views/CampaignDetail.tsx';
import { ContactsView } from './views/Contacts.tsx';
import { AgentsView } from './views/Agents.tsx';
import { CallsView } from './views/Calls.tsx';
import { SimulationView } from './views/Simulation.tsx';
import { ProviderView } from './views/Provider.tsx';
import { EventsView } from './views/Events.tsx';

const NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'agents', label: 'Agents' },
  { id: 'calls', label: 'Calls' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'provider', label: 'Provider' },
  { id: 'events', label: 'System Events' },
];

export function App(): React.JSX.Element {
  const route = useRoute();
  const [events, setEvents] = useState<readonly SmartDialerEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  const status = usePolled(() => api.systemStatus(), 1000);
  const action = useAction();

  const onEvent = useCallback((event: SmartDialerEvent) => {
    setEvents((current) => appendBounded(current, event));
  }, []);

  useEffect(() => openEventStream({ onEvent, onStateChange: setConnection }), [onEvent]);

  // Seed the log with recent history so a freshly-opened dashboard is not blank until the
  // next event happens to fire.
  useEffect(() => {
    void api
      .events({ limit: 200 })
      .then((result) => setEvents((current) => (current.length === 0 ? result.events : current)))
      .catch(() => undefined);
  }, []);

  const system = status.data?.system;
  const emergencyStopped = system?.emergencyStopped ?? false;

  const toggleEmergencyStop = (): void => {
    void action.run(
      () => (emergencyStopped ? api.emergencyResume() : api.emergencyStop('Engaged from the dashboard')),
      status.reload,
    );
  };

  return (
    <div className="app">
      {/*
        The safety posture is the first thing on the page, above the product name. Anyone who
        glances at this dashboard should know immediately that nothing here places real calls
        (CONSTRAINTS.md §1).
      */}
      <div className="safety-banner">
        <span>●</span>
        <span>
          SIMULATION MODE — mock provider &ldquo;{system?.providerDriver ?? '…'}&rdquo;. No real
          calls are placed and no real phone numbers are stored.
        </span>
      </div>

      {emergencyStopped && (
        <div className="estop-banner">
          <span>■</span>
          <span>
            EMERGENCY STOP ENGAGED — no new calls will be initiated
            {system?.reason === null || system?.reason === undefined ? '' : ` · ${system.reason}`}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn--sm btn--ok" onClick={toggleEmergencyStop} disabled={action.pending}>
            Release
          </button>
        </div>
      )}

      <header className="masthead">
        <div className="masthead__brand">SmartDialer</div>

        <div className="connection">
          <span
            className={`connection__dot ${
              connection === 'live' ? 'connection__dot--live' : connection === 'down' ? 'connection__dot--down' : ''
            }`}
          />
          {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </div>

        <div className="masthead__spacer" />

        <div className="masthead__stats">
          <span className="masthead__stat">
            Active calls <b>{status.data?.activeCalls ?? 0}</b> / {status.data?.concurrency.globalMax ?? '—'}
          </span>
          <span className="masthead__stat">
            Agents <b>{status.data?.agents.available ?? 0}</b> free of {status.data?.agents.total ?? 0}
          </span>
          <span className="masthead__stat">
            Sim clock <b>{virtualTime(status.data?.clock.virtualMs ?? 0)}</b> @{' '}
            {status.data?.clock.speed ?? 1}×
          </span>
        </div>

        <button
          className={`btn ${emergencyStopped ? 'btn--ok' : 'btn--danger'}`}
          onClick={toggleEmergencyStop}
          disabled={action.pending}
        >
          {emergencyStopped ? 'Release Emergency Stop' : 'Emergency Stop'}
        </button>
      </header>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav__item ${route.view === item.id || (route.view === 'campaign' && item.id === 'campaigns') ? 'nav__item--active' : ''}`}
            onClick={() => navigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="main">
        <Router route={route} events={events} onChanged={status.reload} />
      </main>

      {action.error !== null && (
        <div className="toast" role="alert">
          <span className="toast__code">{action.error.code}</span>
          {action.error.message}
          <button className="btn btn--sm" style={{ marginLeft: 10 }} onClick={action.clearError}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function Router({
  route,
  events,
  onChanged,
}: {
  route: { view: string; param: string | null };
  events: readonly SmartDialerEvent[];
  onChanged: () => void;
}): React.JSX.Element {
  switch (route.view) {
    case 'campaigns':
      return <CampaignsView onChanged={onChanged} />;
    case 'campaign':
      return route.param === null ? (
        <CampaignsView onChanged={onChanged} />
      ) : (
        <CampaignDetailView campaignId={route.param} events={events} onChanged={onChanged} />
      );
    case 'contacts':
      return <ContactsView />;
    case 'agents':
      return <AgentsView onChanged={onChanged} />;
    case 'calls':
      return <CallsView />;
    case 'simulation':
      return <SimulationView />;
    case 'provider':
      return <ProviderView />;
    case 'events':
      return <EventsView events={events} />;
    default:
      return <DashboardView events={events} />;
  }
}
