import { Given, Then, When } from '@badeball/cypress-cucumber-preprocessor';
import { api, eventually, type Campaign } from '../api.ts';
import { shell } from '../../pages/BasePage.ts';
import { providerPage, type FaultPreset } from '../../pages/ProviderPage.ts';

// ---------------------------------------------------------------------------
// Emergency stop
// ---------------------------------------------------------------------------

When('I engage the emergency stop', () => {
  shell.engageEmergencyStop();
});

Given('the emergency stop has been engaged', () => {
  cy.request('POST', '/api/system/emergency-stop', { reason: 'Engaged by the e2e suite' });
});

When('I release the emergency stop', () => {
  shell.releaseEmergencyStop();
});

Then('the emergency stop banner is shown', () => {
  shell.emergencyStopBanner().should('be.visible').and('contain.text', 'EMERGENCY STOP ENGAGED');
  shell.releaseEmergencyStopButton().should('be.visible');
});

Then('the emergency stop banner is gone', () => {
  shell.emergencyStopBanner().should('not.exist');
  shell.emergencyStopButton().should('be.visible');
});

Then('the server reports the emergency stop is {word}', (state: 'engaged' | 'released') => {
  api.systemStatus().its('emergencyStopped').should('equal', state === 'engaged');
});

// ---------------------------------------------------------------------------
// Provider failure injection
// ---------------------------------------------------------------------------

Given('I am on the provider page', () => {
  providerPage.open();
});

When('I apply the {string} fault', (preset: FaultPreset) => {
  providerPage.applyPreset(preset);
});

Then('the {string} control reads {string}', (label: string, reading: string) => {
  providerPage.rateReading(label).should('have.text', reading);
});

Then('the live provider reports {string} as {string}', (key: string, expected: string) => {
  eventually(
    () => api.providerConfig(),
    (config) => String(config[key]) === expected,
    `the live provider's ${key} is ${expected}`,
  );
});

Then('the watchdog times out silent calls for the campaign', () => {
  cy.get<Campaign>('@campaign').then((campaign) => {
    // The provider watchdog fires 45s of simulated time after a call goes silent.
    eventually(
      () => api.events({ types: 'call.timeout', campaignId: campaign.id }),
      (events) => events.length > 0,
      'a call.timeout event is recorded for the campaign',
    );
  });
});
