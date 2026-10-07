/**
 * Direct API access for arranging test data and for checking server state.
 *
 * Scenarios *act* through the browser, but they arrange through the API and they assert
 * against both. Arranging through the UI would make every scenario re-test campaign
 * creation; asserting only against the UI would let a control that changes the screen but
 * not the server pass (TEST_CHECKLIST.md, "Dashboard verification"). Requests go through
 * the dashboard's own `/api` proxy, so there is exactly one base URL to configure.
 */

export const PROVIDER_ID = 'mock-provider';

export interface Campaign {
  id: string;
  name: string;
  status: string;
  dialingMode: 'PROGRESSIVE' | 'PREDICTIVE';
  predictivePausedReason: string | null;
}

export interface CampaignMetrics {
  callsTotal: number;
  callsActive: number;
  contactsByStatus: Record<string, number>;
}

export interface Contact {
  id: string;
  status: string;
}

export interface Call {
  id: string;
  contactId: string;
  status: string;
}

export interface SmartDialerEvent {
  type: string;
  campaignId?: string;
}

export interface CampaignSetup {
  name: string;
  dialingMode?: 'PROGRESSIVE' | 'PREDICTIVE';
  agents: number;
  contacts: number;
  doNotCall?: number;
}

/** The provider exactly as the mock ships, including timings a fault preset may have changed. */
export const HEALTHY_PROVIDER = {
  answerRate: 0.65,
  noAnswerRate: 0.2,
  busyRate: 0.1,
  failureRate: 0.05,
  timeoutRate: 0,
  stuckRingingRate: 0,
  errorRate: 0,
  invalidNumberRate: 0,
  meanRingDurationMs: 4000,
  meanCallDurationMs: 25_000,
  latencySpikeMs: 0,
  outageActive: false,
} as const;

/** Every number is inside the reserved fictional +1-555-01xx block the API insists on. */
const fictionalNumber = (index: number): string => `+155501${String(index % 100).padStart(2, '0')}`;

export const api = {
  campaigns: (): Cypress.Chainable<Campaign[]> =>
    cy.request('/api/campaigns').its('body.campaigns'),

  campaign: (id: string): Cypress.Chainable<Campaign> =>
    cy.request(`/api/campaigns/${id}`).its('body.campaign'),

  campaignMetrics: (id: string): Cypress.Chainable<CampaignMetrics> =>
    cy.request(`/api/campaigns/${id}/metrics`).its('body.campaign'),

  campaignAction: (id: string, action: 'start' | 'pause' | 'resume' | 'stop'): Cypress.Chainable<Campaign> =>
    cy.request('POST', `/api/campaigns/${id}/${action}`).its('body.campaign'),

  createCampaign: (body: Record<string, unknown>): Cypress.Chainable<Cypress.Response<unknown>> =>
    cy.request({ method: 'POST', url: '/api/campaigns', body, failOnStatusCode: false }),

  contacts: (campaignId: string): Cypress.Chainable<Contact[]> =>
    cy.request(`/api/contacts?campaignId=${campaignId}&limit=1000`).its('body.contacts'),

  calls: (campaignId: string): Cypress.Chainable<Call[]> =>
    cy.request(`/api/calls?campaignId=${campaignId}&limit=1000`).its('body.calls'),

  events: (filter: { types: string; campaignId: string }): Cypress.Chainable<SmartDialerEvent[]> =>
    cy
      .request(`/api/events?types=${filter.types}&campaignId=${filter.campaignId}&limit=2000`)
      .its('body.events'),

  systemStatus: (): Cypress.Chainable<{ emergencyStopped: boolean; reason: string | null }> =>
    cy.request('/api/system/status').its('body.system'),

  invariants: (): Cypress.Chainable<{ passed: boolean; violations: Array<{ invariant: string; detail: string }> }> =>
    cy.request('/api/system/invariants').its('body'),

  providerConfig: (): Cypress.Chainable<Record<string, number | boolean>> =>
    cy.request(`/api/providers/${PROVIDER_ID}`).its('body.config'),

  /**
   * A ready-to-start campaign with its own agents and contacts.
   *
   * Each scenario builds its own rather than sharing seeded ones, so no scenario's outcome
   * depends on which scenarios ran before it or what they left behind.
   */
  arrangeCampaign: (setup: CampaignSetup): Cypress.Chainable<Campaign> =>
    cy
      .request('POST', '/api/campaigns', {
        name: setup.name,
        dialingMode: setup.dialingMode ?? 'PROGRESSIVE',
        maxConcurrentCalls: 10,
        maxCallsPerSecond: 5,
        maxAbandonRate: 0.03,
        maxAttemptsPerContact: 3,
      })
      .its('body.campaign')
      .then((campaign: Campaign) => {
        for (let i = 0; i < setup.agents; i += 1) {
          cy.request('POST', '/api/agents', {
            campaignId: campaign.id,
            name: `E2E agent ${i + 1}`,
            online: true,
          });
        }
        cy.request('POST', '/api/contacts/import', {
          campaignId: campaign.id,
          contacts: Array.from({ length: setup.contacts }, (_, i) => ({
            name: `E2E contact ${i + 1}`,
            phoneNumber: fictionalNumber(i),
          })),
        })
          .its('body.contacts')
          .then((contacts: Contact[]) => {
            for (const contact of contacts.slice(0, setup.doNotCall ?? 0)) {
              cy.request('POST', `/api/contacts/${contact.id}/do-not-call`);
            }
          });
        cy.request('POST', `/api/campaigns/${campaign.id}/ready`);
        return api.campaign(campaign.id);
      }),

  /**
   * Put the shared parts of the system back to a known state before each scenario.
   *
   * The database persists for the whole run, so a scenario that engaged the emergency stop,
   * broke the provider or left a campaign dialing would otherwise leak into the next one.
   */
  resetSystem: (): void => {
    cy.request('POST', '/api/system/emergency-resume');
    cy.request('POST', `/api/providers/${PROVIDER_ID}/config`, HEALTHY_PROVIDER);
    api.campaigns().then((campaigns) => {
      for (const campaign of campaigns) {
        if (campaign.status === 'RUNNING' || campaign.status === 'PAUSED') {
          cy.request('POST', `/api/campaigns/${campaign.id}/stop`);
        }
      }
    });
  },
};

/**
 * Poll a server-side value until it satisfies `done`.
 *
 * Cypress retries DOM queries on its own but never retries `cy.request`, and the dialer runs
 * on a paced clock — "calls are being placed" is true a moment after the click, not at it.
 */
export function eventually<T>(
  load: () => Cypress.Chainable<T>,
  done: (value: T) => boolean,
  description: string,
  { attempts = 60, intervalMs = 500 }: { attempts?: number; intervalMs?: number } = {},
): Cypress.Chainable<T> {
  return load().then((value) => {
    if (done(value)) return cy.wrap(value, { log: false });
    if (attempts <= 1) {
      throw new Error(`Timed out waiting until ${description}. Last value: ${JSON.stringify(value)}`);
    }
    cy.wait(intervalMs, { log: false });
    return eventually(load, done, description, { attempts: attempts - 1, intervalMs });
  });
}
