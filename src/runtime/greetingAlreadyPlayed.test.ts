/**
 * The greeting is spoken by the transport, so the transport is what has to say
 * so. Evidence for every case here is in the module's own header: 13 calls on
 * 2026-09-03 played the opening two or three times, averaging 175 seconds
 * against a fleet average of 89.
 */
import { describe, it, expect } from "vitest";
import { withGreetingAlreadyPlayed, GREETING_ALREADY_PLAYED } from "./greetingAlreadyPlayed";

const PROMPT = "You are the optical queue agent.";
const GREETING = "Thank you for calling Azul Vision optical. How can I help you today?";

describe("telling the model its greeting already played", () => {
  it("appends the rule when the runtime is going to speak a greeting", () => {
    const out = withGreetingAlreadyPlayed(PROMPT, GREETING);
    expect(out.startsWith(PROMPT)).toBe(true);
    expect(out).toContain("ALREADY been spoken");
    expect(out).toContain("Never say it again");
  });

  /**
   * The trigger on six of the seven worst calls. A caller who asks for another
   * language mid-greeting must not restart the whole opening.
   */
  it("names the three things that actually triggered a repeat", () => {
    const out = withGreetingAlreadyPlayed(PROMPT, GREETING);
    expect(out).toContain("interrupted");
    expect(out).toContain("another language");
    expect(out).toContain("did not understand");
  });

  it("says what to do INSTEAD, so the model has somewhere to go", () => {
    // A prohibition with no alternative is how the model ended up repeating
    // its opening in the first place: it had nothing else to say.
    expect(GREETING_ALREADY_PLAYED).toContain("ask them to repeat");
  });

  it("appends NOTHING when the lane has no greeting", () => {
    // Those lanes open the call themselves; the claim would be false.
    expect(withGreetingAlreadyPlayed(PROMPT, null)).toBe(PROMPT);
    expect(withGreetingAlreadyPlayed(PROMPT, "")).toBe(PROMPT);
  });

  it("is idempotent — a prompt is never given the rule twice", () => {
    const once = withGreetingAlreadyPlayed(PROMPT, GREETING);
    expect(withGreetingAlreadyPlayed(once, GREETING)).toBe(once);
  });

  it("leaves the lane's own words untouched at the front", () => {
    // The lane prompt is the operator's; this only ever adds to the end.
    const out = withGreetingAlreadyPlayed(PROMPT, GREETING);
    expect(out.slice(0, PROMPT.length)).toBe(PROMPT);
  });
});
