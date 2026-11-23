/**
 * The after-hours transfer's on-call path (v268), driven through the REAL
 * `createRuntimeTransfer` with only Twilio, the store, the rotation, the text
 * sender and the runner faked. A helper test proves the helper; this proves
 * the transfer calls it, dials the number it chose and hands the outcome on.
 *
 * Every phone is a 555 number and every name is made up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import {
  createRuntimeTransfer,
  ON_CALL_LANES,
  rotationMayTakeTheDial,
  TRANSFER_ACCEPT_PATH,
  TRANSFER_STATUS_PATH,
  type OnCallTransferWiring,
} from "./runtimeTransfer";
import type { TransferTwilioOps } from "./warmTransfer";
import type { UrgentTransferAlerts } from "./urgentTransferAlerts";
import type { WebhookRequest } from "./voiceWebhook";
import { escalationDetailsMap } from "../services/escalationStore";
import { readOnCallConfig } from "./onCall/config";
import { createFakeOnCallStore, type FakeOnCallStore } from "./onCall/store.fake";
import { provider, syntheticRotation, IE_DIRECTOR } from "./onCall/testRotation";
import type { RotationData } from "./onCall/rotation";
import type { InCallTransferResult } from "./onCall/runner";

const AUTH_TOKEN = "test-auth-token";
const DOMAIN = "runtime.example.test";
const ENV = {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_PHONE_NUMBER: "+15550000000",
  HUMAN_AGENT_NUMBER: "+18185551234",
  PCP_HUMAN_AGENT_NUMBER: "+17149564300",
};
const META = { callSid: "CAcaller", callId: "CAcaller", callerPhone: "+15551234567", dialedNumber: "+15559876543" };
const ROTATION_CALLER_ID = "+15550001111";
const TEST_PHONES = ["+15550002222", "+15550003333"];

/** Tuesday 2026-12-01, 6:00 PM Pacific: the first on-call hour of provider 1's week. */
const AFTER_HOURS = new Date("2026-12-02T02:00:00Z");
/** Wednesday 2026-12-02, 10:00 AM Pacific: weekday daytime, not on call. */
const WEEKDAY_DAYTIME = new Date("2026-12-02T18:00:00Z");

afterEach(() => escalationDetailsMap.clear());

function fakeOps() {
  const dialed: Array<{ to: string; from: string; twiml: string }> = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async ({ to, from, twiml }) => {
      dialed.push({ to, from, twiml });
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async () => undefined,
    endCall: async () => undefined,
    redirectCallerToQueue: async () => undefined,
  };
  return { ops, dialed };
}

function signed(path: string, body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: DOMAIN,
      "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://${DOMAIN}${path}`, body),
    },
    body,
    originalUrl: path,
  };
}

interface Built {
  wiring: OnCallTransferWiring;
  store: FakeOnCallStore;
  texts: Array<{ to: string; from: string; body: string; at: number }>;
  handed: InCallTransferResult[];
  order: string[];
}

function buildWiring(over: {
  env?: Record<string, string>;
  at?: Date;
  rotation?: RotationData;
  available?: boolean;
} = {}): Built {
  const at = over.at ?? AFTER_HOURS;
  const rotation = over.rotation ?? syntheticRotation();
  const store = createFakeOnCallStore(rotation, () => at);
  if (over.available === false) store.tablesPresent = false;
  const texts: Built["texts"] = [];
  const handed: InCallTransferResult[] = [];
  const order: string[] = [];
  const wiring: OnCallTransferWiring = {
    runner: {
      // Opens the chain's row the way the real runner does, and closes it on a
      // pickup, so the transfer's one-chain-per-call check reads a real row.
      afterInCallTransfer: async (r) => {
        handed.push(r);
        const row = await store.openEscalation({
          callSid: r.callSid,
          mode: r.mode,
          routing: r.routing,
          plan: r.plan,
          details: r.details,
          callerNumber: r.callerNumber,
          nextAt: at,
          levelStartedAt: r.levelStartedAt,
          attemptNo: 2,
        });
        if (row && r.warm.outcome === "accepted") {
          return store.closeEscalation(row.id, row.version, { status: "accepted" });
        }
        return row;
      },
    },
    config: readOnCallConfig(
      over.env ?? {
        ON_CALL_ROTATION_MODE: "test",
        ON_CALL_CALLER_ID: ROTATION_CALLER_ID,
        ON_CALL_TEST_PHONES: TEST_PHONES.join(","),
      },
    ),
    store,
    rotation: { get: async () => rotation },
    consoleQuery: null,
    personIdFor: () => undefined,
    sendSms: async (input) => {
      order.push(`sms:${input.to}`);
      texts.push({ ...input, at: Date.now() });
      return { sid: `SM${texts.length}` };
    },
    now: () => at,
  };
  return { wiring, store, texts, handed, order };
}

