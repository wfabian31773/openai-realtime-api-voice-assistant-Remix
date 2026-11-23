import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_PER_LEVEL,
  LEVEL_RETRY_DEADLINE_MS,
  RETRY_GAP_MS,
  RING_GUARD_MS,
  attemptNote,
  createOnCallRunner,
  exhaustedNote,
  outcomeForCallStatus,
  type InCallTransferResult,
  type WarmOutcome,
} from "./runner";
import { createFakeOnCallStore } from "./store.fake";
import { FINAL_DIRECTOR, IE_DIRECTOR, provider, syntheticRotation } from "./testRotation";
import { planAt, syntheticTestPlan } from "./routing";
import type { OnCallConfig } from "./config";
import type { ChainPlan } from "./rotation";
import type { RoutingFacts } from "./store";
import { ON_CALL_ACK_PATH, ON_CALL_STATUS_PATH } from "./providerCall";

const LIVE: OnCallConfig = { mode: "live", testPhones: [], callerId: "+15550000000", requireKept: false };
const TEST: OnCallConfig = {
  mode: "test",
  testPhones: ["+15550100001", "+15550100002"],
  callerId: "+15550000000",
  requireKept: false,
};

// Wed 2026-12-02 22:30 PT, week of 12-01: provider 1 (Inland Empire) on call.
const WED_NIGHT = new Date("2026-12-03T06:30:00Z");
// Wed 2026-12-23 22:00 PT, week of 12-22: provider 3 (San Diego) on call.
const SD_WEEK_NIGHT = new Date("2026-12-24T06:00:00Z");

const SID = "CA00000000000000000000000000000001";
const ROUTING: RoutingFacts = {
  reason: "on_call",
  window: "off_hours",
  weekStartsOn: "2026-12-01",
  source: "schedule",
  notes: [],
};
const DETAILS = { reason: "Sudden curtain over the right eye", patientFirstName: "Test", callbackNumber: "+15550199999" };

const phoneOf = (id: number) => provider(id, "x").phone;

