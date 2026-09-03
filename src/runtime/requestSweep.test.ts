/**
 * The sweep is the backstop under every gate that lost a request today, so its
 * tests are the calls themselves — transcripts reduced to their shape, never
 * carrying a real name, date of birth or phone number into the repository.
 */
import { describe, it, expect } from "vitest";
import {
  callerLines,
  callerSaidSomething,
  alreadyFiledByTool,
  decideSweep,
  buildSweptTicket,
  sweepMarker,
  UNIDENTIFIED_FIRST,
  type SweepInput,
} from "./requestSweep";

function call(over: Partial<SweepInput> = {}): SweepInput {
  return {
    callSid: "CA00000000000000000000000000000001",
    slug: "tech",
    callerPhone: "+15555550100",
    transcript: "AGENT: Thank you for calling.\nCALLER: I need a refill on my drops.",
    toolEvents: [],
    ticketAlreadyFiled: false,
    ...over,
  };
}

describe("what the caller said", () => {
  it("keeps the caller's lines and drops the agent's", () => {
    const t = "AGENT: How can I help?\nCALLER: Eyeglass pickup.\nAGENT: One moment.\nCALLER: Washington Boulevard.";
    expect(callerLines(t)).toEqual(["Eyeglass pickup.", "Washington Boulevard."]);
  });

  it("counts a two-word request as something", () => {
    // The failure to avoid is discarding a real request for being short.
    expect(callerSaidSomething("AGENT: Hi.\nCALLER: Eyeglass pickup.")).toBe(true);
  });

  it("counts a request for a human as something — standing instruction 10", () => {
    // "Nobody is told to call back." A caller who asks for a person has made a
    // request; three of them hung up inside 45 seconds today with nothing filed.
    expect(callerSaidSomething("AGENT: Hi.\nCALLER: Representative?")).toBe(true);
  });

  it("does not count filler alone", () => {
    expect(callerSaidSomething("AGENT: Am I speaking with you?\nCALLER: No.\nCALLER: Okay")).toBe(false);
  });

  it("does not count a greeting-only call", () => {
    expect(callerSaidSomething("AGENT: Thank you for calling Azul Vision.")).toBe(false);
  });

  it("reads a request in any language — the caller's words are the request", () => {
    // CA54f824ae, tech 21:28: the whole request arrived in Spanish and the
    // caller hung up at 38 seconds. Nothing here may be English-only.
    const t = "AGENT: Thank you for calling.\nCALLER: Necesito surtir mis gotas, que se mande la prescripcion a la farmacia.";
    expect(callerSaidSomething(t)).toBe(true);
  });
});

describe("when NOT to file", () => {
  it("skips a lane that is not a queue", () => {
    expect(decideSweep(call({ slug: "no-ivr" }))).toEqual({ file: false, reason: "not-a-queue-lane" });
  });

  it("skips when a filing tool already succeeded", () => {
    const d = decideSweep(call({ toolEvents: [{ name: "file_tech_ticket", ok: true }] }));
    expect(d).toEqual({ file: false, reason: "already-filed" });
  });

  it("skips when the call already carries a ticket from check_open_tickets", () => {
    // A caller attached to their existing open ticket has been handled. Filing
    // again is the duplicate this must never create.
    expect(decideSweep(call({ ticketAlreadyFiled: true }))).toEqual({
      file: false, reason: "already-filed",
    });
  });

  it("skips a greeting-only hangup", () => {
    const d = decideSweep(call({ transcript: "AGENT: Thank you for calling." }));
    expect(d).toEqual({ file: false, reason: "caller-said-nothing" });
  });

  it("does NOT count a REFUSED filing tool as filed", () => {
    /**
     * The distinction the tool ceiling was reviewed over: dispatch answers ok
     * whenever the tool RAN, refusal included. Reading `ok` alone would have
     * skipped every call this exists for — CAc940b441 called
     * file_surgery_ticket four times and filed nothing.
     */
    const events = [
      { name: "file_surgery_ticket", ok: true, error: "validation" },
      { name: "file_surgery_ticket", ok: true, error: "validation" },
    ];
    expect(alreadyFiledByTool(events)).toBe(false);
    expect(decideSweep(call({ slug: "surgery", toolEvents: events })).file).toBe(true);
  });
});

