/**
 * Hub-backed PluginStore. Imported only from production wiring, never from
 * tests. Tables come from migrations/add_plugin_api.sql — this adapter does
 * not CREATE them. A missing table fails closed.
 */

import type { PluginAuditEntry } from "./audit";
import { sanitizeAuditEntry } from "./audit";
import { parseScopes } from "./scopes";
import type {
  ApiTokenRow,
  ApprovalStatus,
  ContactApprovalRow,
  ContactChannel,
  MessageOutboxRow,
  OutboxStatus,
  PluginStore,
} from "./store";

export type SqlExec = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function tokenFrom(r: Record<string, unknown>): ApiTokenRow {
  return {
    jti: String(r.jti),
    hashedSecret: String(r.hashed_secret ?? r.hashedSecret),
    label: (r.label as string | null) ?? null,
    scopes: parseScopes((r.scopes as string[]) ?? []),
    revokedAt: r.revoked_at ? new Date(String(r.revoked_at)) : null,
    expiresAt: r.expires_at ? new Date(String(r.expires_at)) : null,
    lastUsedAt: r.last_used_at ? new Date(String(r.last_used_at)) : null,
  };
}

function approvalFrom(r: Record<string, unknown>): ContactApprovalRow {
  const raw = r.payload;
  const payload =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : typeof raw === "string"
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
  return {
    id: String(r.id),
    channel: r.channel as ContactChannel,
    status: r.status as ApprovalStatus,
    tokenJti: String(r.token_jti ?? r.tokenJti),
    ticketId: (r.ticket_id as string | null) ?? null,
    ticketNumber: (r.ticket_number as string | null) ?? null,
    phoneKey: (r.phone_key as string | null) ?? null,
    payload,
    payloadHash: String(r.payload_hash),
    confirmTokenHash: (r.confirm_token_hash as string | null) ?? null,
    confirmExpiresAt: r.confirm_expires_at ? new Date(String(r.confirm_expires_at)) : null,
    confirmUsedAt: r.confirm_used_at ? new Date(String(r.confirm_used_at)) : null,
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: r.approved_at ? new Date(String(r.approved_at)) : null,
    rejectedBy: (r.rejected_by as string | null) ?? null,
    rejectedAt: r.rejected_at ? new Date(String(r.rejected_at)) : null,
    cancelledAt: r.cancelled_at ? new Date(String(r.cancelled_at)) : null,
    committedAt: r.committed_at ? new Date(String(r.committed_at)) : null,
    result: (r.result as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)),
    updatedAt: new Date(String(r.updated_at)),
  };
}

