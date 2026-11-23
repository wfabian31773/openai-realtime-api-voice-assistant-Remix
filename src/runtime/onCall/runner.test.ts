import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_PER_LEVEL,
  CLAIM_LEASE_MS,
  DRAIN_WINDOW_MS,
  LEVEL_RETRY_DEADLINE_MS,
  RETRY_GAP_MS,
  RING_GUARD_MS,
  STALE_ESCALATION_MS,
  SWITCHED_OFF_REASON,
  TICK_BUDGET_MS,
  MAX_LATE_TICKS,
  LATE_TICK_FORGET_MS,
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
import { levelLabel, type ChainPlan } from "./rotation";
import { ABSENT_RECHECK_MS, type RoutingFacts } from "./store";
import {
  NO_TEXT_PARAM,
  ON_CALL_ACK_PATH,
  ON_CALL_STATUS_PATH,
  PROVIDER_CALL_OPENING,
  PROVIDER_CALL_OPENING_NO_TEXT,
  ackResultOf,
  type AckReply,
} from "./providerCall";

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

function harness(
  opts: {
    config?: OnCallConfig;
    start?: Date;
    placeCall?: any;
    sendSms?: any;
    notifyUrgent?: any;
    endCall?: any;
    tickBudgetMs?: number;
    lateTickForgetMs?: number;
  } = {},
) {
  let clock = new Date(opts.start ?? WED_NIGHT);
  const now = () => new Date(clock);
  const store = createFakeOnCallStore(syntheticRotation(), now);
  const texts: Array<{ to: string; from: string; body: string; at: Date }> = [];
  const calls: Array<{ to: string; from: string; twiml: string; statusCallback: string; timeout: number; timeLimit: number; at: Date }> = [];
  const urgent: string[] = [];
  const urgentModes: string[] = [];
  const urgentPlans: Array<ChainPlan | undefined> = [];
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
    vi.fn(async (body: string, mode: string, plan?: ChainPlan) => {
      urgent.push(body);
      urgentModes.push(mode);
      urgentPlans.push(plan);
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
    ...(opts.tickBudgetMs !== undefined ? { tickBudgetMs: opts.tickBudgetMs } : {}),
    ...(opts.lateTickForgetMs !== undefined ? { lateTickForgetMs: opts.lateTickForgetMs } : {}),
  });
  return {
    store,
    runner,
    texts,
    calls,
    urgent,
    urgentModes,
    urgentPlans,
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
      // picked up and hung up with no key pressed: declined, and the chain moves on
      [1, "region_director", "call", 2, "declined"],
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

  it("answers the key press without waiting on another call's hang-up (review of #514, round 14)", async () => {
    const never = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ endCall: never });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const taking = h.lastCallAttempt();
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
    const reply = await Promise.race([
      h.runner.onProviderAck(taking.id, "1"),
      new Promise((r) => setTimeout(() => r("held"), 200)),
    ]);
    expect(reply).toBe("accepted");
    expect(h.store.attempts.get(stray.id)?.outcome).toBe("taken_elsewhere");
    // the hang-up was still asked for, only not awaited
    expect(never).toHaveBeenCalledWith("CA8".padEnd(34, "0"));
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
    let takingAnswer: AckReply | undefined;
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
    let secondAnswer: AckReply | undefined;
    vi.spyOn(h.store, "endAttempt").mockImplementation(async (id: number, outcome: any, at: Date) => {
      const row = await real(id, outcome, at);
      if (!raced && id === first.id && outcome === "accepted") {
        raced = true;
        secondAnswer = await h.runner.onProviderAck(second.id, "1");
      }
      return row;
    });
    const firstAnswer = await h.runner.onProviderAck(first.id, "1");
    // The second call was logged with no text before it, so its reply is the
    // no-text form; the race is about which call takes the patient.
    expect(ackResultOf(secondAnswer!)).toBe("accepted");
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
    let secondAnswer: AckReply | undefined;
    vi.spyOn(h.store, "endAttempt").mockImplementation(async (id: number, outcome: any, at: Date) => {
      const row = await real(id, outcome, at);
      if (!raced && id === first.id && outcome === "accepted") {
        raced = true;
        secondAnswer = await h.runner.onProviderAck(second.id, "1");
      }
      return row;
    });
    const firstAnswer = await h.runner.onProviderAck(first.id, "1");
    // The second call was logged with no text before it, so its reply is the
    // no-text form; the race is about which call takes the patient.
    expect(ackResultOf(secondAnswer!)).toBe("accepted");
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

  it("lets a key press on a call the ringing guard gave up on take the patient while the chain runs", async () => {
    // Round 1 of the review of #514 answered this press "closed". Round 10:
    // the provider pressing it is on the phone, so the press takes the
    // patient and the call ringing in its place is hung up.
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const stale = h.lastCallAttempt().id;
    h.advance(RING_GUARD_MS);
    await h.runner.tick(); // gives up on it and escalates
    expect(h.store.attempts.get(stale)?.outcome).toBe("no_status");
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1 });
    await h.runner.tick(); // rings the director
    const next = [...h.store.attempts.values()].filter((a) => a.kind === "call" && a.outcome === "in_progress");
    expect(next.map((a) => a.providerId)).toEqual([IE_DIRECTOR]);
    expect(await h.runner.onProviderAck(stale, "1")).toBe("accepted");
    expect(h.store.attempts.get(stale)?.outcome).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: stale });
    for (const a of next) expect(h.store.attempts.get(a.id)?.outcome).toBe("taken_elsewhere");
  });

  it("says closed for an attempt it does not know, or one that is not a call", async () => {
    const h = harness();
    expect(await h.runner.onProviderAck(999, "1")).toBe("closed");
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const warm = [...h.store.attempts.values()].find((a) => a.kind === "warm_transfer")!;
    expect(await h.runner.onProviderAck(warm.id, "1")).toBe("closed");
  });
});

