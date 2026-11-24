/**
 * THE OPERATIONS FALLBACK (Wayne) — operator, 2026-11-24: after the final
 * director, call Wayne, via ON_CALL_FINAL_FALLBACK_NUMBER, with the same
 * cadence as every level. Unset or unusable, the chain is exactly as before.
 */
import { describe, expect, it, vi } from "vitest";
import { onCallHealth, readFinalFallback, readOnCallConfig, type OnCallConfig } from "./config";
import { decideRoute, syntheticTestPlan, type RouteInput } from "./routing";
import {
  levelLabel,
  noNumberNote,
  OPERATIONS_FALLBACK_PROVIDER_ID,
  withOperationsFallback,
  type ChainPlan,
  type RotationData,
} from "./rotation";
import { FINAL_DIRECTOR, IE_DIRECTOR, LA_DIRECTOR, provider, syntheticRotation } from "./testRotation";
import { RETRY_GAP_MS, createOnCallRunner, type InCallTransferResult } from "./runner";
import { createFakeOnCallStore } from "./store.fake";
import type { RoutingFacts } from "./store";

const WAYNE = "+15550177777";
const BASE = { TWILIO_PHONE_NUMBER: "+15550000001" };

const LIVE: OnCallConfig = { mode: "live", testPhones: [], callerId: "+15550000000", requireKept: false };
const LIVE_FB: OnCallConfig = { ...LIVE, finalFallbackPhone: WAYNE };
const TEST_FB: OnCallConfig = {
  mode: "test",
  testPhones: ["+15550100001", "+15550100002", "+15550100003", "+15550100004"],
  callerId: "+15550000000",
  requireKept: false,
  finalFallbackPhone: WAYNE,
};

// Wed 2026-12-02 22:30 PT, week of 12-01: provider 1 (Inland Empire) on call.
const WED_NIGHT = new Date("2026-12-03T06:30:00Z");
const WED_DAY = new Date("2026-12-02T18:00:00Z");
const PERSON = "00000000-0000-4000-8000-000000000001";

function input(over: Partial<RouteInput> & { data?: RotationData } = {}): RouteInput {
  const data = over.data ?? syntheticRotation();
  return {
    at: WED_NIGHT,
    config: LIVE_FB,
    store: { available: async () => true, loadRotation: async () => data },
    rotation: { get: async () => data },
    personId: undefined,
    consoleQuery: null,
    ...over,
  };
}

const levels = (d: Awaited<ReturnType<typeof decideRoute>>) =>
  d.kind === "rotation" ? d.plan.levels.map((l) => [l.role, l.providerId, l.phone]) : null;

const phoneOf = (id: number) => provider(id, "x").phone;

describe("ON_CALL_FINAL_FALLBACK_NUMBER", () => {
  it("is absent when unset, in every mode", () => {
    for (const mode of ["live", "test"]) {
      const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: mode, ON_CALL_TEST_PHONES: "+15550100001" });
      expect(c.finalFallbackPhone).toBeUndefined();
      expect(c.finalFallbackProblem).toBeUndefined();
    }
  });

  it("is read as E.164, from ten digits too", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_FINAL_FALLBACK_NUMBER: "555 017 7777" });
    expect(c.finalFallbackPhone).toBe(WAYNE);
    const t = readOnCallConfig({
      ...BASE,
      ON_CALL_ROTATION_MODE: "test",
      ON_CALL_TEST_PHONES: "+15550100001",
      ON_CALL_FINAL_FALLBACK_NUMBER: WAYNE,
    });
    expect(t.finalFallbackPhone).toBe(WAYNE);
  });

  it("leaves the fallback out, and keeps the rotation running, when it is not a phone number", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_FINAL_FALLBACK_NUMBER: "wayne" });
    expect(c.mode).toBe("live");
    expect(c.finalFallbackPhone).toBeUndefined();
    expect(c.finalFallbackProblem).toMatch(/not a phone number/);
  });

  it("leaves the fallback out when it is the rotation's own caller ID", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_FINAL_FALLBACK_NUMBER: "+15550000001" });
    expect(c.mode).toBe("live");
    expect(c.finalFallbackPhone).toBeUndefined();
    expect(c.finalFallbackProblem).toMatch(/caller ID/);
  });

  it("is not read in off mode, but the admin preview can read it", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_FINAL_FALLBACK_NUMBER: WAYNE });
    expect(c.mode).toBe("off");
    expect(c.finalFallbackPhone).toBeUndefined();
    expect(readFinalFallback({ ...BASE, ON_CALL_FINAL_FALLBACK_NUMBER: WAYNE }).finalFallbackPhone).toBe(WAYNE);
    expect(readFinalFallback({ ...BASE }).finalFallbackPhone).toBeUndefined();
  });

  it("shows only the last four digits on health", () => {
    const h = onCallHealth(LIVE_FB);
    expect(h.finalFallback).toEqual({ configured: true, last4: "7777" });
    expect(JSON.stringify(h)).not.toContain(WAYNE);
    expect(JSON.stringify(h)).not.toMatch(/\d{7}/);
    expect(onCallHealth(LIVE).finalFallback).toEqual({ configured: false });
    expect(onCallHealth({ ...LIVE, finalFallbackProblem: "bad" }).finalFallback).toEqual({ configured: false, problem: "bad" });
  });
});

