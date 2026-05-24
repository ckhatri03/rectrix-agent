import { constants, promises as fs } from 'node:fs';
import dotenv from 'dotenv';
import {
  DEFAULT_LOCAL_LOG_FILE_PATH,
  resolveAgentEnvFilePath,
  resolveStateFilePath,
} from './envPaths';

export class StartupConfigurationError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StartupConfigurationError';
  }
}

const hasValue = (value: string | undefined) => Boolean(value && value.trim());

const loadPersistedStateSummary = async (stateFilePath: string) => {
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      exists: true,
      hasAgentId: hasValue(typeof parsed.agentId === 'string' ? parsed.agentId : undefined),
      hasRuntimeToken: hasValue(
        typeof parsed.runtimeToken === 'string' ? parsed.runtimeToken : undefined,
      ),
      hasBootstrapToken: hasValue(
        typeof parsed.bootstrapToken === 'string' ? parsed.bootstrapToken : undefined,
      ),
      hasManagerApiUrl: hasValue(
        typeof parsed.managerApiUrl === 'string' ? parsed.managerApiUrl : undefined,
      ),
      hasWssUrl: hasValue(
        typeof parsed.wssUrl === 'string' ? parsed.wssUrl : undefined,
      ),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        exists: false,
        hasAgentId: false,
        hasRuntimeToken: false,
        hasBootstrapToken: false,
        hasManagerApiUrl: false,
        hasWssUrl: false,
      };
    }
    throw new StartupConfigurationError('Failed to read persisted agent state', {
      stateFilePath,
      code: err.code ?? 'UNKNOWN',
      detail: err.message,
    });
  }
};

export const validateStartupEnvironment = async (): Promise<void> => {
  const envFilePath = resolveAgentEnvFilePath();
  const stateFilePath = resolveStateFilePath();

  let envContents = '';
  try {
    await fs.access(envFilePath, constants.R_OK);
    envContents = await fs.readFile(envFilePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new StartupConfigurationError('agent.env is missing or unreadable', {
      envFilePath,
      code: err.code ?? 'UNKNOWN',
      detail: err.message,
      remediation:
        'Create the env file, verify permissions, and set MANAGER_API_URL plus either activation or runtime credentials.',
    });
  }

  const parsedEnv = dotenv.parse(envContents);
  const persistedState = await loadPersistedStateSummary(stateFilePath);

  const managerApiUrl = process.env.MANAGER_API_URL ?? parsedEnv.MANAGER_API_URL;
  const wssUrl = process.env.WSS_URL ?? parsedEnv.WSS_URL;

  const activationCode = process.env.AGENT_ACTIVATION_CODE ?? parsedEnv.AGENT_ACTIVATION_CODE;
  if (hasValue(activationCode) && !/^[A-Z0-9]{24}$/.test(activationCode!.trim().toUpperCase())) {
    throw new StartupConfigurationError('AGENT_ACTIVATION_CODE must be 24 uppercase alphanumeric characters', {
      envFilePath,
      invalidKey: 'AGENT_ACTIVATION_CODE',
    });
  }

  const hasRuntimeCredentials =
    hasValue(process.env.AGENT_ID ?? parsedEnv.AGENT_ID)
    && hasValue(process.env.AGENT_RUNTIME_TOKEN ?? parsedEnv.AGENT_RUNTIME_TOKEN);
  const hasBootstrapCredentials = hasValue(
    process.env.AGENT_BOOTSTRAP_TOKEN ?? parsedEnv.AGENT_BOOTSTRAP_TOKEN,
  );
  const hasActivationCredential = hasValue(activationCode);
  const hasPersistedCredentials =
    persistedState.hasAgentId
    && (persistedState.hasRuntimeToken || persistedState.hasBootstrapToken);
  const hasPersistedRuntimeCredentials =
    persistedState.hasAgentId && persistedState.hasRuntimeToken;
  const hasRuntimePath = hasRuntimeCredentials || hasPersistedRuntimeCredentials;
  const hasManagerApiUrl = hasValue(managerApiUrl) || persistedState.hasManagerApiUrl;
  const hasWssUrl = hasValue(wssUrl) || persistedState.hasWssUrl;

  if (
    !hasRuntimeCredentials
    && !hasBootstrapCredentials
    && !hasActivationCredential
    && !hasPersistedCredentials
  ) {
    throw new StartupConfigurationError('No activation or runtime credentials are available for agent startup', {
      envFilePath,
      stateFilePath,
      remediation:
        'Provide AGENT_ACTIVATION_CODE, AGENT_BOOTSTRAP_TOKEN, or AGENT_ID with AGENT_RUNTIME_TOKEN, or restore the persisted state file.',
    });
  }

  if (!hasManagerApiUrl && !hasRuntimePath) {
    throw new StartupConfigurationError('MANAGER_API_URL is missing', {
      envFilePath,
      stateFilePath,
      remediation:
        'Set MANAGER_API_URL in agent.env or restore a persisted state file with the manager URL.',
    });
  }

  if (hasRuntimePath && !hasManagerApiUrl && !hasWssUrl) {
    throw new StartupConfigurationError('No control-plane endpoint is configured for the persisted/runtime agent credentials', {
      envFilePath,
      stateFilePath,
      remediation:
        'Set MANAGER_API_URL for HTTP mode or WSS_URL for websocket mode, or restore persisted state with one of those endpoints.',
    });
  }
};

export const buildStartupErrorContext = (error: unknown) => {
  const err = error as Partial<Error> & { code?: string };
  return {
    envFilePath: resolveAgentEnvFilePath(),
    stateFilePath: resolveStateFilePath(),
    localLogFilePath: DEFAULT_LOCAL_LOG_FILE_PATH,
    processId: process.pid,
    cwd: process.cwd(),
    nodeVersion: process.version,
    errorName: err?.name ?? typeof error,
    errorCode: err?.code,
    errorMessage: err?.message ?? String(error),
    errorStack: err?.stack,
    errorDetails:
      error instanceof StartupConfigurationError
        ? error.details
        : error && typeof error === 'object' && 'responseText' in error
          ? {
              status: 'status' in error ? error.status : undefined,
              responseText: error.responseText,
            }
          : undefined,
  };
};
