/**
 * The production wiring of the on-call chain: off by default and touching
 * nothing, refused without a public host, and, when it runs, sending its calls
 * and texts through one Twilio client with the shapes the runner asks for.
 *
 * Every phone is a 555 number.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOnCallWiring } from "./wiring";
import { createFakeOnCallStore } from "./store.fake";
import { syntheticRotation } from "./testRotation";
import { planAt } from "./routing";
import { ON_CALL_ACK_PATH, ON_CALL_STATUS_PATH } from "./providerCall";
import { RING_GUARD_MS, type InCallTransferResult } from "./runner";

const HOST = "voice.example.test";
const CALLER_ID = "+15550001111";
// Wed 2026-12-02 22:30 PT, week of 12-01: provider 1 (Inland Empire) on call.
const WED_NIGHT = new Date("2026-12-03T06:30:00Z");

afterEach(() => vi.unstubAllEnvs());

function fakeTwilio() {
  const texts: Array<{ body: string; from: string; to: string }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const updates: Array<{ sid: string; opts: Record<string, unknown> }> = [];
  const callsApi = Object.assign(
    (sid: string) => ({
      update: vi.fn(async (opts: { status: "completed" }) => {
        updates.push({ sid, opts });
        return {};
      }),
    }),
    {
      create: vi.fn(async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return { sid: `CA9${String(calls.length).padStart(31, "0")}` };
      }),
    },
  );
  const client = {
    messages: {
      create: vi.fn(async (opts: { body: string; from: string; to: string }) => {
        texts.push(opts);
        return { sid: `SM${texts.length}` };
      }),
    },
    calls: callsApi,
  };
  const factory = vi.fn(async () => client);
  return { factory, texts, calls, updates };
}

function noAnswer(): InCallTransferResult {
  const plan = planAt(WED_NIGHT, syntheticRotation());
  return {
    callSid: "CA00000000000000000000000000000001",
    mode: "live",
    plan,
    routing: { reason: "on_call", window: "off_hours", weekStartsOn: "2026-12-01", source: "schedule", notes: [] },
    details: { reason: "Sudden curtain over the right eye", callbackNumber: "+15550199999" },
    callerNumber: "+15550199999",
    warm: { outcome: "no_answer", dialedTo: plan.levels[0].phone, endedAt: new Date(WED_NIGHT.getTime() + 40_000) },
    levelStartedAt: WED_NIGHT,
    preDialSms: { ok: true, sid: "SM0", at: WED_NIGHT },
  };
}

describe("with the rotation switched off (the default)", () => {
  it("builds nothing and touches neither Twilio nor the database", () => {
    const tw = fakeTwilio();
    for (const env of [{}, { ON_CALL_ROTATION_MODE: "off" }, { ON_CALL_ROTATION_MODE: "" }]) {
      const w = buildOnCallWiring(env, HOST, { twilio: tw.factory });
      expect(w.transfer).toBeNull();
      expect(w.runner).toBeNull();
      expect(w.health).toEqual({ mode: "off", testPhones: 0, requireKept: false, running: false });
    }
    expect(tw.factory).not.toHaveBeenCalled();
  });

  it("says why when a lever forced it off", () => {
    const w = buildOnCallWiring({ ON_CALL_ROTATION_MODE: "test", ON_CALL_CALLER_ID: CALLER_ID }, HOST);
    expect(w.transfer).toBeNull();
    expect(w.health.running).toBe(false);
    expect(w.health.disabledBecause).toBe("test mode needs ON_CALL_TEST_PHONES");
  });

  it("refuses the Wayne Operator Line as the caller ID", () => {
    const w = buildOnCallWiring(
      { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: CALLER_ID, OPERATOR_LINE_FROM_NUMBER: CALLER_ID },
      HOST,
    );
    expect(w.transfer).toBeNull();
    expect(w.health.disabledBecause).toMatch(/Wayne Operator Line/);
  });
});

describe("with no public host", () => {
  it("does not run, and says the provider-call webhooks cannot be reached", () => {
    const tw = fakeTwilio();
    const env = { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: CALLER_ID };
    for (const host of [undefined, ""]) {
      const w = buildOnCallWiring(env, host, { twilio: tw.factory });
      expect(w.transfer).toBeNull();
      expect(w.runner).toBeNull();
      expect(w.health.running).toBe(false);
      expect(w.health.blockedBy).toMatch(/no public host/);
      expect(w.health.mode).toBe("live");
    }
    expect(tw.factory).not.toHaveBeenCalled();
  });
});

describe("running", () => {
  function running(env: Record<string, string> = {}, over: { consoleQuery?: null } = {}) {
    let clock = new Date(WED_NIGHT);
    const tw = fakeTwilio();
    const store = createFakeOnCallStore(syntheticRotation(), () => new Date(clock));
    const lines: string[] = [];
    const w = buildOnCallWiring(
      {
        ON_CALL_ROTATION_MODE: "live",
        ON_CALL_CALLER_ID: CALLER_ID,
        TWILIO_PHONE_NUMBER: "+15550000000",
        URGENT_NOTIFICATION_NUMBER: "+15550007777",
        ...env,
      },
      HOST,
      { twilio: tw.factory, store, now: () => new Date(clock), log: (l) => void lines.push(l), ...over },
    );
    return { w, tw, store, lines, at: (d: Date) => void (clock = new Date(d)) };
  }

  it("reports counts only on health, never a phone number", () => {
    const { w } = running({
      ON_CALL_ROTATION_MODE: "test",
      ON_CALL_TEST_PHONES: "+15550002222,+15550003333",
      ON_CALL_POST_OP_REQUIRE_KEPT: "1",
    });
    expect(w.health).toEqual({ mode: "test", testPhones: 2, requireKept: true, running: true });
    expect(JSON.stringify(w.health)).not.toMatch(/\d{7}/);
  });

  it("hands the transfer the runner, the config, the store, the rotation and the clock it was built with", async () => {
    const { w, store } = running();
    expect(w.transfer).not.toBeNull();
    expect(w.transfer!.runner).toBe(w.runner);
    expect(w.transfer!.config).toBe(w.config);
    expect(w.transfer!.store).toBe(store);
    expect(w.transfer!.now!().toISOString()).toBe(WED_NIGHT.toISOString());
    expect((await w.transfer!.rotation.get()).providers.length).toBe(syntheticRotation().providers.length);
  });

  it("sends the transfer's text through Twilio as given", async () => {
    const { w, tw } = running();
    const out = await w.transfer!.sendSms({ to: "+15550002222", from: CALLER_ID, body: "hello" });
    expect(out).toEqual({ sid: "SM1" });
    expect(tw.texts).toEqual([{ to: "+15550002222", from: CALLER_ID, body: "hello" }]);
    expect(tw.factory).toHaveBeenCalledTimes(1);
  });

  it("places the runner's retry call with the status callback on this host, by POST, with its limits", async () => {
    const { w, tw, at } = running();
    const esc = await w.runner!.afterInCallTransfer(noAnswer());
    at(esc!.nextAt!);
    await w.runner!.tick();
    expect(tw.calls).toHaveLength(1);
    const call = tw.calls[0];
    expect(call.from).toBe(CALLER_ID);
    expect(call.to).toBe(noAnswer().plan.levels[0].phone);
    expect(call.statusCallbackMethod).toBe("POST");
    expect(call.statusCallback).toMatch(new RegExp(`^https://${HOST}${ON_CALL_STATUS_PATH}\\?attempt=\\d+$`));
    expect(String(call.twiml)).toContain(`https://${HOST}${ON_CALL_ACK_PATH}?attempt=`);
    expect(call.timeout).toBe(30);
    expect(call.timeLimit).toBe(300);
    // One Twilio client, opened once, serves the text and the call.
    expect(tw.factory).toHaveBeenCalledTimes(2);
  });

  it("hangs up a provider call whose status never came back, through the same Twilio client", async () => {
    const { w, tw, at } = running();
    const esc = await w.runner!.afterInCallTransfer(noAnswer());
    at(esc!.nextAt!);
    await w.runner!.tick();
    expect(tw.calls).toHaveLength(1);
    at(new Date(esc!.nextAt!.getTime() + RING_GUARD_MS));
    await w.runner!.tick();
    expect(tw.updates).toEqual([{ sid: `CA9${"1".padStart(31, "0")}`, opts: { status: "completed" } }]);
  });

  it("texts the urgent notification number from today's number when the chain cannot start", async () => {
    const { w, tw, store } = running();
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    const urgent = tw.texts.filter((t) => t.to === "+15550007777");
    expect(urgent).toHaveLength(1);
    expect(urgent[0].from).toBe("+15550000000");
    expect(urgent[0].body).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
  });

  it("logs and sends nothing when the urgent number is not set", async () => {
    const { w, tw, store, lines } = running({ URGENT_NOTIFICATION_NUMBER: "" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts).toHaveLength(0);
    expect(lines.some((l) => /'nobody took it' text was not sent/.test(l))).toBe(true);
  });

  it("logs and sends nothing when today's number is not set, so no text goes out with no sender", async () => {
    const { w, tw, store, lines } = running({ TWILIO_PHONE_NUMBER: "" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts.filter((t) => t.to === "+15550007777")).toHaveLength(0);
    expect(lines.some((l) => /'nobody took it' text was not sent/.test(l))).toBe(true);
  });

  it("reads no surgery facts without the Console", () => {
    vi.stubEnv("OBS_CONSOLE_DATABASE_URL", "");
    const { w } = running();
    expect(w.transfer!.consoleQuery).toBeNull();
  });

  it("reads surgery facts from the Console pool when it is configured", () => {
    vi.stubEnv("OBS_CONSOLE_DATABASE_URL", "postgres://user:pass@127.0.0.1:1/none");
    const { w } = running();
    expect(typeof w.transfer!.consoleQuery).toBe("function");
  });

  it("takes an injected console query over the pool", () => {
    vi.stubEnv("OBS_CONSOLE_DATABASE_URL", "postgres://user:pass@127.0.0.1:1/none");
    const { w } = running({}, { consoleQuery: null });
    expect(w.transfer!.consoleQuery).toBeNull();
  });
});
