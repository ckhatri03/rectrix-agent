import os from 'node:os';
import { config } from './config';
import { extractJob } from './controlPlane/messageCodec';
import { logger } from './logger';
import {
  AgentJob,
  AgentState,
  CapabilityKey,
  ControlPlaneAuthMode,
  ControlPlaneMode,
  SystemInfo,
} from './types';

const joinUrl = (baseUrl: string, requestPath: string) =>
  new URL(
    requestPath.startsWith('/') ? requestPath : `/${requestPath}`,
    `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}`,
  ).toString();

const pathForJob = (template: string, jobId: string) =>
  template.replace(':jobId', encodeURIComponent(jobId));

const request = async <T>(
  baseUrl: string,
  requestPath: string,
  init: RequestInit,
): Promise<T | undefined> => {
  const response = await fetch(joinUrl(baseUrl, requestPath), {
    ...init,
    signal: AbortSignal.timeout(config.httpTimeoutMs),
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  });

  if (response.status === 204) {
    return undefined;
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Manager request failed ${response.status} ${response.statusText}: ${responseText}`,
    );
  }

  if (response.headers.get('content-type')?.includes('application/json')) {
    return (await response.json()) as T;
  }

  return undefined;
};

const asControlPlaneMode = (value: unknown): ControlPlaneMode | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'http' || normalized === 'rest' || normalized === 'wss') {
    return normalized;
  }
  return undefined;
};

const asControlPlaneAuthMode = (
  value: unknown,
): ControlPlaneAuthMode | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'token' || normalized === 'x509') {
    return normalized;
  }
  return undefined;
};

export class ManagerClient {
  constructor(private readonly state: AgentState, private readonly system: SystemInfo) {}

  private baseUrl(): string {
    const baseUrl = this.state.managerApiUrl ?? config.managerApiUrl;
    if (!baseUrl) {
      throw new Error('MANAGER_API_URL is required');
    }
    return baseUrl;
  }

  private authHeaders(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async activate(): Promise<Partial<AgentState>> {
    if (!config.activationCode) {
      throw new Error('Activation requires AGENT_ACTIVATION_CODE');
    }

    const response = await request<any>(this.baseUrl(), config.activationPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activationCode: config.activationCode,
        hostname: this.system.hostname,
        os: this.system.os,
        osVersion: this.system.osVersion,
        arch: this.system.arch,
        agentVersion: config.agentVersion,
      }),
    });

    return {
      agentId: response?.agentId,
      bootstrapToken: response?.bootstrapToken,
      managerApiUrl: response?.managerApiUrl ?? this.baseUrl(),
      wssUrl: response?.wssUrl ?? response?.controlPlane?.wssUrl,
      pollIntervalMs: response?.pollIntervalMs,
      heartbeatIntervalMs: response?.heartbeatIntervalMs,
      requestedControlPlaneMode: asControlPlaneMode(
        response?.controlPlaneMode ?? response?.controlPlane?.mode,
      ),
      requestedControlPlaneAuthMode: asControlPlaneAuthMode(
        response?.controlPlaneAuthMode ?? response?.controlPlane?.authMode,
      ),
    };
  }

  async enroll(token: string): Promise<Partial<AgentState>> {
    const response = await request<any>(this.baseUrl(), config.enrollPath, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        agentId: this.state.agentId,
        hostname: this.system.hostname,
        os: this.system.os,
        osVersion: this.system.osVersion,
        arch: this.system.arch,
        agentVersion: config.agentVersion,
      }),
    });

    return {
      agentId: response?.agentId ?? this.state.agentId,
      runtimeToken: response?.runtimeToken ?? response?.agentToken,
      managerApiUrl: response?.managerApiUrl ?? this.baseUrl(),
      wssUrl: response?.wssUrl ?? response?.controlPlane?.wssUrl ?? this.state.wssUrl,
      pollIntervalMs: response?.pollIntervalMs,
      heartbeatIntervalMs: response?.heartbeatIntervalMs,
      requestedControlPlaneMode:
        asControlPlaneMode(
          response?.controlPlaneMode ?? response?.controlPlane?.mode,
        ) ?? this.state.requestedControlPlaneMode,
      requestedControlPlaneAuthMode:
        asControlPlaneAuthMode(
          response?.controlPlaneAuthMode ?? response?.controlPlane?.authMode,
        ) ?? this.state.requestedControlPlaneAuthMode,
    };
  }

  async sendCapabilities(token: string, capabilities: CapabilityKey[]): Promise<void> {
    await request(this.baseUrl(), config.capabilitiesPath, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        agentId: this.state.agentId,
        hostname: this.system.hostname,
        capabilities,
      }),
    });
  }

  async sendHeartbeat(token: string, capabilities: CapabilityKey[]): Promise<void> {
    await request(this.baseUrl(), config.heartbeatPath, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        agentId: this.state.agentId,
        hostname: this.system.hostname,
        agentVersion: config.agentVersion,
        capabilities,
        status: 'online',
        timestamp: new Date().toISOString(),
      }),
    });
  }

  async fetchNextJob(token: string, capabilities: CapabilityKey[]): Promise<AgentJob | undefined> {
    const response = await request<any>(this.baseUrl(), config.nextJobPath, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        agentId: this.state.agentId,
        hostname: this.system.hostname,
        capabilities,
      }),
    });
    return extractJob(response);
  }

  async sendJobEvent(
    token: string,
    jobId: string,
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await request(this.baseUrl(), pathForJob(config.jobEventPathTemplate, jobId), {
        method: 'POST',
        headers: this.authHeaders(token),
        body: JSON.stringify({
          agentId: this.state.agentId,
          level,
          message,
          details,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (error) {
      logger.warn({ error, jobId }, 'failed to send job event');
    }
  }

  async completeJob(
    token: string,
    jobId: string,
    status: 'succeeded' | 'failed',
    result?: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void> {
    await request(this.baseUrl(), pathForJob(config.jobCompletePathTemplate, jobId), {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        agentId: this.state.agentId,
        status,
        result,
        error: errorMessage,
        hostname: os.hostname(),
        completedAt: new Date().toISOString(),
      }),
    });
  }
}
