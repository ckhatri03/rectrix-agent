import { config } from '../config';
import { logger } from '../logger';
import { AgentJob, JobEventLevel, JobExecutionStatus } from '../types';
import WebSocket, { RawData } from 'ws';
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
      const waiter = this.waiters.shift();
      waiter?.(undefined);
    }
    this.items = [];
  }
}

export class WebSocketControlPlaneTransport implements ControlPlaneTransport {
  readonly mode = 'wss' as const;
  readonly authMode = 'token' as const;

  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectLoopPromise: Promise<void> | null = null;
  private readonly queuedJobs = new AsyncJobQueue();
  private readonly queuedJobIds = new Set<string>();
  private pongDeadlineTimer: NodeJS.Timeout | undefined;
  private forceReconnectTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: ControlPlaneTransportContext & { wssUrl: string }) {}

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.queuedJobs.close();
    if (this.socket) {
      try {
        this.socket.close(1000, 'agent shutting down');
      } catch {
        // best effort during shutdown
      }
    }
  }

  async sendCapabilities(): Promise<void> {
    await this.sendMessage(
      buildCapabilitiesMessage(
        this.context.state,
        this.context.system,
        this.context.capabilities,
      ),
    );
  }

  async sendHeartbeat(): Promise<void> {
    await this.sendMessage(
      buildPresencePingMessage(
        this.context.state,
        this.context.system,
        this.context.capabilities,
      ),
    );
    this.armPongTimeout();
  }

  async nextJob(): Promise<AgentJob | undefined> {
    await this.connect();
    return this.queuedJobs.shift();
  }

  async sendJobAccepted(jobId: string): Promise<void> {
    await this.sendMessage(
      buildJobAcceptedMessage(this.context.state, this.context.system, jobId),
    );
  }

  async sendJobEvent(
    jobId: string,
    level: JobEventLevel,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.sendMessage(
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
    await this.sendMessage(
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
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.openSocket().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.context.wssUrl);
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        fn();
      };

      const timeoutHandle = setTimeout(() => {
        finish(() => {
          try {
            socket.close(4000, 'connect timeout');
          } catch {
            // ignore close errors during timeout cleanup
          }
          reject(
            new Error(
              `WebSocket connect timed out after ${config.wssConnectTimeoutMs}ms`,
            ),
          );
        });
      }, config.wssConnectTimeoutMs);

      socket.once('open', () => {
        finish(() => {
          this.socket = socket;
          this.reconnectAttempts = 0;
          this.scheduleForceReconnect();
          void this.context.onStateChange({
            activeControlPlaneMode: 'wss',
            activeControlPlaneAuthMode: 'token',
            lastSuccessfulWssConnectAt: new Date().toISOString(),
            lastFallbackReason: undefined,
          });
          void this.sendMessage(
            buildHelloMessage(
              this.context.state,
              this.context.system,
              this.context.capabilities,
              this.authMode,
              this.context.authToken,
            ),
          ).catch((error) => {
            logger.error({ error }, 'failed to send websocket hello');
          });
          resolve();
        });
      });

      socket.on('message', (data: RawData) => {
        void this.handleMessage(data);
      });

      socket.once('error', (error: Error) => {
        if (!settled) {
          finish(() => {
            reject(error);
          });
          return;
        }
        logger.warn({ error }, 'websocket transport emitted an error event');
      });

      socket.on('close', (code: number, reason: Buffer) => {
        const reasonText = reason.length > 0 ? reason.toString('utf8') : undefined;
        if (!settled) {
          finish(() => {
            reject(
              new Error(
                `WebSocket closed before ready${code ? ` (${code})` : ''}${reasonText ? `: ${reasonText}` : ''}`,
              ),
            );
          });
          return;
        }
        this.handleClose(code, reasonText);
      });
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = normalizeMessageData(data);
    if (!text) {
      logger.debug('ignoring non-text websocket control-plane message');
      return;
    }

    let message;
    try {
      message = parseInboundControlPlaneMessage(text);
    } catch (error) {
      logger.warn({ error }, 'failed to parse websocket control-plane message');
      return;
    }

    if (!message) {
      logger.debug({ payload: text }, 'ignoring websocket message without type');
      return;
    }

    switch (message.type) {
      case 'presence.pong':
        this.clearPongDeadline();
        return;
      case 'job.dispatch': {
        const job = extractJob(message);
        if (!job) {
          logger.warn({ message }, 'received websocket job.dispatch without a valid job');
          return;
        }
        if (this.queuedJobIds.has(job.id)) {
          logger.warn({ jobId: job.id }, 'ignoring duplicate websocket job dispatch');
          return;
        }
        this.queuedJobIds.add(job.id);
        this.queuedJobs.push(job);
        return;
      }
      case 'control.reconnect':
        if (this.socket) {
          this.socket.close(4100, 'control plane requested reconnect');
        }
        return;
      default:
        logger.debug({ type: message.type }, 'ignoring unsupported websocket message');
    }
  }

  private handleClose(code?: number, reason?: string): void {
    if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
      this.socket = null;
    }
    this.clearTimers();
    if (this.stopped) {
      return;
    }
    logger.warn({ code, reason }, 'websocket transport disconnected; reconnecting');
    if (!this.reconnectLoopPromise) {
      this.reconnectLoopPromise = this.reconnectLoop().finally(() => {
        this.reconnectLoopPromise = null;
      });
    }
  }

  private async reconnectLoop(): Promise<void> {
    while (!this.stopped && this.socket?.readyState !== WebSocket.OPEN) {
      const attempt = this.reconnectAttempts + 1;
      const delayMs = Math.min(
        config.wssBackoffInitialMs * 2 ** this.reconnectAttempts,
        config.wssBackoffMaxMs,
      );
      this.reconnectAttempts = attempt;
      logger.info({ attempt, delayMs }, 'waiting before websocket reconnect');
      await delay(delayMs);
      if (this.stopped) {
        return;
      }
      try {
        await this.connect();
        logger.info('websocket transport reconnected');
        return;
      } catch (error) {
        logger.warn({ error, attempt }, 'websocket reconnect attempt failed');
      }
    }
  }

  private async sendMessage(payload: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket transport is not connected');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private armPongTimeout(): void {
    this.clearPongDeadline();
    this.pongDeadlineTimer = setTimeout(() => {
      if (this.socket) {
        logger.warn('websocket pong timeout reached; forcing reconnect');
        this.socket.close(4101, 'pong timeout');
      }
    }, config.wssPongTimeoutMs);
  }

  private clearPongDeadline(): void {
    if (this.pongDeadlineTimer) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = undefined;
    }
  }

  private scheduleForceReconnect(): void {
    if (this.forceReconnectTimer) {
      clearTimeout(this.forceReconnectTimer);
    }
    this.forceReconnectTimer = setTimeout(() => {
      if (this.socket) {
        logger.info('forcing websocket reconnect before session expiry window');
        this.socket.close(4102, 'scheduled reconnect');
      }
    }, config.wssForceReconnectMs);
  }

  private clearTimers(): void {
    this.clearPongDeadline();
    if (this.forceReconnectTimer) {
      clearTimeout(this.forceReconnectTimer);
      this.forceReconnectTimer = undefined;
    }
  }
}
