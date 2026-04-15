import { ManagerClient } from '../managerClient';
import { CapabilityKey } from '../types';
import { ControlPlaneTransport } from './types';

export class HttpControlPlaneTransport implements ControlPlaneTransport {
  readonly mode = 'http' as const;
  readonly authMode = 'token' as const;

  constructor(
    private readonly client: ManagerClient,
    private readonly authToken: string,
    private readonly capabilities: CapabilityKey[],
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async sendCapabilities(): Promise<void> {
    await this.client.sendCapabilities(this.authToken, this.capabilities);
  }

  async sendHeartbeat(): Promise<void> {
    await this.client.sendHeartbeat(this.authToken, this.capabilities);
  }

  async nextJob() {
    return this.client.fetchNextJob(this.authToken, this.capabilities);
  }

  async sendJobAccepted(jobId: string): Promise<void> {
    await this.client.sendJobEvent(this.authToken, jobId, 'info', 'job accepted');
  }

  async sendJobEvent(
    jobId: string,
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.client.sendJobEvent(this.authToken, jobId, level, message, details);
  }

  async completeJob(
    jobId: string,
    status: 'succeeded' | 'failed',
    result?: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void> {
    await this.client.completeJob(
      this.authToken,
      jobId,
      status,
      result,
      errorMessage,
    );
  }
}
