/**
 * TAKE THE REQUEST THE CALLER ALREADY MADE.
 *
 * Operator instruction, 2026-09-03: *"yes file from the transcript and create a
 * backfill if needed for this."*
 *
 * WHAT THIS IS FOR
 *
 * Five calls on the afternoon of 2026-09-03 ended with a complete, actionable
 * request sitting in `call_logs.transcript` and no ticket anywhere:
 *
 *   21:11 tech      a nine-day-old eye-drop refill and the pharmacy's number.
 *                   The agent spent the call on an ambiguous lookup and asked
 *                   the caller whether she was a man with a different surname.
 *   21:28 tech      an entire refill request, name and callback number, in
 *                   Spanish, delivered in one breath. The caller hung up at 38
 *                   seconds. ZERO tools ran.
 *   21:50 surgery   a corneal graft with a named surgeon and a recommended
 *                   date. The filing tool refused four times over a date of
 *                   birth the caller had already said, and the agent told her
 *                   "I've logged your request." Nothing was logged.
 *   20:43 records   "release of information", said twice, three and a half
 *                   minutes on the line, nothing filed.
 *   21:07 optical   a pickup question with the office named, five refusals.
 *
 * Every one of them is the same shape: WE HAD THE REQUEST AND DID NOT KEEP IT.
 * The gate that stopped each was different — identity, a hangup, a date of
 * birth — and arguing with each gate one at a time is how this has gone for a
 * fortnight. This is the backstop underneath all of them.
 *
 * THE ONE RULE
 *
 * If the caller said something substantive and no ticket exists when the call
 * ends, file what they said. The transcript IS the request. Staff can read it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not diagnose, classify or route beyond the queue the call arrived on
 * — the queue IS the classification (operator, 2026-08-11), and the department
 * catch-all exists precisely so a request nobody could categorise still lands
 * somewhere a human reads. It does not re-run any gate that already refused;
 * that is the point.
 *
 * NO DATE OF BIRTH IS REQUIRED. Traced 2026-09-03: `/api/voice-agent/create-ticket`
 * validates `patientBirthMonth/Day/Year` as OPTIONAL. Every `missingFields:
 * ["date_of_birth"]` refusal in today's logs came from OUR OWN tools, not from
 * the ticketing app. So a swept ticket files cleanly without one, and the
 * request survives a gate that was never the server's.
 */
import { otherReasonFor } from "../tools/otherReason";

/** The lanes this runs on. Each is a queue whose department is its routing. */
const DEPARTMENT_BY_SLUG: Record<string, number> = {
  optical: 1,
  surgery: 2,
  tech: 3,
  records: 16,
};

export interface SweepToolEvent {
  name: string;
  ok: boolean;
  error?: string;
}

export interface SweepInput {
  callSid: string;
  slug: string;
  callerPhone: string;
  /** The rendered call transcript, "AGENT:" / "CALLER:" lines. */
  transcript: string;
  toolEvents: readonly SweepToolEvent[];
  /** True when the call already carries a ticket — from a filing tool that
   * succeeded, or from check_open_tickets attaching an existing one. */
  ticketAlreadyFiled: boolean;
}

export type SweepDecision =
  | { file: true; callerSaid: string }
  | { file: false; reason: SweepSkipReason };

export type SweepSkipReason =
  | "not-a-queue-lane"
  | "already-filed"
  | "caller-said-nothing"
  | "no-department-catch-all";

/**
 * The caller's own words, in order, with the agent's stripped out.
 *
 * Reads the rendered transcript rather than a structured field because that is
 * what survives to teardown and what the backfill has for calls already over —
 * one extractor for the live sweep and the recovery, so they cannot disagree
 * about what a caller said.
 */
export function callerLines(transcript: string): string[] {
  return transcript
    .split("\n")
    .filter((l) => l.startsWith("CALLER:"))
    .map((l) => l.slice("CALLER:".length).trim())
    .filter(Boolean);
}

/**
 * Filler a caller says while the agent is still talking. A call whose ONLY
 * caller speech is these has told us nothing to file.
 *
 * Deliberately short and literal. The failure to avoid is the opposite one —
 * discarding a real request because it was brief. "Eyeglass pickup." is two
 * words and is a request; so is "Representative?", which standing instruction
 * 10 says to take rather than deflect. Anything not on this list counts.
 */
