/**
 * Real-time overview.
 *
 * Answers three questions in order of urgency: is anything wrong, what is the system doing
 * right now, and what just happened.
 */

import { api } from '../lib/api.ts';
import { usePolled } from '../lib/hooks.ts';
import { count, duration, percent } from '../lib/format.ts';
import { Badge, Card, Empty, Meter, Stat } from '../components/ui.tsx';
import { EventLog } from '../components/EventLog.tsx';
import { navigate } from '../lib/router.ts';
import type { SmartDialerEvent } from '../lib/types.ts';

export function DashboardView({ events }: { events: readonly SmartDialerEvent[] }): React.JSX.Element {
  const status = usePolled(() => api.systemStatus(), 1000);
  const campaigns = usePolled(() => api.campaigns(), 2000);
  const invariants = usePolled(() => api.invariants(), 5000);

  const agents = status.data?.agents;
  const concurrency = status.data?.concurrency;
  const active = status.data?.activeCalls ?? 0;
  const globalMax = concurrency?.globalMax ?? 1;

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Dashboard</h1>
        <p className="view__subtitle">
          Live state of the dialer. Every number here comes from the running engine — the same
          engine the test suite drives.
        </p>
      </div>

      {/*
        A crash that silently tidies up after itself is a crash nobody notices, so this sits
        above the metrics — it is describing something that already went wrong.
      */}
      {status.data !== null && !status.data.recovery.clean && (
        <div className="section">
          <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--warn-dim)' }}>
            <div className="card__header">
              <h3 className="card__title" style={{ color: 'var(--warn)' }}>
                Recovered from an unclean shutdown
              </h3>
              <span className="badge badge--warn">RECOVERED</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              A previous process left work in flight. On startup this one reclaimed{' '}
              <strong>{status.data.recovery.callsReclaimed}</strong> call(s),{' '}
              released <strong>{status.data.recovery.contactsReleased}</strong> contact(s) and{' '}
              freed <strong>{status.data.recovery.agentsReleased}</strong> agent(s).
              Reclaimed calls are recorded as timeouts, not failures — the outage was ours, so
              those contacts remain retriable.
            </div>
          </div>
        </div>
      )}

      {/*
        Invariants first. This is the headline correctness signal, and burying it below the
        metrics would defeat the point of checking them continuously.
      */}
      {invariants.data !== null && (
        <div className="section">
          <div className={`card ${invariants.data.passed ? '' : 'stat--danger'}`}>
            <div className="card__header">
              <h3 className="card__title">System invariants</h3>
              <Badge status={invariants.data.passed ? 'PASSED' : 'FAILED'} />
            </div>
            {invariants.data.passed ? (
              <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                Concurrency limits, agent capacity, attempt limits and DNC protection all hold.
                Checked continuously against the database, not the in-memory ledger.
              </div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--danger)' }}>
                {invariants.data.violations.map((violation, index) => (
                  <li key={index}>
                    <strong>{violation.invariant}</strong> — {violation.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="section grid grid--4">
        <Stat
          label="Active calls"
          value={active}
          hint={`of ${globalMax} global limit`}
          tone={active >= globalMax ? 'warn' : 'info'}
        />
        <Stat label="Agents available" value={agents?.available ?? 0} hint={`${agents?.total ?? 0} total`} tone="ok" />
        <Stat
          label="Agent utilisation"
          value={percent(agents?.utilization ?? 0, 0)}
          hint="occupied seats / online agents"
        />
        <Stat
          label="Avg handle time"
          value={duration(agents?.averageHandleTimeMs ?? 0)}
          hint="talk + wrap, simulated"
        />
      </div>

      <div className="section split">
        <Card title="Campaigns">
          {campaigns.data === null || campaigns.data.campaigns.length === 0 ? (
            <Empty>No campaigns yet. Run `npm run seed`, or create one on the Campaigns tab.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th className="num">Active</th>
                    <th className="num">Limit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {campaigns.data.campaigns.map((campaign) => {
                    const activeForCampaign = concurrency?.byCampaign[campaign.id] ?? 0;
                    return (
                      <tr key={campaign.id}>
                        <td>{campaign.name}</td>
                        <td><Badge status={campaign.status} /></td>
                        <td className="mono">{campaign.dialingMode}</td>
                        <td className="num">{activeForCampaign}</td>
                        <td className="num">{campaign.maxConcurrentCalls}</td>
                        <td>
                          <button className="btn btn--sm" onClick={() => navigate('campaign', campaign.id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          <Card title="Concurrency" className="section">
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              {active} of {globalMax} global slots in use
            </div>
            <Meter value={active} max={globalMax} tone={active >= globalMax ? 'warn' : 'ok'} />
            <div style={{ marginTop: 12, fontSize: 12.5 }}>
              {Object.entries(concurrency?.byProvider ?? {}).length === 0 ? (
                <span style={{ color: 'var(--text-faint)' }}>No provider traffic right now.</span>
              ) : (
                Object.entries(concurrency?.byProvider ?? {}).map(([provider, n]) => (
                  <div key={provider} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-dim)' }}>{provider}</span>
                    <span className="mono">
                      {n} / {concurrency?.providerMax}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card title="Agent states">
            {agents === undefined ? (
              <Empty>Loading…</Empty>
            ) : (
              <div style={{ fontSize: 13 }}>
                {([
                  ['Available', agents.available, 'ok'],
                  ['On call', agents.onCall, 'info'],
                  ['Wrap up', agents.wrapUp, 'warn'],
                  ['Paused', agents.paused, 'muted'],
                  ['Offline', agents.offline, 'muted'],
                ] as const).map(([label, value]) => (
                  <div
                    key={label}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}
                  >
                    <span style={{ color: 'var(--text-dim)' }}>{label}</span>
                    <span className="mono">{count(value)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="Live event stream">
        <EventLog events={events.slice(0, 120)} showFilters={false} />
      </Card>
    </div>
  );
}
