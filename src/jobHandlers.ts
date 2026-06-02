import { execFile, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from './config';
import {
  aptInstall,
  aptRemove,
  binaryExists,
  chmodManagedPath,
  chownManagedPath,
  ensureManagedDirectory,
  ensureManagedFile,
  getUnitState,
  managedPathExists,
  readUnitLogs,
  readUnitStatus,
  removeManagedFiles,
  runRootBinary,
  systemctl,
  writeManagedFiles,
} from './system';
import { loadState } from './stateStore';
import { AgentJob, JobResult, ManagedFile } from './types';

const execFileAsync = promisify(execFile);

const fileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.string().regex(/^0[0-7]{3}$/).optional(),
});

const unitsSchema = z.array(z.string().min(1)).default([]);
const packagesSchema = z.array(z.enum(['mosquitto', 'telegraf'])).default([]);
const diagnosticsSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  requestedBy: z.string().trim().min(1).max(200).optional(),
  expectedTransportMode: z
    .enum(['auto', 'http', 'rest', 'wss'])
    .optional(),
});

const agentUpdateSchema = z.object({
  archiveUrl: z.string().url(),
  version: z.string().trim().min(1),
  serviceName: z.string().trim().min(1).default('rectrix-agent.service'),
});

const fileApplySchema = z.object({
  files: z.array(fileSchema).min(1),
  installPackages: z.boolean().optional(),
  packages: packagesSchema.optional(),
  packageVersions: z.record(z.string()).optional(),
  unitsToEnable: unitsSchema.optional(),
  unitsToRestart: unitsSchema.optional(),
  unitsToReload: unitsSchema.optional(),
});

const fileRemoveSchema = z.object({
  filesToRemove: z.array(z.string().min(1)).default([]),
  removePackages: z.boolean().optional(),
  packages: packagesSchema.optional(),
  unitsToStop: unitsSchema.optional(),
  unitsToDisable: unitsSchema.optional(),
});

const stackSchema = z.object({
  packages: packagesSchema.optional(),
  packageVersions: z.record(z.string()).optional(),
  unitsToEnable: unitsSchema.optional(),
  unitsToStart: unitsSchema.optional(),
  unitsToStop: unitsSchema.optional(),
  unitsToDisable: unitsSchema.optional(),
});

const brokerDynsecAclSchema = z.object({
  permission: z.enum(['read', 'write', 'readwrite']),
  topic: z.string().min(1),
});

const brokerCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string(),
  roleName: z.string().min(1),
  acls: z.array(brokerDynsecAclSchema).default([]),
});

const brokerTlsBootstrapSchema = z.object({
  cafile: z.string().min(1),
  certfile: z.string().min(1),
  keyfile: z.string().min(1),
  requireCertificate: z.boolean(),
  installPublicCaBundle: z.boolean().optional().default(false),
  certbotLiveDir: z.string().min(1).optional(),
});

const brokerApplySchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  dynsecConfigPath: z.string().min(1),
  dynsecAdminUsername: z.string().min(1),
  dynsecAdminPassword: z.string(),
  dynsecControlPort: z.number().int().positive().max(65535),
  persistenceLocation: z.string().min(1),
  unitPath: z.string().min(1),
  configContents: z.string(),
  unitContents: z.string(),
  dynsecClients: z.array(brokerCredentialSchema).default([]),
  tlsBootstrap: brokerTlsBootstrapSchema.optional(),
});

const brokerControlSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
});

const brokerRuntimeSnapshotSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  maxLogLines: z.number().int().positive().max(500).optional().default(20),
});

const brokerRemoveSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  dynsecConfigPath: z.string().min(1),
  persistenceLocation: z.string().min(1),
  unitPath: z.string().min(1),
});

const letsEncryptDnsDeploySchema = z.object({
  planId: z.number().int().positive(),
  certificateHostname: z.string().trim().min(1),
  contactEmail: z.string().trim().email(),
  environment: z.enum(['staging', 'production']),
  renewalStrategy: z.enum(['copy-and-reload', 'symlink-and-reload']),
  dnsProvider: z.string().trim().min(1),
  dnsCredentialsSecretRef: z.string().trim().min(1).optional(),
  dnsApiKey: z.string().trim().min(1).optional(),
  dnsApiSecret: z.string().trim().min(1).optional(),
  dnsZone: z.string().trim().min(1).optional(),
  renewDryRun: z.boolean().optional().default(false),
  brokerServices: z.array(z.string().min(1)).default([]),
});

const telegrafRuntimeApplySchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  unitPath: z.string().min(1),
  configContents: z.string(),
  unitContents: z.string(),
  tlsAccessPaths: z.array(z.string().min(1)).optional().default([]),
});

const telegrafRuntimeSnapshotSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  maxLogLines: z.number().int().positive().max(500).optional().default(20),
});

const telegrafRuntimeRemoveSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  unitPath: z.string().min(1),
});

const mqttDiagnosticsSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  maxMessages: z.number().int().positive().max(100).optional().default(20),
});

const maybeReloadSystemd = async (files: ManagedFile[]) => {
  const changedSystemdUnits = files.some((file) =>
    file.path.startsWith('/etc/systemd/system/'),
  );
  if (changedSystemdUnits) {
    await systemctl('daemon-reload');
  }
};

const summarizeUnitStates = async (units: string[]) => {
  const entries = await Promise.all(
    units.map(async (unit) => [unit, await getUnitState(unit)] as const),
  );
  return Object.fromEntries(entries);
};

const withDefaultPackages = (packages: string[] | undefined, fallback: string[]) =>
  packages && packages.length > 0 ? packages : fallback;

const safeUsername = () => {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
};

const assertAllowedServiceName = (
  serviceName: string,
  suffix: 'mqtt' | 'telegraf',
) => {
  const expected = suffix === 'mqtt' ? /_mqtt$/i : /_telegraf$/i;
  if (!/^[a-z0-9_]+$/i.test(serviceName) || !expected.test(serviceName)) {
    throw new Error(`Service name ${serviceName} is not allowed.`);
  }
  return serviceName;
};

const shellEscape = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

const systemCaBundleCandidates = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
] as const;

const resolveAgentAuthToken = async () => {
  const persisted: Partial<{ runtimeToken: string; bootstrapToken: string }> =
    await loadState(config.stateFile).catch(() => ({}));
  return (
    config.runtimeToken
    ?? persisted.runtimeToken
    ?? config.bootstrapToken
    ?? persisted.bootstrapToken
    ?? null
  );
};

