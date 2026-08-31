/**
 * Shared presentational pieces.
 *
 * Small and unopinionated on purpose — they exist so that a stat tile or a status badge looks
 * the same in nine views, not to build a component framework.
 */

import type { ReactNode } from 'react';
import { statusTone } from '../lib/format.ts';

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`card ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="card__header">
          {title !== undefined && <h3 className="card__title">{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger' | 'info';
}): React.JSX.Element {
  return (
    <div className={`card ${tone === undefined ? '' : `stat--${tone}`}`}>
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
      {hint !== undefined && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function Badge({ status }: { status: string }): React.JSX.Element {
  return <span className={`badge badge--${statusTone(status)}`}>{status}</span>;
}

/**
 * A labelled proportion bar.
 *
 * `danger` above the threshold rather than at a fixed level, because "80% of capacity" means
 * something different for concurrency (fine) than for abandon rate (not fine).
 */
export function Meter({
  value,
  max,
  tone = 'info',
}: {
  value: number;
  max: number;
  tone?: 'ok' | 'warn' | 'danger' | 'info';
}): React.JSX.Element {
  const pct = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="meter">
      <div className={`meter__fill meter__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="empty">{children}</div>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {children}
      {hint !== undefined && error === undefined && <div className="field__hint">{hint}</div>}
      {error !== undefined && <div className="field__error">{error}</div>}
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }): React.JSX.Element {
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
