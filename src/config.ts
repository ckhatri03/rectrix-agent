import os from 'node:os';
import dotenv from 'dotenv';
import { DEFAULT_STATE_FILE_PATH, resolveAgentEnvFilePath } from './envPaths';
import { CapabilityKey, ControlPlaneAuthMode, ControlPlaneMode } from './types';
import packageJson from '../package.json';

dotenv.config({ path: resolveAgentEnvFilePath() });

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
const DEFAULT_ALLOWED_CONFIG_ROOTS = [
  '/etc/mosquitto',
  '/etc/telegraf',
  '/etc/systemd/system',
  '/var/lib/mosquitto',
] as const;
const DEFAULT_ALLOWED_UNIT_PATTERNS = [
  '^mosquitto(?:@.+)?\\.service$',
  '^telegraf(?:@.+)?\\.service$',
  '^telegraf-.+\\.service$',
  '^[a-z0-9_]+_mqtt\\.service$',
  '^[a-z0-9_]+_telegraf\\.service$',
] as const;

export const CAPABILITIES: CapabilityKey[] = [
  'agent.diagnostics.snapshot',
  'agent.update',
  'stack.install',
  'stack.remove',
  'mqtt.diagnostics.snapshot',
  'broker.runtime.snapshot',
  'broker.apply',
  'broker.start',
  'broker.restart',
  'broker.stop',
  'broker.remove',
  'broker.config.apply',
  'mosquitto.acl.sync',
  'telegraf.runtime.snapshot',
  'telegraf.apply',
  'telegraf.remove',
];

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'production',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  agentVersion: process.env.AGENT_VERSION ?? packageJson.version,
  managerApiUrl: asString(process.env.MANAGER_API_URL),
  wssUrl: asString(process.env.WSS_URL),
  activationCode: asString(process.env.AGENT_ACTIVATION_CODE)?.toUpperCase(),
  agentId: asString(process.env.AGENT_ID),
  bootstrapToken: asString(process.env.AGENT_BOOTSTRAP_TOKEN),
  runtimeToken: asString(process.env.AGENT_RUNTIME_TOKEN),
  envFilePath: resolveAgentEnvFilePath(),
  stateFile: process.env.STATE_FILE ?? DEFAULT_STATE_FILE_PATH,
  pollIntervalMs: asNumber('POLL_INTERVAL_MS', 10000),
  heartbeatIntervalMs: asNumber('HEARTBEAT_INTERVAL_MS', 30000),
  idleJobCooldownAfterMs: asNumber('IDLE_JOB_COOLDOWN_AFTER_MS', 15 * 60 * 1000),
  idleJobPollIntervalMs: asNumber('IDLE_JOB_POLL_INTERVAL_MS', 60000),
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
  allowedConfigRoots: [
    ...new Set([
      ...DEFAULT_ALLOWED_CONFIG_ROOTS,
      ...asList('ALLOWED_CONFIG_ROOTS', [...DEFAULT_ALLOWED_CONFIG_ROOTS]),
    ]),
  ],
  allowedUnitPatterns: [
    ...new Set([
      ...DEFAULT_ALLOWED_UNIT_PATTERNS,
      ...asList('ALLOWED_UNIT_PATTERNS', [...DEFAULT_ALLOWED_UNIT_PATTERNS]),
    ]),
  ].map((value) => new RegExp(value)),
  sudoBin: process.env.SUDO_BIN ?? '/usr/bin/sudo',
  aptGetBin: process.env.APT_GET_BIN ?? '/usr/bin/apt-get',
  systemctlBin: process.env.SYSTEMCTL_BIN ?? '/usr/bin/systemctl',
  journalctlBin: process.env.JOURNALCTL_BIN ?? '/usr/bin/journalctl',
  installBin: process.env.INSTALL_BIN ?? '/usr/bin/install',
  rmBin: process.env.RM_BIN ?? '/usr/bin/rm',
  chownBin: process.env.CHOWN_BIN ?? '/usr/bin/chown',
  chmodBin: process.env.CHMOD_BIN ?? '/usr/bin/chmod',
  python3Bin: process.env.PYTHON3_BIN ?? '/usr/bin/python3',
  mosquittoSubBin:
    process.env.MOSQUITTO_SUB_BIN ?? '/usr/bin/mosquitto_sub',
  mosquittoPasswdBin:
    process.env.MOSQUITTO_PASSWD_BIN ?? '/usr/bin/mosquitto_passwd',
  setfaclBin: process.env.SETFACL_BIN ?? '/usr/bin/setfacl',
  capabilities: CAPABILITIES,
  hostname: os.hostname(),
};