const queueAgentSelfUpdate = async (
  payload: z.infer<typeof agentUpdateSchema>,
): Promise<JobResult> => {
  const authToken = await resolveAgentAuthToken();
  if (!authToken) {
    throw new Error('Agent update requires a persisted runtime or bootstrap token.');
  }

  const appDir = path.resolve(__dirname, '..');
  const installRoot = path.dirname(appDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rectrix-agent-update-'));
  const logPath = path.join(tempDir, 'update.log');
  const stageRoot = path.join(tempDir, 'stage');
  const nextAppDir = path.join(installRoot, `app.next.${Date.now()}`);
  const backupAppDir = path.join(installRoot, `app.previous.${Date.now()}`);

  await fs.mkdir(stageRoot, { recursive: true });

  const script = [
    'set -eu',
    `TEMP_DIR=${shellEscape(tempDir)}`,
    `ARCHIVE_URL=${shellEscape(payload.archiveUrl)}`,
    `AUTH_TOKEN=${shellEscape(authToken)}`,
    `APP_DIR=${shellEscape(appDir)}`,
    `NEXT_APP_DIR=${shellEscape(nextAppDir)}`,
    `BACKUP_APP_DIR=${shellEscape(backupAppDir)}`,
    `STAGE_ROOT=${shellEscape(stageRoot)}`,
    `ENV_FILE=${shellEscape(config.envFilePath)}`,
    `TARGET_VERSION=${shellEscape(payload.version)}`,
    `SERVICE_NAME=${shellEscape(payload.serviceName)}`,
    `LOG_PATH=${shellEscape(logPath)}`,
    'SERVICE_LOG_PATH=/var/log/rectrix-agent.log',
    '{',
    '  ARCHIVE_PATH="$TEMP_DIR/rectrix-agent.tar.gz"',
    '  mkdir -p "$STAGE_ROOT"',
    '  curl -fsSL -H "Authorization: Bearer $AUTH_TOKEN" "$ARCHIVE_URL" -o "$ARCHIVE_PATH"',
    '  tar -xzf "$ARCHIVE_PATH" -C "$STAGE_ROOT"',
    '  SRC_DIR="$(find "$STAGE_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"',
    '  if [ -z "$SRC_DIR" ]; then',
    '    echo "update archive did not contain a source directory" >&2',
    '    exit 1',
    '  fi',
    '  rm -rf "$NEXT_APP_DIR"',
    '  mkdir -p "$NEXT_APP_DIR"',
    '  cp -R "$SRC_DIR/." "$NEXT_APP_DIR/"',
    '  cd "$NEXT_APP_DIR"',
    '  npm ci',
    '  npm run build',
    '  if [ ! -f "$SERVICE_LOG_PATH" ]; then',
    '    sudo install -m 0640 -o rectrix-agent -g rectrix-agent /dev/null "$SERVICE_LOG_PATH"',
    '  fi',
    '  rm -rf "$BACKUP_APP_DIR"',
    '  mv "$APP_DIR" "$BACKUP_APP_DIR"',
    '  mv "$NEXT_APP_DIR" "$APP_DIR"',
    '  if [ -f "$ENV_FILE" ] || [ -w "$(dirname "$ENV_FILE")" ]; then',
    '    if grep -q "^AGENT_VERSION=" "$ENV_FILE" 2>/dev/null; then',
    '      sed -i "s|^AGENT_VERSION=.*$|AGENT_VERSION=$TARGET_VERSION|" "$ENV_FILE"',
    '    else',
    '      printf "AGENT_VERSION=%s\n" "$TARGET_VERSION" >> "$ENV_FILE"',
    '    fi',
    '  fi',
    '  sudo systemctl restart "$SERVICE_NAME"',
    '} >> "$LOG_PATH" 2>&1',
  ].join('\n');

  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();


  return {
    ok: true,
    summary: `Queued agent self-update to ${payload.version}`,
    details: {
      version: payload.version,
      archiveUrl: payload.archiveUrl,
      serviceName: payload.serviceName,
      logPath,
    },
  };
};

const requiresAclForTelegraf = (filePath: string) =>
  /(^|\/)(privkey\.pem|.*\.key)$/i.test(filePath.trim());

const buildParentPaths = (filePath: string, stopAt: string): string[] => {
  const normalizedPath = filePath.trim().replace(/\/+$/, '');
  const normalizedStop = stopAt.trim().replace(/\/+$/, '');
  if (
    !normalizedPath.startsWith(`${normalizedStop}/`) &&
    normalizedPath !== normalizedStop
  ) {
    return [];
  }

  const targetDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
  if (!targetDir || targetDir.length < normalizedStop.length) {
    return [];
  }

  const paths: string[] = [];
  let currentDir = targetDir;
  while (
    currentDir === normalizedStop ||
    currentDir.startsWith(`${normalizedStop}/`)
  ) {
    paths.unshift(currentDir);
    if (currentDir === normalizedStop) {
      break;
    }
    currentDir = currentDir.substring(0, currentDir.lastIndexOf('/'));
  }

  return paths;
};

const parsePersistenceConfig = (contents: string) => {
  const defaults = {
    persistence: false,
    persistenceLocation: '/var/lib/mosquitto/',
  };

  let persistence: boolean | null = null;
  let persistenceLocation: string | null = null;

  contents.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const [rawKey, ...rest] = trimmed.split(/\s+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(' ');

    if (key === 'persistence') {
      persistence = value.toLowerCase() === 'true';
    } else if (key === 'persistence_location') {
      persistenceLocation = value;
    }
  });

  return {
    persistence: persistence ?? defaults.persistence,
    persistenceLocation: persistenceLocation ?? defaults.persistenceLocation,
  };
};

const resolveDbPath = (persistenceLocation: string) => {
  const trimmed = persistenceLocation.trim();
  if (!trimmed) {
    return '/var/lib/mosquitto/mqtt.db';
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed.replace(/\/+$/, '')}/mqtt.db`;
};

const parseTableList = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const pickMessageTable = (tables: string[]) =>
  tables.find((table) => /message/i.test(table)) ?? tables[0] ?? null;

const sanitizeTableName = (value: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error('Invalid table name in mqtt.db');
  }
  return value;
};

const summarizeUnitStatesForService = async (serviceName: string) => {
  const unit = `${serviceName}.service`;
  return {
    [unit]: await getUnitState(unit),
  };
};

const ensureRuntimePackage = async (
  binaryPath: string,
  packageName: 'mosquitto' | 'telegraf',
) => {
  if (await binaryExists(binaryPath)) {
    return false;
  }
  await aptInstall([packageName]);
  return true;
};

const DYNSEC_PLUGIN_PATH_PLACEHOLDER = '__RECTRIX_DYNSEC_PLUGIN_PATH__';

const dynsecPluginCandidates = [
  '/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so',
  '/usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so',
  '/usr/lib/arm-linux-gnueabihf/mosquitto_dynamic_security.so',
  '/usr/lib64/mosquitto_dynamic_security.so',
  '/usr/lib/mosquitto_dynamic_security.so',
] as const;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const usesTopicPattern = (topic: string) => /[+#]/.test(topic);

const parseDynsecList = (stdout: string) =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const resolveDynsecPluginPath = async () => {
  for (const candidate of dynsecPluginCandidates) {
    if (await managedPathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate mosquitto_dynamic_security.so. Checked: ${dynsecPluginCandidates.join(', ')}`,
  );
};

const renderBrokerConfigWithDynsec = async (configContents: string) =>
  configContents.replaceAll(
    DYNSEC_PLUGIN_PATH_PLACEHOLDER,
    await resolveDynsecPluginPath(),
  );

const ensureDynsecConfigInitialized = async (
  payload: z.infer<typeof brokerApplySchema>,
) => {
  await ensureManagedDirectory(path.dirname(payload.dynsecConfigPath), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });

  if (!(await managedPathExists(payload.dynsecConfigPath))) {
    await runRootBinary(config.mosquittoCtrlBin, [
      'dynsec',
      'init',
      payload.dynsecConfigPath,
      payload.dynsecAdminUsername,
      payload.dynsecAdminPassword,
    ]);
  }

  await chownManagedPath(payload.dynsecConfigPath, 'root', 'mosquitto');
  await chmodManagedPath(payload.dynsecConfigPath, '0640');
};

const runDynsec = async (
  payload: z.infer<typeof brokerApplySchema>,
  args: string[],
) =>
  runRootBinary(config.mosquittoCtrlBin, [
    '-h',
    '127.0.0.1',
    '-p',
    String(payload.dynsecControlPort),
    '-u',
    payload.dynsecAdminUsername,
    '-P',
    payload.dynsecAdminPassword,
    'dynsec',
    ...args,
  ]);

const waitForDynsecReady = async (payload: z.infer<typeof brokerApplySchema>) => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await runDynsec(payload, ['listClients']);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out waiting for dynsec to become ready.');
};

