import {
  ActiveControlPlaneAuthMode,
  ActiveControlPlaneMode,
  AgentJob,
  AgentState,
  CapabilityKey,
  JobEventLevel,
  JobExecutionStatus,
  SystemInfo,
} from '../types';

export interface ControlPlaneTransport {
  readonly mode: ActiveControlPlaneMode;
  readonly authMode: ActiveControlPlaneAuthMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendCapabilities(): Promise<void>;
  sendHeartbeat(): Promise<void>;
  nextJob(): Promise<AgentJob | undefined>;
  sendJobAccepted(jobId: string): Promise<void>;
  sendJobEvent(
    jobId: string,
    level: JobEventLevel,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
  completeJob(
    jobId: string,
    status: JobExecutionStatus,
    result?: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void>;
}

export interface ControlPlaneTransportContext {
  state: AgentState;
  system: SystemInfo;
  authToken: string;
  capabilities: CapabilityKey[];
  onStateChange: (update: Partial<AgentState>) => Promise<void>;
}
