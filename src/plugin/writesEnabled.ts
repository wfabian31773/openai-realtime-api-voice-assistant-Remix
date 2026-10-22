/**
 * PLUGIN_WRITES_ENABLED defaults OFF. Only an explicit true/1/yes enables writes.
 * Matching the ticketing-app plugin API (PR #366).
 */
export function pluginWritesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.PLUGIN_WRITES_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}