const reconcileBrokerDynsec = async (
  payload: z.infer<typeof brokerApplySchema>,
) => {
  await runDynsec(payload, ['setDefaultACLAccess', 'publishClientSend', 'deny']);
  await runDynsec(payload, ['setDefaultACLAccess', 'publishClientReceive', 'deny']);
  await runDynsec(payload, ['setDefaultACLAccess', 'subscribe', 'deny']);
  await runDynsec(payload, ['setDefaultACLAccess', 'unsubscribe', 'deny']);

  const clients = parseDynsecList((await runDynsec(payload, ['listClients'])).stdout);
  for (const username of clients) {
    if (username === payload.dynsecAdminUsername) {
      continue;
    }
    await runDynsec(payload, ['deleteClient', username]);
  }

  const roles = parseDynsecList((await runDynsec(payload, ['listRoles'])).stdout);
  for (const roleName of roles) {
    if (roleName === 'admin') {
      continue;
    }
    await runDynsec(payload, ['deleteRole', roleName]);
  }

  for (const client of payload.dynsecClients) {
    await runDynsec(payload, ['createRole', client.roleName]);

    for (const [index, acl] of client.acls.entries()) {
      const priority = String(1000 - index);
      if (acl.permission === 'write' || acl.permission === 'readwrite') {
        await runDynsec(payload, [
          'addRoleACL',
          client.roleName,
          'publishClientSend',
          acl.topic,
          'allow',
          priority,
        ]);
      }

      if (acl.permission === 'read' || acl.permission === 'readwrite') {
        const subscribeType = usesTopicPattern(acl.topic)
          ? 'subscribePattern'
          : 'subscribeLiteral';
        const unsubscribeType = usesTopicPattern(acl.topic)
          ? 'unsubscribePattern'
          : 'unsubscribeLiteral';
        await runDynsec(payload, [
          'addRoleACL',
          client.roleName,
          'publishClientReceive',
          acl.topic,
          'allow',
          priority,
        ]);
        await runDynsec(payload, [
          'addRoleACL',
          client.roleName,
          subscribeType,
          acl.topic,
          'allow',
          priority,
        ]);
        await runDynsec(payload, [
          'addRoleACL',
          client.roleName,
          unsubscribeType,
          acl.topic,
          'allow',
          priority,
        ]);
      }
    }

    await runDynsec(payload, ['createClient', client.username]);
    await runDynsec(payload, ['setClientPassword', client.username, client.password]);
    await runDynsec(payload, ['addClientRole', client.username, client.roleName, '0']);
  }
};

const installTlsArtifact = async (
  sourcePath: string,
  targetPath: string,
  mode: '0640' | '0644' = '0640',
) => {
  await ensureManagedDirectory(path.dirname(targetPath), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });

  try {
    await runRootBinary(config.installBin, [
      '-D',
      '-o',
      'root',
      '-g',
      'mosquitto',
      '-m',
      mode,
      sourcePath,
      targetPath,
    ]);
  } catch (error) {
    throw new Error(`TLS source file ${sourcePath} does not exist on the host.`);
  }
};

const installPublicCaBundle = async (cafile: string) => {
  for (const candidate of systemCaBundleCandidates) {
    if (await binaryExists(candidate)) {
      await installTlsArtifact(candidate, cafile, '0640');
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate a system CA bundle. Checked: ${systemCaBundleCandidates.join(', ')}`,
  );
};

const resolveMosquittoSharedTlsFallback = async (configuredPath: string) => {
  const sharedCertDir = '/etc/mosquitto/certs';
  const configuredDir = path.dirname(configuredPath);
  if (configuredDir !== sharedCertDir) {
    return null;
  }

  const filename = path.basename(configuredPath);
  let dirEntries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    dirEntries = await fs.readdir(sharedCertDir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return null;
  }

  const candidatePaths: string[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidatePath = path.join(sharedCertDir, entry.name, filename);
    if (await managedPathExists(candidatePath)) {
      candidatePaths.push(candidatePath);
    }
  }

  if (candidatePaths.length === 0) {
    return null;
  }
  if (candidatePaths.length === 1) {
    return candidatePaths[0];
  }

  throw new Error(
    `Configured TLS file ${configuredPath} does not exist on the host, and multiple hostname-scoped fallback files were found: ${candidatePaths.join(', ')}`,
  );
};

const ensureBrokerTlsArtifact = async (
  configuredPath: string,
  label: 'CA bundle' | 'certificate file' | 'private key file',
  mode: '0640' | '0644' = '0640',
) => {
  if (await managedPathExists(configuredPath)) {
    await chownManagedPath(configuredPath, 'root', 'mosquitto');
    await chmodManagedPath(configuredPath, mode);
    return configuredPath;
  }

  const fallbackPath = await resolveMosquittoSharedTlsFallback(configuredPath);
  if (!fallbackPath) {
    throw new Error(`Configured ${label} ${configuredPath} does not exist on the host.`);
  }

  await installTlsArtifact(fallbackPath, configuredPath, mode);
  return fallbackPath;
};

const prepareBrokerTlsFiles = async (
  payload: z.infer<typeof brokerApplySchema>,
) => {
  const tls = payload.tlsBootstrap;
  if (!tls) {
    return [] as string[];
  }

  await ensureManagedDirectory(path.dirname(tls.cafile), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });
  await ensureManagedDirectory(path.dirname(tls.certfile), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });
  await ensureManagedDirectory(path.dirname(tls.keyfile), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });

  const prepared: string[] = [];

  if (tls.installPublicCaBundle) {
    prepared.push(await installPublicCaBundle(tls.cafile));
  } else {
    prepared.push(await ensureBrokerTlsArtifact(tls.cafile, 'CA bundle', '0640'));
  }

  if (tls.certbotLiveDir) {
    const fullchainPath = path.join(tls.certbotLiveDir, 'fullchain.pem');
    const privkeyPath = path.join(tls.certbotLiveDir, 'privkey.pem');
    await installTlsArtifact(fullchainPath, tls.certfile, '0640');
    await installTlsArtifact(privkeyPath, tls.keyfile, '0640');
    prepared.push(fullchainPath, privkeyPath);
    return prepared;
  }

  prepared.push(await ensureBrokerTlsArtifact(tls.certfile, 'certificate file', '0640'));
  prepared.push(await ensureBrokerTlsArtifact(tls.keyfile, 'private key file', '0640'));
  return prepared;
};

type RootShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type LetsEncryptDeployStepResult = {
  step: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type LetsEncryptCertificateInspection = {
  certificateStatus: 'not-installed' | 'installed' | 'expiring-soon' | 'expired' | 'unknown';
  certificateSummary: string;
  certificateExpiresAt: string | null;
  certificateDaysRemaining: number | null;
  certificateStatusCheckedAt: string | null;
};

type LetsEncryptResultMetadata = {
  certificateHostname: string;
  certbotLiveDir: string;
  certbotRenewalConfigPath: string;
  certbotRenewCommand: string;
  renewDryRunEnabled: boolean;
};

const truncateOutput = (value: string, max = 2000) =>
  value.length > max
    ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]`
    : value;

const summarizeShellFailure = (result: RootShellResult) => {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (!detail) {
    return `exit code ${result.exitCode ?? 'unknown'}`;
  }
  return detail;
};

const parseCertificateExpiry = (value: string): string | null => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const parsedTime = Date.parse(trimmedValue);
  if (Number.isNaN(parsedTime)) {
    return null;
  }

  return new Date(parsedTime).toISOString();
};

const buildCertificateInspection = (
  expiresAt: string | null,
  checkedAt = new Date().toISOString(),
): LetsEncryptCertificateInspection => {
  if (!expiresAt) {
    return {
      certificateStatus: 'not-installed',
      certificateSummary: 'Certificate not installed.',
      certificateExpiresAt: null,
      certificateDaysRemaining: null,
      certificateStatusCheckedAt: checkedAt,
    };
  }

  const expiryTime = new Date(expiresAt).getTime();
  const daysRemaining = Math.floor(
    (expiryTime - Date.now()) / (1000 * 60 * 60 * 24),
  );

  if (daysRemaining < 0) {
    return {
      certificateStatus: 'expired',
      certificateSummary: `Certificate expired ${Math.abs(daysRemaining)}d ago.`,
      certificateExpiresAt: expiresAt,
      certificateDaysRemaining: daysRemaining,
      certificateStatusCheckedAt: checkedAt,
    };
  }

  if (daysRemaining <= 30) {
    return {
      certificateStatus: 'expiring-soon',
      certificateSummary: `Certificate installed, expires in ${daysRemaining}d.`,
      certificateExpiresAt: expiresAt,
      certificateDaysRemaining: daysRemaining,
      certificateStatusCheckedAt: checkedAt,
    };
  }

  return {
    certificateStatus: 'installed',
    certificateSummary: `Certificate installed, not due for renewal (${daysRemaining}d left).`,
    certificateExpiresAt: expiresAt,
    certificateDaysRemaining: daysRemaining,
    certificateStatusCheckedAt: checkedAt,
  };
};

const runRootShell = async (command: string): Promise<RootShellResult> => {
  try {
    const result = await runRootBinary('/bin/sh', ['-lc', command]);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const shellError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string | null;
    };
    return {
      stdout: shellError.stdout ?? '',
      stderr: shellError.stderr ?? shellError.message,
      exitCode: typeof shellError.code === 'number' ? shellError.code : null,
    };
  }
};

const normalizeDnsProviderToken = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error('dnsProvider must contain only lowercase letters, digits, and hyphens.');
  }
  return normalized;
};

