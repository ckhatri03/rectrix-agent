import pino from 'pino';
import { createLocalLogStream } from './localLog';
import { DEFAULT_LOCAL_LOG_FILE_PATH } from './envPaths';
import packageJson from '../package.json';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'rectrix-agent',
    version: process.env.AGENT_VERSION ?? packageJson.version,
  },
}, createLocalLogStream(DEFAULT_LOCAL_LOG_FILE_PATH));