function harness(opts: { config?: OnCallConfig; start?: Date; placeCall?: any; sendSms?: any; notifyUrgent?: any; endCall?: any } = {}) {
  let clock = new Date(opts.start ?? WED_NIGHT);
  const now = () => new Date(clock);
  const store = createFakeOnCallStore(syntheticRotation(), now);
  const texts: Array<{ to: string; from: string; body: string; at: Date }> = [];
  const calls: Array<{ to: string; from: string; twiml: string; statusCallback: string; timeout: number; timeLimit: number; at: Date }> = [];
  const urgent: string[] = [];
  let sid = 0;
  const sendSms =
    opts.sendSms ??
    vi.fn(async (m: { to: string; from: string; body: string }) => {
      texts.push({ ...m, at: now() });
      return { sid: `SM${++sid}` };
    });
  const placeCall =
    opts.placeCall ??
    vi.fn(async (c: any) => {
      calls.push({ ...c, at: now() });
      return { sid: `CA9${String(++sid).padStart(31, "0")}` };
    });
  const notifyUrgent =
    opts.notifyUrgent ??
    vi.fn(async (body: string) => {
      urgent.push(body);
    });
  const hungUp: string[] = [];
  const endCall =
    opts.endCall ??
    vi.fn(async (callSid: string) => {
      hungUp.push(callSid);
    });
  const log = vi.fn();
  const runner = createOnCallRunner({
    store,
    config: opts.config ?? LIVE,
    host: "voice.example.test",
    sendSms,
    placeCall,
    notifyUrgent,
    endCall,
    now,
    log,
  });
  return {
    store,
    runner,
    texts,
    calls,
    urgent,
    hungUp,
    log,
    sendSms,
    placeCall,
    notifyUrgent,
    endCall,
    now,
    at: (d: Date) => {
      clock = new Date(d);
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    /** The id of the newest call attempt. */
    lastCallAttempt: () => {
      const all = [...store.attempts.values()].filter((a) => a.kind === "call");
      return all[all.length - 1];
    },
    escalation: () => [...store.escalations.values()][0],
  };
}

function inCall(
  plan: ChainPlan,
  outcome: WarmOutcome,
  over: Partial<InCallTransferResult> = {},
  start = WED_NIGHT,
): InCallTransferResult {
  return {
    callSid: SID,
    mode: "live",
    plan,
    routing: ROUTING,
    details: DETAILS,
    callerNumber: "+15550199999",
    warm: { outcome, dialedTo: plan.levels[0].phone, endedAt: new Date(start.getTime() + 40_000) },
    levelStartedAt: start,
    preDialSms: { ok: true, sid: "SM0", at: start },
    ...over,
  };
}

const wedPlan = () => planAt(WED_NIGHT, syntheticRotation());

describe("the cadence (success criterion: retry plus nudge within 5 minutes, then the RMD, then Dr. Logan)", () => {
  it("walks the whole chain when nobody takes it, every step logged", async () => {
    const h = harness();
    const plan = wedPlan();
    expect(plan.levels.map((l) => l.providerId)).toEqual([1, IE_DIRECTOR, FINAL_DIRECTOR]);

    // a. the in-call transfer rang out (b. no answer, logged as no answer)
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(esc).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2, phase: "due" });

    // c. the second call and the reminder text, inside 5 minutes of the call
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].to).toBe(phoneOf(1));
    expect(h.calls[0].at.getTime() - WED_NIGHT.getTime()).toBeLessThanOrEqual(5 * 60_000);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0].to).toBe(phoneOf(1));
    expect(h.texts[0].body).toMatch(/REMINDER/);
    expect(h.texts[0].body).toContain(DETAILS.reason);
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");

    // e. the region's medical director, same cadence
    const l1Start = h.now();
    await h.runner.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].to).toBe(phoneOf(IE_DIRECTOR));
    expect(h.texts[1].to).toBe(phoneOf(IE_DIRECTOR));
    expect(h.texts[1].body).toMatch(/ESCALATED — Provider 1 did not take this urgent call/);
    expect(h.texts[1].body).toContain(DETAILS.reason);
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    expect(h.calls).toHaveLength(2); // not due until the retry gap passes
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].to).toBe(phoneOf(IE_DIRECTOR));
    expect(h.calls[2].at.getTime() - l1Start.getTime()).toBeLessThanOrEqual(5 * 60_000);
    expect(h.texts[2].body).toMatch(/REMINDER/);
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "completed");

    // f. Dr. Logan (the final director), same cadence
    await h.runner.tick();
    expect(h.calls[3].to).toBe(phoneOf(FINAL_DIRECTOR));
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "busy");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    expect(h.calls[4].to).toBe(phoneOf(FINAL_DIRECTOR));
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");

    // nobody took it: closed, and the urgent number told to call the patient
    expect(h.escalation()).toMatchObject({ status: "exhausted", details: null, callerNumber: null });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/NOBODY TOOK THIS URGENT CALL — all 3 on-call levels were tried/);
    expect(h.urgent[0]).toContain(DETAILS.reason);
    await h.runner.tick();
    expect(h.calls).toHaveLength(5);

    // the log says where the call ended up, level by level
    const log = [...h.store.attempts.values()].map((a) => [a.levelIndex, a.role, a.kind, a.attemptNo, a.outcome]);
    expect(log).toEqual([
      [0, "on_call", "sms", 1, "sent"],
      [0, "on_call", "warm_transfer", 1, "no_answer"],
      [0, "on_call", "nudge_sms", 2, "sent"],
      [0, "on_call", "call", 2, "no_answer"],
      [1, "region_director", "sms", 1, "sent"],
      [1, "region_director", "call", 1, "no_answer"],
      [1, "region_director", "nudge_sms", 2, "sent"],
      [1, "region_director", "call", 2, "no_answer"],
      [2, "final", "sms", 1, "sent"],
      [2, "final", "call", 1, "busy"],
      [2, "final", "nudge_sms", 2, "sent"],
      [2, "final", "call", 2, "no_answer"],
    ]);
    for (const a of h.store.attempts.values()) {
      expect(a.callSid).toBe(SID);
      expect(a.routingReason).toBe("on_call");
    }
  });

  it("calls from the configured caller ID with the ring and length limits, and the webhooks in the signed URL", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    expect(h.calls[0]).toMatchObject({
      from: LIVE.callerId,
      timeout: 30,
      timeLimit: 300,
      statusCallback: `https://voice.example.test${ON_CALL_STATUS_PATH}?attempt=${id}`,
    });
    expect(h.calls[0].twiml).toContain(`https://voice.example.test${ON_CALL_ACK_PATH}?attempt=${id}`);
    expect(h.texts[0].from).toBe(LIVE.callerId);
    expect(h.lastCallAttempt().providerCallSid).toMatch(/^CA9/);
  });

  it("never waits past the level's 4-minute mark for the second call, even after a long ring", async () => {
    const h = harness();
    const plan = wedPlan();
    const r = inCall(plan, "no_answer", {
      warm: { outcome: "no_answer", dialedTo: plan.levels[0].phone, endedAt: new Date(WED_NIGHT.getTime() + 210_000) },
    });
    const esc = await h.runner.afterInCallTransfer(r);
    expect(esc!.nextAt!.getTime()).toBe(WED_NIGHT.getTime() + LEVEL_RETRY_DEADLINE_MS);
  });

  it("goes from a San Diego provider straight to Dr. Logan (success criterion)", async () => {
    const h = harness({ start: SD_WEEK_NIGHT });
    const plan = planAt(SD_WEEK_NIGHT, syntheticRotation());
    expect(plan.levels.map((l) => [l.role, l.providerId])).toEqual([
      ["on_call", 3],
      ["final", FINAL_DIRECTOR],
    ]);
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", {}, SD_WEEK_NIGHT));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls[0].to).toBe(phoneOf(3));
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    expect(h.calls[1].to).toBe(phoneOf(FINAL_DIRECTOR));
    expect(h.texts[1].body).toMatch(/ESCALATED — Provider 3/);
  });
});

