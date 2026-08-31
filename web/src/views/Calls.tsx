/**
 * Current and historical calls.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled } from '../lib/hooks.ts';
import { count, duration, virtualTime } from '../lib/format.ts';
import { Badge, Card, Empty, Stat } from '../components/ui.tsx';

const STATUSES = [
  'CREATED', 'QUEUED', 'DIALING', 'RINGING', 'CONNECTED', 'ON_HOLD',
  'ENDED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'TIMEOUT',
];

export function CallsView(): React.JSX.Element {
  const campaigns = usePolled(() => api.campaigns(), 10_000);
  const [campaignId, setCampaignId] = useState('');
  const [status, setStatus] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  const calls = usePolled(
    () => api.calls({
      campaignId: campaignId || undefined,
      status: status || undefined,
      activeOnly: activeOnly || undefined,
      limit: 200,
    }),
    1500,
    [campaignId, status, activeOnly],
  );

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Calls</h1>
        <p className="view__subtitle">
          Every call, live and historical. A call occupies a concurrency slot until it reaches a
          terminal state — which is exactly the set the invariants count.
        </p>
      </div>

      <div className="section grid grid--3">
        <Stat label="Active now" value={calls.data?.activeCount ?? 0} tone="info" />
        <Stat label="Shown" value={count(calls.data?.calls.length ?? 0)} hint="most recent first" />
        <Stat
          label="Abandoned in view"
          value={calls.data?.calls.filter((c) => c.abandoned).length ?? 0}
          tone={(calls.data?.calls.filter((c) => c.abandoned).length ?? 0) > 0 ? 'danger' : 'ok'}
          hint="answered with no agent free"
        />
      </div>

      <div className="toolbar">
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          <option value="">All campaigns</option>
          {campaigns.data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Active only
        </label>
      </div>

      <Card>
        {calls.data === null ? (
          <Empty>Loading…</Empty>
        ) : calls.data.calls.length === 0 ? (
          <Empty>No calls match. Start a campaign to place some.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Call</th><th>Status</th><th>Outcome</th><th>Contact</th><th>Agent</th>
                  <th>Created</th><th className="num">Talk time</th><th>Failure</th>
                </tr>
              </thead>
              <tbody>
                {calls.data.calls.map((call) => (
                  <tr key={call.id}>
                    <td className="mono">{call.id}</td>
                    <td><Badge status={call.status} /></td>
                    <td>
                      {call.outcome === null ? <span style={{ color: 'var(--text-faint)' }}>—</span> : <Badge status={call.outcome} />}
                      {call.abandoned && <span className="badge badge--danger" style={{ marginLeft: 4 }}>ABANDONED</span>}
                    </td>
                    <td className="mono">{call.contactId}</td>
                    <td className="mono">{call.agentId ?? '—'}</td>
                    <td className="mono">{virtualTime(call.createdAt)}</td>
                    <td className="num">{duration(call.talkDurationMs)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {call.failureCode ?? (call.failureClass === 'NONE' ? '—' : call.failureClass)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
