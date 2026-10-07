import { BasePage, exactly } from './BasePage.ts';

export type DetailControl =
  | 'Mark ready'
  | 'Start'
  | 'Pause'
  | 'Resume'
  | 'Stop'
  | 'Resume predictive dialing'
  | 'Reset for replay';

export class CampaignDetailPage extends BasePage {
  open(campaignId: string): void {
    cy.visit(`/#/campaign/${campaignId}`);
  }

  heading(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.viewTitle();
  }

  status(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.viewTitle().find('.badge');
  }

  control(control: DetailControl): void {
    cy.contains('.toolbar .btn', exactly(control)).click();
  }

  /** The dialer's own pacing arithmetic: what the pacer requested and what safety approved. */
  pacingExplanation(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.card('Why this many calls?');
  }

  pacingReasoning(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.pacingExplanation().find('pre.reasoning');
  }

  /** Every safety rule currently denying this campaign a dial, by code. */
  safetyDenialCodes(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.card('Safety evaluation').find('.denial .mono');
  }
}

export const campaignDetailPage = new CampaignDetailPage();
