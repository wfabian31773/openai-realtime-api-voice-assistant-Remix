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
import { RING_GUARD_MS, SWITCHED_OFF_REASON, type InCallTransferResult } from "./runner";
import { ABSENT_RECHECK_MS } from "./store";

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
  it("opens no chain, and builds only a draining runner that touches neither Twilio nor the database", () => {
    const tw = fakeTwilio();
    const hub = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));
    for (const env of [{}, { ON_CALL_ROTATION_MODE: "off" }, { ON_CALL_ROTATION_MODE: "" }]) {
      const w = buildOnCallWiring(env, HOST, { twilio: tw.factory, hubQuery: hub });
      expect(w.transfer).toBeNull();
      expect(w.runner).not.toBeNull();
      expect(w.runner!.draining).toBe(true);
      expect(w.health).toEqual({ mode: "off", testPhones: 0, requireKept: false, finalFallback: { configured: false }, running: false });
    }
    expect(tw.factory).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("on the default deployment asks the Hub twice, ten minutes apart, then stops for good, without the store's notice", async () => {
    let clock = new Date(WED_NIGHT);
    const tw = fakeTwilio();
    const hub = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));
    const lines: string[] = [];
    const w = buildOnCallWiring({}, HOST, {
      twilio: tw.factory,
      hubQuery: hub,
      now: () => new Date(clock),
      log: (l) => void lines.push(l),
    });
    await w.runner!.tick();
    expect(hub).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + ABSENT_RECHECK_MS + 1);
    await w.runner!.tick();
    expect(hub).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => /the rotation is off: .*; the drain stops/.test(l))).toHaveLength(1);
    clock = new Date(clock.getTime() + 60 * 60_000);
    await w.runner!.tick();
    expect(hub).toHaveBeenCalledTimes(2);
    expect(lines.some((l) => /on_call_\* tables are/.test(l))).toBe(false);
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
  it("opens no chain, says the provider-call webhooks cannot be reached, and only drains", () => {
    const tw = fakeTwilio();
    const hub = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));
    const env = { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: CALLER_ID };
    for (const host of [undefined, ""]) {
      const w = buildOnCallWiring(env, host, { twilio: tw.factory, hubQuery: hub });
      expect(w.transfer).toBeNull();
      expect(w.runner!.draining).toBe(true);
      expect(w.health.running).toBe(false);
      expect(w.health.blockedBy).toMatch(/no public host/);
      expect(w.health.mode).toBe("live");
    }
    expect(tw.factory).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("says nothing is blocked when the rotation is simply off", () => {
    const w = buildOnCallWiring({}, undefined, { twilio: fakeTwilio().factory });
    expect(w.health.blockedBy).toBeUndefined();
  });
});

