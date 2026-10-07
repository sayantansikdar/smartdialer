import { Given, Then, When } from '@badeball/cypress-cucumber-preprocessor';
import { simulationPage } from '../../pages/SimulationPage.ts';

type Report = Record<string, unknown>;

Given('I am on the simulation page', () => {
  simulationPage.open();
});

When('I run the {string} scenario', (scenario: string) => {
  simulationPage.runScenario(scenario);
});

When('I set the simulation {string} to {string}', (label: string, value: string) => {
  simulationPage.fillField(label, value);
});

/** Runs the custom simulation and keeps the server's report, so two runs can be compared. */
function runCustom(alias: string): void {
  cy.intercept('POST', '/api/simulation/start').as('simulation');
  simulationPage.runCustomSimulation();
  cy.wait('@simulation').its('response.body.report').as(alias);
}

When('I run the custom simulation', () => {
  runCustom('firstRun');
});

When('I run the custom simulation again', () => {
  runCustom('secondRun');
});

Then('the report verdict is {string}', (verdict: string) => {
  simulationPage.invariantVerdict().should('have.text', verdict);
});

Then('the report is for scenario {string}', (scenario: string) => {
  simulationPage.reportSubtitle().should('contain.text', `scenario "${scenario}"`);
});

Then('the report is for a custom run with seed {string}', (seed: string) => {
  simulationPage.reportSubtitle().should('have.text', `custom run · seed ${seed}`);
});

Then('the scenario demonstrated what it claims', () => {
  simulationPage.scenarioClaim().should('have.text', 'The scenario demonstrated what it claims.');
});

Then('both runs produced the same result', () => {
  // Wall-clock duration is the one field that legitimately differs between replays.
  const comparable = ({ realDurationMs: _ignored, ...rest }: Report): Report => rest;

  cy.get<Report>('@firstRun').then((first) => {
    cy.get<Report>('@secondRun').then((second) => {
      expect(first['totalAttempts'], 'the run placed calls').to.be.greaterThan(0);
      expect(comparable(second)).to.deep.equal(comparable(first));
    });
  });
});
