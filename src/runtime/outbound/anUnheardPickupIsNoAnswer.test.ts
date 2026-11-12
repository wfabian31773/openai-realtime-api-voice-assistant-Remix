/**
 * A DIALLED CALL THAT CONNECTED AND ON WHICH THE CALLER NEVER SAID A WORD IS
 * NOT AN ANSWER (v213, operator 2026-11-12: "if they dont answer, send them a
 * text").
 *
 * The corpus: the NPX campaign's first two connected calls of its first
 * evening, CA2c6daf4be55fdeff507d87a7a46475a6 (00:33 UTC) and
 * CAbd9602be8a7b0ac08de364a89e39917f (00:37 UTC). Both heard the greeting,
 * both were a silent line (0% of the caller's audio voiced, no caller line in
 * the transcript), both were cut by the silence ladder after three prompts,
 * and both were settled `answered` by the status webhook, a status the
 * dialler never rings again. Synthetic contacts stand in for the patients.
 */
import { describe, expect, it } from "vitest";
import { OPERATOR_SLUG } from "../../plugin/operatorLine";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { callerWasHeard, handleOutboundStatus, settleUnheardPickup, unheardPickupToSettle } from "./outboundWebhook";
import { readFileSync } from "node:fs";
import { FakeOutboundStore } from "./store.testkit";
import { statusUrl } from "./dialer";
import twilio from "twilio";
import type { WebhookRequest } from "../voiceWebhook";

const NOW = new Date("2041-03-05T18:00:00Z");
const AUTH_TOKEN = "test-auth-token";
const HOST = "runtime.example.com";
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: (c) => `Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with ${c.firstName}?`,
  voicemail: () => "Hello, this is Azul Vision.",
};

/** The two corpus transcripts, as the runtime wrote them (names removed). */
const SILENT_LINE = [
  "AGENT: Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with Testa?",
  "AGENT: I'm sorry, I cannot hear you. Are you still there?",
  "AGENT: I'm sorry, I cannot hear you. Are you still there?",
  "AGENT: I'm sorry, I cannot hear you. Are you still there?",
].join("\n");
const CORPUS = ["CA2c6daf4be55fdeff507d87a7a46475a6", "CAbd9602be8a7b0ac08de364a89e39917f"];

async function setup() {
  const store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: "c1", phone: "+15555550111", firstName: "Testa" });
  await store.claimContact("c1", NOW);
  const attemptId = await store.startAttempt("c1", "campaign-1", 1);
  const deps = { store, policyFor: async (slug: string) => (slug === "test-lane" ? policy : null), now: () => NOW };
  return { store, deps, attemptId };
}

function signed(url: string, body: Record<string, string>): WebhookRequest {
  const sig = (
    twilio as unknown as { getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string }
  ).getExpectedTwilioSignature(AUTH_TOKEN, url, body);
  const u = new URL(url);
  return { headers: { host: u.host, "x-forwarded-proto": "https", "x-twilio-signature": sig }, body, originalUrl: `${u.pathname}${u.search}` };
}

const completed = (attemptId: string, callSid: string) =>
  signed(statusUrl(HOST, "test-lane", "c1", attemptId), { CallSid: callSid, CallStatus: "completed", CallDuration: "66", AnsweredBy: "unknown" });

describe("whether the caller was heard", () => {
  it("reads the corpus transcripts as a caller who never spoke", () => {
    expect(callerWasHeard(SILENT_LINE)).toBe(false);
    expect(callerWasHeard("")).toBe(false);
  });

  it("counts any line the caller said, and no empty one", () => {
    expect(callerWasHeard(`${SILENT_LINE}\nCALLER: Hello?`)).toBe(true);
    expect(callerWasHeard("AGENT: Hi.\nCALLER: \nAGENT: Bye.")).toBe(false);
    // The word in an agent line is not the caller.
    expect(callerWasHeard("AGENT: The CALLER: field is empty.")).toBe(false);
  });
});

