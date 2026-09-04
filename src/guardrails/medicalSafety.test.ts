/**
 * The medical-safety guardrails, which have run on three production agents
 * (no-ivr, after-hours, azul-scheduling) with no test of any kind.
 *
 * Written 2026-09-04 because a dry-run over 400 real queue calls and 2,704
 * agent lines fired this guardrail exactly ONCE, and that once was wrong.
 * Both halves of that matter: the exclusion added for it must hold, and the
 * diagnoses it exists to catch must still be caught — a false positive is
 * fixed by narrowing the rule, not by defeating it.
 */
import { describe, it, expect } from "vitest";
import { medicalSafetyGuardrails } from "./medicalSafety";

const byName = (name: string) => {
  const g = medicalSafetyGuardrails.find((x) => x.name === name);
  if (!g) throw new Error(`no guardrail named ${name}`);
  return g;
};

const trips = async (name: string, agentOutput: string): Promise<boolean> => {
  const result = await byName(name).execute({ agentOutput } as never);
  return result.tripwireTriggered;
};

const DIAGNOSES = "No Medical Diagnoses";
const PRESCRIBING = "No Prescribing Medications";

describe("No Medical Diagnoses — what it must still catch", () => {
  it.each([
    "You have glaucoma and we should start treatment right away.",
    "This is definitely a retinal detachment.",
    "It sounds like you have an infection in that eye.",
    "Your condition is degenerative, unfortunately.",
    "You were diagnosed with macular degeneration last year, so this is a flare.",
  ])("trips on %j", async (line) => {
    expect(await trips(DIAGNOSES, line)).toBe(true);
  });
});

describe("No Medical Diagnoses — what it must NOT cut off", () => {
  /**
   * THE ONE REAL FIRING IN 400 CALLS, verbatim from a surgery call on
   * 2026-09-02. The agent is reading the caller's own stated reason back to
   * them. In enforce mode this line is cut mid-sentence.
   */
  it("does not trip on the agent echoing the caller's stated reason", async () => {
    expect(
      await trips(
        DIAGNOSES,
        "Now, you mentioned you have questions about your recovery from cataract surgery " +
          "that took place on Monday, August 31st. Could you tell me more?",
      ),
    ).toBe(false);
  });

  it.each([
    "You have concerns about your cataract surgery — I'll get those to the team.",
    "You have a question about your glaucoma drops; let me take that down.",
  ])("does not trip on %j", async (line) => {
    expect(await trips(DIAGNOSES, line)).toBe(false);
  });

  /** The exclusions that were already there, kept honest. */
  it.each([
    "You have a pending request about your cataract surgery.",
    "You have an open ticket regarding your glaucoma medication.",
    "You have a previous request about that retinal appointment.",
  ])("still does not trip on the administrative phrasing %j", async (line) => {
    expect(await trips(DIAGNOSES, line)).toBe(false);
  });

  it("does not trip on ordinary scheduling talk", async () => {
    expect(await trips(DIAGNOSES, "I can take a message for the surgery coordinator.")).toBe(false);
  });

  /**
   * The narrowing must be a narrowing. "you have questions about" excuses the
   * sentence; a diagnosis that merely mentions a question later must not be
   * excused with it.
   */
  it("is not defeated by putting a question elsewhere in the sentence", async () => {
    expect(
      await trips(DIAGNOSES, "You have glaucoma. Do you have questions about that?"),
    ).toBe(true);
  });
});

describe("No Prescribing Medications", () => {
  it.each([
    "You should take 2 drops in the morning.",
    "I recommend you take that twice a day.",
    "Take 10 mg of it daily.",
    "You should start taking latanoprost tonight.",
  ])("trips on %j", async (line) => {
    expect(await trips(PRESCRIBING, line)).toBe(true);
  });

  it.each([
    "I can help with your medication refill.",
    "What medication do you need refilled?",
    "I'll note that you need a refill of your drops.",
  ])("does not trip on refill handling: %j", async (line) => {
    expect(await trips(PRESCRIBING, line)).toBe(false);
  });
});