describe("a key press on a call we had marked over (review of #514, round 10)", () => {
  it("takes the patient from a call recorded as failed, and hangs up the call ringing in its place", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    // The provider's second call. Say we recorded it failed (Twilio answered
    // the create ambiguously) while Twilio placed it after all.
    const placed = h.lastCallAttempt();
    await h.store.endAttempt(placed.id, "failed", h.now());
    // Meanwhile the chain moved on and the director's call is ringing.
    const ringing = await h.store.logAttempt({
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
    await h.store.setAttemptCallSid(ringing.id, "CA7".padEnd(34, "0"));

    expect(await h.runner.onProviderAck(placed.id, "1")).toBe("accepted");
    expect(h.store.attempts.get(placed.id)?.outcome).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: 1, acceptedAttemptId: placed.id, details: null });
    expect(h.store.attempts.get(ringing.id)?.outcome).toBe("taken_elsewhere");
    expect(h.hungUp).toEqual(["CA7".padEnd(34, "0")]);
    expect(h.log.mock.calls.some(([m]) => /recorded failed .* it takes the patient/.test(String(m)))).toBe(true);
    h.advance(RING_GUARD_MS * 2);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.urgent).toHaveLength(0);
  });

  it("takes it from a call the ringing guard or its status had already ended", async () => {
    for (const outcome of ["no_status", "no_answer", "declined", "busy"] as const) {
      const h = harness();
      const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
      h.at(esc!.nextAt!);
      await h.runner.tick();
      const id = h.lastCallAttempt().id;
      await h.store.endAttempt(id, outcome, h.now());
      expect(await h.runner.onProviderAck(id, "1")).toBe("accepted");
      expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: id });
    }
  });

  it("tells them nobody was reached in time once the chain has ended, and records nothing taken", async () => {
    // Round 13 of the review of #514: "closed" read as handled while the
    // urgent number had been told nobody took the patient.
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.store.endAttempt(id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
    expect(await h.runner.onProviderAck(id, "1")).toBe("too_late");
    expect(h.store.attempts.get(id)?.outcome).toBe("no_answer");
    expect(h.escalation()).toMatchObject({ status: "exhausted", acceptedAttemptId: null });
  });

  it("takes the patient when the key press lands between the last move's read and its close", async () => {
    // Round 15 of the review of #514: the move read no accepted attempt, the
    // key press then recorded one, and the move's close still landed, so the
    // chain read exhausted over an accepted call and the urgent number was told
    // nobody took the patient. An accept now moves the chain's version, so the
    // close loses its race and the move's next read finds the press.
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    const last = h.lastCallAttempt();
    expect(last.levelIndex).toBe(2);
    expect(last.attemptNo).toBe(2);
    const real = h.store.attemptsFor.bind(h.store);
    let pressed = false;
    h.store.attemptsFor = async (callSid) => {
      const seen = await real(callSid);
      if (!pressed && h.store.attempts.get(last.id)?.outcome === "no_answer") {
        pressed = true;
        expect(await h.store.acceptLate(last.id, h.now())).toMatchObject({ outcome: "accepted" });
      }
      return seen;
    };
    await h.runner.onProviderStatus(last.id, "no-answer");
    expect(pressed).toBe(true);
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: last.id });
    expect(h.urgent.some((u) => /NOBODY TOOK/.test(u))).toBe(false);
  });

  it("refuses a key press on a call still ringing once its chain has ended", async () => {
    // The accepted end needs the chain active, as the late accept always has.
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    const cur = h.escalation();
    const v = cur.version;
    await h.store.closeEscalation(cur.id, v, { status: "exhausted", nextAt: null });
    expect(await h.store.endAttempt(id, "accepted", h.now())).toBeNull();
    expect(h.store.attempts.get(id)?.outcome).toBe("in_progress");
    expect(h.escalation().version).toBe(v + 1);
  });

  it("is told nobody was reached in time, not taken, when the chain ends between the read and the press", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.store.endAttempt(id, "no_answer", h.now());
    const real = h.store.acceptLate.bind(h.store);
    h.store.acceptLate = async (attemptId, at) => {
      const cur = h.escalation();
      await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
      return real(attemptId, at);
    };
    expect(await h.runner.onProviderAck(id, "1")).toBe("too_late");
    expect(h.store.attempts.get(id)?.outcome).toBe("no_answer");
  });

  it("is told already taken when another call takes the patient between the read and the press", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.store.endAttempt(id, "no_answer", h.now());
    const real = h.store.acceptLate.bind(h.store);
    h.store.acceptLate = async (attemptId, at) => {
      const cur = h.escalation();
      await h.store.closeEscalation(cur.id, cur.version, {
        status: "accepted",
        acceptedBy: IE_DIRECTOR,
        acceptedAt: at,
        acceptedAttemptId: 999,
        nextAt: null,
      });
      return real(attemptId, at);
    };
    expect(await h.runner.onProviderAck(id, "1")).toBe("already_taken");
    expect(h.store.attempts.get(id)?.outcome).toBe("no_answer");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: 999 });
  });

  it("closes the chain on a second press when the first press's close did not land", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    // The first press recorded the accept; its close of the chain failed.
    await h.store.endAttempt(id, "accepted", h.now());
    expect(h.escalation()).toMatchObject({ status: "active" });
    expect(await h.runner.onProviderAck(id, "1")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: id });
  });

  it("keeps a call hung up because another took the patient as already taken", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    await h.store.endAttempt(id, "taken_elsewhere", h.now());
    expect(await h.runner.onProviderAck(id, "1")).toBe("already_taken");
    expect(h.store.attempts.get(id)?.outcome).toBe("taken_elsewhere");
    expect(h.escalation()).toMatchObject({ status: "active" });
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
    // Picked up and ended with no key pressed: the ack webhook's own reading.
    expect(outcomeForCallStatus("completed")).toBe("declined");
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
    expect(h.urgentPlans[0]?.levels.map((l) => l.phone)).toEqual(wedPlan().levels.map((l) => l.phone));
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
    // The chain's own plan goes with it, so a process switched to live in the
    // meantime still has a test number to send it to (review of #514, round 6).
    expect(h.urgentPlans[0]?.levels.map((l) => l.phone)).toEqual(syntheticTestPlan(TEST).levels.map((l) => l.phone));
  });

  it("marks a stale escalation's text as a test in test mode", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    h.at(new Date(esc!.createdAt.getTime() + STALE_ESCALATION_MS + 1));
    await h.runner.tick();
    expect(h.urgent[0]).toContain("[TEST MODE] THE ON-CALL ESCALATION STOPPED");
    expect(h.urgentModes).toEqual(["test"]);
    expect(h.urgentPlans[0]?.levels.map((l) => l.phone)).toEqual(syntheticTestPlan(TEST).levels.map((l) => l.phone));
  });

  it("opens one escalation per call and hands back the existing one, with each hand-off's call logged on it", async () => {
    const h = harness();
    const a = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const b = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    expect(b?.id).toBe(a?.id);
    expect(h.store.escalations.size).toBe(1);
    // Each hand-off rang the provider, so each call is a row on the one chain
    // (review of #514, round 8: the second used to go unlogged).
    const warm = [...h.store.attempts.values()].filter((x) => x.kind === "warm_transfer");
    expect(warm).toHaveLength(2);
    expect(new Set(warm.map((x) => x.escalationId))).toEqual(new Set([a!.id]));
  });

  // Review of #514, round 15: the hand-off no longer waits on the pre-dial
  // text's record; the runner opens the chain and logs the text when it lands.
  it("opens the chain without the pre-dial text's record, and logs the text once it lands", async () => {
    const h = harness();
    let land: (v: { ok: boolean; sid: string | null; at: Date } | null) => void = () => undefined;
    const late = new Promise<{ ok: boolean; sid: string | null; at: Date } | null>((ok) => (land = ok));
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer", { preDialSms: null, preDialSmsLate: late }));
    expect(esc?.status).toBe("active");
    const kinds = () => [...h.store.attempts.values()].map((a) => a.kind);
    expect(kinds()).toEqual(["warm_transfer"]);
    land({ ok: true, sid: "SMlate", at: WED_NIGHT });
    await vi.waitFor(() => expect(kinds()).toEqual(["warm_transfer", "sms"]));
    const sms = [...h.store.attempts.values()].find((a) => a.kind === "sms")!;
    expect(sms).toMatchObject({ outcome: "sent", smsSid: "SMlate", levelIndex: 0, attemptNo: 1, escalationId: esc!.id });
  });

  it("logs no text row when the late record never arrived", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(
      inCall(wedPlan(), "no_answer", { preDialSms: null, preDialSmsLate: Promise.resolve(null) }),
    );
    expect(esc?.status).toBe("active");
    await vi.waitFor(() =>
      expect(h.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/had no result in time; its record is not logged/),
    );
    expect([...h.store.attempts.values()].map((a) => a.kind)).toEqual(["warm_transfer"]);
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

  // Review of #514, round 9: a throw before the call is placed left the row
  // "ringing" for RING_GUARD_MS (6.5 minutes) with nobody being called.
  const linesOf = (h: ReturnType<typeof harness>) => h.log.mock.calls.map((c) => String(c[0])).join("\n");

  it("moves on at once when the call's attempt row cannot be written, and places no call", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a: any) => {
      if (a.kind === "call" && a.outcome === undefined) {
        h.store.logAttempt = realLog;
        throw new Error("hub blip");
      }
      return realLog(a);
    };
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    // Level 0's second try was its last, so the chain is at the next level, due now.
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1, attemptNo: 1, phase: "due" });
    expect(h.escalation().nextAt!.getTime()).toBeLessThanOrEqual(h.now().getTime());
    expect(linesOf(h)).toMatch(/ringing level 0 failed before its call was placed: hub blip; moving on/);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].to).toBe(phoneOf(IE_DIRECTOR));
  });

  it("retries the level when its first try cannot write the text's row", async () => {
    const h = harness();
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a: any) => {
      if (a.kind === "sms") {
        h.store.logAttempt = realLog;
        throw new Error("hub blip");
      }
      return realLog(a);
    };
    const before = h.calls.length;
    await h.runner.tick();
    expect(h.calls.length).toBe(before);
    // The first try failed before its call, so the level gets its second try
    // at the usual gap rather than at the guard.
    const e = h.escalation();
    expect(e).toMatchObject({ status: "active", levelIndex: 1, attemptNo: 2, phase: "due" });
    expect(e.nextAt!.getTime() - h.now().getTime()).toBeLessThanOrEqual(RETRY_GAP_MS);
    h.at(e.nextAt!);
    await h.runner.tick();
    expect(h.calls.length).toBe(before + 1);
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 1, attemptNo: 2, outcome: "in_progress" });
  });

  it("ends the logged call attempt as failed when the read before the call throws", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const realLog = h.store.logAttempt.bind(h.store);
    const realGet = h.store.getEscalation.bind(h.store);
    let armed = false;
    h.store.logAttempt = async (a: any) => {
      const row = await realLog(a);
      if (a.kind === "call" && a.outcome === undefined) armed = true;
      return row;
    };
    h.store.getEscalation = async (id: number) => {
      if (armed) {
        armed = false;
        throw new Error("hub blip");
      }
      return realGet(id);
    };
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 0, attemptNo: 2, outcome: "failed" });
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1, attemptNo: 1, phase: "due" });
  });

  it("does not move the chain when a step after the placed call throws", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.log.mockImplementation((line: string) => {
      if (/calling level 0/.test(String(line))) throw new Error("log sink down");
    });
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 0, attemptNo: 2, outcome: "in_progress" });
    // The call is ringing: its status callback moves the chain, nothing here.
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2, phase: "ringing" });
  });

  it("does not move a chain that moved on, even when its unplaced call cannot be ended", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a: any) => {
      const row = await realLog(a);
      if (a.kind === "call" && a.outcome === undefined) {
        // Something else touched the row while the text was being sent.
        const e = h.store.escalations.get(a.escalationId)!;
        h.store.escalations.set(e.id, { ...e, version: e.version + 1 });
      }
      return row;
    };
    h.store.endAttempt = async () => {
      throw new Error("hub blip");
    };
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 0, attemptNo: 2, phase: "ringing" });
    const lines = linesOf(h);
    expect(lines).toMatch(/could not end level 0's unplaced call: hub blip/);
    expect(lines).not.toMatch(/failed before its call was placed/);
  });

  it("moves on when a call that could not be placed also cannot be ended the first time", async () => {
    let n = 0;
    const placeCall = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("twilio said no");
      return { sid: "CA9" + "0".repeat(31) };
    });
    const h = harness({ placeCall });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const realEnd = h.store.endAttempt.bind(h.store);
    h.store.endAttempt = async (...args: Parameters<typeof realEnd>) => {
      h.store.endAttempt = realEnd;
      throw new Error("hub blip");
    };
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.lastCallAttempt()).toMatchObject({ levelIndex: 0, attemptNo: 2, outcome: "failed" });
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 1, attemptNo: 1, phase: "due" });
  });

  it("goes straight to the next level when a level with no number cannot move on the first time", async () => {
    const h = harness();
    const plan = wedPlan();
    plan.levels[1] = { ...plan.levels[1], phone: "" };
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    const realLog = h.store.logAttempt.bind(h.store);
    const realGet = h.store.getEscalation.bind(h.store);
    let armed = false;
    h.store.logAttempt = async (a: any) => {
      const row = await realLog(a);
      if (a.kind === "call" && a.dialedTo === null) armed = true;
      return row;
    };
    h.store.getEscalation = async (id: number) => {
      if (armed) {
        armed = false;
        throw new Error("hub blip");
      }
      return realGet(id);
    };
    await h.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 2, attemptNo: 1, phase: "due" });
  });

  it("stays bounded when every call attempt row fails: each level is texted at most twice, then the urgent number", async () => {
    const h = harness();
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    const realLog = h.store.logAttempt.bind(h.store);
    h.store.logAttempt = async (a: any) => {
      if (a.kind === "call" && a.outcome === undefined) throw new Error("hub down for calls");
      return realLog(a);
    };
    h.at(esc!.nextAt!);
    for (let i = 0; i < 40 && h.escalation().status === "active"; i++) {
      await h.runner.tick();
      h.advance(RETRY_GAP_MS);
    }
    expect(h.escalation().status).toBe("exhausted");
    expect(h.calls).toHaveLength(0);
    // Level 0's first text went before the in-call transfer; every other try texts once.
    expect(h.texts.length).toBe(plan.levels.length * ATTEMPTS_PER_LEVEL - 1);
    expect(h.urgent).toHaveLength(1);
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

  it("skips a test level with no phone straight to the next level, as live does, instead of cancelling", async () => {
    const h = harness({ config: TEST });
    const plan = syntheticTestPlan(TEST);
    plan.levels[1] = { ...plan.levels[1], phone: "" };
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "due" });
    const before = h.calls.length;
    await h.runner.tick(); // level 1 has no number
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 2, attemptNo: 1 });
    expect(h.urgent).toHaveLength(0);
    const level1 = [...h.store.attempts.values()].filter((a) => a.levelIndex === 1);
    expect(level1).toHaveLength(1);
    expect(level1[0]).toMatchObject({ kind: "call", outcome: "failed", dialedTo: null });
    expect(h.calls.length).toBe(before);
    await h.runner.tick();
    expect(h.calls.length).toBe(before + 1);
    expect(h.calls[h.calls.length - 1].to).toBe(TEST.testPhones[1]);
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

  it("sends a test chain's stop, after a switch to live, with the chain's own plan", async () => {
    const h = harness({ config: LIVE });
    const plan = syntheticTestPlan(TEST);
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
    expect(h.escalation()?.status).toBe("cancelled");
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain("[TEST MODE] THE ON-CALL ESCALATION STOPPED");
    expect(h.urgentModes).toEqual(["test"]);
    // The wiring sends a test chain's text to a number its own plan rang once
    // the test list is gone (review of #514, round 6), so the plan must come
    // with it.
    expect(h.urgentPlans[0]?.levels.map((l) => l.phone)).toEqual(plan.levels.map((l) => l.phone));
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
    // The chain's own plan goes with the text, so a test chain still open
    // after a switch to live can send it to a number that plan rang
    // (review of #514, round 6).
    expect(h.urgentPlans[0]?.levels.map((l) => l.phone)).toEqual(syntheticTestPlan(TEST).levels.map((l) => l.phone));
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

  it("says on level 0's reminder that the patient is still waiting and we are calling again", () => {
    const note = attemptNote({ ...base, levelIndex: 0, attemptNo: 2 });
    expect(note).toMatch(/this patient is still waiting for a provider/);
    expect(note).toMatch(/We are calling you again now/);
  });

  it("makes no claim on level 0's reminder about how the in-call transfer went (review of #514, round 14)", () => {
    // It may have rung out, been declined, or never rung at all (a dial that
    // threw after the text went out).
    const note = attemptNote({ ...base, levelIndex: 0, attemptNo: 2 });
    expect(note).not.toMatch(/not taken|missed|did not answer|declined/i);
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

  it("never says a level it passed over for having no number did not take the call", () => {
    // A director with no phone is skipped by the runner; the next level's text
    // names the one who was rung, and says the skipped one was never called
    // (review of #514, round 10).
    const skippedPlan = { ...plan, levels: plan.levels.map((l, i) => (i === 1 ? { ...l, phone: "" } : l)) };
    const note = attemptNote({ ...base, plan: skippedPlan, levelIndex: 2, attemptNo: 1 });
    const [rung, skipped] = skippedPlan.levels;
    expect(note).toContain(`ESCALATED — ${rung.name} did not take this urgent call.`);
    expect(note).toContain(`${levelLabel(skipped)} has no dialable number on file and was not called.`);
    expect(note).not.toContain(`${skipped.name} did not take`);
  });

  it("names every level passed over in a row, in order", () => {
    const four = { ...plan, levels: [...plan.levels, { ...plan.levels[2], providerId: 92, name: "Provider 92" }] };
    const skippedPlan = { ...four, levels: four.levels.map((l, i) => (i === 1 || i === 2 ? { ...l, phone: "" } : l)) };
    const note = attemptNote({ ...base, plan: skippedPlan, levelIndex: 3, attemptNo: 1 });
    expect(note).toContain(`ESCALATED — ${skippedPlan.levels[0].name} did not take this urgent call.`);
    expect(note).toContain(
      `${levelLabel(skippedPlan.levels[1])} and ${levelLabel(skippedPlan.levels[2])} have no dialable number on file and were not called.`,
    );
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

describe("one row that never answers holds no other row (review, 2026-11-23)", () => {
  const OTHER_SID = "CA00000000000000000000000000000002";
  const never = () => new Promise<never>(() => {});

  it("calls the other due row in the same tick while one row's text never answers", async () => {
    let texts = 0;
    const sendSms = vi.fn(async () => {
      texts += 1;
      if (texts === 1) return never();
      return { sid: `SM${texts}` };
    });
    const h = harness({ sendSms, tickBudgetMs: 50 });
    const plan = wedPlan();
    const a = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    const b = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { callSid: OTHER_SID }));
    h.at(new Date(Math.max(a!.nextAt!.getTime(), b!.nextAt!.getTime())));
    await h.runner.tick();
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(1);
    expect(h.log.mock.calls.some(([l]) => String(l).includes("still waiting on a send or the store"))).toBe(true);
  });

  it("lets the next tick run when one tick never settles", async () => {
    const h = harness({ sendSms: vi.fn(never), tickBudgetMs: 30 });
    const claim = vi.spyOn(h.store, "claimDue");
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(1);
    h.advance(10_000);
    await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("names the row whose step failed and still rings the other row", async () => {
    const h = harness({ tickBudgetMs: 1_000 });
    const plan = wedPlan();
    const a = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    const b = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", { callSid: OTHER_SID }));
    const update = h.store.updateEscalation.bind(h.store);
    vi.spyOn(h.store, "updateEscalation").mockImplementation(async (id, version, patch) => {
      if (id === a!.id) throw new Error("store write refused");
      return update(id, version, patch);
    });
    h.at(new Date(Math.max(a!.nextAt!.getTime(), b!.nextAt!.getTime())));
    await h.runner.tick();
    expect(h.calls).toHaveLength(1);
    const lines = h.log.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes(`${a!.callSid}: step failed: store write refused`))).toBe(true);
    expect(lines.some((l) => l.includes("tick failed"))).toBe(false);
  });

  // Review of #514, round 9: under a stalled store every tick started another
  // claim beside the ones still hanging.
  it("stops claiming while three ticks are still waiting, and claims again when one answers", async () => {
    const h = harness({ tickBudgetMs: 20 });
    const claimDue = h.store.claimDue.bind(h.store);
    const hung: Array<() => void> = [];
    const claim = vi.spyOn(h.store, "claimDue").mockImplementation(async (...args) => {
      if (hung.length < MAX_LATE_TICKS) {
        await new Promise<void>((res) => hung.push(res));
      }
      return claimDue(...args);
    });
    for (let i = 0; i < MAX_LATE_TICKS; i++) await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS);
    await h.runner.tick();
    await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS);
    const paused = h.log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("no new rows are claimed"));
    expect(paused).toHaveLength(1);
    hung[0]();
    await vi.waitFor(async () => {
      await h.runner.tick();
      expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS + 1);
    });
  });

  it("says so again when claiming pauses a second time", async () => {
    const h = harness({ tickBudgetMs: 20 });
    const claimDue = h.store.claimDue.bind(h.store);
    const hung: Array<() => void> = [];
    vi.spyOn(h.store, "claimDue").mockImplementation(async (...args) => {
      if (hung.length < MAX_LATE_TICKS + 1) {
        await new Promise<void>((res) => hung.push(res));
      }
      return claimDue(...args);
    });
    const pauses = () => h.log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("no new rows are claimed"));
    for (let i = 0; i < MAX_LATE_TICKS; i++) await h.runner.tick();
    await h.runner.tick();
    expect(pauses()).toHaveLength(1);
    hung[0]();
    await vi.waitFor(async () => {
      await h.runner.tick();
      expect(hung).toHaveLength(MAX_LATE_TICKS + 1);
    });
    await h.runner.tick();
    expect(pauses()).toHaveLength(2);
  });

  it("still lets the next tick claim while fewer than three ticks are late", async () => {
    const h = harness({ tickBudgetMs: 20 });
    const claim = vi.spyOn(h.store, "claimDue").mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < MAX_LATE_TICKS; i++) await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS);
  });

  it("forgets a late tick that never answers, so the chain is not stopped for good", async () => {
    const h = harness({ tickBudgetMs: 20, lateTickForgetMs: 60 });
    const claim = vi.spyOn(h.store, "claimDue").mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < MAX_LATE_TICKS; i++) await h.runner.tick();
    await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS);
    await new Promise((r) => setTimeout(r, 80));
    await h.runner.tick();
    expect(claim).toHaveBeenCalledTimes(MAX_LATE_TICKS + 1);
  });

  it("forgets a late tick no sooner than the ringing guard", () => {
    expect(MAX_LATE_TICKS).toBeGreaterThanOrEqual(2);
    expect(LATE_TICK_FORGET_MS).toBeGreaterThan(TICK_BUDGET_MS);
    expect(LATE_TICK_FORGET_MS).toBeLessThanOrEqual(RING_GUARD_MS);
  });

  it("gives up waiting on a tick before its rows' lease runs out", () => {
    expect(TICK_BUDGET_MS).toBeLessThan(CLAIM_LEASE_MS);
    expect(CLAIM_LEASE_MS - TICK_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("does not call a level the chain has left while that level's text was being sent", async () => {
    let release: (v: { sid: string }) => void = () => {};
    let held = true;
    const texts: string[] = [];
    const sendSms = vi.fn(async (m: { to: string; body: string }) => {
      texts.push(m.to);
      if (!held) return { sid: `SM${texts.length}` };
      return new Promise<{ sid: string }>((res) => {
        release = res;
      });
    });
    const h = harness({ sendSms, tickBudgetMs: 30 });
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    // Level 0's second call: the text hangs, so the call is not placed yet.
    expect(texts).toEqual([plan.levels[0].phone]);
    expect(h.calls).toHaveLength(0);
    // The ringing guard passes and the chain moves on to the director.
    held = false;
    h.advance(RING_GUARD_MS + 1_000);
    await h.runner.tick();
    const moved = h.escalation();
    expect(moved.levelIndex).toBe(1);
    // The hung text now answers: level 0 must not be called.
    release({ sid: "SMlate" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.filter((c) => c.to === plan.levels[0].phone)).toHaveLength(0);
    const stale = [...h.store.attempts.values()].filter(
      (a) => a.kind === "call" && a.levelIndex === 0 && a.attemptNo === 2,
    );
    expect(stale.every((a) => a.outcome === "failed" && a.providerCallSid == null)).toBe(true);
    const lines = h.log.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes("chain moved on while level 0's text was being sent"))).toBe(true);
  });

  it("still places the call when nothing touched the row while its text was sent", async () => {
    const h = harness();
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls.map((c) => c.to)).toEqual([plan.levels[0].phone]);
    const lines = h.log.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes("chain moved on"))).toBe(false);
  });

  it("does not ring a row twice when its lease runs out under a step still in flight", async () => {
    const h = harness({ sendSms: vi.fn(never), tickBudgetMs: 30 });
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    // The hung step wrote "ringing" before it sent, so the row is not due again
    // until the ringing guard, whatever the lease says.
    h.advance(CLAIM_LEASE_MS + 1_000);
    await h.runner.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.escalation()).toMatchObject({ phase: "ringing" });
  });

  it("texts and calls once when a step stalls before its ringing write past the budget and the lease (review of #514, round 8)", async () => {
    // The step stalls in its first store read, before anything is sent. The
    // tick gives up on it at the budget, the lease runs out, and a later tick
    // claims the row again (a new version) and rings it. When the stalled read
    // answers, its ringing write is against the old version and lands
    // nothing, so it sends nothing.
    const h = harness({ tickBudgetMs: 30 });
    const plan = wedPlan();
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    const attemptsFor = h.store.attemptsFor.bind(h.store);
    let release: () => void = () => {};
    let stalls = 1;
    vi.spyOn(h.store, "attemptsFor").mockImplementation(async (sid) => {
      if (stalls-- > 0) await new Promise<void>((res) => (release = res));
      return attemptsFor(sid);
    });
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.texts).toHaveLength(0);
    h.advance(CLAIM_LEASE_MS + 1_000);
    await h.runner.tick();
    expect(h.texts.map((t) => t.to)).toEqual([plan.levels[0].phone]);
    expect(h.calls.map((c) => c.to)).toEqual([plan.levels[0].phone]);
    release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.texts).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.escalation()).toMatchObject({ phase: "ringing", attemptNo: 2 });
  });
});

