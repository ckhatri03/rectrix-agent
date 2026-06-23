import { promises as fs } from 'node:fs';
import os from 'node:os';
import {
  hydrateAwsIotClaimIdentity,
  provisionAwsIotRuntimeIdentity,
} from './awsIotProvisioning';
import { config } from './config';
import { createControlPlaneTransport } from './controlPlane';
import { ControlPlaneTransport } from './controlPlane/types';
import { updateEnvFile } from './envFile';
import { runJob } from './jobHandlers';
import { logger } from './logger';
import { ManagerClient, ManagerRequestError } from './managerClient';
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
      iotEndpoint: config.iotEndpoint ?? persistedState.iotEndpoint,
      iotThingName: config.iotThingName ?? persistedState.iotThingName,
      iotClientId: config.iotClientId ?? persistedState.iotClientId,
      iotCaPath: config.iotCaPath ?? persistedState.iotCaPath,
      iotCertPath: config.iotCertPath ?? persistedState.iotCertPath,
      iotKeyPath: config.iotKeyPath ?? persistedState.iotKeyPath,
      iotTopicPrefix: config.iotTopicPrefix ?? persistedState.iotTopicPrefix,
      iotProvisioningTemplateName:
        config.iotProvisioningTemplateName
        ?? persistedState.iotProvisioningTemplateName,
      iotTransportMode:
        persistedState.iotTransportMode ?? config.iotTransportMode,
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
      lastSuccessfulMqttConnectAt: persistedState.lastSuccessfulMqttConnectAt,
      lastFallbackReason: persistedState.lastFallbackReason,
      activationDisabledAt: persistedState.activationDisabledAt,
      activationDisabledReason: persistedState.activationDisabledReason,
      completedJobs: persistedState.completedJobs ?? {},
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
    if (!this.state.agentId) {
      throw new Error('Agent bootstrap did not yield agent credentials');
    }

    this.transport = await createControlPlaneTransport({
      state: this.state,
      system,
      authToken: authToken ?? '',
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
        iotEndpoint: this.state.iotEndpoint,
        iotClientId: this.state.iotClientId ?? this.state.iotThingName,
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
    if (!this.state.agentId) {
      return;
    }

    await updateEnvFile(config.envFilePath, {
      MANAGER_API_URL: this.state.managerApiUrl ?? '',
      WSS_URL: this.state.wssUrl ?? '',
      AGENT_ID: this.state.agentId,
      AGENT_RUNTIME_TOKEN: this.state.runtimeToken ?? '',
      AGENT_BOOTSTRAP_TOKEN: '',
      AGENT_ACTIVATION_CODE: '',
      AWS_IOT_ENDPOINT: this.state.iotEndpoint ?? '',
      AWS_IOT_THING_NAME: this.state.iotThingName ?? '',
      AWS_IOT_CLIENT_ID: this.state.iotClientId ?? '',
      AWS_IOT_CA_PATH: this.state.iotCaPath ?? '',
      AWS_IOT_CERT_PATH: this.state.iotCertPath ?? '',
      AWS_IOT_KEY_PATH: this.state.iotKeyPath ?? '',
      AWS_IOT_TOPIC_PREFIX: this.state.iotTopicPrefix ?? config.iotTopicPrefix,
      AWS_IOT_PROVISIONING_TEMPLATE_NAME:
        this.state.iotProvisioningTemplateName ?? '',
      AWS_IOT_TRANSPORT_MODE:
        this.state.iotTransportMode ?? config.iotTransportMode,
      ACTIVATION_DISABLED_AT: '',
      ACTIVATION_DISABLED_REASON: '',
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

  private isTerminalActivationError(error: unknown): error is ManagerRequestError {
    if (!(error instanceof ManagerRequestError) || error.status !== 409) {
      return false;
    }

    return [
      'Activation code has expired',
      'Activation code has been revoked',
      'Activation code has already been used',
    ].some((message) => error.responseText.includes(message));
  }

  private async disableActivation(reason: string): Promise<never> {
    const disabledAt = new Date().toISOString();
    await this.updateState({
      activationDisabledAt: disabledAt,
      activationDisabledReason: reason,
      bootstrapToken: undefined,
      runtimeToken: undefined,
    });
    await updateEnvFile(config.envFilePath, {
      AGENT_ACTIVATION_CODE: '',
      AGENT_BOOTSTRAP_TOKEN: '',
      ACTIVATION_DISABLED_AT: disabledAt,
      ACTIVATION_DISABLED_REASON: reason,
    });
    throw new Error(
      `Activation disabled after terminal manager response: ${reason}. Provide a new activation code or restore agent credentials before restarting the agent.`,
    );
  }

  private async updateState(update: Partial<AgentState>): Promise<void> {
    Object.assign(this.state, update);
    await saveState(config.stateFile, this.state);
  }

  private async bootstrap(system: SystemInfo): Promise<void> {
    if (
      this.hasRuntimeMqttIdentity()
      && this.state.agentId
      && !this.state.bootstrapToken
      && !this.state.runtimeToken
    ) {
      await this.persistRuntimeCredentials();
      return;
    }

    const client = new ManagerClient(this.state, system);

    if (this.state.activationDisabledReason) {
      throw new Error(
        `Activation disabled at ${this.state.activationDisabledAt ?? 'an unknown time'}: ${this.state.activationDisabledReason}`,
      );
    }

    if (!this.state.agentId || !(this.state.bootstrapToken || this.state.runtimeToken)) {
      logger.info('no persisted agent credentials found, activating');
      try {
        const activation = await client.activate();
        await this.updateState(activation.state);
        await hydrateAwsIotClaimIdentity(
          { ...this.state, ...activation.state },
          activation.claimBootstrap,
        );
      } catch (error) {
        if (this.isTerminalActivationError(error)) {
          logger.error({ err: error }, 'activation rejected permanently by manager');
          await this.disableActivation(error.responseText);
        }
        throw error;
      }
    }

    const shouldProvisionAwsIotRuntimeIdentity = this.shouldProvisionAwsIotRuntimeIdentity();
    if (shouldProvisionAwsIotRuntimeIdentity) {
      logger.info({ agentId: this.state.agentId }, 'provisioning AWS IoT runtime identity from claim credentials');
      await this.updateState(await provisionAwsIotRuntimeIdentity(this.state, system));
    } else if (this.requiresAwsIotClaimProvisioning()) {
      throw new Error(
        'AWS IoT claim bootstrap is incomplete; refusing HTTP enrollment because no runtime X.509 identity was provisioned',
      );
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
    const enrollment = await client.enroll(enrollmentToken);
    await this.updateState({
      ...enrollment,
      iotTransportMode:
        this.state.iotTransportMode === 'mqtt-x509-runtime'
          ? 'mqtt-x509-runtime'
          : enrollment.iotTransportMode,
    });
    await this.persistRuntimeCredentials();
  }

  private shouldProvisionAwsIotRuntimeIdentity(): boolean {
    const requestedMode =
      this.state.requestedControlPlaneMode ?? config.controlPlaneMode;
    if (requestedMode !== 'aws-iot-mqtt') {
      return false;
    }

    const transportMode = this.state.iotTransportMode ?? config.iotTransportMode;
    return Boolean(
      transportMode === 'mqtt-x509-claim'
      && !this.hasRuntimeMqttIdentity()
      && this.state.agentId
      && (this.state.iotEndpoint ?? config.iotEndpoint)
      && (this.state.iotCertPath ?? config.iotCertPath)
      && (this.state.iotKeyPath ?? config.iotKeyPath)
      && (this.state.iotProvisioningTemplateName ?? config.iotProvisioningTemplateName)
      && (this.state.bootstrapToken || config.activationCode),
    );
  }

  private requiresAwsIotClaimProvisioning(): boolean {
    const requestedMode =
      this.state.requestedControlPlaneMode ?? config.controlPlaneMode;
    const transportMode = this.state.iotTransportMode ?? config.iotTransportMode;
    return requestedMode === 'aws-iot-mqtt'
      && transportMode === 'mqtt-x509-claim'
      && !this.hasRuntimeMqttIdentity();
  }

  private hasRuntimeMqttIdentity(): boolean {
    const requestedMode =
      this.state.requestedControlPlaneMode ?? config.controlPlaneMode;
    if (requestedMode !== 'aws-iot-mqtt') {
      return false;
    }

    const transportMode = this.state.iotTransportMode ?? config.iotTransportMode;
    if (transportMode === 'mqtt-x509-claim') {
      return false;
    }

    return Boolean(
      this.state.agentId
      && (this.state.iotEndpoint ?? config.iotEndpoint)
      && (this.state.iotCertPath ?? config.iotCertPath)
      && (this.state.iotKeyPath ?? config.iotKeyPath)
      && (
        (this.state.iotClientId ?? config.iotClientId)
        || (this.state.iotThingName ?? config.iotThingName)
      ),
    );
  }

  private heartbeatDelayMs(transport: ControlPlaneTransport): number {
    if (transport.mode === 'wss') {
      return config.wssPingIntervalMs;
    }
    return this.state.heartbeatIntervalMs ?? config.heartbeatIntervalMs;
  }

  private httpJobPollDelayMs(idleSinceMs: number | null): number {
    const normalDelayMs = this.state.pollIntervalMs ?? config.pollIntervalMs;
    if (!idleSinceMs) {
      return normalDelayMs;
    }

    if (Date.now() - idleSinceMs < config.idleJobCooldownAfterMs) {
      return normalDelayMs;
    }

    return Math.max(normalDelayMs, config.idleJobPollIntervalMs);
  }

  private async heartbeatLoop(transport: ControlPlaneTransport): Promise<void> {
    while (!this.stopped) {
      try {
        await transport.sendHeartbeat();
        logger.debug('heartbeat sent');
      } catch (error) {
        logger.error({ err: error }, 'heartbeat failed');
      }
      await delay(this.heartbeatDelayMs(transport));
    }
  }

  private async jobLoop(transport: ControlPlaneTransport): Promise<void> {
    let idleSinceMs: number | null = null;
    let cooldownActive = false;

    while (!this.stopped) {
      try {
        const job = await transport.nextJob();
        if (!job) {
          if (transport.mode === 'http') {
            idleSinceMs ??= Date.now();
            const nextCooldownActive =
              Date.now() - idleSinceMs >= config.idleJobCooldownAfterMs;
            if (nextCooldownActive && !cooldownActive) {
              cooldownActive = true;
              logger.info(
                {
                  idleForMinutes: Math.floor((Date.now() - idleSinceMs) / 60000),
                  pollIntervalMs: this.httpJobPollDelayMs(idleSinceMs),
                },
                'no jobs for cooldown window, slowing HTTP job polling',
              );
            }
            await delay(this.httpJobPollDelayMs(idleSinceMs));
          }
          continue;
        }

        if (cooldownActive) {
          logger.info(
            { jobId: job.id, restoredPollIntervalMs: this.state.pollIntervalMs ?? config.pollIntervalMs },
            'job received, restoring normal HTTP job polling',
          );
        }
        idleSinceMs = null;
        cooldownActive = false;

        logger.info({ jobId: job.id, jobType: job.type }, 'running job');
        await transport.sendJobAccepted(job.id);

        try {
          const result = await runJob(job);
          await transport.completeJob(job.id, 'succeeded', {
            summary: result.summary,
            details: result.details,
          });
          logger.info({ jobId: job.id, jobType: job.type }, 'job completed');
          if (result.restartRequested) {
            logger.info({ jobId: job.id }, 'job requested agent restart');
            setTimeout(() => process.exit(0), 250);
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await transport.sendJobEvent(job.id, 'error', message, {
            errorName: error instanceof Error ? error.name : typeof error,
            stack: error instanceof Error ? error.stack : undefined,
            jobType: job.type,
          });
          await transport.completeJob(job.id, 'failed', undefined, message);
          logger.error({ err: error, jobId: job.id, jobType: job.type }, 'job failed');
        }
      } catch (error) {
        logger.error({ err: error }, 'job poll failed');
        if (transport.mode === 'http') {
          await delay(this.httpJobPollDelayMs(idleSinceMs));
        } else {
          await delay(
            transport.mode === 'aws-iot-mqtt'
              ? config.mqttBackoffInitialMs
              : config.wssBackoffInitialMs,
          );
        }
      }
    }
  }
}
