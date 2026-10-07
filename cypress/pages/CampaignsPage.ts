import { BasePage, exactly } from './BasePage.ts';

export type DialingMode = 'PROGRESSIVE' | 'PREDICTIVE';
export type CampaignControl = 'Mark ready' | 'Start' | 'Pause' | 'Resume' | 'Stop' | 'Reset' | 'Detail';

export class CampaignsPage extends BasePage {
  open(): void {
    this.visit('campaigns');
    this.viewTitle().should('have.text', 'Campaigns');
  }

  openNewCampaignForm(): void {
    cy.contains('.toolbar .btn', exactly('New campaign')).click();
    this.card('New campaign').should('be.visible');
  }

  selectDialingMode(mode: DialingMode): void {
    this.field('Dialing mode').find('select').select(mode);
  }

  submitNewCampaign(): void {
    cy.contains('.btn', exactly('Create campaign')).click();
  }

  fieldError(label: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.field(label).find('.field__error');
  }

  row(name: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('tbody tr', name);
  }

  status(name: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.row(name).find('.badge');
  }

  mode(name: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.row(name).find('td.mono');
  }

  control(name: string, control: CampaignControl): void {
    this.row(name).contains('button', exactly(control)).click();
  }

  openDetail(name: string): void {
    this.row(name).contains('a', name).click();
  }
}

export const campaignsPage = new CampaignsPage();
