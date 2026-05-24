import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

const MAX_LOCAL_LOG_LINES = 100;

class TailFileStream extends Writable {
  private readonly lines: string[];

  private partialLine = '';

  private writeFailureLogged = false;

  constructor(
    private readonly filePath: string,
    private readonly maxLines = MAX_LOCAL_LOG_LINES,
  ) {
    super();
    this.lines = this.readExistingLines();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : chunk;
      process.stdout.write(text);
      this.appendChunk(text);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private readExistingLines(): string[] {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }
      const existing = readFileSync(this.filePath, 'utf8');
      return existing.split(/\r?\n/).filter(Boolean).slice(-this.maxLines);
    } catch {
      return [];
    }
  }

  private appendChunk(text: string): void {
    const combined = `${this.partialLine}${text}`;
    const segments = combined.split(/\r?\n/);
    this.partialLine = segments.pop() ?? '';

    if (segments.length === 0) {
      return;
    }

    for (const line of segments) {
      if (line) {
        this.lines.push(line);
      }
    }

    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }

    this.persistLines();
  }

  private persistLines(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload = this.lines.length > 0 ? `${this.lines.join('\n')}\n` : '';
      writeFileSync(this.filePath, payload, 'utf8');
    } catch (error) {
      if (!this.writeFailureLogged) {
        this.writeFailureLogged = true;
        process.stderr.write(
          `rectrix-agent failed to write local log file ${this.filePath}: ${String(error)}\n`,
        );
      }
    }
  }
}

export const createLocalLogStream = (filePath: string) =>
  new TailFileStream(filePath, MAX_LOCAL_LOG_LINES);
