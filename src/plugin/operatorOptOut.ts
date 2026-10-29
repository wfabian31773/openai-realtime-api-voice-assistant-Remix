import { US_E164 } from "./operatorLine";
import type { PluginStore } from "./store";
import type { OutboundStore } from "../runtime/outbound/store";

/** The same DNC lists checked by outbound operator commits. */
export async function recordOperatorOptOut(phone: string, plugin: PluginStore | null, outbound: () => Promise<OutboundStore>): Promise<void> {
  if (US_E164.test(phone)) {
    await (await outbound()).stampDoNotContact(phone, "voice:wayne-operator");
  } else {
    if (!plugin) throw new Error("operator opt-out storage unavailable");
    await plugin.setOperatorOptOut(phone);
  }
}