const parseCertificatePemExpiry = (value: string): string | null => {
  const match = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!match) {
    return null;
  }
  try {
    return parseCertificateExpiry(new X509Certificate(match[0]).validTo);
  } catch {
    return null;
  }
};

const parseCertificateOpenSslExpiry = (value: string): string | null => {
  const match = value.match(/notAfter=(.+)/);
  return parseCertificateExpiry(match?.[1] ?? '');
};

const inspectLetsEncryptCertificateLocal = async (
  certificateHostname: string,
): Promise<LetsEncryptCertificateInspection> => {
  const fullchainPath = `/etc/letsencrypt/live/${certificateHostname}/fullchain.pem`;
  const checkedAt = new Date().toISOString();

  try {
    const pemContents = await fs.readFile(fullchainPath, 'utf8');
    const pemExpiresAt = parseCertificatePemExpiry(pemContents);
    if (pemExpiresAt) {
      return buildCertificateInspection(pemExpiresAt, checkedAt);
    }

    try {
      const result = await execFileAsync('openssl', ['x509', '-in', fullchainPath, '-noout', '-enddate']);
      const opensslExpiresAt = parseCertificateOpenSslExpiry(result.stdout);
      if (opensslExpiresAt) {
        return buildCertificateInspection(opensslExpiresAt, checkedAt);
      }
    } catch {
      // Fall through to the existing unknown-status response below.
    }

    return {
      certificateStatus: 'unknown',
      certificateSummary: 'Unable to parse installed certificate expiry.',
      certificateExpiresAt: null,
      certificateDaysRemaining: null,
      certificateStatusCheckedAt: checkedAt,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return buildCertificateInspection(null, checkedAt);
    }
    return {
      certificateStatus: 'unknown',
      certificateSummary: err.message || 'Unable to inspect certificate status.',
      certificateExpiresAt: null,
      certificateDaysRemaining: null,
      certificateStatusCheckedAt: checkedAt,
    };
  }
};

const summarizeCommandFailure = (error: unknown) => {
  const commandError = error as Error & {
    stdout?: string;
    stderr?: string;
    code?: number | string | null;
  };
  return commandError.stderr?.trim()
    || commandError.stdout?.trim()
    || commandError.message
    || `exit code ${commandError.code ?? 'unknown'}`;
};

const buildLetsEncryptResultMetadata = (
  certificateHostname: string,
  letsEncryptLiveDir: string,
  renewDryRunEnabled: boolean,
): LetsEncryptResultMetadata => ({
  certificateHostname,
  certbotLiveDir: letsEncryptLiveDir,
  certbotRenewalConfigPath: `/etc/letsencrypt/renewal/${certificateHostname}.conf`,
  certbotRenewCommand: `${config.certbotBin} renew`,
  renewDryRunEnabled,
});

const ensureCertbotAvailable = async () => {
  if (await binaryExists(config.certbotBin)) {
    return 'certbot is already available';
  }
  if (!(await binaryExists(config.aptGetBin))) {
    throw new Error(
      `certbot is not installed and ${config.aptGetBin} is unavailable for automatic installation.`,
    );
  }
  await runRootBinary(config.aptGetBin, ['update']);
  await runRootBinary(config.aptGetBin, ['install', '-y', 'certbot']);
  if (!(await binaryExists(config.certbotBin))) {
    throw new Error('certbot is still unavailable after installation attempt.');
  }
  return 'Installed certbot with apt-get';
};

const setManagedSymlink = async (targetPath: string, linkPath: string) => {
  await ensureManagedDirectory(path.dirname(linkPath), {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });
  await runRootBinary(config.python3Bin, [
    '-c',
    [
      'import os, sys',
      'target, link = sys.argv[1], sys.argv[2]',
      'try:',
      '    os.unlink(link)',
      'except FileNotFoundError:',
      '    pass',
      'os.symlink(target, link)',
    ].join('\n'),
    targetPath,
    linkPath,
  ]);
};

