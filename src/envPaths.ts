const trimEnvValue = (value: string | undefined) =>
  value && value.trim() ? value.trim() : undefined;

export const DEFAULT_AGENT_ENV_FILE_PATH = '/etc/rectrix-agent/agent.env';
export const DEFAULT_STATE_FILE_PATH = '/var/lib/rectrix-agent/state.json';
export const DEFAULT_LOCAL_LOG_FILE_PATH = '/var/log/rectrix-agent.log';

export const resolveAgentEnvFilePath = () =>
  trimEnvValue(process.env.AGENT_ENV_FILE_PATH) ?? DEFAULT_AGENT_ENV_FILE_PATH;

export const resolveStateFilePath = () =>
  trimEnvValue(process.env.STATE_FILE) ?? DEFAULT_STATE_FILE_PATH;
