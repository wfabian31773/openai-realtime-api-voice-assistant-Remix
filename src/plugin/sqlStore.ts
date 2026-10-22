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
            id, channel, status, token_jti, ticket_id, ticket_number, payload, payload_hash, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *`,
        [
          row.id,
          row.channel,
          row.status,
          row.tokenJti,
          row.ticketId,
          row.ticketNumber,
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
    async isSmsOptedOut(phoneKey) {
      // Any DNC row blocks SMS — a call opt-out is also a text opt-out.
      const rows = await exec(
        "SELECT phone_key FROM do_not_contact WHERE phone_key = $1 LIMIT 1",
        [phoneKey],
      );
      return rows.length > 0;
    },
    async setSmsOptOut(phoneKey, optedOut) {
      if (optedOut) {
        // Do not overwrite a call opt-out with sms_stop; START must not
        // clear a number that asked not to be called.
        await exec(
          `INSERT INTO do_not_contact (phone_key, source) VALUES ($1, $2)
           ON CONFLICT (phone_key) DO NOTHING`,
          [phoneKey, "sms_stop"],
        );
      } else {
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
