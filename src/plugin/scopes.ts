/**
 * Plugin API scopes for the voice-fleet half of the SI Assistant.
 *
 * Matching contract: ticketing-app PR #366. Write scopes are never implied.
 * The mint script defaults to fleet:read only. Do not grant contacts:approve
 * to the SI Assistant bot — that scope is for the Support Center page.
 */

export const PLUGIN_SCOPES = [
  "fleet:read",
  "contacts:prepare",
  "contacts:commit",
  "contacts:approve",
] as const;

export type PluginScope = (typeof PLUGIN_SCOPES)[number];

export const DEFAULT_PLUGIN_SCOPES: PluginScope[] = ["fleet:read"];

export const WRITE_PLUGIN_SCOPES: readonly PluginScope[] = [
  "contacts:prepare",
  "contacts:commit",
  "contacts:approve",
];

const SCOPE_SET = new Set<string>(PLUGIN_SCOPES);
const WRITE_SCOPE_SET = new Set<string>(WRITE_PLUGIN_SCOPES);

export function isPluginScope(value: string): value is PluginScope {
  return SCOPE_SET.has(value);
}

export function isWritePluginScope(value: string): boolean {
  return WRITE_SCOPE_SET.has(value);
}

/** Empty / unknown input yields fleet:read only. Write scopes are never implied. */
export function parseScopes(values: string[] | null | undefined): PluginScope[] {
  const unique = new Set<PluginScope>();
  for (const value of values ?? []) {
    if (isPluginScope(value)) unique.add(value);
  }
  if (unique.size === 0) unique.add("fleet:read");
  return [...unique];
}

export function hasScope(granted: readonly string[] | null | undefined, needed: PluginScope): boolean {
  return (granted ?? []).includes(needed);
}

export const SCOPE_FOR_TOOL: Record<string, PluginScope> = {
  list_agents: "fleet:read",
  agent_health: "fleet:read",
  fleet_today: "fleet:read",
  recent_outcomes: "fleet:read",
  outbound_status: "fleet:read",
  get_contact_request: "fleet:read",
  email_replies: "fleet:read",
  prepare_call: "contacts:prepare",
  prepare_sms: "contacts:prepare",
  prepare_email: "contacts:prepare",
  cancel_contact: "contacts:prepare",
  commit_contact: "contacts:commit",
  list_approvals: "contacts:approve",
  approve_contact: "contacts:approve",
  reject_contact: "contacts:approve",
};