describe("a second hand-off on a call whose chain is already open (review of #514, round 8)", () => {
  // Reached when the call's chain claim was released after HANDOFF_SETTLE_MS
  // while the first hand-off was still writing, and a second escalation rang
  // level 0 again. The second hand-off opens nothing.
  const kinds = (h: ReturnType<typeof harness>, escalationId: number) =>
    [...h.store.attempts.values()].filter((a) => a.escalationId === escalationId).map((a) => `${a.kind}:${a.outcome}`);

  it("answers the open chain while it is paging, opens no second row, and logs its text and call on that chain", async () => {
    const h = harness();
    const plan = wedPlan();
    const first = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    const second = await h.runner.afterInCallTransfer(inCall(plan, "busy"));
    expect(h.store.escalations.size).toBe(1);
    expect(second).toMatchObject({ id: first!.id, status: "active" });
    expect(kinds(h, first!.id)).toEqual(["sms:sent", "warm_transfer:no_answer", "sms:sent", "warm_transfer:busy"]);
    const lines = h.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toMatch(/this call's chain was already open \(escalation \d+\); this hand-off opened nothing/);
  });

  it("does not answer a chain somebody has already taken as carrying on; it closes it", async () => {
    const h = harness();
    const plan = wedPlan();
    const first = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    // A taken attempt whose close never landed: the row still reads active.
    const taken = await h.store.logAttempt({
      escalationId: first!.id,
      callSid: SID,
      levelIndex: 0,
      role: "on_call",
      providerId: null,
      kind: "call",
      attemptNo: 2,
      mode: "live",
      dialedTo: plan.levels[0].phone,
      outcome: "accepted",
      endedAt: h.now(),
    });
    expect(h.escalation().status).toBe("active");
    const second = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(second?.status).toBe("accepted");
    expect(second?.acceptedAttemptId).toBe(taken.id);
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: taken.id });
  });

  it("closes the open chain on this hand-off's call when this provider took the patient, and hangs up the chain's ringing call", async () => {
    const h = harness();
    const plan = wedPlan();
    const first = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.at(first!.nextAt!);
    await h.runner.tick(); // the chain's own retry is ringing
    const ringing = h.lastCallAttempt();
    expect(ringing.outcome).toBe("in_progress");
    const second = await h.runner.afterInCallTransfer(inCall(plan, "accepted"));
    const warm = [...h.store.attempts.values()].filter((a) => a.kind === "warm_transfer").pop()!;
    expect(warm.outcome).toBe("accepted");
    expect(second).toMatchObject({ id: first!.id, status: "accepted", acceptedAttemptId: warm.id });
    expect(h.store.attempts.get(ringing.id)?.outcome).toBe("taken_elsewhere");
    expect(h.hungUp).toEqual([ringing.providerCallSid]);
  });

  it("brings the open chain due when this hand-off's call was taken and the close cannot land, so the next tick closes it", async () => {
    const h = harness();
    const plan = wedPlan();
    const first = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(first!.nextAt!.getTime()).toBeGreaterThan(h.now().getTime());
    const realClose = h.store.closeEscalation.bind(h.store);
    h.store.closeEscalation = async () => null; // every close loses its race
    await h.runner.afterInCallTransfer(inCall(plan, "accepted"));
    const warm = [...h.store.attempts.values()].filter((a) => a.kind === "warm_transfer").pop()!;
    expect(warm.outcome).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "active" });
    expect(h.escalation().nextAt!.getTime()).toBeLessThanOrEqual(h.now().getTime());
    h.store.closeEscalation = realClose;
    const callsBefore = h.calls.length;
    await h.runner.tick();
    expect(h.calls).toHaveLength(callsBefore);
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: warm.id });
  });

  it("answers a finished chain as it is, still logging this hand-off's attempts on it", async () => {
    const h = harness();
    const plan = wedPlan();
    const first = await h.runner.afterInCallTransfer(inCall(plan, "accepted"));
    expect(first?.status).toBe("accepted");
    const second = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(second?.status).toBe("accepted");
    expect(kinds(h, first!.id)).toEqual(["sms:sent", "warm_transfer:accepted", "sms:sent", "warm_transfer:no_answer"]);
  });

  it("does not text the urgent number that the escalation could not start when its attempts cannot be logged on the open chain", async () => {
    const h = harness();
    const plan = wedPlan();
    await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.store.logAttempt = async () => {
      throw new Error("hub blip");
    };
    const second = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(second).toBeNull();
    expect(h.urgent).toEqual([]);
    expect(h.escalation().status).toBe("active");
    const lines = h.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toMatch(/is open; this hand-off's attempts may be missing/);
  });

  it("still closes the open chain when this hand-off's call was taken and its attempts cannot be logged", async () => {
    const h = harness();
    const plan = wedPlan();
    await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    h.store.logAttempt = async () => {
      throw new Error("hub blip");
    };
    await h.runner.afterInCallTransfer(inCall(plan, "accepted"));
    expect(h.escalation().status).toBe("accepted");
    expect(h.urgent).toEqual([]);
  });

  it("opens nothing and answers nothing when the open fails to land and no row is on record", async () => {
    const h = harness();
    const plan = wedPlan();
    h.store.openEscalation = async () => null;
    const r = await h.runner.afterInCallTransfer(inCall(plan, "no_answer"));
    expect(r).toBeNull();
    expect(h.store.attempts.size).toBe(0);
  });
});

