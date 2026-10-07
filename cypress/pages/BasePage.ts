/**
 * The application shell every view shares: safety banner, masthead, navigation, toasts.
 *
 * Page objects are the only place in the suite that knows the dashboard's markup. Step
 * definitions talk in terms of what an operator does ("engage the emergency stop"), so a
 * markup change is fixed here once rather than in every step that touches it.
 */

/** Matches an element whose whole text is `text`, so "Resume" does not also hit "Resume predictive dialing". */
export function exactly(text: string): RegExp {
  return new RegExp(`^\\s*${Cypress._.escapeRegExp(text)}\\s*$`);
}

export type View =
  | 'dashboard'
  | 'campaigns'
  | 'contacts'
  | 'agents'
  | 'calls'
  | 'simulation'
  | 'provider'
  | 'events';

export class BasePage {
  visit(view: View = 'dashboard'): void {
    cy.visit(`/#/${view}`);
  }

  navigateTo(label: string): void {
    cy.contains('.nav__item', exactly(label)).click();
  }

  activeNavItem(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.nav__item--active');
  }

  viewTitle(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.view__title');
  }

  safetyBanner(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.safety-banner');
  }

  connectionStatus(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.connection');
  }

  emergencyStopButton(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('.masthead .btn', exactly('Emergency Stop'));
  }

  releaseEmergencyStopButton(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('.masthead .btn', exactly('Release Emergency Stop'));
  }

  emergencyStopBanner(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.estop-banner');
  }

  engageEmergencyStop(): void {
    this.emergencyStopButton().click();
  }

  releaseEmergencyStop(): void {
    this.releaseEmergencyStopButton().click();
  }

  errorToast(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get('.toast[role="alert"]');
  }

  /** A titled card on the current view, e.g. "Why this many calls?". */
  card(title: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('.card__title', exactly(title)).closest('.card');
  }

  /** The form field wrapper for a label: holds the input, its hint and its error. */
  field(label: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.contains('.field__label', exactly(label)).parent('.field');
  }

  fillField(label: string, value: string): void {
    this.field(label).find('input').clear();
    if (value !== '') this.field(label).find('input').type(value);
  }
}

export const shell = new BasePage();
