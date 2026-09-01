/**
 * One campaign, in depth.
 *
 * The panel that earns its place here is "Why this many calls?" — the dialer's own reasoning,
 * rendered verbatim. A pacing decision an operator cannot interrogate is a pacing decision
 * they cannot trust, and the strategy already produces the explanation (D-010).
 */

import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { count, duration, percent } from '../lib/format.ts';
import { Badge, Card, Empty, KeyValue, Meter, Stat } from '../components/ui.tsx';
import { EventLog } from '../components/EventLog.tsx';
import { navigate } from '../lib/router.ts';
import type { SmartDialerEvent } from '../lib/types.ts';

export function CampaignDetailView({
  campaignId,
  events,
  onChanged,
}: {
  campaignId: string;
  events: readonly SmartDialerEvent[];
  onChanged: () => void;
}): React.JSX.Element {
  const detail = usePolled(() => api.campaign(campaignId), 2000, [campaignId]);
  const metrics = usePolled(() => api.campaignMetrics(campaignId), 1000, [campaignId]);
  const safety = usePolled(() => api.campaignSafety(campaignId), 2000, [campaignId]);
  const action = useAction();

  const campaign = detail.data?.campaign;
  const m = metrics.data?.campaign;
  const dialer = metrics.data?.dialer;
  const agentMetrics = metrics.data?.agents;

  const act = (
    verb: 'start' | 'pause' | 'resume' | 'stop' | 'ready' | 'resume-predictive' | 'reset',
  ): void => {
    void action.run(() => api.campaignAction(campaignId, verb), () => {
      detail.reload();
      metrics.reload();
      safety.reload();
      onChanged();
    });
  };

  if (detail.error !== null) {
    return (
      <Empty>
        {detail.error.message}{' '}
        <button className="btn btn--sm" onClick={() => navigate('campaigns')}>
          Back to campaigns
        </button>
      </Empty>
    );
  }
  if (campaign === undefined) return <Empty>Loading…</Empty>;

  const campaignEvents = events.filter((event) => event.campaignId === campaignId);

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">
          {campaign.name} <Badge status={campaign.status} />
        </h1>
        <p className="view__subtitle">
          {campaign.dialingMode === 'PREDICTIVE'
            ? 'Predictive: over-dials based on the observed answer rate, bounded by a variance guard so a lucky batch cannot swamp the agents.'
            : 'Progressive: one line per free agent, so every answered call has someone waiting.'}
        </p>
      </div>

      <div className="toolbar">
        {campaign.status === 'DRAFT' && <button className="btn" onClick={() => act('ready')}>Mark ready</button>}
        {(campaign.status === 'READY' || campaign.status === 'DRAFT' || campaign.status === 'STOPPED') && (
          <button className="btn btn--primary" onClick={() => act('start')} disabled={action.pending}>
            Start
          </button>
        )}
        {campaign.status === 'RUNNING' && (
          <button className="btn" onClick={() => act('pause')} disabled={action.pending}>
            Pause
          </button>
        )}
        {campaign.status === 'PAUSED' && (
          <button className="btn btn--primary" onClick={() => act('resume')} disabled={action.pending}>
            Resume
          </button>
        )}
        {(campaign.status === 'RUNNING' || campaign.status === 'PAUSED') && (
          <button className="btn btn--danger" onClick={() => act('stop')} disabled={action.pending}>
            Stop
          </button>
        )}
        {campaign.predictivePausedReason !== null && (
          <button className="btn btn--ok" onClick={() => act('resume-predictive')} disabled={action.pending}>
            Resume predictive dialing
          </button>
        )}
        {(campaign.status === 'COMPLETED' || campaign.status === 'STOPPED' || campaign.status === 'FAILED') && (
          <button
            className="btn"
            title="Put unsuccessful contacts back in the pool and run again. Never restores DO_NOT_CALL contacts, and never re-dials someone already reached."
            onClick={() => act('reset')}
            disabled={action.pending}
          >
            Reset for replay
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn--sm" onClick={() => navigate('contacts')}>Contacts</button>
        <button className="btn btn--sm" onClick={() => navigate('calls')}>Calls</button>
      </div>

      {campaign.predictivePausedReason !== null && (
        <div className="denial section">
          <strong>Predictive dialing paused by the abandon-rate control.</strong>
          <span>
            {campaign.predictivePausedReason} — this never clears itself, because the condition
            that tripped it is the condition that would trip it again. Resume explicitly once
            you have looked at why.
          </span>
        </div>
      )}

      <div className="section grid grid--4">
        <Stat label="Active calls" value={m?.callsActive ?? 0} hint={`limit ${campaign.maxConcurrentCalls}`} tone="info" />
        <Stat label="Contacts remaining" value={count(m?.contactsRemaining ?? 0)} hint={`${count(m?.contactsTotal ?? 0)} total`} />
        <Stat label="Answer rate" value={percent(m?.answerRate ?? 0)} hint={`recent ${percent(m?.recentAnswerRate ?? 0)}`} tone="ok" />
        <Stat
          label="Abandon rate"
          value={percent(m?.abandonRate ?? 0)}
          hint={`max ${percent(campaign.maxAbandonRate)}`}
          tone={(m?.abandonRate ?? 0) > campaign.maxAbandonRate ? 'danger' : 'ok'}
        />
      </div>

      <div className="section split">
        <div>
          {/*
            The dialer's own arithmetic, verbatim. This is the difference between a demo that
            looks like magic and one that explains itself.
          */}
          <Card title="Why this many calls?" className="section">
            {dialer?.lastPlan == null ? (
              <Empty>The campaign is not ticking. Start it to see live pacing decisions.</Empty>
            ) : (
              <>
                <div style={{ marginBottom: 10, fontSize: 13 }}>
                  Most recent plan requested{' '}
                  <strong className="mono" style={{ color: 'var(--accent)' }}>
                    {dialer.lastPlan.attempts}
                  </strong>{' '}
                  dial{dialer.lastPlan.attempts === 1 ? '' : 's'}.
                </div>
                <pre className="reasoning">{dialer.lastPlan.reasoning.join('\n')}</pre>
              </>
            )}
          </Card>

          <Card title="Contacts by status" className="section">
            {m === undefined || Object.keys(m.contactsByStatus).length === 0 ? (
              <Empty>No contacts.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {Object.entries(m.contactsByStatus)
                      .sort((a, b) => b[1] - a[1])
                      .map(([statusName, n]) => (
                        <tr key={statusName}>
                          <td><Badge status={statusName} /></td>
                          <td className="num">{count(n)}</td>
                          <td style={{ width: '55%' }}>
                            <Meter value={n} max={m.contactsTotal} tone="info" />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Call outcomes">
            {m === undefined || Object.keys(m.outcomes).length === 0 ? (
              <Empty>No completed calls yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Outcome</th><th className="num">Count</th><th className="num">Share</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(m.outcomes).sort((a, b) => b[1] - a[1]).map(([outcome, n]) => (
                      <tr key={outcome}>
                        <td><Badge status={outcome} /></td>
                        <td className="num">{count(n)}</td>
                        <td className="num">{percent(m.callsTotal === 0 ? 0 : n / m.callsTotal, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div>
          <Card title="Dialer state" className="section">
            <KeyValue
              rows={[
                ['Ticking', dialer?.running === true ? 'yes' : 'no'],
                ['Stood down', dialer?.stalled === true ? 'yes' : 'no'],
                ['In flight', dialer?.inFlight ?? 0],
                ['Awaiting agent', dialer?.awaitingAgent ?? 0],
                ['Free agents', dialer?.snapshot?.availableAgents ?? 0],
                ['Est. answer rate', percent(dialer?.snapshot?.recentAnswerRate ?? 0)],
                ['Campaign headroom', dialer?.snapshot?.campaignHeadroom ?? 0],
                ['Rate headroom', dialer?.snapshot?.rateLimitHeadroom ?? 0],
              ]}
            />
          </Card>

          {/*
            "Why is this campaign not dialing?" — every rule currently denying, not just the
            first. Evaluated read-only so asking does not spend rate-limit allowance.
          */}
          <Card title="Safety evaluation" className="section">
            {safety.data === null ? (
              <Empty>Loading…</Empty>
            ) : safety.data.denials.length === 0 ? (
              <div style={{ color: 'var(--ok)', fontSize: 13 }}>
                All safety rules pass — nothing is blocking this campaign.
              </div>
            ) : (
              safety.data.denials.map((denial) => (
                <div
                  key={denial.rule}
                  className={`denial ${
                    ['AGENT_CAPACITY_EXCEEDED', 'GLOBAL_CONCURRENCY_LIMIT', 'CAMPAIGN_CONCURRENCY_LIMIT',
                     'PROVIDER_CONCURRENCY_LIMIT', 'RATE_LIMIT_EXCEEDED', 'RETRY_NOT_DUE'].includes(denial.code)
                      ? 'denial--backpressure'
                      : ''
                  }`}
                >
                  <div>
                    <div className="mono" style={{ fontSize: 11, opacity: 0.85 }}>{denial.code}</div>
                    {denial.message}
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card title="Agents">
            <KeyValue
              rows={[
                ['Total', agentMetrics?.total ?? 0],
                ['Available', agentMetrics?.available ?? 0],
                ['On call', agentMetrics?.onCall ?? 0],
                ['Wrap up', agentMetrics?.wrapUp ?? 0],
                ['Utilisation', percent(agentMetrics?.utilization ?? 0, 0)],
                ['Avg handle', duration(agentMetrics?.averageHandleTimeMs ?? 0)],
              ]}
            />
          </Card>
        </div>
      </div>

      <Card title="Campaign events">
        <EventLog events={campaignEvents} />
      </Card>

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
