/**
 * Typed API client.
 *
 * One place that knows how to talk to the backend, and one place that understands its error
 * shape. Every failure the server classifies (`{ error: { code, message, metadata } }`)
 * becomes an `ApiError` carrying that code, so a view can show "CAMPAIGN_CONCURRENCY_LIMIT"
 * and its metadata rather than "Request failed".
 */

import type {
  Agent, AgentMetrics, Call, CallAttempt, Campaign, CampaignMetrics, Contact,
  DialerState, ProviderInfo, SafetyDecision, Scenario, SimulationReport,
  SmartDialerEvent, SystemStatus,
} from './types.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly metadata: Record<string, unknown>;

  constructor(code: string, message: string, status: number, metadata: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.metadata = metadata;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    });
  } catch (cause) {
    // The API being unreachable is the single most likely failure in local development, and
    // "Failed to fetch" tells nobody anything useful.
    throw new ApiError(
      'NETWORK_ERROR',
      'Cannot reach the SmartDialer API. Is `npm run dev` running?',
      0,
      { cause: String(cause) },
    );
  }

  const text = await response.text();
  const body: unknown = text === '' ? {} : JSON.parse(text);

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; metadata?: Record<string, unknown> } }).error;
    throw new ApiError(
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed with ${response.status}`,
      response.status,
      error?.metadata ?? {},
    );
  }
  return body as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

/** Serialise a filter object into a query string, dropping empty values. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

export const api = {
  health: () => get<{ status: string; simulationMode: boolean }>('/api/health'),

  systemStatus: () => get<SystemStatus>('/api/system/status'),
  emergencyStop: (reason?: string) =>
    post<{ system: SystemStatus['system'] }>('/api/system/emergency-stop', { reason }),
  emergencyResume: () => post<{ system: SystemStatus['system'] }>('/api/system/emergency-resume'),
  invariants: () =>
    get<{ passed: boolean; violations: Array<{ invariant: string; detail: string }> }>(
      '/api/system/invariants',
    ),
  safetyRules: () =>
    get<{ rules: Array<{ name: string; description: string }> }>('/api/system/safety-rules'),
  setSpeed: (speed: number) => post<{ speed: number }>('/api/system/speed', { speed }),

  campaigns: () => get<{ campaigns: Campaign[] }>('/api/campaigns'),
  campaign: (id: string) =>
    get<{
      campaign: Campaign;
      metrics: CampaignMetrics;
      agents: Agent[];
      contactCounts: { total: number; byStatus: Record<string, number> };
      running: boolean;
    }>(`/api/campaigns/${id}`),
  campaignMetrics: (id: string) =>
    get<{ campaign: CampaignMetrics; agents: AgentMetrics; dialer: DialerState }>(
      `/api/campaigns/${id}/metrics`,
    ),
  campaignSafety: (id: string) =>
    get<{ rules: Array<{ name: string; description: string }>; denials: SafetyDecision[] }>(
      `/api/campaigns/${id}/safety`,
    ),
  createCampaign: (body: unknown) => post<{ campaign: Campaign }>('/api/campaigns', body),
  updateCampaign: (id: string, body: unknown) =>
    patch<{ campaign: Campaign }>(`/api/campaigns/${id}`, body),
  campaignAction: (id: string, action: 'ready' | 'start' | 'pause' | 'resume' | 'stop' | 'resume-predictive') =>
    post<{ campaign: Campaign }>(`/api/campaigns/${id}/${action}`),

  contacts: (filter: { campaignId?: string; status?: string; query?: string; limit?: number }) =>
    get<{ contacts: Contact[] }>(`/api/contacts${query(filter)}`),
  contact: (id: string) =>
    get<{ contact: Contact; attempts: CallAttempt[] }>(`/api/contacts/${id}`),
  createContact: (body: unknown) => post<{ contact: Contact }>('/api/contacts', body),
  markDoNotCall: (id: string) => post<{ contact: Contact }>(`/api/contacts/${id}/do-not-call`),

  agents: (campaignId?: string) =>
    get<{ agents: Agent[]; metrics: AgentMetrics }>(`/api/agents${query({ campaignId })}`),
  createAgent: (body: unknown) => post<{ agent: Agent }>('/api/agents', body),
  setAgentStatus: (id: string, status: 'OFFLINE' | 'AVAILABLE' | 'PAUSED') =>
    post<{ agent: Agent }>(`/api/agents/${id}/status`, { status }),

  calls: (filter: { campaignId?: string; status?: string; activeOnly?: boolean; limit?: number }) =>
    get<{ calls: Call[]; activeCount: number }>(`/api/calls${query(filter)}`),
  call: (id: string) =>
    get<{ call: Call | null; attempt: CallAttempt | null; contact: Contact | null; agent: Agent | null }>(
      `/api/calls/${id}`,
    ),

  events: (filter: {
    types?: string;
    severities?: string;
    campaignId?: string;
    callId?: string;
    contactId?: string;
    agentId?: string;
    limit?: number;
  }) => get<{ events: SmartDialerEvent[]; latestSeq: number }>(`/api/events${query(filter)}`),

  providers: () => get<{ providers: ProviderInfo[] }>('/api/providers'),
  updateProvider: (id: string, config: Record<string, number | boolean>) =>
    post<{ id: string; config: ProviderInfo['config']; metrics: ProviderInfo['metrics'] }>(
      `/api/providers/${id}/config`,
      config,
    ),

  scenarios: () => get<{ scenarios: Scenario[] }>('/api/simulation/scenarios'),
  runSimulation: (config: Record<string, unknown>) =>
    post<{ report: SimulationReport }>('/api/simulation/start', config),
  runScenario: (name: string) =>
    post<{
      scenario: string;
      demonstrates: string;
      report: SimulationReport;
      expectationsMet: boolean;
      problems: string[];
    }>(`/api/simulation/scenario/${name}`),
};
