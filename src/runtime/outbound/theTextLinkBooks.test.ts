/**
 * v214: a booking made through the text link reaches NPX.
 *
 * The corpus is the NPX outreach campaign's first evening of texts,
 * 2026-11-12 00:27–02:27 UTC: 493 contacts texted, 32 opened the link and
 * confirmed their date of birth, 0 booked. NPX answered every link booking
 * HTTP 400: the page sent the booking reference `text-link:<contact>`, and
 * NPX's schema (apps/npx/src/lib/outreach.ts, outreachBookingSchema) takes
 * only letters, digits, hyphens and underscores in `callRef`, and refuses the
 * whole booking when it breaks that rule. Phone bookings carry the CallSid,
 * which fits, and were unaffected (13 booked in the same hours).
 *
 * A link booking carries no CallSid, so the corpus is indexed by contact row,
 * and the rows here are synthetic stand-ins in the real ids' shape (a uuid):
 * the 32 real rows are the npx-outreach contacts whose outreach_text holds a
 * verified_at and no booking_id. Two layers are driven, both real: the page's
 * booking step, and the NPX client against a fake NPX that applies NPX's own
 * rule. Synthetic data only; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactSource, OutboundLanePolicy, SourceRecheck } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import {
  handleBookingStep,
  resetLinkLimitsForTests,
  textLinkCallRef,
  type BookingPageDeps,
  type BookingPageLane,
} from "./bookingPage";
import { OUTREACH_TEXT_KEY, newBookingToken } from "./outreachText";
import { FakeOutboundStore } from "./store.testkit";
import { createNpxOutreachClient, NPX_CALL_REF, type NpxBookRequest } from "../../services/npxOutreachClient";

/** NPX's own rule, copied from its schema rather than from ours, so a
 * mistake in the pinned constant cannot pass for agreement. */
const NPX_SCHEMA_CALL_REF = /^[A-Za-z0-9_-]{1,64}$/;

const NOW = new Date("2041-03-05T18:00:00Z");
const DOB = { month: "1", day: "2", year: "1950" };

/** 32 contacts in the real rows' shape: a uuid each. */
const CORPUS = Array.from({ length: 32 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);

const SLOT = {
  slotId: "slot-a", startAt: "2041-02-04T17:00:00.000Z", endAt: "2041-02-04T17:30:00.000Z",
  timezone: "America/Los_Angeles", day: "2041-02-04", partnerOrgId: "p1", partnerName: "Partner One",
  clinicId: "k1", clinicName: "Clinic One", address: "1 Test St, Testville, CA 90000", phone: "555-010-0000",
  providerName: "Dr Test", visitType: "Comprehensive Exam",
};

/** A fake NPX booking endpoint that applies NPX's schema to `callRef`. */
function fakeNpx() {
  const sent: Record<string, unknown>[] = [];
  const f = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push(body);
    if (body.callRef !== undefined && !NPX_SCHEMA_CALL_REF.test(String(body.callRef).trim())) {
      return new Response(JSON.stringify({ error: "bad_request", issues: ["callRef must be 1-64 letters, digits, - or _"] }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ ok: true, bookingId: `booking-${sent.length}`, alreadyBooked: false, recordGroupDiffers: false, slot: SLOT }),
      { status: 201 },
    );
  });
  return { f, sent };
}

let store: FakeOutboundStore;
let npx: ReturnType<typeof fakeNpx>;
let deps: BookingPageDeps;

function seedContact(id: string): string {
  const t = newBookingToken();
  store.addContact({
    id,
    phone: "+15555550111",
    firstName: "Testa",
    lastName: "Synthetic",
    externalRef: `ref-${id}`,
    customData: {
      date_of_birth: "1950-01-02",
      appointment_date: "2041-03-20",
      event_name: "Dilated Exam",
      medical_group: "Test Group",
      [OUTREACH_TEXT_KEY]: {
        state: "sent",
        lane: "test-lane",
        token_hash: t.hash,
        claimed_at: NOW.toISOString(),
        sent_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      },
    },
  });
  return t.token;
}

const step = (token: string, action: string, body: Record<string, unknown> = {}) =>
  handleBookingStep(token, action, body, deps).then((r) => JSON.parse(r.body) as Record<string, unknown>);

