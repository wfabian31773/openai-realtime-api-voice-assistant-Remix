/**
 * Model A/B assignment (Phase 7 carriage, generalized 2026-08-03).
 *
 * Originally azul-only via AZUL_AB_MODEL_B. Now any agent listed in
 * AB_MODEL_B_AGENTS runs the experiment with AB_MODEL_B as the challenger.
 * Backward compatible: with only AZUL_AB_MODEL_B set, behavior is unchanged
 * (azul-scheduling only). Unset challenger = no experiment anywhere.
 *
 * Assignment is a deterministic hash of the callSid (~50/50, reproducible),
 * so a retried webhook for the same call always lands on the same arm.
 */

export interface AbAssignment {
  /** Challenger model when this call is arm B; undefined = keep control model. */
  challengerModel?: string;
  /** "A:<model>" | "B:<model>" — persisted to the call log for per-arm grading. */
  armLabel?: string;
}

export function hashSid(sid: string): number {
  return [...sid].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
}

export function resolveAbAssignment(
  agentSlug: string,
  sid: string,
  controlModel: string,
  env: NodeJS.ProcessEnv = process.env,
): AbAssignment {
  const challenger = env.AB_MODEL_B || env.AZUL_AB_MODEL_B;
  if (!challenger || !sid) return {};
  const agents = (env.AB_MODEL_B_AGENTS || (env.AZUL_AB_MODEL_B && !env.AB_MODEL_B ? 'azul-scheduling' : ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!agents.includes(agentSlug)) return {};
  const arm = hashSid(sid) % 2 === 0 ? 'A' : 'B';
  const model = arm === 'B' ? challenger : controlModel;
  return {
    challengerModel: arm === 'B' ? challenger : undefined,
    armLabel: `${arm}:${model}`,
  };
}
