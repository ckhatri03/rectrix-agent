import { logger } from './logger';
import { buildStartupErrorContext, validateStartupEnvironment } from './startupDiagnostics';

const main = async () => {
  await validateStartupEnvironment();
  const { AgentService } = await import('./agent');
  const service = new AgentService();
  await service.start();
};

main().catch((error) => {
  logger.error({ err: error, startup: buildStartupErrorContext(error) }, 'agent crashed');
  process.exitCode = 1;
});
