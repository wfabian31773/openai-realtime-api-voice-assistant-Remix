/**
 * v271: a person the campaign has nothing to offer is neither rung nor texted.
 *
 * Operator, 2026-11-24, on the patients NPX has no credentialed opening for:
 * "if they're not credentialed, then we shouldn't be calling those patients
 * anyway, right?" On 2026-11-23 (UTC), 4 of the 17 NPX outreach calls that
 * reached describe_upcoming_appointment told the patient nothing sooner was
 * open: 2 of 8 dialled calls and 2 of 9 returned calls (the corpus below). The
 * dialler now asks the lane's offer check after every other check and before
 * it rings; the text tick asks it before it sends. A returned call is not
 * stopped here: what stops is the dial or the text that would prompt one.
 *
 * Synthetic people, numbers and practices only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFER_CHECK_TIMEOUT_MS,
  askOfferCheck,
  type ContactSource,
  type OfferCheck,
  type OutboundLanePolicy,
  type SourceContact,
} from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW, tomorrowAtOpening } from "./callingWindow";
import { nextLookAt, runCampaignTick, type OutboundTwilio } from "./dialer";
import { TEXT_RETRY_MS, runTextTick, textRecordOf, type OutboundTextPolicy, type TextDeps } from "./outreachText";
import { FakeOutboundStore } from "./store.testkit";
import { SMS_DNC_SOURCE } from "./channelDnc";
import type { SmsSender } from "../../plugin/sms";
import type { NpxOutreachClient, NpxSlot } from "../../services/npxOutreachClient";
import {
  NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  NPX_OUTREACH_LIVE_CAMPAIGN_KEY,
  loadAvailability,
  npxOfferCheck,
  resetOutreachAvailabilityForTests,
  setNpxOutreachDepsForTests,
} from "../../tools/npxOutreachTools";
import { npxOutreachPolicy } from "../../agents/npxOutreachAgent";

// Tuesday 10 AM Pacific (PST).
const NOW = new Date("2041-03-05T18:00:00Z");
// Wednesday 9 AM Pacific: the window's next opening.
const TOMORROW_9AM = new Date("2041-03-06T17:00:00Z");
const ON = { RUNTIME_OUTBOUND_DIALING: "1", OUTBOUND_CAMPAIGN_TEST: "1", OUTBOUND_TEST_FROM: "+15555550100", NPX_TEST_TEXTS: "1" };

/** The four NPX calls of 2026-11-23 that heard "nothing sooner is open":
 * two we dialled and two returned calls. Each stands in here as a contact
 * the dialler would ring next, with a synthetic record whose group NPX has no
 * opening for. */
const NOTHING_SOONER_20261123 = [
  "CA671b718383db52a068c5db9cfa7a42a8", // dialled
  "CA9e63bfccce5eb227763f59ee0a89eac7", // dialled
  "CAb506b033d3db0dac5b453870838ebe56", // returned call
  "CA4c899a2f35b6a81a234a5bced588c034", // returned call
] as const;

/** What the movable list carries for an NPX outreach row: the offer's inputs. */
const OFFER_FIELDS = {
  medical_group: "Synthetic Medical Group",
  partners: ["Synthetic Partner Eyecare"],
  appointment_date: "2041-04-20",
  date_of_birth: "1950-01-02",
};

const slot = (id: string): NpxSlot => ({
  slotId: id,
  startAt: "2041-03-12T17:00:00.000Z",
  endAt: "2041-03-12T17:30:00.000Z",
  timezone: "America/Los_Angeles",
  day: "2041-03-12",
  partnerOrgId: "org-1",
  partnerName: "Synthetic Partner Eyecare",
  clinicId: "clinic-1",
  clinicName: "Synthetic Partner Eyecare Fontana",
  address: "1 Example Way, Fontana, CA 92335",
  city: "Fontana",
  phone: "5555550199",
} as NpxSlot);

