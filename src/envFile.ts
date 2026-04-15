import { promises as fs } from 'node:fs';
import path from 'node:path';

const escapeEnvValue = (value: string): string => {
  if (value === '') {
    return '';
  }
  if (/[\s#"']/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
};

export const updateEnvFile = async (
  filePath: string,
  updates: Record<string, string>,
): Promise<void> => {
  let contents = '';
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }

  const lines = contents === '' ? [] : contents.split('\n');
  const applied = new Set<string>();
  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (!(key in updates)) {
      return line;
    }
    applied.add(key);
    return `${key}=${escapeEnvValue(updates[key] ?? '')}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!applied.has(key)) {
      updatedLines.push(`${key}=${escapeEnvValue(value)}`);
    }
  }

  const nextContents = `${updatedLines.join('\n').replace(/\n*$/u, '')}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextContents, 'utf8');
};