function recordingAlerts(): { alerts: UrgentTransferAlerts; beforeDial: unknown[]; tickets: unknown[] } {
  const beforeDial: unknown[] = [];
  const tickets: unknown[] = [];
  return {
    alerts: {
      smsBeforeDial: (input) => void beforeDial.push(input),
      fallbackTicket: (input) => void tickets.push(input),
    },
    beforeDial,
    tickets,
  };
}

function transferWith(
  ops: TransferTwilioOps,
  onCall: OnCallTransferWiring | undefined,
  alerts = recordingAlerts().alerts,
  over: { env?: Record<string, string>; log?: (line: string) => void } = {},
) {
  return createRuntimeTransfer({
    env: { ...ENV, ...over.env },
    ops,
    domain: DOMAIN,
    onCall,
    urgentAlerts: alerts,
    persistOutcome: () => undefined,
    log: over.log ?? (() => undefined),
  });
}

function urgent(slug = "no-ivr") {
  escalationDetailsMap.set("CAcaller", {
    agentSlug: slug,
    callerType: "patient_urgent",
    reason: "Sudden loss of vision in the left eye",
  });
}

describe("an urgent after-hours call with the rotation on", () => {
  it("texts the full details to the week's on-call provider, then dials them from the rotation's caller ID", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const order = built.order;
    const wrapped: TransferTwilioOps = {
      ...ops,
      createOfficeLeg: async (input) => {
        order.push(`dial:${input.to}`);
        return ops.createOfficeLeg(input);
      },
    };
    const transfer = transferWith(wrapped, built.wiring);
    urgent();

    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    // Test mode: level 0 rings the first test phone, never a real provider.
    expect(dialed).toHaveLength(1);
    expect(dialed[0].to).toBe(TEST_PHONES[0]);
    expect(dialed[0].from).toBe(ROTATION_CALLER_ID);
    // The text went first, to the same phone, with the details in it.
    expect(order).toEqual([`sms:${TEST_PHONES[0]}`, `dial:${TEST_PHONES[0]}`]);
    expect(built.texts[0].from).toBe(ROTATION_CALLER_ID);
    expect(built.texts[0].body).toContain("Sudden loss of vision in the left eye");
    expect(built.texts[0].body).toContain("[TEST MODE]");

    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    const h = built.handed[0];
    expect(h.warm.outcome).toBe("accepted");
    expect(h.warm.dialedTo).toBe(TEST_PHONES[0]);
    expect(h.warm.providerCallSid).toBe("CAoffice");
    expect(h.mode).toBe("test");
    expect(h.callSid).toBe("CAcaller");
    expect(h.callerNumber).toBe(META.callerPhone);
    expect(h.preDialSms?.ok).toBe(true);
    // Provider 1 (Inland Empire), then the region's director, then the final director.
    expect(h.plan.levels.map((l) => l.role)).toEqual(["on_call", "region_director", "final"]);
    expect(h.plan.levels[0].providerId).toBe(1);
    expect(h.plan.levels[1].providerId).toBe(IE_DIRECTOR);
    expect(h.routing.reason).toBe("on_call");
  });

  it("hands a declined transfer to the runner as declined, and still tells the agent it failed", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "" }));
    await expect(outcome).rejects.toThrow(/handoff_failed:DECLINED/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("declined");
    expect(built.handed[0].warm.providerCallSid).toBeNull();
  });

  it("hands a ring-out to the runner as no answer, not as a failure (spec b)", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("no_answer");
  });

  it("keeps today's heads-up text to the urgent notification number, unchanged", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(rec.beforeDial).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("never starts a second chain for one call: a second escalation dials nobody", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/handoff_failed:NO_ANSWER/);

    urgent();
    // Its own slug: the chain is still paging, which is not "could not be placed".
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_RUNNING$/);
    expect(dialed).toHaveLength(1);
    expect(built.texts).toHaveLength(1);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
  });

  it("covers every after-hours lane", () => {
    expect([...ON_CALL_LANES].sort()).toEqual(["dev-no-ivr", "no-ivr", "no-ivr-v2"]);
  });
});

