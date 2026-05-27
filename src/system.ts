import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from './config';
import { logger } from './logger';
import { ManagedFile } from './types';

const execFileAsync = promisify(execFile);

const managedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.string().regex(/^0[0-7]{3}$/).optional(),
});

const packageSchema = z.enum(['mosquitto', 'telegraf']);

const asRootCommand = (binary: string, args: string[]) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { file: binary, args };
  }
  return { file: config.sudoBin, args: [binary, ...args] };
};

const runCommand = async (
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => {
  logger.debug({ file, args }, 'running command');
  return execFileAsync(file, args, { maxBuffer: 1024 * 1024 * 5 });
};

export const runRootBinary = async (
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => {
  const command = asRootCommand(binary, args);
  return runCommand(command.file, command.args);
};

const validateUnit = (unit: string) => {
  if (!config.allowedUnitPatterns.some((pattern) => pattern.test(unit))) {
    throw new Error(`Unit is not allowed: ${unit}`);
  }
};

const validatePath = (targetPath: string) => {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Managed path must be absolute: ${targetPath}`);
  }
  const resolved = path.resolve(targetPath);
  const allowed = config.allowedConfigRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return (
      resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)
    );
  });
  if (!allowed) {
    throw new Error(`Managed path is outside allowed roots: ${targetPath}`);
  }
  return resolved;
};

export const writeManagedFiles = async (
  files: ManagedFile[],
): Promise<string[]> => {
  const appliedFiles: string[] = [];

  for (const candidate of files) {
    const file = managedFileSchema.parse(candidate);
    const resolvedPath = validatePath(file.path);
    const tempPath = path.join(
      os.tmpdir(),
      `rectrix-agent-${path.basename(resolvedPath)}-${Date.now()}.tmp`,
    );

    try {
      await fs.writeFile(tempPath, file.content, 'utf8');
      const mode = file.mode ?? '0644';
      const command = asRootCommand(config.installBin, [
        '-D',
        '-m',
        mode,
        tempPath,
        resolvedPath,
      ]);
      await runCommand(command.file, command.args);
      appliedFiles.push(resolvedPath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  return appliedFiles;
};

export const removeManagedFiles = async (files: string[]): Promise<string[]> => {
  const removedFiles: string[] = [];
  for (const filePath of files) {
    const resolvedPath = validatePath(filePath);
    const command = asRootCommand(config.rmBin, ['-f', resolvedPath]);
    await runCommand(command.file, command.args);
    removedFiles.push(resolvedPath);
  }
  return removedFiles;
};

export const ensureManagedDirectory = async (
  dirPath: string,
  options?: {
    mode?: string;
    owner?: string;
    group?: string;
  },
) => {
  const resolvedPath = validatePath(dirPath);
  const args = ['-d', '-m', options?.mode ?? '0755'];
  if (options?.owner) {
    args.push('-o', options.owner);
  }
  if (options?.group) {
    args.push('-g', options.group);
  }
  args.push(resolvedPath);
  await runRootBinary(config.installBin, args);
  return resolvedPath;
};

export const ensureManagedFile = async (
  filePath: string,
  options?: {
    mode?: string;
    owner?: string;
    group?: string;
  },
) => {
  const resolvedPath = validatePath(filePath);
  const args = ['-D', '-m', options?.mode ?? '0644'];
  if (options?.owner) {
    args.push('-o', options.owner);
  }
  if (options?.group) {
    args.push('-g', options.group);
  }
  args.push('/dev/null', resolvedPath);
  await runRootBinary(config.installBin, args);
  return resolvedPath;
};

export const chmodManagedPath = async (targetPath: string, mode: string) => {
  const resolvedPath = validatePath(targetPath);
  await runRootBinary(config.chmodBin, [mode, resolvedPath]);
  return resolvedPath;
};

export const chownManagedPath = async (
  targetPath: string,
  owner: string,
  group?: string,
) => {
  const resolvedPath = validatePath(targetPath);
  await runRootBinary(config.chownBin, [
    group ? `${owner}:${group}` : owner,
    resolvedPath,
  ]);
  return resolvedPath;
};

export const managedPathExists = async (targetPath: string) => {
  const resolvedPath = validatePath(targetPath);
  try {
    await fs.access(resolvedPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EACCES' && err.code !== 'EPERM') {
      return false;
    }
  }

  try {
    await runRootBinary(config.python3Bin, [
      '-c',
      'import os, sys; raise SystemExit(0 if os.path.exists(sys.argv[1]) else 1)',
      resolvedPath,
    ]);
    return true;
  } catch {
    return false;
  }
};

export const binaryExists = async (binaryPath: string) => {
  try {
    await fs.access(binaryPath);
    return true;
  } catch {
    return false;
  }
};

export const systemctl = async (
  action: 'daemon-reload' | 'enable' | 'disable' | 'start' | 'restart' | 'reload' | 'stop' | 'is-active',
  units: string[] = [],
): Promise<string> => {
  for (const unit of units) {
    validateUnit(unit);
  }
  const command = asRootCommand(config.systemctlBin, [action, ...units]);
  const { stdout } = await runCommand(command.file, command.args);
  return stdout.trim();
};

export const aptInstall = async (
  packages: string[],
  versions?: Record<string, string>,
): Promise<string[]> => {
  if (!config.allowPackageOperations) {
    throw new Error('Package operations are disabled');
  }
  const validated = packages.map((item) => packageSchema.parse(item));
  const resolved = validated.map((pkg) => {
    const version = versions?.[pkg];
    return version ? `${pkg}=${version}` : pkg;
  });
  const command = asRootCommand(config.aptGetBin, [
    'update',
  ]);
  await runCommand(command.file, command.args);
  const installCommand = asRootCommand(config.aptGetBin, [
    'install',
    '-y',
    ...resolved,
  ]);
  await runCommand(installCommand.file, installCommand.args);
  return validated;
};

export const aptRemove = async (packages: string[]): Promise<string[]> => {
  if (!config.allowPackageOperations) {
    throw new Error('Package operations are disabled');
  }
  const validated = packages.map((item) => packageSchema.parse(item));
  const command = asRootCommand(config.aptGetBin, [
    'remove',
    '-y',
    ...validated,
  ]);
  await runCommand(command.file, command.args);
  return validated;
};

export const readUnitLogs = async (
  unit: string,
  lines = 200,
): Promise<string> => {
  validateUnit(unit);
  const count = Math.min(Math.max(lines, 1), 500);
  const command = asRootCommand(config.journalctlBin, [
    '--unit',
    unit,
    '--no-pager',
    '--output',
    'short-iso',
    '--lines',
    String(count),
  ]);
  const { stdout } = await runCommand(command.file, command.args);
  return stdout;
};

export const readUnitStatus = async (
  unit: string,
  lines = 50,
): Promise<string> => {
  validateUnit(unit);
  const count = Math.min(Math.max(lines, 1), 500);
  const command = asRootCommand(config.systemctlBin, [
    'status',
    unit,
    '--no-pager',
    '--lines',
    String(count),
  ]);

  try {
    const { stdout, stderr } = await runCommand(command.file, command.args);
    return [stdout, stderr].filter(Boolean).join('\n').trim();
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    if (output) {
      return output;
    }
    throw error;
  }
};

export const getUnitState = async (unit: string): Promise<string> => {
  validateUnit(unit);
  try {
    return await systemctl('is-active', [unit]);
  } catch (error) {
    const err = error as Error & { stdout?: string };
    return err.stdout?.trim() ?? 'unknown';
  }
};
