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
} from "../services/urgentTransferAlert";

export interface UrgentTransferAlerts {
  /** The heads-up text, sent BEFORE the on-call phone rings. */
  smsBeforeDial(input: { callerNumber?: string; escalationDetails?: EscalationDetails }): void;
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
  const now = deps.now ?? (() => new Date());

  return {
    smsBeforeDial(input) {
      const to = env.URGENT_NOTIFICATION_NUMBER?.trim();
      const from = env.TWILIO_PHONE_NUMBER?.trim();
      if (!to || !from) {
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
          await (await smsClient()).messages.create({ body, from, to });
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
          const result = await createTicket(
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
            log(`[runtime-xfer] ✓ urgent fallback ticket ${result.ticketNumber ?? "(no number)"} for ${input.callSid}`);
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
