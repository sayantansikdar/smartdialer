/**
 * Campaign list and creation.
 *
 * The creation form mirrors the server's zod schema — the same bounds, the same reasons.
 * Client validation is a convenience, never the guarantee: the server rejects an unsafe
 * configuration regardless of what the browser sends, and the API tests prove it.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { percent } from '../lib/format.ts';
import { Badge, Card, Empty, Field } from '../components/ui.tsx';
import type { DialingMode } from '../lib/types.ts';
import {
  isValid,
  validateCampaignForm,
  type CampaignFormErrors,
} from '../lib/validation.ts';

type DraftForm = {
  name: string;
  dialingMode: DialingMode;
  maxConcurrentCalls: string;
  maxCallsPerSecond: string;
  maxAbandonRate: string;
  maxAttemptsPerContact: string;
};

const EMPTY_FORM: DraftForm = {
  name: '',
  dialingMode: 'PROGRESSIVE',
  maxConcurrentCalls: '8',
  maxCallsPerSecond: '4',
  maxAbandonRate: '0.03',
  maxAttemptsPerContact: '3',
};

export function CampaignsView({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const campaigns = usePolled(() => api.campaigns(), 2000);
  const action = useAction();
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [errors, setErrors] = useState<CampaignFormErrors>({});

  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = (): void => {
    const found = validateCampaignForm(form);
    setErrors(found);
    if (!isValid(found)) return;

    void action.run(
      () =>
        api.createCampaign({
          name: form.name.trim(),
          dialingMode: form.dialingMode,
          maxConcurrentCalls: Number(form.maxConcurrentCalls),
          maxCallsPerSecond: Number(form.maxCallsPerSecond),
          maxAbandonRate: Number(form.maxAbandonRate),
          maxAttemptsPerContact: Number(form.maxAttemptsPerContact),
        }),
      () => {
        setForm(EMPTY_FORM);
        setShowForm(false);
        campaigns.reload();
        onChanged();
      },
    );
  };

  const act = (id: string, verb: 'start' | 'pause' | 'resume' | 'stop' | 'ready' | 'reset'): void => {
    void action.run(() => api.campaignAction(id, verb), () => {
      campaigns.reload();
      onChanged();
    });
  };

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Campaigns</h1>
        <p className="view__subtitle">
          Create, configure and control campaigns. Start, pause, resume and stop all perform the
          real transition — pausing genuinely halts new dialing while calls already in flight
          finish.
        </p>
      </div>

      <div className="toolbar">
        <button className="btn btn--primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New campaign'}
        </button>
      </div>

      {showForm && (
        <Card title="New campaign" className="section">
          <div className="form-grid">
            <Field label="Name" error={errors.name}>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Q3 Renewals" />
            </Field>
            <Field label="Dialing mode" hint="Predictive needs a large team to over-dial safely">
              <select value={form.dialingMode} onChange={(e) => set('dialingMode', e.target.value as DialingMode)}>
                <option value="PROGRESSIVE">Progressive — one line per free agent</option>
                <option value="PREDICTIVE">Predictive — over-dial on the answer rate</option>
              </select>
            </Field>
            <Field label="Max concurrent calls" error={errors.maxConcurrentCalls}>
              <input value={form.maxConcurrentCalls} onChange={(e) => set('maxConcurrentCalls', e.target.value)} />
            </Field>
            <Field label="Max calls / second" error={errors.maxCallsPerSecond}>
              <input value={form.maxCallsPerSecond} onChange={(e) => set('maxCallsPerSecond', e.target.value)} />
            </Field>
            <Field
              label="Max abandon rate"
              error={errors.maxAbandonRate}
              hint="0.03 = 3%. Real predictive dialing is typically held at or below this."
            >
              <input value={form.maxAbandonRate} onChange={(e) => set('maxAbandonRate', e.target.value)} />
            </Field>
            <Field label="Max attempts / contact" error={errors.maxAttemptsPerContact}>
              <input
                value={form.maxAttemptsPerContact}
                onChange={(e) => set('maxAttemptsPerContact', e.target.value)}
              />
            </Field>
          </div>
          <div className="btn-row">
            <button className="btn btn--primary" onClick={submit} disabled={action.pending}>
              Create campaign
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              Created in DRAFT. Add agents and contacts before starting.
            </span>
          </div>
          {action.error !== null && (
            <div className="field__error" style={{ marginTop: 8 }}>
              {action.error.code}: {action.error.message}
            </div>
          )}
        </Card>
      )}

      <Card>
        {campaigns.data === null ? (
          <Empty>Loading…</Empty>
        ) : campaigns.data.campaigns.length === 0 ? (
          <Empty>No campaigns. Create one above, or run `npm run seed` for demo data.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th className="num">Concurrency</th>
                  <th className="num">Rate</th>
                  <th className="num">Attempts</th>
                  <th className="num">Abandon max</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.data.campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <a href={`#/campaign/${campaign.id}`}>{campaign.name}</a>
                      {campaign.predictivePausedReason !== null && (
                        <div style={{ fontSize: 11, color: 'var(--warn)' }}>
                          Predictive paused: {campaign.predictivePausedReason}
                        </div>
                      )}
                    </td>
                    <td><Badge status={campaign.status} /></td>
                    <td className="mono">{campaign.dialingMode}</td>
                    <td className="num">{campaign.maxConcurrentCalls}</td>
                    <td className="num">{campaign.maxCallsPerSecond}/s</td>
                    <td className="num">{campaign.maxAttemptsPerContact}</td>
                    <td className="num">{percent(campaign.maxAbandonRate)}</td>
                    <td>
                      <div className="btn-row">
                        {campaign.status === 'DRAFT' && (
                          <button className="btn btn--sm" onClick={() => act(campaign.id, 'ready')}>
                            Mark ready
                          </button>
                        )}
                        {(campaign.status === 'READY' || campaign.status === 'DRAFT' || campaign.status === 'STOPPED') && (
                          <button className="btn btn--sm btn--primary" onClick={() => act(campaign.id, 'start')}>
                            Start
                          </button>
                        )}
                        {campaign.status === 'RUNNING' && (
                          <button className="btn btn--sm" onClick={() => act(campaign.id, 'pause')}>
                            Pause
                          </button>
                        )}
                        {campaign.status === 'PAUSED' && (
                          <button className="btn btn--sm btn--primary" onClick={() => act(campaign.id, 'resume')}>
                            Resume
                          </button>
                        )}
                        {(campaign.status === 'RUNNING' || campaign.status === 'PAUSED') && (
                          <button className="btn btn--sm btn--danger" onClick={() => act(campaign.id, 'stop')}>
                            Stop
                          </button>
                        )}
                        {(campaign.status === 'COMPLETED' || campaign.status === 'STOPPED' || campaign.status === 'FAILED') && (
                          <button
                            className="btn btn--sm"
                            title="Put unsuccessful contacts back in the pool and run again. Never restores DO_NOT_CALL contacts."
                            onClick={() => act(campaign.id, 'reset')}
                          >
                            Reset
                          </button>
                        )}
                        <button className="btn btn--sm" onClick={() => navigate('campaign', campaign.id)}>
                          Detail
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {action.error !== null && !showForm && (
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
