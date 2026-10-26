/**
 * src/services/twilioStatusCallback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANGUP WEBHOOK, as a decision, so a 500 has a name.
 *
 * Twilio POSTs here when a call changes status. On the live Remix app that
 * is `/api/voice/status` (and `/api/voice/status-callback`), served by the
 * OLD CORE process on port 8000 — not the Grok runtime. The runtime writes
 * `call_logs` at stream teardown with its own clock; this webhook is what
 * was supposed to overwrite `duration` with Twilio's CallDuration.
 *
 * On 2026-09-15 every completed PCP inbound returned HTTP 500 (Twilio
 * 15003). The handler caught the exception and answered 500, so the
 * exception never had a name and the Twilio duration never landed.
 * `local_duration_seconds` stayed at the stream length (37–52s on a blind
 * transfer) while the parent Twilio leg ran to 347s.
 *
 * WHAT THIS FILE EXISTS TO DO
 *
 *   1. Never answer Twilio with 5xx. The house rule on every other runtime
 *      webhook: Twilio treats ANY 5xx as failure and plays its own handling
 *      (15003). A processing error is a 200 with success:false, and the
 *      exception is logged under a stable prefix so the next hangup names it.
 *   2. Refuse to hand drizzle an Invalid Date or a NaN. Either one makes
 *      Postgres reject the UPDATE — the cheapest proven path to the 500.
 *   3. If the cost-preserving write throws, still write duration + twilio
 *      status. Hangup bookkeeping must not die because a cost field did.
 *
 * Session teardown is NOT the 500. `handleTwilioStatusCallback` is fire-and-
 * forget when the runtime never registered the call. The await chain that
 * can throw is parse → lookup → price → update. Child-leg callbacks (no
 * call_logs row) already returned 200; they are not this defect.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { priceVoiceCall } from "./voiceCostRates";

export type StatusCallbackHttp = {
  status: 200 | 400;
  body: { success: boolean; error?: string; message?: string };
};

/** The columns this webhook reads off the existing row. Narrow on purpose. */
export interface StatusCallbackCallLog {
  id: string;
  duration: number | null;
  twilioCostCents: number | null;
  openaiCostCents: number | null;
  inputAudioTokens: number | null;
  voiceProvider?: string | null;
  costReconciledAt?: Date | string | null;
  transferredToHuman?: boolean | null;
  campaignId?: string | null;
  contactId?: string | null;
  direction?: string | null;
}

export interface StatusCallbackUpdate {
  status: "initiated" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer" | "busy" | "transferred";
  twilioStatus: string;
  answeredBy: string | null;
  machineDetectionDuration: number | null;
  callDisposition: string;
  isVoicemail: boolean;
  twilioErrorCode: string | null;
  endTime: Date;
  twilioCostCents: number;
  openaiCostCents: number;
  totalCostCents: number;
  transferredToHuman: boolean;
  duration?: number;
  costIsEstimated?: boolean;
}

export interface StatusCallbackStorage {
  getCallLogBySid(callSid: string): Promise<StatusCallbackCallLog | undefined>;
  updateCallLogPreservingReconciledCost(
    id: string,
    updates: StatusCallbackUpdate,
  ): Promise<unknown>;
  /** Minimal hangup write — duration and Twilio status only. No cost columns. */
  updateCallLogHangup(
    id: string,
    updates: Pick<
      StatusCallbackUpdate,
      "status" | "twilioStatus" | "endTime" | "duration" | "callDisposition"
    >,
  ): Promise<unknown>;
  updateCampaignContact?(
    contactId: string,
    updates: { contacted: boolean; successful: boolean; lastAttemptAt: Date },
  ): Promise<unknown>;
}

export interface ApplyStatusCallbackDeps {
  storage: StatusCallbackStorage;
  fetchTwilioCostCents?: (callSid: string) => Promise<number | null>;
  notifyCampaignComplete?: (callSid: string) => void;
  log?: (line: string) => void;
}

const TERMINAL_STATES = ["completed", "busy", "no-answer", "failed", "canceled"];

/**
 * Twilio's body on this path is a raw Buffer (src/server.ts bodyParser.raw)
 * or, if a different process parsed it, an object. `null` is typeof 'object'
 * in JavaScript — the inline handler treated it as parsed and then
 * destructured, which throws and is HTTP 500.
 */