describe("a pickup at any step stops the chain (success criterion)", () => {
  it("closes on the in-call transfer being taken, and calls nobody", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"));
    expect(esc).toMatchObject({ status: "accepted", acceptedBy: 1, details: null });
    h.advance(24 * 3_600_000);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect([...h.store.attempts.values()].map((a) => [a.kind, a.outcome])).toEqual([
      ["sms", "sent"],
      ["warm_transfer", "accepted"],
    ]);
  });

  it("closes on a key press during the second call", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    expect(await h.runner.onProviderAck(id, "5")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, details: null, callerNumber: null });
    expect(h.store.attempts.get(id)?.outcome).toBe("accepted");
    // the call's own status arrives afterwards and moves nothing
    await h.runner.onProviderStatus(id, "completed");
    h.advance(RING_GUARD_MS * 2);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.urgent).toHaveLength(0);
  });

  it("closes on a key press at the region director", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    expect(await h.runner.onProviderAck(h.lastCallAttempt().id, "1")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: IE_DIRECTOR, levelIndex: 1 });
    h.advance(RETRY_GAP_MS * 10);
    await h.runner.tick();
    expect(h.calls).toHaveLength(2);
  });

  it("tells a second provider the patient is already taken", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.runner.onProviderAck(id, "1");
    expect(await h.runner.onProviderAck(id, "1")).toBe("already_taken");
  });

  it("reads a call answered with no key press as declined, and carries on", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    expect(await h.runner.onProviderAck(id, "")).toBe("declined");
    expect(h.store.attempts.get(id)?.outcome).toBe("declined");
    await h.runner.onProviderStatus(id, "completed"); // arrives after the gather; moves nothing
    await h.runner.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].to).toBe(phoneOf(IE_DIRECTOR));
  });

  it("hangs up any other call of ours still ringing for the patient, and logs it taken_elsewhere", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
    // A call of ours that is somehow still ringing (its hang-up failed, say).
    const stray = await h.store.logAttempt({
      escalationId: esc!.id,
      callSid: SID,
      levelIndex: 0,
      role: "on_call",
      providerId: 1,
      kind: "call",
      attemptNo: 1,
      mode: "live",
      dialedTo: phoneOf(1),
    });
    await h.store.setAttemptCallSid(stray.id, "CA8".padEnd(34, "0"));
    expect(await h.runner.onProviderAck(taking.id, "1")).toBe("accepted");
    expect(h.store.attempts.get(stray.id)?.outcome).toBe("taken_elsewhere");
    expect(h.hungUp).toEqual(["CA8".padEnd(34, "0")]);
    // the hung-up call's own status then arrives and moves nothing
    await h.runner.onProviderStatus(stray.id, "completed");
    expect(h.escalation()).toMatchObject({ status: "accepted" });
    // and a key press on it answers that the patient is taken
    expect(await h.runner.onProviderAck(stray.id, "1")).toBe("already_taken");
  });

  it("hangs up nothing when the call that was taken was the only one", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(await h.runner.onProviderAck(h.lastCallAttempt().id, "1")).toBe("accepted");
    expect(h.hungUp).toEqual([]);
  });

  it("does not throw when the close keeps losing its race, and the next tick finishes it instead of ringing on", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    const real = h.store.closeEscalation.bind(h.store);
    const spy = vi.spyOn(h.store, "closeEscalation").mockResolvedValue(null);
    expect(await h.runner.onProviderAck(id, "1")).toBe("accepted");
    expect(h.store.attempts.get(id)?.outcome).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "active" });
    spy.mockImplementation(real);
    // the ringing guard comes due; it must find the key press and close, not escalate
    h.advance(RING_GUARD_MS);
    await h.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, details: null });
    expect(h.calls).toHaveLength(1);
    expect(h.texts.filter((t) => t.to !== phoneOf(1))).toHaveLength(0);
    expect(h.urgent).toHaveLength(0);
  });

  it("a due row with a key press on it closes instead of ringing", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    // A key press recorded on the chain while the row says it is due.
    const a = await h.store.logAttempt({
      escalationId: esc!.id,
      callSid: SID,
      levelIndex: 0,
      role: "on_call",
      providerId: 1,
      kind: "call",
      attemptNo: 2,
      mode: "live",
      dialedTo: phoneOf(1),
    });
    await h.store.endAttempt(a.id, "accepted", h.now());
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1 });
  });

  it("answers closed for a key press on a call the ringing guard already gave up on", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const stale = h.lastCallAttempt().id;
    h.advance(RING_GUARD_MS);
    await h.runner.tick(); // gives up on it and escalates
    expect(h.store.attempts.get(stale)?.outcome).toBe("no_status");
    expect(await h.runner.onProviderAck(stale, "1")).toBe("closed");
    expect(h.store.attempts.get(stale)?.outcome).toBe("no_status");
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1 });
  });

  it("says closed for an attempt it does not know, or one that is not a call", async () => {
    const h = harness();
    expect(await h.runner.onProviderAck(999, "1")).toBe("closed");
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const warm = [...h.store.attempts.values()].find((a) => a.kind === "warm_transfer")!;
    expect(await h.runner.onProviderAck(warm.id, "1")).toBe("closed");
  });
});

