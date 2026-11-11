/**
 * v211: the booking page the outreach text links to, in four steps — the
 * date of birth, a day and a city, a time, confirm. Operator, 2026-11-11:
 * "they should get a customized link that lets them book in 4 easy steps."
 *
 * Nothing from the record before the date of birth matches; two tries per
 * link, then locked for good; a wrong or used link learns nothing; the
 * appointment is re-checked before anything is booked. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactSource, OutboundLanePolicy, SourceRecheck } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import {
  EXPIRED_PAGE,
  LINK_DOB_TRIES,
  LINK_REQUEST_LIMIT,
  LINK_SESSION_MS,
  STEPS_PAGE,
  cleanToken,
  handleBookingPage,
  handleBookingStep,
  resetLinkLimitsForTests,
  type BookingOpening,
  type BookingPageDeps,
  type BookingPageLane,
} from "./bookingPage";
import { OUTREACH_TEXT_KEY, hashBookingToken, newBookingToken, textRecordOf, type OutreachTextRecord } from "./outreachText";
import { FakeOutboundStore } from "./store.testkit";

const NOW = new Date("2041-03-05T18:00:00Z");
const DOB = { month: "1", day: "2", year: "1950" };
const RECORD_WORDS = ["Testa", "Synthetic", "2041-03-20", "Dilated", "Test Office", "1950", "Test Group"];

const OPENINGS: BookingOpening[] = [
  { id: "slot-a", day: "2041-02-04", dayLabel: "Monday, February 4", timeLabel: "9:00 AM", city: "Testville", place: "Partner One, 1 Test St, Testville", provider: "Dr Test" },
  { id: "slot-b", day: "2041-02-04", dayLabel: "Monday, February 4", timeLabel: "2:30 PM", city: "Testville", place: "Partner One, 1 Test St, Testville", provider: "Dr Test" },
  { id: "slot-c", day: "2041-02-04", dayLabel: "Monday, February 4", timeLabel: "10:00 AM", city: "Otherton", place: "Partner Two, 2 Test Ave, Otherton", provider: "Dr Other" },
  { id: "slot-d", day: "2041-02-06", dayLabel: "Wednesday, February 6", timeLabel: "8:30 AM", city: "Testville", place: "Partner One, 1 Test St, Testville", provider: "Dr Test" },
];

let store: FakeOutboundStore;
let token: string;
let lane: BookingPageLane & {
  openings: ReturnType<typeof vi.fn>;
  book: ReturnType<typeof vi.fn>;
  isDemo: ReturnType<typeof vi.fn>;
};
let recheck: ReturnType<typeof vi.fn<(externalRef: string, now: Date) => Promise<SourceRecheck>>>;
let policy: OutboundLanePolicy;
let now: Date;
let deps: BookingPageDeps;

function seed(over: Partial<OutreachTextRecord> = {}, contact: Partial<Parameters<FakeOutboundStore["addContact"]>[0]> = {}) {
  const t = newBookingToken();
  token = t.token;
  store.addContact({
    id: "c1",
    phone: "+15555550111",
    firstName: "Testa",
    lastName: "Synthetic",
    externalRef: "ref-c1",
    customData: {
      date_of_birth: "1950-01-02",
      appointment_date: "2041-03-20",
      event_name: "Dilated Exam",
      office: "Test Office",
      medical_group: "Test Group",
      [OUTREACH_TEXT_KEY]: {
        state: "sent",
        lane: "test-lane",
        token_hash: t.hash,
        claimed_at: NOW.toISOString(),
        sent_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
        ...over,
      },
    },
    ...contact,
  });
}

const rec = (): OutreachTextRecord => textRecordOf(store.contacts.get("c1")!.customData)!;
const step = (action: string, body: Record<string, unknown> = {}, tok = token) =>
  handleBookingStep(tok, action, body, deps).then((r) => ({ ...r, json: JSON.parse(r.body) as Record<string, unknown> }));
const verified = async () => {
  const r = await step("verify", DOB);
  expect(r.json.ok).toBe(true);
  return r.json.session as string;
};

beforeEach(() => {
  resetLinkLimitsForTests();
  now = NOW;
  store = new FakeOutboundStore(() => now);
  recheck = vi.fn(async (): Promise<SourceRecheck> => ({
    state: "current",
    contact: { externalRef: "ref-c1", phone: "+15555550199", firstName: "Testa", lastName: "Synthetic", data: {} },
  }));
  const source: ContactSource = { name: "test", refreshEveryMs: 1, parkMs: 1, list: async () => [], recheck };
  lane = {
    isDemo: vi.fn(() => true),
    currentAppointment: () => "a dilated eye exam on Wednesday, March 20",
    openings: vi.fn(async () => ({ openings: OPENINGS })),
    book: vi.fn(async () => ({ ok: true as const, bookingId: "booking-1", confirmation: "You're booked." })),
  };
  policy = {
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
    now: () => now,
    log: () => undefined,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the page", () => {
  it("serves the four steps for a good link, and nothing from the record", async () => {
    seed();
    const r = await handleBookingPage(token, deps);
    expect(r.status).toBe(200);
    expect(r.body).toBe(STEPS_PAGE);
    for (const word of RECORD_WORDS) expect(r.body).not.toContain(word);
    expect(r.body).toContain("Step 1 of 4: confirm your date of birth");
    expect(r.body).toContain("Step 2 of 4: choose a day and a city");
    expect(r.body).toContain("Step 3 of 4: choose a time");
    expect(r.body).toContain("Step 4 of 4: confirm");
  });

  it("is never cached, never sends the address onward, and is never indexed", async () => {
    seed();
    const r = await handleBookingPage(token, deps);
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(r.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(r.headers["X-Robots-Tag"]).toMatch(/noindex/);
    expect(r.headers["Content-Security-Policy"]).toMatch(/default-src 'none'/);
    expect(r.body).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("reads a link whose full stop a phone kept", async () => {
    seed();
    expect(cleanToken(`${token}.`)).toBe(token);
    expect((await handleBookingPage(`${token}.`, deps)).body).toBe(STEPS_PAGE);
  });

  it.each([
    ["a malformed token", () => "not-a-token"],
    ["an unknown token", () => newBookingToken().token],
  ])("says expired for %s", async (_label, make) => {
    seed();
    const r = await handleBookingPage(make(), deps);
    expect(r.body).toBe(EXPIRED_PAGE);
    expect(r.body).toContain("This link has expired");
  });

  it("says expired once the seven days are up", async () => {
    seed({ expires_at: new Date(NOW.getTime() - 1000).toISOString() });
    expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
  });

  it.each(["failed", "skipped", "retry"] as const)("says expired for a link that was never delivered (%s)", async (state) => {
    seed({ state });
    expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
  });

  it("says expired once the link has booked", async () => {
    seed({ booked_at: NOW.toISOString() });
    expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
  });

  it.each(["completed", "declined", "wrong_number", "do_not_call", "rescheduled"] as const)(
    "says expired for a contact who is %s",
    async (status) => {
      seed({}, { status });
      expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
    },
  );

  it("asks them to try again later while we are on a call with them", async () => {
    seed({}, { status: "calling" });
    const r = await handleBookingPage(token, deps);
    expect(r.body).not.toBe(STEPS_PAGE);
    expect(r.body).toContain("try again in a few minutes");
  });

  it("says expired for a lane that has no booking page", async () => {
    seed({ lane: "other-lane" });
    expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
  });

  it("stops a link that is used too often", async () => {
    seed();
    for (let i = 0; i < LINK_REQUEST_LIMIT; i++) await handleBookingPage(token, deps);
    const r = await handleBookingPage(token, deps);
    expect(r.status).toBe(429);
    expect(r.body).toContain("Please wait");
  });
});

describe("step 1: the date of birth", () => {
  it("opens the steps on a match, and only then says the appointment", async () => {
    seed();
    const r = await step("verify", DOB);
    expect(r.json).toMatchObject({ ok: true, current: "a dilated eye exam on Wednesday, March 20" });
    expect(String(r.json.session)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rec()).toMatchObject({ dob_tries: 1, verified_at: NOW.toISOString() });
    // The row keeps the session's hash, never the session.
    expect(rec().session_hash).toBe(hashBookingToken(String(r.json.session)));
  });

  it("accepts a zero-padded day and month", async () => {
    seed();
    expect((await step("verify", { month: "01", day: "02", year: "1950" })).json.ok).toBe(true);
  });

  it("says nothing from the record on a wrong date, and locks after two", async () => {
    seed();
    const first = await step("verify", { month: "1", day: "3", year: "1950" });
    expect(first.json).toEqual({ ok: false, error: "mismatch" });
    const second = await step("verify", { month: "2", day: "2", year: "1950" });
    expect(second.json).toEqual({ ok: false, error: "locked" });
    // A third, correct, date does not unlock it.
    expect((await step("verify", DOB)).json).toEqual({ ok: false, error: "locked" });
    expect(rec().dob_tries).toBe(LINK_DOB_TRIES);
    expect(rec().verified_at).toBeUndefined();
  });

  it("keeps the lock on a link that had verified once", async () => {
    seed();
    await verified();
    expect((await step("verify", { month: "5", day: "5", year: "1955" })).json).toEqual({ ok: false, error: "locked" });
    expect((await step("verify", DOB)).json).toEqual({ ok: false, error: "locked" });
  });

  it("lets a verified link verify again without spending a try", async () => {
    seed();
    await verified();
    await verified();
    await verified();
    expect(rec().dob_tries).toBe(1);
  });

  it("refuses a record with no date of birth", async () => {
    seed();
    const c = store.contacts.get("c1")!;
    delete c.customData.date_of_birth;
    expect((await step("verify", DOB)).json.ok).toBe(false);
  });

  it("refuses a year that is not a date", async () => {
    seed();
    expect((await step("verify", { month: "1", day: "2", year: "nineteen fifty" })).json).toEqual({ ok: false, error: "mismatch" });
  });
});

describe("steps 2 and 3: a day and a city, then a time", () => {
  it("shows nothing before the date of birth matches", async () => {
    seed();
    for (const action of ["days", "times", "book"]) {
      const r = await step(action, { session: "x".repeat(43), day: "2041-02-04", city: "Testville", id: "slot-a" });
      expect(r.json).toEqual({ ok: false, error: "session" });
    }
    expect(lane.openings).not.toHaveBeenCalled();
    expect(lane.book).not.toHaveBeenCalled();
  });

  it("lists each day once, with the cities that have openings, earliest first", async () => {
    seed();
    const session = await verified();
    const r = await step("days", { session });
    expect(r.json).toEqual({
      ok: true,
      days: [
        { day: "2041-02-04", label: "Monday, February 4", cities: ["Testville", "Otherton"] },
        { day: "2041-02-06", label: "Wednesday, February 6", cities: ["Testville"] },
      ],
    });
  });

  it("lists the times on that day in that city", async () => {
    seed();
    const session = await verified();
    const r = await step("times", { session, day: "2041-02-04", city: "Testville" });
    expect((r.json.times as Array<{ id: string }>).map((t) => t.id)).toEqual(["slot-a", "slot-b"]);
  });

  it("reads the demo the lane's way", async () => {
    seed();
    const session = await verified();
    await step("days", { session });
    expect(lane.isDemo).toHaveBeenCalledWith(expect.objectContaining({ contactId: "c1" }), "npx-outreach");
    expect(lane.openings).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("asks for the date of birth again once the session is old", async () => {
    seed();
    const session = await verified();
    now = new Date(NOW.getTime() + LINK_SESSION_MS + 1000);
    expect((await step("days", { session })).json).toEqual({ ok: false, error: "session" });
  });
});

describe("step 4: booking", () => {
  it("re-checks the appointment, books it, and the link is used up", async () => {
    seed();
    const session = await verified();
    const r = await step("book", { session, id: "slot-a" });
    expect(r.json).toEqual({ ok: true, confirmation: "You're booked." });
    expect(recheck).toHaveBeenCalledWith("ref-c1", NOW);
    expect(lane.book).toHaveBeenCalledWith(
      expect.objectContaining({
        demo: true,
        openingId: "slot-a",
        callRef: "text-link:c1",
        // Today's number from the source, as the dialler uses.
        contact: expect.objectContaining({ contactId: "c1", phone: "+15555550199" }),
      }),
    );
    expect(rec()).toMatchObject({ booked_at: NOW.toISOString(), booking_id: "booking-1" });
    expect((await handleBookingPage(token, deps)).body).toBe(EXPIRED_PAGE);
  });

  it("never books for an appointment that is over", async () => {
    seed();
    const session = await verified();
    recheck.mockResolvedValueOnce({ state: "gone" });
    expect((await step("book", { session, id: "slot-a" })).json).toEqual({ ok: false, error: "appointment_changed" });
    expect(lane.book).not.toHaveBeenCalled();
    expect(rec().booking_started_at).toBeNull();
  });

  it("books nothing when the source cannot answer", async () => {
    seed();
    const session = await verified();
    recheck.mockRejectedValueOnce(new Error("console down"));
    expect((await step("book", { session, id: "slot-a" })).json).toEqual({ ok: false, error: "busy" });
    expect(lane.book).not.toHaveBeenCalled();
  });

  it("books one at a time per link", async () => {
    seed();
    const session = await verified();
    let release!: () => void;
    lane.book.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, bookingId: "b1", confirmation: "ok" }))),
    );
    const first = step("book", { session, id: "slot-a" });
    await vi.waitFor(() => expect(lane.book).toHaveBeenCalledTimes(1));
    expect((await step("book", { session, id: "slot-b" })).json).toEqual({ ok: false, error: "busy" });
    release();
    expect((await first).json.ok).toBe(true);
    expect(lane.book).toHaveBeenCalledTimes(1);
  });

  it("says a taken slot was taken, and lets them choose again", async () => {
    seed();
    const session = await verified();
    lane.book.mockResolvedValueOnce({ ok: false, error: "slot_unavailable" });
    expect((await step("book", { session, id: "slot-a" })).json).toEqual({ ok: false, error: "taken" });
    expect(rec().booking_started_at).toBeNull();
    expect((await step("book", { session, id: "slot-b" })).json.ok).toBe(true);
  });

  it("says nothing was changed when NPX would not book it", async () => {
    seed();
    const session = await verified();
    lane.book.mockResolvedValueOnce({ ok: false, error: "record_incomplete" });
    expect((await step("book", { session, id: "slot-a" })).json).toEqual({ ok: false, error: "not_booked" });
    expect(rec().booked_at).toBeUndefined();
  });

  it("does not book while we are on a call with them", async () => {
    seed();
    const session = await verified();
    store.contacts.get("c1")!.status = "calling";
    expect((await step("book", { session, id: "slot-a" })).json).toEqual({ ok: false, error: "busy" });
    expect(lane.book).not.toHaveBeenCalled();
  });
});
