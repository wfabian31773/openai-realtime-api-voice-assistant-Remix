/**
 * THE RUNTIME'S HALF OF THE URGENT-TRANSFER HEADS-UP AND ITS SAFETY NET.
 *
 * The words and the payload live in `src/services/urgentTransferAlert.ts`,
 * shared with the old core. This module only SENDS them, with the runtime's
 * own environment and its own lazily-built Twilio client, so a process with
 * no transfer configured still boots and the health check still answers.
 *
 * Both methods are fire-and-forget and never throw: a text that fails must
 * never delay the dial, and a ticket that fails must never reach the caller.
 * Each says what happened in one console line, which is the only trace a
 * missing text leaves anywhere.
 */
import type { EscalationDetails } from "../services/escalationStore";
import {
  buildUrgentTransferSms,
  urgentAlertTime,
  urgentFallbackTicketParams,
  urgentRingOutBesideParams,
  type UrgentRingOutBesideParams,
} from "../services/urgentTransferAlert";
import { isTestCall } from "../services/testCalls";

export interface UrgentTransferAlerts {
  /** The heads-up text, sent BEFORE the on-call phone rings. */
  smsBeforeDial(input: { callSid?: string; callerNumber?: string; escalationDetails?: EscalationDetails }): void;
  /** The urgent ticket, filed when a transfer rang and nobody took it. */
  fallbackTicket(input: {
    callSid: string;
    callerNumber?: string;
    escalationDetails?: EscalationDetails;
    why: string;
    dialTarget?: string;
    agentUsed: string;
  }): void;
}

interface MessagesClient {
  messages: { create(input: { body: string; from: string; to: string }): Promise<unknown> };
}

/**
 * Whether the on-call text can be sent at all: a number to text and a number
 * to send from. ONE rule, read by the sender below and by `/voice/health`, so
 * the page can never say ready while the sender skips. Names only, never the
 * numbers. Before this, a missing URGENT_NOTIFICATION_NUMBER showed nowhere
 * but one console line per escalation: the text just stopped (the 2026-10-02
 * shape, where the operator waited for a text that never came).
 */
export function urgentAlertStatus(env: Record<string, string | undefined>): { ready: boolean; missing: string[] } {
  const missing = ["URGENT_NOTIFICATION_NUMBER", "TWILIO_PHONE_NUMBER"].filter((k) => !env[k]?.trim());
  return { ready: missing.length === 0, missing };
}

