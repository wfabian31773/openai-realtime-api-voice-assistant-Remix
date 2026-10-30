/**
 * Every database read and write the plugin API makes, behind one interface
 * so the routes and the approval gate are tested against an in-memory fake
 * and never against the Hub. The SQL adapter is ./sqlStore.ts and is not
 * imported from tests.
 *
 * Tables (this app, Operations Hub — see migrations/add_plugin_api.sql):
 *   api_tokens, contact_approvals, plugin_audit_log, plugin_message_outbox
 *   plugin_operator_calls, plugin_operator_dnc (migrations/add_operator_line.sql)
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
import { ChannelDoNotContact } from "../runtime/outbound/channelDnc";
import type { OperatorInitiator } from "./operatorLine";
import type { TranscriptTurn } from "../runtime/transcriptLog";

export interface OperatorCallRecord {
  initiatedBy: OperatorInitiator;
  sessionId: string;
  approvalId: string;
  tokenJti: string;
  callSid: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  turns: TranscriptTurn[];
}

/** Request contents stay behind the authenticated transcript endpoint. */
export interface OperatorQueuedRequest {
  id: string;
  text: string;
  createdAt: string;
}

/** Separate from approval-owned outbound calls; never copied into audit. */
export interface OperatorInboundCallRecord {
  callId: string;
  callSid: string;
  direction: "inbound";
  laneSlug: "wayne-operator";
  callerNumber: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  turns: TranscriptTurn[];
  queuedRequests: OperatorQueuedRequest[];
  optedOut: boolean;
  transcriptUrl: string;
}

/** Private message/recording contents are only returned by operator:call fetches. */
export interface OperatorSmsRecord {
  messageSid: string;
  callerNumber: string | null;
  body: string;
  receivedAt: Date;
  fetchUrl: string;
}
export interface OperatorVoicemailRecord {
  recordingSid: string;
  callSid: string;
  recordingUrl: string | null;
  transcript: string | null;
  transcriptionStatus: string | null;
  receivedAt: Date;
  fetchUrl: string;
}

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
/**
 * A follow-up attachmentUpdate on an already delivered row has its own
 * budget. Running out never makes the message dead — it was delivered.
 */
export const ATTACHMENT_UPDATE_MAX_ATTEMPTS = 8;
export const RETURNED_CALL_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Undelivered outbox rows older than this are deleted. Delivered bodies are purged on settle. */
export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PluginStoreOptions {
  operatorNotificationClaimLeaseMs?: number;
}

/** Invalid lease settings fall back to 60s rather than allowing immediate reclaims. */
export function operatorNotificationClaimLeaseMs(options: PluginStoreOptions = {}): number {
  const leaseMs = options.operatorNotificationClaimLeaseMs
    ?? Number(process.env.OPERATOR_NOTIFICATION_CLAIM_LEASE_MS);
  return Number.isSafeInteger(leaseMs) && leaseMs > 0 ? leaseMs : 60_000;
}

