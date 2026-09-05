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

/**
 * THE HUNDRED SLOTS WERE BEING SPENT ENTIRELY ON THE FIRST SOURCE.
 *
 * Measured 2026-09-05 against the real directory sizes (77 providers, 105
 * locations). `selectKeyterms` drained each source completely before starting
 * the next, so any lane whose first source is bigger than MAX_KEYTERMS never
 * reached its second:
 *
 *   optical            meds   0  providers   0  locations 100
 *   records            meds   0  providers   0  locations 100
 *   answering-service  meds   0  providers   0  locations 100
 *
 * Three of five configured lanes sent ZERO provider names, and
 * answering-service declared `medications` in its order and had never sent
 * one. Nothing failed and nothing logged — the lane just could not hear a
 * surgeon's name.
 *
 * The marginal value is not flat: the 60th-busiest office is worth far less
 * to a transcriber than the busiest surgeon, because both lists are ranked by
 * real volume and both have long tails. So the slots are drawn round-robin
 * across the lane's sources, in priority order within each round. Priority
 * still decides who is served first when a round runs out; it no longer
 * decides who is served at all.
 */
describe("every source a lane declares actually gets slots", () => {
  const providers = Array.from({ length: 77 }, (_, i) => ({
    canonical: `Provider ${i}, M.D.`,
    volume90d: 1000 - i,
  }));
  const locations = Array.from({ length: 105 }, (_, i) => ({
    canonical: `Office ${i}`,
    volume90d: 1000 - i,
  }));
  const medications = Array.from({ length: 45 }, (_, i) => `Drug${i}`);
  const vocab = { providers, locations, medications };

  const shareOf = (terms: string[]) => ({
    meds: terms.filter((t) => t.startsWith("Drug")).length,
    providers: terms.filter((t) => t.startsWith("Provider")).length,
    locations: terms.filter((t) => t.startsWith("Office")).length,
  });

  it.each([
    ["optical", ["locations", "providers"]],
    ["records", ["locations", "providers"]],
    ["answering-service", ["medications", "locations", "providers"]],
    ["no-ivr", ["medications", "providers", "locations"]],
    ["tech", ["medications", "providers", "locations"]],
    ["surgery", ["providers", "locations"]],
  ] as const)("%s sends some of every source it declares", (lane, declared) => {
    const terms = selectKeyterms(vocab, lane) ?? [];
    expect(terms.length).toBe(MAX_KEYTERMS);
    const share = shareOf(terms);
    for (const source of declared) {
      const got = source === "medications" ? share.meds : share[source];
      expect(got, `${lane} declares ${source} and must send some`).toBeGreaterThan(0);
    }
  });

  it("keeps the highest-volume entries, not an arbitrary slice", () => {
    // Round-robin must still draw each source in its own ranked order, so the
    // busiest provider is always in and the 77th never displaces it.
    const terms = selectKeyterms(vocab, "surgery") ?? [];
    expect(terms).toContain("Provider 0");
    expect(terms).not.toContain("Provider 76");
  });

  it("still honours priority when the rounds run out", () => {
    // surgery leads with providers, so it must hold more provider slots than
    // location slots — the order still means something.
    const share = shareOf(selectKeyterms(vocab, "surgery") ?? []);
    expect(share.providers).toBeGreaterThan(share.locations);
  });

  it("a source with nothing in it does not strand the others", () => {
    const terms = selectKeyterms({ providers, locations, medications: [] }, "tech") ?? [];
    expect(terms.length).toBe(MAX_KEYTERMS);
    const share = shareOf(terms);
    expect(share.meds).toBe(0);
    expect(share.providers).toBeGreaterThan(0);
    expect(share.locations).toBeGreaterThan(0);
  });
});
