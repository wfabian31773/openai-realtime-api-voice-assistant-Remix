import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const OPERATOR_SCENARIO_DIRECTORY = resolve(process.cwd(), "docs/operator-line/scenarios");

/** Only line endings and surrounding whitespace are normalized; words stay locked. */
export function scenarioScriptHash(script: string): string {
  return createHash("sha256").update(script.replace(/\r\n?/g, "\n").trim(), "utf8").digest("hex");
}

/** Fail closed on missing assets, stale hashes, extra files or malformed manifests. */
export function readCommittedScenarios(directory = OPERATOR_SCENARIO_DIRECTORY): Record<string, string> | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
    const entries = Object.entries(manifest);
    const files = readdirSync(directory).filter((file) => file.endsWith(".md")).sort();
    if (!entries.length || JSON.stringify(files) !== JSON.stringify(entries.map(([id]) => `${id}.md`).sort())) return null;
    for (const [id, hash] of entries) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null;
      if (scenarioScriptHash(readFileSync(resolve(directory, `${id}.md`), "utf8")) !== hash) return null;
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch { return null; }
}

// Loaded once from the deployed, committed assets. Editing files needs a restart.
export const COMMITTED_OPERATOR_SCENARIOS = readCommittedScenarios();
