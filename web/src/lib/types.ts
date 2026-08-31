/**
 * Shapes the API returns.
 *
 * Hand-written rather than shared with the backend: the frontend has its own tsconfig
 * (DOM lib, bundler resolution) and importing server types would drag `node:sqlite` and
 * Fastify into the browser build. The duplication is small, and the API tests are what
 * actually pin the contract.
 */

export type CampaignStatus =
  | 'DRAFT' | 'READY' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'COMPLETED' | 'FAILED';
export type DialingMode = 'PROGRESSIVE' | 'PREDICTIVE';

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export interface CampaignSafety {
  pacingMultiplier: number;
  targetOccupancy: number;
  lineRatio: number;
  maxLinesPerAgent: number;
  abandonTimeoutMs: number;
  abandonMinSample: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  dialingMode: DialingMode;
  maxConcurrentCalls: number;
  maxCallsPerSecond: number;
  maxAbandonRate: number;
  maxAttemptsPerContact: number;
  retryPolicy: RetryPolicy;
  safety: CampaignSafety;
  providerId: string;
  predictivePausedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignMetrics {
  campaignId: string;
  status: CampaignStatus;
  dialingMode: DialingMode;
  contactsTotal: number;
  contactsRemaining: number;
  contactsByStatus: Record<string, number>;
  callsActive: number;
  callsTotal: number;
  callsAnswered: number;
  callsAbandoned: number;
  outcomes: Record<string, number>;
  answerRate: number;
  recentAnswerRate: number;
  noAnswerRate: number;
  busyRate: number;
  failureRate: number;
  abandonRate: number;
  averageTalkMs: number;
  retriesScheduled: number;
}

export interface AgentMetrics {
  total: number;
  available: number;
  occupied: number;
  paused: number;
  offline: number;
  onCall: number;
  wrapUp: number;
  utilization: number;
  averageHandleTimeMs: number;
}

export interface DialerState {
  running: boolean;
  stalled: boolean;
  inFlight: number;
  awaitingAgent: number;
  snapshot: DialerSnapshot | null;
  lastPlan: { attempts: number; reasoning: string[]; at: number } | null;
}

export interface DialerSnapshot {
  now: number;
  totalAgents: number;
  availableAgents: number;
  occupiedAgents: number;
  activeCalls: number;
  pendingConnections: number;
  connectedCalls: number;
  historicalAnswerRate: number;
  recentAnswerRate: number;
  recentSample: number;
  abandonRate: number;
  abandonSample: number;
  campaignHeadroom: number;
  globalHeadroom: number;
  providerHeadroom: number;
  rateLimitHeadroom: number;
  remainingContacts: number;
}

export type ContactStatus =
  | 'READY' | 'RESERVED' | 'DIALING' | 'RINGING' | 'CONNECTED' | 'NO_ANSWER'
  | 'BUSY' | 'FAILED' | 'COMPLETED' | 'RETRY_PENDING' | 'EXHAUSTED' | 'DO_NOT_CALL';

export interface Contact {
  id: string;
  campaignId: string;
  name: string;
  phoneNumber: string;
  status: ContactStatus;
  attemptCount: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  timezone: string;
  metadata: Record<string, unknown>;
}

export interface CallAttempt {
  id: string;
  callId: string;
  contactId: string;
  attemptNumber: number;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  failureCode: string | null;
  failureClass: string;
  retryScheduledFor: number | null;
}

export type AgentStatus =
  | 'OFFLINE' | 'AVAILABLE' | 'RESERVED' | 'RINGING' | 'ON_CALL' | 'WRAP_UP' | 'PAUSED';

export interface Agent {
  id: string;
  campaignId: string | null;
  name: string;
  status: AgentStatus;
  currentCallId: string | null;
  callsHandled: number;
  totalHandleTimeMs: number;
  lastStateChange: number;
}

export type CallStatus =
  | 'CREATED' | 'QUEUED' | 'DIALING' | 'RINGING' | 'CONNECTED' | 'ON_HOLD'
  | 'ENDED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';

export interface Call {
  id: string;
  campaignId: string;
  contactId: string;
  attemptId: string;
  agentId: string | null;
  providerId: string;
  providerCallId: string | null;
  status: CallStatus;
  createdAt: number;
  connectedAt: number | null;
  endedAt: number | null;
  talkDurationMs: number | null;
  outcome: string | null;
  failureCode: string | null;
  failureClass: string;
  abandoned: boolean;
}

export interface SmartDialerEvent {
  id: string;
  seq?: number;
  type: string;
  at: number;
  severity: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  campaignId?: string;
  contactId?: string;
  callId?: string;
  agentId?: string;
  providerId?: string;
  metadata: Record<string, unknown>;
}

export interface SystemStatus {
  system: {
    emergencyStopped: boolean;
    emergencyStoppedAt: number | null;
    reason: string | null;
    simulationMode: boolean;
    providerDriver: string;
  };
  concurrency: {
    global: number;
    byCampaign: Record<string, number>;
    byProvider: Record<string, number>;
    globalMax: number;
    providerMax: number;
  };
  clock: { virtualMs: number; speed: number; running: boolean; pendingTimers: number };
  agents: AgentMetrics;
  campaigns: number;
  activeCalls: number;
  sseSubscribers: number;
  safety: { simulationMode: boolean; providerDriver: string; configWarnings: string[] };
}

export interface SafetyDecision {
  allowed: boolean;
  rule: string;
  code: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface ProviderConfig {
  answerRate: number;
  noAnswerRate: number;
  busyRate: number;
  failureRate: number;
  timeoutRate: number;
  stuckRingingRate: number;
  errorRate: number;
  invalidNumberRate: number;
  meanRingDurationMs: number;
  meanCallDurationMs: number;
  latencySpikeMs: number;
  maxConcurrentCalls: number;
  outageActive: boolean;
}

export interface ProviderMetrics {
  requests: number;
  accepted: number;
  rejected: number;
  completed: number;
  failed: number;
  silent: number;
  averageResponseTimeMs: number;
  activeCalls: number;
  outageActive: boolean;
}

export interface ProviderInfo {
  id: string;
  driver: string;
  config: ProviderConfig;
  metrics: ProviderMetrics;
}

export interface SimulationReport {
  scenario: string;
  seed: number;
  dialingMode: DialingMode;
  totalContacts: number;
  totalAttempts: number;
  successfulConnections: number;
  noAnswers: number;
  busy: number;
  failures: number;
  timeouts: number;
  abandoned: number;
  cancelled: number;
  retries: number;
  averageAttemptsPerContact: number;
  averageCallDurationMs: number;
  peakConcurrency: number;
  averageConcurrency: number;
  agentUtilization: number;
  answerRate: number;
  abandonRate: number;
  providerErrorRate: number;
  safetyInterventions: number;
  capacityBackpressure: number;
  contactsByStatus: Record<string, number>;
  virtualDurationMs: number;
  realDurationMs: number;
  totalEvents: number;
  invariantsPassed: boolean;
  invariantViolations: Array<{ invariant: string; detail: string }>;
  stopReason: string;
}

export interface Scenario {
  name: string;
  demonstrates: string;
  config: Record<string, unknown>;
}
