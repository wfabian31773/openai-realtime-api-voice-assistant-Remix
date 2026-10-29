import type { PluginStore } from "./store";

/** The env flag is a hard off for ALL operator admission, inbound and outbound.
 * No daily cap and no peak window apply to this line. Only this switch,
 * configuration, opt-outs, approval policy and the safety duration apply. */
export async function operatorLineEnabled(env: Record<string, string | undefined>, store: PluginStore | null): Promise<boolean> {
  if (env.OPERATOR_LINE_INBOUND_ENABLED !== "true" || !store) return false;
  try { return await store.getOperatorLineEnabled(); }
  catch { return false; }
}