export function parseStatusCallbackBody(
  reqBody: unknown,
): Record<string, string> | { error: "invalid_format" } {
  if (Buffer.isBuffer(reqBody)) {
    return Object.fromEntries(new URLSearchParams(reqBody.toString("utf8")));
  }
  if (typeof reqBody === "string") {
    return Object.fromEntries(new URLSearchParams(reqBody));
  }
  if (reqBody && typeof reqBody === "object" && !Array.isArray(reqBody)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(reqBody as Record<string, unknown>)) {
      if (value == null) continue;
      out[key] = String(value);
    }
    return out;
  }
  return { error: "invalid_format" };
}

/** A Date drizzle can write. Invalid Date becomes "NaN" in the SQL and Postgres 500s. */
export function sanitizeTimestamp(raw: string | undefined): Date {
  if (!raw) return new Date();
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 1e9) {
    const ms = asNum < 1e12 ? asNum * 1000 : asNum;
    const fromUnix = new Date(ms);
    if (!Number.isNaN(fromUnix.getTime())) return fromUnix;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
}

/** Finite integer, or null. parseInt("abc") is NaN, and NaN in an integer column 500s. */
export function sanitizeInt(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function twilioDurationFrom(callDuration: string | undefined): number | null {
  if (!callDuration || callDuration === "0") return null;
  const n = sanitizeInt(callDuration);
  return n != null && n > 0 ? n : null;
}

export function internalStatusFor(
  callStatus: string,
): StatusCallbackUpdate["status"] {
  if (callStatus === "busy") return "busy";
  if (callStatus === "no-answer") return "no_answer";
  if (callStatus === "failed" || callStatus === "canceled") return "failed";
  if (callStatus === "completed") return "completed";
  if (callStatus === "ringing") return "ringing";
  if (callStatus === "in-progress" || callStatus === "in_progress") return "in_progress";
  if (callStatus === "queued" || callStatus === "initiated") return "initiated";
  return "completed";
}

export function dispositionFor(parsed: Record<string, string>): {
  callDisposition: string;
  isVoicemail: boolean;
} {
  const answeredBy = parsed.AnsweredBy;
  if (
    answeredBy === "machine_start" ||
    answeredBy === "machine_end_beep" ||
    answeredBy === "machine_end_silence"
  ) {
    return { callDisposition: "voicemail", isVoicemail: true };
  }
  if (answeredBy === "fax") {
    return { callDisposition: "fax_machine", isVoicemail: false };
  }
  const status = parsed.CallStatus;
  if (status === "busy") return { callDisposition: "busy", isVoicemail: false };
  if (status === "no-answer") return { callDisposition: "no_answer", isVoicemail: false };
  if (status === "failed" || status === "canceled") {
    if (parsed.ErrorCode === "21217") return { callDisposition: "line_disconnected", isVoicemail: false };
    if (parsed.ErrorCode === "21214") return { callDisposition: "wrong_number", isVoicemail: false };
    if (parsed.ErrorCode === "21211") return { callDisposition: "out_of_service", isVoicemail: false };
    return { callDisposition: "failed", isVoicemail: false };
  }
  return { callDisposition: status || "completed", isVoicemail: false };
}

export function buildStatusCallbackUpdate(input: {
  parsed: Record<string, string>;
  callLog: StatusCallbackCallLog;
  actualTwilioCostCents?: number | null;
}): { update: StatusCallbackUpdate; twilioDuration: number | null } {
  const { parsed, callLog } = input;
  const twilioDuration = twilioDurationFrom(parsed.CallDuration);
  const duration = twilioDuration ?? callLog.duration ?? 0;
  const { callDisposition, isVoicemail } = dispositionFor(parsed);
  const internalStatus = internalStatusFor(parsed.CallStatus ?? "");
  const twilioCostCents =
    input.actualTwilioCostCents ?? callLog.twilioCostCents ?? 0;

  const pricing = priceVoiceCall({
    voiceProvider: callLog.voiceProvider,
    inputAudioTokens: callLog.inputAudioTokens,
    existingOpenaiCostCents: callLog.openaiCostCents,
    costReconciledAt: callLog.costReconciledAt,
    durationSeconds: duration,
    twilioCostCents,
  });
  const hasTokenDerivedCost =
    pricing.basis === "openai_tokens" || pricing.basis === "reconciled";
  const openaiCostCents = pricing.providerCostCents ?? callLog.openaiCostCents ?? 0;

  const update: StatusCallbackUpdate = {
    status: internalStatus,
    twilioStatus: parsed.CallStatus ?? "",
    answeredBy: parsed.AnsweredBy || null,
    machineDetectionDuration: sanitizeInt(parsed.MachineDetectionDuration),
    callDisposition,
    isVoicemail,
    twilioErrorCode: parsed.ErrorCode || null,
    endTime: sanitizeTimestamp(parsed.Timestamp),
    twilioCostCents,
    openaiCostCents,
    totalCostCents: pricing.totalCostCents,
    transferredToHuman: callLog.transferredToHuman || false,
  };

  if (twilioDuration != null) {
    update.duration = twilioDuration;
    update.costIsEstimated = !hasTokenDerivedCost;
  }

  return { update, twilioDuration };
}

export async function applyTwilioStatusCallback(
  reqBody: unknown,
  deps: ApplyStatusCallbackDeps,
): Promise<StatusCallbackHttp> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const parsed = parseStatusCallbackBody(reqBody);
  if ("error" in parsed) {
    return { status: 400, body: { success: false, error: "Invalid request format" } };
  }

  const callSid = parsed.CallSid;
  const callStatus = parsed.CallStatus;
  if (!callSid || !callStatus) {
    return { status: 400, body: { success: false, error: "Missing required fields" } };
  }

  log(`[STATUS CALLBACK] CallSid: ${callSid}, Status: ${callStatus}, AnsweredBy: ${parsed.AnsweredBy || "N/A"}`);

  try {
    const callLog = await deps.storage.getCallLogBySid(callSid);
    if (!callLog) {
      log(`[STATUS CALLBACK] No call log found for CallSid: ${callSid}`);
      return { status: 200, body: { success: false, message: "Call log not found" } };
    }

    let actualTwilioCostCents: number | null = null;
    if (TERMINAL_STATES.includes(callStatus) && deps.fetchTwilioCostCents) {
      try {
        actualTwilioCostCents = await deps.fetchTwilioCostCents(callSid);
      } catch (err) {
        log(`[STATUS CALLBACK] Could not fetch Twilio cost: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { update, twilioDuration } = buildStatusCallbackUpdate({
      parsed,
      callLog,
      actualTwilioCostCents,
    });

    if (twilioDuration != null) {
      log(`[STATUS CALLBACK] ✓ TWILIO AUTHORITATIVE: Duration=${twilioDuration}s`);
    } else {
      log(`[STATUS CALLBACK] ⚠️ Twilio did not provide CallDuration, keeping costIsEstimated=true for reconciliation`);
    }

    try {
      await deps.storage.updateCallLogPreservingReconciledCost(callLog.id, update);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[STATUS CALLBACK] exception ${err instanceof Error ? err.name : "Error"}: ${message}`);
      try {
        await deps.storage.updateCallLogHangup(callLog.id, {
          status: update.status,
          twilioStatus: update.twilioStatus,
          endTime: update.endTime,
          callDisposition: update.callDisposition,
          ...(update.duration != null ? { duration: update.duration } : {}),
        });
        log(`[STATUS CALLBACK] hangup fallback wrote duration=${update.duration ?? "unchanged"} for ${callSid}`);
      } catch (fallbackErr) {
        log(
          `[STATUS CALLBACK] hangup fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
      return { status: 200, body: { success: false, error: "status_callback_write_failed" } };
    }

    if (callLog.campaignId && callLog.contactId && deps.storage.updateCampaignContact) {
      const successful = update.status === "completed" && !update.isVoicemail;
      await deps.storage.updateCampaignContact(callLog.contactId, {
        contacted: true,
        successful,
        lastAttemptAt: update.endTime,
      });
    }

    if (
      callLog.campaignId &&
      callLog.direction === "outbound" &&
      TERMINAL_STATES.includes(callStatus)
    ) {
      try {
        deps.notifyCampaignComplete?.(callSid);
      } catch (err) {
        log(`[STATUS CALLBACK] Error notifying campaign executor: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log(`[STATUS CALLBACK] ✓ Call log updated: ${callLog.id}, Disposition: ${update.callDisposition}`);
    return { status: 200, body: { success: true } };
  } catch (err) {
    // Lookup, pricing, or anything else this function did not already name.
    // Still 200: a 500 here is Twilio 15003 and the exception stays invisible.
    const message = err instanceof Error ? err.message : String(err);
    log(`[STATUS CALLBACK] exception ${err instanceof Error ? err.name : "Error"}: ${message}`);
    return { status: 200, body: { success: false, error: "status_callback_failed" } };
  }
}
