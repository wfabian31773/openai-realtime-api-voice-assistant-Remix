/**
 * JSONL spool: durable, replayable session storage (CP 4, 17, 19).
 * Default location .shadow-spool/ (gitignored). Failure to write never
 * propagates — the pipeline counts and continues.
 */
import { appendFile, mkdir, readFile, readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { getShadowConfig } from './config';

export class SpoolWriter {
  constructor(private dir?: string) {}

  private resolveDir(): string {
    return this.dir ?? getShadowConfig().spoolDir;
  }

  async writeSession(sessionId: string, record: Record<string, unknown>): Promise<void> {
    const dir = this.resolveDir();
    await mkdir(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `sessions-${day}.jsonl`);
    await appendFile(file, JSON.stringify({ sessionId, ...record }) + '\n', 'utf8');
  }

  async readSessions(file: string): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { parseError: true };
        }
      });
  }

  /** Retention purge (CP 20/21): delete spool files older than retentionDays. */
  async purgeOldFiles(now: Date = new Date()): Promise<number> {
    const dir = this.resolveDir();
    const cfg = getShadowConfig();
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = now.getTime() - cfg.retentionDays * 86_400_000;
    for (const name of names) {
      try {
        const full = join(dir, name);
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await unlink(full);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}