describe("a provider call whose text did not send (review of #514, round 12)", () => {
  /** Texts fail to `failTo`; every other text sends and is recorded. */
  function failingTextsTo(failTo: string[]) {
    let n = 0;
    const sent: Array<{ to: string; body: string }> = [];
    const sendSms = vi.fn(async (m: { to: string; from: string; body: string }) => {
      if (failTo.includes(m.to)) throw new Error("sms down");
      sent.push(m);
      return { sid: `SMX${++n}` };
    });
    return { sendSms, sent };
  }

  /** Walk to the region director's first call. */
  async function toLevelOne(h: ReturnType<typeof harness>, over: Partial<InCallTransferResult> = {}) {
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer", over));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    return h.lastCallAttempt();
  }

  it("does not tell the director the details are in a text that failed, and reads the number on a key press", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const call = await toLevelOne(h);
    expect(call.dialedTo).toBe(phoneOf(IE_DIRECTOR));
    const twiml = h.calls[h.calls.length - 1].twiml;
    expect(twiml).toContain(PROVIDER_CALL_OPENING_NO_TEXT);
    expect(twiml).not.toContain(PROVIDER_CALL_OPENING);
    expect(twiml).toContain(`${NO_TEXT_PARAM}=0`);
    // the call itself still carries nothing about the patient
    expect(twiml).not.toMatch(/5550199999/);
    const reply = await h.runner.onProviderAck(call.id, "1");
    expect(reply).toEqual({ result: "accepted", noText: true, callbackNumber: DETAILS.callbackNumber });
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: IE_DIRECTOR, details: null });
  });

  it("keeps the usual opening when an earlier text on the chain reached the same number", async () => {
    // The pre-dial text reached the on-call provider; the reminder before
    // their second call failed. They hold the details.
    const { sendSms } = failingTextsTo([phoneOf(1)]);
    const h = harness({ sendSms });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const nudge = [...h.store.attempts.values()].find((a) => a.kind === "nudge_sms");
    expect(nudge?.outcome).toBe("send_failed");
    const twiml = h.calls[0].twiml;
    expect(twiml).toContain(PROVIDER_CALL_OPENING);
    expect(twiml).not.toContain(`${NO_TEXT_PARAM}=0`);
    expect(await h.runner.onProviderAck(h.lastCallAttempt().id, "1")).toBe("accepted");
  });

  it("uses the no-text opening when the pre-dial text and the reminder both failed", async () => {
    const { sendSms } = failingTextsTo([phoneOf(1)]);
    const h = harness({ sendSms });
    const esc = await h.runner.afterInCallTransfer(
      inCall(wedPlan(), "no_answer", { preDialSms: { ok: false, error: "sms down", at: WED_NIGHT } as any }),
    );
    h.at(esc!.nextAt!);
    await h.runner.tick();
    expect(h.calls[0].twiml).toContain(PROVIDER_CALL_OPENING_NO_TEXT);
    expect(await h.runner.onProviderAck(h.lastCallAttempt().id, "1")).toEqual({
      result: "accepted",
      noText: true,
      callbackNumber: DETAILS.callbackNumber,
    });
  });

  it("counts a reminder text that reached the director after their first text failed", async () => {
    // Only the director's first text fails; the reminder before their second
    // call carries the details and sends.
    let failed = false;
    const base = failingTextsTo([]);
    const sendSms = vi.fn(async (m: { to: string; from: string; body: string }) => {
      if (!failed && m.to === phoneOf(IE_DIRECTOR)) {
        failed = true;
        throw new Error("sms down");
      }
      return base.sendSms(m);
    });
    const h = harness({ sendSms });
    const first = await toLevelOne(h);
    expect(h.calls[h.calls.length - 1].twiml).toContain(PROVIDER_CALL_OPENING_NO_TEXT);
    await h.runner.onProviderStatus(first.id, "no-answer");
    h.at(h.escalation()!.nextAt!);
    await h.runner.tick();
    const second = h.lastCallAttempt();
    expect(second.id).not.toBe(first.id);
    expect(second.dialedTo).toBe(phoneOf(IE_DIRECTOR));
    const nudge = [...h.store.attempts.values()].find(
      (a) => a.kind === "nudge_sms" && a.dialedTo === phoneOf(IE_DIRECTOR),
    );
    expect(nudge?.outcome).toBe("sent");
    expect(h.calls[h.calls.length - 1].twiml).toContain(PROVIDER_CALL_OPENING);
    expect(await h.runner.onProviderAck(second.id, "1")).toBe("accepted");
  });

  it("reads the callback number the caller gave before the caller ID", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const call = await toLevelOne(h, { details: { ...DETAILS, callbackNumber: "+15550177777" } });
    expect(await h.runner.onProviderAck(call.id, "1")).toMatchObject({ callbackNumber: "+15550177777" });
  });

  it("falls back to the caller ID when the caller gave no callback number", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const { callbackNumber: _drop, ...noNumber } = DETAILS;
    const call = await toLevelOne(h, { details: noNumber, callerNumber: "+15550166666" });
    expect(await h.runner.onProviderAck(call.id, "1")).toMatchObject({ callbackNumber: "+15550166666" });
  });

  it("answers with no number when neither is known", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const { callbackNumber: _drop, ...noNumber } = DETAILS;
    const call = await toLevelOne(h, { details: noNumber, callerNumber: null });
    expect(await h.runner.onProviderAck(call.id, "1")).toEqual({ result: "accepted", noText: true, callbackNumber: null });
  });

  it("reads the number when whether a text was sent cannot be read", async () => {
    const h = harness();
    const call = await toLevelOne(h);
    // The read that hangs up the other calls succeeds; the next read, the
    // one that asks whether a text reached this number, fails.
    const real = h.store.attemptsFor.bind(h.store);
    let afterTaken = 0;
    vi.spyOn(h.store, "attemptsFor").mockImplementation(async (sid: string) => {
      if (h.escalation()?.status === "accepted" && ++afterTaken === 2) throw new Error("hub down");
      return real(sid);
    });
    expect(await h.runner.onProviderAck(call.id, "1")).toEqual({
      result: "accepted",
      noText: true,
      callbackNumber: DETAILS.callbackNumber,
    });
    expect(h.log.mock.calls.some(([l]) => /could not read whether the details text was sent/.test(String(l)))).toBe(true);
  });

  it("uses the no-text opening when the text failed and the earlier texts cannot be read", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    // Only the read that follows the failed text to the director fails.
    const real = h.store.attemptsFor.bind(h.store);
    let textFailed = false;
    (sendSms as any).mockImplementationOnce(async () => {
      textFailed = true;
      throw new Error("sms down");
    });
    vi.spyOn(h.store, "attemptsFor").mockImplementation(async (sid: string) => {
      if (textFailed) {
        textFailed = false;
        throw new Error("hub down");
      }
      return real(sid);
    });
    await h.runner.tick();
    expect(h.calls[h.calls.length - 1].to).toBe(phoneOf(IE_DIRECTOR));
    expect(h.calls[h.calls.length - 1].twiml).toContain(PROVIDER_CALL_OPENING_NO_TEXT);
    expect(h.log.mock.calls.some(([l]) => /could not read level 1's earlier texts/.test(String(l)))).toBe(true);
  });

  it("reads the number again to a second key press from the call that took the patient", async () => {
    const { sendSms } = failingTextsTo([phoneOf(IE_DIRECTOR)]);
    const h = harness({ sendSms });
    const call = await toLevelOne(h);
    await h.runner.onProviderAck(call.id, "1");
    expect(h.escalation()?.details).toBeNull();
    // The escalation has closed and cleared its details: the second answer
    // can name no number, and must not claim a text either.
    const again = await h.runner.onProviderAck(call.id, "1");
    expect(again).toMatchObject({ result: "accepted", noText: true });
  });
});

