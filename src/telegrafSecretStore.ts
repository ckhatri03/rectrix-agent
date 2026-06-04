import { spawn } from 'node:child_process';

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

const shellEscape = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

const runCommandWithInput = (
  command: string,
  args: string[],
  input: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
            || `Command ${command} exited with code ${code ?? 'unknown'}`,
        ),
      );
    });

    child.stdin.write(`${input}\n`);
    child.stdin.end();
  });

const setSecretWithRunuser = async (
  configPath: string,
  storeId: string,
  secretKey: string,
  secretValue: string,
) => {
  await runCommandWithInput(
    'runuser',
    [
      '-u',
      'telegraf',
      '--',
      TELEGRAF_BIN,
      '--config',
      configPath,
      'secrets',
      'set',
      storeId,
      secretKey,
    ],
    secretValue,
  );
};

const setSecretWithSu = async (
  configPath: string,
  storeId: string,
  secretKey: string,
  secretValue: string,
) => {
  const command = `${shellEscape(TELEGRAF_BIN)} --config ${shellEscape(configPath)} secrets set ${shellEscape(storeId)} ${shellEscape(secretKey)}`;
  await runCommandWithInput(
    'su',
    ['-s', '/bin/sh', 'telegraf', '-c', command],
    secretValue,
  );
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

  try {
    await setSecretWithRunuser(payload.configPath, secretStoreId, secretKey, secretValue);
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (maybeErr?.code !== 'ENOENT') {
      throw error;
    }
    await setSecretWithSu(payload.configPath, secretStoreId, secretKey, secretValue);
  }

  return {
    authMode,
    keyringEntry,
    secretStoreId,
    secretKey,
    updated: true,
  };
};
