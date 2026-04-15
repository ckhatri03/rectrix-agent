import { randomUUID } from 'node:crypto';
import { config } from '../config';
import {
  AgentJob,
  AgentState,
  CapabilityKey,
  JobEventLevel,
  JobExecutionStatus,
  SystemInfo,
} from '../types';

type JsonRecord = Record<string, unknown>;

export interface InboundControlPlaneMessage extends JsonRecord {
  type: string;
}

const withEnvelope = <T extends JsonRecord>(type: string, payload: T) => ({
  messageId: randomUUID(),
  type,
  timestamp: new Date().toISOString(),
  ...payload,
});

export const buildHelloMessage = (
  state: AgentState,
  system: SystemInfo,
  capabilities: CapabilityKey[],
  authMode: 'token' | 'x509',
  authToken: string,
) =>
  withEnvelope('hello', {
    agentId: state.agentId,
    hostname: system.hostname,
    agentVersion: config.agentVersion,
    transportMode: 'wss',
    auth: authMode === 'token' ? { mode: authMode, token: authToken } : { mode: authMode },
    system,
    capabilities,
  });

export const buildCapabilitiesMessage = (
  state: AgentState,
  system: SystemInfo,
  capabilities: CapabilityKey[],
) =>
  withEnvelope('capabilities.report', {
    agentId: state.agentId,
    hostname: system.hostname,
    capabilities,
  });

export const buildPresencePingMessage = (
  state: AgentState,
  system: SystemInfo,
  capabilities: CapabilityKey[],
) =>
  withEnvelope('presence.ping', {
    agentId: state.agentId,
    hostname: system.hostname,
    agentVersion: config.agentVersion,
    status: 'online',
    capabilities,
  });

export const buildJobAcceptedMessage = (
  state: AgentState,
  system: SystemInfo,
  jobId: string,
) =>
  withEnvelope('job.accepted', {
    agentId: state.agentId,
    hostname: system.hostname,
    jobId,
  });

export const buildJobEventMessage = (
  state: AgentState,
  system: SystemInfo,
  jobId: string,
  level: JobEventLevel,
  message: string,
  details?: Record<string, unknown>,
) =>
  withEnvelope('job.event', {
    agentId: state.agentId,
    hostname: system.hostname,
    jobId,
    level,
    message,
    details,
  });

export const buildJobCompleteMessage = (
  state: AgentState,
  system: SystemInfo,
  jobId: string,
  status: JobExecutionStatus,
  result?: Record<string, unknown>,
  errorMessage?: string,
) =>
  withEnvelope('job.complete', {
    agentId: state.agentId,
    hostname: system.hostname,
    jobId,
    status,
    result,
    error: errorMessage,
    completedAt: new Date().toISOString(),
  });

export const parseInboundControlPlaneMessage = (
  payload: string,
): InboundControlPlaneMessage | undefined => {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const candidate = parsed as Partial<InboundControlPlaneMessage>;
  if (!candidate.type || typeof candidate.type !== 'string') {
    return undefined;
  }
  return candidate as InboundControlPlaneMessage;
};

export const extractJob = (raw: unknown): AgentJob | undefined => {
  const candidate =
    (typeof raw === 'object' && raw
      ? ((raw as JsonRecord).job ?? (raw as JsonRecord).payload ?? raw)
      : raw) as JsonRecord | undefined;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const id =
    candidate.id ??
    candidate.jobId ??
    candidate.agentJobId ??
    candidate.job_uuid;
  const type = candidate.type ?? candidate.jobType ?? candidate.job_type;
  if (!id || !type) {
    return undefined;
  }

  return {
    id: String(id),
    type: String(type),
    payload: candidate.payload ?? candidate.data ?? candidate,
    raw: candidate,
  };
};

export const normalizeMessageData = (payload: unknown): string | undefined => {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  return undefined;
};
