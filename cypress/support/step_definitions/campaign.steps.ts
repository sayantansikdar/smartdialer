import { Given, Then, When } from '@badeball/cypress-cucumber-preprocessor';
import { api, eventually, type Campaign } from '../api.ts';
import { named } from '../names.ts';
import { campaignsPage, type CampaignControl, type DialingMode } from '../../pages/CampaignsPage.ts';
import { campaignDetailPage, type DetailControl } from '../../pages/CampaignDetailPage.ts';

/** The campaign the current scenario arranged, set by the "a ready … campaign" steps. */
const currentCampaign = (): Cypress.Chainable<Campaign> => cy.get<Campaign>('@campaign');

// ---------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------

Given(
  'a ready {string} campaign {string} with {int} agents and {int} contacts',
  (mode: DialingMode, name: string, agents: number, contacts: number) => {
    api.arrangeCampaign({ name: named(name), dialingMode: mode, agents, contacts }).as('campaign');
  },
);

Given(
  'a ready {string} campaign {string} with {int} agents and {int} contacts, {int} of them do-not-call',
  (mode: DialingMode, name: string, agents: number, contacts: number, doNotCall: number) => {
    api
      .arrangeCampaign({ name: named(name), dialingMode: mode, agents, contacts, doNotCall })
      .as('campaign');
    cy.wrap(doNotCall).as('doNotCallCount');
  },
);

Given('the campaign is running', () => {
  currentCampaign().then((campaign) => {
    api.campaignAction(campaign.id, 'start').its('status').should('equal', 'RUNNING');
  });
});

Given('I am on the campaigns page', () => {
  campaignsPage.open();
});

// ---------------------------------------------------------------------------
// Creating campaigns through the form
// ---------------------------------------------------------------------------

When('I create a {string} campaign named {string}', (mode: DialingMode, name: string) => {
  campaignsPage.openNewCampaignForm();
  campaignsPage.fillField('Name', named(name));
  campaignsPage.selectDialingMode(mode);
  campaignsPage.submitNewCampaign();
});

When('I start a new campaign named {string}', (name: string) => {
  campaignsPage.openNewCampaignForm();
  campaignsPage.fillField('Name', named(name));
});

When('I set the {string} field to {string}', (label: string, value: string) => {
  campaignsPage.fillField(label, value);
});

When('I submit the new campaign', () => {
  campaignsPage.submitNewCampaign();
});

Then('the {string} field shows the error {string}', (label: string, error: string) => {
  campaignsPage.fieldError(label).should('have.text', error);
});

Then('no campaign named {string} exists on the server', (name: string) => {
  api.campaigns().then((campaigns) => {
    expect(campaigns.map((c) => c.name)).not.to.include(named(name));
  });
});

When('a client posts a campaign with a max abandon rate of {float} straight to the API', (rate: number) => {
  api
    .createCampaign({
      name: named('Bypassed form'),
      dialingMode: 'PROGRESSIVE',
      maxConcurrentCalls: 8,
      maxCallsPerSecond: 4,
      maxAbandonRate: rate,
      maxAttemptsPerContact: 3,
    })
    .as('apiResponse');
});

Then('the API rejects it with status {int} and error code {string}', (status: number, code: string) => {
  cy.get<Cypress.Response<{ error: { code: string } }>>('@apiResponse').then((response) => {
    expect(response.status).to.equal(status);
    expect(response.body.error.code).to.equal(code);
  });
  api.campaigns().then((campaigns) => {
    expect(campaigns.map((c) => c.name)).not.to.include(named('Bypassed form'));
  });
});

// ---------------------------------------------------------------------------
// The campaign list
// ---------------------------------------------------------------------------

Then(
  'the campaign {string} is listed with status {string} and mode {string}',
  (name: string, status: string, mode: string) => {
    campaignsPage.status(named(name)).should('have.text', status);
    campaignsPage.mode(named(name)).should('have.text', mode);
  },
);

Then('the campaign {string} is listed with status {string}', (name: string, status: string) => {
  campaignsPage.status(named(name)).should('have.text', status);
});

Then('the campaign {string} eventually shows status {string}', (name: string, status: string) => {
  // A whole campaign has to play out on the paced clock, so this waits far longer than a
  // single control's round trip.
  campaignsPage.status(named(name)).should('have.text', status, { timeout: 90_000 });
});

