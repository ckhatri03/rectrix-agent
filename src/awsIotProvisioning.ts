import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  io,
  iot,
  iotidentity,
  mqtt,
  mqtt_request_response,
} from 'aws-iot-device-sdk-v2';
import { config } from './config';
import { logger } from './logger';
import { AgentState, AwsIotTransportMode, SystemInfo } from './types';

export type AwsIotClaimBootstrapMaterial = {
  caPem?: string;
  certificatePem?: string;
  privateKeyPem?: string;
};

type ProvisionedIdentity = {
  iotEndpoint: string;
  iotThingName: string;
  iotClientId: string;
  iotCertPath: string;
  iotKeyPath: string;
  iotTopicPrefix: string;
  iotProvisioningTemplateName: string;
  iotTransportMode: AwsIotTransportMode;
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const writePemFile = async (targetPath: string, contents: string) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(targetPath, 0o600);
};

export const hydrateAwsIotClaimIdentity = async (
  state: AgentState,
  material: AwsIotClaimBootstrapMaterial | undefined,
): Promise<void> => {
  if (!material) {
    return;
  }

  const certificatePem = asString(material.certificatePem);
  const privateKeyPem = asString(material.privateKeyPem);
  const caPem = asString(material.caPem);
  if (!certificatePem && !privateKeyPem && !caPem) {
    return;
  }

  if (!certificatePem || !privateKeyPem) {
    throw new Error('AWS IoT claim bootstrap requires both certificate and private key PEM values');
  }

  const certPath = state.iotCertPath ?? config.iotCertPath;
  const keyPath = state.iotKeyPath ?? config.iotKeyPath;
  const caPath = state.iotCaPath ?? config.iotCaPath;
  if (!certPath || !keyPath) {
    throw new Error('AWS IoT claim bootstrap requires AWS_IOT_CERT_PATH and AWS_IOT_KEY_PATH');
  }

  await writePemFile(certPath, certificatePem);
  await writePemFile(keyPath, privateKeyPem);
  if (caPem && caPath) {
    await writePemFile(caPath, caPem);
  }
};

const buildProvisioningParameters = (
  state: AgentState,
  system: SystemInfo,
): Record<string, string> => ({
  activationCode: config.activationCode ?? '',
  ActivationCode: config.activationCode ?? '',
  agentId: state.agentId ?? '',
  AgentId: state.agentId ?? '',
  hostname: system.hostname,
  Hostname: system.hostname,
  os: system.os,
  osVersion: system.osVersion,
  arch: system.arch,
  agentVersion: config.agentVersion,
});

export const provisionAwsIotRuntimeIdentity = async (
  state: AgentState,
  system: SystemInfo,
): Promise<ProvisionedIdentity> => {
  const endpoint = state.iotEndpoint ?? config.iotEndpoint;
  const certPath = state.iotCertPath ?? config.iotCertPath;
  const keyPath = state.iotKeyPath ?? config.iotKeyPath;
  const caPath = state.iotCaPath ?? config.iotCaPath;
  const templateName =
    state.iotProvisioningTemplateName ?? config.iotProvisioningTemplateName;
  const bootstrapClientId =
    state.iotClientId
    ?? state.iotThingName
    ?? config.iotClientId
    ?? config.iotThingName
    ?? state.agentId;

  if (!endpoint || !certPath || !keyPath || !templateName || !bootstrapClientId) {
    throw new Error(
      'AWS IoT claim provisioning requires endpoint, cert path, key path, template name, and client identity',
    );
  }
  if (!state.agentId) {
    throw new Error('AWS IoT claim provisioning requires an agentId');
  }
  if (!config.activationCode) {
    throw new Error('AWS IoT claim provisioning requires AGENT_ACTIVATION_CODE');
  }

  const builder = iot.AwsIotMqttConnectionConfigBuilder.new_mtls_builder_from_path(
    certPath,
    keyPath,
  );
  if (caPath) {
    builder.with_certificate_authority_from_path(undefined, caPath);
  }
  builder.with_endpoint(endpoint);
  builder.with_client_id(bootstrapClientId);
  builder.with_clean_session(true);
  builder.with_keep_alive_seconds(60);
  builder.with_ping_timeout_ms(config.mqttConnectTimeoutMs);
  builder.with_protocol_operation_timeout_ms(config.mqttConnectTimeoutMs);

  const client = new mqtt.MqttClient(new io.ClientBootstrap());
  const connection = client.new_connection(builder.build());
  const rrOptions = {
    maxRequestResponseSubscriptions: 6,
    maxStreamingSubscriptions: 2,
    operationTimeoutInSeconds: Math.max(
      30,
      Math.ceil(config.mqttConnectTimeoutMs / 1000) * 3,
    ),
  };
  const identityClient = iotidentity.IotIdentityClientv2.newFromMqtt311(
    connection,
    rrOptions,
  );

  try {
    logger.info({ endpoint, templateName, agentId: state.agentId }, 'connecting claim identity to AWS IoT');
    await connection.connect();

    logger.info({ templateName, agentId: state.agentId }, 'requesting AWS IoT runtime certificate');
    const issued = await identityClient.createKeysAndCertificate({});
    if (
      !issued.certificateOwnershipToken
      || !issued.certificatePem
      || !issued.privateKey
    ) {
      throw new Error('AWS IoT provisioning did not return certificate material');
    }

    logger.info({ templateName, agentId: state.agentId }, 'registering thing through AWS IoT Fleet Provisioning');
    const registered = await identityClient.registerThing({
      templateName,
      certificateOwnershipToken: issued.certificateOwnershipToken,
      parameters: buildProvisioningParameters(state, system),
    });

    await writePemFile(certPath, issued.certificatePem);
    await writePemFile(keyPath, issued.privateKey);

    const deviceConfiguration = registered.deviceConfiguration ?? {};
    const thingName =
      asString(deviceConfiguration.thingName)
      ?? registered.thingName
      ?? state.iotThingName
      ?? state.agentId;
    const clientId =
      asString(deviceConfiguration.clientId)
      ?? asString(deviceConfiguration.iotClientId)
      ?? thingName;
    const topicPrefix =
      asString(deviceConfiguration.topicPrefix)
      ?? state.iotTopicPrefix
      ?? config.iotTopicPrefix;
    const resolvedEndpoint =
      asString(deviceConfiguration.endpoint)
      ?? asString(deviceConfiguration.iotEndpoint)
      ?? endpoint;

    logger.info({ thingName, clientId, endpoint: resolvedEndpoint }, 'AWS IoT runtime identity provisioned');
    return {
      iotEndpoint: resolvedEndpoint,
      iotThingName: thingName,
      iotClientId: clientId,
      iotCertPath: certPath,
      iotKeyPath: keyPath,
      iotTopicPrefix: topicPrefix,
      iotProvisioningTemplateName: templateName,
      iotTransportMode: 'mqtt-x509-runtime',
    };
  } finally {
    identityClient.close();
    try {
      await connection.disconnect();
    } catch {
      // ignore disconnect failures during provisioning teardown
    }
  }
};
