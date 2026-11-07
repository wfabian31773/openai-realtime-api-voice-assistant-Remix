/**
 * v185 — A CALLER FROM A BUSINESS IS NOT ASKED WHETHER THEY ARE A NEW PATIENT.
 *
 * Operator, 2026-11-07: "go ahead and skip new-or-existing for business
 * callers."
 *
 * THE CORPUS, measured on the Hub: optical, surgery and tech, 2026-10-24..11-06,
 * substantive calls (duration >= 30) on which the agent asked "Are you a new
 * patient or an existing patient?". 652 calls; 90 were a business calling about
 * a patient (tech 83, surgery 5, optical 2); 73 of the 90 answered the question
 * by naming their business; 13 were asked it two or three times. 28 left no
 * ticket of any provenance (each SID checked in the Support Center). Those 28,
 * and the 5 more that were asked twice and filed, are below. The transcripts
 * stay on disk and in call_logs (RULE THREE); what is here is the SID, the lane,
 * how many times the question was asked, whether the call filed, and the kind
 * of business the caller named — the shape, with a synthetic answer in that
 * shape.
 *
 * WHAT THIS CAN AND CANNOT PROVE. The ask is prompt text: whether the model
 * obeys it is the after-number, not a test. What is pinned is the text the
 * model receives — that it names every kind of business in the corpus, that the
 * exception comes BEFORE the question (the v29 lesson: a model reading in order
 * meets the instruction before its carve-out otherwise), that an answer naming a
 * business stops the re-ask, and that the reader still finds no patient status
 * in such an answer, so nothing a business caller says suppresses a lookup.
 */
import { describe, it, expect } from "vitest";
import { NEW_OR_EXISTING_ASK, withNewOrExistingAsk } from "./newOrExistingAsk";
import { readPatientStatus } from "../tools/spokenPatientStatus";

type Kind = "pharmacy" | "health plan" | "doctor's office" | "provider's office" | "clinic" | "office";

interface Case {
  sid: string;
  lane: "optical" | "surgery" | "tech";
  asked: number;
  filed: boolean;
  kind: Kind;
}

