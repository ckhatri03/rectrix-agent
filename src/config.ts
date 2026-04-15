import os from 'node:os';
import dotenv from 'dotenv';
import { CapabilityKey, ControlPlaneAuthMode, ControlPlaneMode } from './types';

dotenv.config();

const asString = (value: string | undefined) =>
  value && value.trim() ? value.trim() : undefined;

const asNumber = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
};

const asBoolean = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const asList = (name: string, fallback: string[]) => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const asEnum = <T extends string>(
  name: string,
  fallback: T,
  allowedValues: readonly T[],
): T => {
  const raw = asString(process.env[name])?.toLowerCase() as T | undefined;
  if (!raw) {
    return fallback;
  }
  if (!allowedValues.includes(raw)) {
    throw new Error(
      `Invalid ${name} value: ${raw}. Expected one of ${allowedValues.join(', ')}`,
    );
  }
  return raw;
};

const CONTROL_PLANE_MODES = ['auto', 'http', 'rest', 'wss'] as const satisfies ReadonlyArray<ControlPlaneMode>;
const CONTROL_PLANE_AUTH_MODES = ['auto', 'token', 'x509'] as const satisfies ReadonlyArray<ControlPlaneAuthMode>;

export const CAPABILITIES: CapabilityKey[] = [
  'stack.install',
  'stack.remove',
  'broker.config.apply',
  'mosquitto.acl.sync',
  'telegraf.apply',
  'telegraf.remove',
];

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'production',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  agentVersion: process.env.AGENT_VERSION ?? '0.1.0',
  managerApiUrl: asString(process.env.MANAGER_API_URL),
  wssUrl: asString(process.env.WSS_URL),
  activationCode: asString(process.env.AGENT_ACTIVATION_CODE)?.toUpperCase(),
  agentId: asString(process.env.AGENT_ID),
  bootstrapToken: asString(process.env.AGENT_BOOTSTRAP_TOKEN),
  runtimeToken: asString(process.env.AGENT_RUNTIME_TOKEN),
  envFilePath: process.env.AGENT_ENV_FILE_PATH ?? '/etc/rectrix-agent/agent.env',
  stateFile: process.env.STATE_FILE ?? '/var/lib/rectrix-agent/state.json',
  pollIntervalMs: asNumber('POLL_INTERVAL_MS', 10000),
  heartbeatIntervalMs: asNumber('HEARTBEAT_INTERVAL_MS', 30000),
  httpTimeoutMs: asNumber('HTTP_TIMEOUT_MS', 15000),
  controlPlaneMode: asEnum<ControlPlaneMode>(
    'CONTROL_PLANE_MODE',
    'http',
    CONTROL_PLANE_MODES,
  ),
  controlPlaneAuthMode: asEnum<ControlPlaneAuthMode>(
    'CONTROL_PLANE_AUTH_MODE',
    'token',
    CONTROL_PLANE_AUTH_MODES,
  ),
  wssConnectTimeoutMs: asNumber('WSS_CONNECT_TIMEOUT_MS', 10000),
  wssPingIntervalMs: asNumber('WSS_PING_INTERVAL_MS', 30000),
  wssPongTimeoutMs: asNumber('WSS_PONG_TIMEOUT_MS', 10000),
  wssForceReconnectMs: asNumber('WSS_FORCE_RECONNECT_MS', 3600000),
  wssBackoffInitialMs: asNumber('WSS_BACKOFF_INITIAL_MS', 1000),
  wssBackoffMaxMs: asNumber('WSS_BACKOFF_MAX_MS', 30000),
  activationPath: process.env.ACTIVATION_PATH ?? '/public-agent/activate',
  enrollPath: process.env.ENROLL_PATH ?? '/agent/enroll',
  heartbeatPath: process.env.HEARTBEAT_PATH ?? '/agent/heartbeat',
  capabilitiesPath: process.env.CAPABILITIES_PATH ?? '/agent/capabilities',
  nextJobPath: process.env.NEXT_JOB_PATH ?? '/agent/jobs/next',
  jobEventPathTemplate:
    process.env.JOB_EVENT_PATH_TEMPLATE ?? '/agent/jobs/:jobId/events',
  jobCompletePathTemplate:
    process.env.JOB_COMPLETE_PATH_TEMPLATE ?? '/agent/jobs/:jobId/complete',
  allowPackageOperations: asBoolean('ALLOW_PACKAGE_OPERATIONS', true),
  allowedConfigRoots: asList('ALLOWED_CONFIG_ROOTS', [
    '/etc/mosquitto',
    '/etc/telegraf',
    '/etc/systemd/system',
  ]),
  allowedUnitPatterns: asList('ALLOWED_UNIT_PATTERNS', [
    '^mosquitto(?:@.+)?\\.service$',
    '^telegraf(?:@.+)?\\.service$',
    '^telegraf-.+\\.service$',
  ]).map((value) => new RegExp(value)),
  sudoBin: process.env.SUDO_BIN ?? '/usr/bin/sudo',
  aptGetBin: process.env.APT_GET_BIN ?? '/usr/bin/apt-get',
  systemctlBin: process.env.SYSTEMCTL_BIN ?? '/usr/bin/systemctl',
  journalctlBin: process.env.JOURNALCTL_BIN ?? '/usr/bin/journalctl',
  installBin: process.env.INSTALL_BIN ?? '/usr/bin/install',
  rmBin: process.env.RM_BIN ?? '/usr/bin/rm',
  capabilities: CAPABILITIES,
  hostname: os.hostname(),
};