const FILLER = new Set([
  "yes", "no", "yeah", "yep", "nope", "ok", "okay", "hello", "hi", "hey",
  "thanks", "thank you", "bye", "goodbye", "uh", "um", "mm", "mhm", "what",
  "sorry", "pardon", "huh",
]);

function isFiller(line: string): boolean {
  const bare = line.toLowerCase().replace(/[.,!?¿¡]/g, "").trim();
  return bare === "" || FILLER.has(bare);
}

/** Did the caller say anything worth keeping? */
export function callerSaidSomething(transcript: string): boolean {
  return callerLines(transcript).some((l) => !isFiller(l));
}

/**
 * A filing tool that RAN AND SUCCEEDED. `ok` alone is not enough — dispatch
 * answers ok whenever the tool ran at all, refusal included, which is the
 * distinction that cost the tool ceiling a round of review.
 */
export function alreadyFiledByTool(events: readonly SweepToolEvent[]): boolean {
  return events.some((e) => /^file_.*_ticket$/.test(e.name) && e.ok && !e.error);
}

export function decideSweep(input: SweepInput): SweepDecision {
  const departmentId = DEPARTMENT_BY_SLUG[input.slug];
  if (departmentId === undefined) return { file: false, reason: "not-a-queue-lane" };
  if (input.ticketAlreadyFiled || alreadyFiledByTool(input.toolEvents)) {
    return { file: false, reason: "already-filed" };
  }
  if (!callerSaidSomething(input.transcript)) {
    return { file: false, reason: "caller-said-nothing" };
  }
  if (!otherReasonFor(departmentId)) {
    return { file: false, reason: "no-department-catch-all" };
  }
  return { file: true, callerSaid: callerLines(input.transcript).join(" ") };
}

/**
 * WHO THE TICKET IS FOR WHEN THE CALLER NEVER SAID.
 *
 * `create-ticket` requires a first and last name of at least one character —
 * it does NOT reject placeholders (that rule lives on the submit-ticket path,
 * which this does not use). So the honest thing is available: say plainly that
 * the identity was not established and put the number staff must call on the
 * ticket, rather than inventing a person.
 *
 * The name is not a guess and must never become one. A caller who gave their
 * name in the transcript is a separate improvement and is NOT done here: doing
 * it properly means the model extracting it, not this module regexing for a
 * capitalised word, per standing instruction 3.
 */
export const UNIDENTIFIED_FIRST = "Unidentified";
export const UNIDENTIFIED_LAST = "Caller";

export interface SweptTicket {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  description: string;
  priority: "low" | "medium" | "high";
  callSid: string;
  idempotencyKey: string;
}

/**
 * The payload. `idempotencyKey` is derived from the call sid so a retry, a
 * re-run of the backfill over the same call, and the live sweep racing the
 * backfill all collapse to one ticket — the key is what held duplicate filing
 * to 3 calls in 2,086 when it was measured.
 */
export function buildSweptTicket(input: SweepInput, callerSaid: string): SweptTicket {
  const departmentId = DEPARTMENT_BY_SLUG[input.slug]!;
  const other = otherReasonFor(departmentId)!;
  return {
    departmentId,
    requestTypeId: other.requestTypeId,
    requestReasonId: other.requestReasonId,
    patientFirstName: UNIDENTIFIED_FIRST,
    patientLastName: UNIDENTIFIED_LAST,
    patientPhone: input.callerPhone,
    description:
      `Recovered from the call recording — the agent did not file this request.\n\n` +
      `What the caller said, in their own words:\n${callerSaid}\n\n` +
      `Call back on ${input.callerPhone}. Call reference ${input.callSid}.`,
    // Not "medium". Nobody has looked at this request yet and the caller has
    // been told nothing true about it; on three of today's five the agent said
    // it was filed when it was not.
    priority: "high",
    callSid: input.callSid,
    idempotencyKey: `sweep:${input.callSid}`,
  };
}

/**
 * DEPLOY MARKER AND LIVE COUNTER. Prints only when a request is recovered, so
 * its first appearance proves the build is live and its rate is how many
 * requests were being dropped. Carries the lane and the call reference — never
 * the transcript, never a name, never the caller's number.
 */
export function sweepMarker(slug: string, callSid: string): string {
  return `[REQUEST SWEEP] ${slug}: the caller made a request and no ticket was filed — recovering it from the transcript (${callSid})`;
}
