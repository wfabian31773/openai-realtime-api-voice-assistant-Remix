import { describe, expect, it } from "vitest";
import {
  callbackGreeting,
  callbackPurpose,
  callbackSteps,
  describeLastAttempt,
  matchCallback,
  withCallbackSteps,
  DEFAULT_CALLBACK_PURPOSE,
  type CallbackCandidate,
  type CallbackContext,
} from "./callback";
import { OUTBOUND_RECORDING_CLAUSE } from "./campaign";

/** Synthetic people only. */
function candidate(over: Partial<CallbackCandidate> & { contactId: string }): CallbackCandidate {
  return {
    campaignId: "campaign-1",
    phone: "+15555550111",
    firstName: "Testa",
    lastName: "Person",
    status: "voicemail",
    data: {},
    lastAttemptAt: null,
    lastAttemptStatus: null,
    ...over,
  };
}

const ctx = (match: CallbackContext["match"]): CallbackContext => ({
  campaignKey: "test-campaign",
  campaignId: "campaign-1",
  callerPhone: "+15555550111",
  match,
  purpose: "it was a test call, and nothing is needed from them.",
});

describe("who a returned call is from", () => {
  it("is nobody when the number is not on the list", () => {
    expect(matchCallback([])).toEqual({ kind: "none" });
  });

  it("is one person when every row on the number is the same person — the row rung most recently", () => {
    const older = candidate({ contactId: "a", lastAttemptAt: new Date("2041-03-01T18:00:00Z") });
    const newer = candidate({ contactId: "b", lastAttemptAt: new Date("2041-03-04T18:00:00Z") });
    const never = candidate({ contactId: "c" });
    const m = matchCallback([older, never, newer]);
    expect(m.kind).toBe("one");
    expect(m.kind === "one" && m.contact.contactId).toBe("b");
  });

  it("folds accents and case, so one person spelled two ways is still one person", () => {
    const m = matchCallback([
      candidate({ contactId: "a", firstName: "José", lastName: "Peña" }),
      candidate({ contactId: "b", firstName: "jose", lastName: "PENA" }),
    ]);
    expect(m.kind).toBe("one");
  });

  it("is SEVERAL — never picked between — when two different people share the number", () => {
    const m = matchCallback([
      candidate({ contactId: "a", firstName: "Testa" }),
      candidate({ contactId: "b", firstName: "Other" }),
    ]);
    expect(m).toEqual({ kind: "several", people: 2 });
  });

  it("never treats two rows with no names as one person", () => {
    const m = matchCallback([
      candidate({ contactId: "a", firstName: null, lastName: null }),
      candidate({ contactId: "b", firstName: null, lastName: null }),
    ]);
    expect(m.kind).toBe("several");
  });
});

describe("the greeting on a returned call", () => {
  it("confirms a single match by first name, as a question", () => {
    const g = callbackGreeting({ kind: "one", contact: candidate({ contactId: "a" }) });
    expect(g).toBe(
      `Thank you for calling Azul Vision. This is an automated assistant. ${OUTBOUND_RECORDING_CLAUSE}. Am I speaking with Testa?`,
    );
    expect(g).not.toContain("Person"); // never the last name
  });

  it("asks who is calling when there is no single person to confirm", () => {
    for (const match of [
      { kind: "none" } as const,
      { kind: "several", people: 2 } as const,
      { kind: "one", contact: candidate({ contactId: "a", firstName: null }) } as const,
    ]) {
      expect(callbackGreeting(match)).toMatch(/May I have your first and last name\?$/);
    }
  });

  it("says it is automated and recorded before anything else, every time", () => {
    for (const match of [{ kind: "none" } as const, { kind: "one", contact: candidate({ contactId: "a" }) } as const]) {
      const g = callbackGreeting(match);
      expect(g.indexOf("automated")).toBeLessThan(g.indexOf("?"));
      expect(g).toContain(OUTBOUND_RECORDING_CLAUSE);
    }
  });
});

