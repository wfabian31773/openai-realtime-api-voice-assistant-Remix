/**
 * Production and test wiring for the SI Assistant tools. The registry
 * tool cannot import mount.ts (that file talks to the Hub pool).
 */
import type { PluginStore } from "./store";
import type { OutboundStore } from "../runtime/outbound/store";

let plugin: PluginStore | null = null;
let outbound: OutboundStore | null = null;

export function bindPluginStore(store: PluginStore | null): void {
  plugin = store;
}

export function bindOutboundStore(store: OutboundStore | null): void {
  outbound = store;
}

export function boundPluginStore(): PluginStore | null {
  return plugin;
}

export function boundOutboundStore(): OutboundStore | null {
  return outbound;
}
