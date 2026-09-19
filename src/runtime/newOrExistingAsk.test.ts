/**
 * RULE ZERO 2a — the unit half.
 *
 * These prove the FUNCTION. They cannot prove the runtime calls it, and a
 * suite that stopped here would have passed for the whole time the wire was
 * missing — which is exactly how #291's office carry was found dead with five
 * green tests. The wiring is proved in `voiceRuntime.test.ts`, under
 * "Rule Zero 2a reaches the session, and stands down when Rule 1 answered".
 */
import { describe, it, expect } from "vitest";
import { withNewOrExistingAsk, NEW_OR_EXISTING_ASK } from "./newOrExistingAsk";

const PROMPT = "You answer the optical line at Azul Vision.";

describe("withNewOrExistingAsk", () => {
  it("asks on every patient queue lane when nobody was recognised", () => {
    for (const slug of ["optical", "surgery", "tech", "records"]) {
      expect(withNewOrExistingAsk(PROMPT, slug, false)).toBe(PROMPT + NEW_OR_EXISTING_ASK);
    }
  });

  it("STANDS DOWN for a recognised caller — Rule 2a's own carve-out", () => {
    // "A caller recognised from their phone number is an existing patient by
    // definition — asking anyway tells them we do not know who they are while
    // we are looking at their chart."
    for (const slug of ["optical", "surgery", "tech", "records"]) {
      expect(withNewOrExistingAsk(PROMPT, slug, true)).toBe(PROMPT);
    }
  });

  it("never asks a lane whose callers are not patients", () => {
    // PCP takes doctors' offices, medical groups, surgery centres and
    // insurers. CAbf717457 is already on record as an entity mishandled by
    // being sent down the patient branch; asking a surgery centre whether it
    // is a new or existing PATIENT is that same error, spoken aloud.
    for (const slug of ["pcp", "no-ivr", "answering-service", "azul-scheduling"]) {
      expect(withNewOrExistingAsk(PROMPT, slug, false)).toBe(PROMPT);
    }
  });

  it("is idempotent, and stands down for a prompt that grows the question itself", () => {
    const once = withNewOrExistingAsk(PROMPT, "optical", false);
    expect(withNewOrExistingAsk(once, "optical", false)).toBe(once);

    const laneSaysItAlready =
      PROMPT + ' Open by asking whether they are a new patient or an existing patient.';
    expect(withNewOrExistingAsk(laneSaysItAlready, "optical", false)).toBe(laneSaysItAlready);
  });

  it("asks the question in the operator's own words, and names both branches", () => {
    // Not a spelling check. Each of these is a decision Wayne stated out loud
    // and any of them going missing changes what the lane does:
    //   - the question itself, in his wording
    //   - NEW closes the lookup branch, so a miss is expected
    //   - and specifically must not produce "we have no record of you"
    //   - EXISTING opens it, and is worth pushing through
    expect(NEW_OR_EXISTING_ASK).toContain("new patient or an existing patient");
    expect(NEW_OR_EXISTING_ASK).toContain("STOP LOOKING");
    expect(NEW_OR_EXISTING_ASK).toContain("no record of them");
    expect(NEW_OR_EXISTING_ASK).toContain("keep going until you do");
  });

  it("costs less than the recognition block it replaces on that branch", () => {
    // Measured 2026-09-12, tokens as the repo estimates them (chars / 4):
    //
    //   lane      unmatched  +greeting   matched  +greeting
    //   optical        1426       1494      1632       1700
    //   surgery        1300       1368      1506       1574
    //   tech           1584       1652      1797       1865
    //   records        1687       1755      1940       2008
    //
    // This line lands ONLY on the unmatched branch, which is the lighter one
    // by ~206 tokens on every lane — the recognition block is absent there.
    // So a lane carrying this ask is still smaller than that same lane
    // already is today on a recognised call, and no lane reaches a size it
    // does not already run at. That is the budget argument; it is not a
    // licence, and the ceilings in the agent files are separately stale (see
    // the PR body).
    expect(Math.round(NEW_OR_EXISTING_ASK.length / 4)).toBeLessThan(206);
  });
});
