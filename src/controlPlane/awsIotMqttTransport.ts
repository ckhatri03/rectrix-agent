import { io, iot, mqtt } from 'aws-iot-device-sdk-v2';
import { config } from '../config';
import { logger } from '../logger';
import { AgentJob, JobEventLevel, JobExecutionStatus } from '../types';
import {
  buildCapabilitiesMessage,
  buildHelloMessage,
  buildJobAcceptedMessage,
  buildJobCompleteMessage,
  buildJobEventMessage,
  buildPresencePingMessage,
  extractJob,
  normalizeMessageData,
  parseInboundControlPlaneMessage,
} from './messageCodec';
import { ControlPlaneTransport, ControlPlaneTransportContext } from './types';

const delay = async (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class AsyncJobQueue {
  private items: AgentJob[] = [];
  private waiters: Array<(job: AgentJob | undefined) => void> = [];
  private closed = false;

  push(job: AgentJob): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(job);
      return;
    }
    this.items.push(job);
  }

  async shift(): Promise<AgentJob | undefined> {
    if (this.items.length > 0) {
      return this.items.shift();
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<AgentJob | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(undefined);
    }
    this.items = [];
  }
}

export class AwsIotMqttControlPlaneTransport implements ControlPlaneTransport {
  readonly mode = 'aws-iot-mqtt' as const;
  readonly authMode = 'x509' as const;

