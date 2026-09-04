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
    verifiedName: { firstName: "Testpatient", lastName: "Example" },
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
    const d = decideSweep(call({ toolEvents: [{ name: "file_tech_ticket", succeeded: true }] }));
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
     * The distinction the tool ceiling was reviewed over, and the one that
     * nearly made this whole module a no-op.
     *
     * A runtime ToolEvent's `ok` means dispatch RAN the tool. A
     * `missing([...])` refusal comes back `ok: true` AND WITHOUT AN `error` —
     * nothing failed at the transport. The first version of this test invented
     * an `error: "validation"` the bridge never sets, so it passed while the
     * predicate underneath it read `ok` and would have called every refused
     * ticket a filed one — skipping the sweep on all five calls at the top of
     * requestSweep.ts. The fixture below is now the shape the bridge actually
     * produces.
     */
    const events = [
      { name: "file_surgery_ticket", succeeded: false },
      { name: "file_surgery_ticket", succeeded: false },
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
      toolEvents: [{ name: "lookup_patient", succeeded: true }, { name: "lookup_patient", succeeded: true }],
    }));
    expect(d.file).toBe(true);
  });

  it("files when the agent SAID it filed and did not", () => {
    // CAc940b441, surgery 21:50:12 — "I've logged your request", four refusals.
    const d = decideSweep(call({
      slug: "surgery",
      transcript: "CALLER: I need an appointment for a graft with my surgeon.\nAGENT: I've logged your request.",
      toolEvents: [
        { name: "lookup_patient", succeeded: true },
        { name: "file_surgery_ticket", succeeded: false },
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
  if (!d.file) throw new Error("fixture must be fileable");
  const t = buildSweptTicket(input, d);

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

  it("uses the name we verified, never one invented here", () => {
    expect(t.patientFirstName).toBe("Testpatient");
    expect(t.patientLastName).toBe("Example");
  });

  it("still carries the number staff have to ring", () => {
    expect(t.description).toContain(input.callerPhone);
  });

  it("files high, because nobody has looked at it and the caller may have been told it was done", () => {
    expect(t.priority).toBe("high");
  });

  it("is idempotent on the call — a retry and a backfill re-run collapse to one ticket", () => {
    const again = buildSweptTicket(input, { ...d, callerSaid: "different wording entirely" });
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


/**
 * NO NAME, NO TICKET. Operator ruling, 2026-09-03, given in answer to the
 * question put to him: what identity goes on a swept ticket when nobody
 * established one? None — and no ticket.
 *
 * An earlier draft filed these as "Unidentified Caller" with the phone number
 * in the description, and create-ticket would have accepted it. These tests
 * exist so that design cannot come back by accident.
 */
describe("no name, no ticket", () => {
  it("does not file when no identity was established", () => {
    const d = decideSweep(call({ verifiedName: undefined }));
    expect(d).toEqual({ file: false, reason: "no-name" });
  });

  it("does not file on half a name", () => {
    expect(decideSweep(call({ verifiedName: { firstName: "Given", lastName: "" } })).file).toBe(false);
    expect(decideSweep(call({ verifiedName: { firstName: "", lastName: "Family" } })).file).toBe(false);
  });

  it("does not accept whitespace as a name", () => {
    const d = decideSweep(call({ verifiedName: { firstName: "  ", lastName: "  " } }));
    expect(d).toEqual({ file: false, reason: "no-name" });
  });

  it("reports no-name SEPARATELY from a silent line", () => {
    // Two different problems. A nameless call has a real request in it and
    // belongs on the operator's callback list; a silent one does not. Collapsing
    // them into one counter would hide the population worth acting on.
    const anonymous = decideSweep(call({ verifiedName: undefined }));
    const silent = decideSweep(call({ transcript: "AGENT: Thank you for calling." }));
    expect(anonymous).toEqual({ file: false, reason: "no-name" });
    expect(silent).toEqual({ file: false, reason: "caller-said-nothing" });
  });

  it("checks the name LAST, so an already-filed call is not miscounted as nameless", () => {
    const d = decideSweep(call({ verifiedName: undefined, ticketAlreadyFiled: true }));
    expect(d).toEqual({ file: false, reason: "already-filed" });
  });

  it("files when the identity was verified", () => {
    const d = decideSweep(call({ verifiedName: { firstName: "Given", lastName: "Family" } }));
    expect(d.file).toBe(true);
  });
});

/**
 * THE CALLER CHASING A REQUEST THEY ALREADY MADE.
 *
 * Codex, PR #268 — the finding with a human cost. `check_open_tickets`
 * succeeds, the agent reads the caller their existing VA number, no filing
 * tool runs because none needed to, and the sweep would open a SECOND
 * high-priority catch-all ticket for work already in progress.
 *
 * Measured size: on 2026-09-03 the transcript VA-proxy over-counted filings
 * by 9 calls, every one of them exactly this — three from one number all
 * quoting the same ticket. And every one of those callers was identified, so
 * unlike the 47 the no-name rule stops, all 9 would have passed the gate.
 */
describe("a caller who rang to check on an existing request", () => {
  const statusCheck = (over: Partial<SweepInput> = {}) =>
    decideSweep(
      call({
        toolEvents: [
          { name: "lookup_patient", succeeded: true },
          { name: "check_open_tickets", succeeded: true, foundOpenTicket: true },
        ],
        ...over,
      }),
    );

  it("does not get a duplicate ticket opened for them at teardown", () => {
    expect(statusCheck()).toEqual({ file: false, reason: "status-check" });
  });

  it("is skipped under its OWN reason, so the trade-off stays countable", () => {
    // Not folded into "already-filed": that means a filing tool put a ticket
    // on THIS call. Keeping them apart is what lets the operator see how
    // often this fires and decide whether the trade is the right one.
    const d = statusCheck();
    expect(d.file).toBe(false);
    if (!d.file) expect(d.reason).not.toBe("already-filed");
  });

  it("still sweeps when check_open_tickets was attempted and FAILED", () => {
    // A failed lookup is not the caller being told anything, so their request
    // is as unhandled as if the tool had never run.
    const d = statusCheck({
      toolEvents: [
        { name: "lookup_patient", succeeded: true },
        { name: "check_open_tickets", succeeded: false },
      ],
    });
    expect(d.file).toBe(true);
  });

  /**
   * THE REGRESSION THAT ROUND 1's FIX INTRODUCED (Codex, PR #268 round 2).
   *
   * `sharedPatientTools` answers `success: true` with
   * `has_open_tickets: false` when the caller has nothing open, and every
   * queue prompt tells the agent to run this tool BEFORE filing. So keying
   * the skip on "the tool succeeded" turned off the recovery sweep on the
   * ordinary failure path — a strictly worse bug than the duplicate it was
   * meant to prevent, and it would have been invisible: fewer tickets, no
   * error anywhere.
   */
  it("SWEEPS when the tool ran fine and found NOTHING — the ordinary call", () => {
    const d = statusCheck({
      toolEvents: [
        { name: "lookup_patient", succeeded: true },
        { name: "check_open_tickets", succeeded: true, foundOpenTicket: false },
        { name: "file_tech_ticket", succeeded: false },
      ],
    });
    expect(d.file).toBe(true);
  });

  it("sweeps when the tool did not report either way", () => {
    // An older record with no `foundOpenTicket` must not be read as a match.
    const d = statusCheck({
      toolEvents: [
        { name: "lookup_patient", succeeded: true },
        { name: "check_open_tickets", succeeded: true },
      ],
    });
    expect(d.file).toBe(true);
  });

  it("still sweeps an ordinary call where no ticket tool ran at all", () => {
    expect(decideSweep(call({ toolEvents: [{ name: "lookup_patient", succeeded: true }] })).file)
      .toBe(true);
  });
});