describe("a key press after the chain ended with nobody taking the patient (review of #514, round 13)", () => {
  /** Walk to level 0's callback, mark it no-answer and close the chain as `status`. */
  async function endedChain(status: "exhausted" | "failed" | "cancelled", sendSms?: any) {
    const h = harness(sendSms ? { sendSms } : {});
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status, nextAt: null });
    return { h, call };
  }

  it("answers too_late for every way a chain ends without a taker", async () => {
    for (const status of ["exhausted", "failed", "cancelled"] as const) {
      const { h, call } = await endedChain(status);
      expect(await h.runner.onProviderAck(call.id, "1")).toBe("too_late");
      expect(h.escalation()).toMatchObject({ status, acceptedAttemptId: null });
    }
  });

  it("tells the urgent number once, naming the level and the conversation, not the patient", async () => {
    const { h, call } = await endedChain("exhausted");
    const before = h.urgent.length;
    await h.runner.onProviderAck(call.id, "1");
    await h.runner.onProviderAck(call.id, "1");
    expect(h.urgent.length - before).toBe(1);
    const update = h.urgent[h.urgent.length - 1];
    expect(update).toContain("pressed a key on our call after this patient's on-call escalation had ended");
    expect(update).toContain(levelLabel(h.escalation().plan.levels[call.levelIndex]));
    expect(update).toContain(call.callSid);
    expect(update).not.toContain(DETAILS.patientFirstName);
    expect(update).not.toContain(DETAILS.reason);
    expect(update).not.toMatch(/5550199999/);
  });

  it("marks a test-mode chain's update as a test", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
    expect(await h.runner.onProviderAck(call.id, "1")).toBe("too_late");
    expect(h.urgent[h.urgent.length - 1]).toMatch(/^\[TEST MODE\] UPDATE /);
  });

  it("points at no text when no details text reached that number", async () => {
    // The director's texts fail; walk to the director's call, then end the chain.
    const sendSms = vi.fn(async (m: { to: string }) => {
      if (m.to === phoneOf(IE_DIRECTOR)) throw new Error("sms down");
      return { sid: "SMX1" };
    });
    const h = harness({ sendSms });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    const call = h.lastCallAttempt();
    expect(call.dialedTo).toBe(phoneOf(IE_DIRECTOR));
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
    expect(await h.runner.onProviderAck(call.id, "1")).toEqual({ result: "too_late", noText: true });
  });

  it("points at no text when the texts cannot be read", async () => {
    const { h, call } = await endedChain("exhausted");
    h.store.attemptsFor = async () => {
      throw new Error("db down");
    };
    expect(await h.runner.onProviderAck(call.id, "1")).toEqual({ result: "too_late", noText: true });
  });

  it("answers a late key press without waiting on the update text (review of #514, round 14)", async () => {
    // A send that never settles must not hold the reply past Twilio's
    // webhook timeout: the provider is on the line waiting for it.
    const never = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ notifyUrgent: never });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
    const before = never.mock.calls.length;
    const reply = await Promise.race([
      h.runner.onProviderAck(call.id, "1"),
      new Promise((r) => setTimeout(() => r("held"), 200)),
    ]);
    expect(reply).toBe("too_late");
    // the update was still sent, only not awaited
    expect(never.mock.calls.length).toBe(before + 1);
  });

  it("still says closed, and tells nobody, when no key was pressed", async () => {
    const { h, call } = await endedChain("exhausted");
    const before = h.urgent.length;
    expect(await h.runner.onProviderAck(call.id, "")).toBe("closed");
    expect(h.urgent.length).toBe(before);
  });

  it("still says already taken to a call that did not take an accepted chain", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, {
      status: "accepted",
      acceptedBy: IE_DIRECTOR,
      acceptedAt: h.now(),
      acceptedAttemptId: null,
      nextAt: null,
    });
    const before = h.urgent.length;
    expect(await h.runner.onProviderAck(call.id, "1")).toBe("already_taken");
    expect(h.urgent.length).toBe(before);
  });

  it("does not let a failed update text stop the reply", async () => {
    const notifyUrgent = vi.fn(async () => {
      throw new Error("twilio down");
    });
    const h = harness({ notifyUrgent });
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    await h.store.endAttempt(call.id, "no_answer", h.now());
    const cur = h.escalation();
    await h.store.closeEscalation(cur.id, cur.version, { status: "exhausted", nextAt: null });
    expect(await h.runner.onProviderAck(call.id, "1")).toBe("too_late");
  });
});

