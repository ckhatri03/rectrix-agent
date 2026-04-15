import os from 'node:os';
import { z } from 'zod';
import { config } from './config';
import {
  aptInstall,
  aptRemove,
  getUnitState,
  removeManagedFiles,
  systemctl,
  writeManagedFiles,
} from './system';
import { AgentJob, JobResult, ManagedFile } from './types';

const fileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.string().regex(/^0[0-7]{3}$/).optional(),
});

const unitsSchema = z.array(z.string().min(1)).default([]);
const packagesSchema = z.array(z.enum(['mosquitto', 'telegraf'])).default([]);
const diagnosticsSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  requestedBy: z.string().trim().min(1).max(200).optional(),
  expectedTransportMode: z
    .enum(['auto', 'http', 'rest', 'wss'])
    .optional(),
});

const fileApplySchema = z.object({
  files: z.array(fileSchema).min(1),
  installPackages: z.boolean().optional(),
  packages: packagesSchema.optional(),
  packageVersions: z.record(z.string()).optional(),
  unitsToEnable: unitsSchema.optional(),
  unitsToRestart: unitsSchema.optional(),
  unitsToReload: unitsSchema.optional(),
});

const fileRemoveSchema = z.object({
  filesToRemove: z.array(z.string().min(1)).default([]),
  removePackages: z.boolean().optional(),
  packages: packagesSchema.optional(),
  unitsToStop: unitsSchema.optional(),
  unitsToDisable: unitsSchema.optional(),
});

const stackSchema = z.object({
  packages: packagesSchema.optional(),
  packageVersions: z.record(z.string()).optional(),
  unitsToEnable: unitsSchema.optional(),
  unitsToStart: unitsSchema.optional(),
  unitsToStop: unitsSchema.optional(),
  unitsToDisable: unitsSchema.optional(),
});

const maybeReloadSystemd = async (files: ManagedFile[]) => {
  const changedSystemdUnits = files.some((file) =>
    file.path.startsWith('/etc/systemd/system/'),
  );
  if (changedSystemdUnits) {
    await systemctl('daemon-reload');
  }
};

const summarizeUnitStates = async (units: string[]) => {
  const entries = await Promise.all(
    units.map(async (unit) => [unit, await getUnitState(unit)] as const),
  );
  return Object.fromEntries(entries);
};

const withDefaultPackages = (packages: string[] | undefined, fallback: string[]) =>
  packages && packages.length > 0 ? packages : fallback;

const safeUsername = () => {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
};

const applyFiles = async (
  payload: z.infer<typeof fileApplySchema>,
  defaultPackages: string[],
): Promise<JobResult> => {
  const packages = payload.installPackages
    ? await aptInstall(
        withDefaultPackages(payload.packages, defaultPackages),
        payload.packageVersions,
      )
    : [];
  const appliedFiles = await writeManagedFiles(payload.files);
  await maybeReloadSystemd(payload.files);

  if (payload.unitsToEnable && payload.unitsToEnable.length > 0) {
    await systemctl('enable', payload.unitsToEnable);
  }
  if (payload.unitsToReload && payload.unitsToReload.length > 0) {
    await systemctl('reload', payload.unitsToReload);
  }
  if (payload.unitsToRestart && payload.unitsToRestart.length > 0) {
    await systemctl('restart', payload.unitsToRestart);
  }

  const touchedUnits = [
    ...(payload.unitsToEnable ?? []),
    ...(payload.unitsToReload ?? []),
    ...(payload.unitsToRestart ?? []),
  ];

  return {
    ok: true,
    summary: `Applied ${appliedFiles.length} files`,
    details: {
      packages,
      appliedFiles,
      unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
    },
  };
};

