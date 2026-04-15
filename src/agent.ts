import { promises as fs } from 'node:fs';
import os from 'node:os';
import { config } from './config';
import { createControlPlaneTransport } from './controlPlane';
import { ControlPlaneTransport } from './controlPlane/types';
import { updateEnvFile } from './envFile';
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
  private transport: ControlPlaneTransport | null = null;

  async start(): Promise<void> {
    const persistedState = await loadState(config.stateFile);
    this.state = {
      ...persistedState,
      managerApiUrl: config.managerApiUrl ?? persistedState.managerApiUrl,
      wssUrl: config.wssUrl ?? persistedState.wssUrl,
      agentId: config.agentId ?? persistedState.agentId,
      bootstrapToken: config.bootstrapToken ?? persistedState.bootstrapToken,
      runtimeToken: config.runtimeToken ?? persistedState.runtimeToken,
      pollIntervalMs: persistedState.pollIntervalMs ?? config.pollIntervalMs,
      heartbeatIntervalMs:
        persistedState.heartbeatIntervalMs ?? config.heartbeatIntervalMs,
      requestedControlPlaneMode:
        persistedState.requestedControlPlaneMode ?? config.controlPlaneMode,
      activeControlPlaneMode: persistedState.activeControlPlaneMode,
      requestedControlPlaneAuthMode:
        persistedState.requestedControlPlaneAuthMode ?? config.controlPlaneAuthMode,
      activeControlPlaneAuthMode: persistedState.activeControlPlaneAuthMode,
      lastSuccessfulWssConnectAt: persistedState.lastSuccessfulWssConnectAt,
      lastFallbackReason: persistedState.lastFallbackReason,
    };

    const system = await getSystemInfo();
    await this.bootstrap(system);

    process.on('SIGINT', () => {
      this.stopped = true;
      void this.transport?.stop();
    });
    process.on('SIGTERM', () => {
      this.stopped = true;
      void this.transport?.stop();
    });

    const authToken = this.state.runtimeToken ?? this.state.bootstrapToken;
    if (!this.state.agentId || !authToken) {
      throw new Error('Agent bootstrap did not yield agent credentials');
    }

    this.transport = await createControlPlaneTransport({
      state: this.state,
      system,
      authToken,
      capabilities: config.capabilities,
      onStateChange: async (update) => {
        await this.updateState(update);
      },
    });

    await this.transport.sendCapabilities();

    logger.info(
      {
        agentId: this.state.agentId,
        managerApiUrl: this.state.managerApiUrl,
        wssUrl: this.state.wssUrl,
        hostname: system.hostname,
        requestedControlPlaneMode: this.state.requestedControlPlaneMode,
        activeControlPlaneMode: this.transport.mode,
        activeControlPlaneAuthMode: this.transport.authMode,
        lastFallbackReason: this.state.lastFallbackReason,
      },
      'rectrix-agent started',
    );

    try {
      await Promise.all([
        this.heartbeatLoop(this.transport),
        this.jobLoop(this.transport),
      ]);
    } finally {
      await this.transport.stop();
    }
  }

  private async persistRuntimeCredentials(): Promise<void> {
    if (!this.state.agentId || !this.state.runtimeToken) {
      return;
    }

    await updateEnvFile(config.envFilePath, {
      MANAGER_API_URL: this.state.managerApiUrl ?? '',
      WSS_URL: this.state.wssUrl ?? '',
      AGENT_ID: this.state.agentId,
      AGENT_RUNTIME_TOKEN: this.state.runtimeToken,
      AGENT_BOOTSTRAP_TOKEN: '',
      AGENT_ACTIVATION_CODE: '',
      POLL_INTERVAL_MS: String(
        this.state.pollIntervalMs ?? config.pollIntervalMs,
      ),
      HEARTBEAT_INTERVAL_MS: String(
        this.state.heartbeatIntervalMs ?? config.heartbeatIntervalMs,
      ),
      CONTROL_PLANE_MODE:
        this.state.requestedControlPlaneMode ?? config.controlPlaneMode,
      CONTROL_PLANE_AUTH_MODE:
        this.state.requestedControlPlaneAuthMode ?? config.controlPlaneAuthMode,
    });
  }

  private async updateState(update: Partial<AgentState>): Promise<void> {
    Object.assign(this.state, update);
    await saveState(config.stateFile, this.state);
  }

  private async bootstrap(system: SystemInfo): Promise<void> {
    const client = new ManagerClient(this.state, system);

    if (!this.state.agentId || !(this.state.bootstrapToken || this.state.runtimeToken)) {
      logger.info('no persisted agent credentials found, activating');
      await this.updateState(await client.activate());
    }

    if (this.state.runtimeToken) {
      await this.persistRuntimeCredentials();
      return;
    }

    const enrollmentToken = this.state.bootstrapToken;
    if (!enrollmentToken) {
      throw new Error('Missing bootstrap token after activation');
    }

    logger.info({ agentId: this.state.agentId }, 'enrolling with manager');
    await this.updateState(await client.enroll(enrollmentToken));
    await this.persistRuntimeCredentials();
  }

  private heartbeatDelayMs(transport: ControlPlaneTransport): number {
    if (transport.mode === 'wss') {
      return config.wssPingIntervalMs;
    }
    return this.state.heartbeatIntervalMs ?? config.heartbeatIntervalMs;
  }

  private async heartbeatLoop(transport: ControlPlaneTransport): Promise<void> {
    while (!this.stopped) {
      try {
        await transport.sendHeartbeat();
        logger.debug('heartbeat sent');
      } catch (error) {
        logger.error({ error }, 'heartbeat failed');
      }
      await delay(this.heartbeatDelayMs(transport));
    }
  }

  private async jobLoop(transport: ControlPlaneTransport): Promise<void> {
    while (!this.stopped) {
      try {
        const job = await transport.nextJob();
        if (!job) {
          if (transport.mode === 'http') {
            await delay(this.state.pollIntervalMs ?? config.pollIntervalMs);
          }
          continue;
        }

        logger.info({ jobId: job.id, jobType: job.type }, 'running job');
        await transport.sendJobAccepted(job.id);

        try {
          const result = await runJob(job);
          await transport.completeJob(job.id, 'succeeded', {
            summary: result.summary,
            details: result.details,
          });
          logger.info({ jobId: job.id, jobType: job.type }, 'job completed');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await transport.sendJobEvent(job.id, 'error', message);
          await transport.completeJob(job.id, 'failed', undefined, message);
          logger.error({ error, jobId: job.id, jobType: job.type }, 'job failed');
        }
      } catch (error) {
        logger.error({ error }, 'job poll failed');
        if (transport.mode === 'http') {
          await delay(this.state.pollIntervalMs ?? config.pollIntervalMs);
        } else {
          await delay(config.wssBackoffInitialMs);
        }
      }
    }
  }
}
