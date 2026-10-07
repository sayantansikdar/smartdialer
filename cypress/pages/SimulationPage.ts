import { BasePage, exactly } from './BasePage.ts';

export class SimulationPage extends BasePage {
  open(): void {
    this.visit('simulation');
    this.viewTitle().should('have.text', 'Simulation');
  }

  scenarioRow(name: string): Cypress.Chainable<JQuery<HTMLTableRowElement>> {
    return cy.contains('td.mono', exactly(name)).parent('tr');
  }

  runScenario(name: string): void {
    this.scenarioRow(name).contains('button', exactly('Run')).click();
  }

  runCustomSimulation(): void {
    this.card('Custom simulation').contains('button', exactly('Run simulation')).click();
  }

  /** "INVARIANTS: PASSED" or "INVARIANTS: FAILED" — the headline of every report. */
  invariantVerdict(): Cypress.Chainable<JQuery<HTMLElement>> {
    // A run can take a few seconds server-side, so allow more than the default timeout.
    return cy.contains('.stat__value', 'INVARIANTS:', { timeout: 30_000 });
  }

  /** "custom run · seed 12345" or `scenario "dnc" · seed …`. */
  reportSubtitle(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.invariantVerdict().siblings('.stat__label');
  }

  /** Whether a predefined scenario demonstrated the behaviour it claims to. */
  scenarioClaim(): Cypress.Chainable<JQuery<HTMLDivElement>> {
    return cy.contains('div', /The scenario demonstrated what it claims\.|Did not demonstrate its claim/);
  }
}

export const simulationPage = new SimulationPage();
