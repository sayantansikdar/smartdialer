/**
 * Agent roster and state.
 *
 * New agents are created OFFLINE and brought online explicitly, so adding one never silently
 * becomes dialable capacity in the middle of a running campaign.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { duration, percent, virtualTime } from '../lib/format.ts';
import { Badge, Card, Empty, Field, Stat } from '../components/ui.tsx';

export function AgentsView({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const campaigns = usePolled(() => api.campaigns(), 10_000);
  const [campaignId, setCampaignId] = useState('');
  const [newName, setNewName] = useState('');
  const agents = usePolled(() => api.agents(campaignId || undefined), 1500, [campaignId]);
  const action = useAction();

  const metrics = agents.data?.metrics;

  const setStatus = (id: string, status: 'AVAILABLE' | 'PAUSED' | 'OFFLINE'): void => {
    void action.run(() => api.setAgentStatus(id, status), () => {
      agents.reload();
      onChanged();
    });
  };

  const create = (): void => {
    if (newName.trim() === '' || campaignId === '') return;
    void action.run(
      () => api.createAgent({ campaignId, name: newName.trim(), online: true }),
      () => {
        setNewName('');
        agents.reload();
        onChanged();
      },
    );
  };

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Agents</h1>
        <p className="view__subtitle">
          The scarce resource the whole dialer exists to keep busy without overwhelming.
          <span className="mono"> RESERVED</span> means a seat is spoken for by a call in flight
          that has not connected yet — pacing that ignored those would over-dial into agents
          who are already committed.
        </p>
      </div>

      <div className="section grid grid--4">
        <Stat label="Total agents" value={metrics?.total ?? 0} />
        <Stat label="Available" value={metrics?.available ?? 0} tone="ok" />
        <Stat label="Occupied" value={metrics?.occupied ?? 0} tone="info" hint="reserved, ringing or on call" />
        <Stat label="Utilisation" value={percent(metrics?.utilization ?? 0, 0)} hint="of agents who are online" />
      </div>

      <div className="toolbar">
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          <option value="">All campaigns</option>
          {campaigns.data?.campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
          ))}
        </select>
      </div>

      {campaignId !== '' && (
        <Card title="Add an agent" className="section">
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, maxWidth: 320 }}>
              <Field label="Name">
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Agent name" />
              </Field>
            </div>
            <button className="btn btn--primary" onClick={create} disabled={action.pending || newName.trim() === ''}>
              Add and bring online
            </button>
          </div>
        </Card>
      )}

      <Card>
        {agents.data === null ? (
          <Empty>Loading…</Empty>
        ) : agents.data.agents.length === 0 ? (
          <Empty>No agents. Select a campaign to add one.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Status</th><th>Current call</th>
                  <th className="num">Handled</th><th className="num">Avg handle</th>
                  <th>Since</th><th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {agents.data.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>{agent.name}</td>
                    <td><Badge status={agent.status} /></td>
                    <td className="mono">{agent.currentCallId ?? '—'}</td>
                    <td className="num">{agent.callsHandled}</td>
                    <td className="num">
                      {duration(agent.callsHandled === 0 ? null : Math.round(agent.totalHandleTimeMs / agent.callsHandled))}
                    </td>
                    <td className="mono">{virtualTime(agent.lastStateChange)}</td>
                    <td>
                      <div className="btn-row">
                        {agent.status === 'OFFLINE' && (
                          <button className="btn btn--sm btn--ok" onClick={() => setStatus(agent.id, 'AVAILABLE')}>
                            Bring online
                          </button>
                        )}
                        {agent.status === 'AVAILABLE' && (
                          <>
                            <button className="btn btn--sm" onClick={() => setStatus(agent.id, 'PAUSED')}>Pause</button>
                            <button className="btn btn--sm" onClick={() => setStatus(agent.id, 'OFFLINE')}>Offline</button>
                          </>
                        )}
                        {agent.status === 'PAUSED' && (
                          <button className="btn btn--sm btn--ok" onClick={() => setStatus(agent.id, 'AVAILABLE')}>
                            Resume
                          </button>
                        )}
                        {['RESERVED', 'RINGING', 'ON_CALL', 'WRAP_UP'].includes(agent.status) && (
                          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                            on a call — engine-owned
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {action.error !== null && (
        <div className="toast" role="alert">
          <span className="toast__code">{action.error.code}</span>
          {action.error.message}
          <button className="btn btn--sm" style={{ marginLeft: 10 }} onClick={action.clearError}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
