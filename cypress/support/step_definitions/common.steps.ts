import { Before, Given, Then, When } from '@badeball/cypress-cucumber-preprocessor';
import * as allure from 'allure-js-commons';
import { api } from '../api.ts';
import { newScenarioToken } from '../names.ts';
import { shell } from '../../pages/BasePage.ts';

Before(({ pickle, gherkinDocument }) => {
  newScenarioToken();
  api.resetSystem();

  // Carry the Gherkin structure into Allure, so its Behaviors tab groups scenarios by feature
  // and the @safety / @smoke / @api tags can be filtered on in the report.
  const tags = pickle.tags.map((tag) => tag.name.replace(/^@/, ''));
  void allure.epic('SmartDialer dashboard');
  void allure.feature(gherkinDocument.feature?.name ?? 'Unnamed feature');
  void allure.story(pickle.name);
  void allure.tags(...tags);
  // A broken do-not-call guard or emergency stop is a different class of defect from a
  // mislabelled navigation item; severity lets the report rank failures accordingly.
  void allure.severity(tags.includes('safety') ? 'critical' : tags.includes('smoke') ? 'normal' : 'minor');
});

Given('I open the dashboard', () => {
  shell.visit('dashboard');
  shell.viewTitle().should('have.text', 'Dashboard');
});

When('I navigate to {string}', (label: string) => {
  shell.navigateTo(label);
});

Then('the view title contains {string}', (title: string) => {
  shell.viewTitle().should('contain.text', title);
});

Then('{string} is the active navigation item', (label: string) => {
  shell.activeNavItem().should('have.text', label);
});

Then('the safety banner says {string}', (text: string) => {
  shell.safetyBanner().should('be.visible').and('contain.text', text);
});

Then('the connection indicator shows {string}', (state: string) => {
  shell.connectionStatus().should('have.text', state);
});

Then('the browser console has no errors', () => {
  cy.get('@consoleError').should('not.have.been.called');
});

Then('the system invariants still hold', () => {
  api.invariants().then((result) => {
    expect(result.violations, 'invariant violations').to.deep.equal([]);
    expect(result.passed).to.equal(true);
  });
});
