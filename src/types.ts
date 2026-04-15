export type CapabilityKey =
  | 'stack.install'
  | 'stack.remove'
  | 'broker.config.apply'
  | 'mosquitto.acl.sync'
  | 'telegraf.apply'
  | 'telegraf.remove';

export type AgentJobType = CapabilityKey;

export interface AgentState {
  agentId?: string;
  bootstrapToken?: string;
  runtimeToken?: string;
  managerApiUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
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
