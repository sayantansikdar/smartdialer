import { defineConfig } from 'cypress';
import createBundler from '@bahmutov/cypress-esbuild-preprocessor';
import { addCucumberPreprocessorPlugin } from '@badeball/cypress-cucumber-preprocessor';
import { createEsbuildPlugin } from '@badeball/cypress-cucumber-preprocessor/esbuild';
import { allureCypress } from 'allure-cypress/reporter';
import cypressOnFix from 'cypress-on-fix';

/**
 * Browser end-to-end tests: Gherkin features, step definitions, page objects.
 *
 * Run through `npm run e2e`, which boots an isolated API and dashboard first and points
 * `baseUrl` at them via CYPRESS_BASE_URL. Running `cypress` directly against a developer's
 * `npm run dev` stack works too, but the scenarios will start campaigns in that database.
 */
export default defineConfig({
  // Nothing here reads Cypress.env(); tag filters and other values go through `--expose`.
  allowCypressEnv: false,
  e2e: {
    baseUrl: 'http://127.0.0.1:5174',
    specPattern: 'cypress/e2e/**/*.feature',
    supportFile: 'cypress/support/e2e.ts',
    viewportWidth: 1440,
    viewportHeight: 900,
    // The dashboard polls every 1–2s and the dialer runs on a paced clock, so state the UI
    // reflects can legitimately lag the click that caused it by a couple of polls.
    defaultCommandTimeout: 10_000,
    video: false,
    // scripts/e2e.mjs clears old screenshots itself. Cypress's own clean-up shells out to a helper
    // binary that fails on Apple Silicon without Rosetta (spawn error -86).
    trashAssetsBeforeRuns: false,
    screenshotOnRunFailure: true,
    async setupNodeEvents(cypressOn, config) {
      // Cypress keeps only the last handler registered for each event, and both the Cucumber
      // preprocessor and Allure listen to `after:spec` / `after:run`. cypress-on-fix lets them
      // share the events instead of one silently disabling the other's report.
      const on = cypressOnFix(cypressOn);
      await addCucumberPreprocessorPlugin(on, config);
      on('file:preprocessor', createBundler({ plugins: [createEsbuildPlugin(config)] }));
      allureCypress(on, config, {
        resultsDir: 'allure-results',
        environmentInfo: {
          Application: 'SmartDialer dashboard (simulation mode, mock provider)',
          'Base URL': config.baseUrl ?? '',
          Node: process.version,
        },
      });
      return config;
    },
  },
});
