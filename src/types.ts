export type CapabilityKey =
  | 'agent.diagnostics.snapshot'
  | 'agent.update'
  | 'aws-iot.certificate.prepare'
  | 'aws-iot.certificate.install'
  | 'aws-iot.certificate.cleanup'
  | 'stack.install'
  | 'stack.remove'
  | 'mqtt.diagnostics.snapshot'
  | 'broker.runtime.snapshot'
  | 'dynsec.snapshot'
  | 'broker.apply'
  | 'broker.start'
  | 'broker.restart'
  | 'broker.stop'
  | 'broker.remove'
  | 'broker.config.apply'
  | 'mosquitto.acl.sync'
  | 'letsencrypt.dns01.deploy'
  | 'telegraf.runtime.snapshot'
  | 'telegraf.apply'
  | 'telegraf.remove';

export type AgentJobType = CapabilityKey;
export type ControlPlaneMode = 'auto' | 'http' | 'rest' | 'wss' | 'aws-iot-mqtt';
export type ActiveControlPlaneMode = 'http' | 'wss' | 'aws-iot-mqtt';
export type ControlPlaneAuthMode = 'auto' | 'token' | 'x509';
export type ActiveControlPlaneAuthMode = 'token' | 'x509';
export type AwsIotTransportMode = 'mqtt-x509-claim' | 'mqtt-x509-runtime';
export type JobEventLevel = 'info' | 'error';
export type JobExecutionStatus = 'succeeded' | 'failed';

export interface AgentState {
  agentId?: string;
  bootstrapToken?: string;
  runtimeToken?: string;
  managerApiUrl?: string;
  wssUrl?: string;
  iotEndpoint?: string;
  iotThingName?: string;
  iotClientId?: string;
  iotCaPath?: string;
  iotCertPath?: string;
  iotKeyPath?: string;
  iotTopicPrefix?: string;
  iotProvisioningTemplateName?: string;
  iotTransportMode?: AwsIotTransportMode;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requestedControlPlaneMode?: ControlPlaneMode;
  activeControlPlaneMode?: ActiveControlPlaneMode;
  requestedControlPlaneAuthMode?: ControlPlaneAuthMode;
  activeControlPlaneAuthMode?: ActiveControlPlaneAuthMode;
  lastSuccessfulWssConnectAt?: string;
  lastSuccessfulMqttConnectAt?: string;
  lastFallbackReason?: string;
  activationDisabledAt?: string;
  activationDisabledReason?: string;
  completedJobs?: Record<string, JobExecutionStatus>;
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
  restartRequested?: boolean;
}