const basePolicy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 4,
  greeting: () => "Hello, this is an automated assistant calling for Azul Vision. This call is recorded.",
  voicemail: () => "Hello, this is Azul Vision.",
};

function dialSetup() {
  const store = new FakeOutboundStore(() => NOW);
  let n = 0;
  const createCall = vi.fn(async () => ({ sid: `CA${String(++n).padStart(32, "0")}` }));
  const voiceUrlFor = vi.fn(async (): Promise<string | null> => "https://voice.example.test/voice/test-lane");
  const twilio: OutboundTwilio = { createCall, voiceUrlFor };
  const deps = { store, twilio, env: ON, host: "voice.example.test", now: () => NOW, log: () => undefined };
  return { store, createCall, deps };
}

const person = (ref: string, data: Record<string, unknown> = OFFER_FIELDS): SourceContact => ({
  externalRef: ref,
  phone: "+15555550111",
  firstName: "Testa",
  lastName: "Synthetic",
  data,
});

function sourceFor(listed: SourceContact[]): ContactSource {
  return {
    name: "test movable list",
    refreshEveryMs: 15 * 60 * 1000,
    parkMs: 60 * 60 * 1000,
    list: async () => listed,
    recheck: async (ref) => ({ state: "current", contact: listed.find((p) => p.externalRef === ref) ?? person(ref) }),
  };
}

