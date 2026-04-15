import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  base: {
    service: 'rectrix-agent',
    version: config.agentVersion,
  },
});

