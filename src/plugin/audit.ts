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
  | "deduplicated"
  | "failed"
  | "unknown"
  | "expired";

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
  details?: { maskedNumber: string; purpose: string; reason: string; approvalExempt?: never }
    | { initiatedBy: "bot"; approvalExempt: true; exemptReason: "owner_number";
      maskedNumber?: never; purpose?: never; reason?: never; operatorSms?: never }
    | { operatorSms: true; initiatedBy: "owner_request" | "bot_initiative"; maskedNumber: string;
      approvalExempt?: never; purpose?: never; reason?: never };
}

// Purpose is arbitrary caller-provided text and may contain PHI. Keep only
// generic task vocabulary, redact everything else, then truncate the preview.
// Exclude ambiguous names (e.g. Will, Price, Hope, May) even when lowercase,
// and treat capitals after the first word as potential names.
// Regex-only phone/DOB masking cannot safely retain names or clinical details.
const PURPOSE_AUDIT_WORDS = new Set("call ask about the a an and or for to from with on behalf of practice assistant office hours opening closing availability available schedule reservation confirm cancel order delivery pickup quote please thanks thank you find out check whether is are can could would open closed today tomorrow".split(" "));

export function directCallAuditDetails(body: unknown, reason: string): { maskedNumber: string; purpose: string; reason: string } {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const digits = typeof input.phone === "string" ? input.phone.replace(/\D/g, "") : "";
  const purpose = typeof input.purpose === "string" ? input.purpose : "";
  const names = new Set(typeof input.name === "string" ? input.name.toLowerCase().split(/\W+/) : []);
  let wordIndex = 0;
  const preview = purpose.replace(/\S+/g, (word) => {
    const capitalized = wordIndex++ > 0 && /\p{Lu}/u.test(word);
    const key = word.toLowerCase().replace(/^[.,!?;:]+|[.,!?;:]+$/g, "");
    return !capitalized && PURPOSE_AUDIT_WORDS.has(key) && !names.has(key) ? key : "[redacted]";
  }).replace(/\s+/g, " ").trim().slice(0, 160);
  return { maskedNumber: digits.length >= 4 ? `***${digits.slice(-4)}` : "unknown", purpose: preview, reason };
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
  if (entry.details) {
    clean.details = "operatorSms" in entry.details && entry.details.operatorSms === true ? {
      operatorSms: true, initiatedBy: entry.details.initiatedBy === "owner_request" ? "owner_request" : "bot_initiative",
      maskedNumber: /^\*\*\*\d{4}$/.test(entry.details.maskedNumber) ? entry.details.maskedNumber : "unknown",
    } : entry.details.approvalExempt === true ? {
      initiatedBy: "bot", approvalExempt: true, exemptReason: "owner_number",
    } : {
      maskedNumber: /^\*\*\*\d{4}$/.test(entry.details.maskedNumber) ? entry.details.maskedNumber : "unknown",
      purpose: directCallAuditDetails({ purpose: entry.details.purpose }, "").purpose,
      reason: entry.details.reason,
    };
  }
  if (auditContainsPhi(clean as unknown as Record<string, unknown>)) {
    throw new Error("plugin audit refused a row that looks like PHI");
  }
  return clean;
}