describe("the plan", () => {
  it("is unchanged when the fallback is not configured", async () => {
    const d = await decideRoute(input({ config: LIVE }));
    expect(levels(d)?.map((l) => l[0])).toEqual(["on_call", "region_director", "final"]);
  });

  it("adds the operations fallback after the final director on the regular chain", async () => {
    const d = await decideRoute(input());
    expect(levels(d)).toEqual([
      ["on_call", 1, phoneOf(1)],
      ["region_director", IE_DIRECTOR, phoneOf(IE_DIRECTOR)],
      ["final", FINAL_DIRECTOR, phoneOf(FINAL_DIRECTOR)],
      ["operations_fallback", OPERATIONS_FALLBACK_PROVIDER_ID, WAYNE],
    ]);
  });

  it("adds it after the final director on the post-op chain too", async () => {
    const consoleQuery = vi.fn(async () => ({
      rows: [
        {
          date: "2026-11-29",
          event_name: "Surgery",
          is_kept: true,
          is_cancelled: false,
          is_rescheduled: false,
          npi: provider(2, "x").npi,
          nextgen_name: "Surgeon, MD",
        },
      ],
    }));
    const d = await decideRoute(input({ personId: PERSON, consoleQuery }));
    expect(levels(d)?.map((l) => [l[0], l[1]])).toEqual([
      ["surgeon", 2],
      ["region_director", LA_DIRECTOR],
      ["final", FINAL_DIRECTOR],
      ["operations_fallback", OPERATIONS_FALLBACK_PROVIDER_ID],
    ]);
  });

  it("rings a test number in test mode, the next one after the other levels", async () => {
    const d = await decideRoute(input({ config: TEST_FB }));
    expect(levels(d)?.map((l) => [l[0], l[2]])).toEqual([
      ["on_call", "+15550100001"],
      ["region_director", "+15550100002"],
      ["final", "+15550100003"],
      ["operations_fallback", "+15550100004"],
    ]);
  });

  it("is on the synthetic test chain only when configured", () => {
    expect(syntheticTestPlan(TEST_FB).levels.map((l) => [l.role, l.phone])).toEqual([
      ["on_call", "+15550100001"],
      ["region_director", "+15550100002"],
      ["final", "+15550100003"],
      ["operations_fallback", "+15550100004"],
    ]);
    const { finalFallbackPhone: _f, ...noFb } = TEST_FB;
    expect(syntheticTestPlan(noFb).levels.map((l) => l.role)).toEqual(["on_call", "region_director", "final"]);
  });

  it("is never rung twice: a fallback number already in the chain is skipped, with a note", async () => {
    const d = await decideRoute(input({ config: { ...LIVE, finalFallbackPhone: phoneOf(FINAL_DIRECTOR) } }));
    expect(levels(d)?.map((l) => l[0])).toEqual(["on_call", "region_director", "final"]);
    expect(d.kind === "rotation" && d.plan.notes).toContain("operations_fallback_already_in_chain");
    expect(d.kind === "rotation" && d.routing.notes).toContain("operations_fallback_already_in_chain");
  });

  it("decides the duplicate on the live numbers, before test mode swaps them", async () => {
    const d = await decideRoute(input({ config: { ...TEST_FB, finalFallbackPhone: phoneOf(1) } }));
    expect(levels(d)?.map((l) => l[0])).toEqual(["on_call", "region_director", "final"]);
  });

  it("does not turn a plan with no level into a rotation call: today's path stands", async () => {
    const data = syntheticRotation({ schedule: new Map(), directors: new Map() });
    const d = await decideRoute(input({ data }));
    expect(d.kind === "legacy" && d.because).toBe("no_levels");
    expect(withOperationsFallback({ levels: [], notes: [] }, WAYNE).levels).toEqual([]);
  });

  it("does not change weekday daytime or the off switch", async () => {
    expect((await decideRoute(input({ at: WED_DAY }))).kind).toBe("legacy");
    const off = await decideRoute(input({ config: { mode: "off", testPhones: [], callerId: "", requireKept: false, finalFallbackPhone: WAYNE } }));
    expect(off).toEqual({ kind: "legacy", because: "mode_off" });
  });

  it("is labelled 'Operations fallback (Wayne)' for staff and texts", () => {
    const plan = withOperationsFallback({ levels: [{ role: "final", providerId: 9, name: "Dr. F", phone: "+15550999999" }], notes: [] }, WAYNE);
    expect(levelLabel(plan.levels[1])).toBe("Operations fallback (Wayne)");
    expect(noNumberNote([plan.levels[1]])).toBe("Operations fallback (Wayne) has no dialable number on file and was not called.");
  });
});

