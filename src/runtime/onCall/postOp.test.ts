import { describe, expect, it, vi } from "vitest";
import {
  CONSOLE_UNAVAILABLE_NOTE,
  NO_IDENTITY_NOTE,
  POST_OP_SQL,
  SURGERY_EVENTS,
  daysBetween,
  decidePostOp,
  matchSurgeon,
  nameKeyForMatch,
  postOpRouteFor,
  readSurgeryFacts,
  type SurgeryFact,
} from "./postOp";
import { provider } from "./testRotation";

// Synthetic surgeons only. The Console's names are staff data and stay out of git.
const SURGEON = provider(10, "Inland Empire", { fullName: "Ada Quill", npi: "1000000010" });
const OTHER = provider(11, "Los Angeles", { fullName: "Ben Quarry", npi: "1000000011" });
const RESTING = provider(12, "Orange County", { fullName: "Cora Vale", npi: "1000000012", active: false });
const POOL = [SURGEON, OTHER, RESTING];

const TODAY = "2026-12-10";

function surgery(over: Partial<SurgeryFact> = {}): SurgeryFact {
  return {
    date: "2026-12-05",
    eventName: "Surgery",
    kept: true,
    cancelled: false,
    rescheduled: false,
    providerNpi: "1000000010",
    providerName: "Ada Quill, MD",
    ...over,
  };
}

describe("the 7-day window", () => {
  it("routes a surgery 7 days ago to the surgeon", () => {
    const d = decidePostOp([surgery({ date: "2026-12-03" })], TODAY, POOL);
    expect(d).toMatchObject({ route: "surgeon", provider: { id: 10 }, daysAgo: 7, surgeryDate: "2026-12-03" });
  });

  it("routes a surgery 8 days ago to the on-call provider, with nothing uncertain to say", () => {
    const d = decidePostOp([surgery({ date: "2026-12-02" })], TODAY, POOL);
    expect(d).toEqual({ route: "on_call", reason: "no_recent_surgery" });
  });

  it("routes a surgery today to the surgeon", () => {
    expect(decidePostOp([surgery({ date: TODAY })], TODAY, POOL)).toMatchObject({ route: "surgeon", daysAgo: 0 });
  });

  it("does not count a surgery booked for the future", () => {
    expect(decidePostOp([surgery({ date: "2026-12-11" })], TODAY, POOL)).toMatchObject({ route: "on_call", reason: "no_recent_surgery" });
  });

  it("counts days across a month and a year", () => {
    expect(daysBetween("2026-12-29", "2027-01-05")).toBe(7);
    expect(daysBetween("2027-02-26", "2027-03-05")).toBe(7);
    expect(decidePostOp([surgery({ date: "2026-12-29" })], "2027-01-05", POOL)).toMatchObject({ route: "surgeon", daysAgo: 7 });
    expect(decidePostOp([surgery({ date: "2026-12-28" })], "2027-01-05", POOL)).toMatchObject({ route: "on_call" });
  });
});

describe("which rows count", () => {
  it("counts every surgery event and nothing else", () => {
    for (const eventName of SURGERY_EVENTS) {
      expect(decidePostOp([surgery({ eventName })], TODAY, POOL).route).toBe("surgeon");
    }
    for (const eventName of ["CoManaged Surgery", "YAG", "SLT", "Avastin Injection", "Minor Procedure", "Post-Op YAG", "Bleph Consult"]) {
      expect(decidePostOp([surgery({ eventName })], TODAY, POOL)).toMatchObject({ route: "on_call", reason: "no_recent_surgery" });
    }
  });

  it("does not count a cancelled surgery", () => {
    expect(decidePostOp([surgery({ cancelled: true })], TODAY, POOL)).toMatchObject({ route: "on_call", reason: "no_recent_surgery" });
  });

  it("does not count a surgery that was moved and not kept", () => {
    expect(decidePostOp([surgery({ rescheduled: true, kept: false })], TODAY, POOL)).toMatchObject({ route: "on_call", reason: "no_recent_surgery" });
  });

  it("counts a surgery that was kept even when its reschedule flag is set", () => {
    expect(decidePostOp([surgery({ rescheduled: true, kept: true })], TODAY, POOL)).toMatchObject({ route: "surgeon", kept: true });
  });

  it("uses the most recent surgery", () => {
    const d = decidePostOp(
      [surgery({ date: "2026-12-04", providerNpi: "1000000011", providerName: "Ben Quarry, M.D." }), surgery({ date: "2026-12-08" })],
      TODAY,
      POOL,
    );
    expect(d).toMatchObject({ route: "surgeon", provider: { id: 10 }, surgeryDate: "2026-12-08" });
  });

  it("ignores a cancelled later row when an earlier one stands", () => {
    const d = decidePostOp([surgery({ date: "2026-12-09", cancelled: true, providerNpi: "1000000011" }), surgery({ date: "2026-12-06" })], TODAY, POOL);
    expect(d).toMatchObject({ route: "surgeon", provider: { id: 10 }, surgeryDate: "2026-12-06" });
  });
});

