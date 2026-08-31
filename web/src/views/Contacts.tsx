/**
 * Contact search and attempt history.
 *
 * The attempt history is the point: one contact with four rows — no answer, busy, timeout,
 * connected — is the reason attempts are modelled separately from contacts. If the outcome
 * lived on the contact, each attempt would overwrite the last and this panel could not exist.
 */

import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolled, useAction } from '../lib/hooks.ts';
import { count, duration, redactPhone, virtualTime } from '../lib/format.ts';
import { Badge, Card, Empty } from '../components/ui.tsx';
import type { CallAttempt, Contact } from '../lib/types.ts';

const STATUSES = [
  'READY', 'RESERVED', 'DIALING', 'RINGING', 'CONNECTED', 'NO_ANSWER', 'BUSY',
  'FAILED', 'COMPLETED', 'RETRY_PENDING', 'EXHAUSTED', 'DO_NOT_CALL',
];

export function ContactsView(): React.JSX.Element {
  const campaigns = usePolled(() => api.campaigns(), 10_000);
  const [campaignId, setCampaignId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [attempts, setAttempts] = useState<CallAttempt[]>([]);
  const action = useAction();

  const contacts = usePolled(
    () => api.contacts({ campaignId: campaignId || undefined, status: status || undefined, query: search || undefined, limit: 200 }),
    3000,
    [campaignId, status, search],
  );

  const open = (contact: Contact): void => {
    setSelected(contact);
    void api.contact(contact.id).then((result) => setAttempts(result.attempts)).catch(() => setAttempts([]));
  };

  const markDnc = (contact: Contact): void => {
    void action.run(() => api.markDoNotCall(contact.id), () => {
      contacts.reload();
      if (selected?.id === contact.id) open(contact);
    });
  };

  return (
    <div>
      <div className="view__header">
        <h1 className="view__title">Contacts</h1>
        <p className="view__subtitle">
          Numbers are shown redacted, exactly as they are logged — the dashboard is where the
          habit forms. All sample data uses the reserved fictional <span className="mono">+1-555-01xx</span> block.
        </p>
      </div>

      <div className="toolbar">
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          <option value="">All campaigns</option>
          {campaigns.data?.campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          placeholder="Search name or number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search contacts"
          style={{ minWidth: 220 }}
        />
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {count(contacts.data?.contacts.length ?? 0)} shown
        </span>
      </div>

      <div className="split">
        <Card>
          {contacts.data === null ? (
            <Empty>Loading…</Empty>
          ) : contacts.data.contacts.length === 0 ? (
            <Empty>No contacts match.</Empty>
          ) : (
            <div className="table-wrap scroll-y">
              <table>
                <thead>
                  <tr>
                    <th>Name</th><th>Number</th><th>Status</th>
                    <th className="num">Attempts</th><th>Next attempt</th><th />
                  </tr>
                </thead>
                <tbody>
                  {contacts.data.contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td>{contact.name}</td>
                      <td className="mono">{redactPhone(contact.phoneNumber)}</td>
                      <td><Badge status={contact.status} /></td>
                      <td className="num">{contact.attemptCount}</td>
                      <td className="mono">
                        {contact.nextAttemptAt === null ? '—' : virtualTime(contact.nextAttemptAt)}
                      </td>
                      <td>
                        <div className="btn-row">
                          <button className="btn btn--sm" onClick={() => open(contact)}>Attempts</button>
                          {contact.status !== 'DO_NOT_CALL' && (
                            <button className="btn btn--sm btn--danger" onClick={() => markDnc(contact)}>
                              DNC
                            </button>
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

        <Card title={selected === null ? 'Attempt history' : `Attempts — ${selected.name}`}>
          {selected === null ? (
            <Empty>Select a contact to see every attempt made to reach them.</Empty>
          ) : attempts.length === 0 ? (
            <Empty>No attempts yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th className="num">#</th><th>Outcome</th><th>Class</th><th className="num">Duration</th></tr>
                </thead>
                <tbody>
                  {attempts.map((attempt) => (
                    <tr key={attempt.id}>
                      <td className="num">{attempt.attemptNumber}</td>
                      <td>{attempt.outcome === null ? <Badge status="DIALING" /> : <Badge status={attempt.outcome} />}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{attempt.failureClass}</td>
                      <td className="num">
                        {duration(attempt.endedAt === null ? null : attempt.endedAt - attempt.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selected.status === 'DO_NOT_CALL' && (
                <div className="denial" style={{ marginTop: 10 }}>
                  <span>
                    Marked <strong>DO_NOT_CALL</strong>. This is a one-way door — there is no API
                    to undo it, deliberately.
                  </span>
                </div>
              )}
            </div>
          )}
        </Card>
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
