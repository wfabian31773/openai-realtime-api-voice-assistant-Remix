import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_PER_LEVEL,
  LEVEL_RETRY_DEADLINE_MS,
  RETRY_GAP_MS,
  RING_GUARD_MS,
  STALE_ESCALATION_MS,
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
  const urgentModes: string[] = [];
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
    vi.fn(async (body: string, mode: string) => {
      urgent.push(body);
      urgentModes.push(mode);
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
    urgentModes,
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
    expect(h.urgentModes).toEqual(["live"]);
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
    const second = await h.store.logAttempt({
      escalationId: esc!.id,
      callSid: SID,
      levelIndex: 1,
      role: "region_director",
      providerId: IE_DIRECTOR,
      kind: "call",
      attemptNo: 1,
      mode: "live",
      dialedTo: phoneOf(IE_DIRECTOR),
    });
    expect(await h.runner.onProviderAck(second.id, "1")).toBe("already_taken");
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

  /** A second call of ours on the same escalation, still ringing. */
  async function strayCall(h: ReturnType<typeof harness>, escalationId: number, levelIndex = 0, providerId = 1) {
    const stray = await h.store.logAttempt({
      escalationId,
      callSid: SID,
      levelIndex,
      role: levelIndex === 0 ? "on_call" : "region_director",
      providerId,
      kind: "call",
      attemptNo: 1,
      mode: "live",
      dialedTo: phoneOf(providerId),
    });
    await h.store.setAttemptCallSid(stray.id, "CA8".padEnd(34, "0"));
    return stray;
  }

  it("still takes the patient and logs it when hanging up the other call fails", async () => {
    const endCall = vi.fn(async () => {
      throw new Error("twilio down");
    });
    const h = harness({ endCall });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
    const stray = await strayCall(h, esc!.id);
    expect(await h.runner.onProviderAck(taking.id, "1")).toBe("accepted");
    expect(endCall).toHaveBeenCalledWith("CA8".padEnd(34, "0"));
    expect(h.store.attempts.get(stray.id)?.outcome).toBe("taken_elsewhere");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1 });
    expect(h.log.mock.calls.some(([l]) => /could not hang up a provider call: twilio down/.test(String(l)))).toBe(true);
  });

  it("tells a key press that read the chain before another took it that the patient is taken", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
    const stray = await strayCall(h, esc!.id);
    // The stray's key press reads the escalation while it is still active;
    // the taking call's key press then runs to the end before the stray's
    // carries on, closing the chain and ending the stray as taken_elsewhere.
    const real = h.store.getEscalation.bind(h.store);
    let raced = false;
    let takingAnswer: string | undefined;
    vi.spyOn(h.store, "getEscalation").mockImplementation(async (id: number) => {
      const row = await real(id);
      if (!raced) {
        raced = true;
        takingAnswer = await h.runner.onProviderAck(taking.id, "1");
      }
      return row;
    });
    expect(await h.runner.onProviderAck(stray.id, "1")).toBe("already_taken");
    expect(takingAnswer).toBe("accepted");
    expect(h.store.attempts.get(stray.id)?.outcome).toBe("taken_elsewhere");
  });

  it("when two providers press a key at once, tells only the one the escalation names", async () => {
    const h = harness();
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const first = h.lastCallAttempt(); // the on-call provider, the lower attempt id
    const second = await strayCall(h, esc!.id, 1, plan.levels[1].providerId); // the director
    // The first provider's key press records `accepted`; before it closes the
    // chain, the director's key press runs to the end and closes it.
    const real = h.store.endAttempt.bind(h.store);
    let raced = false;
    let secondAnswer: string | undefined;
    vi.spyOn(h.store, "endAttempt").mockImplementation(async (id: number, outcome: any, at: Date) => {
      const row = await real(id, outcome, at);
      if (!raced && id === first.id && outcome === "accepted") {
        raced = true;
        secondAnswer = await h.runner.onProviderAck(second.id, "1");
      }
      return row;
    });
    const firstAnswer = await h.runner.onProviderAck(first.id, "1");
    expect(secondAnswer).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: plan.levels[1].providerId });
    // one provider is told they have the patient, not two
    expect(firstAnswer).toBe("already_taken");
    expect(h.escalation()?.acceptedAttemptId).toBe(second.id);
  });

  it("names the call that took the patient when neither level stores a provider id", async () => {
    // A test-mode chain's levels are synthetic, so both calls carry a null
    // provider id; the row must still tell only one of them they have it.
    const h = harness({ config: TEST });
    const plan = syntheticTestPlan(TEST);
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const first = h.lastCallAttempt();
    const second = await h.store.logAttempt({
      escalationId: esc!.id,
      callSid: SID,
      levelIndex: 1,
      role: "region_director",
      providerId: null,
      kind: "call",
      attemptNo: 1,
      mode: "test",
      dialedTo: plan.levels[1].phone,
    });
    expect(first.providerId).toBeNull();
    const real = h.store.endAttempt.bind(h.store);
    let raced = false;
    let secondAnswer: string | undefined;
    vi.spyOn(h.store, "endAttempt").mockImplementation(async (id: number, outcome: any, at: Date) => {
      const row = await real(id, outcome, at);
      if (!raced && id === first.id && outcome === "accepted") {
        raced = true;
        secondAnswer = await h.runner.onProviderAck(second.id, "1");
      }
      return row;
    });
    const firstAnswer = await h.runner.onProviderAck(first.id, "1");
    expect(secondAnswer).toBe("accepted");
    expect(firstAnswer).toBe("already_taken");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: null, acceptedAttemptId: second.id });
  });

  it("tells a key press arriving twice for the call that took the patient that it is theirs", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
    expect(await h.runner.onProviderAck(taking.id, "1")).toBe("accepted");
    expect(await h.runner.onProviderAck(taking.id, "1")).toBe("accepted");
    const other = await strayCall(h, esc!.id, 1, wedPlan().levels[1].providerId);
    expect(await h.runner.onProviderAck(other.id, "1")).toBe("already_taken");
  });

  it("tells a key press that a move already found, and closed the chain on, that the patient is theirs", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
    // The key press records `accepted`; before it closes the chain, the next
    // move comes due, finds that press and closes the chain on it first.
    const real = h.store.endAttempt.bind(h.store);
    let raced = false;
    vi.spyOn(h.store, "endAttempt").mockImplementation(async (id: number, outcome: any, at: Date) => {
      const row = await real(id, outcome, at);
      if (!raced && id === taking.id && outcome === "accepted") {
        raced = true;
        h.advance(RING_GUARD_MS + 1);
        await h.runner.tick();
      }
      return row;
    });
    const answer = await h.runner.onProviderAck(taking.id, "1");
    expect(raced).toBe(true);
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: taking.providerId });
    expect(answer).toBe("accepted");
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
    // brought due now, not left for the ringing guard
    expect(h.escalation()?.nextAt?.getTime()).toBe(h.now().getTime());
    spy.mockImplementation(real);
    // the next tick must find the key press and close, not escalate
    await h.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, details: null });
    expect(h.calls).toHaveLength(1);
    expect(h.texts.filter((t) => t.to !== phoneOf(1))).toHaveLength(0);
    expect(h.urgent).toHaveLength(0);
  });

  it("tells a key press whose close another call won that the patient is already taken", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    const other = await h.store.logAttempt({
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
    const realClose = h.store.closeEscalation.bind(h.store);
    // Every close from this key press loses its race...
    vi.spyOn(h.store, "closeEscalation").mockResolvedValue(null);
    // ...and while it brings the row due, the other call's close lands.
    vi.spyOn(h.store, "updateEscalation").mockImplementationOnce(async () => {
      const cur = (await h.store.getEscalation(esc!.id))!;
      await realClose(cur.id, cur.version, {
        status: "accepted",
        acceptedBy: 1,
        acceptedAt: h.now(),
        acceptedAttemptId: other.id,
        nextAt: null,
      });
      return null;
    });
    expect(await h.runner.onProviderAck(id, "1")).toBe("already_taken");
  });

  it("still answers accepted when bringing the taken chain due throws", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    vi.spyOn(h.store, "closeEscalation").mockResolvedValue(null);
    vi.spyOn(h.store, "updateEscalation").mockRejectedValue(new Error("hub down"));
    expect(await h.runner.onProviderAck(id, "1")).toBe("accepted");
    expect(h.log.mock.calls.some(([l]) => String(l).includes("could not bring the taken chain due"))).toBe(true);
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

  it("keeps a placed call open when its call sid cannot be saved, and the chain waits for its status", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const realSave = h.store.setAttemptCallSid.bind(h.store);
    h.store.setAttemptCallSid = async () => {
      throw new Error("hub blip");
    };
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    const ringing = h.lastCallAttempt();
    expect(ringing.outcome).toBe("in_progress");
    expect(ringing.providerCallSid ?? null).toBeNull();
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2, phase: "ringing" });
    const lines = h.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toMatch(/is ringing but its call sid could not be saved/);
    expect(lines).not.toMatch(/could not be placed/);
    h.store.setAttemptCallSid = realSave;
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(await h.runner.onProviderAck(ringing.id, "1")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted" });
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
    expect(h.urgentModes).toEqual(["live"]);
  });

  it("keeps a chain whose row opened when the first attempt's log row cannot be written, and tells nobody it did not start", async () => {
    const h = harness();
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a: any) => {
      if (a.kind === "warm_transfer") throw new Error("write timed out");
      return realLog(a);
    };
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    expect(esc).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2 });
    expect(h.urgent).toHaveLength(0);
    h.store.logAttempt = realLog;
    h.at(new Date(WED_NIGHT.getTime() + 40_000 + RETRY_GAP_MS));
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].to).toBe(phoneOf(1));
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 0, attemptNo: 2 });
  });

  it("says nothing to the urgent number when an accepted transfer cannot be recorded", async () => {
    const h = harness();
    h.store.failWrites = true;
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"));
    expect(h.urgent).toHaveLength(0);
  });

  it("brings a taken transfer due when its close loses every race, and the next tick closes it without ringing", async () => {
    const h = harness();
    const realClose = h.store.closeEscalation.bind(h.store);
    let losing = true;
    h.store.closeEscalation = async (...args) => (losing ? null : realClose(...args));
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"));
    expect(esc).toMatchObject({ status: "active" });
    expect(esc!.nextAt!.getTime()).toBeLessThanOrEqual(h.now().getTime());
    losing = false;
    await h.runner.tick();
    const warm = [...h.store.attempts.values()].find((a) => a.kind === "warm_transfer")!;
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, acceptedAttemptId: warm.id, details: null });
    expect(h.calls).toHaveLength(0);
    expect(h.urgent).toHaveLength(0);
  });

  it("brings the row due when every advance loses its race, and the next tick moves on in seconds, not at the ring guard", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.escalation()).toMatchObject({ levelIndex: 0, attemptNo: 2, phase: "ringing" });

    // Every move to the next level loses its race; bringing the row due does not.
    const realUpdate = h.store.updateEscalation.bind(h.store);
    let losing = true;
    let lost = 0;
    h.store.updateEscalation = async (id, version, patch) => {
      if (losing && patch.levelIndex !== undefined) {
        lost++;
        return null;
      }
      return realUpdate(id, version, patch);
    };
    const statusAt = h.now();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(lost).toBe(3);
    expect(h.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/could not advance after three tries; bringing it due/);
    const due = h.escalation();
    expect(due).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2, phase: "ringing" });
    expect(due.nextAt!.getTime()).toBeLessThanOrEqual(statusAt.getTime());

    // The next tick reads the ringing row past its time and moves the chain on.
    losing = false;
    h.advance(5_000);
    await h.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1, attemptNo: 1 });
    await h.runner.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].to).toBe(phoneOf(IE_DIRECTOR));
    expect(h.calls[1].at.getTime() - statusAt.getTime()).toBeLessThan(RING_GUARD_MS);
  });

  it("closes a taken transfer whose attempt could not be logged, and rings nobody", async () => {
    const h = harness();
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a) => {
      if (a.kind === "warm_transfer") throw new Error("fake store: attempt refused");
      return realLog(a);
    };
    expect(await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"))).toBeNull();
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, acceptedAttemptId: null });
    h.advance(24 * 3_600_000);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.urgent).toHaveLength(0);
  });

  it("does not bring due a taken transfer it could neither log nor close, so the provider who took it is not rung", async () => {
    const h = harness();
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a) => {
      if (a.kind === "warm_transfer") throw new Error("fake store: attempt refused");
      return realLog(a);
    };
    h.store.closeEscalation = async () => null;
    expect(await h.runner.afterInCallTransfer(inCall(wedPlan(), "accepted"))).toBeNull();
    const row = h.escalation()!;
    expect(row.status).toBe("active");
    expect(row.nextAt!.getTime()).toBeGreaterThan(h.now().getTime() + STALE_ESCALATION_MS);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
  });

  it("stops an escalation that comes due more than two hours after it opened, and tells the urgent number", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(new Date(esc!.createdAt.getTime() + STALE_ESCALATION_MS + 1));
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "failed", details: null });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/THE ON-CALL ESCALATION STOPPED/);
    expect(h.urgent[0]).toContain(DETAILS.reason);
  });

  it("still rings an escalation that comes due just inside two hours", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(new Date(esc!.createdAt.getTime() + STALE_ESCALATION_MS));
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.escalation()).toMatchObject({ status: "active" });
  });

  it("sends a test chain's closing text as a test", async () => {
    const h = harness({ config: TEST });
    await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    for (let i = 0; i < 20 && h.escalation()!.status === "active"; i++) {
      h.advance(RETRY_GAP_MS);
      const before = h.calls.length;
      await h.runner.tick();
      if (h.calls.length > before) await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    }
    expect(h.escalation()).toMatchObject({ status: "exhausted" });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain("[TEST MODE] NOBODY TOOK THIS URGENT CALL");
    expect(h.urgentModes).toEqual(["test"]);
  });

  it("marks a stale escalation's text as a test in test mode", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    h.at(new Date(esc!.createdAt.getTime() + STALE_ESCALATION_MS + 1));
    await h.runner.tick();
    expect(h.urgent[0]).toContain("[TEST MODE] THE ON-CALL ESCALATION STOPPED");
    expect(h.urgentModes).toEqual(["test"]);
  });

  it("opens one escalation per call and hands back the existing one", async () => {
    const h = harness();
    const a = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const b = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    expect(b?.id).toBe(a?.id);
    expect(h.store.escalations.size).toBe(1);
    expect([...h.store.attempts.values()].filter((x) => x.kind === "warm_transfer")).toHaveLength(1);
  });

  it("skips a level with no phone number straight to the next level, with no retry wait", async () => {
    const h = harness();
    const plan = wedPlan();
    plan.levels[1] = { ...plan.levels[1], phone: "" };
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    const atLevel1 = h.escalation();
    expect(atLevel1).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    const before = h.calls.length;
    await h.runner.tick(); // level 1 has no number
    // One failed attempt row for the level, and the chain is at the next level,
    // due now: no 60-second retry of a number that does not exist.
    const level1 = [...h.store.attempts.values()].filter((a) => a.levelIndex === 1);
    expect(level1).toHaveLength(1);
    expect(level1[0]).toMatchObject({ kind: "call", outcome: "failed", dialedTo: null });
    expect(h.escalation()).toMatchObject({ levelIndex: 2, attemptNo: 1, phase: "due" });
    expect(h.escalation().nextAt!.getTime()).toBeLessThanOrEqual(h.now().getTime());
    expect(h.calls.length).toBe(before);
    await h.runner.tick();
    expect(h.calls.length).toBe(before + 1);
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 2, attemptNo: 1 });
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
    // The urgent number is told the chain stopped, in the chain's own mode.
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain(
      "[TEST MODE] THE ON-CALL ESCALATION STOPPED — the rotation is in test mode and the next level is not a test number",
    );
    expect(h.urgent[0]).toContain(DETAILS.reason);
    expect(h.urgentModes).toEqual(["test"]);
  });

  it("cancels a live-mode row once the process is switched to test", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer", { mode: "live" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()?.status).toBe("cancelled");
    // A live chain's patient is real: the real urgent number hears it stopped.
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/THE ON-CALL ESCALATION STOPPED/);
    expect(h.urgent[0]).not.toMatch(/\[TEST MODE\]/);
    expect(h.urgentModes).toEqual(["live"]);
  });

  it("says nothing more when another process closed the row first", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer", { mode: "test" }));
    h.store.closeEscalation = async () => null;
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.urgent).toHaveLength(0);
  });
});

describe("a level that is not in the plan", () => {
  it("closes the chain as failed and tells the urgent number, in the chain's mode", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.store.escalations.get(esc!.id)!.levelIndex = 9;
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "failed", details: null });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/THE ON-CALL ESCALATION STOPPED — its next level could not be read, so nobody else will be called/);
    expect(h.urgent[0]).toContain(DETAILS.reason);
    expect(h.urgentModes).toEqual(["live"]);
  });

  it("marks a test chain's stop as a test and sends it the test way", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    h.store.escalations.get(esc!.id)!.levelIndex = 9;
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "failed", details: null });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain("[TEST MODE] THE ON-CALL ESCALATION STOPPED — its next level could not be read");
    expect(h.urgentModes).toEqual(["test"]);
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
