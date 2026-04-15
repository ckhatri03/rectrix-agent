import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentState } from './types';

const ensureDirectory = async (filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

export const loadState = async (filePath: string): Promise<AgentState> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as AgentState;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

export const saveState = async (
  filePath: string,
  nextState: AgentState,
): Promise<void> => {
  await ensureDirectory(filePath);
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
};