describe("the dialler asks the offer check last, and rings nobody it has nothing for", () => {
  it("holds a person with nothing to offer until tomorrow's window, keeping their status, and rings nobody", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "nothing_to_offer");
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, deps);
    expect(r.held).toEqual({ no_opening: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")).toMatchObject({ status: "voicemail" });
    expect(store.contacts.get("c1")!.nextAttemptAt!.toISOString()).toBe(TOMORROW_9AM.toISOString());
    // Nobody was rung: no attempt is written, so no cap is spent.
    expect(store.attempts.length).toBe(0);
  });

  it("rings a person it has something for", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, deps);
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(offerCheck).toHaveBeenCalledWith({ id: "c1", customData: expect.objectContaining(OFFER_FIELDS) });
  });

  it("holds a person whose answer could not be read for the short retry, and rings nobody", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "no_answer", customData: OFFER_FIELDS });
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck: async () => "unknown" }, deps);
    expect(r.held).toEqual({ offer_unknown: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")).toMatchObject({ status: "no_answer" });
    expect(store.contacts.get("c1")!.nextAttemptAt!.getTime()).toBe(nextLookAt(NOW, "twilio_refused", basePolicy).getTime());
  });

  it("reads a check that throws as unknown, and rings nobody", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const offerCheck = () => {
      throw new Error("npx down");
    };
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck: offerCheck as never }, deps);
    expect(r.held).toEqual({ offer_unknown: 1 });
    expect(createCall).not.toHaveBeenCalled();
  });

  it("is not asked of a person who would not be rung anyway", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    store.dnc.set("5555550111", "voice:test");
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, deps);
    expect(r.held).toEqual({ do_not_contact: 1 });
    expect(offerCheck).not.toHaveBeenCalled();
    expect(createCall).not.toHaveBeenCalled();
  });

  it("is not asked outside the calling window", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    // 10 PM Pacific: the tick does not open at all.
    const late = new Date("2041-03-06T06:00:00Z");
    await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, { ...deps, now: () => late });
    expect(offerCheck).not.toHaveBeenCalled();
    expect(createCall).not.toHaveBeenCalled();
  });

  it("reads the window again after the offer check, and rings nobody once it has closed", async () => {
    // Review of #519: the offer check can take seconds per person, under the
    // tick's one timestamp. 7:59:58 PM Pacific when the tick starts; the
    // window has closed by the time the check answers.
    let clock = new Date("2041-03-06T03:59:58Z");
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => {
      clock = new Date("2041-03-06T04:00:05Z");
      return "offerable";
    });
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, { ...deps, now: () => clock });
    expect(offerCheck).toHaveBeenCalledTimes(1);
    expect(r.held).toEqual({ outside_hours: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.attempts.length).toBe(0);
    expect(store.contacts.get("c1")).toMatchObject({ status: "voicemail" });
    // Wednesday's opening hour, read from the clock as it is now (the tick's
    // own timestamp would give 16:59:58, before the window opens).
    expect(store.contacts.get("c1")!.nextAttemptAt!.toISOString()).toBe("2041-03-06T17:00:05.000Z");
  });

  it("still rings when the window is open on the clock as it is now", async () => {
    let clock = new Date("2041-03-06T03:59:00Z");
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => {
      clock = new Date("2041-03-06T03:59:30Z");
      return "offerable";
    });
    await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, { ...deps, now: () => clock });
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("reads today's fields from the source, over the row's own", async () => {
    const { store, deps } = dialSetup();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      externalRef: "appt-1",
      customData: { ...OFFER_FIELDS, medical_group: "An Older Group" },
    });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "nothing_to_offer");
    const source = sourceFor([person("appt-1")]);
    // The queue was refreshed a moment ago, so the row still holds the older
    // group: only the dial's own re-check carries today's.
    await runCampaignTick(
      "test-lane",
      { ...basePolicy, offerCheck, source: async () => source },
      { ...deps, sourceRefreshedAt: new Map([["test-campaign", NOW.getTime()]]) },
    );
    expect(offerCheck).toHaveBeenCalledWith({
      id: "c1",
      customData: expect.objectContaining({ medical_group: "Synthetic Medical Group" }),
    });
  });

  it("writes today's fields onto the row before it rings, because the call reads the row", async () => {
    // Review of #519, round 2: the offer check approved today's group, so the
    // call must offer from today's group too.
    const { store, createCall, deps } = dialSetup();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      externalRef: "appt-1",
      customData: { ...OFFER_FIELDS, medical_group: "An Older Group" },
    });
    let groupWhenRung: unknown;
    createCall.mockImplementation(async () => {
      groupWhenRung = store.contacts.get("c1")!.customData.medical_group;
      return { sid: `CA${"1".padStart(32, "0")}` };
    });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const source = sourceFor([person("appt-1")]);
    await runCampaignTick(
      "test-lane",
      { ...basePolicy, offerCheck, source: async () => source },
      { ...deps, sourceRefreshedAt: new Map([["test-campaign", NOW.getTime()]]) },
    );
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(groupWhenRung).toBe("Synthetic Medical Group");
  });

  it("writes nothing when the row already holds today's fields", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const source = sourceFor([person("appt-1")]);
    await runCampaignTick(
      "test-lane",
      { ...basePolicy, offerCheck, source: async () => source },
      { ...deps, sourceRefreshedAt: new Map([["test-campaign", NOW.getTime()]]) },
    );
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(store.upserts).toEqual([]);
  });

  it("rings nobody when today's fields cannot be written onto the row", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      status: "voicemail",
      externalRef: "appt-1",
      customData: { ...OFFER_FIELDS, medical_group: "An Older Group" },
    });
    store.upsertSourceContacts = async () => {
      throw new Error("database unavailable");
    };
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const source = sourceFor([person("appt-1")]);
    const r = await runCampaignTick(
      "test-lane",
      { ...basePolicy, offerCheck, source: async () => source },
      { ...deps, sourceRefreshedAt: new Map([["test-campaign", NOW.getTime()]]) },
    );
    expect(r.held).toEqual({ source_write_failed: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")).toMatchObject({ status: "voicemail" });
  });

  it("reads the place-by deadline again after the offer check, and never rings a call it has missed", async () => {
    // Review of #519, round 2: a first call due by a deadline the check outlasted.
    let clock = NOW;
    const { store, createCall, deps } = dialSetup();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      customData: { ...OFFER_FIELDS, place_by: new Date(NOW.getTime() + 5_000).toISOString() },
    });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => {
      clock = new Date(NOW.getTime() + 8_000);
      return "offerable";
    });
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, { ...deps, now: () => clock });
    expect(offerCheck).toHaveBeenCalledTimes(1);
    expect(r.held).toEqual({ place_by_passed: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")).toMatchObject({ status: "rescheduled" });
  });

  it("honours an opt-out recorded while the offer check waited, and rings nobody", async () => {
    // Review of #519, round 3: the do-not-contact list is read again after the
    // offer check, which can wait seconds on NPX.
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail", customData: OFFER_FIELDS });
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => {
      await store.stampDoNotContact("+15555550111", SMS_DNC_SOURCE);
      return "offerable";
    });
    const r = await runCampaignTick("test-lane", { ...basePolicy, offerCheck }, deps);
    expect(offerCheck).toHaveBeenCalledTimes(1);
    expect(r.held).toEqual({ do_not_contact: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.attempts.length).toBe(0);
    expect(store.contacts.get("c1")).toMatchObject({ status: "do_not_call" });
  });

  it("writes today's fields before it reads the clock again, so a write that crosses closing rings nobody", async () => {
    // Review of #519, round 3: the time the write takes counts against the window.
    let clock = new Date("2041-03-06T03:59:58Z");
    const { store, createCall, deps } = dialSetup();
    store.addContact({
      id: "c1",
      phone: "+15555550111",
      status: "voicemail",
      externalRef: "appt-1",
      customData: { ...OFFER_FIELDS, medical_group: "An Older Group" },
    });
    const write = store.upsertSourceContacts.bind(store);
    store.upsertSourceContacts = async (...args: Parameters<typeof write>) => {
      clock = new Date("2041-03-06T04:00:05Z");
      return write(...args);
    };
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const source = sourceFor([person("appt-1")]);
    const r = await runCampaignTick(
      "test-lane",
      { ...basePolicy, offerCheck, source: async () => source },
      { ...deps, now: () => clock, sourceRefreshedAt: new Map([["test-campaign", clock.getTime()]]) },
    );
    expect(r.held).toEqual({ outside_hours: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.customData.medical_group).toBe("Synthetic Medical Group");
  });

  it("leaves a campaign with no offer check exactly as it was", async () => {
    const { store, createCall, deps } = dialSetup();
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    await runCampaignTick("test-lane", basePolicy, deps);
    expect(createCall).toHaveBeenCalledTimes(1);
  });
});

