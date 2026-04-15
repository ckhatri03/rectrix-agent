import { AgentService } from './agent';
import { logger } from './logger';

const main = async () => {
  const service = new AgentService();
  await service.start();
};

main().catch((error) => {
  logger.error({ error }, 'agent crashed');
  process.exitCode = 1;
});