describe("what keeps the chain moving when something goes wrong", () => {
  it("ends a call whose status never came back as no_status and moves on", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    h.advance(RING_GUARD_MS - 1);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await h.runner.tick(); // the guard ends the call, hangs it up and escalates
    expect(h.store.attempts.get(id)?.outcome).toBe("no_status");
    expect(h.hungUp).toEqual([h.store.attempts.get(id)?.providerCallSid]);
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    await h.runner.tick();
    expect(h.calls[1].to).toBe(phoneOf(IE_DIRECTOR));
    // the late status for the old call changes nothing
    await h.runner.onProviderStatus(id, "no-answer");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "ringing" });
  });

  it("logs a call that could not be placed as failed and moves on", async () => {
    let n = 0;
    const placeCall = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("twilio said no");
      return { sid: "CA9" + "0".repeat(31) };
    });
    const h = harness({ placeCall });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const failed = [...h.store.attempts.values()].find((a) => a.kind === "call")!;
    expect(failed.outcome).toBe("failed");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    await h.runner.tick();
    expect(placeCall).toHaveBeenCalledTimes(2);
  });

  it("still calls when the text could not be sent, and logs the text as send_failed", async () => {
    const sendSms = vi.fn(async () => {
      throw new Error("carrier refused");
    });
    const h = harness({ sendSms });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect([...h.store.attempts.values()].find((a) => a.kind === "nudge_sms")?.outcome).toBe("send_failed");
  });

  it("moves the chain once for a status that arrives twice", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.runner.onProviderStatus(id, "no-answer");
    await h.runner.onProviderStatus(id, "no-answer");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1 });
  });

  it("ignores a status that is not terminal", async () => {
    expect(outcomeForCallStatus("ringing")).toBeNull();
    expect(outcomeForCallStatus("in-progress")).toBeNull();
    expect(outcomeForCallStatus("no-answer")).toBe("no_answer");
    expect(outcomeForCallStatus("completed")).toBe("no_answer");
    expect(outcomeForCallStatus("busy")).toBe("busy");
    expect(outcomeForCallStatus("failed")).toBe("failed");
    expect(outcomeForCallStatus("canceled")).toBe("failed");
  });

  it("rings a level once when two runners tick at the same moment", async () => {
    const h = harness();
    const second = createOnCallRunner({
      store: h.store,
      config: LIVE,
      host: "voice.example.test",
      sendSms: h.sendSms,
      placeCall: h.placeCall,
      notifyUrgent: h.notifyUrgent,
      endCall: h.endCall,
      now: h.now,
      log: () => {},
    });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await Promise.all([h.runner.tick(), second.tick()]);
    expect(h.calls).toHaveLength(1);
  });

  it("does not ring a row whose version moved under it", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    const original = h.store.claimDue.bind(h.store);
    h.store.claimDue = async (...args) => {
      const rows = await original(...args);
      // something else writes the row between the claim and the ring
      for (const r of rows) await h.store.updateEscalation(r.id, r.version, {});
      return rows;
    };
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
  });

  it("does nothing while the on-call tables are absent", async () => {
    const h = harness();
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.store.tablesPresent = false;
    h.advance(10 * 60_000);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
  });

  it("tells the urgent number to call the patient when the escalation cannot be recorded", async () => {
    const h = harness();
    h.store.failWrites = true;
    expect(await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"))).toBeNull();
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
    expect(h.urgent[0]).toContain(DETAILS.reason);
  });

  it("says nothing to the urgent number when an accepted transfer cannot be recorded", async () => {
    const h = harness();
    h.store.failWrites = true;
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"));
    expect(h.urgent).toHaveLength(0);
  });

  it("opens one escalation per call and hands back the existing one", async () => {
    const h = harness();
    const a = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const b = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    expect(b?.id).toBe(a?.id);
    expect(h.store.escalations.size).toBe(1);
    expect([...h.store.attempts.values()].filter((x) => x.kind === "warm_transfer")).toHaveLength(1);
  });

  it("skips a level with no phone number and moves on", async () => {
    const h = harness();
    const plan = wedPlan();
    plan.levels[1] = { ...plan.levels[1], phone: "" };
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick(); // level 1 has no number
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 2 });
  });
});

