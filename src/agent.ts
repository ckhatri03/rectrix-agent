import { promises as fs } from 'node:fs';
import os from 'node:os';
import { config } from './config';
import { runJob } from './jobHandlers';
import { logger } from './logger';
import { ManagerClient } from './managerClient';
import { loadState, saveState } from './stateStore';
import { AgentState, SystemInfo } from './types';

const delay = async (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const readOsRelease = async () => {
  try {
    const raw = await fs.readFile('/etc/os-release', 'utf8');
    const fields = Object.fromEntries(
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [key, ...rest] = line.split('=');
          return [key, rest.join('=').replace(/^"|"$/g, '')];
        }),
    );
    return {
      os: (fields.ID as string | undefined) ?? process.platform,
      osVersion: (fields.VERSION_ID as string | undefined) ?? 'unknown',
    };
  } catch {
    return { os: process.platform, osVersion: 'unknown' };
  }
};

const getSystemInfo = async (): Promise<SystemInfo> => {
  const release = await readOsRelease();
  return {
    hostname: config.hostname,
    os: release.os,
    osVersion: release.osVersion,
    arch: os.arch(),
  };
};

export class AgentService {
  private state: AgentState = {};
  private stopped = false;

  async start(): Promise<void> {
    const persistedState = await loadState(config.stateFile);
    this.state = {
      ...persistedState,
      managerApiUrl: config.managerApiUrl ?? persistedState.managerApiUrl,
      agentId: config.agentId ?? persistedState.agentId,
      bootstrapToken: config.bootstrapToken ?? persistedState.bootstrapToken,
      runtimeToken: config.runtimeToken ?? persistedState.runtimeToken,
      pollIntervalMs: persistedState.pollIntervalMs ?? config.pollIntervalMs,
      heartbeatIntervalMs:
        persistedState.heartbeatIntervalMs ?? config.heartbeatIntervalMs,
    };

    const system = await getSystemInfo();
    await this.bootstrap(system);

    process.on('SIGINT', () => {
      this.stopped = true;
    });
    process.on('SIGTERM', () => {
      this.stopped = true;
    });

    const client = new ManagerClient(this.state, system);
    const authToken = this.state.runtimeToken ?? this.state.bootstrapToken;
    if (!this.state.agentId || !authToken) {
      throw new Error('Agent bootstrap did not yield agent credentials');
    }

    await client.sendCapabilities(authToken, config.capabilities);

    logger.info(
      {
        agentId: this.state.agentId,
        managerApiUrl: this.state.managerApiUrl,
        hostname: system.hostname,
      },
      'rectrix-agent started',
    );

    await Promise.all([
      this.heartbeatLoop(client, authToken),
      this.jobLoop(client, authToken),
    ]);
  }

  private async bootstrap(system: SystemInfo): Promise<void> {
    const client = new ManagerClient(this.state, system);

    if (!this.state.agentId || !(this.state.bootstrapToken || this.state.runtimeToken)) {
      logger.info('no persisted agent credentials found, activating');
      this.state = { ...this.state, ...(await client.activate()) };
      await saveState(config.stateFile, this.state);
    }

    const enrollmentToken = this.state.runtimeToken ?? this.state.bootstrapToken;
    if (!enrollmentToken) {
      throw new Error('Missing bootstrap or runtime token after activation');
    }

    logger.info({ agentId: this.state.agentId }, 'enrolling with manager');
    this.state = { ...this.state, ...(await client.enroll(enrollmentToken)) };
    await saveState(config.stateFile, this.state);
  }

  private async heartbeatLoop(
    client: ManagerClient,
    authToken: string,
  ): Promise<void> {
    while (!this.stopped) {
      try {
        await client.sendHeartbeat(authToken, config.capabilities);
        logger.debug('heartbeat sent');
      } catch (error) {
        logger.error({ error }, 'heartbeat failed');
      }
      await delay(this.state.heartbeatIntervalMs ?? config.heartbeatIntervalMs);
    }
  }

  private async jobLoop(client: ManagerClient, authToken: string): Promise<void> {
    while (!this.stopped) {
      try {
        const job = await client.fetchNextJob(authToken, config.capabilities);
        if (!job) {
          await delay(this.state.pollIntervalMs ?? config.pollIntervalMs);
          continue;
        }

        logger.info({ jobId: job.id, jobType: job.type }, 'running job');
        await client.sendJobEvent(authToken, job.id, 'info', 'job accepted');

        try {
          const result = await runJob(job);
          await client.completeJob(authToken, job.id, 'succeeded', {
            summary: result.summary,
            details: result.details,
          });
          logger.info({ jobId: job.id, jobType: job.type }, 'job completed');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await client.sendJobEvent(authToken, job.id, 'error', message);
          await client.completeJob(authToken, job.id, 'failed', undefined, message);
          logger.error({ error, jobId: job.id, jobType: job.type }, 'job failed');
        }
      } catch (error) {
        logger.error({ error }, 'job poll failed');
        await delay(this.state.pollIntervalMs ?? config.pollIntervalMs);
      }
    }
  }
}
