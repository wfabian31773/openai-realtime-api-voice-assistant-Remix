/**
 * The approval gate. Nothing leaves this fleet until a human approves a
 * pending contact_approvals row and commit_contact consumes a 5-minute
 * single-use token minted at approve.
 */

import { dncKey } from "../runtime/outbound/store";
import { prepareDobFromPayload } from "./callEnqueue";
import { parseOperatorPayload, operatorApprovalRequired, US_E164, type OperatorCallPayload } from "./operatorLine";
import { hashPayload, hashSecret, isConfirmExpired } from "./tokens";
import {
  issueConfirmOnApprove,
  newId,
  phoneKeyOfPayload,
  publicApproval,
  STALE_SENDING_MS,
  type CallPayload,
  type ContactApprovalRow,
  type ContactChannel,
  type EmailPayload,
  type PluginStore,
  type SmsPayload,
} from "./store";

export const PREPARE_PAYLOAD_MAX_BYTES = 8192;

const PREPARE_KEYS: Record<ContactChannel, readonly string[]> = {
  call: [
    "phone",
    "firstName",
    "lastName",
    "dateOfBirth",
    "date_of_birth",
    "birthMonth",
    "birthDay",
    "birthYear",
    "ticketId",
    "ticketNumber",
    "purpose",
  ],
  sms: ["phone", "body", "ticketId", "ticketNumber"],
  email: ["to", "subject", "body", "ticketId", "ticketNumber"],
};

