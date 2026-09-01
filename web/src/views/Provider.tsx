/**
 * Mock provider behaviour and failure injection.
 *
 * Every control here is real. Moving the timeout slider changes the live provider, and the
 * very next call the engine places will genuinely go silent — the watchdog fires, the slot is
 * released and a retry is scheduled. Nothing on this page is a simulation of a simulation
 * (CONSTRAINTS.md §5).
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { count, duration, percent } from '../lib/format.ts';
import { Card, Empty, Stat } from '../components/ui.tsx';
import type { ProviderConfig } from '../lib/types.ts';

interface Knob {
  key: keyof ProviderConfig;
  label: string;
  why: string;
  max: number;
  step: number;
}

/** Each knob says what it actually causes, not just what it is called. */
const RATE_KNOBS: readonly Knob[] = [
  { key: 'answerRate', label: 'Answer rate', why: 'Share of calls a person picks up.', max: 1, step: 0.05 },
  { key: 'noAnswerRate', label: 'No-answer rate', why: 'Rings out. Transient — will be retried.', max: 1, step: 0.05 },
  { key: 'busyRate', label: 'Busy rate', why: 'Engaged. Transient — will be retried.', max: 1, step: 0.05 },
  { key: 'failureRate', label: 'Call failure rate', why: 'Provider reports the call failed mid-flight.', max: 1, step: 0.05 },
  { key: 'timeoutRate', label: 'Silence rate', why: 'Provider accepts the call and never reports an outcome. Only the engine watchdog can recover these.', max: 1, step: 0.05 },
  { key: 'stuckRingingRate', label: 'Stuck ringing', why: 'Rings forever with no terminal event.', max: 1, step: 0.05 },
  { key: 'errorRate', label: 'Request rejection', why: 'createCall is refused. Transient.', max: 1, step: 0.05 },
  { key: 'invalidNumberRate', label: 'Invalid number', why: 'Permanent — never retried, so it does not burn attempts.', max: 1, step: 0.05 },
];

