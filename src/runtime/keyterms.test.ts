import { describe, it, expect } from "vitest";
import {
  selectKeyterms,
  speakableName,
  MAX_KEYTERMS,
  MAX_KEYTERM_CHARS,
  type Vocabulary,
} from "./keyterms";

const vocab = (over: Partial<Vocabulary> = {}): Vocabulary => ({
  providers: [],
  locations: [],
  medications: [],
  ...over,
});

const entries = (...pairs: [string, number][]) =>
  pairs.map(([canonical, volume90d]) => ({ canonical, volume90d }));

describe("speakableName", () => {
  it("drops credentials nobody says out loud", () => {
    expect(speakableName("Talin Khachatoor Sarkissian, O.D.")).toBe("Talin Khachatoor Sarkissian");
    expect(speakableName("Timothy Hammill, M.D.")).toBe("Timothy Hammill");
    expect(speakableName("Jane Roe, Ph.D.")).toBe("Jane Roe");
    expect(speakableName("John Doe, F.A.C.S.")).toBe("John Doe");
  });

  it("drops a leading honorific — 'Dr' needs no help on these calls", () => {
    expect(speakableName("Dr. Timothy Hammill")).toBe("Timothy Hammill");
    expect(speakableName("Doctor Jane Roe")).toBe("Jane Roe");
  });

  it("leaves a plain name alone", () => {
    expect(speakableName("Encinitas")).toBe("Encinitas");
  });
});

describe("ranking", () => {
  it("puts the busiest names first — a surgeon nobody has seen is not worth a slot", () => {
    const r = selectKeyterms(
      vocab({ providers: entries(["Quiet Doctor", 0], ["Busy Doctor", 900], ["Middling Doctor", 40]) }),
      "surgery",
    );
    expect(r).toEqual(["Busy Doctor", "Middling Doctor", "Quiet Doctor"]);
  });

  it("breaks ties alphabetically, so two runs of one snapshot agree", () => {
    const r = selectKeyterms(vocab({ providers: entries(["Zeta", 5], ["Alpha", 5]) }), "surgery");
    expect(r).toEqual(["Alpha", "Zeta"]);
  });
});

describe("lane priority", () => {
  const full = vocab({
    providers: entries(["Surgeon Name", 100]),
    locations: entries(["Encinitas", 100]),
    medications: ["latanoprost"],
  });

  it("surgery leads on surgeons — the queue is assigned by surgeon", () => {
    expect(selectKeyterms(full, "surgery")![0]).toBe("Surgeon Name");
  });

  it("optical leads on locations — the queue is assigned by location", () => {
    expect(selectKeyterms(full, "optical")![0]).toBe("Encinitas");
  });

  it("tech leads on medications — it is the medication queue", () => {
    expect(selectKeyterms(full, "tech")![0]).toBe("latanoprost");
  });

  it("an unknown lane still gets a sensible list rather than nothing", () => {
    expect(selectKeyterms(full, "fantasy-football")).toBeTruthy();
  });
});

describe("the API's caps", () => {
  it("never sends more than 100 terms", () => {
    const many = entries(...Array.from({ length: 250 }, (_, i) => [`Name ${i}`, 250 - i] as [string, number]));
    const r = selectKeyterms(vocab({ providers: many }), "surgery")!;
    expect(r).toHaveLength(MAX_KEYTERMS);
    // And it kept the BUSIEST hundred, not the first hundred it happened to see.
    expect(r[0]).toBe("Name 0");
    expect(r).not.toContain("Name 200");
  });

  it("skips a term over 50 characters instead of spending a slot on one the API drops", () => {
    const long = "L".repeat(MAX_KEYTERM_CHARS + 1);
    const r = selectKeyterms(vocab({ providers: entries([long, 900], ["Short Name", 1]) }), "surgery");
    expect(r).toEqual(["Short Name"]);
  });

  it("keeps a term of exactly 50 characters — the cap is inclusive", () => {
    const exact = "E".repeat(MAX_KEYTERM_CHARS);
    expect(selectKeyterms(vocab({ providers: entries([exact, 1]) }), "surgery")).toEqual([exact]);
  });

  it("dedupes case-insensitively across sources — one slot per real term", () => {
    const r = selectKeyterms(
      vocab({ providers: entries(["Encinitas", 5]), locations: entries(["encinitas", 9]) }),
      "optical",
    );
    expect(r).toHaveLength(1);
  });

  it("drops blanks rather than sending an empty keyterm", () => {
    expect(selectKeyterms(vocab({ providers: entries(["   ", 9], ["Real", 1]) }), "surgery")).toEqual(["Real"]);
  });
});

describe("nothing to send", () => {
  it("returns undefined, not an empty array", () => {
    // The field is then omitted entirely. An empty array is a claim that the
    // practice has no vocabulary; undefined is "the directory was unreachable".
    expect(selectKeyterms(vocab(), "surgery")).toBeUndefined();
  });
});

describe("no PHI can reach a keyterm", () => {
  it("carries only practice reference data — nothing patient-shaped", () => {
    const r = selectKeyterms(
      vocab({ providers: entries(["Timothy Hammill, M.D.", 10]), locations: entries(["Encinitas", 9]) }),
      "surgery",
    )!;
    // No digits at all: a date of birth, a phone number or a record id would
    // all carry them, and none of those belong in a transcription hint.
    for (const term of r) expect(term).not.toMatch(/\d/);
  });
});