export function pickPreparePayload(
  channel: ContactChannel,
  raw: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    return { ok: false, error: "Payload is not valid JSON" };
  }
  if (encoded.length > PREPARE_PAYLOAD_MAX_BYTES) {
    return { ok: false, error: "Payload is too large" };
  }
  const payload: Record<string, unknown> = {};
  for (const key of PREPARE_KEYS[channel]) {
    if (raw[key] !== undefined) payload[key] = raw[key];
  }
  return { ok: true, payload };
}

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
    const dob = prepareDobFromPayload(input.payload as unknown as Record<string, unknown>);
    if (!dob.ok) return { ok: false, error: dob.error };
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
  callKind?: "operator",
  env: Record<string, string | undefined> = process.env,
): Promise<GateResult> {
  const picked = callKind === "operator"
    ? parseOperatorPayload(input.payload, env)
    : pickPreparePayload(input.channel, input.payload as unknown as Record<string, unknown>);
  if (!picked.ok) return { ok: false, status: 400, error: picked.error };
  const payload = { ...picked.payload } as Record<string, unknown>;
  const narrowed = { channel: input.channel, payload: picked.payload } as unknown as PrepareInput;
  const valid = callKind === "operator" ? { ok: true as const } : validatePrepare(narrowed);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const ticketId =
    (typeof payload.ticketId === "string" && payload.ticketId) || null;
  const ticketNumber =
    (typeof payload.ticketNumber === "string" && payload.ticketNumber) || null;

  const row: ContactApprovalRow = {
    id: newId(),
    channel: input.channel,
    status: "pending",
    tokenJti,
    ticketId,
    ticketNumber,
    phoneKey: input.channel === "email" || (callKind === "operator" && !US_E164.test(String(payload.phone)))
      ? null : phoneKeyOfPayload(payload),
    payload,
    payloadHash: hashPayload(payload),
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
  // Operator bots declare provenance. Owner requests and calls to the owner
  // need no approval tap; all unspecified provenance defaults to bot initiative.
  const automatic = callKind === "operator" && !operatorApprovalRequired(picked.payload as OperatorCallPayload, env);
  const confirm = automatic ? issueConfirmOnApprove(now) : null;
  if (confirm) Object.assign(row, {
    status: "approved", confirmTokenHash: confirm.hash, confirmTokenPlaintext: confirm.plaintext,
    confirmExpiresAt: confirm.expiresAt,
  });
  const approval = await store.insertApproval(row);
  return { ok: true, approval, ...(confirm ? { confirmToken: confirm.plaintext } : {}) };
}

export async function approveContact(
  store: PluginStore,
  id: string,
  approvedBy: string,
  now = new Date(),
  expectedPayloadHash?: string,
): Promise<GateResult> {
  const current = await store.getApproval(id);
  if (!current) return { ok: false, status: 404, error: "Contact request not found" };
  if (current.status !== "pending") {
    return { ok: false, status: 409, error: `Contact request is ${current.status}, not pending` };
  }
  if (approvedBy === current.tokenJti) {
    return { ok: false, status: 403, error: "A token cannot approve its own request" };
  }
  if (typeof expectedPayloadHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedPayloadHash)) {
    return { ok: false, status: 400, error: "payloadHash is required" };
  }
  if (expectedPayloadHash !== current.payloadHash) {
    return { ok: false, status: 409, error: "payloadHash does not match the request on file" };
  }
  if (hashPayload(current.payload) !== current.payloadHash) {
    return { ok: false, status: 409, error: "Stored payload does not match the locked hash" };
  }
  const confirm = issueConfirmOnApprove(now);
  const approval = await store.updateApproval(
    id,
    {
      status: "approved",
      approvedBy,
      approvedAt: now,
      confirmTokenHash: confirm.hash,
      confirmTokenPlaintext: confirm.plaintext,
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
  if (current.status !== "pending" && current.status !== "approved") {
    return { ok: false, status: 409, error: `Contact request is ${current.status}` };
  }
  if (current.confirmUsedAt) {
    return { ok: false, status: 409, error: "Contact request is already being sent" };
  }
  const approval = await store.cancelIfOpen(id, now);
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
  await store.purgeExpiredConfirmTokens(now);
  const hash = hashSecret(confirmToken);
  const claimed = await store.claimConfirmToken(hash, now);
  if (claimed) return { ok: true, approval: claimed };

  const row = await store.findApprovalByConfirmHash(hash);
  if (!row) return { ok: false, status: 404, error: "Confirmation token not found" };
  if (row.status === "sending" && row.confirmUsedAt) {
    return { ok: false, status: 409, error: "Confirmation token has already been used" };
  }
  if (row.status !== "approved") {
    return { ok: false, status: 409, error: "Contact request is not approved" };
  }
  if (row.confirmUsedAt) {
    return { ok: false, status: 409, error: "Confirmation token has already been used" };
  }
  if (!row.confirmExpiresAt || isConfirmExpired(row.confirmExpiresAt, now)) {
    return { ok: false, status: 410, error: "Confirmation token has expired" };
  }
  return { ok: false, status: 409, error: "Confirmation token has already been used" };
}

export async function markCommitted(
  store: PluginStore,
  id: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<ContactApprovalRow | null> {
  return store.updateApproval(
    id,
    {
      status: "committed",
      committedAt: now,
      result,
      updatedAt: now,
    },
    "sending",
  );
}

export async function markFailed(
  store: PluginStore,
  id: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<ContactApprovalRow | null> {
  return store.updateApproval(
    id,
    {
      status: "failed",
      result,
      updatedAt: now,
    },
    "sending",
  );
}

/**
 * The send may already have gone out (timeout, abort after accept,
 * markCommitted throw). Do not resend. A new prepare is the only way out.
 */
export async function markUnknown(
  store: PluginStore,
  id: string,
  result: Record<string, unknown>,
  now = new Date(),
): Promise<ContactApprovalRow | null> {
  return store.updateApproval(
    id,
    {
      status: "unknown",
      result,
      updatedAt: now,
    },
    "sending",
  );
}

/**
 * A claim that never reached markCommitted/markFailed/markUnknown stays
 * `sending` forever unless we sweep it. Labels those stale rows `unknown`
 * — the send may have succeeded after the process died — and never resends.
 * A new prepare is the only way out.
 */
export async function reapStaleSending(
  store: PluginStore,
  now = new Date(),
  staleMs = STALE_SENDING_MS,
): Promise<ContactApprovalRow[]> {
  await store.purgeExpiredConfirmTokens(now);
  const staleBefore = new Date(now.getTime() - staleMs);
  const rows = await store.reapStaleSending(now, staleBefore);
  for (const row of rows) {
    try {
      await store.writeAudit({
        tokenJti: "system",
        tool: "reap_stale_sending",
        route: "/api/plugin/v1/commit_contact",
        method: "SWEEP",
        approvalId: row.id,
        ticketId: row.ticketId,
        outcome: "unknown",
        httpStatus: 408,
      });
    } catch {
      console.error("[plugin] stale-send audit failed");
    }
  }
  return rows;
}

export function channelOf(value: string): ContactChannel | null {
  if (value === "call" || value === "sms" || value === "email") return value;
  return null;
}

export { publicApproval };