describe("not yet kept", () => {
  it("routes a booked surgery not yet marked kept to the surgeon, and says so", () => {
    const d = decidePostOp([surgery({ kept: false })], TODAY, POOL);
    expect(d).toMatchObject({ route: "surgeon", provider: { id: 10 }, kept: false });
    expect(d.note).toContain("not yet marked kept");
  });

  it("treats an unknown kept flag as not yet kept", () => {
    expect(decidePostOp([surgery({ kept: null })], TODAY, POOL)).toMatchObject({ route: "surgeon", kept: false });
  });

  it("routes it to on-call when kept is required, and says so", () => {
    const d = decidePostOp([surgery({ kept: false })], TODAY, POOL, { requireKept: true });
    expect(d).toMatchObject({ route: "on_call", reason: "surgery_not_kept" });
    expect(d.note).toContain("not marked kept");
    expect(d.note).toContain("Ada Quill");
  });

  it("a kept surgery carries no note", () => {
    const d = decidePostOp([surgery()], TODAY, POOL, { requireKept: true });
    expect(d).toMatchObject({ route: "surgeon", kept: true });
    expect(d.note).toBeUndefined();
  });
});

describe("the surgeon", () => {
  it("two surgeons on the latest date goes to on-call, naming both", () => {
    const d = decidePostOp(
      [surgery(), surgery({ providerNpi: "1000000011", providerName: "Ben Quarry, MD" })],
      TODAY,
      POOL,
    );
    expect(d).toMatchObject({ route: "on_call", reason: "surgeon_unclear" });
    expect(d.note).toContain("Ada Quill, MD");
    expect(d.note).toContain("Ben Quarry, MD");
  });

  it("two rows for one surgeon on one date is one surgeon", () => {
    expect(decidePostOp([surgery(), surgery({ eventName: "Lasik Enhancement", kept: false })], TODAY, POOL)).toMatchObject({ route: "surgeon", kept: true });
  });

  it("a row with no surgeon at all goes to on-call", () => {
    const d = decidePostOp([surgery({ providerNpi: null, providerName: null })], TODAY, POOL);
    expect(d).toMatchObject({ route: "on_call", reason: "surgeon_unclear" });
    expect(d.note).toContain("an unnamed surgeon");
  });

  it("a surgeon not in the on-call list goes to on-call, naming them", () => {
    const d = decidePostOp([surgery({ providerNpi: "1999999999", providerName: "Dee Outsider, DO" })], TODAY, POOL);
    expect(d).toMatchObject({ route: "on_call", reason: "surgeon_not_in_pool" });
    expect(d.note).toContain("Dee Outsider, DO");
  });

  it("an inactive surgeon goes to on-call", () => {
    const d = decidePostOp([surgery({ providerNpi: "1000000012", providerName: "Cora Vale, MD" })], TODAY, POOL);
    expect(d).toMatchObject({ route: "on_call", reason: "surgeon_inactive" });
    expect(d.note).toContain("inactive");
  });

  it("matches by NPI before the name", () => {
    expect(matchSurgeon({ providerNpi: "1000000011", providerName: "Ada Quill, MD" }, POOL)?.id).toBe(11);
  });

  it("falls back to the name when there is no NPI, or the NPI is not in the list", () => {
    expect(matchSurgeon({ providerNpi: null, providerName: "Ada Quill, M.D." }, POOL)?.id).toBe(10);
    expect(matchSurgeon({ providerNpi: "1999999999", providerName: "Dr. Ada M. Quill, MD" }, POOL)?.id).toBe(10);
  });

  it("does not match a name two list rows share", () => {
    const twins = [SURGEON, provider(13, "Los Angeles", { fullName: "Ada Quill", npi: null })];
    expect(matchSurgeon({ providerNpi: null, providerName: "Ada Quill, MD" }, twins)).toBeNull();
  });

  it("does not match on a first name alone", () => {
    expect(matchSurgeon({ providerNpi: null, providerName: "Ada" }, POOL)).toBeNull();
  });
});

