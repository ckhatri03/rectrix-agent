import { spawn } from 'node:child_process';
import { config } from './config';

type TimescaleSecretPayload = {
  configPath: string;
  timescaleAuthMode?: string;
  timescaleKeyringEntry?: string | null;
  timescaleSecretStoreId?: string | null;
  timescaleSecretKey?: string | null;
  timescaleSecretConnection?: string | null;
  timescaleConnectionString?: string | null;
  timescalePassword?: string | null;
};

type TimescaleSecretResult = {
  authMode: string;
  keyringEntry: string | null;
  secretStoreId: string | null;
  secretKey: string | null;
  updated: boolean;
};

const TELEGRAF_BIN = '/usr/bin/telegraf';

const runCommand = (
  command: string,
  args: string[],
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim()
            || stdout.trim()
            || `Command ${command} exited with code ${code ?? 'unknown'}` ,
        ),
      );
    });
  });

const runTelegrafSecretSetAsUser = async (
  configPath: string,
  storeId: string,
  secretKey: string,
  secretValue: string,
) => {
  const pythonScript = [
    'import os, pwd, subprocess, sys',
    "username = 'telegraf'",
    'pw = pwd.getpwnam(username)',
    'def demote():',
    '    os.initgroups(username, pw.pw_gid)',
    '    os.setgid(pw.pw_gid)',
    '    os.setuid(pw.pw_uid)',
    'cmd = [sys.argv[1], "--config", sys.argv[2], "secrets", "set", sys.argv[3], sys.argv[4], sys.argv[5]]',
    'completed = subprocess.run(cmd, text=True, preexec_fn=demote)',
    'raise SystemExit(completed.returncode)',
  ].join('\n');

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const command = isRoot ? config.python3Bin : config.sudoBin;
  const args = isRoot
    ? ['-c', pythonScript, TELEGRAF_BIN, configPath, storeId, secretKey, secretValue]
    : [config.python3Bin, '-c', pythonScript, TELEGRAF_BIN, configPath, storeId, secretKey, secretValue];

  await runCommand(command, args);
};

const resolveSecretValue = (payload: TimescaleSecretPayload) => {
  if (payload.timescaleSecretConnection?.trim()) {
    return payload.timescaleSecretConnection.trim();
  }

  const connectionString = payload.timescaleConnectionString?.trim();
  if (!connectionString) {
    return null;
  }

  if (!payload.timescalePassword) {
    return connectionString;
  }

  try {
    const url = new URL(connectionString);
    if (!url.password) {
      url.password = payload.timescalePassword;
    }
    return url.toString();
  } catch {
    return connectionString;
  }
};

export const prepareTimescaleSecretStore = async (
  payload: TimescaleSecretPayload,
): Promise<TimescaleSecretResult> => {
  const authMode = payload.timescaleAuthMode ?? 'legacy_inline_dsn';
  const keyringEntry = payload.timescaleKeyringEntry ?? null;
  const secretStoreId = payload.timescaleSecretStoreId ?? null;
  const secretKey = payload.timescaleSecretKey ?? null;

  if (authMode !== 'os_keyring') {
    return {
      authMode,
      keyringEntry,
      secretStoreId,
      secretKey,
      updated: false,
    };
  }

  if (!secretStoreId || !secretKey) {
    throw new Error('Telegraf keyring payload is missing the secret store identifier.');
  }

  const secretValue = resolveSecretValue(payload);
  if (!secretValue) {
    throw new Error('Telegraf keyring payload is missing the Timescale connection secret.');
  }

  await runTelegrafSecretSetAsUser(
    payload.configPath,
    secretStoreId,
    secretKey,
    secretValue,
  );

  return {
    authMode,
    keyringEntry,
    secretStoreId,
    secretKey,
    updated: true,
  };
};
