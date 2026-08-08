/**
 * Deploy stamp (operator challenge 2026-08-08: "do you know if I
 * republished or not?" — nobody should have to guess). The build script
 * writes build-info.json at publish time; this surfaces it. A missing
 * file reads as 'pre-stamp build'.
 */
import fs from 'fs';
import path from 'path';

export interface BuildInfo {
  builtAt: string | null;
  gitSha: string | null;
}

export function getBuildInfo(): BuildInfo {
  try {
    const p = path.join(process.cwd(), 'build-info.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { builtAt: j.builtAt ?? null, gitSha: j.gitSha ?? null };
  } catch {
    return { builtAt: null, gitSha: null };
  }
}
