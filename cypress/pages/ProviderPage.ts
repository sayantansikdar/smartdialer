import { BasePage, exactly } from './BasePage.ts';

export type FaultPreset =
  | 'Reset to healthy'
  | 'All calls go silent'
  | 'Provider outage'
  | 'High busy rate'
  | 'Latency spike'
  | 'Half stuck ringing';

export class ProviderPage extends BasePage {
  open(): void {
    this.visit('provider');
    this.viewTitle().should('contain.text', 'Provider');
  }

  applyPreset(preset: FaultPreset): void {
    this.card('Failure injection').contains('.btn', exactly(preset)).click();
  }

  /** The live percentage shown beside a rate slider, e.g. "Silence rate" → "100%". */
  rateReading(label: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('.field__label span', exactly(label)).siblings('.mono');
  }
}

export const providerPage = new ProviderPage();