describe("one chain per call, read from the chain's own row", () => {
  it("refuses a second escalation that arrives while the first is still being routed", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = built.wiring.rotation.get;
    const wiring: OnCallTransferWiring = {
      ...built.wiring,
      rotation: { get: async () => (await gate, realGet()) },
    };
    const transfer = transferWith(ops, wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_RUNNING$/);
    expect(dialed).toHaveLength(0);

    release();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await first;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
  });

  it("takes today's path for an escalation after this call's chain has finished", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await first;
    await vi.waitFor(() => expect([...built.store.escalations.values()][0]?.status).toBe("accepted"));

    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    expect(dialed[1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[1].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    expect(built.texts).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    expect(built.handed).toHaveLength(1);
  });

  it("routes a second escalation again when the runner could not open a row for the first", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    built.store.failWrites = true;
    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    built.store.failWrites = false;

    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    expect(dialed[1].to).toBe(TEST_PHONES[0]);
    expect(built.texts).toHaveLength(2);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    await vi.waitFor(() => expect(built.handed).toHaveLength(2));
  });

  it("lets only one of two same-tick escalations start a chain once the first chain is over", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    built.store.failWrites = true;
    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    built.store.failWrites = false;

    urgent();
    const second = handoff();
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_RUNNING$/);
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    await vi.waitFor(() => expect(built.handed).toHaveLength(2));
  });

  it("takes today's path when the chain's row cannot be read", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const lines: string[] = [];
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));

    built.store.getEscalationByCall = async () => {
      throw new Error("hub unreachable");
    };
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(built.texts).toHaveLength(1);
    expect(lines.some((l) => l.includes("could not read this call's escalation"))).toBe(true);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    expect(built.handed).toHaveLength(1);
  });

  it("does not leave the call claimed after its record could not be read", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));

    const realGet = built.store.getEscalationByCall.bind(built.store);
    built.store.getEscalationByCall = async () => {
      throw new Error("hub unreachable");
    };
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;

    // The record can be read again, and this call's chain has since ended.
    built.store.getEscalationByCall = realGet;
    const row = [...built.store.escalations.values()][0];
    row.status = "exhausted";
    urgent();
    const third = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(3);
    expect(dialed[2].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await third;
  });

  it("hands the chain to the runner as failed when the dial throws after the provider was texted", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const alerts: UrgentTransferAlerts = {
      smsBeforeDial: () => {
        throw new Error("alert sender broke");
      },
      fallbackTicket: () => undefined,
    };
    const transfer = transferWith(ops, built.wiring, alerts);
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/alert sender broke/);
    expect(dialed).toHaveLength(0);
    expect(built.texts).toHaveLength(1);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("failed");
    expect(built.handed[0].warm.providerCallSid).toBeNull();
  });
});