describe("the rotation switched off while a chain was open (review of #514, round 15)", () => {
  /** A runner on the same store as `h` that only finishes the chains left open. */
  function drainerFor(h: ReturnType<typeof harness>) {
    const sendSms = vi.fn(async () => {
      throw new Error("a draining runner sends nothing");
    });
    const placeCall = vi.fn(async () => {
      throw new Error("a draining runner calls nobody");
    });
    const log = vi.fn();
    const runner = createOnCallRunner({
      store: h.store,
      config: { mode: "off", testPhones: [], callerId: LIVE.callerId, requireKept: false },
      host: "voice.example.test",
      sendSms,
      placeCall,
      notifyUrgent: h.notifyUrgent,
      endCall: h.endCall,
      now: h.now,
      log,
      draining: true,
    });
    const lines = () => log.mock.calls.map((c) => String(c[0]));
    return { runner, sendSms, placeCall, log, lines };
  }
  const stopped = (lines: string[]) => lines.filter((l) => /the drain stops/.test(l));

  it("closes a chain that comes due instead of ringing it, and tells the urgent number once", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const d = drainerFor(h);
    h.at(esc!.nextAt!);
    await d.runner.tick();
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.placeCall).not.toHaveBeenCalled();
    expect(h.escalation()).toMatchObject({ status: "cancelled", nextAt: null, details: null, callerNumber: null });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain(`THE ON-CALL ESCALATION STOPPED — ${SWITCHED_OFF_REASON}`);
    expect(h.urgent[0]).toContain(DETAILS.reason);
    expect(h.urgentModes).toEqual(["live"]);
    await d.runner.tick();
    expect(h.urgent).toHaveLength(1);
  });

  it("marks a test chain's switch-off text as a test", async () => {
    const h = harness({ config: TEST });
    const esc = await h.runner.afterInCallTransfer(inCall(syntheticTestPlan(TEST), "no_answer", { mode: "test" }));
    const d = drainerFor(h);
    h.at(esc!.nextAt!);
    await d.runner.tick();
    expect(h.urgent[0]).toContain(`[TEST MODE] THE ON-CALL ESCALATION STOPPED — ${SWITCHED_OFF_REASON}`);
    expect(h.urgentModes).toEqual(["test"]);
  });

  it("ends a call's attempt on its status and closes the chain instead of ringing the next level", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    const d = drainerFor(h);
    await d.runner.onProviderStatus(id, "no-answer");
    expect(h.store.attempts.get(id)?.outcome).toBe("no_answer");
    expect(h.escalation()).toMatchObject({ status: "cancelled", levelIndex: 0 });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain(SWITCHED_OFF_REASON);
    h.advance(RETRY_GAP_MS);
    await d.runner.tick();
    expect(d.placeCall).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it("closes the chain instead of the level's second call", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick(); // the region director's first call
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 1, phase: "ringing" });
    const d = drainerFor(h);
    await d.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(h.escalation()).toMatchObject({ status: "cancelled", levelIndex: 1, attemptNo: 1 });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toContain(SWITCHED_OFF_REASON);
  });

  it("still ends the last call of the last level as nobody took it", async () => {
    const h = harness({ start: SD_WEEK_NIGHT });
    const plan = planAt(SD_WEEK_NIGHT, syntheticRotation());
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "no_answer", {}, SD_WEEK_NIGHT));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    expect(h.escalation()).toMatchObject({ levelIndex: 1, attemptNo: 2, phase: "ringing" });
    const d = drainerFor(h);
    await d.runner.onProviderStatus(h.lastCallAttempt().id, "no-answer");
    expect(h.escalation()).toMatchObject({ status: "exhausted" });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/NOBODY TOOK THIS URGENT CALL/);
    expect(h.urgent[0]).not.toContain(SWITCHED_OFF_REASON);
  });

  it("lets a key press on the open chain take the patient", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const id = h.lastCallAttempt().id;
    const d = drainerFor(h);
    expect(await d.runner.onProviderAck(id, "1")).toBe("accepted");
    expect(h.store.attempts.get(id)?.outcome).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedAttemptId: id });
    expect(h.urgent).toHaveLength(0);
    await d.runner.tick();
    expect(d.placeCall).not.toHaveBeenCalled();
  });

  it("hangs up a call whose status never came back, and closes the chain", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    const call = h.lastCallAttempt();
    const d = drainerFor(h);
    h.advance(RING_GUARD_MS);
    await d.runner.tick();
    expect(h.store.attempts.get(call.id)?.outcome).toBe("no_status");
    expect(h.hungUp).toEqual([call.providerCallSid]);
    expect(h.escalation()).toMatchObject({ status: "cancelled" });
    expect(h.urgent).toHaveLength(1);
    expect(d.placeCall).not.toHaveBeenCalled();
  });

  it("opens no chain", async () => {
    const h = harness();
    const d = drainerFor(h);
    expect(await d.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"))).toBeNull();
    expect(h.store.escalations.size).toBe(0);
    expect(h.store.attempts.size).toBe(0);
  });

  it("stops for good once no chain is open", async () => {
    const h = harness();
    const d = drainerFor(h);
    const available = vi.spyOn(h.store, "available");
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual(["[ON-CALL] the rotation is off: no chain is still open; the drain stops"]);
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.advance(10 * 60_000);
    await d.runner.tick();
    expect(available).toHaveBeenCalledTimes(1);
    expect(h.escalation()).toMatchObject({ status: "active" });
  });

  it("keeps ticking while a chain is open, and stops once it closes", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const d = drainerFor(h);
    await d.runner.tick(); // not due yet
    expect(stopped(d.lines())).toEqual([]);
    expect(h.escalation()).toMatchObject({ status: "active" });
    h.at(esc!.nextAt!);
    await d.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "cancelled" });
    expect(stopped(d.lines())).toEqual([]);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual(["[ON-CALL] the rotation is off: no chain is still open; the drain stops"]);
  });

  it("does not stop on one answer that the tables are not there, only past the store's re-check", async () => {
    const h = harness();
    const d = drainerFor(h);
    h.store.tablesPresent = false;
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([]);
    h.advance(ABSENT_RECHECK_MS);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([]);
    h.advance(1);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([
      "[ON-CALL] the rotation is off: the on-call tables are not on the Hub, so no chain can be open; the drain stops",
    ]);
  });

  it("starts the re-check over when the tables answer in between", async () => {
    const h = harness();
    const esc = await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    const d = drainerFor(h);
    h.store.tablesPresent = false;
    await d.runner.tick();
    h.advance(ABSENT_RECHECK_MS - 60_000);
    h.store.tablesPresent = true;
    await d.runner.tick(); // a chain is open, and not yet due
    h.store.tablesPresent = false;
    h.advance(2 * 60_000);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([]);
    h.store.tablesPresent = true;
    h.at(esc!.nextAt!.getTime() > h.now().getTime() ? esc!.nextAt! : h.now());
    await d.runner.tick();
    expect(h.escalation()).toMatchObject({ status: "cancelled" });
  });

  it("stops after the drain window with a chain still open that nothing would move", async () => {
    const h = harness();
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    // A chain no claim can reach.
    h.store.escalations.get(h.escalation().id)!.nextAt = null;
    const d = drainerFor(h);
    await d.runner.tick();
    h.advance(DRAIN_WINDOW_MS);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([]);
    h.advance(1);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([
      "[ON-CALL] the rotation is off: a chain is still open after the drain window; nothing left would move it; the drain stops",
    ]);
  });

  it("measures the drain window from its first tick", async () => {
    const h = harness();
    await h.runner.afterInCallTransfer(inCall(wedPlan(), "no_answer"));
    h.store.escalations.get(h.escalation().id)!.nextAt = null;
    const d = drainerFor(h);
    h.advance(DRAIN_WINDOW_MS + 60_000);
    await d.runner.tick();
    expect(stopped(d.lines())).toEqual([]);
  });

  it("clears its timer when it stops, and does not start again", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const d = drainerFor(h);
      const available = vi.spyOn(h.store, "available");
      d.runner.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(available).toHaveBeenCalledTimes(1);
      expect(stopped(d.lines())).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      d.runner.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(available).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