const CORPUS: readonly Case[] = [
  // No ticket of any provenance.
  { sid: "CA97fa35d03020cf3cf00f0b477c7e00a9", lane: "tech", asked: 3, filed: false, kind: "pharmacy" },
  { sid: "CA8d90cc05c81c433e59b13875085be073", lane: "surgery", asked: 2, filed: false, kind: "provider's office" },
  { sid: "CA9e88bd1568c84919eb7cbf0e83b834f3", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CAdebfeb70b15dc087538f6b78823d9a25", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CA581087e4f4e3032a348e9eb1682a8500", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CA9d1c06a458a53a44eaa91dde13fa6ba7", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CA3ddcee0422a3d23c85d2cf715e72f34d", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CA0de0be58bd9c5f31e8ba96f4ff74a26f", lane: "tech", asked: 2, filed: false, kind: "pharmacy" },
  { sid: "CA4d8d45f3a6c65d13172d7ad9d33b568a", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAca3d92fc25505401d726da4c85a679cc", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA56a3a4c6abd4f89253428438c6b38104", lane: "tech", asked: 1, filed: false, kind: "provider's office" },
  { sid: "CAa6a8a9617c331e66db3ff6fd7e993e33", lane: "tech", asked: 1, filed: false, kind: "doctor's office" },
  { sid: "CAece0663c9bcf6e2e45288b87113be7e5", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAb7837849be22ff197044c8c2263c0048", lane: "surgery", asked: 1, filed: false, kind: "office" },
  { sid: "CA077b5d460b20ada47c940ad9de9b1be1", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA414a70ec90f98f3c4e958d20a1d5e7c9", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA396c725c37abf79b87f14fe9d9deba76", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAaa2396b71203a1f50a187c85d1fa5462", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAe8a14e6374cd46b18c36f91a49e6b6a5", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA4122f2f289c82d646cb5b4b4de9f90a5", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAd0773a6e83b0fb7d80df008405547d8f", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA1b82c767b88cd445bd3564d41e2e790d", lane: "surgery", asked: 1, filed: false, kind: "provider's office" },
  { sid: "CAaf114f4c3ec25b50ee2c905fe800a414", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CAc51941add769add23901029932dc64ea", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA2bf43c69c0749b5e38bcd591d7d611d2", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA54f7ff048d87c59c9a2cf8bb609c66a5", lane: "tech", asked: 1, filed: false, kind: "pharmacy" },
  { sid: "CA106bbc6920a8baf77357b0b08c9a1812", lane: "surgery", asked: 1, filed: false, kind: "clinic" },
  { sid: "CA4154d3a0b5183c02d1fab19cf83a5c59", lane: "tech", asked: 1, filed: false, kind: "health plan" },
  // Filed, after being asked two or three times.
  { sid: "CAcd512d83066541478f2a378d6c84be3d", lane: "tech", asked: 3, filed: true, kind: "pharmacy" },
  { sid: "CA71d9b6af768209a1f407e9ce5bec8d33", lane: "tech", asked: 2, filed: true, kind: "pharmacy" },
  { sid: "CA0682043b8ea3688958c5f22d63139f47", lane: "tech", asked: 2, filed: true, kind: "pharmacy" },
  { sid: "CAed6da4086405077c69c80853b77b5025", lane: "tech", asked: 2, filed: true, kind: "pharmacy" },
  { sid: "CAc19f841b37fb20435dad1f6b672225f5", lane: "tech", asked: 2, filed: true, kind: "pharmacy" },
];

/** The answer each kind gave, in its shape. Synthetic: no names, no numbers. */
const ANSWER: Record<Kind, string> = {
  pharmacy: "Pharmacy.",
  "health plan": "I'm calling from the health plan.",
  "doctor's office": "This is the doctor's office.",
  "provider's office": "Provider's office.",
  clinic: "I'm calling from a medical clinic about a patient.",
  office: "I'm calling from the office about a patient.",
};

const QUESTION = "Are you a new patient or an existing patient?";
const ask = NEW_OR_EXISTING_ASK;
const questionAt = ask.indexOf(`"${QUESTION}"`);
const exceptionEnd = ask.indexOf("Everyone else:");

describe("v185 — the corpus is what the measurement says it is", () => {
  it("28 left no ticket, 13 were asked more than once, every call a canonical SID", () => {
    expect(CORPUS).toHaveLength(33);
    expect(CORPUS.filter((c) => !c.filed)).toHaveLength(28);
    expect(CORPUS.filter((c) => c.asked >= 2)).toHaveLength(13);
    expect(new Set(CORPUS.map((c) => c.sid)).size).toBe(CORPUS.length);
    for (const c of CORPUS) expect(c.sid).toMatch(/^CA[0-9a-f]{32}$/);
  });
});

describe("v185 — a caller from a business is not asked new-or-existing", () => {
  it("the question is still in the prompt, for everyone else", () => {
    expect(questionAt).toBeGreaterThan(-1);
    for (const lane of ["optical", "surgery", "tech"]) {
      expect(withNewOrExistingAsk("Prompt.", lane, false)).toContain(QUESTION);
    }
  });

  it("the exception comes BEFORE the question, not after it", () => {
    // The v29 lesson: the carve-out stated after the instruction is met after
    // the model has already been told to ask.
    expect(exceptionEnd).toBeGreaterThan(-1);
    expect(exceptionEnd).toBeLessThan(questionAt);
    expect(ask.slice(0, exceptionEnd)).toMatch(/never ask them whether they are new or existing/);
  });

  it("names, before the question, every kind of business in the corpus", () => {
    const exception = ask.slice(0, exceptionEnd).toLowerCase();
    const named: Record<Kind, RegExp> = {
      pharmacy: /\bpharmacy\b/,
      "health plan": /\bhealth plan\b/,
      "doctor's office": /\bdoctor's\b[^—]*\boffice\b/,
      "provider's office": /\bprovider's office\b/,
      clinic: /\bclinic\b/,
      office: /\boffice\b/,
    };
    for (const c of CORPUS) {
      expect(exception, `${c.sid}: ${c.kind}`).toMatch(named[c.kind]);
    }
    // And the kinds the operator approved that the 14 days did not happen to
    // carry: an insurer, a hospital, a lab, a medical group.
    for (const word of ["insurer", "hospital", "lab", "medical group"]) {
      expect(exception).toContain(word);
    }
  });

  it("a business named in ANSWER to the question ends the asking", () => {
    // 73 of the 90 said where they were calling from only when asked. The
    // clause that stops the second and third asks sits after the question,
    // because it is about the answer to it.
    const after = ask.slice(questionAt);
    expect(after).toMatch(/answer with a business[^.]*\(".+?"\)[^.]*do not ask again/);
  });

  it("does not stretch to a relative calling for a patient — that residue was accepted", () => {
    // Operator, 2026-09-21, on the proxy residue: "forget about that 1.2%".
    // The ruling of 2026-11-07 is business callers, and only those.
    const exception = ask.slice(0, exceptionEnd).toLowerCase();
    for (const word of ["family", "relative", "caregiver", "spouse", "parent"]) {
      expect(exception).not.toContain(word);
    }
  });

  it("fits the budget the ask has always been held to", () => {
    expect(Math.round(ask.length / 4)).toBeLessThan(206);
  });
});

describe("v185 — what a business caller says never reads as new or existing", () => {
  it.each(CORPUS.map((c) => [c.sid, c] as const))(
    "%s: the answer in its shape reads no status, so no lookup is suppressed",
    (_sid, c) => {
      const lines = [`AGENT: ${QUESTION}`, `CALLER: ${ANSWER[c.kind]}`];
      // Asked twice: the second ask and the same answer again.
      if (c.asked >= 2) lines.push(`AGENT: ${QUESTION}`, `CALLER: ${ANSWER[c.kind]}`);
      expect(readPatientStatus(lines)).toBeUndefined();
    },
  );
});
