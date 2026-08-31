/**
 * Phone-number redaction.
 *
 * Even in a prototype using fictional numbers, logs are the wrong place for full
 * destination numbers: the habit is what carries into a real system, and a log file
 * outlives the process that wrote it (CONSTRAINTS.md, security).
 *
 * Only the last two digits survive, plus a leading `+` if there was one. That is
 * deliberately not enough to identify anyone — correlation across log lines is done with
 * `contactId` and `callId`, which every line already carries, so the number itself never
 * needs to be readable. The unredacted value stays in the database, where it is required.
 */

export function redactPhoneNumber(phoneNumber: string): string {
  const trimmed = phoneNumber.trim();
  if (trimmed === '') return '';

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return '*'.repeat(trimmed.length);
  if (digits.length <= 2) return '*'.repeat(digits.length);

  const plus = trimmed.startsWith('+') ? '+' : '';
  return `${plus}${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}