const persistGoDaddyCredentialsFile = async (
  certificateHostname: string,
  payload: z.infer<typeof letsEncryptDnsDeploySchema>,
) => {
  const apiKey = payload.dnsApiKey?.trim();
  const apiSecret = payload.dnsApiSecret?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error('GoDaddy API key and secret are required for DNS-01 deployment.');
  }

  const credentialsDir = '/etc/letsencrypt/rectrix-godaddy';
  const credentialsPath = `${credentialsDir}/${certificateHostname}.env`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rectrix-godaddy-'));
  const tempPath = path.join(tempDir, 'credentials.env');
  const contents = [
    `GODADDY_API_KEY=${apiKey}`,
    `GODADDY_API_SECRET=${apiSecret}`,
    ...(payload.dnsZone?.trim() ? [`GODADDY_ZONE=${payload.dnsZone.trim()}`] : []),
    '',
  ].join('\n');

  await fs.writeFile(tempPath, contents, { mode: 0o600 });
  try {
    await runRootBinary(config.installBin, [
      '-d',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '700',
      credentialsDir,
    ]);
    await runRootBinary(config.installBin, [
      '-D',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '600',
      tempPath,
      credentialsPath,
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return credentialsPath;
};

const reloadBrokerUnit = async (unit: string) => {
  try {
    await systemctl('reload', [unit]);
    return 'reloaded';
  } catch {
    await systemctl('restart', [unit]);
    return 'restarted';
  }
};

const deployLetsEncryptDns01GoDaddy = async (
  payload: z.infer<typeof letsEncryptDnsDeploySchema>,
): Promise<JobResult> => {
  const certHostname = payload.certificateHostname.trim();
  const contactEmail = payload.contactEmail.trim();
  const sharedMosquittoCertDir = '/etc/mosquitto/certs';
  const mosquittoCertDir = `/etc/mosquitto/certs/${certHostname}`;
  const letsEncryptLiveDir = `/etc/letsencrypt/live/${certHostname}`;
  const defaultMosquittoCertPaths = {
    cafile: '/etc/mosquitto/certs/ca.crt',
    certfile: '/etc/mosquitto/certs/fullchain.pem',
    keyfile: '/etc/mosquitto/certs/privkey.pem',
  };
  const mosquittoCertPaths = {
    cafile: `${mosquittoCertDir}/ca.crt`,
    certfile: `${mosquittoCertDir}/fullchain.pem`,
    keyfile: `${mosquittoCertDir}/privkey.pem`,
  };

  const hookScriptPath = path.join(__dirname, 'godaddyDnsHook.js');
  await fs.access(hookScriptPath);
  const credentialsPath = await persistGoDaddyCredentialsFile(certHostname, payload);
  const authHook = [
    process.execPath,
    hookScriptPath,
    'auth',
    '--credentials-file',
    credentialsPath,
  ].join(' ');
  const cleanupHook = [
    process.execPath,
    hookScriptPath,
    'cleanup',
    '--credentials-file',
    credentialsPath,
  ].join(' ');
  const certbotArgs = [
    'certonly',
    ...(payload.environment === 'staging' ? ['--staging'] : []),
    '--manual',
    '--preferred-challenges',
    'dns',
    '--manual-public-ip-logging-ok',
    '--manual-auth-hook',
    authHook,
    '--manual-cleanup-hook',
    cleanupHook,
    '--agree-tos',
    '--non-interactive',
    '--keep-until-expiring',
    '-m',
    contactEmail,
    '-d',
    certHostname,
  ];
  const certbotCommand = [
    config.certbotBin,
    ...certbotArgs.map((value) => shellEscape(value)),
  ].join(' ');
  const resultMetadata = buildLetsEncryptResultMetadata(
    certHostname,
    letsEncryptLiveDir,
    payload.renewDryRun,
  );

  const steps: LetsEncryptDeployStepResult[] = [];
  let certificateInspection: LetsEncryptCertificateInspection | null = null;
  let dryRunWarning: string | null = null;

  const runBinaryStep = async (
    stepName: string,
    binary: string,
    args: string[],
    allowFailure = false,
    commandPreview = [binary, ...args.map((value) => shellEscape(value))].join(' '),
  ) => {
    try {
      const result = await runRootBinary(binary, args);
      steps.push({
        step: stepName,
        command: commandPreview,
        ok: true,
        exitCode: 0,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      });
      return result;
    } catch (error) {
      const commandError = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string | null;
      };
      steps.push({
        step: stepName,
        command: commandPreview,
        ok: false,
        exitCode: typeof commandError.code === 'number' ? commandError.code : null,
        stdout: truncateOutput(commandError.stdout ?? ''),
        stderr: truncateOutput(commandError.stderr ?? commandError.message),
      });
      if (!allowFailure) {
        throw new Error(`${stepName} failed: ${summarizeCommandFailure(error)}`);
      }
      return {
        stdout: commandError.stdout ?? '',
        stderr: commandError.stderr ?? commandError.message,
      };
    }
  };

  try {
    await runBinaryStep(
      'Ensure certbot availability',
      config.certbotBin,
      ['--version'],
      false,
      `${config.certbotBin} --version`,
    );
  } catch {
    const detail = await ensureCertbotAvailable();
    steps.push({
      step: 'Install certbot',
      command: `${config.aptGetBin} update && ${config.aptGetBin} install -y certbot`,
      ok: true,
      exitCode: 0,
      stdout: detail,
      stderr: '',
    });
  }

  await runBinaryStep('Issue certificate with certbot', config.certbotBin, certbotArgs, false, certbotCommand);
  certificateInspection = await inspectLetsEncryptCertificateLocal(certHostname);

  if (payload.renewDryRun) {
    await runBinaryStep(
      'Run certbot renewal dry-run',
      config.certbotBin,
      ['renew', '--dry-run'],
      true,
      `${config.certbotBin} renew --dry-run`,
    );
    const dryRunStep = steps[steps.length - 1];
    if (dryRunStep && !dryRunStep.ok) {
      dryRunWarning =
        `Renewal dry-run failed after certificate issuance for ${certHostname}. `
        + 'Certificate deployment continued; review the dry-run output before the next renewal window.';
    }
  }

  await ensureManagedDirectory(sharedMosquittoCertDir, {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });
  await ensureManagedDirectory(mosquittoCertDir, {
    mode: '0750',
    owner: 'root',
    group: 'mosquitto',
  });
  steps.push({
    step: 'Prepare mosquitto certificate directories',
    command: `install -d -o root -g mosquitto -m 750 ${sharedMosquittoCertDir} ${mosquittoCertDir}`,
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  if (payload.renewalStrategy === 'copy-and-reload') {
    await installTlsArtifact(`${letsEncryptLiveDir}/fullchain.pem`, mosquittoCertPaths.certfile, '0640');
    await installTlsArtifact(`${letsEncryptLiveDir}/privkey.pem`, mosquittoCertPaths.keyfile, '0640');
    await installTlsArtifact(`${letsEncryptLiveDir}/fullchain.pem`, defaultMosquittoCertPaths.certfile, '0640');
    await installTlsArtifact(`${letsEncryptLiveDir}/privkey.pem`, defaultMosquittoCertPaths.keyfile, '0640');
    steps.push({
      step: 'Copy certificate artifacts to mosquitto paths',
      command: 'install fullchain.pem and privkey.pem into mosquitto certificate paths',
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  } else {
    await setManagedSymlink(`${letsEncryptLiveDir}/fullchain.pem`, mosquittoCertPaths.certfile);
    await setManagedSymlink(`${letsEncryptLiveDir}/privkey.pem`, mosquittoCertPaths.keyfile);
    await installTlsArtifact(`${letsEncryptLiveDir}/fullchain.pem`, defaultMosquittoCertPaths.certfile, '0640');
    await installTlsArtifact(`${letsEncryptLiveDir}/privkey.pem`, defaultMosquittoCertPaths.keyfile, '0640');
    steps.push({
      step: 'Symlink hostname certificate artifacts to mosquitto path',
      command: 'symlink hostname certificate files and copy default broker compatibility files',
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }

  const systemCaBundlePath = await installPublicCaBundle(mosquittoCertPaths.cafile);
  await installTlsArtifact(systemCaBundlePath, defaultMosquittoCertPaths.cafile, '0640');
  steps.push({
    step: 'Install CA bundle for mosquitto',
    command: `install ${systemCaBundlePath} into mosquitto CA bundle paths`,
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  await grantTelegrafTlsAccess([
    mosquittoCertPaths.cafile,
    defaultMosquittoCertPaths.cafile,
  ]);

  const brokerUnits = payload.brokerServices.map((serviceName) => {
    const safeServiceName = assertAllowedServiceName(serviceName, 'mqtt');
    return `${safeServiceName}.service`;
  });

  if (brokerUnits.length > 0) {
    for (const unit of brokerUnits) {
      const action = await reloadBrokerUnit(unit);
      steps.push({
        step: `Reload service ${unit}`,
        command: `systemctl reload ${unit} || systemctl restart ${unit}`,
        ok: true,
        exitCode: 0,
        stdout: action,
        stderr: '',
      });
    }
  } else {
    try {
      const action = await reloadBrokerUnit('mosquitto.service');
      steps.push({
        step: 'Reload default mosquitto service',
        command: 'systemctl reload mosquitto.service || systemctl restart mosquitto.service',
        ok: true,
        exitCode: 0,
        stdout: action,
        stderr: '',
      });
    } catch (error) {
      steps.push({
        step: 'Reload default mosquitto service',
        command: 'systemctl reload mosquitto.service || systemctl restart mosquitto.service',
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: summarizeCommandFailure(error),
      });
    }
  }

  return {
    ok: true,
    summary: `Deployed DNS-01 certificate for ${certHostname}`,
    details: {
      planId: payload.planId,
      ...resultMetadata,
      certbotCommand,
      warning: dryRunWarning,
      steps,
      certificateInspection,
    },
  };
};

const deployLetsEncryptDns01 = async (
  payload: z.infer<typeof letsEncryptDnsDeploySchema>,
): Promise<JobResult> => {
  const dnsProvider = normalizeDnsProviderToken(payload.dnsProvider);
  if (dnsProvider === 'godaddy') {
    return deployLetsEncryptDns01GoDaddy(payload);
  }

  const certHostname = payload.certificateHostname.trim();
  const contactEmail = payload.contactEmail.trim();
  const environmentFlag = payload.environment === 'staging' ? '--staging ' : '';
  const credentialsRef = payload.dnsCredentialsSecretRef?.trim();
  if (credentialsRef && !credentialsRef.startsWith('/')) {
    throw new Error('dnsCredentialsSecretRef must be an absolute file path on the host.');
  }

  const sharedMosquittoCertDir = '/etc/mosquitto/certs';
  const mosquittoCertDir = `/etc/mosquitto/certs/${certHostname}`;
  const letsEncryptLiveDir = `/etc/letsencrypt/live/${certHostname}`;
  const defaultMosquittoCertPaths = {
    cafile: '/etc/mosquitto/certs/ca.crt',
    certfile: '/etc/mosquitto/certs/fullchain.pem',
    keyfile: '/etc/mosquitto/certs/privkey.pem',
  };
  const mosquittoCertPaths = {
    cafile: `${mosquittoCertDir}/ca.crt`,
    certfile: `${mosquittoCertDir}/fullchain.pem`,
    keyfile: `${mosquittoCertDir}/privkey.pem`,
  };

  const systemCaBundlePath = await (async () => {
    for (const candidate of systemCaBundleCandidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error(
      `Unable to locate a system CA bundle. Checked: ${systemCaBundleCandidates.join(', ')}`,
    );
  })();

  const credentialsFlag = credentialsRef
    ? ` --dns-${dnsProvider}-credentials ${shellEscape(credentialsRef)}`
    : '';
  const certbotCommand = [
    `certbot certonly ${environmentFlag}--dns-${dnsProvider}${credentialsFlag} --preferred-challenges dns`.trim(),
    '--agree-tos --non-interactive --keep-until-expiring',
    `-m ${shellEscape(contactEmail)}`,
    `-d ${shellEscape(certHostname)}`,
  ].join(' ');
  const resultMetadata = buildLetsEncryptResultMetadata(
    certHostname,
    letsEncryptLiveDir,
    payload.renewDryRun,
  );

  const steps: LetsEncryptDeployStepResult[] = [];
  let certificateInspection: LetsEncryptCertificateInspection | null = null;
  let dryRunWarning: string | null = null;

  const runStep = async (
    stepName: string,
    command: string,
    allowFailure = false,
  ) => {
    const result = await runRootShell(command);
    steps.push({
      step: stepName,
      command,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(`${stepName} failed: ${summarizeShellFailure(result)}`);
    }
    return result;
  };

  await runStep(
    'Ensure certbot and DNS plugin availability',
    [
      'if command -v certbot >/dev/null 2>&1 && certbot plugins 2>/dev/null | grep -q ' + shellEscape(`dns-${dnsProvider}`) + '; then',
      "  echo 'certbot DNS plugin is already available';",
      '  exit 0;',
      'fi;',
      "echo 'certbot DNS plugin is missing; attempting installation...';",
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive;',
      `  apt-get update && apt-get install -y certbot python3-certbot-dns-${dnsProvider};`,
      'elif command -v dnf >/dev/null 2>&1; then',
      `  dnf install -y certbot python3-certbot-dns-${dnsProvider} || dnf install -y certbot certbot-dns-${dnsProvider};`,
      'elif command -v yum >/dev/null 2>&1; then',
      `  yum install -y certbot python3-certbot-dns-${dnsProvider} || yum install -y certbot certbot-dns-${dnsProvider};`,
      'elif command -v zypper >/dev/null 2>&1; then',
      `  zypper --non-interactive install certbot python3-certbot-dns-${dnsProvider} || zypper --non-interactive install certbot certbot-dns-${dnsProvider};`,
      'else',
      "  echo 'Automatic DNS plugin installation is only implemented for apt/dnf/yum/zypper hosts';",
      '  exit 1;',
      'fi;',
      'if ! command -v certbot >/dev/null 2>&1; then',
      "  echo 'certbot is still unavailable after installation attempt';",
      '  exit 1;',
      'fi;',
      'if ! certbot plugins 2>/dev/null | grep -q ' + shellEscape(`dns-${dnsProvider}`) + '; then',
      `  echo 'certbot DNS plugin dns-${dnsProvider} is still unavailable after installation attempt';`,
      '  exit 1;',
      'fi',
    ].join(' '),
  );

  await runStep('Issue certificate with certbot', certbotCommand);
  certificateInspection = await inspectLetsEncryptCertificateLocal(certHostname);

  if (payload.renewDryRun) {
    await runStep(
      'Run certbot renewal dry-run',
      'certbot renew --dry-run',
      true,
    );
    const dryRunStep = steps[steps.length - 1];
    if (dryRunStep && !dryRunStep.ok) {
      dryRunWarning =
        `Renewal dry-run failed after certificate issuance for ${certHostname}. `
        + 'Certificate deployment continued; review the dry-run output before the next renewal window.';
    }
  }

  await runStep(
    'Prepare mosquitto certificate directories',
    [
      `install -d -o root -g mosquitto -m 750 ${shellEscape(sharedMosquittoCertDir)}`,
      `install -d -o root -g mosquitto -m 750 ${shellEscape(mosquittoCertDir)}`,
    ].join(' && '),
  );

  if (payload.renewalStrategy === 'copy-and-reload') {
    await runStep(
      'Copy certificate artifacts to mosquitto paths',
      [
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/fullchain.pem`)} ${shellEscape(mosquittoCertPaths.certfile)}`,
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/privkey.pem`)} ${shellEscape(mosquittoCertPaths.keyfile)}`,
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/fullchain.pem`)} ${shellEscape(defaultMosquittoCertPaths.certfile)}`,
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/privkey.pem`)} ${shellEscape(defaultMosquittoCertPaths.keyfile)}`,
      ].join(' && '),
    );
  } else {
    await runStep(
      'Symlink hostname certificate artifacts to mosquitto path',
      [
        `ln -sfn ${shellEscape(`${letsEncryptLiveDir}/fullchain.pem`)} ${shellEscape(mosquittoCertPaths.certfile)}`,
        `ln -sfn ${shellEscape(`${letsEncryptLiveDir}/privkey.pem`)} ${shellEscape(mosquittoCertPaths.keyfile)}`,
      ].join(' && '),
    );
    await runStep(
      'Copy broker compatibility certificate artifacts to default mosquitto paths',
      [
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/fullchain.pem`)} ${shellEscape(defaultMosquittoCertPaths.certfile)}`,
        `install -o root -g mosquitto -m 640 ${shellEscape(`${letsEncryptLiveDir}/privkey.pem`)} ${shellEscape(defaultMosquittoCertPaths.keyfile)}`,
      ].join(' && '),
    );
  }

  await runStep(
    'Install CA bundle for mosquitto',
    [
      `install -o root -g mosquitto -m 640 ${shellEscape(systemCaBundlePath)} ${shellEscape(mosquittoCertPaths.cafile)}`,
      `install -o root -g mosquitto -m 640 ${shellEscape(systemCaBundlePath)} ${shellEscape(defaultMosquittoCertPaths.cafile)}`,
    ].join(' && '),
  );

  await grantTelegrafTlsAccess([
    mosquittoCertPaths.cafile,
    defaultMosquittoCertPaths.cafile,
  ]);

  const brokerUnits = payload.brokerServices.map((serviceName) => {
    const safeServiceName = assertAllowedServiceName(serviceName, 'mqtt');
    return `${safeServiceName}.service`;
  });

  if (brokerUnits.length > 0) {
    for (const unit of brokerUnits) {
      await runStep(
        `Reload service ${unit}`,
        `systemctl reload ${shellEscape(unit)} || systemctl restart ${shellEscape(unit)}`,
      );
    }
  } else {
    await runStep(
      'Reload default mosquitto service',
      "if systemctl list-unit-files mosquitto.service >/dev/null 2>&1; then systemctl reload mosquitto.service || systemctl restart mosquitto.service; else echo 'mosquitto.service not found, skipping reload'; fi",
      true,
    );
  }

  return {
    ok: true,
    summary: `Deployed DNS-01 certificate for ${certHostname}`,
    details: {
      planId: payload.planId,
      ...resultMetadata,
      certbotCommand,
      warning: dryRunWarning,
      steps,
      certificateInspection,
    },
  };
};

const grantTelegrafTlsAccess = async (paths: string[]) => {
  const normalizedPaths = [...new Set(
    paths
      .map((value) => value.trim())
      .filter((value) => value.startsWith('/etc/mosquitto/certs/')),
  )];
  if (normalizedPaths.length === 0) {
    return;
  }

  const directoryPaths = [...new Set(
    normalizedPaths.flatMap((value) => buildParentPaths(value, '/etc/mosquitto')),
  )];

  const canUseSetfacl = await binaryExists(config.setfaclBin);

  for (const dirPath of directoryPaths) {
    if (!(await managedPathExists(dirPath))) {
      continue;
    }
    if (canUseSetfacl) {
      await runRootBinary(config.setfaclBin, ['-m', 'u:telegraf:rx', dirPath]);
    } else {
      await runRootBinary(config.chmodBin, ['o+rx', dirPath]);
    }
  }

  for (const filePath of normalizedPaths) {
    if (!(await managedPathExists(filePath))) {
      continue;
    }
    if (requiresAclForTelegraf(filePath)) {
      if (!canUseSetfacl) {
        throw new Error(
          `setfacl is required to grant telegraf access to private key ${filePath}`,
        );
      }
      await runRootBinary(config.setfaclBin, ['-m', 'u:telegraf:r', filePath]);
      continue;
    }
    if (canUseSetfacl) {
      await runRootBinary(config.setfaclBin, ['-m', 'u:telegraf:r', filePath]);
    } else {
      await runRootBinary(config.chmodBin, ['o+r', filePath]);
    }
  }
};

const applyFiles = async (
  payload: z.infer<typeof fileApplySchema>,
  defaultPackages: string[],
): Promise<JobResult> => {
  const packages = payload.installPackages
    ? await aptInstall(
        withDefaultPackages(payload.packages, defaultPackages),
        payload.packageVersions,
      )
    : [];
  const appliedFiles = await writeManagedFiles(payload.files);
  await maybeReloadSystemd(payload.files);

  if (payload.unitsToEnable && payload.unitsToEnable.length > 0) {
    await systemctl('enable', payload.unitsToEnable);
  }
  if (payload.unitsToReload && payload.unitsToReload.length > 0) {
    await systemctl('reload', payload.unitsToReload);
  }
  if (payload.unitsToRestart && payload.unitsToRestart.length > 0) {
    await systemctl('restart', payload.unitsToRestart);
  }

  const touchedUnits = [
    ...(payload.unitsToEnable ?? []),
    ...(payload.unitsToReload ?? []),
    ...(payload.unitsToRestart ?? []),
  ];

  return {
    ok: true,
    summary: `Applied ${appliedFiles.length} files`,
    details: {
      packages,
      appliedFiles,
      unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
    },
  };
};

const removeFiles = async (
  payload: z.infer<typeof fileRemoveSchema>,
  defaultPackages: string[],
): Promise<JobResult> => {
  if (payload.unitsToStop && payload.unitsToStop.length > 0) {
    await systemctl('stop', payload.unitsToStop);
  }
  if (payload.unitsToDisable && payload.unitsToDisable.length > 0) {
    await systemctl('disable', payload.unitsToDisable);
  }

  const removedFiles =
    payload.filesToRemove.length > 0
      ? await removeManagedFiles(payload.filesToRemove)
      : [];
  const packages =
    payload.removePackages
      ? await aptRemove(withDefaultPackages(payload.packages, defaultPackages))
      : [];

  const touchedUnits = [
    ...(payload.unitsToStop ?? []),
    ...(payload.unitsToDisable ?? []),
  ];

  return {
    ok: true,
    summary: `Removed ${removedFiles.length} files`,
    details: {
      packages,
      removedFiles,
      unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
    },
  };
};

const applyBrokerRuntime = async (
  payload: z.infer<typeof brokerApplySchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'mqtt');
  const unit = `${serviceName}.service`;
  const installedPackages: string[] = [];

  if (await ensureRuntimePackage(config.mosquittoCtrlBin, 'mosquitto')) {
    installedPackages.push('mosquitto');
  }

  await ensureManagedDirectory('/etc/mosquitto', { mode: '0755' });
  await ensureManagedDirectory(payload.persistenceLocation, {
    mode: '0755',
    owner: 'mosquitto',
    group: 'mosquitto',
  });

  const preparedTlsFiles = await prepareBrokerTlsFiles(payload);
  await ensureDynsecConfigInitialized(payload);

  const appliedFiles = await writeManagedFiles([
    {
      path: payload.configPath,
      content: `${(await renderBrokerConfigWithDynsec(payload.configContents)).trimEnd()}\n`,
      mode: '0644',
    },
    {
      path: payload.unitPath,
      content: `${payload.unitContents.trimEnd()}\n`,
      mode: '0644',
    },
  ]);

  await systemctl('daemon-reload');
  await systemctl('enable', [unit]);
  await systemctl('restart', [unit]);
  await waitForDynsecReady(payload);
  await reconcileBrokerDynsec(payload);

  return {
    ok: true,
    summary: `Applied broker runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      installedPackages,
      appliedFiles,
      preparedTlsFiles,
      dynsecConfigPath: payload.dynsecConfigPath,
      unitStates: await summarizeUnitStatesForService(serviceName),
    },
  };
};

const controlBrokerRuntime = async (
  payload: z.infer<typeof brokerControlSchema>,
  action: 'start' | 'restart' | 'stop',
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'mqtt');
  const unit = `${serviceName}.service`;
  await systemctl(action, [unit]);
  return {
    ok: true,
    summary: `${action} broker runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitStates: await summarizeUnitStatesForService(serviceName),
    },
  };
};

const removeBrokerRuntime = async (
  payload: z.infer<typeof brokerRemoveSchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'mqtt');
  const unit = `${serviceName}.service`;

  await systemctl('stop', [unit]).catch(() => undefined);
  await systemctl('disable', [unit]).catch(() => undefined);
  await removeManagedFiles([
    payload.configPath,
    payload.dynsecConfigPath,
    payload.unitPath,
  ]);
  await runRootBinary(config.rmBin, ['-rf', payload.persistenceLocation]);
  await systemctl('daemon-reload');

  return {
    ok: true,
    summary: `Removed broker runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitStates: await summarizeUnitStatesForService(serviceName),
    },
  };
};

const loadBrokerRuntimeSnapshot = async (
  payload: z.infer<typeof brokerRuntimeSnapshotSchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'mqtt');
  const unit = `${serviceName}.service`;
  const unitState = await getUnitState(unit);
  const statusOutput = await readUnitStatus(unit, payload.maxLogLines);
  const journalOutput = await readUnitLogs(unit, payload.maxLogLines);



  return {
    ok: true,
    summary: `Broker runtime snapshot for ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitState,
      statusOutput,
      journalOutput,
    },
  };
};

const applyTelegrafRuntime = async (
  payload: z.infer<typeof telegrafRuntimeApplySchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'telegraf');
  const unit = `${serviceName}.service`;
  const installedPackages: string[] = [];

  if (await ensureRuntimePackage('/usr/bin/telegraf', 'telegraf')) {
    installedPackages.push('telegraf');
  }

  await ensureManagedDirectory('/etc/telegraf', { mode: '0755' });
  await ensureManagedDirectory('/etc/telegraf/telegraf.d', { mode: '0755' });

  const appliedFiles = await writeManagedFiles([
    {
      path: payload.configPath,
      content: `${payload.configContents.trimEnd()}\n`,
      mode: '0640',
    },
    {
      path: payload.unitPath,
      content: `${payload.unitContents.trimEnd()}\n`,
      mode: '0644',
    },
  ]);

  await chownManagedPath(payload.configPath, 'telegraf', 'telegraf');
  await chmodManagedPath(payload.configPath, '0640');
  await grantTelegrafTlsAccess(payload.tlsAccessPaths ?? []);
  await systemctl('daemon-reload');
  await systemctl('enable', [unit]);
  await systemctl('restart', [unit]);

  return {
    ok: true,
    summary: `Applied telegraf runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      installedPackages,
      appliedFiles,
      unitStates: await summarizeUnitStatesForService(serviceName),
    },
  };
};

const removeTelegrafRuntime = async (
  payload: z.infer<typeof telegrafRuntimeRemoveSchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'telegraf');
  const unit = `${serviceName}.service`;

  await systemctl('stop', [unit]).catch(() => undefined);
  await systemctl('disable', [unit]).catch(() => undefined);
  await removeManagedFiles([payload.configPath, payload.unitPath]);
  await systemctl('daemon-reload');

  return {
    ok: true,
    summary: `Removed telegraf runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitStates: await summarizeUnitStatesForService(serviceName),
    },
  };
};

const loadTelegrafRuntimeSnapshot = async (
  payload: z.infer<typeof telegrafRuntimeSnapshotSchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'telegraf');
  const unit = `${serviceName}.service`;
  const unitState = await getUnitState(unit);
  const statusOutput = await readUnitStatus(unit, payload.maxLogLines);
  const journalOutput = await readUnitLogs(unit, payload.maxLogLines);

  return {
    ok: true,
    summary: `Telegraf runtime snapshot for ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitState,
      statusOutput,
      journalOutput,
    },
  };
};

const loadMqttDiagnostics = async (
  payload: z.infer<typeof mqttDiagnosticsSchema>,
): Promise<JobResult> => {
  const rawConfig = await fs.readFile(payload.configPath, 'utf8');
  const configData = parsePersistenceConfig(rawConfig);
  const persistenceEnabled = configData.persistence;
  const persistenceLocation = configData.persistenceLocation;
  const databasePath = resolveDbPath(persistenceLocation);

  if (!persistenceEnabled) {
    return {
      ok: true,
      summary: `MQTT diagnostics snapshot for ${payload.serviceName}`,
      details: {
        brokerId: payload.brokerId,
        serviceName: payload.serviceName,
        persistenceEnabled,
        persistenceLocation,
        databasePath,
        tableName: null,
        warning: 'Persistence is disabled for this broker instance.',
        entries: [],
        columns: [],
      },
    };
  }

  if (!(await managedPathExists(databasePath))) {
    return {
      ok: true,
      summary: `MQTT diagnostics snapshot for ${payload.serviceName}`,
      details: {
        brokerId: payload.brokerId,
        serviceName: payload.serviceName,
        persistenceEnabled,
        persistenceLocation,
        databasePath,
        tableName: null,
        warning: 'mqtt.db does not exist yet.',
        entries: [],
        columns: [],
      },
    };
  }

  const tableListScript = [
    'import sqlite3, sys',
    'conn = sqlite3.connect(sys.argv[1])',
    'cur = conn.cursor()',
    'for row in cur.execute("SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name"):',
    '    print(row[0])',
  ].join('\n');
  const tableResult = await runRootBinary(config.python3Bin, [
    '-c',
    tableListScript,
    databasePath,
  ]);
  const tables = parseTableList(tableResult.stdout);
  const tableName = tables.length > 0 ? pickMessageTable(tables) : null;

  if (!tableName) {
    return {
      ok: true,
      summary: `MQTT diagnostics snapshot for ${payload.serviceName}`,
      details: {
        brokerId: payload.brokerId,
        serviceName: payload.serviceName,
        persistenceEnabled,
        persistenceLocation,
        databasePath,
        tableName: null,
        warning: 'No tables found in mqtt.db yet.',
        entries: [],
        columns: [],
      },
    };
  }

  const safeTableName = sanitizeTableName(tableName);
  const dataScript = [
    'import json, sqlite3, sys',
    'conn = sqlite3.connect(sys.argv[1])',
    'conn.row_factory = sqlite3.Row',
    'cur = conn.cursor()',
    `rows = cur.execute("SELECT * FROM ${safeTableName} ORDER BY rowid DESC LIMIT ${payload.maxMessages}").fetchall()`,
    'print(json.dumps([dict(row) for row in rows]))',
  ].join('\n');
  const dataResult = await runRootBinary(config.python3Bin, [
    '-c',
    dataScript,
    databasePath,
  ]);
  const parsed = dataResult.stdout.trim()
    ? (JSON.parse(dataResult.stdout) as Array<Record<string, unknown>>)
    : [];
  const entries = Array.isArray(parsed) ? parsed : [];
  const columns = Array.from(
    new Set(entries.flatMap((entry) => Object.keys(entry))),
  );

  return {
    ok: true,
    summary: `MQTT diagnostics snapshot for ${payload.serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName: payload.serviceName,
      persistenceEnabled,
      persistenceLocation,
      databasePath,
      tableName,
      warning: null,
      entries,
      columns,
    },
  };
};

export const runJob = async (job: AgentJob): Promise<JobResult> => {
  switch (job.type) {
    case 'agent.diagnostics.snapshot': {
      const payload = diagnosticsSchema.parse(job.payload ?? {});
      return {
        ok: true,
        summary: `Captured agent diagnostics on ${config.hostname}`,
        details: {
          timestamp: new Date().toISOString(),
          hostname: config.hostname,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          agentVersion: config.agentVersion,
          requestedControlPlaneMode: config.controlPlaneMode,
          controlPlaneAuthMode: config.controlPlaneAuthMode,
          managerApiConfigured: Boolean(config.managerApiUrl),
          wssConfigured: Boolean(config.wssUrl),
          capabilities: config.capabilities,
          processId: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          runAsUser: safeUsername(),
          note: payload.note ?? null,
          requestedBy: payload.requestedBy ?? null,
          expectedTransportMode: payload.expectedTransportMode ?? null,
        },
      };
    }
    case 'agent.update':
      return queueAgentSelfUpdate(agentUpdateSchema.parse(job.payload));
    case 'stack.install': {
      const payload = stackSchema.parse(job.payload);
      const packages = await aptInstall(
        withDefaultPackages(payload.packages, ['mosquitto', 'telegraf']),
        payload.packageVersions,
      );
      if (payload.unitsToEnable && payload.unitsToEnable.length > 0) {
        await systemctl('enable', payload.unitsToEnable);
      }
      if (payload.unitsToStart && payload.unitsToStart.length > 0) {
        await systemctl('restart', payload.unitsToStart);
      }
      const touchedUnits = [
        ...(payload.unitsToEnable ?? []),
        ...(payload.unitsToStart ?? []),
      ];
      return {
        ok: true,
        summary: `Installed ${packages.join(', ')}`,
        details: {
          packages,
          unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
        },
      };
    }
    case 'stack.remove': {
      const payload = stackSchema.parse(job.payload);
      if (payload.unitsToStop && payload.unitsToStop.length > 0) {
        await systemctl('stop', payload.unitsToStop);
      }
      if (payload.unitsToDisable && payload.unitsToDisable.length > 0) {
        await systemctl('disable', payload.unitsToDisable);
      }
      const packages = await aptRemove(
        withDefaultPackages(payload.packages, ['telegraf', 'mosquitto']),
      );
      const touchedUnits = [
        ...(payload.unitsToStop ?? []),
        ...(payload.unitsToDisable ?? []),
      ];
      return {
        ok: true,
        summary: `Removed ${packages.join(', ')}`,
        details: {
          packages,
          unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
        },
      };
    }
    case 'mqtt.diagnostics.snapshot':
      return loadMqttDiagnostics(mqttDiagnosticsSchema.parse(job.payload));
    case 'broker.runtime.snapshot':
      return loadBrokerRuntimeSnapshot(
        brokerRuntimeSnapshotSchema.parse(job.payload),
      );
    case 'broker.apply':
      return applyBrokerRuntime(brokerApplySchema.parse(job.payload));
    case 'broker.start':
      return controlBrokerRuntime(brokerControlSchema.parse(job.payload), 'start');
    case 'broker.restart':
      return controlBrokerRuntime(
        brokerControlSchema.parse(job.payload),
        'restart',
      );
    case 'broker.stop':
      return controlBrokerRuntime(brokerControlSchema.parse(job.payload), 'stop');
    case 'broker.remove':
      return removeBrokerRuntime(brokerRemoveSchema.parse(job.payload));
    case 'broker.config.apply':
      return applyFiles(fileApplySchema.parse(job.payload), ['mosquitto']);
    case 'mosquitto.acl.sync':
      return applyFiles(fileApplySchema.parse(job.payload), ['mosquitto']);
    case 'letsencrypt.dns01.deploy':
      return deployLetsEncryptDns01(letsEncryptDnsDeploySchema.parse(job.payload));
    case 'telegraf.runtime.snapshot':
      return loadTelegrafRuntimeSnapshot(
        telegrafRuntimeSnapshotSchema.parse(job.payload),
      );
    case 'telegraf.apply':
      if (job.payload && typeof job.payload === 'object' && 'configPath' in job.payload) {
        return applyTelegrafRuntime(
          telegrafRuntimeApplySchema.parse(job.payload),
        );
      }
      return applyFiles(fileApplySchema.parse(job.payload), ['telegraf']);
    case 'telegraf.remove':
      if (
        job.payload &&
        typeof job.payload === 'object' &&
        'configPath' in job.payload &&
        'unitPath' in job.payload
      ) {
        return removeTelegrafRuntime(
          telegrafRuntimeRemoveSchema.parse(job.payload),
        );
      }
      return removeFiles(fileRemoveSchema.parse(job.payload), ['telegraf']);
    default: {
      throw new Error(`Unsupported job type: ${job.type}`);
    }
  }
};