// ── The runner walks the fallback level like any other ──────────────────────

const SID = "CA00000000000000000000000000000001";
const ROUTING: RoutingFacts = { reason: "on_call", window: "off_hours", weekStartsOn: "2026-12-01", source: "schedule", notes: [] };
const DETAILS = { reason: "Sudden curtain over the right eye", patientFirstName: "Test", callbackNumber: "+15550199999" };

function harness(config: OnCallConfig = LIVE_FB) {
  let clock = new Date(WED_NIGHT);
  const now = () => new Date(clock);
  const store = createFakeOnCallStore(syntheticRotation(), now);
  const texts: Array<{ to: string; from: string; body: string }> = [];
  const calls: Array<{ to: string; from: string }> = [];
  const urgent: string[] = [];
  let sid = 0;
  const runner = createOnCallRunner({
    store,
    config,
    host: "voice.example.test",
    sendSms: vi.fn(async (m: { to: string; from: string; body: string }) => {
      texts.push(m);
      return { sid: `SM${++sid}` };
    }),
    placeCall: vi.fn(async (c: any) => {
      calls.push(c);
      return { sid: `CA9${String(++sid).padStart(31, "0")}` };
    }),
    notifyUrgent: vi.fn(async (body: string) => {
      urgent.push(body);
    }),
    endCall: vi.fn(async () => {}),
    now,
    log: vi.fn(),
  });
  const lastCall = () => [...store.attempts.values()].filter((a) => a.kind === "call").pop()!;
  return {
    store,
    runner,
    texts,
    calls,
    urgent,
    lastCall,
    at: (d: Date) => (clock = new Date(d)),
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    escalation: () => [...store.escalations.values()][0],
  };
}

async function planFor(config: OnCallConfig): Promise<ChainPlan> {
  const d = await decideRoute(input({ config }));
  if (d.kind !== "rotation") throw new Error("expected a rotation plan");
  return d.plan;
}

function inCall(plan: ChainPlan, mode: "live" | "test" = "live"): InCallTransferResult {
  return {
    callSid: SID,
    mode,
    plan,
    routing: ROUTING,
    details: DETAILS,
    callerNumber: "+15550199999",
    warm: { outcome: "no_answer", dialedTo: plan.levels[0].phone, endedAt: new Date(WED_NIGHT.getTime() + 40_000) },
    levelStartedAt: WED_NIGHT,
    preDialSms: { ok: true, sid: "SM0", at: WED_NIGHT },
  };
}

/** Ring out levels 0..`through`, leaving the chain at the next level's first call. */
async function ringOutThrough(h: ReturnType<typeof harness>, through: number) {
  const esc = await h.runner.afterInCallTransfer(inCall(await planFor(LIVE_FB)));
  h.at(esc!.nextAt!);
  await h.runner.tick(); // level 0, second call
  await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
  for (let level = 1; level <= through; level++) {
    await h.runner.tick(); // first call
    await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick(); // second call
    await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
  }
}