describe("which dials the rotation may take", () => {
  it("never takes a PCP dial, which goes to the PCP queue", () => {
    expect(rotationMayTakeTheDial({ allowed: true, destination: "+15550004300", policy: "pcp" })).toBe(false);
    expect(rotationMayTakeTheDial({ allowed: true, destination: "+15550004300", policy: "clinical" })).toBe(true);
    expect(rotationMayTakeTheDial({ allowed: false, reason: "pcp_destination_not_configured" })).toBe(false);
    expect(rotationMayTakeTheDial({ allowed: false, reason: "clinical_destination_not_configured" })).toBe(true);
  });

  it("rings the rotation's level 0 when HUMAN_AGENT_NUMBER is not set", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { env: { HUMAN_AGENT_NUMBER: "" } });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(TEST_PHONES[0]);
    expect(dialed[0].from).toBe(ROTATION_CALLER_ID);
    expect(rec.beforeDial).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
  });

  it("dials nobody when HUMAN_AGENT_NUMBER is not set and the rotation is off, as today", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { env: { HUMAN_AGENT_NUMBER: "" } });
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(dialed).toHaveLength(0);
    expect(rec.beforeDial).toHaveLength(0);
    expect(built.texts).toHaveLength(0);
  });

  it("leaves a caller type the policy does not transfer refused, without reading the rotation", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const get = vi.fn(built.wiring.rotation.get);
    const transfer = transferWith(ops, { ...built.wiring, rotation: { get } });
    escalationDetailsMap.set("CAcaller", { agentSlug: "no-ivr", callerType: "general_inquiry", reason: "Office hours" });
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(dialed).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
    expect(built.texts).toHaveLength(0);
  });
});

describe("live mode: a level with no phone", () => {
  const LIVE = { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: ROTATION_CALLER_ID };

  it("skips a first level with no phone and rings the next level", async () => {
    const base = syntheticRotation();
    const rotation: RotationData = {
      ...base,
      providers: base.providers.map((p) => (p.id === 1 ? provider(1, "Inland Empire", { phone: "" }) : p)),
    };
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: LIVE, rotation });
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    const director = base.providers.find((p) => p.id === IE_DIRECTOR)!;
    expect(dialed[0].to).toBe(director.phone);
    expect(built.texts[0].to).toBe(director.phone);
    expect(built.texts[0].body).not.toContain("[TEST MODE]");
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].plan.levels[0].role).toBe("region_director");
    expect(built.handed[0].plan.notes).toContain("first_level_no_phone:on_call:1");
  });

  it("takes today's path when no level has a phone", async () => {
    const base = syntheticRotation();
    const rotation: RotationData = { ...base, providers: base.providers.map((p) => ({ ...p, phone: "" })) };
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: LIVE, rotation });
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[0].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    expect(built.texts).toHaveLength(0);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(built.handed).toHaveLength(0);
  });
});

describe("today's path, byte for byte", () => {
  async function ringsTheFixedNumber(onCall: OnCallTransferWiring | undefined, slug = "no-ivr") {
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, onCall);
    urgent(slug);
    const outcome = transfer.handoffFor(slug, META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[0].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  }

  it("with no on-call wiring at all", async () => {
    await ringsTheFixedNumber(undefined);
  });

  it("with the rotation switched off", async () => {
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("with the rotation switched off, never reads the rotation or the caller's identity and logs nothing about it", async () => {
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    const personIdFor = vi.fn(() => undefined);
    const get = vi.fn(built.wiring.rotation.get);
    const wiring = { ...built.wiring, personIdFor, rotation: { get } };
    const lines: string[] = [];
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(personIdFor).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes("[ON-CALL]"))).toEqual([]);
  });

  it("when the deployment forces a blind transfer on the after-hours lane, which the chain cannot follow", async () => {
    const built = buildWiring();
    const queued: string[] = [];
    const { ops, dialed } = fakeOps();
    ops.redirectCallerToQueue = async (input) => {
      queued.push(input.destination);
    };
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { env: { RUNTIME_TRANSFER_MODE: "blind" } });
    urgent();
    await transfer.handoffFor("no-ivr", META)();
    expect(dialed).toHaveLength(0);
    expect(queued).toEqual([ENV.HUMAN_AGENT_NUMBER]);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("in weekday daytime hours, which are not on call", async () => {
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("in weekday daytime hours, for every escalation on the call, not only the first", async () => {
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);
    for (const n of [1, 2]) {
      urgent();
      const outcome = handoff();
      await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
      expect(dialed).toHaveLength(n);
      expect(dialed[n - 1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
      transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
      await outcome;
    }
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("when the rotation tables are not there yet (the migration not applied)", async () => {
    const built = buildWiring({ available: false });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("on a lane that is not the after-hours family", async () => {
    const built = buildWiring();
    await ringsTheFixedNumber(built.wiring, "answering-service");
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });
});
