/**
 * Every database read and write the plugin API makes, behind one interface
 * so the routes and the approval gate are tested against an in-memory fake
 * and never against the Hub. The SQL adapter is ./sqlStore.ts and is not
 * imported from tests.
 *
 * Tables (this app, Operations Hub — see migrations/add_plugin_api.sql):
 *   api_tokens, contact_approvals, plugin_audit_log
 *
 * plugin_audit_log holds no phone numbers, message bodies or transcripts.
 */

import { randomBytes } from "node:crypto";
import type { PluginScope } from "./scopes";
import { parseScopes } from "./scopes";
import {
  generateConfirmToken,
  generateTokenParts,
  hashSecret,
  isConfirmExpired,
  scopesOrDefault,
  verifyHashedSecret,
  type VerifiedPluginToken,
} from "./tokens";
import { sanitizeAuditEntry, type PluginAuditEntry } from "./audit";
import { CONFIRM_TTL_MS } from "./tokens";

export const CONTACT_CHANNELS = ["call", "sms", "email"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "committed",
  "failed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApiTokenRow {
  jti: string;
  hashedSecret: string;
  label: string | null;
  scopes: PluginScope[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

export interface ContactApprovalRow {
  id: string;
  channel: ContactChannel;
  status: ApprovalStatus;
  tokenJti: string;
  ticketId: string | null;
  ticketNumber: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  confirmTokenHash: string | null;
  confirmExpiresAt: Date | null;
  confirmUsedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  committedAt: Date | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallPayload {
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  ticketId?: string | null;
  ticketNumber?: string | null;
  purpose?: string | null;
}

export interface SmsPayload {
  phone: string;
  body: string;
  ticketId?: string | null;
  ticketNumber?: string | null;
}

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  ticketId?: string | null;
  ticketNumber?: string | null;
}

export type ContactPayload = CallPayload | SmsPayload | EmailPayload;

export interface PluginStore {
  findToken(jti: string): Promise<ApiTokenRow | null>;
  touchToken(jti: string, at: Date): Promise<void>;
  insertToken(row: ApiTokenRow): Promise<void>;
  revokeToken(jti: string, at: Date): Promise<boolean>;

  insertApproval(row: ContactApprovalRow): Promise<ContactApprovalRow>;
  getApproval(id: string): Promise<ContactApprovalRow | null>;
  listApprovals(status?: ApprovalStatus): Promise<ContactApprovalRow[]>;
  updateApproval(id: string, patch: Partial<ContactApprovalRow>, onlyIfStatus?: ApprovalStatus): Promise<ContactApprovalRow | null>;
  findApprovalByConfirmHash(hash: string): Promise<ContactApprovalRow | null>;
  /**
   * Single-use claim of an approved, unused, unexpired confirm token.
   * Must be one atomic check-and-set so two commits cannot both send.
   */
  claimConfirmToken(hash: string, now: Date): Promise<ContactApprovalRow | null>;
  /** Cancel only while the request is still open and the confirm token is unused. */
  cancelIfOpen(id: string, now: Date): Promise<ContactApprovalRow | null>;

  isSmsOptedOut(phoneKey: string): Promise<boolean>;
  setSmsOptOut(phoneKey: string, optedOut: boolean): Promise<void>;

  writeAudit(entry: PluginAuditEntry): Promise<void>;
  listAudit(): Promise<PluginAuditEntry[]>;
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export async function verifyStoredToken(
  store: PluginStore,
  parsed: { jti: string; secret: string },
  now = new Date(),
): Promise<VerifiedPluginToken | null> {
  const row = await store.findToken(parsed.jti);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!verifyHashedSecret(parsed.secret, row.hashedSecret)) return null;
  try {
    await store.touchToken(row.jti, now);
  } catch {
    // last_used_at is observational
  }
  return { jti: row.jti, label: row.label, scopes: parseScopes(row.scopes) };
}

export class MemoryPluginStore implements PluginStore {
  tokens = new Map<string, ApiTokenRow>();
  approvals = new Map<string, ContactApprovalRow>();
  smsOptOuts = new Set<string>();
  audit: PluginAuditEntry[] = [];

  /** Mint a token and return the plaintext once. */
  mint(scopes: string[] = ["fleet:read"], label = "test"): { plaintext: string; jti: string; scopes: PluginScope[] } {
    const parts = generateTokenParts();
    const parsed = scopesOrDefault(scopes);
    this.tokens.set(parts.jti, {
      jti: parts.jti,
      hashedSecret: hashSecret(parts.secret),
      label,
      scopes: parsed,
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    return { plaintext: parts.plaintext, jti: parts.jti, scopes: parsed };
  }

  async findToken(jti: string): Promise<ApiTokenRow | null> {
    return this.tokens.get(jti) ?? null;
  }
  async touchToken(jti: string, at: Date): Promise<void> {
    const row = this.tokens.get(jti);
    if (row) row.lastUsedAt = at;
  }
  async insertToken(row: ApiTokenRow): Promise<void> {
    this.tokens.set(row.jti, { ...row });
  }
  async revokeToken(jti: string, at: Date): Promise<boolean> {
    const row = this.tokens.get(jti);
    if (!row) return false;
    row.revokedAt = at;
    return true;
  }

  async insertApproval(row: ContactApprovalRow): Promise<ContactApprovalRow> {
    this.approvals.set(row.id, { ...row, payload: { ...row.payload } });
    return this.approvals.get(row.id)!;
  }
  async getApproval(id: string): Promise<ContactApprovalRow | null> {
    const row = this.approvals.get(id);
    return row ? { ...row, payload: { ...row.payload } } : null;
  }
  async listApprovals(status?: ApprovalStatus): Promise<ContactApprovalRow[]> {
    return [...this.approvals.values()]
      .filter((r) => (status ? r.status === status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r, payload: { ...r.payload } }));
  }
  async updateApproval(
    id: string,
    patch: Partial<ContactApprovalRow>,
    onlyIfStatus?: ApprovalStatus,
  ): Promise<ContactApprovalRow | null> {
    const row = this.approvals.get(id);
    if (!row) return null;
    if (onlyIfStatus && row.status !== onlyIfStatus) return null;
    Object.assign(row, patch, { updatedAt: patch.updatedAt ?? new Date() });
    return { ...row, payload: { ...row.payload } };
  }
  async findApprovalByConfirmHash(hash: string): Promise<ContactApprovalRow | null> {
    for (const row of this.approvals.values()) {
      if (row.confirmTokenHash === hash) return { ...row, payload: { ...row.payload } };
    }
    return null;
  }
  async claimConfirmToken(hash: string, now: Date): Promise<ContactApprovalRow | null> {
    // No await between the check and the write — JS is single-threaded,
    // so two overlapping calls still serialise here.
    for (const row of this.approvals.values()) {
      if (
        row.confirmTokenHash === hash &&
        row.status === "approved" &&
        !row.confirmUsedAt &&
        row.confirmExpiresAt &&
        row.confirmExpiresAt.getTime() > now.getTime()
      ) {
        row.confirmUsedAt = now;
        row.updatedAt = now;
        return { ...row, payload: { ...row.payload } };
      }
    }
    return null;
  }
  async cancelIfOpen(id: string, now: Date): Promise<ContactApprovalRow | null> {
    const row = this.approvals.get(id);
    if (!row) return null;
    if (row.confirmUsedAt) return null;
    if (row.status !== "pending" && row.status !== "approved") return null;
    row.status = "cancelled";
    row.cancelledAt = now;
    row.confirmTokenHash = null;
    row.confirmExpiresAt = null;
    row.updatedAt = now;
    return { ...row, payload: { ...row.payload } };
  }

  async isSmsOptedOut(phoneKey: string): Promise<boolean> {
    return this.smsOptOuts.has(phoneKey);
  }
  async setSmsOptOut(phoneKey: string, optedOut: boolean): Promise<void> {
    if (optedOut) this.smsOptOuts.add(phoneKey);
    else this.smsOptOuts.delete(phoneKey);
  }

  async writeAudit(entry: PluginAuditEntry): Promise<void> {
    this.audit.push({ ...sanitizeAuditEntry(entry), createdAt: entry.createdAt ?? new Date() });
  }
  async listAudit(): Promise<PluginAuditEntry[]> {
    return this.audit.map((e) => ({ ...e }));
  }
}

/** Redacted view the bot and get_contact_request may see. No payload. */
export function publicApproval(row: ContactApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    committedAt: row.committedAt?.toISOString() ?? null,
    confirmExpiresAt: row.confirmExpiresAt?.toISOString() ?? null,
    confirmUsed: Boolean(row.confirmUsedAt),
    result: row.result,
  };
}

/**
 * What the Pending bot actions page shows. Includes the payload the
 * fleet will send and the hash the approve/commit steps lock to.
 */
export function approvalForApprover(row: ContactApprovalRow): Record<string, unknown> {
  return {
    ...publicApproval(row),
    payload: { ...row.payload },
    payloadHash: row.payloadHash,
  };
}

export function issueConfirmOnApprove(now = new Date()): {
  plaintext: string;
  hash: string;
  expiresAt: Date;
} {
  const { plaintext, hash } = generateConfirmToken();
  return { plaintext, hash, expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS) };
}

export { isConfirmExpired, CONFIRM_TTL_MS };
