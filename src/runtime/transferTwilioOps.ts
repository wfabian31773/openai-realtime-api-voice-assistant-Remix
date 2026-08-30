/**
 * The Twilio side of a runtime warm transfer.
 *
 * `warmTransfer.ts` holds the ordering and the safety property and knows
 * nothing about Twilio; this is the adapter that makes its four operations
 * real. The TwiML is built by pure functions so the thing a caller and an
 * office actually land in is testable without a Twilio account.
 *
 * Both legs meet in an ordinary two-party conference. The office joins first —
 * it has already pressed a key by the time the caller is redirected — so the
 * caller never hears hold music waiting for someone who may not come.
 */
import { escapeConferenceXml } from "./transferTwiml";
import type { TransferTwilioOps } from "./warmTransfer";

/** The minimum Twilio surface this needs. Narrow on purpose: a client that can
 * only do these three things cannot book, cannot message, cannot delete. */
export interface MinimalTwilioClient {
  calls: {
    create(opts: {
      to: string;
      from: string;
      twiml: string;
      timeout?: number;
      statusCallback?: string;
      statusCallbackMethod?: string;
      statusCallbackEvent?: string[];
    }): Promise<{ sid: string }>;
    (sid: string): {
      update(opts: { twiml?: string; status?: string }): Promise<unknown>;
    };
  };
}

export interface TransferTwilioOptions {
  /** Presented to the office as the caller. */
  fromNumber: string;
  /** Presented to the callee when the caller is redirected, if set. */
  callerId?: string;
  log?: (line: string) => void;
}

export function createTransferTwilioOps(
  client: MinimalTwilioClient,
  opts: TransferTwilioOptions,
): TransferTwilioOps {
  const log = opts.log ?? ((line: string) => console.log(line));
  return {
    async createOfficeLeg({ to, from, twiml, timeoutSeconds, statusCallbackUrl }) {
      const created = await client.calls.create({
        to,
        from,
        twiml,
        timeout: timeoutSeconds,
        // The terminal status is what settles a dial that dies without
        // ever accepting — no-answer, busy, failed — so the caller's
        // agent learns immediately instead of waiting out the whole
        // accept window (Codex, PR #230 round 2).
        ...(statusCallbackUrl
          ? {
              statusCallback: statusCallbackUrl,
              statusCallbackMethod: "POST",
              statusCallbackEvent: ["completed"],
            }
          : {}),
      });
      return { sid: created.sid };
    },

    async redirectCallerToConference({ callerCallSid, conferenceName, callerId }) {
      // This ENDS the media stream — `<Connect><Stream>` owns the caller's
      // verb slot, so replacing the TwiML replaces the stream. By this point a
      // human has already accepted, which is the only reason it is safe.
      await client.calls(callerCallSid).update({
        twiml: buildCallerConferenceTwiml({
          conferenceName,
          callerId: callerId ?? opts.callerId,
        }),
      });
      log(`[runtime-xfer] caller ${callerCallSid} redirected into ${conferenceName}`);
    },

    async endCall(callSid) {
      await client.calls(callSid).update({ status: "completed" });
    },
  };
}

export interface ConferenceTwimlInput {
  conferenceName: string;
  callerId?: string;
}

/**
 * What the CALLER is redirected into.
 *
 * No `waitUrl` hold music: the office is already in the room, so anything the
 * caller hears before the bridge is noise between two people who are both
 * present. `endConferenceOnExit` on both legs means whoever hangs up first
 * ends it, rather than leaving the other party in an empty room.
 */
export function buildCallerConferenceTwiml({
  conferenceName,
  callerId,
}: ConferenceTwimlInput): string {
  const callerIdAttr = callerId ? ` callerId="${escapeConferenceXml(callerId)}"` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Dial${callerIdAttr}>` +
    `<Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true"` +
    ` participantLabel="caller">` +
    `${escapeConferenceXml(conferenceName)}` +
    `</Conference>` +
    `</Dial>` +
    `</Response>`
  );
}

/**
 * What the OFFICE hears the instant it presses a key — the accept webhook's
 * response. One line, then the bridge.
 */
export function buildOfficeAcceptTwiml({ conferenceName }: ConferenceTwimlInput): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="Polly.Joanna">Connecting you to the caller now.</Say>` +
    `<Dial>` +
    `<Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true"` +
    ` participantLabel="office">` +
    `${escapeConferenceXml(conferenceName)}` +
    `</Conference>` +
    `</Dial>` +
    `</Response>`
  );
}

/** The office pressed a key on a leg nobody is waiting on any more. */
export function buildExpiredTransferTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="Polly.Joanna">That transfer is no longer waiting. Goodbye.</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/** The office declined, or the briefing played out with no keypress. */
export function buildDeclinedTransferTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
}