describe("test mode", () => {
  it("stores a synthetic test level's id as nothing, never a made-up provider", async () => {
    const h = harness({ config: TEST });
    const plan = syntheticTestPlan(TEST);
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    for (const a of h.store.attempts.values()) expect(a.providerId).toBeNull();
    expect(await h.runner.onProviderAck(h.lastCallAttempt().id, "1")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: null });
  });

  it("marks every text as a test", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.texts[0].body).toMatch(/\[TEST MODE\] REMINDER/);
  });

  it("cancels rather than ring a number outside the test list", async () => {
    const h = harness({ config: TEST });
    const plan = wedPlan(); // live phones
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "cancelled", details: null });
  });

  it("cancels a live-mode row once the process is switched to test", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer", { mode: "live" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()?.status).toBe("cancelled");
  });
});

describe("the notes on the texts", () => {
  const plan = wedPlan();
  const base = { plan, routing: ROUTING, mode: "live" as const };

  it("asks for a key press on our call on every text", () => {
    for (const [levelIndex, attemptNo] of [
      [0, 2],
      [1, 1],
      [1, 2],
      [2, 1],
    ]) {
      expect(attemptNote({ ...base, levelIndex, attemptNo })).toMatch(/Press any key on the call we are placing to you now/);
    }
  });

  it("says on level 0's reminder that the transfer was not taken and we are calling again", () => {
    const note = attemptNote({ ...base, levelIndex: 0, attemptNo: 2 });
    expect(note).toMatch(/the urgent transfer to you was not taken/);
    expect(note).toMatch(/We are calling you again now/);
  });

  it("makes no claim on any text about whether the patient is still on the line", () => {
    // When the reminder goes out the caller may well still be talking to the agent.
    for (const [levelIndex, attemptNo] of [
      [0, 2],
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]) {
      expect(attemptNote({ ...base, levelIndex, attemptNo })).not.toMatch(/no longer on the line|still on the line/);
    }
  });

  it("names who did not take it on a new level", () => {
    expect(attemptNote({ ...base, levelIndex: 2, attemptNo: 1 })).toMatch(/ESCALATED — Provider 91 did not take/);
  });

  it("carries the routing note, so a post-op doubt reaches every level", () => {
    const note = "Post-op status could not be confirmed.";
    expect(attemptNote({ ...base, routing: { ...ROUTING, note }, levelIndex: 1, attemptNo: 1 })).toContain(note);
  });

  it("counts the levels in the closing alert", () => {
    expect(exhaustedNote({ plan, mode: "live" })).toMatch(/all 3 on-call levels were tried/);
    expect(exhaustedNote({ plan: { levels: [plan.levels[0]], notes: [] }, mode: "test" })).toMatch(
      /^\[TEST MODE\] .*all 1 on-call level was tried/,
    );
  });

  it("asks for at most two calls a level", () => {
    expect(ATTEMPTS_PER_LEVEL).toBe(2);
    expect(RETRY_GAP_MS).toBeLessThan(LEVEL_RETRY_DEADLINE_MS);
    expect(LEVEL_RETRY_DEADLINE_MS).toBeLessThan(5 * 60_000);
  });
});

describe("the timer", () => {
  it("ticks on an interval and stops", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const tick = vi.spyOn(h.runner, "tick");
      h.runner.start();
      h.runner.start(); // idempotent
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(1);
      h.runner.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