describe("askOfferCheck", () => {
  afterEach(() => vi.useRealTimers());

  it("is offerable with no check at all", async () => {
    expect(await askOfferCheck({}, { id: "c1", customData: {} })).toBe("offerable");
  });

  it("reads an answer it does not know as unknown", async () => {
    expect(await askOfferCheck({ offerCheck: async () => "maybe" as never }, { id: "c1", customData: {} })).toBe("unknown");
  });

  it("stops waiting at OFFER_CHECK_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const pending = askOfferCheck({ offerCheck: () => new Promise<OfferCheck>(() => undefined) }, { id: "c1", customData: {} });
    await vi.advanceTimersByTimeAsync(OFFER_CHECK_TIMEOUT_MS);
    expect(await pending).toBe("unknown");
  });
});

describe("tomorrowAtOpening", () => {
  it("is tomorrow at the opening hour in Pacific time", () => {
    expect(tomorrowAtOpening(NOW, 9).toISOString()).toBe(TOMORROW_9AM.toISOString());
  });

  it("is tomorrow even when asked before today's opening", () => {
    // 6 AM Pacific: today's 9 AM has not come, and it is not the answer.
    expect(tomorrowAtOpening(new Date("2041-03-05T14:00:00Z"), 9).toISOString()).toBe(TOMORROW_9AM.toISOString());
  });

  it("stays right across the spring-forward change", () => {
    // Saturday 2041-03-09, 10 AM PST; Sunday opens at 9 AM PDT = 16:00Z.
    expect(tomorrowAtOpening(new Date("2041-03-09T18:00:00Z"), 9).toISOString()).toBe("2041-03-10T16:00:00.000Z");
  });

  it("is what the dialler's daily cap already used", () => {
    expect(nextLookAt(NOW, "daily_cap", basePolicy).toISOString()).toBe(TOMORROW_9AM.toISOString());
    expect(nextLookAt(NOW, "no_opening", basePolicy).toISOString()).toBe(TOMORROW_9AM.toISOString());
  });
});

