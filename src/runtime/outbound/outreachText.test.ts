/**
 * v211: the NPX outreach text. Operator, 2026-11-11: "i want them all to
 * receive a text message as well", "they should get a customized link that
 * lets them book in 4 easy steps", "there is already a number that NPX uses,
 * we should use that number, wording is fine."
 *
 * One text per contact, from the campaign's caller ID, inside the calling
 * window, never to a do-not-contact number, never twice. Synthetic people and
 * numbers only.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ContactSource, OutboundLanePolicy, SourceRecheck } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { SMS_DNC_SOURCE } from "./channelDnc";
import { refreshFromSource, sourceKey } from "./dialer";
import {
  BOOKING_LINK_TTL_MS,
  MAX_SEND_TRIES,
  OUTREACH_TEXT_KEY,
  TEXT_RETRY_MS,
  bookingLinkUrl,
  hashBookingToken,
  isBookingTokenShape,
  newBookingToken,
  runTextTick,
  textRecordOf,
  type OutboundTextPolicy,
  type OutreachTextRecord,
  type TextDeps,
} from "./outreachText";
import { SendOutcomeError } from "../../plugin/sendFailure";
import type { SmsSender } from "../../plugin/sms";
import type { BookingPageLane } from "./bookingPage";
import { FakeOutboundStore } from "./store.testkit";
import type { ContactStatus } from "./store";

// Tuesday 10 AM Pacific.
const NOW = new Date("2041-03-05T18:00:00Z");
const FROM = "+15555550100";
const ENV = { NPX_TEST_TEXTS: "1", OUTBOUND_TEST_FROM: FROM };

const page: BookingPageLane = {
  isDemo: () => true,
  currentAppointment: () => "an eye exam",
  openings: async () => ({ openings: [] }),
  book: async () => ({ ok: false, error: "x" }),
};
const text: OutboundTextPolicy = {
  enableEnv: "NPX_TEST_TEXTS",
  perTick: 10,
  body: (link) => `Azul Vision: test. Book in 4 steps: ${link}. Reply STOP to opt out.`,
  page,
};
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: () => "Hello.",
  voicemail: () => "Hello.",
  textOutreach: text,
};

function sourceWith(recheck: (ref: string) => Promise<SourceRecheck>): ContactSource {
  return { name: "test source", refreshEveryMs: 60_000, parkMs: 60_000, list: async () => [], recheck };
}
const CURRENT = (phone = "+15555550111"): SourceRecheck => ({
  state: "current",
  contact: { externalRef: "x", phone, firstName: "Testa", lastName: "Synthetic", data: {} },
});

function setup(over: { env?: Record<string, string>; sender?: SmsSender | null; policy?: OutboundLanePolicy; now?: Date } = {}) {
  const store = new FakeOutboundStore(() => over.now ?? NOW);
  const sent: Array<{ to: string; from: string; body: string }> = [];
  let n = 0;
  const sender: SmsSender = {
    send: vi.fn(async (m) => {
      sent.push(m);
      return { sid: `SM${String(++n).padStart(32, "0")}` };
    }),
  };
  const lines: string[] = [];
  const deps: TextDeps = {
    store,
    env: over.env ?? ENV,
    host: "voice.example.test",
    sms: async () => (over.sender === undefined ? sender : over.sender),
    now: () => over.now ?? NOW,
    log: (l) => lines.push(l),
  };
  return { store, sent, sender, deps, lines, policy: over.policy ?? policy };
}

const add = (store: FakeOutboundStore, id: string, extra: Partial<Parameters<FakeOutboundStore["addContact"]>[0]> = {}) =>
  store.addContact({ id, phone: `+1555555${id.replace(/\D/g, "").padStart(4, "0")}`, externalRef: `ref-${id}`, ...extra });

const record = (store: FakeOutboundStore, id: string): OutreachTextRecord | null =>
  textRecordOf(store.contacts.get(id)!.customData);

describe("the link", () => {
  it("is a random 256-bit token, base64url, and the row keeps only its SHA-256", () => {
    const a = newBookingToken();
    const b = newBookingToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(hashBookingToken(a.token)).toBe(a.hash);
    expect(isBookingTokenShape(a.token)).toBe(true);
    expect(isBookingTokenShape(`${a.token}x`)).toBe(false);
    expect(isBookingTokenShape("../../etc/passwd")).toBe(false);
  });

  it("is the page's path on the public host, and names nobody", () => {
    expect(bookingLinkUrl("voice.example.test", "T".repeat(43))).toBe(`https://voice.example.test/book/${"T".repeat(43)}`);
  });

  it("lasts seven days", () => {
    expect(BOOKING_LINK_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("nothing is texted unless everything is in place", () => {
  it("needs the campaign's own text switch", async () => {
    const { store, sent, deps, policy } = setup({ env: { OUTBOUND_TEST_FROM: FROM } });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toBe("disabled");
    expect(sent).toEqual([]);
    expect(store.textClaims).toBe(0);
  });

  it("needs the switch to be exactly 1", async () => {
    const { store, sent, deps, policy } = setup({ env: { ...ENV, NPX_TEST_TEXTS: "true" } });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toBe("disabled");
    expect(sent).toEqual([]);
  });

  it("needs the caller ID", async () => {
    const { store, sent, deps, policy } = setup({ env: { NPX_TEST_TEXTS: "1" } });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toMatch(/no caller ID/);
    expect(sent).toEqual([]);
  });

  it("needs a public host for the link", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, { ...deps, host: "" })).skipped).toBe("no public host");
    expect(sent).toEqual([]);
  });

  it("needs a booking page: a link that can only say expired is never sent", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1");
    const noPage = { ...policy, textOutreach: { ...text, page: undefined } };
    expect((await runTextTick("test-lane", noPage, deps)).skipped).toBe("no booking page");
    expect(sent).toEqual([]);
  });

  it("needs an SMS sender", async () => {
    const { store, deps, policy } = setup({ sender: null });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toBe("no sms sender");
    expect(store.textClaims).toBe(0);
  });

  it("is off for a campaign that does not text", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1");
    expect((await runTextTick("test-lane", { ...policy, textOutreach: undefined }, deps)).skipped).toBe("no text");
    expect(sent).toEqual([]);
  });

  it("holds outside the calling window: 8 AM Pacific", async () => {
    const { store, sent, deps, policy } = setup({ now: new Date("2041-03-05T16:00:00Z") });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toBe("outside_hours");
    expect(sent).toEqual([]);
  });

  it("holds on a closed holiday, as the calls do", async () => {
    // Thanksgiving 2041 is Thursday 28 November; 11 AM Pacific.
    const { store, sent, deps, policy } = setup({ now: new Date("2041-11-28T19:00:00Z") });
    add(store, "c1");
    expect((await runTextTick("test-lane", policy, deps)).skipped).toBe("holiday");
    expect(sent).toEqual([]);
  });

  it("texts nobody when the campaign's source cannot be built", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1");
    const p = { ...policy, source: async () => null };
    expect((await runTextTick("test-lane", p, deps)).skipped).toBe("contact source not available");
    expect(sent).toEqual([]);
  });
});

describe("one text per contact", () => {
  it("sends the campaign's words, with the link, from the caller ID, to the person's number", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { phone: "(555) 555-0111" });
    const r = await runTextTick("test-lane", policy, deps);
    expect(r.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(FROM);
    expect(sent[0].to).toBe("+15555550111");
    const link = /https:\/\/voice\.example\.test\/book\/([A-Za-z0-9_-]{43})/.exec(sent[0].body);
    expect(link).not.toBeNull();
    expect(sent[0].body).toBe(`Azul Vision: test. Book in 4 steps: https://voice.example.test/book/${link![1]}. Reply STOP to opt out.`);
    const rec = record(store, "c1")!;
    expect(rec).toMatchObject({ state: "sent", lane: "test-lane", sent_at: NOW.toISOString() });
    expect(rec.message_sid).toMatch(/^SM/);
    // The row holds the hash, never the token.
    expect(rec.token_hash).toBe(hashBookingToken(link![1]));
    expect(JSON.stringify(store.contacts.get("c1")!.customData)).not.toContain(link![1]);
    expect(new Date(rec.expires_at!).getTime() - NOW.getTime()).toBe(BOOKING_LINK_TTL_MS);
  });

  it("never texts the same person twice", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1");
    await runTextTick("test-lane", policy, deps);
    await runTextTick("test-lane", policy, deps);
    await runTextTick("test-lane", policy, deps);
    expect(sent).toHaveLength(1);
    expect(store.textClaims).toBe(1);
  });

  it("two ticks racing for one row: only one claim lands", async () => {
    const { store } = setup();
    add(store, "c1");
    const a = await store.claimText("c1", NOW, { state: "claimed" });
    const b = await store.claimText("c1", NOW, { state: "claimed" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("caps the texts a tick sends", async () => {
    const { store, sent, deps } = setup();
    for (let i = 1; i <= 5; i++) add(store, `c${i}`);
    const p = { ...policy, textOutreach: { ...text, perTick: 2 } };
    expect((await runTextTick("test-lane", p, deps)).sent).toBe(2);
    expect(sent).toHaveLength(2);
    expect((await runTextTick("test-lane", p, deps)).sent).toBe(2);
    expect((await runTextTick("test-lane", p, deps)).sent).toBe(1);
    expect(sent).toHaveLength(5);
  });

  it("logs a count, never a number or the words", async () => {
    const { store, deps, policy, lines } = setup();
    add(store, "c1");
    await runTextTick("test-lane", policy, deps);
    expect(lines).toEqual(["[outbound] test-campaign: texted 1"]);
  });
});

describe("who is texted", () => {
  const TEXTED: ContactStatus[] = ["pending", "no_answer", "voicemail", "callback_scheduled", "answered", "max_attempts"];
  const NOT_TEXTED: ContactStatus[] = ["completed", "declined", "wrong_number", "do_not_call", "rescheduled", "confirmed", "calling"];

  it.each(TEXTED)("texts a contact who is %s", async (status) => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { status });
    await runTextTick("test-lane", policy, deps);
    expect(sent).toHaveLength(1);
  });

  it.each(NOT_TEXTED)("does not text a contact who is %s", async (status) => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { status });
    await runTextTick("test-lane", policy, deps);
    expect(sent).toEqual([]);
    expect(store.textClaims).toBe(0);
  });

  it("does not text a number on the do-not-contact list, from a call", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { phone: "+15555550111" });
    await store.stampDoNotContact("+15555550111", "voice_opt_out");
    await runTextTick("test-lane", policy, deps);
    expect(sent).toEqual([]);
    expect(record(store, "c1")).toMatchObject({ state: "skipped", reason: "do_not_contact" });
  });

  it("does not text a number that texted STOP", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { phone: "+15555550111" });
    await store.stampDoNotContact("+15555550111", SMS_DNC_SOURCE);
    await runTextTick("test-lane", policy, deps);
    expect(sent).toEqual([]);
  });

  it("does not text an unreadable number", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { phone: "555-0111" });
    await runTextTick("test-lane", policy, deps);
    expect(sent).toEqual([]);
    expect(record(store, "c1")).toMatchObject({ state: "skipped" });
  });

  it("does not text a live SI approval row", async () => {
    const { store, sent, deps, policy } = setup();
    add(store, "c1", { customData: { plugin_live: true } });
    await runTextTick("test-lane", policy, deps);
    expect(sent).toEqual([]);
  });

  it("does not text a row the source never wrote, on a source-fed campaign", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1", { externalRef: null });
    const p = { ...policy, source: async () => sourceWith(async () => CURRENT()) };
    await runTextTick("test-lane", p, deps);
    expect(sent).toEqual([]);
  });
});

describe("the source is asked first, as the dialler asks it", () => {
  it("texts today's number when the appointment is still current", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1", { phone: "+15555550111" });
    const p = { ...policy, source: async () => sourceWith(async () => CURRENT("+15555550199")) };
    await runTextTick("test-lane", p, deps);
    expect(sent.map((m) => m.to)).toEqual(["+15555550199"]);
  });

  it("never texts about an appointment that is over", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1");
    const p = { ...policy, source: async () => sourceWith(async () => ({ state: "gone" })) };
    await runTextTick("test-lane", p, deps);
    expect(sent).toEqual([]);
    expect(record(store, "c1")).toMatchObject({ state: "skipped", reason: "source_gone" });
    // ... and never looks at it again.
    await runTextTick("test-lane", p, { ...deps, now: () => new Date(NOW.getTime() + 2 * TEXT_RETRY_MS) });
    expect(sent).toEqual([]);
  });

  it("waits, then tries again, when the row is off the list or the source cannot answer", async () => {
    const { store, sent, deps } = setup();
    add(store, "c1");
    add(store, "c2");
    let answer: (ref: string) => Promise<SourceRecheck> = async (ref) => {
      if (ref === "ref-c1") return { state: "off_list" };
      throw new Error("console down");
    };
    const p = { ...policy, source: async () => sourceWith((ref) => answer(ref)) };
    await runTextTick("test-lane", p, deps);
    expect(sent).toEqual([]);
    expect(record(store, "c1")).toMatchObject({ state: "retry", reason: "off_list" });
    expect(record(store, "c2")).toMatchObject({ state: "retry", reason: "source_unavailable" });
    // Not before the retry is due ...
    await runTextTick("test-lane", p, { ...deps, now: () => new Date(NOW.getTime() + TEXT_RETRY_MS - 1000) });
    expect(sent).toEqual([]);
    // ... and then once each.
    answer = async () => CURRENT();
    const later = new Date(NOW.getTime() + TEXT_RETRY_MS + 1000);
    await runTextTick("test-lane", p, { ...deps, now: () => later });
    expect(sent).toHaveLength(2);
  });
});

describe("a send that fails", () => {
  it("is never sent again when it may have gone out: a second text is worse than none", async () => {
    const sender: SmsSender = { send: vi.fn(async () => Promise.reject(new SendOutcomeError("sms_timeout", true))) };
    const { store, deps, policy } = setup({ sender });
    add(store, "c1");
    await runTextTick("test-lane", policy, deps);
    expect(record(store, "c1")).toMatchObject({ state: "unknown", reason: "sms_timeout" });
    await runTextTick("test-lane", policy, { ...deps, now: () => new Date(NOW.getTime() + 2 * TEXT_RETRY_MS) });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("is tried again an hour later when Twilio clearly refused it, at most three times in all", async () => {
    const sender: SmsSender = { send: vi.fn(async () => Promise.reject(new SendOutcomeError("twilio_rejected", false))) };
    const { store, deps, policy } = setup({ sender });
    add(store, "c1");
    await runTextTick("test-lane", policy, deps);
    expect(record(store, "c1")).toMatchObject({ state: "retry", tries: 1 });
    for (let i = 1; i <= 4; i++) {
      await runTextTick("test-lane", policy, { ...deps, now: () => new Date(NOW.getTime() + i * (TEXT_RETRY_MS + 1000)) });
    }
    expect(sender.send).toHaveBeenCalledTimes(MAX_SEND_TRIES);
    expect(record(store, "c1")).toMatchObject({ state: "failed", tries: MAX_SEND_TRIES });
  });

  it("gives a retried text a new link, so an old one never works", async () => {
    let fail = true;
    const bodies: string[] = [];
    const sender: SmsSender = {
      send: vi.fn(async (m) => {
        bodies.push(m.body);
        if (fail) throw new SendOutcomeError("twilio_rejected", false);
        return { sid: "SM1" };
      }),
    };
    const { store, deps, policy } = setup({ sender });
    add(store, "c1");
    await runTextTick("test-lane", policy, deps);
    const firstHash = record(store, "c1")!.token_hash;
    fail = false;
    await runTextTick("test-lane", policy, { ...deps, now: () => new Date(NOW.getTime() + TEXT_RETRY_MS + 1000) });
    expect(record(store, "c1")!.token_hash).not.toBe(firstHash);
    expect(bodies[0]).not.toBe(bodies[1]);
  });
});

describe("the queue refresh never wipes a text (the row's custom_data follows the source)", () => {
  const listed = { externalRef: "ref-c1", phone: "+15555550111", firstName: "Testa", lastName: "Synthetic", data: { appointment_date: "2041-04-01" } };

  it("does not count the text's state as a change", () => {
    const row = { ...listed, data: { ...listed.data, [OUTREACH_TEXT_KEY]: { state: "sent" } } };
    expect(sourceKey(row)).toBe(sourceKey(listed));
  });

  it("writes nothing for a texted row whose fields have not changed", async () => {
    const { store, deps, policy } = setup();
    store.addContact({ id: "c1", ...listed, customData: { ...listed.data } });
    await runTextTick("test-lane", policy, deps);
    const src: ContactSource = { name: "s", refreshEveryMs: 1, parkMs: 1, list: async () => [listed], recheck: async () => CURRENT() };
    const r = await refreshFromSource(policy, src, "campaign-1", NOW, { store, log: () => undefined });
    expect(r?.written).toBe(0);
    expect(record(store, "c1")!.state).toBe("sent");
  });

  it("keeps the text's state when the source changes the row's fields", async () => {
    const { store, sent, deps, policy } = setup();
    store.addContact({ id: "c1", ...listed, customData: { ...listed.data } });
    await runTextTick("test-lane", policy, deps);
    const moved = { ...listed, data: { appointment_date: "2041-04-08" } };
    const src: ContactSource = { name: "s", refreshEveryMs: 1, parkMs: 1, list: async () => [moved], recheck: async () => CURRENT() };
    const r = await refreshFromSource(policy, src, "campaign-1", NOW, { store, log: () => undefined });
    expect(r?.written).toBe(1);
    expect(store.contacts.get("c1")!.customData.appointment_date).toBe("2041-04-08");
    expect(record(store, "c1")!.state).toBe("sent");
    // ... so the person is not texted again.
    await runTextTick("test-lane", policy, deps);
    expect(sent).toHaveLength(1);
  });
});