export interface OperatorNotificationClaim {
  claimToken: string;
  claimedAt: Date;
  deliveredAt: Date | null;
}

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
  /** Request identity, separate from the human-approved payload/hash. */
  idempotencyKey?: string | null;
  ticketNumber: string | null;
  /** Last-10 of the destination phone. Lookup key only; never written to audit. */
  phoneKey?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  confirmTokenHash: string | null;
  /** Short-lived hand-off secret. Never exposed in approval views or audit. */
  confirmTokenPlaintext?: string | null;
  confirmExpiresAt: Date | null;
  confirmUsedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  /** Server-owned audit for scenario pre-approval; never part of bot input. */
  approvalMetadata?: { scenario_id: string } | null;
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
  idempotency_key?: string;
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
  /** Atomically claim a new or expired undelivered event; null means blocked. */
  claimOperatorNotification(eventId: string): Promise<string | null>;
  /** Only the current claim token can retain the event permanently after delivery. */
  markOperatorNotificationDelivered(eventId: string, claimToken: string): Promise<void>;
  /** Only the current claim token can release an undelivered event. */
  releaseOperatorNotification(eventId: string, claimToken: string): Promise<void>;
  getOperatorLineEnabled(): Promise<boolean>;
  setOperatorLineEnabled(enabled: boolean, updatedBy: string | null): Promise<void>;
  getOperatorScenarioPreapprovalEnabled(): Promise<boolean>;
  setOperatorScenarioPreapprovalEnabled(enabled: boolean, updatedBy: string | null): Promise<void>;
  /** First SMS with this MessageSid wins; null means a duplicate. */
  saveOperatorSms(record: OperatorSmsRecord): Promise<OperatorSmsRecord | null>;
  getOperatorSms(messageSid: string): Promise<OperatorSmsRecord | null>;
  /** Merge asynchronous recording/transcription callbacks without losing either. */
  saveOperatorVoicemail(record: OperatorVoicemailRecord): Promise<OperatorVoicemailRecord | null>;
  getOperatorVoicemail(recordingSid: string): Promise<OperatorVoicemailRecord | null>;
  startOperatorInboundCall(record: OperatorInboundCallRecord): Promise<OperatorInboundCallRecord>;
  getOperatorInboundCall(callSid: string): Promise<OperatorInboundCallRecord | null>;
  setOperatorInboundOptOut(callSid: string): Promise<void>;
  appendOperatorInboundRequest(callSid: string, request: OperatorQueuedRequest): Promise<OperatorInboundCallRecord | null>;
  /** Atomic first completion wins, including across callback retries. */
  finishOperatorInboundCall(callSid: string, endedAt: Date, status: string, turns: TranscriptTurn[]): Promise<OperatorInboundCallRecord | null>;
  isOperatorOptedOut(phone: string): Promise<boolean>;
  setOperatorOptOut(phone: string): Promise<void>;
  saveOperatorCall(record: OperatorCallRecord): Promise<void>;
  getOperatorCall(sessionId: string): Promise<OperatorCallRecord | null>;
  findToken(jti: string): Promise<ApiTokenRow | null>;
  touchToken(jti: string, at: Date): Promise<void>;
  insertToken(row: ApiTokenRow): Promise<void>;
  revokeToken(jti: string, at: Date): Promise<boolean>;

  insertApproval(row: ContactApprovalRow): Promise<ContactApprovalRow>;
  findApprovalByIdempotencyKey(tokenJti: string, key: string): Promise<ContactApprovalRow | null>;
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
  /** Atomic owner-only read-and-clear. A token can be fetched at most once. */
  takeConfirmToken(id: string, tokenJti: string, now: Date): Promise<{ confirmToken: string; expiresAt: Date } | null>;
  purgeExpiredConfirmTokens(now: Date): Promise<void>;
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
  getOutbox(id: string): Promise<MessageOutboxRow | null>;
  claimDueOutbox(now: Date, limit: number): Promise<MessageOutboxRow[]>;
  markOutbox(
    id: string,
    patch: Partial<MessageOutboxRow>,
    onlyIfStatus?: OutboxStatus,
  ): Promise<MessageOutboxRow | null>;
  /** Reset stale `sending` outbox rows to `pending` so the sweep can retry. */
  reclaimStaleOutboxSending(now: Date, staleBefore: Date): Promise<MessageOutboxRow[]>;
  /**
   * Delivered rows whose attachmentUpdate follow-up is still owed and due.
   * Leases each row until `leaseUntil` so two sweeps do not send it twice.
   */
  claimDueAttachmentUpdates(now: Date, leaseUntil: Date, limit: number): Promise<MessageOutboxRow[]>;
  /** Empty delivered bodies (PHI), and null the sender phone and MessageSid with them. */
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
  /** Inbound SMS sender (E.164). PHI. Forwarded to the webhook, never logged. */
  fromPhone?: string | null;
  /** Twilio MessageSid of an inbound SMS. */
  messageSid?: string | null;
  /** When the webhook first answered 2xx for this row. Null until then. */
  deliveredAt?: Date | null;
  /** A delivered row still owes an attachmentUpdate follow-up. */
  attachmentPending?: boolean;
  attachmentAttempts?: number;
  attachmentNextAttemptAt?: Date | null;
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
  private readonly notificationClaimLeaseMs: number;
  constructor(options: PluginStoreOptions = {}) {
    this.notificationClaimLeaseMs = operatorNotificationClaimLeaseMs(options);
  }
  operatorNotifications = new Map<string, OperatorNotificationClaim>();
  async claimOperatorNotification(eventId: string): Promise<string | null> {
    const now = new Date();
    const prior = this.operatorNotifications.get(eventId);
    if (prior && (prior.deliveredAt !== null
      || prior.claimedAt.getTime() >= now.getTime() - this.notificationClaimLeaseMs)) return null;
    const claimToken = newId();
    this.operatorNotifications.set(eventId, { claimToken, claimedAt: now, deliveredAt: null });
    return claimToken;
  }
  async markOperatorNotificationDelivered(eventId: string, claimToken: string): Promise<void> {
    const claim = this.operatorNotifications.get(eventId);
    if (claim?.claimToken === claimToken && claim.deliveredAt === null) claim.deliveredAt = new Date();
  }
  async releaseOperatorNotification(eventId: string, claimToken: string): Promise<void> {
    const claim = this.operatorNotifications.get(eventId);
    if (claim?.claimToken === claimToken && claim.deliveredAt === null) this.operatorNotifications.delete(eventId);
  }
  operatorLineEnabled = true;
  async getOperatorLineEnabled(): Promise<boolean> { return this.operatorLineEnabled; }
  async setOperatorLineEnabled(enabled: boolean, _updatedBy: string | null): Promise<void> { this.operatorLineEnabled = enabled; }
  operatorScenarioPreapprovalEnabled = false;
  async getOperatorScenarioPreapprovalEnabled(): Promise<boolean> { return this.operatorScenarioPreapprovalEnabled; }
  async setOperatorScenarioPreapprovalEnabled(enabled: boolean, _updatedBy: string | null): Promise<void> { this.operatorScenarioPreapprovalEnabled = enabled; }
  operatorSms = new Map<string, OperatorSmsRecord>();
  async saveOperatorSms(record: OperatorSmsRecord): Promise<OperatorSmsRecord | null> {
    if (this.operatorSms.has(record.messageSid)) return null;
    this.operatorSms.set(record.messageSid, structuredClone(record));
    return structuredClone(record);
  }
  async getOperatorSms(messageSid: string): Promise<OperatorSmsRecord | null> { return structuredClone(this.operatorSms.get(messageSid) ?? null); }
  operatorVoicemails = new Map<string, OperatorVoicemailRecord>();
  async saveOperatorVoicemail(record: OperatorVoicemailRecord): Promise<OperatorVoicemailRecord | null> {
    const prior = this.operatorVoicemails.get(record.recordingSid);
    if (prior && prior.callSid !== record.callSid) return null;
    const merged = prior ? { ...prior, recordingUrl: record.recordingUrl ?? prior.recordingUrl,
      transcript: record.transcript ?? prior.transcript, transcriptionStatus: record.transcriptionStatus ?? prior.transcriptionStatus } : record;
    if (prior && JSON.stringify(prior) === JSON.stringify(merged)) return null;
    this.operatorVoicemails.set(record.recordingSid, structuredClone(merged));
    return structuredClone(merged);
  }
  async getOperatorVoicemail(recordingSid: string): Promise<OperatorVoicemailRecord | null> { return structuredClone(this.operatorVoicemails.get(recordingSid) ?? null); }
  operatorInboundCalls = new Map<string, OperatorInboundCallRecord>();
  async startOperatorInboundCall(record: OperatorInboundCallRecord): Promise<OperatorInboundCallRecord> {
    if (!this.operatorInboundCalls.has(record.callSid)) this.operatorInboundCalls.set(record.callSid, structuredClone(record));
    return structuredClone(this.operatorInboundCalls.get(record.callSid)!);
  }
  async getOperatorInboundCall(callSid: string): Promise<OperatorInboundCallRecord | null> {
    return structuredClone(this.operatorInboundCalls.get(callSid) ?? null);
  }
  async setOperatorInboundOptOut(callSid: string): Promise<void> {
    const record = this.operatorInboundCalls.get(callSid);
    if (record && !record.endedAt) record.optedOut = true;
  }
  async appendOperatorInboundRequest(callSid: string, request: OperatorQueuedRequest): Promise<OperatorInboundCallRecord | null> {
    const record = this.operatorInboundCalls.get(callSid);
    if (!record || record.endedAt) return null;
    if (!record.queuedRequests.some((item) => item.id === request.id)) record.queuedRequests.push(structuredClone(request));
    return structuredClone(record);
  }
  async finishOperatorInboundCall(callSid: string, endedAt: Date, status: string, turns: TranscriptTurn[]): Promise<OperatorInboundCallRecord | null> {
    const record = this.operatorInboundCalls.get(callSid);
    if (!record || record.endedAt) return null;
    Object.assign(record, { endedAt, status, turns: structuredClone(turns) });
    return structuredClone(record);
  }
  operatorOptOuts = new Set<string>();
  async isOperatorOptedOut(phone: string): Promise<boolean> { return this.operatorOptOuts.has(phone); }
  async setOperatorOptOut(phone: string): Promise<void> { this.operatorOptOuts.add(phone); }
  operatorCalls = new Map<string, OperatorCallRecord>();
  async saveOperatorCall(record: OperatorCallRecord): Promise<void> {
    this.operatorCalls.set(record.sessionId, { ...record, turns: record.turns.map((turn) => ({ ...turn })) });
  }
  async getOperatorCall(sessionId: string): Promise<OperatorCallRecord | null> {
    const record = this.operatorCalls.get(sessionId);
    return record ? { ...record, turns: record.turns.map((turn) => ({ ...turn })) } : null;
  }
  tokens = new Map<string, ApiTokenRow>();
  approvals = new Map<string, ContactApprovalRow>();
  outbox = new Map<string, MessageOutboxRow>();
  channelDnc = new ChannelDoNotContact();
  get smsOptOuts(): Set<string> {
    return this.channelDnc.sms;
  }
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
    // No await between checking the key and inserting, including concurrent prepares.
    if (row.idempotencyKey != null) {
      const existing = [...this.approvals.values()].find((item) => item.tokenJti === row.tokenJti
        && item.idempotencyKey === row.idempotencyKey && item.status !== "rejected" && item.status !== "cancelled");
      if (existing) return { ...existing, payload: { ...existing.payload } };
    }
    this.approvals.set(row.id, { ...row, payload: { ...row.payload } });
    return this.approvals.get(row.id)!;
  }
  async findApprovalByIdempotencyKey(tokenJti: string, key: string): Promise<ContactApprovalRow | null> {
    const row = [...this.approvals.values()].find((item) => item.tokenJti === tokenJti
      && item.idempotencyKey === key && item.status !== "rejected" && item.status !== "cancelled");
    return row ? { ...row, payload: { ...row.payload } } : null;
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
        row.confirmTokenPlaintext = null;
        row.confirmUsedAt = now;
        row.status = "sending";
        row.updatedAt = now;
        return { ...row, payload: { ...row.payload } };
      }
    }
    return null;
  }
  async takeConfirmToken(id: string, tokenJti: string, now: Date): Promise<{ confirmToken: string; expiresAt: Date } | null> {
    await this.purgeExpiredConfirmTokens(now);
    const row = this.approvals.get(id);
    if (!row || row.tokenJti !== tokenJti || row.status !== "approved" || row.confirmUsedAt ||
        !row.confirmTokenPlaintext || !row.confirmExpiresAt || row.confirmExpiresAt <= now) return null;
    const confirmToken = row.confirmTokenPlaintext;
    row.confirmTokenPlaintext = null;
    return { confirmToken, expiresAt: row.confirmExpiresAt };
  }
  async purgeExpiredConfirmTokens(now: Date): Promise<void> {
    for (const row of this.approvals.values()) {
      if (row.confirmExpiresAt && row.confirmExpiresAt <= now) row.confirmTokenPlaintext = null;
    }
  }
  async cancelIfOpen(id: string, now: Date): Promise<ContactApprovalRow | null> {
    const row = this.approvals.get(id);
    if (!row) return null;
    if (row.confirmUsedAt) return null;
    if (row.status !== "pending" && row.status !== "approved") return null;
    row.status = "cancelled";
    row.cancelledAt = now;
    row.confirmTokenPlaintext = null;
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

  async getOutbox(id: string): Promise<MessageOutboxRow | null> {
    const row = this.outbox.get(id);
    return row ? { ...row } : null;
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

  async claimDueAttachmentUpdates(now: Date, leaseUntil: Date, limit: number): Promise<MessageOutboxRow[]> {
    const due = [...this.outbox.values()]
      .filter(
        (r) =>
          r.status === "delivered" &&
          r.attachmentPending === true &&
          (r.attachmentNextAttemptAt?.getTime() ?? 0) <= now.getTime(),
      )
      .slice(0, Math.max(0, limit));
    for (const row of due) {
      row.attachmentNextAttemptAt = leaseUntil;
      row.updatedAt = now;
    }
    return due.map((r) => ({ ...r }));
  }

  async purgeDeliveredOutboxBodies(now: Date): Promise<number> {
    let n = 0;
    for (const row of this.outbox.values()) {
      if (row.status !== "delivered") continue;
      if (row.message === "" && !row.fromPhone && !row.messageSid) continue;
      // The sender's number and the MessageSid go with the body.
      row.message = "";
      row.fromPhone = null;
      row.messageSid = null;
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
    return this.channelDnc.isSmsBlocked(phoneKey);
  }
  async setSmsOptOut(phoneKey: string, optedOut: boolean): Promise<void> {
    this.channelDnc.setSms(phoneKey, optedOut);
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
    ...(row.payload.callKind === "operator" ? { callKind: "operator", maskedNumber: `***${String(row.payload.phone).slice(-4)}` } : {}),
    ...(row.payload.smsKind === "operator" ? {
      smsKind: "operator", laneSlug: row.payload.laneSlug, initiated_by: row.payload.initiated_by,
      maskedNumber: `***${String(row.payload.phone).slice(-4)}`,
      maskedFromNumber: `***${String(row.payload.fromNumber).slice(-4)}`,
    } : {}),
    status: row.status,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    ...(row.approvedBy === "scenario_preapproval" ? {
      approvedBy: row.approvedBy, approvalMetadata: row.approvalMetadata ?? null,
    } : {}),
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