describe("a chain left open when the rotation is switched off", () => {
  const LIVE = {
    ON_CALL_ROTATION_MODE: "live",
    ON_CALL_CALLER_ID: CALLER_ID,
    TWILIO_PHONE_NUMBER: "+15550000000",
    URGENT_NOTIFICATION_NUMBER: "+15550007777",
  };

  function openThenOff(offEnv: Record<string, string>, offHost: string | undefined = HOST) {
    let clock = new Date(WED_NIGHT);
    const now = () => new Date(clock);
    const tw = fakeTwilio();
    const store = createFakeOnCallStore(syntheticRotation(), now);
    const lines: string[] = [];
    const live = buildOnCallWiring(LIVE, HOST, { twilio: tw.factory, store, now, log: (l) => void lines.push(l) });
    const off = buildOnCallWiring(offEnv, offHost, { twilio: tw.factory, store, now, log: (l) => void lines.push(l) });
    return { live, off, tw, store, lines, at: (d: Date) => void (clock = new Date(d)) };
  }

  it("is closed at its next step with one text to the urgent number, and nobody else is called", async () => {
    const { live, off, tw, store, at } = openThenOff({
      TWILIO_PHONE_NUMBER: "+15550000000",
      URGENT_NOTIFICATION_NUMBER: "+15550007777",
    });
    const esc = await live.runner!.afterInCallTransfer(noAnswer());
    const textsBefore = tw.texts.length;
    at(esc!.nextAt!);
    await off.runner!.tick();
    expect(tw.calls).toHaveLength(0);
    const sent = tw.texts.slice(textsBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("+15550007777");
    expect(sent[0].from).toBe("+15550000000");
    expect(sent[0].body).toContain(SWITCHED_OFF_REASON);
    expect((await store.getEscalationByCall(esc!.callSid))!.status).toBe("cancelled");
  });

  it("sends that text from ON_CALL_CALLER_ID when it is still set", async () => {
    const { live, off, tw, at } = openThenOff({
      ON_CALL_CALLER_ID: CALLER_ID,
      TWILIO_PHONE_NUMBER: "+15550000000",
      URGENT_NOTIFICATION_NUMBER: "+15550007777",
    });
    const esc = await live.runner!.afterInCallTransfer(noAnswer());
    const textsBefore = tw.texts.length;
    at(esc!.nextAt!);
    await off.runner!.tick();
    expect(tw.texts.slice(textsBefore).map((t) => t.from)).toEqual([CALLER_ID]);
  });

  it("never sends that text from the operator line", async () => {
    const { live, off, tw, lines, at } = openThenOff({
      TWILIO_PHONE_NUMBER: "+15550009999",
      OPERATOR_LINE_FROM_NUMBER: "+15550009999",
      URGENT_NOTIFICATION_NUMBER: "+15550007777",
    });
    const esc = await live.runner!.afterInCallTransfer(noAnswer());
    const textsBefore = tw.texts.length;
    at(esc!.nextAt!);
    await off.runner!.tick();
    expect(tw.calls).toHaveLength(0);
    expect(tw.texts.slice(textsBefore)).toHaveLength(0);
    expect(tw.texts.some((t) => t.from === "+15550009999")).toBe(false);
    expect(lines.some((l) => /'nobody took it' text was not sent: no caller ID/.test(l))).toBe(true);
  });

  it("still takes a provider's key press on a call the live runner placed", async () => {
    const { live, off, tw, store, at } = openThenOff({ TWILIO_PHONE_NUMBER: "+15550000000" }, undefined);
    const esc = await live.runner!.afterInCallTransfer(noAnswer());
    at(esc!.nextAt!);
    await live.runner!.tick();
    expect(tw.calls).toHaveLength(1);
    const attempt = Number(new URL(String(tw.calls[0].statusCallback)).searchParams.get("attempt"));
    const reply = await off.runner!.onProviderAck(attempt, "1");
    expect(reply).toBe("accepted");
    expect((await store.getEscalationByCall(esc!.callSid))!.status).toBe("accepted");
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
    expect(w.health).toEqual({ mode: "test", testPhones: 2, requireKept: true, finalFallback: { configured: false }, running: true });
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
    expect(urgent[0].from).toBe(CALLER_ID);
    expect(urgent[0].body).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
  });

  it("sends a test chain's 'nobody took it' text to the first test phone, never the urgent number", async () => {
    const { w, tw, store } = running({ ON_CALL_ROTATION_MODE: "test", ON_CALL_TEST_PHONES: "+15550002222,+15550003333" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer({ ...noAnswer(), mode: "test" });
    expect(tw.texts.filter((t) => t.to === "+15550007777")).toHaveLength(0);
    const sent = tw.texts.filter((t) => t.to === "+15550002222");
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(CALLER_ID);
    expect(sent[0].body).toMatch(/\[TEST MODE\]/);
    expect(sent[0].body).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
  });

  it("sends a test-mode chain's text to the test number its own plan rang after the rotation is switched to live", async () => {
    // A live process has no test list; the chain's own plan rang test numbers
    // by construction, so its closing text goes to the first of them and never
    // to the urgent number (review of #514, round 6).
    const { w, tw, store } = running();
    store.failWrites = true;
    const base = noAnswer();
    const plan = {
      ...base.plan,
      levels: base.plan.levels.map((l, i) => ({ ...l, phone: i === 0 ? "" : `+1555000444${i}` })),
    };
    await w.runner!.afterInCallTransfer({ ...base, mode: "test", plan });
    expect(tw.texts.filter((t) => t.to === "+15550007777")).toHaveLength(0);
    const sent = tw.texts.filter((t) => t.to === "+15550004441");
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(CALLER_ID);
    expect(sent[0].body).toMatch(/\[TEST MODE\]/);
    expect(sent[0].body).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
  });

  it("keeps a test-mode chain's text off the urgent number when its plan holds no number either", async () => {
    const { w, tw, store, lines } = running();
    store.failWrites = true;
    const base = noAnswer();
    const plan = { ...base.plan, levels: base.plan.levels.map((l) => ({ ...l, phone: "" })) };
    await w.runner!.afterInCallTransfer({ ...base, mode: "test", plan });
    expect(tw.texts.filter((t) => t.to === "+15550007777")).toHaveLength(0);
    expect(tw.texts).toHaveLength(0);
    expect(lines.some((l) => /a test chain needs ON_CALL_TEST_PHONES/.test(l))).toBe(true);
  });

  it("sends a live chain's text to the urgent number even after the rotation is switched to test", async () => {
    const { w, tw, store } = running({ ON_CALL_ROTATION_MODE: "test", ON_CALL_TEST_PHONES: "+15550002222" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts.filter((t) => t.to === "+15550002222")).toHaveLength(0);
    const sent = tw.texts.filter((t) => t.to === "+15550007777");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toMatch(/\[TEST MODE\]/);
    expect(sent[0].body).toMatch(/THE ON-CALL ESCALATION COULD NOT START/);
  });

  it("logs and sends nothing when the urgent number is not set", async () => {
    const { w, tw, store, lines } = running({ URGENT_NOTIFICATION_NUMBER: "" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts).toHaveLength(0);
    expect(lines.some((l) => /'nobody took it' text was not sent/.test(l))).toBe(true);
  });

  it("sends the 'nobody took it' text to an urgent number written with punctuation, as E.164", async () => {
    const { w, tw, store } = running({ URGENT_NOTIFICATION_NUMBER: " (555) 000-7777 " });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts.filter((t) => t.to === "+15550007777")).toHaveLength(1);
    expect(tw.texts.some((t) => t.to.includes("("))).toBe(false);
  });

  it("says the urgent number is not a phone number, and sends nothing, when it is not one", async () => {
    const { w, tw, store, lines } = running({ URGENT_NOTIFICATION_NUMBER: "on-call desk" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    expect(tw.texts).toHaveLength(0);
    expect(lines.some((l) => /URGENT_NOTIFICATION_NUMBER is not a phone number/.test(l))).toBe(true);
  });

  it("sends the 'nobody took it' text from the chain's caller ID even when TWILIO_PHONE_NUMBER is not set", async () => {
    const { w, tw, store, lines } = running({ TWILIO_PHONE_NUMBER: "" });
    store.failWrites = true;
    await w.runner!.afterInCallTransfer(noAnswer());
    const urgent = tw.texts.filter((t) => t.to === "+15550007777");
    expect(urgent).toHaveLength(1);
    expect(urgent[0].from).toBe(CALLER_ID);
    expect(lines.some((l) => /'nobody took it' text was not sent/.test(l))).toBe(false);
  });

  it("never runs the chain from the operator line", async () => {
    // The config refuses a caller ID that is the operator line, and with no
    // other number the rotation does not run: the transfer gets no wiring and
    // the runner left only drains.
    const w = buildOnCallWiring(
      {
        ON_CALL_ROTATION_MODE: "live",
        TWILIO_PHONE_NUMBER: "+15550009999",
        OPERATOR_LINE_FROM_NUMBER: "+15550009999",
        URGENT_NOTIFICATION_NUMBER: "+15550007777",
      },
      HOST,
      { twilio: fakeTwilio().factory, store: createFakeOnCallStore(syntheticRotation(), () => new Date(WED_NIGHT)) },
    );
    expect(w.transfer).toBeNull();
    expect(w.runner!.draining).toBe(true);
    expect(await w.runner!.afterInCallTransfer(noAnswer())).toBeNull();
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
