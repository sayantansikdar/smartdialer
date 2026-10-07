/**
 * Scenario-unique names.
 *
 * The e2e database lives for the whole run, so a campaign called "Q4 Win-back" created by
 * one scenario would still be listed when the next one looks for it. Features use readable
 * base names; every lookup goes through `named()`, which appends a token fresh for each
 * scenario.
 */
let token = '';

export function newScenarioToken(): void {
  token = crypto.randomUUID().slice(0, 6);
}

export function named(base: string): string {
  return `${base} ${token}`;
}
