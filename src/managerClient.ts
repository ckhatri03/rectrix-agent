import os from 'node:os';
import { AwsIotClaimBootstrapMaterial } from './awsIotProvisioning';
import { config } from './config';
import { extractJob } from './controlPlane/messageCodec';
import { logger } from './logger';
import {
  AgentJob,
  AgentState,
  CapabilityKey,
  AwsIotTransportMode,
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
    throw new ManagerRequestError(
      `Manager request failed ${response.status} ${response.statusText}: ${responseText}`,
      response.status,
      responseText,
    );
  }

  if (response.headers.get('content-type')?.includes('application/json')) {
    return (await response.json()) as T;
  }

  return undefined;
};

export class ManagerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(message);
    this.name = 'ManagerRequestError';
  }
}

const asControlPlaneMode = (value: unknown): ControlPlaneMode | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'auto'
    || normalized === 'http'
    || normalized === 'rest'
    || normalized === 'wss'
    || normalized === 'aws-iot-mqtt'
  ) {
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

const asAwsIotTransportMode = (
  value: unknown,
): AwsIotTransportMode | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mqtt-x509-claim' || normalized === 'mqtt-x509-runtime') {
    return normalized;
  }
  return undefined;
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export type AgentActivationBootstrap = {
  state: Partial<AgentState>;
  claimBootstrap?: AwsIotClaimBootstrapMaterial;
};

const extractClaimBootstrap = (response: any): AwsIotClaimBootstrapMaterial | undefined => {
  const claimBootstrap = {
    caPem:
      asString(response?.iotCaPem)
      ?? asString(response?.controlPlane?.iotCaPem)
      ?? asString(response?.controlPlane?.iot?.caPem),
    certificatePem:
      asString(response?.iotClaimCertificatePem)
      ?? asString(response?.controlPlane?.iotClaimCertificatePem)
      ?? asString(response?.controlPlane?.iot?.certificatePem),
    privateKeyPem:
      asString(response?.iotClaimPrivateKeyPem)
      ?? asString(response?.controlPlane?.iotClaimPrivateKeyPem)
      ?? asString(response?.controlPlane?.iot?.privateKeyPem),
  };

  return claimBootstrap.caPem || claimBootstrap.certificatePem || claimBootstrap.privateKeyPem
    ? claimBootstrap
    : undefined;
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

  async activate(): Promise<AgentActivationBootstrap> {
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
      state: {
        agentId: response?.agentId,
        bootstrapToken: response?.bootstrapToken,
        managerApiUrl: response?.managerApiUrl ?? this.baseUrl(),
        wssUrl: response?.wssUrl ?? response?.controlPlane?.wssUrl,
        iotEndpoint:
          asString(response?.iotEndpoint)
          ?? asString(response?.controlPlane?.iotEndpoint)
          ?? asString(response?.controlPlane?.iot?.endpoint),
        iotThingName:
          asString(response?.iotThingName)
          ?? asString(response?.controlPlane?.iotThingName)
          ?? asString(response?.controlPlane?.iot?.thingName),
        iotClientId:
          asString(response?.iotClientId)
          ?? asString(response?.controlPlane?.iotClientId)
          ?? asString(response?.controlPlane?.iot?.clientId),
        iotCaPath:
          asString(response?.iotCaPath)
          ?? asString(response?.controlPlane?.iotCaPath)
          ?? asString(response?.controlPlane?.iot?.caPath),
        iotCertPath:
          asString(response?.iotCertPath)
          ?? asString(response?.controlPlane?.iotCertPath)
          ?? asString(response?.controlPlane?.iot?.certPath),
        iotKeyPath:
          asString(response?.iotKeyPath)
          ?? asString(response?.controlPlane?.iotKeyPath)
          ?? asString(response?.controlPlane?.iot?.keyPath),
        iotTopicPrefix:
          asString(response?.iotTopicPrefix)
          ?? asString(response?.controlPlane?.iotTopicPrefix)
          ?? asString(response?.controlPlane?.iot?.topicPrefix),
        iotProvisioningTemplateName:
          asString(response?.iotProvisioningTemplateName)
          ?? asString(response?.controlPlane?.iotProvisioningTemplateName)
          ?? asString(response?.controlPlane?.iot?.provisioningTemplateName),
        iotTransportMode:
          asAwsIotTransportMode(response?.iotTransportMode)
          ?? asAwsIotTransportMode(response?.controlPlane?.iotTransportMode)
          ?? asAwsIotTransportMode(response?.controlPlane?.iot?.transportMode),
        pollIntervalMs: response?.pollIntervalMs,
        heartbeatIntervalMs: response?.heartbeatIntervalMs,
        requestedControlPlaneMode: asControlPlaneMode(
          response?.controlPlaneMode ?? response?.controlPlane?.mode,
        ),
        requestedControlPlaneAuthMode: asControlPlaneAuthMode(
          response?.controlPlaneAuthMode ?? response?.controlPlane?.authMode,
        ),
      },
      claimBootstrap: extractClaimBootstrap(response),
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
      iotEndpoint:
        asString(response?.iotEndpoint)
        ?? asString(response?.controlPlane?.iotEndpoint)
        ?? asString(response?.controlPlane?.iot?.endpoint)
        ?? this.state.iotEndpoint,
      iotThingName:
        asString(response?.iotThingName)
        ?? asString(response?.controlPlane?.iotThingName)
        ?? asString(response?.controlPlane?.iot?.thingName)
        ?? this.state.iotThingName,
      iotClientId:
        asString(response?.iotClientId)
        ?? asString(response?.controlPlane?.iotClientId)
        ?? asString(response?.controlPlane?.iot?.clientId)
        ?? this.state.iotClientId,
      iotCaPath:
        asString(response?.iotCaPath)
        ?? asString(response?.controlPlane?.iotCaPath)
        ?? asString(response?.controlPlane?.iot?.caPath)
        ?? this.state.iotCaPath,
      iotCertPath:
        asString(response?.iotCertPath)
        ?? asString(response?.controlPlane?.iotCertPath)
        ?? asString(response?.controlPlane?.iot?.certPath)
        ?? this.state.iotCertPath,
      iotKeyPath:
        asString(response?.iotKeyPath)
        ?? asString(response?.controlPlane?.iotKeyPath)
        ?? asString(response?.controlPlane?.iot?.keyPath)
        ?? this.state.iotKeyPath,
      iotTopicPrefix:
        asString(response?.iotTopicPrefix)
        ?? asString(response?.controlPlane?.iotTopicPrefix)
        ?? asString(response?.controlPlane?.iot?.topicPrefix)
        ?? this.state.iotTopicPrefix,
      iotProvisioningTemplateName:
        asString(response?.iotProvisioningTemplateName)
        ?? asString(response?.controlPlane?.iotProvisioningTemplateName)
        ?? asString(response?.controlPlane?.iot?.provisioningTemplateName)
        ?? this.state.iotProvisioningTemplateName,
      iotTransportMode:
        asAwsIotTransportMode(response?.iotTransportMode)
        ?? asAwsIotTransportMode(response?.controlPlane?.iotTransportMode)
        ?? asAwsIotTransportMode(response?.controlPlane?.iot?.transportMode)
        ?? this.state.iotTransportMode,
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
      logger.warn({ err: error, jobId }, 'failed to send job event');
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
