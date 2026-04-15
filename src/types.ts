export type CapabilityKey =
  | 'agent.diagnostics.snapshot'
  | 'stack.install'
  | 'stack.remove'
  | 'broker.config.apply'
  | 'mosquitto.acl.sync'
  | 'telegraf.apply'
  | 'telegraf.remove';

export type AgentJobType = CapabilityKey;
export type ControlPlaneMode = 'auto' | 'http' | 'rest' | 'wss';
export type ActiveControlPlaneMode = 'http' | 'wss';
export type ControlPlaneAuthMode = 'auto' | 'token' | 'x509';
export type ActiveControlPlaneAuthMode = 'token' | 'x509';
export type JobEventLevel = 'info' | 'error';
export type JobExecutionStatus = 'succeeded' | 'failed';

export interface AgentState {
  agentId?: string;
  bootstrapToken?: string;
  runtimeToken?: string;
  managerApiUrl?: string;
  wssUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requestedControlPlaneMode?: ControlPlaneMode;
  activeControlPlaneMode?: ActiveControlPlaneMode;
  requestedControlPlaneAuthMode?: ControlPlaneAuthMode;
  activeControlPlaneAuthMode?: ActiveControlPlaneAuthMode;
  lastSuccessfulWssConnectAt?: string;
  lastFallbackReason?: string;
}

export interface ManagedFile {
  path: string;
  content: string;
  mode?: string;
}

export interface AgentJob {
  id: string;
  type: string;
  payload: unknown;
  raw: unknown;
}

export interface SystemInfo {
  hostname: string;
  os: string;
  osVersion: string;
  arch: string;
}

export interface JobResult {
  ok: true;
  summary: string;
  details?: Record<string, unknown>;
}