beforeEach(() => {
  resetLinkLimitsForTests();
  store = new FakeOutboundStore(() => NOW);
  npx = fakeNpx();
  const client = createNpxOutreachClient({ NPX_OUTREACH_API_KEY: "test-key" }, npx.f as never);
  const recheck = vi.fn(async (externalRef: string): Promise<SourceRecheck> => ({
    state: "current",
    contact: { externalRef, phone: "+15555550199", firstName: "Testa", lastName: "Synthetic", data: {} },
  }));
  const source: ContactSource = { name: "test", refreshEveryMs: 1, parkMs: 1, list: async () => [], recheck };
  // The page's lane books through the real NPX client, with the reference
  // the page hands it, as npxBookingPageLane does through bookOutreachSlot.
  const lane: BookingPageLane = {
    isDemo: () => false,
    currentAppointment: () => "a dilated eye exam on Wednesday, March 20",
    openings: async () => ({
      openings: [{ id: "slot-a", day: "2041-02-04", dayLabel: "Monday, February 4", timeLabel: "9:00 AM", city: "Testville", place: "Partner One", provider: "Dr Test" }],
    }),
    book: async ({ contact, openingId, callRef }) => {
      const req: NpxBookRequest = {
        slotId: openingId,
        medicalGroupName: "Test Group",
        patient: { firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", dateOfBirth: "1950-01-02", ngePersonId: "person-1" },
        replacedAppointment: { ngeAppointmentId: "appt-1", date: "2041-03-20" },
        callRef,
      };
      const r = await client.book(req);
      return r.ok ? { ok: true, bookingId: r.bookingId, confirmation: "You're booked." } : { ok: false, error: r.error };
    },
  };
  const policy: OutboundLanePolicy = {
    campaignKey: "test-campaign",
    enableEnv: "X",
    callerIdEnv: "Y",
    window: DEFAULT_CALLING_WINDOW,
    caps: DEFAULT_ATTEMPT_CAPS,
    concurrency: 1,
    greeting: () => "Hello.",
    voicemail: () => "Hello.",
    source: async () => source,
    textOutreach: { enableEnv: "Z", perTick: 1, body: (l) => l, page: lane },
  };
  deps = {
    store: async () => store,
    policyFor: async (slug) => (slug === "test-lane" ? policy : null),
    now: () => NOW,
    log: () => undefined,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the corpus: 32 patients who confirmed their date of birth on the link", () => {
  it("every one books, and NPX receives a reference it accepts", async () => {
    let booked = 0;
    for (const id of CORPUS) {
      const token = seedContact(id);
      const verified = await step(token, "verify", DOB);
      expect(verified.ok).toBe(true);
      const r = await step(token, "book", { session: verified.session, id: "slot-a" });
      if (r.ok === true) booked++;
    }
    expect(booked).toBe(CORPUS.length);
    expect(npx.sent).toHaveLength(CORPUS.length);
    for (const body of npx.sent) expect(String(body.callRef)).toMatch(NPX_SCHEMA_CALL_REF);
  });

  it("the reference still names the contact, so a booking can be traced to its row", async () => {
    const token = seedContact(CORPUS[0]);
    const verified = await step(token, "verify", DOB);
    await step(token, "book", { session: verified.session, id: "slot-a" });
    expect(npx.sent[0].callRef).toBe(`text-link-${CORPUS[0]}`);
  });
});

describe("the reference", () => {
  it("fits NPX's rule for every contact id shape, inside 64 characters", () => {
    for (const id of CORPUS) {
      const ref = textLinkCallRef(id);
      expect(ref).toMatch(NPX_SCHEMA_CALL_REF);
      expect(ref.length).toBeLessThanOrEqual(64);
    }
  });

  it("the client's pinned rule is NPX's rule", () => {
    expect(NPX_CALL_REF.source).toBe(NPX_SCHEMA_CALL_REF.source);
    expect(NPX_CALL_REF.flags).toBe(NPX_SCHEMA_CALL_REF.flags);
  });
});

describe("a reference NPX would refuse never costs the booking", () => {
  const BOOK: NpxBookRequest = {
    slotId: "slot-a",
    medicalGroupName: "Test Group",
    patient: { firstName: "Testa", lastName: "Synthetic", dateOfBirth: "1950-01-02", ngePersonId: "person-1" },
    replacedAppointment: { ngeAppointmentId: "appt-1", date: "2041-03-20" },
  };
  const client = () => createNpxOutreachClient({ NPX_OUTREACH_API_KEY: "test-key" }, npx.f as never);

  it.each([
    ["the v211 shape", "text-link:00000000-0000-4000-8000-000000000001"],
    ["a space", "has a space"],
    ["too long", "x".repeat(65)],
    ["empty", ""],
  ])("%s: the reference is left off and the booking goes", async (_label, callRef) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await client().book({ ...BOOK, callRef });
    expect(r).toMatchObject({ ok: true, bookingId: "booking-1" });
    expect(npx.sent[0]).not.toHaveProperty("callRef");
  });

  it("a reference NPX accepts is sent as it is", async () => {
    const r = await client().book({ ...BOOK, callRef: "CA0123456789abcdef0123456789abcdef" });
    expect(r).toMatchObject({ ok: true });
    expect(npx.sent[0].callRef).toBe("CA0123456789abcdef0123456789abcdef");
  });

  it("no reference sends none", async () => {
    await client().book(BOOK);
    expect(npx.sent[0]).not.toHaveProperty("callRef");
  });

  it("the warning names no patient and no reference", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await client().book({ ...BOOK, callRef: "text-link:00000000-0000-4000-8000-000000000001" });
    const lines = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines).toContain("left off");
    expect(lines).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(lines).not.toContain("Testa");
    expect(lines).not.toContain("1950");
  });
});