describe("what the last call did", () => {
  it("says it in the practice's day, never the server's", () => {
    // 01:30 UTC on a Wednesday is Tuesday evening in Pacific time.
    const c = candidate({ contactId: "a", lastAttemptAt: new Date("2041-03-06T01:30:00Z"), lastAttemptStatus: "voicemail" });
    expect(describeLastAttempt(c)).toBe("We called on Tuesday, March 5 and left a voicemail.");
  });

  it("says when nobody has been rung yet", () => {
    expect(describeLastAttempt(candidate({ contactId: "a" }))).toBe("We have not reached them by phone yet.");
  });
});

describe("the steps on a returned call", () => {
  it("tells the agent to identify a single match by the first name they confirm", () => {
    const steps = callbackSteps(ctx({ kind: "one", contact: candidate({ contactId: "a" }) }));
    expect(steps).toContain('call identify_callback_caller with first_name "Testa"');
    expect(steps).not.toContain("Person");
    expect(steps).toContain("Never tell them why we called");
    // Why we called comes only after identification.
    expect(steps.indexOf("Once they are identified")).toBeGreaterThan(steps.indexOf("identify_callback_caller"));
  });

  it("names nobody when the number belongs to several people", () => {
    const steps = callbackSteps(ctx({ kind: "several", people: 2 }));
    expect(steps).toContain("more than one person we called");
    expect(steps).toContain("Never guess");
  });

  it("asks for a date of birth in parts when the number is not on the list", () => {
    const steps = callbackSteps(ctx({ kind: "none" }));
    expect(steps).toContain("This number is not one we called");
    expect(steps).toContain("starting with the month, then the day, then the year");
  });
});

describe("where the steps go", () => {
  const prompt = [
    "## Role & Persona",
    "You are the test agent.",
    "",
    "## Objective",
    "Do the thing.",
    "",
    "## Conversation Flow",
    "### Greeting",
    "Already spoken.",
    "",
    "## Guardrails & Escalation",
    "Be careful.",
  ].join("\n");

  it("goes first inside the lane's Conversation Flow, and leaves the five sections in order", () => {
    const out = withCallbackSteps(prompt, "### Returned call\nFind out who.");
    const flow = out.indexOf("## Conversation Flow");
    const steps = out.indexOf("### Returned call");
    expect(steps).toBeGreaterThan(flow);
    expect(steps).toBeLessThan(out.indexOf("### Greeting"));
    expect(out.indexOf("## Guardrails")).toBeGreaterThan(steps);
    expect(out.match(/^## /gm)).toHaveLength(4);
  });

  it("is appended to a prompt that has no Conversation Flow", () => {
    expect(withCallbackSteps("You are the test agent.", "### Returned call")).toBe(
      "You are the test agent.\n\n### Returned call",
    );
  });
});

describe("why we called", () => {
  it("is the campaign's own sentence, or a default that says nothing private", () => {
    expect(callbackPurpose({ callbackPurpose: "a test." })).toBe("a test.");
    expect(callbackPurpose({})).toBe(DEFAULT_CALLBACK_PURPOSE);
    expect(DEFAULT_CALLBACK_PURPOSE).not.toMatch(/appointment|doctor|eye|health/i);
  });
});

describe("two people who share a name", () => {
  it("are two people when the campaign holds two dates of birth — a father and a son are never one", () => {
    const m = matchCallback([
      candidate({ contactId: "a", data: { date_of_birth: "1950-01-02" } }),
      candidate({ contactId: "b", data: { date_of_birth: "1980-03-04" } }),
    ]);
    expect(m).toEqual({ kind: "several", people: 2 });
  });

  it("are one person when the dates of birth agree however they are written", () => {
    const m = matchCallback([
      candidate({ contactId: "a", data: { date_of_birth: "1950-01-02" } }),
      candidate({ contactId: "b", data: { date_of_birth: "01/02/1950" } }),
    ]);
    expect(m.kind).toBe("one");
  });
});
