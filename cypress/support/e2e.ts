import 'allure-cypress';

/**
 * Runs before every feature file.
 *
 * Spies on the page's console so a scenario can assert the dashboard logged no errors —
 * React reporting a failed render to the console while the page still looks fine is exactly
 * the kind of defect a screenshot-only check misses.
 */
Cypress.on('window:before:load', (win) => {
  cy.spy(win.console, 'error').as('consoleError');
});
