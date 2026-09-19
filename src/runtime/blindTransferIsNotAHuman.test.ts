/**
 * A BLIND TRANSFER RECORDED THAT THE CALLER REACHED A HUMAN. NOTHING DID.
 *
 * Measured over the PCP calls of 2026-09-14, in the Support Center:
 *
 *   pcp_handoff_status  human_answer_status     human_handoff_occurred  tickets
 *   DIALING             TRANSFERRED_TO_QUEUE    TRUE                        20
 *   NOT_REQUESTED       (none)                  TRUE                         2
 *   (none)              (none)                  TRUE                         1
 *
 * Twenty-three tickets in one day say a person was reached. On a blind
 * transfer nothing can say that — there is no keypress, and Rosa's design
 * (approved 2026-09-08) reserves the word for one: *"Nothing on this path may
 * record as `accepted`. The vocabulary is `handed_to_queue` then
 * `queue_answered` or `no_answer`, and `queue_answered` means the ACD picked
 * up, NOT that a person spoke."* A staffer who reads "handoff occurred" skips
 * the callback, which is the single thing that ticket exists to prevent.
 *
 * THE CHAIN, all four links read:
 *
 *   mediaStreamBridge.ts   teardown(): if (this.transferInFlight)
 *                          outcome = "transferred"
 *   callRecord.ts          outcome === "transferred"
 *                          -> transferredToHuman: true
 *   ticketingSyncService   humanHandoffOccurred: call.transferredToHuman
 *   ticketing-app          update-call-data writes it raw over a value the
 *                          app computes correctly itself (pcp-ticket.ts gates
 *                          on finalStatus === 'CONNECTED')
 *
 * THE DEFECT IS ONE MISSING ARGUMENT, and `blindTransfer.ts` says so without
 * knowing it: *"`ok: true` here means 'the caller is no longer ours', not
 * 'the caller reached a person'. The distinction is carried in
 * `method: 'blind'`, and every consumer that turns a TransferOutcome into a
 * record or a ticket status branches on it."*
 *
 * Every consumer except this one. `onCallerRedirectStarting` is a bare hook
 * taking no arguments, so the bridge sets one undifferentiated
 * `transferInFlight` for warm and blind alike, and the consumer that writes
 * the RECORD — named in that very sentence — is the only one that cannot
 * branch. The method now travels with the hook.
 *
 * WHAT DOES NOT CHANGE: `outcome` is still `transferred` on both paths. That
 * flag exists because the redirect kills the Media Stream and the resulting
 * close looked like `caller_hangup`, which corrupted the transfer metrics the
 * migration is judged by (Codex, PR #230 round 2). How the call ENDED is not
 * in question. Whether a HUMAN ANSWERED is, and only on the warm path does
 * anything observe it — there the redirect happens only after a keypress.
 */
import { describe, it, expect } from "vitest";
import { toCallLogRow } from "./callRecord";
import type { VoiceCallRecord } from "./mediaStreamBridge";

function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: "CA00000000000000000000000000000001",
    streamSid: "MZ0000000000000000000000000000001",
    slug: "pcp",
    callerPhone: "+16265550101",
    dialedNumber: "+16269000771",
    outcome: "transferred",
    transcript: "AGENT: ...\nCALLER: ...",
    toolEvents: [],
    agentTurns: 2,
    interruptions: 0,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_090_000,
    ...over,
  };
}

describe("transferred_to_human means a human answered", () => {
  it("a blind transfer does NOT claim a human", () => {
    const row = toCallLogRow(record({ transferMethod: "blind" }));
    expect(
      row.transferredToHuman,
      "the 20 DIALING/TRANSFERRED_TO_QUEUE tickets of 2026-09-14",
    ).not.toBe(true);
  });

  it("a warm transfer still does — the keypress proved it", () => {
    const row = toCallLogRow(record({ transferMethod: "warm" }));
    expect(row.transferredToHuman).toBe(true);
  });

  /**
   * Every other transfer-capable lane keeps the warm path, and warm is the
   * per-lane default, so an unset method must not silently downgrade a real
   * transfer to "nobody answered" — that would trade this bug for its mirror
   * image and quietly zero the metric the migration is judged by.
   */
  it("an unrecorded method is treated as warm, not as nothing", () => {
    const row = toCallLogRow(record());
    expect(row.transferredToHuman).toBe(true);
  });

  it("a call that was never transferred claims nothing, either way", () => {
    for (const m of ["warm", "blind", undefined] as const) {
      const row = toCallLogRow(record({ outcome: "caller_hangup", transferMethod: m }));
      expect(row.transferredToHuman, `outcome caller_hangup, method ${m}`).toBeUndefined();
    }
  });

  /** The flag exists so a redirect is not mis-read as a hangup. That holds
   *  on BOTH paths and is not what this change touches. */
  it("a blind transfer is still recorded as transferred, not as a hangup", () => {
    const row = toCallLogRow(record({ transferMethod: "blind" }));
    expect(row.runtimeOutcome).toBe("transferred");
    expect(row.status).toBe("completed");
  });
});

/**
 * THE ONE LINK NO BEHAVIOURAL TEST REACHES.
 *
 * `voiceRuntime` builds the handoff hooks inside the lane factory, minutes of
 * setup away from anything a unit test can drive, and it is where the method
 * is handed from the transfer to the bridge. Mutation testing showed that
 * dropping the argument there — `() => bridge?.noteTransferStarting()` —
 * leaves every other test in this change green while putting the live
 * behaviour back exactly as it was on 2026-09-14.
 *
 * So it is pinned by reading the file, the same device `ticketRequirements`
 * uses for the sweep's own wiring. A source assertion is a poor test and a
 * good tripwire; this is the second kind.
 */
describe("the runtime actually hands the method to the bridge", () => {
  it("passes it through rather than calling with no argument", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");
    expect(
      src,
      "dropping the argument silently restores the 2026-09-14 behaviour",
    ).toMatch(/onCallerRedirectStarting:\s*\(method\)\s*=>\s*bridge\?\.noteTransferStarting\(method\)/);
  });
});
