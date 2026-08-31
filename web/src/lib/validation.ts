/**
 * Client-side form validation.
 *
 * Extracted from the view because it is domain logic, not presentation: these are the same
 * bounds the server's zod schemas enforce, for the same reasons. Living in a component made
 * it untestable and made the duplication with the server invisible.
 *
 * To be clear about what this is for — it is a **convenience, never the guarantee**. The
 * server rejects an unsafe configuration regardless of what the browser sends, and the API
 * tests are what prove it. This exists so an operator learns about a bad value while typing
 * rather than after submitting.
 */

export interface CampaignFormValues {
  name: string;
  dialingMode: string;
  maxConcurrentCalls: string;
  maxCallsPerSecond: string;
  maxAbandonRate: string;
  maxAttemptsPerContact: string;
}

export type CampaignFormErrors = Partial<Record<keyof CampaignFormValues, string>>;

/** Mirrors `createCampaignSchema` in `src/api/schemas.ts`. */
export function validateCampaignForm(form: CampaignFormValues): CampaignFormErrors {
  const errors: CampaignFormErrors = {};

  if (form.name.trim() === '') errors.name = 'Required.';
  else if (form.name.trim().length > 200) errors.name = 'At most 200 characters.';

  const concurrency = Number(form.maxConcurrentCalls);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    errors.maxConcurrentCalls = 'Must be a whole number of at least 1.';
  } else if (concurrency > 1000) {
    errors.maxConcurrentCalls = 'At most 1000.';
  }

  const cps = Number(form.maxCallsPerSecond);
  if (!Number.isFinite(cps) || cps <= 0) {
    errors.maxCallsPerSecond = 'Must be greater than 0.';
  } else if (cps > 1000) {
    errors.maxCallsPerSecond = 'At most 1000 per second.';
  }

  // A proportion, not a percentage. Entering "3" meaning 3% would silently permit a 300%
  // abandon rate — which is why the bound is checked rather than clamped.
  const abandon = Number(form.maxAbandonRate);
  if (!Number.isFinite(abandon) || abandon < 0 || abandon > 1) {
    errors.maxAbandonRate = 'A proportion between 0 and 1 (0.03 = 3%).';
  }

  const attempts = Number(form.maxAttemptsPerContact);
  if (!Number.isInteger(attempts) || attempts < 1) {
    errors.maxAttemptsPerContact = 'At least 1 — zero attempts would never dial.';
  } else if (attempts > 20) {
    errors.maxAttemptsPerContact = 'At most 20.';
  }

  return errors;
}

export function isValid(errors: CampaignFormErrors): boolean {
  return Object.keys(errors).length === 0;
}