export function ProviderView(): React.JSX.Element {
  const providers = usePolled(() => api.providers(), 1500);
  const action = useAction();
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);

  const current = providers.data?.providers.find((p) => p.id === (providerId ?? p.id));

  // Adopt the live config once, then let the user edit locally. Re-adopting on every poll
  // would yank a slider out from under the person dragging it.
  useEffect(() => {
    if (draft === null && current !== undefined) {
      setDraft(current.config);
      setProviderId(current.id);
    }
  }, [current, draft]);

  const apply = (patch: Partial<ProviderConfig>): void => {
    if (providerId === null) return;
    const next = { ...(draft ?? current?.config), ...patch } as ProviderConfig;
    setDraft(next);
    void action.run(
      () => api.updateProvider(providerId, patch as Record<string, number | boolean>),
      providers.reload,
    );
  };

  const preset = (patch: Partial<ProviderConfig>): void => {
    setDraft((d) => (d === null ? d : { ...d, ...patch }));
    if (providerId !== null) {
      void action.run(() => api.updateProvider(providerId, patch as Record<string, number | boolean>), providers.reload);
    }
  };

  if (providers.data === null) return <Empty>Loading…</Empty>;
  if (current === undefined || draft === null) return <Empty>No provider registered.</Empty>;

  const metrics = current.metrics;

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Provider — {current.id}</h1>
        <p className="view__subtitle">
          Driver <span className="mono">{current.driver}</span>. These controls change the live
          provider: the next call the engine places really will behave this way. There is no
          real-telecom implementation in this repository to switch to.
        </p>
      </div>

      <div className="section grid grid--4">
        <Stat label="Requests" value={count(metrics.requests)} />
        <Stat label="Accepted" value={count(metrics.accepted)} tone="ok" />
        <Stat label="Rejected" value={count(metrics.rejected)} tone={metrics.rejected > 0 ? 'warn' : undefined} hint="createCall refused" />
        <Stat
          label="Went silent"
          value={count(metrics.silent)}
          tone={metrics.silent > 0 ? 'danger' : undefined}
          hint="no terminal event ever sent"
        />
        <Stat label="Completed" value={count(metrics.completed)} />
        <Stat label="Failed" value={count(metrics.failed)} />
        <Stat label="Avg response" value={duration(metrics.averageResponseTimeMs)} hint="time to accept" />
        <Stat label="Active calls" value={count(metrics.activeCalls)} tone="info" />
      </div>

      {/*
        Only the unreliable driver produces these, and they are worth showing prominently:
        without them, an event stream full of repeats looks like the engine misbehaving rather
        than the provider doing exactly what it was configured to do.
      */}
      {(current.faults.duplicatesSent > 0 ||
        current.faults.reorderedEvents > 0 ||
        current.faults.outageCount > 0) && (
        <div className="section grid grid--3">
          <Stat
            label="Duplicate events sent"
            value={count(current.faults.duplicatesSent)}
            tone="warn"
            hint="redelivered webhooks — the engine must ignore them"
          />
          <Stat
            label="Events reordered"
            value={count(current.faults.reorderedEvents)}
            tone="warn"
            hint="delivered after the event that followed them"
          />
          <Stat
            label="Outages entered"
            value={count(current.faults.outageCount)}
            tone={current.faults.outageCount > 0 ? 'danger' : undefined}
          />
        </div>
      )}

      <div className="split">
        <Card title="Failure injection">
          <div className="btn-row section">
            <button className="btn btn--sm" onClick={() => preset({
              answerRate: 0.65, noAnswerRate: 0.2, busyRate: 0.1, failureRate: 0.05,
              timeoutRate: 0, stuckRingingRate: 0, errorRate: 0, invalidNumberRate: 0,
              outageActive: false, latencySpikeMs: 0,
            })}>
              Reset to healthy
            </button>
            <button className="btn btn--sm btn--danger" onClick={() => preset({ timeoutRate: 1 })}>
              All calls go silent
            </button>
            <button className="btn btn--sm btn--danger" onClick={() => preset({ outageActive: true })}>
              Provider outage
            </button>
            <button className="btn btn--sm" onClick={() => preset({ busyRate: 0.8, answerRate: 0.1, noAnswerRate: 0.1, failureRate: 0 })}>
              High busy rate
            </button>
            <button className="btn btn--sm" onClick={() => preset({ latencySpikeMs: 5000 })}>
              Latency spike
            </button>
            <button className="btn btn--sm" onClick={() => preset({ stuckRingingRate: 0.5 })}>
              Half stuck ringing
            </button>
          </div>

          <div
            className="denial"
            style={{
              background: draft.outageActive ? 'var(--danger-dim)' : 'var(--surface-2)',
              borderColor: draft.outageActive ? 'var(--danger)' : 'var(--border)',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.outageActive}
                onChange={(e) => apply({ outageActive: e.target.checked })}
                style={{ width: 'auto' }}
              />
              <span>
                <strong>Provider outage</strong> — every createCall is rejected as transient, so
                contacts stay retriable rather than being burned.
              </span>
            </label>
          </div>

          {RATE_KNOBS.map((knob) => (
            <div key={knob.key} className="field">
              <label className="field__label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{knob.label}</span>
                <span className="mono">{percent(Number(draft[knob.key]), 0)}</span>
              </label>
              <input
                type="range"
                min={0}
                max={knob.max}
                step={knob.step}
                value={Number(draft[knob.key])}
                onChange={(e) => setDraft({ ...draft, [knob.key]: Number(e.target.value) })}
                onMouseUp={(e) => apply({ [knob.key]: Number((e.target as HTMLInputElement).value) })}
                onTouchEnd={(e) => apply({ [knob.key]: Number((e.target as HTMLInputElement).value) })}
                onKeyUp={(e) => apply({ [knob.key]: Number((e.target as HTMLInputElement).value) })}
              />
              <div className="field__hint">{knob.why}</div>
            </div>
          ))}
        </Card>

        <div>
          <Card title="Timing" className="section">
            <div className="field">
              <label className="field__label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Mean ring duration</span>
                <span className="mono">{duration(draft.meanRingDurationMs)}</span>
              </label>
              <input
                type="range" min={500} max={30_000} step={500}
                value={draft.meanRingDurationMs}
                onChange={(e) => setDraft({ ...draft, meanRingDurationMs: Number(e.target.value) })}
                onMouseUp={(e) => apply({ meanRingDurationMs: Number((e.target as HTMLInputElement).value) })}
              />
            </div>
            <div className="field">
              <label className="field__label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Mean call duration</span>
                <span className="mono">{duration(draft.meanCallDurationMs)}</span>
              </label>
              <input
                type="range" min={1000} max={120_000} step={1000}
                value={draft.meanCallDurationMs}
                onChange={(e) => setDraft({ ...draft, meanCallDurationMs: Number(e.target.value) })}
                onMouseUp={(e) => apply({ meanCallDurationMs: Number((e.target as HTMLInputElement).value) })}
              />
            </div>
            <div className="field">
              <label className="field__label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Latency spike</span>
                <span className="mono">{draft.latencySpikeMs}ms</span>
              </label>
              <input
                type="range" min={0} max={20_000} step={250}
                value={draft.latencySpikeMs}
                onChange={(e) => setDraft({ ...draft, latencySpikeMs: Number(e.target.value) })}
                onMouseUp={(e) => apply({ latencySpikeMs: Number((e.target as HTMLInputElement).value) })}
              />
              <div className="field__hint">
                Added to every accept. The insidious failure: everything still works, but slots
                are held longer.
              </div>
            </div>
          </Card>

          <Card title="What to try">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7 }}>
              <li>Start a campaign, then set <strong>Silence rate</strong> to 100%. Watch <span className="mono">call.timeout</span> appear in the event log ~45s of simulated time later, with slots and agents released.</li>
              <li>Trigger a <strong>provider outage</strong>. Contacts stay retriable rather than exhausting; clear it and the campaign recovers.</li>
              <li>Set <strong>Invalid number</strong> to 100%. Those are permanent — one attempt each, no retries, no wasted attempt budget.</li>
              <li>Push <strong>Latency spike</strong> to 5s and watch concurrency climb as slots are held longer.</li>
            </ol>
          </Card>
        </div>
      </div>

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