describe("name keys", () => {
  it("drops titles, degrees, initials, punctuation and accents", () => {
    expect(nameKeyForMatch("Dr. Ada M. Quill, MD")).toBe("ada quill");
    expect(nameKeyForMatch("Ada Quill, M.D.")).toBe("ada quill");
    expect(nameKeyForMatch("Doctor Ada Quill")).toBe("ada quill");
    expect(nameKeyForMatch("Ádá Quíll, DO")).toBe("ada quill");
  });

  it("keeps a hyphenated surname whole", () => {
    expect(nameKeyForMatch("Ada Quill-Vane, MD")).toBe("ada quill-vane");
    expect(nameKeyForMatch("Ada Quill-Vane, MD")).not.toBe(nameKeyForMatch("Ada Vane, MD"));
  });

  it("answers nothing for a blank or one-word name", () => {
    expect(nameKeyForMatch(null)).toBeNull();
    expect(nameKeyForMatch("")).toBeNull();
    expect(nameKeyForMatch("Quill")).toBeNull();
  });
});

describe("reading the Console", () => {
  it("binds the person, the window and the events, every one typed", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await readSurgeryFacts(query, "11111111-1111-1111-1111-111111111111", TODAY);
    expect(query).toHaveBeenCalledWith(POST_OP_SQL, ["11111111-1111-1111-1111-111111111111", "2026-12-03", TODAY, SURGERY_EVENTS]);
    expect(POST_OP_SQL).toContain("$1::uuid");
    expect(POST_OP_SQL).toContain("$2::date");
    expect(POST_OP_SQL).toContain("$3::date");
    expect(POST_OP_SQL).toContain("$4::text[]");
    expect(POST_OP_SQL).toContain("to_char(f.appointment_date, 'YYYY-MM-DD')");
  });

  it("maps rows, keeping an unknown kept flag unknown", async () => {
    const query = async () => ({
      rows: [
        { date: "2026-12-05", event_name: "Surgery", is_kept: null, is_cancelled: false, is_rescheduled: false, npi: "1000000010", nextgen_name: "Ada Quill, MD" },
      ],
    });
    expect(await readSurgeryFacts(query, "p", TODAY)).toEqual([surgery({ kept: null })]);
  });
});

describe("the whole check", () => {
  const base = { today: TODAY, providers: POOL, budgetMs: 200 };

  it("with no confirmed patient, goes to on-call and says why", async () => {
    const query = vi.fn();
    const d = await postOpRouteFor({ ...base, personId: undefined, query });
    expect(d).toEqual({ route: "on_call", reason: "no_identity", note: NO_IDENTITY_NOTE });
    expect(query).not.toHaveBeenCalled();
  });

  it("with no Console, goes to on-call and says why", async () => {
    expect(await postOpRouteFor({ ...base, personId: "p", query: null })).toMatchObject({ reason: "console_unavailable", note: CONSOLE_UNAVAILABLE_NOTE });
  });

  it("when the Console throws, goes to on-call and says why", async () => {
    const query = async () => {
      throw new Error("down");
    };
    expect(await postOpRouteFor({ ...base, personId: "p", query })).toMatchObject({ reason: "console_unavailable" });
  });

  it("when the Console is slower than the budget, goes to on-call and says why", async () => {
    vi.useFakeTimers();
    try {
      const query = () => new Promise<{ rows: any[] }>(() => {});
      const pending = postOpRouteFor({ ...base, personId: "p", query });
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toMatchObject({ reason: "console_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes to the surgeon from the Console's rows", async () => {
    const query = async () => ({
      rows: [{ date: "2026-12-04", event_name: "Surgery", is_kept: true, is_cancelled: false, is_rescheduled: false, npi: "1000000010", nextgen_name: "Ada Quill, MD" }],
    });
    expect(await postOpRouteFor({ ...base, personId: "p", query })).toMatchObject({ route: "surgeon", provider: { id: 10 }, daysAgo: 6 });
  });

  it("passes the kept lever through", async () => {
    const query = async () => ({
      rows: [{ date: "2026-12-09", event_name: "Surgery", is_kept: false, is_cancelled: false, is_rescheduled: false, npi: "1000000010", nextgen_name: "Ada Quill, MD" }],
    });
    expect(await postOpRouteFor({ ...base, personId: "p", query, requireKept: true })).toMatchObject({ reason: "surgery_not_kept" });
    expect(await postOpRouteFor({ ...base, personId: "p", query })).toMatchObject({ route: "surgeon" });
  });
});
