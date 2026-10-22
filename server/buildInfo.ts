/**
 * Deploy stamp (operator challenge 2026-08-08: "do you know if I
 * republished or not?" — nobody should have to guess). The deployment build
 * runs scripts/write-build-info.cjs, which writes build-info.json; this
 * surfaces it. A missing or unreadable file reads as null — unknown, never a
 * guess. The file is gitignored: a committed copy reported 3f4ec74 as the
 * deployed SHA from 2026-08-12 until Stage C (v111).
 */
import fs from 'fs';
import path from 'path';

export interface BuildInfo {
  builtAt: string | null;
  /** Short SHA of the commit the bundle was built from. */
  gitSha: string | null;
  /** Full SHA, when the build could read it. */
  gitShaFull?: string | null;
  /** Whether that commit is on origin/main, from local git at build time; null = could not tell. */
  traceable?: boolean | null;
  /** True when the build ran from a workspace with uncommitted changes; then the SHA is null. */
  dirty?: boolean | null;
}

export function getBuildInfo(file: string = path.join(process.cwd(), 'build-info.json')): BuildInfo {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
      builtAt: str(j.builtAt),
      gitSha: str(j.gitSha),
      gitShaFull: str(j.gitShaFull),
      traceable: typeof j.traceable === 'boolean' ? j.traceable : null,
      dirty: typeof j.dirty === 'boolean' ? j.dirty : null,
    };
  } catch {
    return { builtAt: null, gitSha: null, gitShaFull: null, traceable: null, dirty: null };
  }
}