export function defaultUrgentTransferAlerts(
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  deps: {
    /** Injected for tests; defaults to a client built from env credentials. */
    smsClient?: () => Promise<MessagesClient>;
    /** Injected for tests; defaults to SyncAgentService.createTicket. */
    createTicket?: (
      params: ReturnType<typeof urgentFallbackTicketParams>,
    ) => Promise<{ success: boolean; ticketNumber?: string; error?: string }>;
    /**
     * Injected for tests; defaults to the ticket number already written back
     * onto this call's `call_logs` row — the same value `createTicket`'s claim
     * would hand back instead of posting.
     */
    ticketAlreadyOnCall?: (callSid: string) => Promise<string | undefined>;
    /** Injected for tests; defaults to SyncAgentService.submitSimplifiedTicket. */
    submitBeside?: (
      params: UrgentRingOutBesideParams,
    ) => Promise<{ success: boolean; ticketNumber?: string; error?: string }>;
    now?: () => Date;
  } = {},
): UrgentTransferAlerts {
  let client: Promise<MessagesClient> | null = null;
  const smsClient =
    deps.smsClient ??
    (() => {
      if (!client) {
        client = import("twilio").then(
          ({ default: twilio }) =>
            twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) as unknown as MessagesClient,
        );
      }
      return client;
    });
  const createTicket =
    deps.createTicket ??
    (async (params: ReturnType<typeof urgentFallbackTicketParams>) => {
      // Dynamic for the same reason `callRecord` is: the ticketing service
      // reaches the database, and that must stay off the runtime's boot path.
      const { SyncAgentService } = await import("../services/syncAgentService");
      return SyncAgentService.createTicket(params);
    });
  const ticketAlreadyOnCall =
    deps.ticketAlreadyOnCall ??
    (async (callSid: string) => {
      // Dynamic for the same reason: storage validates the database URL on load.
      const { storage } = await import("../../server/storage");
      return (await storage.getCallLogBySid(callSid))?.ticketNumber ?? undefined;
    });
  const submitBeside =
    deps.submitBeside ??
    (async (params: UrgentRingOutBesideParams) => {
      const { SyncAgentService } = await import("../services/syncAgentService");
      return SyncAgentService.submitSimplifiedTicket(params);
    });
  const now = deps.now ?? (() => new Date());

  return {
    smsBeforeDial(input) {
      if (isTestCall({ callSid: input.callSid, callerPhone: input.callerNumber }, env)) {
        log("[runtime-xfer] urgent SMS skipped - test call");
        return;
      }
      if (!urgentAlertStatus(env).ready) {
        log(
          "[runtime-xfer] urgent SMS skipped - URGENT_NOTIFICATION_NUMBER or TWILIO_PHONE_NUMBER not configured",
        );
        return;
      }
      void (async () => {
        try {
          const body = buildUrgentTransferSms(
            { callerNumber: input.callerNumber, escalationDetails: input.escalationDetails },
            urgentAlertTime(now()),
          );
          await (await smsClient()).messages.create({
            body,
            from: env.TWILIO_PHONE_NUMBER!.trim(),
            to: env.URGENT_NOTIFICATION_NUMBER!.trim(),
          });
          log("[runtime-xfer] ✓ urgent SMS sent before the dial");
        } catch (err) {
          log(`[runtime-xfer] ⚠️ urgent SMS failed: ${String(err)}`);
        }
      })();
    },

    fallbackTicket(input) {
      log(`[runtime-xfer] filing the urgent fallback ticket for ${input.callSid}`);
      void (async () => {
        try {
          /**
           * DOES THE CALL ALREADY HOLD A TICKET? If it does, `createTicket`'s
           * per-call claim returns that ticket and posts nothing — so a caller
           * whose request was filed before the urgent transfer rang out was
           * left with a medium ticket and no urgent record (VA-70426 on
           * 2026-10-10, VA-70441 on 2026-10-11). The record is filed BESIDE it
           * instead. With no ticket yet, it files as the call's own ticket
           * exactly as before, so a later `create_ticket` still returns it.
           *
           * A read that fails falls back to the old path: the worst case is
           * the behaviour this replaces, never a ticket lost to the lookup.
           */
          let earlier: string | undefined;
          try {
            earlier = await ticketAlreadyOnCall(input.callSid);
          } catch (err) {
            log(
              `[runtime-xfer] ⚠️ could not read whether ${input.callSid} already holds a ticket ` +
                `(${String(err)}) — filing the urgent record as the call's own ticket`,
            );
          }
          const result = earlier
            ? await submitBeside(
                urgentRingOutBesideParams({
                  why: input.why,
                  dialTarget: input.dialTarget,
                  escalationDetails: input.escalationDetails,
                  callerId: input.callerNumber,
                  callSid: input.callSid,
                  agentUsed: input.agentUsed,
                  earlierTicket: earlier,
                }),
              )
            : await createTicket(
                urgentFallbackTicketParams({
                  why: input.why,
                  dialTarget: input.dialTarget,
                  escalationDetails: input.escalationDetails,
                  callerId: input.callerNumber,
                  callSid: input.callSid,
                  agentUsed: input.agentUsed,
                }),
              );
          if (result.success) {
            log(
              `[runtime-xfer] ✓ urgent fallback ticket ${result.ticketNumber ?? "(no number)"} for ${input.callSid}` +
                (earlier ? ` (beside ${earlier})` : ""),
            );
          } else {
            log(`[runtime-xfer] ✗ urgent fallback ticket failed for ${input.callSid}: ${result.error ?? "unknown"}`);
          }
        } catch (err) {
          log(`[runtime-xfer] ✗ urgent fallback ticket threw for ${input.callSid}: ${String(err)}`);
        }
      })();
    },
  };
}