describe("the five calls this was built for", () => {
  it("files the request a caller delivered before hanging up", () => {
    // CA54f824ae, tech 21:28:21 — zero tools ran.
    const d = decideSweep(call({
      transcript: "AGENT: Thank you for calling.\nCALLER: I need a refill sent to the pharmacy, and my callback number.",
      toolEvents: [],
    }));
    expect(d.file).toBe(true);
  });

  it("files when identity was the only thing missing", () => {
    // CA392f1567, tech 21:11:46 — the agent spent the whole call on an
    // ambiguous lookup and never classified or filed.
    const d = decideSweep(call({
      transcript: "AGENT: Could you give me your name?\nCALLER: My pharmacy sent a refill request nine days ago and nothing has come through.",
      toolEvents: [{ name: "lookup_patient", ok: true }, { name: "lookup_patient", ok: true }],
    }));
    expect(d.file).toBe(true);
  });

  it("files when the agent SAID it filed and did not", () => {
    // CAc940b441, surgery 21:50:12 — "I've logged your request", four refusals.
    const d = decideSweep(call({
      slug: "surgery",
      transcript: "CALLER: I need an appointment for a graft with my surgeon.\nAGENT: I've logged your request.",
      toolEvents: [
        { name: "lookup_patient", ok: true },
        { name: "file_surgery_ticket", ok: true, error: "validation" },
      ],
    }));
    expect(d.file).toBe(true);
  });
});

describe("the ticket it builds", () => {
  const input = call({
    slug: "surgery",
    transcript: "AGENT: How can I help?\nCALLER: I need to book a procedure my surgeon recommended.",
  });
  const d = decideSweep(input);
  const t = buildSweptTicket(input, d.file ? d.callerSaid : "");

  it("routes to the queue's own department and its catch-all", () => {
    // The queue IS the classification (operator, 2026-08-11). Surgery is
    // department 2, and 65/535 is its own "Other - See Description" — never
    // another department's, which is the bug that produced VA-50811.
    expect(t.departmentId).toBe(2);
    expect(t.requestTypeId).toBe(65);
    expect(t.requestReasonId).toBe(535);
  });

  it("carries the caller's own words, not a summary", () => {
    expect(t.description).toContain("I need to book a procedure my surgeon recommended.");
  });

  it("says plainly that nobody identified the caller", () => {
    // Never invent a person. The number to call is what staff actually need.
    expect(t.patientFirstName).toBe(UNIDENTIFIED_FIRST);
    expect(t.description).toContain(input.callerPhone);
  });

  it("files high, because nobody has looked at it and the caller may have been told it was done", () => {
    expect(t.priority).toBe("high");
  });

  it("is idempotent on the call — a retry and a backfill re-run collapse to one ticket", () => {
    const again = buildSweptTicket(input, "different wording entirely");
    expect(again.idempotencyKey).toBe(t.idempotencyKey);
    expect(t.idempotencyKey).toContain(input.callSid);
  });

  it("does not require a date of birth", () => {
    // Traced 2026-09-03: create-ticket validates the DOB fields as OPTIONAL.
    // Every date_of_birth refusal today came from our own tools. A swept
    // ticket must not reintroduce the gate it exists to survive.
    expect(Object.keys(t).some((k) => /birth|dob/i.test(k))).toBe(false);
  });
});

describe("the marker", () => {
  it("names the lane and the call, and carries no PHI", () => {
    const m = sweepMarker("tech", "CA00000000000000000000000000000001");
    expect(m).toContain("[REQUEST SWEEP]");
    expect(m).toContain("tech");
    expect(m).not.toMatch(/\+1\d{10}/);
  });
});