describe("the runner and the operations fallback", () => {
  it("calls Wayne after the final director, with the same text, call, reminder text and retry call", async () => {
    const h = harness();
    await ringOutThrough(h, 2);
    expect(h.escalation()).toMatchObject({ status: "active", levelIndex: 3 });
    expect(h.urgent).toHaveLength(0);

    await h.runner.tick();
    expect(h.calls[h.calls.length - 1]).toMatchObject({ to: WAYNE, from: LIVE.callerId });
    const details = h.texts[h.texts.length - 1];
    expect(details.to).toBe(WAYNE);
    expect(details.body).toMatch(/ESCALATED — Provider 95 did not take this urgent call/);
    expect(details.body).toContain(DETAILS.reason);
    await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    h.advance(RETRY_GAP_MS);
    await h.runner.tick();
    expect(h.calls[h.calls.length - 1].to).toBe(WAYNE);
    expect(h.texts[h.texts.length - 1]).toMatchObject({ to: WAYNE });
    expect(h.texts[h.texts.length - 1].body).toMatch(/REMINDER/);

    const fallbackLog = [...h.store.attempts.values()]
      .filter((a) => a.levelIndex === 3)
      .map((a) => [a.role, a.kind, a.attemptNo, a.providerId, a.dialedTo]);
    expect(fallbackLog).toEqual([
      ["operations_fallback", "sms", 1, null, WAYNE],
      ["operations_fallback", "call", 1, null, WAYNE],
      ["operations_fallback", "nudge_sms", 2, null, WAYNE],
      ["operations_fallback", "call", 2, null, WAYNE],
    ]);
  });

  it("closes exhausted, and texts the urgent number, only after Wayne's calls are not taken too", async () => {
    const h = harness();
    await ringOutThrough(h, 3);
    expect(h.escalation()).toMatchObject({ status: "exhausted" });
    expect(h.urgent).toHaveLength(1);
    expect(h.urgent[0]).toMatch(/NOBODY TOOK THIS URGENT CALL — all 4 on-call levels were tried/);
  });

  it("is taken by a key press at the fallback level, with no provider id", async () => {
    const h = harness();
    await ringOutThrough(h, 2);
    await h.runner.tick();
    expect(await h.runner.onProviderAck(h.lastCall().id, "1")).toBe("accepted");
    expect(h.escalation()).toMatchObject({ status: "accepted", acceptedBy: null, levelIndex: 3 });
    expect(h.urgent).toHaveLength(0);
  });

  it("without the number, exhausts after the final director exactly as before", async () => {
    const h = harness(LIVE);
    const esc = await h.runner.afterInCallTransfer(inCall(await planFor(LIVE)));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    for (let level = 1; level <= 2; level++) {
      await h.runner.tick();
      await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
      h.advance(RETRY_GAP_MS);
      await h.runner.tick();
      await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    }
    expect(h.escalation()).toMatchObject({ status: "exhausted" });
    expect(h.calls.every((c) => c.to !== WAYNE)).toBe(true);
    expect(h.urgent[0]).toMatch(/all 3 on-call levels were tried/);
  });

  it("rings the test number, never Wayne's, in test mode", async () => {
    const h = harness(TEST_FB);
    const plan = await planFor(TEST_FB);
    const esc = await h.runner.afterInCallTransfer(inCall(plan, "test"));
    h.at(esc!.nextAt!);
    await h.runner.tick();
    await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    for (let level = 1; level <= 2; level++) {
      await h.runner.tick();
      await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
      h.advance(RETRY_GAP_MS);
      await h.runner.tick();
      await h.runner.onProviderStatus(h.lastCall().id, "no-answer");
    }
    await h.runner.tick();
    expect(h.calls[h.calls.length - 1].to).toBe("+15550100004");
    expect(h.calls.every((c) => c.to !== WAYNE)).toBe(true);
    expect(h.texts.every((t) => t.to !== WAYNE)).toBe(true);
    expect(h.texts[h.texts.length - 1].body).toContain("[TEST MODE]");
  });
});
