/**
 * Configure and run simulations.
 *
 * Each run builds its own isolated engine — its own in-memory database, clock, RNG and
 * provider — so running a chaos scenario from this page cannot disturb the live campaigns
 * shown elsewhere in the dashboard.
 *
 * The seed field is the interesting one: the same seed and configuration replay identically,
 * which is what makes a surprising result reproducible enough to debug.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { count, duration, percent } from '../lib/format.ts';
import { Card, Empty, Field, Stat } from '../components/ui.tsx';
import type { SimulationReport } from '../lib/types.ts';

export function SimulationView(): React.JSX.Element {
  const scenarios = usePolled(() => api.scenarios(), 0);
  const action = useAction();

  const [report, setReport] = useState<SimulationReport | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [ranScenario, setRanScenario] = useState<string | null>(null);

  const [form, setForm] = useState({
    contacts: '100',
    agents: '10',
    dialingMode: 'PREDICTIVE',
    seed: '12345',
    maxConcurrentCalls: '20',
    callsPerSecond: '10',
    maxAttempts: '3',
    dncContacts: '5',
    answerRate: '0.65',
    noAnswerRate: '0.2',
    busyRate: '0.1',
    failureRate: '0.05',
    timeoutRate: '0',
  });

  const set = (key: keyof typeof form, value: string): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const runCustom = (): void => {
    setProblems([]);
    setRanScenario(null);
    void action.run(
      () =>
        api
          .runSimulation({
            scenario: 'dashboard',
            contacts: Number(form.contacts),
            agents: Number(form.agents),
            dialingMode: form.dialingMode,
            seed: Number(form.seed),
            maxConcurrentCalls: Number(form.maxConcurrentCalls),
            callsPerSecond: Number(form.callsPerSecond),
            maxAttempts: Number(form.maxAttempts),
            dncContacts: Number(form.dncContacts),
            provider: {
              answerRate: Number(form.answerRate),
              noAnswerRate: Number(form.noAnswerRate),
              busyRate: Number(form.busyRate),
              failureRate: Number(form.failureRate),
              timeoutRate: Number(form.timeoutRate),
            },
          })
          .then((result) => setReport(result.report)),
    );
  };

  const runScenario = (name: string): void => {
    void action.run(() =>
      api.runScenario(name).then((result) => {
        setReport(result.report);
        setProblems(result.problems);
        setRanScenario(result.scenario);
      }),
    );
  };

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Simulation</h1>
        <p className="view__subtitle">
          Run a whole campaign in milliseconds. Each run is isolated from the live system, and
          the same seed replays identically — so a surprising result can be reproduced exactly.
        </p>
      </div>

      <div className="split">
        <div>
          <Card title="Predefined scenarios" className="section">
            {scenarios.data === null ? (
              <Empty>Loading…</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {scenarios.data.scenarios.map((scenario) => (
                      <tr key={scenario.name}>
                        <td style={{ width: '25%' }} className="mono">{scenario.name}</td>
                        <td style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>{scenario.demonstrates}</td>
                        <td style={{ width: 80 }}>
                          <button
                            className="btn btn--sm btn--primary"
                            onClick={() => runScenario(scenario.name)}
                            disabled={action.pending}
                          >
                            Run
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Custom simulation">
            <div className="form-grid">
              <Field label="Contacts"><input value={form.contacts} onChange={(e) => set('contacts', e.target.value)} /></Field>
              <Field label="Agents" hint="predictive over-dials safely only with a large team">
                <input value={form.agents} onChange={(e) => set('agents', e.target.value)} />
              </Field>
              <Field label="Mode">
                <select value={form.dialingMode} onChange={(e) => set('dialingMode', e.target.value)}>
                  <option value="PROGRESSIVE">Progressive</option>
                  <option value="PREDICTIVE">Predictive</option>
                </select>
              </Field>
              <Field label="Seed" hint="same seed ⇒ identical run">
                <input value={form.seed} onChange={(e) => set('seed', e.target.value)} />
              </Field>
              <Field label="Max concurrent"><input value={form.maxConcurrentCalls} onChange={(e) => set('maxConcurrentCalls', e.target.value)} /></Field>
              <Field label="Calls / second"><input value={form.callsPerSecond} onChange={(e) => set('callsPerSecond', e.target.value)} /></Field>
              <Field label="Max attempts"><input value={form.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} /></Field>
              <Field label="DNC contacts" hint="never dialled — proves the protection"><input value={form.dncContacts} onChange={(e) => set('dncContacts', e.target.value)} /></Field>
            </div>

            <h4 className="card__title" style={{ marginTop: 10 }}>Provider behaviour</h4>
            <div className="form-grid">
              <Field label="Answer rate"><input value={form.answerRate} onChange={(e) => set('answerRate', e.target.value)} /></Field>
              <Field label="No-answer rate"><input value={form.noAnswerRate} onChange={(e) => set('noAnswerRate', e.target.value)} /></Field>
              <Field label="Busy rate"><input value={form.busyRate} onChange={(e) => set('busyRate', e.target.value)} /></Field>
              <Field label="Failure rate"><input value={form.failureRate} onChange={(e) => set('failureRate', e.target.value)} /></Field>
              <Field label="Timeout rate" hint="provider goes silent; the watchdog must catch it">
                <input value={form.timeoutRate} onChange={(e) => set('timeoutRate', e.target.value)} />
              </Field>
            </div>

            <button className="btn btn--primary" onClick={runCustom} disabled={action.pending}>
              {action.pending ? 'Running…' : 'Run simulation'}
            </button>
          </Card>
        </div>

        <div>
          {report === null ? (
            <Card title="Report">
              <Empty>Run a scenario or a custom simulation to see its report.</Empty>
            </Card>
          ) : (
            <>
              {/*
                The verdict first. A report whose headline is a statistic rather than
                "did it break a rule it must never break" buries the only line that matters.
              */}
              <Card className="section">
                <div className={`stat__value ${report.invariantsPassed ? '' : ''}`}
                  style={{ color: report.invariantsPassed ? 'var(--ok)' : 'var(--danger)' }}>
                  INVARIANTS: {report.invariantsPassed ? 'PASSED' : 'FAILED'}
                </div>
                <div className="stat__label">
                  {ranScenario === null ? 'custom run' : `scenario "${ranScenario}"`} · seed {report.seed}
                </div>
                {!report.invariantsPassed && (
                  <ul style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12.5, paddingLeft: 18 }}>
                    {report.invariantViolations.map((violation, index) => (
                      <li key={index}><strong>{violation.invariant}</strong> — {violation.detail}</li>
                    ))}
                  </ul>
                )}
                {ranScenario !== null && (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: problems.length === 0 ? 'var(--ok)' : 'var(--warn)' }}>
                    {problems.length === 0
                      ? 'The scenario demonstrated what it claims.'
                      : `Did not demonstrate its claim: ${problems.join('; ')}`}
                  </div>
                )}
              </Card>

              <div className="section grid grid--2">
                <Stat label="Attempts" value={count(report.totalAttempts)} hint={`${report.totalContacts} contacts`} />
                <Stat label="Connected" value={count(report.successfulConnections)} tone="ok" />
                <Stat
                  label="Abandoned"
                  value={count(report.abandoned)}
                  tone={report.abandoned > 0 ? 'danger' : 'ok'}
                  hint={percent(report.abandonRate)}
                />
                <Stat label="Peak concurrency" value={report.peakConcurrency} hint={`avg ${report.averageConcurrency.toFixed(1)}`} />
              </div>

              <Card title="Full report">
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {([
                        ['Answer rate', percent(report.answerRate)],
                        ['No answers', count(report.noAnswers)],
                        ['Busy', count(report.busy)],
                        ['Failures', count(report.failures)],
                        ['Timeouts', count(report.timeouts)],
                        ['Cancelled', count(report.cancelled)],
                        ['Retries scheduled', count(report.retries)],
                        ['Avg attempts / contact', report.averageAttemptsPerContact.toFixed(2)],
                        ['Avg call duration', duration(report.averageCallDurationMs)],
                        ['Agent utilisation', percent(report.agentUtilization)],
                        ['Provider error rate', percent(report.providerErrorRate)],
                        ['Safety interventions', count(report.safetyInterventions)],
                        ['Capacity backpressure', count(report.capacityBackpressure)],
                        ['Simulated duration', duration(report.virtualDurationMs)],
                        ['Real duration', `${report.realDurationMs}ms`],
                        ['Events recorded', count(report.totalEvents)],
                        ['Stop reason', report.stopReason],
                      ] as Array<[string, string]>).map(([label, value]) => (
                        <tr key={label}>
                          <td style={{ color: 'var(--text-dim)' }}>{label}</td>
                          <td className="num">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-faint)' }}>
                  <strong>Safety interventions</strong> counts genuine protective action — a DNC
                  block, an attempt limit, the emergency stop. <strong>Capacity backpressure</strong>{' '}
                  counts the dialer being told there is no room right now, which is ordinary
                  operation rather than something going wrong.
                </div>
              </Card>
            </>
          )}
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
