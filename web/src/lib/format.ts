/**
 * Display formatting.
 *
 * Every timestamp in this system is *virtual* milliseconds since the run's epoch, not wall
 * clock. Rendering them as clock times would be a lie — at 10x speed the dashboard's "now"
 * has nothing to do with the viewer's. So durations are shown as elapsed simulated time,
 * which is what an operator watching a simulation actually needs.
 */

export function virtualTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function duration(ms: number | null): string {
  if (ms === null || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Phone numbers are shown redacted, matching how they are logged.
 *
 * These are fictional `+1-555-01xx` numbers so nothing could leak — but the dashboard is the
 * place a habit forms, and a real deployment's screen is as visible as its logs.
 */
export function redactPhone(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length <= 2) return '*'.repeat(digits.length);
  const plus = phoneNumber.trim().startsWith('+') ? '+' : '';
  return `${plus}${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'muted';

/** Status → badge tone. Colour is never the only signal: the label is always present too. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'RUNNING': case 'AVAILABLE': case 'COMPLETED': case 'ANSWERED': case 'CONNECTED':
    case 'ENDED': case 'READY':
      return 'ok';
    case 'PAUSED': case 'RETRY_PENDING': case 'WRAP_UP': case 'NO_ANSWER': case 'BUSY':
    case 'RINGING':
      return 'warn';
    case 'FAILED': case 'TIMEOUT': case 'DO_NOT_CALL': case 'CANCELLED': case 'ABANDONED':
      return 'danger';
    case 'DIALING': case 'ON_CALL': case 'RESERVED': case 'QUEUED': case 'CREATED':
      return 'info';
    case 'DRAFT': case 'STOPPED': case 'OFFLINE': case 'EXHAUSTED':
      return 'muted';
    default:
      return 'muted';
  }
}