Then('the server has the campaign {string} in status {string}', (name: string, status: string) => {
  api.campaigns().then((campaigns) => {
    const campaign = campaigns.find((c) => c.name === named(name));
    expect(campaign, `campaign "${named(name)}" on the server`).not.to.equal(undefined);
    expect(campaign?.status).to.equal(status);
  });
});

When('I press {string} for the campaign {string}', (control: CampaignControl, name: string) => {
  campaignsPage.control(named(name), control);
});

// ---------------------------------------------------------------------------
// The campaign detail page
// ---------------------------------------------------------------------------

When("I open the campaign's detail page", () => {
  currentCampaign().then((campaign) => {
    campaignDetailPage.open(campaign.id);
    campaignDetailPage.heading().should('contain.text', campaign.name);
  });
});

When('I press {string} on the campaign detail page', (control: DetailControl) => {
  campaignDetailPage.control(control);
});

Then('the campaign detail status is {string}', (status: string) => {
  campaignDetailPage.status().should('have.text', status);
});

Then('the pacing explanation shows the engine\'s request and the safety controller\'s verdict', () => {
  campaignDetailPage.pacingExplanation().within(() => {
    cy.contains(/Pacing engine requested\s*\d+/).should('be.visible');
    cy.contains(/Safety controller approved\s*\d+/).should('be.visible');
    cy.get('.badge').should('not.be.empty');
  });
  // Two blocks, deliberately: the pacer's arithmetic and the controller's decision.
  campaignDetailPage.pacingReasoning().should('have.length', 2).first().should('not.be.empty');
});

Then('the safety evaluation lists the denial {string}', (code: string) => {
  campaignDetailPage.safetyDenialCodes().should('contain.text', code);
});

// ---------------------------------------------------------------------------
// What the server actually did
// ---------------------------------------------------------------------------

Then('the server reports the campaign is {string}', (status: string) => {
  currentCampaign().then((campaign) => {
    api.campaign(campaign.id).its('status').should('equal', status);
  });
});

Then('new calls are being placed for the campaign', () => {
  currentCampaign().then((campaign) => {
    api.campaignMetrics(campaign.id).then(({ callsTotal: before }) => {
      eventually(
        () => api.campaignMetrics(campaign.id),
        (metrics) => metrics.callsTotal > before,
        `the campaign places a call beyond the ${before} it had`,
      );
    });
  });
});

Then('no new calls are placed for the campaign', () => {
  currentCampaign().then((campaign) => {
    // Let any dial that was already mid-request when the control took effect land first.
    cy.wait(500);
    api.campaignMetrics(campaign.id).then(({ callsTotal: before }) => {
      // 3 real seconds is a minute of simulated time at the e2e clock speed: an unpaused
      // campaign with free agents would place several calls in that window.
      cy.wait(3000);
      api.campaignMetrics(campaign.id).its('callsTotal').should('equal', before);
    });
  });
});

Then('the campaign has no calls in flight', () => {
  currentCampaign().then((campaign) => {
    eventually(
      () => api.campaignMetrics(campaign.id),
      (metrics) => metrics.callsActive === 0,
      'the stopped campaign has no active calls',
    );
  });
});

Then('no call was ever placed to a do-not-call contact', () => {
  currentCampaign().then((campaign) => {
    api.contacts(campaign.id).then((contacts) => {
      const doNotCall = new Set(contacts.filter((c) => c.status === 'DO_NOT_CALL').map((c) => c.id));
      expect(doNotCall.size, 'do-not-call contacts in the campaign').to.be.greaterThan(0);
      api.calls(campaign.id).then((calls) => {
        expect(calls.length, 'calls placed').to.be.greaterThan(0);
        const offending = calls.filter((call) => doNotCall.has(call.contactId));
        expect(offending, 'calls placed to do-not-call contacts').to.deep.equal([]);
      });
    });
  });
});

Then('every do-not-call contact is still marked {string}', (status: string) => {
  cy.get<number>('@doNotCallCount').then((expected) => {
    currentCampaign().then((campaign) => {
      api.campaignMetrics(campaign.id).its('contactsByStatus').its(status).should('equal', expected);
    });
  });
});
