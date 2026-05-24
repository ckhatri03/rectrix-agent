import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { config } from './config';
import { updateEnvFile } from './envFile';
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

const brokerCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string(),
});

const brokerApplySchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  passwordFilePath: z.string().min(1),
  persistenceLocation: z.string().min(1),
  unitPath: z.string().min(1),
  configContents: z.string(),
  unitContents: z.string(),
  mqttCredentials: z.array(brokerCredentialSchema).default([]),
});

const brokerControlSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
});

const brokerRuntimeSnapshotSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  maxLogLines: z.number().int().positive().max(500).optional().default(20),
  metrics: z
    .object({
      username: z.string().min(1),
      password: z.string(),
      mqttsPort: z.number().int().positive(),
      cafile: z.string().min(1),
    })
    .optional(),
});

const brokerRemoveSchema = z.object({
  brokerId: z.number().int().positive(),
  serviceName: z.string().min(1),
  configPath: z.string().min(1),
  passwordFilePath: z.string().min(1),
  aclFilePath: z.string().min(1),
  persistenceLocation: z.string().min(1),
  unitPath: z.string().min(1),
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
    '  if [ -f "$ENV_FILE" ] || [ -w "$(dirname "$ENV_FILE")" ]; then',
    '    if grep -q "^AGENT_VERSION=" "$ENV_FILE" 2>/dev/null; then',
    '      sed -i "s|^AGENT_VERSION=.*$|AGENT_VERSION=$TARGET_VERSION|" "$ENV_FILE"',
    '    else',
    '      printf "AGENT_VERSION=%s\\n" "$TARGET_VERSION" >> "$ENV_FILE"',
    '    fi',
    '  fi',
    '  if [ ! -f "$SERVICE_LOG_PATH" ]; then',
    '    sudo install -m 0640 -o rectrix-agent -g rectrix-agent /dev/null "$SERVICE_LOG_PATH"',
    '  fi',
    '  rm -rf "$BACKUP_APP_DIR"',
    '  mv "$APP_DIR" "$BACKUP_APP_DIR"',
    '  mv "$NEXT_APP_DIR" "$APP_DIR"',
    '  sudo systemctl restart "$SERVICE_NAME"',
    '} >> "$LOG_PATH" 2>&1',
  ].join('\n');

  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  await updateEnvFile(config.envFilePath, { AGENT_VERSION: payload.version }).catch(
    () => undefined,
  );

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

const syncMosquittoPasswords = async (
  passwordFilePath: string,
  credentials: Array<{ username: string; password: string }>,
) => {
  await ensureManagedFile(passwordFilePath, {
    mode: '0640',
    owner: 'mosquitto',
    group: 'mosquitto',
  });

  for (const credential of credentials) {
    await runRootBinary(config.mosquittoPasswdBin, [
      '-b',
      passwordFilePath,
      credential.username,
      credential.password,
    ]);
  }

  await chownManagedPath(passwordFilePath, 'mosquitto', 'mosquitto');
  await chmodManagedPath(passwordFilePath, '0640');
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

  await ensureManagedDirectory('/etc/mosquitto', { mode: '0755' });
  await ensureManagedDirectory(payload.persistenceLocation, {
    mode: '0755',
    owner: 'mosquitto',
    group: 'mosquitto',
  });

  const appliedFiles = await writeManagedFiles([
    {
      path: payload.configPath,
      content: `${payload.configContents.trimEnd()}\n`,
      mode: '0644',
    },
    {
      path: payload.unitPath,
      content: `${payload.unitContents.trimEnd()}\n`,
      mode: '0644',
    },
  ]);

  await syncMosquittoPasswords(
    payload.passwordFilePath,
    payload.mqttCredentials ?? [],
  );
  await systemctl('daemon-reload');
  await systemctl('enable', [unit]);

  return {
    ok: true,
    summary: `Applied broker runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      appliedFiles,
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
    payload.passwordFilePath,
    payload.aclFilePath,
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

  let sysMetricsOutput = '';
  if (payload.metrics) {
    if (!(await binaryExists(config.mosquittoSubBin))) {
      throw new Error(
        'mosquitto_sub is required to read MQTT metrics. Install the mosquitto-clients package on the broker host.',
      );
    }

    const metricArgs = [
      '-v',
      '-h',
      '127.0.0.1',
      '-p',
      String(payload.metrics.mqttsPort),
      '--cafile',
      payload.metrics.cafile,
      '--insecure',
      '-u',
      payload.metrics.username,
      '-P',
      payload.metrics.password,
      '-t',
      '$SYS/broker/clients/connected',
      '-t',
      '$SYS/broker/messages/received',
      '-t',
      '$SYS/broker/messages/sent',
      '-C',
      '3',
      '-W',
      '5',
    ];
    const metricResult = await runRootBinary(config.mosquittoSubBin, metricArgs);
    sysMetricsOutput = metricResult.stdout.trim();
  }

  return {
    ok: true,
    summary: `Broker runtime snapshot for ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
      unitState,
      statusOutput,
      journalOutput,
      sysMetricsOutput,
    },
  };
};

const applyTelegrafRuntime = async (
  payload: z.infer<typeof telegrafRuntimeApplySchema>,
): Promise<JobResult> => {
  const serviceName = assertAllowedServiceName(payload.serviceName, 'telegraf');
  const unit = `${serviceName}.service`;

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

  return {
    ok: true,
    summary: `Applied telegraf runtime ${serviceName}`,
    details: {
      brokerId: payload.brokerId,
      serviceName,
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
