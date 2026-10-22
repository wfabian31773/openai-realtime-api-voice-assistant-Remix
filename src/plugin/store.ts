/**
 * Every database read and write the plugin API makes, behind one interface
 * so the routes and the approval gate are tested against an in-memory fake
 * and never against the Hub. The SQL adapter is ./sqlStore.ts and is not
 * imported from tests.
 *
 * Tables (this app, Operations Hub — see migrations/add_plugin_api.sql):
 *   api_tokens, contact_approvals, plugin_audit_log, plugin_message_outbox
 *
 * plugin_audit_log holds no phone numbers, message bodies or transcripts.
 * plugin_message_outbox is the one table that may hold a taken-message
 * body — never copy that column into the audit log.
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
  "sending",
  "rejected",
  "cancelled",
  "committed",
  "failed",
  "unknown",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const OUTBOX_STATUSES = ["pending", "sending", "delivered", "dead"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * How long a claim may sit in `sending` before the sweep labels it
 * `unknown`. Never resends. Graph and Twilio are bounded well under this.
 */
export const STALE_SENDING_MS = 10 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 8;
export const RETURNED_CALL_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Undelivered outbox rows older than this are deleted. Delivered bodies are purged on settle. */
export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  /** Last-10 of the destination phone. Lookup key only; never written to audit. */
  phoneKey?: string | null;
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
  dateOfBirth?: string | null;
  date_of_birth?: string | null;
  birthMonth?: string | number | null;
  birthDay?: string | number | null;
  birthYear?: string | number | null;
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
   * Moves the row to `sending`.
   */
  claimConfirmToken(hash: string, now: Date): Promise<ContactApprovalRow | null>;
  /** Cancel only while the request is still open and the confirm token is unused. */
  cancelIfOpen(id: string, now: Date): Promise<ContactApprovalRow | null>;
  /**
   * Mark `sending` rows whose claim is older than `staleBefore` as unknown.
   * Never resends. Audit separately, ids only.
   */
  reapStaleSending(now: Date, staleBefore: Date): Promise<ContactApprovalRow[]>;
  /**
   * Contacts that were actually sent to this last-10 (`committed` with a
   * `committedAt` on or after `since`). Unsent approvals do not count.
   */
  listCommittedContactsByPhone(phoneKey: string, since: Date): Promise<ContactApprovalRow[]>;

  insertOutbox(row: MessageOutboxRow): Promise<MessageOutboxRow>;
  claimDueOutbox(now: Date, limit: number): Promise<MessageOutboxRow[]>;
  markOutbox(
    id: string,
    patch: Partial<MessageOutboxRow>,
    onlyIfStatus?: OutboxStatus,
  ): Promise<MessageOutboxRow | null>;
  /** Reset stale `sending` outbox rows to `pending` so the sweep can retry. */
  reclaimStaleOutboxSending(now: Date, staleBefore: Date): Promise<MessageOutboxRow[]>;
  /** Empty delivered bodies (PHI). */
  purgeDeliveredOutboxBodies(now: Date): Promise<number>;
  /** Delete undelivered rows older than `olderThan`. Returns the deleted ids. */
  purgeExpiredOutbox(now: Date, olderThan: Date): Promise<string[]>;
  /** Ids that would be deleted — audit these first (P3-B). */
  listExpiredOutboxIds(olderThan: Date): Promise<string[]>;
  /** Delete only the ids that were audited. */
  deleteOutboxIds(ids: string[]): Promise<number>;
  /**
   * Stamp ticket keys on unmatched rows for this call so a message taken
   * before identification carries the same identity as the call report.
   */
  attachOutboxTickets(
    callSid: string,
    extras: { ticketId?: string | null; ticketNumber?: string | null; approvalId?: string | null },
    now: Date,
  ): Promise<MessageOutboxRow[]>;

  isSmsOptedOut(phoneKey: string): Promise<boolean>;
  setSmsOptOut(phoneKey: string, optedOut: boolean): Promise<void>;

  writeAudit(entry: PluginAuditEntry): Promise<void>;
  listAudit(): Promise<PluginAuditEntry[]>;
}

export interface MessageOutboxRow {
  id: string;
  callSid: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  approvalId: string | null;
  /** Taken-message text. PHI. Never copy into plugin_audit_log. */
  message: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  /** sha256(callSid + "\\n" + message). Retries with the same words reuse the row. */
  idempotencyKey?: string | null;
  /** Ticket number + approval id only. Unmatched My Messages routing hints. */
  suggestions?: Array<{ ticketNumber: string | null; approvalId: string | null }> | null;
  createdAt: Date;
  updatedAt: Date;
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
  outbox = new Map<string, MessageOutboxRow>();
  smsOptOuts = new Set<string>();
  audit: PluginAuditEntry[] = [];
  /** Tests only: persist-first path must be able to fail closed. */
  outboxBroken = false;

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
        row.status = "sending";
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