describe("a pickup where the caller never spoke", () => {
  for (const callSid of CORPUS) {
    it(`${callSid}: settled at teardown, before Twilio's completed, it goes back in the queue and stays there`, async () => {
      const { store, deps, attemptId } = await setup();
      expect(await settleUnheardPickup("test-lane", "c1", attemptId, deps)).toBe(true);
      const c = store.contacts.get("c1")!;
      expect(c.status).toBe("no_answer");
      expect(c.nextAttemptAt).not.toBeNull();
      // Twilio's completed arrives after the sign-off: it no longer marks
      // them answered.
      await handleOutboundStatus("test-lane", completed(attemptId, callSid), {
        ...deps,
        env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
        registry: undefined as never,
      });
      expect(store.contacts.get("c1")!.status).toBe("no_answer");
    });

    it(`${callSid}: when Twilio's completed came first, the answered is replaced`, async () => {
      const { store, deps, attemptId } = await setup();
      await handleOutboundStatus("test-lane", completed(attemptId, callSid), {
        ...deps,
        env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
        registry: undefined as never,
      });
      expect(store.contacts.get("c1")!.status).toBe("answered");
      expect(await settleUnheardPickup("test-lane", "c1", attemptId, deps)).toBe(true);
      expect(store.contacts.get("c1")!.status).toBe("no_answer");
    });
  }

  it("never replaces an outcome the call recorded", async () => {
    for (const status of ["voicemail", "do_not_call", "callback_scheduled", "declined", "completed", "wrong_number"] as const) {
      const { store, deps, attemptId } = await setup();
      await store.settleContact("c1", status);
      expect(await settleUnheardPickup("test-lane", "c1", attemptId, deps)).toBe(false);
      expect(store.contacts.get("c1")!.status).toBe(status);
    }
  });

  it("stops at the total cap instead of queueing another try", async () => {
    const { store, deps } = await setup();
    await store.startAttempt("c1", "campaign-1", 2);
    const third = await store.startAttempt("c1", "campaign-1", 3);
    expect(await settleUnheardPickup("test-lane", "c1", third, deps)).toBe(true);
    expect(store.contacts.get("c1")!.status).toBe("max_attempts");
  });

  it("does not settle a newer call from an older attempt", async () => {
    const { store, deps, attemptId: first } = await setup();
    store.contacts.get("c1")!.status = "no_answer";
    await store.claimContact("c1", NOW);
    await store.startAttempt("c1", "campaign-1", 2);
    expect(await settleUnheardPickup("test-lane", "c1", first, deps)).toBe(false);
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });

  it("does nothing for the operator line or a lane with no outbound policy", async () => {
    const { store, deps, attemptId } = await setup();
    // Even when the operator line resolves to a policy.
    const everyLane = { ...deps, policyFor: async () => policy };
    expect(await settleUnheardPickup(OPERATOR_SLUG, "c1", attemptId, everyLane)).toBe(false);
    expect(await settleUnheardPickup("optical", "c1", attemptId, deps)).toBe(false);
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });
});

describe("which teardown settles one", () => {
  const outbound = { contactId: "c1", attemptId: "a1" };
  /** The corpus calls' meter: a whole call of frames, nothing voiced. */
  const SILENT = { frames: 2_500, voiced: 0 };

  it("a dialled call with no caller line and a silent line", () => {
    expect(
      unheardPickupToSettle({ slug: "npx-outreach", outbound, liveCall: false, transcript: SILENT_LINE, callerAudio: SILENT }),
    ).toEqual(outbound);
  });

  it("a dialled call whose caller audio never arrived at all", () => {
    expect(
      unheardPickupToSettle({
        slug: "npx-outreach",
        outbound,
        liveCall: false,
        transcript: SILENT_LINE,
        callerAudio: { frames: 0, voiced: 0 },
      }),
    ).toEqual(outbound);
  });

  // Codex P1 on #459: a missing transcript is not silence. 11 of the 25 NPX
  // pickups with no caller line since 2026-11-07 carried voiced audio (3 at
  // 5% or more), a person who spoke and was not transcribed, or who hung up
  // before the transcript landed. Those are not rung again.
  it("not a dialled call whose caller audio was voiced, though nothing was transcribed", () => {
    expect(
      unheardPickupToSettle({
        slug: "npx-outreach",
        outbound,
        liveCall: false,
        transcript: SILENT_LINE,
        callerAudio: { frames: 1_400, voiced: 70 },
      }),
    ).toBeNull();
    // One voiced frame is enough: the meter's own verdict, not a threshold of ours.
    expect(
      unheardPickupToSettle({
        slug: "npx-outreach",
        outbound,
        liveCall: false,
        transcript: SILENT_LINE,
        callerAudio: { frames: 1_400, voiced: 1 },
      }),
    ).toBeNull();
  });

  it("not a dialled call the caller spoke on", () => {
    expect(
      unheardPickupToSettle({
        slug: "npx-outreach",
        outbound,
        liveCall: false,
        transcript: `${SILENT_LINE}\nCALLER: Yes.`,
        callerAudio: SILENT,
      }),
    ).toBeNull();
  });

  it("not a live call, whose transcript is blanked before teardown", () => {
    expect(
      unheardPickupToSettle({ slug: "si-assistant", outbound, liveCall: true, transcript: "", callerAudio: SILENT }),
    ).toBeNull();
  });

  it("not the operator line, and not a call we did not dial", () => {
    expect(
      unheardPickupToSettle({ slug: OPERATOR_SLUG, outbound, liveCall: false, transcript: "", callerAudio: SILENT }),
    ).toBeNull();
    expect(unheardPickupToSettle({ slug: "optical", liveCall: false, transcript: "", callerAudio: SILENT })).toBeNull();
  });

  it("the runtime hands it the live flag it blanks the transcript on, and the socket meter's counts", () => {
    const src = readFileSync(new URL("../voiceRuntime.ts", import.meta.url), "utf8");
    expect(src).toMatch(
      /unheardPickupToSettle\(\{[^}]*liveCall: isLiveCall,[^}]*transcript: record\.transcript,[^}]*callerAudio: callerAudio\.counts\(\),/s,
    );
    expect(src).toContain("if (isLiveCall) record = { ...record, transcript: \"\", turns: [], toolEvents: [] };");
  });
});