function outboxFrom(r: Record<string, unknown>): MessageOutboxRow {
  return {
    id: String(r.id),
    callSid: (r.call_sid as string | null) ?? null,
    ticketId: (r.ticket_id as string | null) ?? null,
    ticketNumber: (r.ticket_number as string | null) ?? null,
    approvalId: (r.approval_id as string | null) ?? null,
    message: String(r.message ?? ""),
    status: r.status as OutboxStatus,
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: new Date(String(r.next_attempt_at)),
    lastError: (r.last_error as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    suggestions: suggestionsFrom(r.suggestions),
    fromPhone: (r.from_phone as string | null) ?? null,
    messageSid: (r.message_sid as string | null) ?? null,
    deliveredAt: r.delivered_at ? new Date(String(r.delivered_at)) : null,
    attachmentPending: r.attachment_pending === true,
    attachmentAttempts: Number(r.attachment_attempts ?? 0),
    attachmentNextAttemptAt: r.attachment_next_attempt_at ? new Date(String(r.attachment_next_attempt_at)) : null,
    createdAt: new Date(String(r.created_at)),
    updatedAt: new Date(String(r.updated_at)),
  };
}

function suggestionsFrom(
  value: unknown,
): Array<{ ticketNumber: string | null; approvalId: string | null }> | null {
  if (!value) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  const out: Array<{ ticketNumber: string | null; approvalId: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { ticketNumber?: unknown; approvalId?: unknown };
    const ticketNumber = typeof row.ticketNumber === "string" ? row.ticketNumber : null;
    const approvalId = typeof row.approvalId === "string" ? row.approvalId : null;
    if (!ticketNumber && !approvalId) continue;
    out.push({ ticketNumber, approvalId });
  }
  return out;
}

export function createSqlPluginStore(exec: SqlExec): PluginStore {
  return {
    async findToken(jti) {
      const rows = await exec("SELECT * FROM api_tokens WHERE jti = $1 LIMIT 1", [jti]);
      return rows[0] ? tokenFrom(rows[0]) : null;
    },
    async touchToken(jti, at) {
      await exec("UPDATE api_tokens SET last_used_at = $1 WHERE jti = $2", [at.toISOString(), jti]);
    },
    async insertToken(row) {
      await exec(
        "INSERT INTO api_tokens (jti, hashed_secret, label, scopes) VALUES ($1, $2, $3, $4)",
        [row.jti, row.hashedSecret, row.label, row.scopes],
      );
    },
    async revokeToken(jti, at) {
      const rows = await exec("UPDATE api_tokens SET revoked_at = $1 WHERE jti = $2 RETURNING jti", [
        at.toISOString(),
        jti,
      ]);
      return rows.length > 0;
    },
    async insertApproval(row) {
      const rows = await exec(
        `INSERT INTO contact_approvals (
            id, channel, status, token_jti, ticket_id, ticket_number, phone_key, payload, payload_hash, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [
          row.id,
          row.channel,
          row.status,
          row.tokenJti,
          row.ticketId,
          row.ticketNumber,
          row.phoneKey ?? null,
          JSON.stringify(row.payload),
          row.payloadHash,
          row.createdAt.toISOString(),
          row.updatedAt.toISOString(),
        ],
      );
      return rows[0] ? approvalFrom(rows[0]) : row;
    },
    async getApproval(id) {
      const rows = await exec("SELECT * FROM contact_approvals WHERE id = $1 LIMIT 1", [id]);
      return rows[0] ? approvalFrom(rows[0]) : null;
    },
    async listApprovals(status) {
      const rows = status
        ? await exec("SELECT * FROM contact_approvals WHERE status = $1 ORDER BY created_at DESC LIMIT 100", [status])
        : await exec("SELECT * FROM contact_approvals ORDER BY created_at DESC LIMIT 100");
      return rows.map(approvalFrom);
    },
    async updateApproval(id, patch, onlyIfStatus) {
      const current = await this.getApproval(id);
      if (!current) return null;
      if (onlyIfStatus && current.status !== onlyIfStatus) return null;
      const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date() };
      const rows = await exec(
        `UPDATE contact_approvals SET
            status = $1,
            confirm_token_hash = $2,
            confirm_expires_at = $3,
            confirm_used_at = $4,
            approved_by = $5,
            approved_at = $6,
            rejected_by = $7,
            rejected_at = $8,
            cancelled_at = $9,
            committed_at = $10,
            result = $11::jsonb,
            updated_at = $12
          WHERE id = $13 AND ($14::text IS NULL OR status = $14)
          RETURNING *`,
        [
          next.status,
          next.confirmTokenHash,
          next.confirmExpiresAt?.toISOString() ?? null,
          next.confirmUsedAt?.toISOString() ?? null,
          next.approvedBy,
          next.approvedAt?.toISOString() ?? null,
          next.rejectedBy,
          next.rejectedAt?.toISOString() ?? null,
          next.cancelledAt?.toISOString() ?? null,
          next.committedAt?.toISOString() ?? null,
          next.result ? JSON.stringify(next.result) : null,
          next.updatedAt.toISOString(),
          id,
          onlyIfStatus ?? null,
        ],
      );
      return rows[0] ? approvalFrom(rows[0]) : null;
    },
    async findApprovalByConfirmHash(hash) {
      const rows = await exec("SELECT * FROM contact_approvals WHERE confirm_token_hash = $1 LIMIT 1", [hash]);
      return rows[0] ? approvalFrom(rows[0]) : null;
    },
    async claimConfirmToken(hash, now) {
      const at = now.toISOString();
      const rows = await exec(
        `UPDATE contact_approvals
            SET confirm_used_at = $2, status = 'sending', updated_at = $2
          WHERE confirm_token_hash = $1
            AND status = 'approved'
            AND confirm_used_at IS NULL
            AND confirm_expires_at > $2
          RETURNING *`,
        [hash, at],
      );
      return rows[0] ? approvalFrom(rows[0]) : null;
    },
    async cancelIfOpen(id, now) {
      const at = now.toISOString();
      const rows = await exec(
        `UPDATE contact_approvals
            SET status = 'cancelled',
                cancelled_at = $2,
                confirm_token_hash = NULL,
                confirm_expires_at = NULL,
                updated_at = $2
          WHERE id = $1
            AND status IN ('pending', 'approved')
            AND confirm_used_at IS NULL
          RETURNING *`,
        [id, at],
      );
      return rows[0] ? approvalFrom(rows[0]) : null;
    },
    async reapStaleSending(now, staleBefore) {
      const rows = await exec(
        `UPDATE contact_approvals
            SET status = 'unknown',
                result = jsonb_build_object('reason', 'stale_send'),
                updated_at = $1
          WHERE status = 'sending'
            AND updated_at < $2
          RETURNING *`,
        [now.toISOString(), staleBefore.toISOString()],
      );
      return rows.map(approvalFrom);
    },
    async listCommittedContactsByPhone(phoneKey, since) {
      if (!phoneKey) return [];
      const rows = await exec(
        `SELECT * FROM contact_approvals
          WHERE phone_key = $1
            AND status = 'committed'
            AND committed_at IS NOT NULL
            AND committed_at >= $2
          ORDER BY committed_at DESC`,
        [phoneKey, since.toISOString()],
      );
      return rows.map(approvalFrom);
    },
    async insertOutbox(row) {
      const rows = await exec(
        `INSERT INTO plugin_message_outbox (
            id, call_sid, ticket_id, ticket_number, approval_id, message,
            status, attempts, next_attempt_at, last_error, idempotency_key,
            suggestions, created_at, updated_at, from_phone, message_sid
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING *`,
        [
          row.id,
          row.callSid,
          row.ticketId,
          row.ticketNumber,
          row.approvalId,
          row.message,
          row.status,
          row.attempts,
          row.nextAttemptAt.toISOString(),
          row.lastError,
          row.idempotencyKey ?? null,
          JSON.stringify(row.suggestions ?? []),
          row.createdAt.toISOString(),
          row.updatedAt.toISOString(),
          row.fromPhone ?? null,
          row.messageSid ?? null,
        ],
      );
      if (rows[0]) return outboxFrom(rows[0]);
      if (row.idempotencyKey) {
        const existing = await exec(
          "SELECT * FROM plugin_message_outbox WHERE idempotency_key = $1 LIMIT 1",
          [row.idempotencyKey],
        );
        if (existing[0]) return outboxFrom(existing[0]);
      }
      return row;
    },
    async getOutbox(id) {
      const rows = await exec("SELECT * FROM plugin_message_outbox WHERE id = $1 LIMIT 1", [id]);
      return rows[0] ? outboxFrom(rows[0]) : null;
    },
    async claimDueOutbox(now, limit) {
      const rows = await exec(
        `UPDATE plugin_message_outbox
            SET status = 'sending',
                attempts = attempts + 1,
                updated_at = $1
          WHERE id IN (
            SELECT id FROM plugin_message_outbox
             WHERE status = 'pending'
               AND next_attempt_at <= $1
             ORDER BY next_attempt_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now.toISOString(), limit],
      );
      return rows.map(outboxFrom);
    },
    async markOutbox(id, patch, onlyIfStatus) {
      const rows = await exec(
        `UPDATE plugin_message_outbox SET
            status = COALESCE($2, status),
            next_attempt_at = COALESCE($3, next_attempt_at),
            last_error = $4,
            updated_at = $5,
            attempts = COALESCE($7, attempts),
            message = COALESCE($8, message),
            delivered_at = COALESCE($9::timestamptz, delivered_at),
            attachment_pending = COALESCE($10::boolean, attachment_pending),
            attachment_attempts = COALESCE($11::integer, attachment_attempts),
            attachment_next_attempt_at = COALESCE($12::timestamptz, attachment_next_attempt_at)
          WHERE id = $1 AND ($6::text IS NULL OR status = $6)
          RETURNING *`,
        [
          id,
          patch.status ?? null,
          patch.nextAttemptAt?.toISOString() ?? null,
          patch.lastError ?? null,
          (patch.updatedAt ?? new Date()).toISOString(),
          onlyIfStatus ?? null,
          patch.attempts ?? null,
          patch.message ?? null,
          patch.deliveredAt?.toISOString() ?? null,
          patch.attachmentPending ?? null,
          patch.attachmentAttempts ?? null,
          patch.attachmentNextAttemptAt?.toISOString() ?? null,
        ],
      );
      return rows[0] ? outboxFrom(rows[0]) : null;
    },
    async reclaimStaleOutboxSending(now, staleBefore) {
      const rows = await exec(
        `UPDATE plugin_message_outbox
            SET status = 'pending',
                last_error = 'stale_sending',
                updated_at = $1
          WHERE status = 'sending'
            AND updated_at < $2
          RETURNING *`,
        [now.toISOString(), staleBefore.toISOString()],
      );
      return rows.map(outboxFrom);
    },
    async claimDueAttachmentUpdates(now, leaseUntil, limit) {
      const rows = await exec(
        `UPDATE plugin_message_outbox
            SET attachment_next_attempt_at = $2,
                updated_at = $1
          WHERE id IN (
            SELECT id FROM plugin_message_outbox
             WHERE status = 'delivered'
               AND attachment_pending
               AND coalesce(attachment_next_attempt_at, $1) <= $1
             ORDER BY attachment_next_attempt_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now.toISOString(), leaseUntil.toISOString(), limit],
      );
      return rows.map(outboxFrom);
    },
    async purgeDeliveredOutboxBodies(now) {
      const rows = await exec(
        `UPDATE plugin_message_outbox
            SET message = '', updated_at = $1
          WHERE status = 'delivered' AND message <> ''
          RETURNING id`,
        [now.toISOString()],
      );
      return rows.length;
    },
    async listExpiredOutboxIds(olderThan) {
      const rows = await exec(
        `SELECT id FROM plugin_message_outbox
          WHERE status IN ('pending', 'sending', 'dead')
            AND created_at < $1`,
        [olderThan.toISOString()],
      );
      return rows.map((r) => String(r.id));
    },
    async deleteOutboxIds(ids) {
      if (ids.length === 0) return 0;
      const rows = await exec(
        `DELETE FROM plugin_message_outbox
          WHERE id = ANY($1::text[])
            AND status IN ('pending', 'sending', 'dead')
          RETURNING id`,
        [ids],
      );
      return rows.length;
    },
    async purgeExpiredOutbox(_now, olderThan) {
      const ids = await this.listExpiredOutboxIds(olderThan);
      await this.deleteOutboxIds(ids);
      return ids;
    },
    async attachOutboxTickets(callSid, extras, now) {
      if (!callSid) return [];
      const rows = await exec(
        `UPDATE plugin_message_outbox
            SET ticket_id = $2,
                ticket_number = $3,
                approval_id = $4,
                suggestions = '[]'::jsonb,
                updated_at = $5
          WHERE call_sid = $1
            AND coalesce(ticket_id, '') = ''
            AND coalesce(ticket_number, '') = ''
            AND coalesce(approval_id, '') = ''
          RETURNING *`,
        [
          callSid,
          extras.ticketId ?? null,
          extras.ticketNumber ?? null,
          extras.approvalId ?? null,
          now.toISOString(),
        ],
      );
      return rows.map(outboxFrom);
    },
    async isSmsOptedOut(phoneKey) {
      // SMS only. A voice opt-out is a different row and does not block texts.
      const rows = await exec(
        "SELECT phone_key FROM do_not_contact WHERE phone_key = $1 AND source = $2 LIMIT 1",
        [phoneKey, "sms_stop"],
      );
      return rows.length > 0;
    },
    async setSmsOptOut(phoneKey, optedOut) {
      if (optedOut) {
        await exec(
          `INSERT INTO do_not_contact (phone_key, source) VALUES ($1, $2)
           ON CONFLICT (phone_key, source) DO NOTHING`,
          [phoneKey, "sms_stop"],
        );
      } else {
        // START clears SMS only. A voice "don't call me" stays.
        await exec("DELETE FROM do_not_contact WHERE phone_key = $1 AND source = $2", [phoneKey, "sms_stop"]);
      }
    },
    async writeAudit(entry) {
      const clean = sanitizeAuditEntry(entry);
      await exec(
        `INSERT INTO plugin_audit_log (token_jti, tool, route, method, approval_id, ticket_id, outcome, http_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          clean.tokenJti,
          clean.tool,
          clean.route,
          clean.method,
          clean.approvalId ?? null,
          clean.ticketId ?? null,
          clean.outcome,
          clean.httpStatus,
        ],
      );
    },
    async listAudit() {
      const rows = await exec("SELECT * FROM plugin_audit_log ORDER BY created_at DESC LIMIT 200");
      return rows.map((r) => ({
        tokenJti: String(r.token_jti),
        tool: String(r.tool),
        route: String(r.route),
        method: String(r.method),
        approvalId: (r.approval_id as string | null) ?? null,
        ticketId: (r.ticket_id as string | null) ?? null,
        outcome: r.outcome as PluginAuditEntry["outcome"],
        httpStatus: Number(r.http_status),
        createdAt: r.created_at ? new Date(String(r.created_at)) : undefined,
      }));
    },
  };
}