  private readonly endpoint: string;
  private readonly certPath: string;
  private readonly keyPath: string;
  private readonly caPath?: string;
  private readonly clientId: string;
  private readonly agentId: string;
  private readonly statusTopicPrefix: string;
  private readonly controlDispatchTopic: string;
  private readonly connection: mqtt.MqttClientConnection;
  private readonly queuedJobs = new AsyncJobQueue();
  private readonly queuedJobIds = new Set<string>();
  private connectPromise: Promise<void> | null = null;
  private stopped = false;
  private reconnectLoopPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly context: ControlPlaneTransportContext) {
    this.endpoint = context.state.iotEndpoint ?? config.iotEndpoint ?? '';
    this.certPath = context.state.iotCertPath ?? config.iotCertPath ?? '';
    this.keyPath = context.state.iotKeyPath ?? config.iotKeyPath ?? '';
    this.caPath = context.state.iotCaPath ?? config.iotCaPath;
    this.agentId = context.state.agentId ?? '';
    this.clientId =
      context.state.iotClientId
      ?? context.state.iotThingName
      ?? config.iotClientId
      ?? config.iotThingName
      ?? this.agentId;

    const basePrefix = (context.state.iotTopicPrefix ?? config.iotTopicPrefix).replace(/\/+$/, '');
    this.statusTopicPrefix = `${basePrefix}/${this.agentId}/status`;
    this.controlDispatchTopic = `${basePrefix}/${this.agentId}/control/job/dispatch`;

    const builder = iot.AwsIotMqttConnectionConfigBuilder.new_mtls_builder_from_path(
      this.certPath,
      this.keyPath,
    );
    if (this.caPath) {
      builder.with_certificate_authority_from_path(undefined, this.caPath);
    }
    builder.with_endpoint(this.endpoint);
    builder.with_client_id(this.clientId);
    builder.with_clean_session(false);
    builder.with_keep_alive_seconds(Math.max(30, Math.floor(config.heartbeatIntervalMs / 1000)));
    builder.with_ping_timeout_ms(config.mqttConnectTimeoutMs);
    builder.with_protocol_operation_timeout_ms(config.mqttConnectTimeoutMs);

    const client = new mqtt.MqttClient(new io.ClientBootstrap());
    this.connection = client.new_connection(builder.build());

    this.connection.on('interrupt', (error) => {
      logger.warn({ err: error }, 'AWS IoT MQTT connection interrupted');
    });
    this.connection.on('resume', (_returnCode, sessionPresent) => {
      logger.info({ sessionPresent }, 'AWS IoT MQTT connection resumed');
      if (!sessionPresent) {
        void this.subscribeControlTopics();
      }
    });
    this.connection.on('disconnect', () => {
      if (this.stopped) {
        return;
      }
      logger.warn('AWS IoT MQTT transport disconnected; reconnecting');
      this.startReconnectLoop();
    });
    this.connection.on('error', (error) => {
      logger.warn({ err: error }, 'AWS IoT MQTT transport emitted an error');
    });
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queuedJobs.close();
    try {
      await this.connection.disconnect();
    } catch (error) {
      logger.debug({ err: error }, 'AWS IoT MQTT disconnect ignored during shutdown');
    }
  }

  async sendCapabilities(): Promise<void> {
    await this.publish(
      `${this.statusTopicPrefix}/capabilities`,
      buildCapabilitiesMessage(this.context.state, this.context.system, this.context.capabilities),
    );
  }

  async sendHeartbeat(): Promise<void> {
    await this.publish(
      `${this.statusTopicPrefix}/heartbeat`,
      buildPresencePingMessage(
        this.context.state,
        this.context.system,
        this.context.capabilities,
        'heartbeat',
      ),
    );
  }

  async nextJob(): Promise<AgentJob | undefined> {
    await this.connect();
    return this.queuedJobs.shift();
  }

  async sendJobAccepted(jobId: string): Promise<void> {
    await this.publish(
      `${this.statusTopicPrefix}/job/accepted`,
      buildJobAcceptedMessage(this.context.state, this.context.system, jobId),
    );
  }

  async sendJobEvent(
    jobId: string,
    level: JobEventLevel,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.publish(
      `${this.statusTopicPrefix}/job/event`,
      buildJobEventMessage(
        this.context.state,
        this.context.system,
        jobId,
        level,
        message,
        details,
      ),
    );
  }

  async completeJob(
    jobId: string,
    status: JobExecutionStatus,
    result?: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void> {
    const topic =
      status === 'failed'
        ? `${this.statusTopicPrefix}/job/fail`
        : `${this.statusTopicPrefix}/job/complete`;
    await this.publish(
      topic,
      buildJobCompleteMessage(
        this.context.state,
        this.context.system,
        jobId,
        status,
        result,
        errorMessage,
      ),
    );

    this.queuedJobIds.delete(jobId);
    const completedJobs = {
      ...(this.context.state.completedJobs ?? {}),
      [jobId]: status,
    };
    const completedEntries = Object.entries(completedJobs).slice(-50);
    const trimmedCompletedJobs = Object.fromEntries(completedEntries);
    this.context.state.completedJobs = trimmedCompletedJobs;
    await this.context.onStateChange({ completedJobs: trimmedCompletedJobs });
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.openConnection().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  private async openConnection(): Promise<void> {
    await this.connection.connect();
    this.reconnectAttempts = 0;
    await this.subscribeControlTopics();
    await this.context.onStateChange({
      activeControlPlaneMode: 'aws-iot-mqtt',
      activeControlPlaneAuthMode: 'x509',
      lastSuccessfulMqttConnectAt: new Date().toISOString(),
      lastFallbackReason: undefined,
    });
    await this.publishConnected(
      `${this.statusTopicPrefix}/hello`,
      buildHelloMessage(
        this.context.state,
        this.context.system,
        this.context.capabilities,
        this.authMode,
        undefined,
        'aws-iot-mqtt',
      ),
    );
  }

  private async subscribeControlTopics(): Promise<void> {
    await this.connection.subscribe(
      this.controlDispatchTopic,
      mqtt.QoS.AtLeastOnce,
      (_topic, payload) => {
        void this.handleMessage(payload as ArrayBuffer);
      },
    );
  }

  private async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
    await this.connect();
    await this.publishConnected(topic, payload);
  }

  private async publishConnected(
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.connection.publish(topic, JSON.stringify(payload), mqtt.QoS.AtLeastOnce);
  }

  private async handleMessage(data: ArrayBuffer): Promise<void> {
    const text = normalizeMessageData(data);
    if (!text) {
      logger.debug('ignoring non-text MQTT control-plane message');
      return;
    }

    let message;
    try {
      message = parseInboundControlPlaneMessage(text);
    } catch (error) {
      logger.warn({ err: error }, 'failed to parse MQTT control-plane message');
      return;
    }

    if (!message) {
      logger.debug({ payload: text }, 'ignoring MQTT message without type');
      return;
    }

    if (message.type !== 'job.dispatch') {
      logger.debug({ type: message.type }, 'ignoring unsupported MQTT control-plane message');
      return;
    }

    const job = extractJob(message);
    if (!job) {
      logger.warn({ message }, 'received MQTT job.dispatch without a valid job');
      return;
    }
    if (this.queuedJobIds.has(job.id)) {
      logger.warn({ jobId: job.id }, 'ignoring duplicate queued MQTT job dispatch');
      return;
    }
    const priorStatus = this.context.state.completedJobs?.[job.id];
    if (priorStatus) {
      logger.info({ jobId: job.id, priorStatus }, 'replaying final status for already completed MQTT job');
      await this.completeJob(job.id, priorStatus, {
        replayed: true,
      });
      return;
    }

    this.queuedJobIds.add(job.id);
    this.queuedJobs.push(job);
  }

  private startReconnectLoop(): void {
    if (this.reconnectLoopPromise) {
      return;
    }
    this.reconnectLoopPromise = this.reconnectLoop().finally(() => {
      this.reconnectLoopPromise = null;
    });
  }

  private async reconnectLoop(): Promise<void> {
    while (!this.stopped) {
      const attempt = this.reconnectAttempts + 1;
      const delayMs = Math.min(
        config.mqttBackoffInitialMs * 2 ** this.reconnectAttempts,
        config.mqttBackoffMaxMs,
      );
      this.reconnectAttempts = attempt;
      logger.info({ attempt, delayMs }, 'waiting before AWS IoT MQTT reconnect');
      await delay(delayMs);
      if (this.stopped) {
        return;
      }
      try {
        await this.openConnection();
        logger.info('AWS IoT MQTT transport reconnected');
        return;
      } catch (error) {
        logger.warn({ err: error, attempt }, 'AWS IoT MQTT reconnect attempt failed');
      }
    }
  }
}
