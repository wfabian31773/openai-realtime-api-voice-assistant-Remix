import { auditContainsPhi } from "./phi";

export type PluginAuditOutcome =
  | "ok"
  | "denied"
  | "error"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "committed"
  | "failed";

export interface PluginAuditEntry {
  tokenJti: string;
  tool: string;
  route: string;
  method: string;
  approvalId?: string | null;
  ticketId?: string | null;
  outcome: PluginAuditOutcome;
  httpStatus: number;
  createdAt?: Date;
}

/**
 * Shape written to plugin_audit_log. Throws in tests if a caller tries to
 * attach PHI; in production it strips unknown extra keys rather than write them.
 */
export function sanitizeAuditEntry(entry: PluginAuditEntry): PluginAuditEntry {
  const clean: PluginAuditEntry = {
    tokenJti: entry.tokenJti,
    tool: entry.tool,
    route: entry.route,
    method: entry.method,
    approvalId: entry.approvalId ?? null,
    ticketId: entry.ticketId ?? null,
    outcome: entry.outcome,
    httpStatus: entry.httpStatus,
  };
  if (auditContainsPhi(clean as unknown as Record<string, unknown>)) {
    throw new Error("plugin audit refused a row that looks like PHI");
  }
  return clean;
}