  async reapStaleSending(now: Date, staleBefore: Date): Promise<ContactApprovalRow[]> {
    const marked: ContactApprovalRow[] = [];
    for (const row of this.approvals.values()) {
      if (row.status !== "sending") continue;
      if (row.updatedAt.getTime() >= staleBefore.getTime()) continue;
      row.status = "unknown";
      row.result = { reason: "stale_send" };
      row.updatedAt = now;
      marked.push({ ...row, payload: { ...row.payload } });
    }
    return marked;
  }

  async listCommittedContactsByPhone(phoneKey: string, since: Date): Promise<ContactApprovalRow[]> {
    if (!phoneKey) return [];
    return [...this.approvals.values()]
      .filter((row) => {
        if (row.status !== "committed") return false;
        if (!row.committedAt || row.committedAt.getTime() < since.getTime()) return false;
        const key = row.phoneKey ?? phoneKeyOfPayload(row.payload);
        return key === phoneKey;
      })
      .sort((a, b) => (b.committedAt ?? b.createdAt).getTime() - (a.committedAt ?? a.createdAt).getTime())
      .map((r) => ({ ...r, payload: { ...r.payload } }));
  }

  async insertOutbox(row: MessageOutboxRow): Promise<MessageOutboxRow> {
    if (this.outboxBroken) throw new Error("outbox unavailable");
    if (row.idempotencyKey) {
      for (const existing of this.outbox.values()) {
        if (existing.idempotencyKey === row.idempotencyKey) return { ...existing };
      }
    }
    const stored = { ...row };
    this.outbox.set(row.id, stored);
    return { ...stored };
  }

  async claimDueOutbox(now: Date, limit: number): Promise<MessageOutboxRow[]> {
    const due = [...this.outbox.values()]
      .filter((r) => r.status === "pending" && r.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, Math.max(0, limit));
    const claimed: MessageOutboxRow[] = [];
    for (const row of due) {
      row.status = "sending";
      row.attempts += 1;
      row.updatedAt = now;
      claimed.push({ ...row });
    }
    return claimed;
  }

  async markOutbox(
    id: string,
    patch: Partial<MessageOutboxRow>,
    onlyIfStatus?: OutboxStatus,
  ): Promise<MessageOutboxRow | null> {
    const row = this.outbox.get(id);
    if (!row) return null;
    if (onlyIfStatus && row.status !== onlyIfStatus) return null;
    Object.assign(row, patch, { updatedAt: patch.updatedAt ?? new Date() });
    return { ...row };
  }

  async reclaimStaleOutboxSending(now: Date, staleBefore: Date): Promise<MessageOutboxRow[]> {
    const reclaimed: MessageOutboxRow[] = [];
    for (const row of this.outbox.values()) {
      if (row.status !== "sending") continue;
      if (row.updatedAt.getTime() >= staleBefore.getTime()) continue;
      row.status = "pending";
      row.lastError = "stale_sending";
      row.updatedAt = now;
      reclaimed.push({ ...row });
    }
    return reclaimed;
  }

  async purgeDeliveredOutboxBodies(now: Date): Promise<number> {
    let n = 0;
    for (const row of this.outbox.values()) {
      if (row.status !== "delivered" || row.message === "") continue;
      row.message = "";
      row.updatedAt = now;
      n += 1;
    }
    return n;
  }

  async listExpiredOutboxIds(olderThan: Date): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, row] of this.outbox) {
      if (row.status === "delivered") continue;
      if (row.createdAt.getTime() >= olderThan.getTime()) continue;
      ids.push(id);
    }
    return ids;
  }

  async deleteOutboxIds(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const row = this.outbox.get(id);
      if (!row || row.status === "delivered") continue;
      if (this.outbox.delete(id)) n += 1;
    }
    return n;
  }

  async purgeExpiredOutbox(_now: Date, olderThan: Date): Promise<string[]> {
    const ids = await this.listExpiredOutboxIds(olderThan);
    await this.deleteOutboxIds(ids);
    return ids;
  }

  async attachOutboxTickets(
    callSid: string,
    extras: { ticketId?: string | null; ticketNumber?: string | null; approvalId?: string | null },
    now: Date,
  ): Promise<MessageOutboxRow[]> {
    if (!callSid) return [];
    const updated: MessageOutboxRow[] = [];
    for (const row of this.outbox.values()) {
      if (row.callSid !== callSid) continue;
      if (row.ticketId || row.ticketNumber || row.approvalId) continue;
      row.ticketId = extras.ticketId ?? null;
      row.ticketNumber = extras.ticketNumber ?? null;
      row.approvalId = extras.approvalId ?? null;
      row.suggestions = [];
      row.updatedAt = now;
      updated.push({ ...row });
    }
    return updated;
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

export function phoneKeyOfPayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload || typeof payload.phone !== "string") return null;
  const digits = payload.phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}