describe("the text tick asks the offer check before it sends", () => {
  const text: OutboundTextPolicy = {
    enableEnv: "NPX_TEST_TEXTS",
    perTick: 10,
    body: (link) => `Azul Vision: test. Book in 4 steps: ${link}. Reply STOP to opt out.`,
    page: {
      isDemo: () => true,
      currentAppointment: () => "an eye exam",
      openings: async () => ({ openings: [] }),
      book: async () => ({ ok: false, error: "x" }),
    },
  };

  function textSetup(offerCheck?: OutboundLanePolicy["offerCheck"]) {
    const store = new FakeOutboundStore(() => NOW);
    const sent: string[] = [];
    const sender: SmsSender = {
      send: vi.fn(async (m) => {
        sent.push(m.to);
        return { sid: `SM${String(sent.length).padStart(32, "0")}` };
      }),
    };
    const deps: TextDeps = { store, env: ON, host: "voice.example.test", sms: async () => sender, now: () => NOW, log: () => undefined };
    const policy: OutboundLanePolicy = { ...basePolicy, textOutreach: text, ...(offerCheck ? { offerCheck } : {}) };
    return { store, sent, deps, policy };
  }

  it("sends no link to a person with nothing to offer, and looks again tomorrow", async () => {
    const { store, sent, deps, policy } = textSetup(async () => "nothing_to_offer");
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const r = await runTextTick("test-lane", policy, deps);
    expect(r.held).toEqual({ no_opening: 1 });
    expect(sent).toEqual([]);
    expect(textRecordOf(store.contacts.get("c1")!.customData)).toMatchObject({
      state: "retry",
      reason: "no_opening",
      retry_after: TOMORROW_9AM.toISOString(),
    });
  });

  it("sends the link to a person it has something for", async () => {
    const { store, sent, deps, policy } = textSetup(async () => "offerable");
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    expect((await runTextTick("test-lane", policy, deps)).sent).toBe(1);
    expect(sent).toEqual(["+15555550111"]);
  });

  it("holds a text whose answer could not be read for the ordinary retry", async () => {
    const { store, sent, deps, policy } = textSetup(async () => "unknown");
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    expect((await runTextTick("test-lane", policy, deps)).held).toEqual({ offer_unknown: 1 });
    expect(sent).toEqual([]);
    expect(textRecordOf(store.contacts.get("c1")!.customData)).toMatchObject({
      state: "retry",
      reason: "offer_unknown",
      retry_after: new Date(NOW.getTime() + TEXT_RETRY_MS).toISOString(),
    });
  });

  it("reads the window again after the offer check, and sends nothing once it has closed", async () => {
    // Review of #519, the text tick's half: it checks the window once, at its start.
    let clock = new Date("2041-03-06T03:59:58Z");
    const { store, sent, deps, policy } = textSetup(async () => {
      clock = new Date("2041-03-06T04:00:05Z");
      return "offerable";
    });
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    const r = await runTextTick("test-lane", policy, { ...deps, now: () => clock });
    expect(r.held).toEqual({ outside_hours: 1 });
    expect(sent).toEqual([]);
    expect(textRecordOf(store.contacts.get("c1")!.customData)).toMatchObject({
      state: "retry",
      reason: "outside_hours",
      retry_after: "2041-03-06T17:00:05.000Z",
    });
  });

  it("honours an opt-out recorded while the offer check waited, and sends nothing", async () => {
    // Review of #519, round 3, the text tick's half.
    let stamp: (() => Promise<void>) | null = null;
    const { store, sent, deps, policy } = textSetup(async () => {
      await stamp?.();
      return "offerable";
    });
    stamp = () => store.stampDoNotContact("+15555550111", SMS_DNC_SOURCE);
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    expect((await runTextTick("test-lane", policy, deps)).held).toEqual({ do_not_contact: 1 });
    expect(sent).toEqual([]);
    expect(textRecordOf(store.contacts.get("c1")!.customData)).toMatchObject({ state: "skipped", reason: "do_not_contact" });
  });

  it("does not ask about a number on the do-not-contact list", async () => {
    const offerCheck = vi.fn(async (): Promise<OfferCheck> => "offerable");
    const { store, deps, policy } = textSetup(offerCheck);
    store.addContact({ id: "c1", phone: "+15555550111", customData: OFFER_FIELDS });
    await store.stampDoNotContact("+15555550111", SMS_DNC_SOURCE);
    expect((await runTextTick("test-lane", policy, deps)).held).toEqual({ do_not_contact: 1 });
    expect(offerCheck).not.toHaveBeenCalled();
  });
});

