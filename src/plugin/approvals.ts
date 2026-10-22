/**
 * The approval gate. Nothing leaves this fleet until a human approves a
 * pending contact_approvals row and commit_contact consumes a 5-minute
 * single-use token minted at approve.
 */

import { dncKey } from "../runtime/outbound/store";
import { hashPayload, hashSecret, isConfirmExpired } from "./tokens";
import {
  issueConfirmOnApprove,
  newId,
  publicApproval,
  type ApprovalStatus,
  type CallPayload,
  type ContactApprovalRow,
  type ContactChannel,
  type EmailPayload,
  type PluginStore,
  type SmsPayload,
} from "./store";

export type PrepareInput =
  | { channel: "call"; payload: CallPayload }
  | { channel: "sms"; payload: SmsPayload }
  | { channel: "email"; payload: EmailPayload };

export type GateResult =
  | { ok: true; approval: ContactApprovalRow; confirmToken?: string }
  | { ok: false; status: number; error: string };

function requirePhone(phone: unknown): string | null {
  if (typeof phone !== "string" || !phone.trim()) return null;
  return dncKey(phone.trim());
}

function requireEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

export function validatePrepare(input: PrepareInput): { ok: true } | { ok: false; error: string } {
  if (input.channel === "call") {
    if (!requirePhone(input.payload.phone)) return { ok: false, error: "A valid US phone number is required" };
    return { ok: true };
  }
  if (input.channel === "sms") {
    if (!requirePhone(input.payload.phone)) return { ok: false, error: "A valid US phone number is required" };
    if (typeof input.payload.body !== "string" || !input.payload.body.trim()) {
      return { ok: false, error: "SMS body is required" };
    }
    return { ok: true };
  }
  if (!requireEmail(input.payload.to)) return { ok: false, error: "A valid email address is required" };
  if (typeof input.payload.subject !== "string" || !input.payload.subject.trim()) {
    return { ok: false, error: "Email subject is required" };
  }
  if (typeof input.payload.body !== "string" || !input.payload.body.trim()) {
    return { ok: false, error: "Email body is required" };
  }
  return { ok: true };
}

export async function prepareContact(
  store: PluginStore,
  tokenJti: string,
  input: PrepareInput,
  now = new Date(),
): Promise<GateResult> {
  const valid = validatePrepare(input);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const ticketId =
    (typeof input.payload.ticketId === "string" && input.payload.ticketId) || null;
  const ticketNumber =
    (typeof input.payload.ticketNumber === "string" && input.payload.ticketNumber) || null;

  const row: ContactApprovalRow = {
    id: newId(),
    channel: input.channel,
    status: "pending",
    tokenJti,
    ticketId,
    ticketNumber,
    payload: { ...input.payload } as Record<string, unknown>,
    payloadHash: hashPayload(input.payload),
    confirmTokenHash: null,
    confirmExpiresAt: null,
    confirmUsedAt: null,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    cancelledAt: null,
    committedAt: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  const approval = await store.insertApproval(row);
  return { ok: true, approval };
}

export async function approveContact(
  store: PluginStore,
  id: string,
  approvedBy: string,
  now = new Date(),
): Promise<GateResult> {
  const current = await store.getApproval(id);
  if (!current) return { ok: false, status: 404, error: "Contact request not found" };
  if (current.status !== "pending") {
    return { ok: false, status: 409, error: `Contact request is ${current.status}, not pending` };
  }
  const confirm = issueConfirmOnApprove(now);
  const approval = await store.updateApproval(
    id,
    {
      status: "approved",
      approvedBy,
      approvedAt: now,
      confirmTokenHash: confirm.hash,
      confirmExpiresAt: confirm.expiresAt,
      confirmUsedAt: null,
      updatedAt: now,
    },
    "pending",
  );
  if (!approval) return { ok: false, status: 409, error: "Contact request is no longer pending" };
  return { ok: true, approval, confirmToken: confirm.plaintext };
}

export async function rejectContact(
  store: PluginStore,
  id: string,
  rejectedBy: string,
  now = new Date(),
): Promise<GateResult> {
  const current = await store.getApproval(id);
  if (!current) return { ok: false, status: 404, error: "Contact request not found" };
  if (current.status !== "pending") {
    return { ok: false, status: 409, error: `Contact request is ${current.status}, not pending` };
  }
  const approval = await store.updateApproval(
    id,
    { status: "rejected", rejectedBy, rejectedAt: now, updatedAt: now },
    "pending",
  );
  if (!approval) return { ok: false, status: 409, error: "Contact request is no longer pending" };
  return { ok: true, approval };
}

export async function cancelContact(
  store: PluginStore,
  id: string,
  now = new Date(),
): Promise<GateResult> {
  const current = await store.getApproval(id);
  if (!current) return { ok: false, status: 404, error: "Contact request not found" };
  if (current.status === "committed") {
    return { ok: false, status: 409, error: "Contact request has already been sent" };
  }
  if (current.status === "cancelled") return { ok: true, approval: current };
  const cancellable: ApprovalStatus[] = ["pending", "approved"];
  if (!cancellable.includes(current.status)) {
    return { ok: false, status: 409, error: `Contact request is ${current.status}` };
  }
  const approval = await store.updateApproval(id, {
    status: "cancelled",
    cancelledAt: now,
    confirmTokenHash: null,
    confirmExpiresAt: null,
    updatedAt: now,
  });
  if (!approval) return { ok: false, status: 409, error: "Contact request could not be cancelled" };
  return { ok: true, approval };
}

export type ConsumeResult =
  | { ok: true; approval: ContactApprovalRow }
  | { ok: false; status: number; error: string };

/**
 * Consume a 5-minute single-use confirm token. Only an approved, unused,
 * unexpired token bound to this request may proceed to send.
 */
export async function consumeConfirmToken(
  store: PluginStore,
  confirmToken: string,
  now = new Date(),
): Promise<ConsumeResult> {
  if (typeof confirmToken !== "string" || !/^[a-f0-9]{64}$/.test(confirmToken)) {
    return { ok: false, status: 400, error: "confirmToken is required" };
  }
  const hash = hashSecret(confirmToken);
  const row = await store.findApprovalByConfirmHash(hash);
  if (!row) return { ok: false, status: 404, error: "Confirmation token not found" };
  if (row.status !== "approved") {
    return { ok: false, status: 409, error: "Contact request is not approved" };
  }
  if (row.confirmUsedAt) {
    return { ok: false, status: 409, error: "Confirmation token has already been used" };
  }
  if (!row.confirmExpiresAt || isConfirmExpired(row.confirmExpiresAt, now)) {
    return { ok: false, status: 410, error: "Confirmation token has expired" };
  }
  const consumed = await store.updateApproval(
    row.id,
    { confirmUsedAt: now, updatedAt: now },
    "approved",
  );
  if (!consumed || !consumed.confirmUsedAt) {
    return { ok: false, status: 409, error: "Confirmation token has already been used" };
  }
  return { ok: true, approval: consumed };
}

export async function markCommitted(
  store: PluginStore,
  id: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<ContactApprovalRow | null> {
  return store.updateApproval(id, {
    status: "committed",
    committedAt: now,
    result,
    updatedAt: now,
  });
}

export async function markFailed(
  store: PluginStore,
  id: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<ContactApprovalRow | null> {
  return store.updateApproval(id, {
    status: "failed",
    result,
    updatedAt: now,
  });
}

export function channelOf(value: string): ContactChannel | null {
  if (value === "call" || value === "sms" || value === "email") return value;
  return null;
}

export { publicApproval };
