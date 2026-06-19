import { config } from '../config';
import { logger } from '../logger';
import { ManagerClient } from '../managerClient';
import {
  ActiveControlPlaneAuthMode,
  ActiveControlPlaneMode,
  AgentState,
  ControlPlaneAuthMode,
  ControlPlaneMode,
} from '../types';
import { AwsIotMqttControlPlaneTransport } from './awsIotMqttTransport';
import { HttpControlPlaneTransport } from './httpTransport';
import { ControlPlaneTransport, ControlPlaneTransportContext } from './types';
import { WebSocketControlPlaneTransport } from './websocketTransport';

const normalizeMode = (
  requestedMode: ControlPlaneMode | undefined,
): ControlPlaneMode => {
  if (!requestedMode) {
    return config.controlPlaneMode;
  }
  return requestedMode;
};

const normalizeAuthMode = (
  requestedAuthMode: ControlPlaneAuthMode | undefined,
): ControlPlaneAuthMode => {
  if (!requestedAuthMode) {
    return config.controlPlaneAuthMode;
  }
  return requestedAuthMode;
};

const resolveRequestedMode = (requestedMode: ControlPlaneMode): ActiveControlPlaneMode | undefined =>
  requestedMode === 'http' || requestedMode === 'rest'
    ? 'http'
    : requestedMode === 'wss'
      ? 'wss'
      : requestedMode === 'aws-iot-mqtt'
        ? 'aws-iot-mqtt'
        : undefined;

const resolveRequestedAuthMode = (
  requestedAuthMode: ControlPlaneAuthMode,
): ActiveControlPlaneAuthMode | undefined =>
  requestedAuthMode === 'token' || requestedAuthMode === 'x509'
    ? requestedAuthMode
    : undefined;

const fallbackToHttp = async (
  context: ControlPlaneTransportContext,
  managerClient: ManagerClient,
  reason: string,
  requestedMode: ControlPlaneMode,
  requestedAuthMode: ControlPlaneAuthMode,
): Promise<ControlPlaneTransport> => {
  logger.warn({ reason, requestedMode, requestedAuthMode }, 'falling back to HTTP control-plane transport');
  await context.onStateChange({
    requestedControlPlaneMode: requestedMode,
    requestedControlPlaneAuthMode: requestedAuthMode,
    activeControlPlaneMode: 'http',
    activeControlPlaneAuthMode: 'token',
    lastFallbackReason: reason,
  });
  return new HttpControlPlaneTransport(
    managerClient,
    context.authToken,
    context.capabilities,
  );
};

const hasAwsIotRuntimeConfig = (state: AgentState): boolean =>
  Boolean(
    (state.iotEndpoint ?? config.iotEndpoint)
    && (state.iotCertPath ?? config.iotCertPath)
    && (state.iotKeyPath ?? config.iotKeyPath)
    && ((state.iotClientId ?? config.iotClientId) || (state.iotThingName ?? config.iotThingName) || state.agentId),
  );

export const createControlPlaneTransport = async (
  context: ControlPlaneTransportContext,
): Promise<ControlPlaneTransport> => {
  const managerClient = new ManagerClient(context.state, context.system);
  const requestedMode = normalizeMode(context.state.requestedControlPlaneMode);
  const requestedAuthMode = normalizeAuthMode(
    context.state.requestedControlPlaneAuthMode,
  );
  const prefersAwsIot =
    requestedMode === 'aws-iot-mqtt'
    || (
      requestedMode === 'auto'
      && requestedAuthMode === 'x509'
      && hasAwsIotRuntimeConfig(context.state)
    );

  if (requestedMode === 'http' || requestedMode === 'rest') {
    await context.onStateChange({
      requestedControlPlaneMode: requestedMode,
      requestedControlPlaneAuthMode: requestedAuthMode,
      activeControlPlaneMode: 'http',
      activeControlPlaneAuthMode: 'token',
      lastFallbackReason: undefined,
    });
    return new HttpControlPlaneTransport(
      managerClient,
      context.authToken,
      context.capabilities,
    );
  }

  if (prefersAwsIot) {
    if (!hasAwsIotRuntimeConfig(context.state)) {
      const reason =
        'AWS_IOT_ENDPOINT, AWS_IOT_CERT_PATH, AWS_IOT_KEY_PATH, and AWS_IOT_CLIENT_ID or AWS_IOT_THING_NAME are required for aws-iot-mqtt control-plane mode';
      if (requestedMode === 'aws-iot-mqtt') {
        throw new Error(reason);
      }
      return fallbackToHttp(
        context,
        managerClient,
        reason,
        requestedMode,
        requestedAuthMode,
      );
    }

    const transport = new AwsIotMqttControlPlaneTransport(context);
    try {
      await transport.start();
      await context.onStateChange({
        requestedControlPlaneMode: requestedMode,
        requestedControlPlaneAuthMode: requestedAuthMode,
        activeControlPlaneMode: 'aws-iot-mqtt',
        activeControlPlaneAuthMode: 'x509',
        lastFallbackReason: undefined,
      });
      return transport;
    } catch (error) {
      if (requestedMode === 'aws-iot-mqtt') {
        throw error;
      }
      return fallbackToHttp(
        context,
        managerClient,
        error instanceof Error ? error.message : String(error),
        requestedMode,
        requestedAuthMode,
      );
    }
  }

  const wssUrl = context.state.wssUrl ?? config.wssUrl;
  if (!wssUrl) {
    const reason = 'WSS_URL is required for websocket control-plane mode';
    if (requestedMode === 'wss') {
      throw new Error(reason);
    }
    return fallbackToHttp(
      context,
      managerClient,
      reason,
      requestedMode,
      requestedAuthMode,
    );
  }

  if (requestedAuthMode === 'x509') {
    const reason = 'CONTROL_PLANE_AUTH_MODE=x509 requires CONTROL_PLANE_MODE=aws-iot-mqtt';
    if (requestedMode === 'wss') {
      throw new Error(reason);
    }
    return fallbackToHttp(
      context,
      managerClient,
      reason,
      requestedMode,
      requestedAuthMode,
    );
  }

  const transport = new WebSocketControlPlaneTransport({
    ...context,
    wssUrl,
  });

  try {
    await transport.start();
    await context.onStateChange({
      wssUrl,
      requestedControlPlaneMode: requestedMode,
      requestedControlPlaneAuthMode: requestedAuthMode,
      activeControlPlaneMode: resolveRequestedMode(requestedMode) ?? 'wss',
      activeControlPlaneAuthMode:
        resolveRequestedAuthMode(requestedAuthMode) ?? 'token',
      lastFallbackReason: undefined,
    });
    return transport;
  } catch (error) {
    if (requestedMode === 'wss') {
      throw error;
    }
    return fallbackToHttp(
      context,
      managerClient,
      error instanceof Error ? error.message : String(error),
      requestedMode,
      requestedAuthMode,
    );
  }
};