describe("the NPX lane's offer check", () => {
  let npx: { availability: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn> };
  let npxDemo: { availability: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn> };
  const fake = (slots: NpxSlot[]) => ({
    availability: vi.fn(async () => ({ ok: true as const, slots, truncated: false })),
    offer: vi.fn(async () => ({ ok: true as const, slots })),
  });

  beforeEach(() => {
    vi.stubEnv("NPX_OUTREACH_MODE", "live");
    resetOutreachAvailabilityForTests();
    npx = fake([]);
    npxDemo = fake([slot("demo-1")]);
    setNpxOutreachDepsForTests({
      npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
      npxDemo: { configured: true, ...npxDemo } as unknown as NpxOutreachClient,
    });
  });

  afterEach(() => {
    setNpxOutreachDepsForTests(null);
    resetOutreachAvailabilityForTests();
    vi.unstubAllEnvs();
  });

  const row = (id: string, data: Record<string, unknown> = OFFER_FIELDS) => ({ id, customData: data });

  it("has nothing to offer when NPX has no opening", async () => {
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("nothing_to_offer");
    // It asked NPX what the call would: the group, the practices, the date.
    expect(npx.availability).toHaveBeenCalledWith(
      expect.objectContaining({
        medicalGroupName: "Synthetic Medical Group",
        partnerNames: ["Synthetic Partner Eyecare"],
        replacedAppointmentDate: "2041-04-20",
      }),
      expect.anything(),
    );
    expect(JSON.stringify(npx.availability.mock.calls)).not.toContain("1950-01-02");
  });

  it("is offerable when NPX has an opening", async () => {
    npx.availability.mockResolvedValue({ ok: true, slots: [slot("s1")], truncated: false });
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("offerable");
  });

  it("is unknown when NPX cannot answer, and the failure is not kept", async () => {
    npx.availability.mockResolvedValue({ ok: false, error: "timeout" });
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("unknown");
    npx.availability.mockResolvedValue({ ok: true, slots: [slot("s1")], truncated: false });
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("offerable");
  });

  it("has nothing to offer for a record the offer cannot be asked for, and asks NPX nothing", async () => {
    expect(await npxOfferCheck(row("c1", { appointment_date: "2041-04-20" }), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe(
      "nothing_to_offer",
    );
    expect(npx.availability).not.toHaveBeenCalled();
  });

  it("is the read the call makes: the call that follows reads it back instead of asking NPX again", async () => {
    npx.availability.mockResolvedValue({ ok: true, slots: [slot("s1")], truncated: false });
    await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY);
    const onTheCall = await loadAvailability(
      { contactId: "c1", campaignId: "x", attemptId: "a1", phone: "+15555550111", firstName: "Testa", lastName: "Synthetic", data: OFFER_FIELDS },
      false,
    );
    expect("slots" in onTheCall && onTheCall.slots.map((s) => s.slotId)).toEqual(["s1"]);
    expect(npx.availability).toHaveBeenCalledTimes(1);
  });

  it("reads NPX afresh when the record's group, partners or appointment date changed", async () => {
    // Review of #519: the dialler checks with today's fields from the source,
    // and a cached answer for yesterday's fields is not an answer for these.
    npx.availability.mockResolvedValueOnce({ ok: true, slots: [], truncated: false });
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("nothing_to_offer");
    npx.availability.mockResolvedValue({ ok: true, slots: [slot("s1")], truncated: false });
    for (const changed of [
      { ...OFFER_FIELDS, medical_group: "Another Synthetic Medical Group" },
      { ...OFFER_FIELDS, partners: ["Synthetic Partner Eyecare", "Second Synthetic Partner"] },
      { ...OFFER_FIELDS, appointment_date: "2041-05-11" },
    ]) {
      expect(await npxOfferCheck(row("c1", changed), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("offerable");
    }
    expect(npx.availability).toHaveBeenCalledTimes(4);
    // The same fields again read the cache.
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_LIVE_CAMPAIGN_KEY)).toBe("nothing_to_offer");
    expect(npx.availability).toHaveBeenCalledTimes(4);
  });

  it("reads the demo NPX for the demo campaign, never production", async () => {
    expect(await npxOfferCheck(row("c1"), NPX_OUTREACH_DEMO_CAMPAIGN_KEY)).toBe("offerable");
    expect(npxDemo.availability).toHaveBeenCalledTimes(1);
    expect(npx.availability).not.toHaveBeenCalled();
  });

  it("is the lane's registered check, on the lane's own campaign", async () => {
    expect(npxOutreachPolicy.offerCheck).toBeTypeOf("function");
    expect(await npxOutreachPolicy.offerCheck!(row("c1"))).toBe("nothing_to_offer");
    expect(npx.availability).toHaveBeenCalledTimes(1);
  });

  it("rings none of the four 2026-11-23 shapes that heard nothing sooner was open, and rings the control", async () => {
    const { store, createCall, deps } = dialSetup();
    NOTHING_SOONER_20261123.forEach((sid, i) => {
      store.addContact({ id: `c${i}`, phone: `+1555555012${i}`, externalRef: `ref-${sid}`, customData: OFFER_FIELDS });
    });
    store.addContact({ id: "control", phone: "+15555550199", externalRef: "ref-control", customData: { ...OFFER_FIELDS, medical_group: "Open Group" } });
    npx.availability.mockImplementation(async (req: { medicalGroupName: string }) =>
      req.medicalGroupName === "Open Group"
        ? { ok: true, slots: [slot("s1")], truncated: false }
        : { ok: true, slots: [], truncated: false },
    );
    const listed = [...store.contacts.values()].map((c) => ({
      externalRef: c.externalRef!,
      phone: c.phone,
      firstName: "Testa",
      lastName: "Synthetic",
      data: c.customData,
    }));
    const policy: OutboundLanePolicy = {
      ...basePolicy,
      concurrency: 10,
      source: async () => sourceFor(listed),
      offerCheck: (c) => npxOfferCheck(c, NPX_OUTREACH_LIVE_CAMPAIGN_KEY),
    };
    const r = await runCampaignTick("test-lane", policy, { ...deps, sourceRefreshedAt: new Map([["test-campaign", NOW.getTime()]]) });
    expect(r.held).toEqual({ no_opening: 4 });
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(createCall).toHaveBeenCalledWith(expect.objectContaining({ to: "+15555550199" }));
  });
});