const removeFiles = async (
  payload: z.infer<typeof fileRemoveSchema>,
  defaultPackages: string[],
): Promise<JobResult> => {
  if (payload.unitsToStop && payload.unitsToStop.length > 0) {
    await systemctl('stop', payload.unitsToStop);
  }
  if (payload.unitsToDisable && payload.unitsToDisable.length > 0) {
    await systemctl('disable', payload.unitsToDisable);
  }

  const removedFiles =
    payload.filesToRemove.length > 0
      ? await removeManagedFiles(payload.filesToRemove)
      : [];
  const packages =
    payload.removePackages
      ? await aptRemove(withDefaultPackages(payload.packages, defaultPackages))
      : [];

  const touchedUnits = [
    ...(payload.unitsToStop ?? []),
    ...(payload.unitsToDisable ?? []),
  ];

  return {
    ok: true,
    summary: `Removed ${removedFiles.length} files`,
    details: {
      packages,
      removedFiles,
      unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
    },
  };
};

export const runJob = async (job: AgentJob): Promise<JobResult> => {
  switch (job.type) {
    case 'agent.diagnostics.snapshot': {
      const payload = diagnosticsSchema.parse(job.payload ?? {});
      return {
        ok: true,
        summary: `Captured agent diagnostics on ${config.hostname}`,
        details: {
          timestamp: new Date().toISOString(),
          hostname: config.hostname,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          agentVersion: config.agentVersion,
          requestedControlPlaneMode: config.controlPlaneMode,
          controlPlaneAuthMode: config.controlPlaneAuthMode,
          managerApiConfigured: Boolean(config.managerApiUrl),
          wssConfigured: Boolean(config.wssUrl),
          capabilities: config.capabilities,
          processId: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          runAsUser: safeUsername(),
          note: payload.note ?? null,
          requestedBy: payload.requestedBy ?? null,
          expectedTransportMode: payload.expectedTransportMode ?? null,
        },
      };
    }
    case 'stack.install': {
      const payload = stackSchema.parse(job.payload);
      const packages = await aptInstall(
        withDefaultPackages(payload.packages, ['mosquitto', 'telegraf']),
        payload.packageVersions,
      );
      if (payload.unitsToEnable && payload.unitsToEnable.length > 0) {
        await systemctl('enable', payload.unitsToEnable);
      }
      if (payload.unitsToStart && payload.unitsToStart.length > 0) {
        await systemctl('restart', payload.unitsToStart);
      }
      const touchedUnits = [
        ...(payload.unitsToEnable ?? []),
        ...(payload.unitsToStart ?? []),
      ];
      return {
        ok: true,
        summary: `Installed ${packages.join(', ')}`,
        details: {
          packages,
          unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
        },
      };
    }
    case 'stack.remove': {
      const payload = stackSchema.parse(job.payload);
      if (payload.unitsToStop && payload.unitsToStop.length > 0) {
        await systemctl('stop', payload.unitsToStop);
      }
      if (payload.unitsToDisable && payload.unitsToDisable.length > 0) {
        await systemctl('disable', payload.unitsToDisable);
      }
      const packages = await aptRemove(
        withDefaultPackages(payload.packages, ['telegraf', 'mosquitto']),
      );
      const touchedUnits = [
        ...(payload.unitsToStop ?? []),
        ...(payload.unitsToDisable ?? []),
      ];
      return {
        ok: true,
        summary: `Removed ${packages.join(', ')}`,
        details: {
          packages,
          unitStates: await summarizeUnitStates([...new Set(touchedUnits)]),
        },
      };
    }
    case 'broker.config.apply':
      return applyFiles(fileApplySchema.parse(job.payload), ['mosquitto']);
    case 'mosquitto.acl.sync':
      return applyFiles(fileApplySchema.parse(job.payload), ['mosquitto']);
    case 'telegraf.apply':
      return applyFiles(fileApplySchema.parse(job.payload), ['telegraf']);
    case 'telegraf.remove':
      return removeFiles(fileRemoveSchema.parse(job.payload), ['telegraf']);
    default: {
      throw new Error(`Unsupported job type: ${job.type}`);
    }
  }
};
