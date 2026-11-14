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
import { monthNumberFromWord } from "../tools/dobParts";
import { classifyRecordsRequest, recordsReasonById } from "../tools/medicalRecordsTaxonomy";
import { classifyTechRequest, techReasonById } from "../tools/techTaxonomy";
import { classifySurgeryRequest, surgeryReasonById } from "../tools/surgeryTaxonomy";
import { classifyOptical, classificationByReasonId } from "../tools/opticalTaxonomy";
import { sanitizeForSms } from "../services/gsm7";
import { NAME_SCAFFOLDING } from "./nameScaffolding";

/** The lanes this runs on. Each is a queue whose department is its routing. */
const DEPARTMENT_BY_SLUG: Record<string, number> = {
  optical: 1,
  surgery: 2,
  tech: 3,
  records: 16,
};

export interface SweepToolEvent {
  name: string;
  /** `check_open_tickets` found an existing open ticket. See ToolEvent. */
  foundOpenTicket?: boolean;
  /**
   * The tool DID ITS JOB — not merely that it ran.
   *
   * This field replaced `ok`, and the reason is the whole point of the sweep.
   * `ok` on a runtime ToolEvent means dispatch reached the handler; a
   * `missing([...])` refusal comes back `ok: true` with no error. So
   * `alreadyFiledByTool`, reading `ok`, counted a REFUSED `file_*_ticket` as a
   * filed ticket — and would have skipped the sweep on every one of the calls
   * listed at the top of this file. Caught while wiring it in, before it ran
   * on a live call.
   */
  succeeded: boolean;
  /**
   * A request-reason id the agent already named — from `classify_*_request`
   * or a refused `file_*_ticket`. A number only; never caller text.
   */
  requestReasonId?: number;
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
  /**
   * WHO WE ESTABLISHED THE CALLER TO BE, or undefined.
   *
   * Operator ruling, 2026-09-03: **"no name no ticket."** Read from the
   * identity `lookup_patient` verified during the call, which is a name off
   * the record rather than one heard down a phone line. Undefined means this
   * sweep does not file — see decideSweep.
   */
  verifiedName?: { firstName: string; lastName: string };
  /**
   * WHERE `verifiedName` CAME FROM. `verified` (or absent) is a certain lookup
   * match. `stated` is the name the caller gave, as a name-taking tool
   * received it (`statedName.ts`, operator ruling 2026-10-29: a caller whose
   * name we got is not nameless). `spoken` is the person the calling number
   * belongs to, used only because the caller said both halves of that name on
   * the call (`callerSaidTheName`, v168 — the same ruling's "nor did we match
   * the phone number to a patient"). `heard` is the patient's name a model read
   * out of the transcript and the code then found in the caller's own lines
   * (`nameFromTheRecording.ts`, v180 — the ruling's "did not get the name in
   * transcripts"). `number` is the one patient the calling number belongs to
   * in the person base, used when nobody on the call said any patient's name
   * (v182, the same ruling's "nor did we match the phone number to a patient
   * on lookup", approved as filed 2026-11-06). The swept ticket tells staff
   * which it is.
   */
  nameSource?: "verified" | "stated" | "spoken" | "heard" | "number";
  /**
   * Staff-facing call summary, when one already exists (a backfill, or a
   * row written before the sweep). Preferred over the raw transcript for
   * classifying the request — it is already isolated from the identity
   * interview. Never put in the patient-facing description.
   */
  summary?: string;
  /**
   * A (type, reason) the agent already named. Wins over summary and
   * transcript. Ignored when it does not belong to this queue.
   */
  capturedReason?: { requestTypeId: number; requestReasonId: number };
  /**
   * The request as the MODEL wrote it in `request_description` on a classify
   * or filing tool this call — kept even when that tool refused
   * (`draftedRequest.ts`, v166). The same text every ordinary filing sends as
   * its description, so unlike the transcript it may go in the description.
   */
  draftedRequest?: string;
  /**
   * v201: what the caller asked for, read from the recording by a model AFTER
   * the call, when nothing was drafted (`requestFromTheRecording.ts`). Already
   * checked and GSM-7 sanitised there. It goes in the description and the
   * staff note; it never feeds a request reason.
   */
  requestFromRecording?: string;
  /**
   * v231: THE DATE OF BIRTH THE CALLER GAVE ON THIS CALL, `YYYY-MM-DD`, as the
   * spoken-DOB reader reads it (`spokenDob.ts`: the caller's answer to a
   * date-of-birth ask, the reader the filing tools use). The runner sets it
   * only when no certain identity holds a chart date, which always wins
   * (RULE ZERO step 5). It reaches the ticket only under a name the caller
   * gave (`stated`, `spoken`, `heard`): a date with no name, or under the
   * calling number's owner when nobody said a patient name, is not carried.
   * See `CALLER_DOB_NOTE`.
   */
  callerDob?: string;
}

export type SweepDecision =
  /**
   * `firstName`/`lastName` are OPTIONAL as of 2026-09-27, for ONE lane. On
   * `records` a request with no verified name files without one (see the
   * name gate in `decideSweep`); on every other lane the gate still refuses,
   * so a filing decision there always carries both.
   */
  | { file: true; callerSaid: string; firstName?: string; lastName?: string }
  | { file: false; reason: SweepSkipReason };

/**
 * THE LANE WHOSE REQUESTS FILE WITHOUT A NAME.
 *
 * Operator, 2026-09-27, approving point 2 of the records-line review: *"go
 * ahead and flip records to the runtime and the other 5 points."* The review
 * measured fourteen business days on the records line: 45 conversations ran
 * `lookup_patient` and never filed, 21 were refused by the filing tool — eleven
 * of them for a name — and on the old core nothing swept any of them up. The
 * "no name, no ticket" ruling of 2026-09-03 was written for the queue lanes'
 * callback tickets, where a name is what a clerk rings back with; a records
 * request has a callback number on every call, and the department is under a
 * Corrective Action Plan whose first rule is that every request is LOGGED.
 * An unlogged request is the failure; an unnamed one is a chase.
 *
 * ONE lane, by name, so the ruling stands everywhere it was made.
 */
const FILES_WITHOUT_A_NAME: ReadonlySet<string> = new Set(["records"]);

export type SweepSkipReason =
  | "not-a-queue-lane"
  | "already-filed"
  | "caller-said-nothing"
  | "no-name"
  | "status-check"
  | "identity-only"
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
 * A caller who identified themselves and then hung up has not made a request.
 *
 * `callerSaidSomething` counts any non-filler line, and "Yes, this is Mary
 * Smith" and a spoken date of birth are not filler — so a lookup that
 * succeeded followed by a hang-up produced a high-priority catch-all ticket
 * containing nothing but the identity interview (Codex, PR #268 round 4).
 *
 * DELIBERATELY THE NARROWEST POSSIBLE VERSION. It suppresses a call only when
 * EVERY caller line is exhausted by that caller's own name and a date — words
 * they were asked for. Any request contains something else, so this cannot
 * swallow one; the failure mode it accepts is filing the occasional
 * identity-only ticket, which is the right direction to err on a path whose
 * whole purpose is not losing requests.
 *
 * It does NOT try to decide what a request is. That is a judgement about
 * conversation content, it belongs to the operator, and standing instruction
 * 3 is that meaning is the model's job and not a regex's. This only asks
 * whether anything was said at all beyond the identifiers.
 */
export function saidMoreThanTheirOwnIdentity(
  transcript: string,
  identity: { firstName?: string; lastName?: string } | undefined,
): boolean {
  const own = new Set(
    [identity?.firstName, identity?.lastName]
      .flatMap((n) => (n ?? "").toLowerCase().split(/\s+/))
      .filter(Boolean),
  );
  for (const turn of callerTurns(transcript)) {
    if (isFiller(turn.text)) continue;
    const words = turn.text
      .toLowerCase()
      .replace(/[.,!?¿¡'"-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const leftover = words.filter(
      (w) =>
        !own.has(w) &&
        !FILLER.has(w) &&
        !IDENTITY_WORDS.has(w) &&
        // Bare numbers and ordinals: a spoken date, a year, "the 17th".
        !/^\d{1,4}(st|nd|rd|th)?$/.test(w) &&
        monthNumberFromWord(w) === undefined &&
        !NUMBER_WORDS.has(w) &&
        // A single letter is a caller spelling their name ("S, M, I, T, H").
        w.length > 1,
    );
    if (leftover.length === 0) continue;
    /**
     * THE ANSWER TO AN IDENTITY QUESTION IS IDENTITY, whatever the words are.
     *
     * Codex P1 on #333: the records lane now files with no verified name, and
     * with no name to subtract the loop above could not tell "Mary Smith" from
     * a request — so a caller who was asked their name, gave it and hung up
     * would have produced a HIGH-priority Medical Records ticket and, through
     * `ensureCaseForTicket`, a regulated case on a statutory clock, for a call
     * that made no request. The protection above only ever worked because the
     * name was known.
     *
     * The fix reads the QUESTION, not the answer — RULE ZERO 2c, and the same
     * device `spokenDob.ts` and `spokenPatientStatus.ts` use: the agent's own
     * ask opens a window, the caller's turns inside it are answers to it, and
     * a name-sized answer (up to three words once the scaffolding, dates and
     * spelled letters are gone) is identity. Anything LONGER than a name inside
     * the window is more than an answer and still counts — "Mary Smith, and I
     * need my records sent" files. There is no name detector here and no list
     * of request words: standing instruction 3 stands.
     *
     * MEASURED before choosing three, records lane 09-08..09-25, the 150
     * no-ticket calls whose caller spoke: 6 are exhausted by answers to
     * identity asks and are now skipped as identity-only; 3 answered a name
     * question with more than a name and still file; 141 said something
     * outside every window and file as before. The residue Codex named — a
     * bare name VOLUNTEERED with no question asked — is not closed, because
     * closing it needs a name detector; it is the same residue v31 accepted on
     * the PCP sweep, and on this lane it costs a clerk a cancellation.
     */
    if (turn.answersIdentityAsk && leftover.length <= NAME_SIZED_ANSWER) continue;
    return true;
  }
  return false;
}

/** Up to first, middle and last. A fourth leftover word is not a name. */
const NAME_SIZED_ANSWER = 3;

/**
 * An AGENT line that asks the caller to identify themselves. One list, so the
 * sweep and the tests agree on what opens a window. English and the Spanish
 * the lanes translate their questions into; a language not listed opens no
 * window, and the caller's answer then simply counts as speech — the direction
 * that costs an identity-only ticket rather than a lost request.
 */
const IDENTITY_ASK =
  /\b(?:your|the patient'?s|patient'?s) (?:first |last |full )?name\b|\bfirst and last name\b|\blast name\b|\bspell\b|\bdate of birth\b|\bmonth,? then the day\b|\bphone number\b|\bnumber to reach\b|\bnew patient or\b|\bexisting patient\b|\bam i speaking with\b|\bwho am i speaking\b|\bsu nombre\b|\bapellido\b|\bfecha de nacimiento\b|\bn[uú]mero de tel[eé]fono\b|\bpaciente nuevo\b/i;

/**
 * The caller's turns, each marked with whether it sits inside an identity-ask
 * window: opened by an AGENT line that matches IDENTITY_ASK, closed by the
 * next AGENT line. Same line shape `callerLines` reads.
 */
export function callerTurns(transcript: string): Array<{ text: string; answersIdentityAsk: boolean }> {
  const turns: Array<{ text: string; answersIdentityAsk: boolean }> = [];
  let window = false;
  for (const raw of transcript.split("\n")) {
    if (raw.startsWith("AGENT:")) {
      window = IDENTITY_ASK.test(raw.slice("AGENT:".length));
      continue;
    }
    if (!raw.startsWith("CALLER:")) continue;
    const text = raw.slice("CALLER:".length).trim();
    if (!text) continue;
    turns.push({ text, answersIdentityAsk: window });
  }
  return turns;
}

/** The scaffolding around an identity answer: "this is", "my name is". */
const IDENTITY_WORDS = new Set([
  "this", "is", "it", "i", "am", "my", "name", "the", "of", "birth", "date",
  "was", "born", "on", "in", "a", "and", "speaking", "here", "that", "s",
  "im", "its", "mr", "mrs", "ms", "dr", "junior", "senior", "jr", "sr",
  // v180: the words the name extractor accepts around a name ("last name",
  // "mi apellido es"), so a bare introduction is identity on every path.
  ...NAME_SCAFFOLDING,
]);

/** Spoken numbers, so "March seventeenth nineteen seventy three" is a date. */
const NUMBER_WORDS = new Set([
  "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
  "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth",
  "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth", "thirtieth", "twenty-first", "twenty-second",
]);

/**
 * A filing tool that RAN AND SUCCEEDED.
 *
 * The distinction is not pedantic: it is the difference between this sweep
 * doing its job and doing nothing at all. Dispatch answers ok whenever the
 * tool ran, refusal included — the same trap the tool ceiling hit in review —
 * so this reads the tool's own verdict and nothing else.
 */
export function alreadyFiledByTool(events: readonly SweepToolEvent[]): boolean {
  return events.some((e) => /^file_.*_ticket$/.test(e.name) && e.succeeded);
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
  /**
   * THE CALLER WHO RANG TO CHASE A REQUEST THEY ALREADY MADE.
   *
   * Codex found this on PR #268 and it is the finding with a human cost:
   * `check_open_tickets` succeeds, the agent correctly reads the caller
   * their existing VA number, no FILING tool runs — because none needed to —
   * and the sweep would then open a second, high-priority, catch-all ticket
   * for a request the practice is already working.
   *
   * It is not hypothetical and the size is known. On 2026-09-03 the
   * transcript `VA-#####` proxy over-counted filings by 9 calls, and every
   * one of those was exactly this: a caller chasing an existing request,
   * three of them from the same number quoting the same ticket. Those
   * callers are all IDENTIFIED, so unlike the 47 the no-name rule stops,
   * every one would have passed the gate below and produced a duplicate.
   *
   * IT IS NOT ENOUGH THAT THE TOOL SUCCEEDED. `sharedPatientTools` answers
   * `success: true` with `has_open_tickets: false` when the caller has
   * nothing open, and every queue prompt tells the agent to run this tool
   * before filing — so keying on `succeeded` alone would have skipped the
   * sweep on the ORDINARY failure path it exists for, which is a worse bug
   * than the duplicate it was fixing (Codex, PR #268 round 2). The skip
   * requires the tool to have actually FOUND something.
   *
   * So a matched existing ticket is treated as the request being handled. The
   * cost of the other reading — a caller who checks a status AND raises
   * something new, whose new thing no filing tool captured — is real but
   * smaller, and it is countable under this reason rather than invisible.
   * Which way that trade should fall is the operator's call; this errs
   * against inventing work for the staff, and makes the number visible so
   * he can settle it with evidence rather than with a guess.
   */
  if (
    input.toolEvents.some(
      (e) => e.name === "check_open_tickets" && e.succeeded && e.foundOpenTicket === true,
    )
  ) {
    return { file: false, reason: "status-check" };
  }
  if (!otherReasonFor(departmentId)) {
    return { file: false, reason: "no-department-catch-all" };
  }
  /**
   * IDENTIFIED, THEN HUNG UP. Everything the caller said was their own name
   * and a date — the two things the agent asked them for. There is no request
   * in that, and filing one puts an identity interview on the staff queue at
   * high priority (Codex, PR #268 round 4).
   *
   * Placed AFTER the cheap checks and BEFORE the name gate, so its skips are
   * counted separately from both silence and anonymity.
   */
  if (!saidMoreThanTheirOwnIdentity(input.transcript, input.verifiedName)) {
    return { file: false, reason: "identity-only" };
  }
  /**
   * NO NAME, NO TICKET. Operator ruling, 2026-09-03, answering the question
   * put to him directly: what identity goes on a swept ticket when nobody
   * established one? His answer settles it — none, and no ticket.
   *
   * This is LAST on purpose. A call that reaches here and stops has a real
   * request in it and an anonymous caller, which is a different problem from
   * a silent line, and the skip reason is what tells the two apart in the
   * counters. Those calls are not filed and are not lost either: they surface
   * on the operator's callback list, where a person decides.
   */
  const first = input.verifiedName?.firstName?.trim();
  const last = input.verifiedName?.lastName?.trim();
  if (!first || !last) {
    // The records lane files anyway — see FILES_WITHOUT_A_NAME. The ticket
    // carries no name at all rather than a half of one: a first name with no
    // surname is a search a clerk cannot run, and the ticket says why.
    if (FILES_WITHOUT_A_NAME.has(input.slug)) {
      return { file: true, callerSaid: callerLines(input.transcript).join(" ") };
    }
    return { file: false, reason: "no-name" };
  }
  return {
    file: true,
    callerSaid: callerLines(input.transcript).join(" "),
    firstName: first,
    lastName: last,
  };
}

/**
 * THERE IS NO PLACEHOLDER IDENTITY, DELIBERATELY.
 *
 * An earlier draft filed anonymous requests as "Unidentified Caller" with the
 * phone number in the description. `create-ticket` would have accepted it — it
 * rejects placeholder names only on the submit-ticket path, which this does
 * not use — so the constraint here is the operator's, not the API's.
 *
 * Wayne, 2026-09-03, asked directly: **"no name no ticket."**
 *
 * Reading a name out of the transcript instead is not the workaround it looks
 * like. Standing instruction 3 — *"why are you trying to determine what a
 * first name is? You'll never ever get it to work like that"* — rules out this
 * module regexing for a capitalised word, and it was right when it was said.
 * The name used is the one `lookup_patient` verified against the record.
 *
 * v180: the same instruction says extraction is the MODEL's job, and the
 * operator's 2026-10-29 ruling asked for the name in the transcript. So where
 * this would skip as `no-name`, the runner asks a model for the patient's name
 * and files under it only when the caller said it as one name in one of
 * their turns (`nameFromTheRecording.ts`). Still no placeholder: no name found, no ticket.
 */

/**
 * The description every swept ticket carries, verbatim.
 *
 * A CONSTANT ON PURPOSE. It is a patient-facing SMS body and this path has no
 * model to write one safely, so there is nothing call-specific to vary and
 * nothing that could leak by accident. Plain GSM-7, so it stays one segment.
 *
 * The wording is a placeholder for the operator's: it states the fact and
 * promises only what standing instruction 10 already promises — that somebody
 * follows up. Change the words freely; do not put anything from the call in
 * them.
 */
export const SWEPT_TICKET_DESCRIPTION =
  "Callback request taken during your call. A team member will follow up with you.";

/**
 * THE QUEUES THAT ASSIGN BY A FIELD THE CALL HAS TO SUPPLY.
 *
 * Optical (1) routes by OFFICE and Surgery (2) by SURGEON, and create-ticket
 * refuses a ticket in either that carries neither — *"Missing required
 * information: office"* / *"…: surgeon"*. That refusal is a QUESTION for a
 * caller who is still on the line. Everything that files at TEARDOWN — this
 * sweep and the setup-failure floor — runs after the caller has gone, so
 * there is nobody left to ask and the refusal is final: the request the
 * floor exists to save is lost on the last step.
 *
 * MEASURED in `voice_agent_api_logs`, 2026-09-28..10-08: **36 optical and 51
 * surgery swept requests were refused HTTP 400 for exactly that, against 2
 * and 3 accepted** (the app derived the field from the patient's record on
 * those). Tech (3) and records (16) carry no routing field and filed every
 * swept request in the same window (101 and 88).
 *
 * `routingAskExhausted` is the app's own unassigned exit (operator ruling
 * 2026-09-02, honoured for departments 1 and 2 by the app's
 * `DEPARTMENTS_WITH_UNASSIGNED_EXIT`). The app still tries to DERIVE the
 * office or surgeon from the verified patient first and takes the exit only
 * when that fails (`routing-gate.ts`, the derive step runs before the exit),
 * so the flag can never cost a ticket a routing it would otherwise have got.
 *
 * Exported because the setup-failure floor files at teardown too and must
 * read the SAME set — two copies of a department list is the drift this repo
 * has already paid for (`explicitAsk.ts`).
 */
export const TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS: ReadonlySet<number> = new Set([1, 2]);

export type SweepReasonSource = "captured" | "drafted" | "summary" | "transcript" | "placeholder";

export interface SweepReason {
  requestTypeId: number;
  requestReasonId: number;
  source: SweepReasonSource;
}

/**
 * WHERE THE SWEPT TICKET'S REASON COMES FROM.
 *
 * The sweep used to file every recovered request as the department's
 * "Other - See Description". Six records tickets on 2026-10-30..31 landed
 * with no usable reason even though the call summary already named one
 * (Support Desk batch Oct 31 item 3). The order is fixed:
 *
 *   1. the reason the agent already captured (classify_* / file_*)
 *   2. classify the call summary, when one exists
 *   3. classify the caller's own words
 *   4. the placeholder, and ONLY when neither a summary nor a transcript
 *      exists to derive from
 *
 * Classification is the lane's own taxonomy, so a records copy request
 * becomes 500 and not 547, and a reason from another department is dropped
 * the same way the live filing tools drop it.
 */
export function resolveSweepReason(input: {
  departmentId: number;
  capturedReason?: { requestTypeId: number; requestReasonId: number };
  summary?: string;
  callerSaid?: string;
  draftedRequest?: string;
  toolEvents?: readonly SweepToolEvent[];
}): SweepReason {
  const placeholder = otherReasonFor(input.departmentId);
  if (!placeholder) {
    throw new Error(`resolveSweepReason: no catch-all for department ${input.departmentId}`);
  }
  const floor = (): SweepReason => ({
    requestTypeId: placeholder.requestTypeId,
    requestReasonId: placeholder.requestReasonId,
    source: "placeholder",
  });

  const captured =
    pairIfOwned(input.departmentId, input.capturedReason) ??
    capturedReasonFromEvents(input.departmentId, input.toolEvents);
  if (captured) return { ...captured, source: "captured" };

  // v166: the model's own `request_description`, before the summary and the
  // caller's raw words — it is the request already isolated from the
  // identity interview. Only a specific hit counts; a catch-all reading of it
  // lets the summary and the transcript have their say.
  const drafted = input.draftedRequest?.trim();
  if (drafted) {
    const hit = classifySweepText(input.departmentId, drafted);
    if (hit && !isCatchAll(input.departmentId, hit.requestReasonId)) return { ...hit, source: "drafted" };
  }

  const summary = input.summary?.trim();
  if (summary) {
    const hit = classifySweepText(input.departmentId, summary);
    if (hit) return { ...hit, source: "summary" };
  }

  const spoken = input.callerSaid?.trim();
  if (spoken) {
    const hit = classifySweepText(input.departmentId, spoken);
    if (hit) return { ...hit, source: "transcript" };
  }

  return floor();
}

function capturedReasonFromEvents(
  departmentId: number,
  events: readonly SweepToolEvent[] | undefined,
): { requestTypeId: number; requestReasonId: number } | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i].requestReasonId;
    if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) continue;
    const pair = reasonPairFor(departmentId, id);
    if (pair) return pair;
  }
  return undefined;
}

function pairIfOwned(
  departmentId: number,
  pair: { requestTypeId: number; requestReasonId: number } | undefined,
): { requestTypeId: number; requestReasonId: number } | undefined {
  if (!pair) return undefined;
  const owned = reasonPairFor(departmentId, pair.requestReasonId);
  if (!owned) return undefined;
  // Trust the looked-up type, not a type the caller invented beside a valid id.
  return owned;
}

function reasonPairFor(
  departmentId: number,
  reasonId: number,
): { requestTypeId: number; requestReasonId: number } | null {
  const named = (() => {
    switch (departmentId) {
      case 16: {
        const hit = recordsReasonById(reasonId);
        return hit
          ? { requestTypeId: hit.requestTypeId, requestReasonId: hit.requestReasonId }
          : null;
      }
      case 3: {
        const hit = techReasonById(reasonId);
        return hit
          ? { requestTypeId: hit.requestTypeId, requestReasonId: hit.requestReasonId }
          : null;
      }
      case 2: {
        const hit = surgeryReasonById(reasonId);
        return hit
          ? { requestTypeId: hit.requestTypeId, requestReasonId: hit.requestReasonId }
          : null;
      }
      case 1: {
        const hit = classificationByReasonId(reasonId);
        return hit
          ? { requestTypeId: hit.requestTypeId, requestReasonId: hit.requestReasonId }
          : null;
      }
      default:
        return null;
    }
  })();
  if (named) return named;
  const other = otherReasonFor(departmentId);
  if (other && other.requestReasonId === reasonId) {
    return { requestTypeId: other.requestTypeId, requestReasonId: other.requestReasonId };
  }
  return null;
}

/** The department's own "Other - See Description" — or a reason named like one. */
function isCatchAll(departmentId: number, reasonId: number): boolean {
  if (otherReasonFor(departmentId)?.requestReasonId === reasonId) return true;
  return /\bother\b/i.test(reasonLabelFor(departmentId, reasonId) ?? "");
}

/** The taxonomy's own name for a reason on this queue. Never caller text. */
export function reasonLabelFor(departmentId: number, reasonId: number): string | undefined {
  switch (departmentId) {
    case 16:
      return recordsReasonById(reasonId)?.requestReason;
    case 3:
      return techReasonById(reasonId)?.requestReason;
    case 2:
      return surgeryReasonById(reasonId)?.requestReason;
    case 1:
      return classificationByReasonId(reasonId)?.requestReason;
    default:
      return undefined;
  }
}

/**
 * THE SWEPT TICKET'S DESCRIPTION — v166.
 *
 * The ticketing app files any voice ticket whose description is exactly the
 * placeholder below as "Callback needed - reason not captured"
 * (`lib/voice-agent/no-reason.ts`). Six calls on 2026-10-28..11-01 landed
 * there, several with the reason already known. In order:
 *
 *   1. the request as the MODEL wrote it (`draftedRequest`) — the text every
 *      ordinary filing sends as its description, GSM-7 sanitised;
 *   2. v201: what the caller asked for, read from the recording by a model
 *      after the call (`requestFromTheRecording.ts`), checked in code;
 *   3. on queues other than Medical Records, a specific reason the sweep
 *      classified, by the taxonomy's own NAME (never the caller's words);
 *   4. the placeholder.
 *
 * NOT 2 ON MEDICAL RECORDS: a records ticket with a reason opens an access
 * case and can start the CAP clock, and a regex reading of the transcript is
 * not enough to start a statutory clock on (the app keeps a placeholder
 * ticket out of that on purpose).
 */
export function sweptTicketDescription(
  departmentId: number,
  reason: SweepReason,
  draftedRequest: string | undefined,
  requestFromRecording?: string,
): string {
  const drafted = draftedRequest ? sanitizeForSms(draftedRequest).value.replace(/\s+/g, " ").trim() : "";
  if (drafted) return drafted;
  // v201: what the caller asked for, read from the recording after the call
  // and checked in `usableRequest` — a sentence beats a taxonomy label.
  const heard = requestFromRecording ? sanitizeForSms(requestFromRecording).value.replace(/\s+/g, " ").trim() : "";
  if (heard) return heard;
  if (departmentId !== 16 && reason.source !== "placeholder" && !isCatchAll(departmentId, reason.requestReasonId)) {
    const label = reasonLabelFor(departmentId, reason.requestReasonId);
    if (label) return `Callback request about: ${sanitizeForSms(label).value}. A team member will follow up with you.`;
  }
  return SWEPT_TICKET_DESCRIPTION;
}

/**
 * A CALL THAT LOOKS ANSWERED, NOT A REQUEST — v166, ticket 70265.
 *
 * An insurance representative asked only for the fax number, was given it,
 * said thanks, and the sweep filed a callback ticket. Telling an answered
 * question from a request is a judgement about content (standing instruction
 * 3), so this does NOT skip the filing. It only says so on the staff note
 * when every one of these holds: no classify or filing tool ran, the model
 * drafted no request, an agent line gave a phone or fax number, and the
 * caller's LAST line was a thank-you or a goodbye.
 */
export function looksInfoOnly(input: Pick<SweepInput, "transcript" | "toolEvents" | "draftedRequest">): boolean {
  if (input.draftedRequest?.trim()) return false;
  if (input.toolEvents.some((e) => /^(file_.*_ticket|classify_.*_request)$/.test(e.name))) return false;
  const lines = input.transcript.split("\n");
  const agentGaveNumber = lines.some(
    (l) => l.startsWith("AGENT:") && /(\d[\s.-]?){10}/.test(l.replace(/[()]/g, "")),
  );
  if (!agentGaveNumber) return false;
  const said = callerLines(input.transcript);
  const last = (said[said.length - 1] ?? "").toLowerCase().replace(/[.,!?¿¡]/g, "").trim();
  return /\b(thank you|thanks|thank|bye|goodbye|gracias|adios|that's all|that is all|perfect)\b/.test(last);
}

/**
 * v201: THE STAFF NOTE WHEN THE DESCRIPTION WAS READ FROM THE RECORDING.
 * The agent did not write the request down; a model read it from the call
 * after the caller hung up. Exported so the test reads the same words.
 */
export const REQUEST_FROM_RECORDING_NOTE =
  "REQUEST READ FROM THE RECORDING — the agent did not write this request down; a model read it from the call after the caller hung up. Check the recording before acting:";

/**
 * v203: A SWEPT RECORDS REQUEST CARRIES WHAT WAS ASKED, AND OPENS A CASE ON
 * PATHWAY REVIEW. Operator, 2026-11-11: "yes ... open it on pathway review."
 *
 * v201 kept the placeholder description on Medical Records because a real
 * description opens a records case and a swept ticket states no requester.
 * Measured, department 16, 2026-10-30..11-10: 64 swept records tickets
 * carried the placeholder and opened no case (the app's no-captured-reason
 * rule). Now the sentence read from the recording is the description on
 * Medical Records too, and the ticketing app decides the rest:
 *
 *   - a records request (its `recordsLinePurpose` reads 'records') opens a
 *     case. The swept ticket sends no requestorType, requestPathway or
 *     capClockApplies, so `decidePathway` falls to its text-only steps,
 *     every one of which sets needsReview: the case opens on
 *     `pathway_review`, and its clock runs from receipt until a person
 *     confirms who asked (the app's rule for any request with no stated
 *     requester, SOP §4.2);
 *   - a sentence about something else (an appointment, a question) is
 *     re-routed by the app's records-line classifier; a named one reaches
 *     the department that works it, and a nameless one is refused (only
 *     Medical Records files without a name), so the default filer files it
 *     again with the placeholder, which is exactly what `main` filed.
 */


export const INFO_ONLY_NOTE =
  "POSSIBLY INFO-ONLY (info_only): the agent gave a phone/fax number and the caller ended with thanks; no request tool ran. Close if no follow-up is needed.";

function classifySweepText(
  departmentId: number,
  text: string,
): { requestTypeId: number; requestReasonId: number } | null {
  switch (departmentId) {
    case 16: {
      const { classification } = classifyRecordsRequest(text);
      return { requestTypeId: classification.requestTypeId, requestReasonId: classification.requestReasonId };
    }
    case 3: {
      const { classification } = classifyTechRequest(text);
      return { requestTypeId: classification.requestTypeId, requestReasonId: classification.requestReasonId };
    }
    case 2: {
      const { classification } = classifySurgeryRequest(text);
      return { requestTypeId: classification.requestTypeId, requestReasonId: classification.requestReasonId };
    }
    case 1: {
      const hit = classifyOptical(text);
      return hit
        ? { requestTypeId: hit.requestTypeId, requestReasonId: hit.requestReasonId }
        : null;
    }
    default:
      return null;
  }
}

export interface SweptTicket {
  /** Staff-only. Travels in callData, never in the patient-facing description. */
  staffNote: string;
  /** The lane that answered. Travels so `callData.agentUsed` names the queue
   * a human would recognise, the same string every other filing path uses. */
  slug: string;
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  /** Absent on a records-lane request nobody identified — never a placeholder. */
  patientFirstName?: string;
  patientLastName?: string;
  patientPhone: string;
  description: string;
  priority: "low" | "medium" | "high";
  callSid: string;
  idempotencyKey: string;
  /**
   * Present only on a queue that routes by a field the call must supply —
   * see TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS. Never sent elsewhere: on any
   * other department it means nothing to the app and would only claim an
   * ask that did not happen.
   */
  routingAskExhausted?: true;
  /** v231: the date of birth the caller gave, only under a name the caller gave. */
  patientBirthYear?: string;
  patientBirthMonth?: string;
  patientBirthDay?: string;
}

/**
 * v231: THE STAFF NOTE WHEN THE DATE OF BIRTH IS THE ONE THE CALLER SAID.
 *
 * Measured over the 14 days to 2026-11-14 (01:00 UTC), optical, surgery and
 * tech: 119 tickets this sweep filed with no date of birth; a transcript
 * pattern finds a date the caller gave in answer to the ask on 40 of them, and
 * on the 2026-11-12/13 corpus that pattern over-counts by about 1 in 10. The
 * sweep carried a date of birth only from a certain lookup, so a caller who
 * answered the question and then hung up before any filing tool ran left a
 * ticket without it. Only the answer to an ask is carried: a date the caller
 * volunteered as "date of birth <date>" with nobody asking is not (the reader
 * for it was built and withdrawn on #480). Not matched to a record, and the
 * note says so. Exported so the test reads the same words.
 */
export const CALLER_DOB_NOTE =
  `DATE OF BIRTH AS THE CALLER SAID IT on the call — not matched to a patient record; confirm it against the chart before acting.`;

/** The names a caller gave on the call, under which their date of birth is carried. */
const CALLER_NAMED: ReadonlySet<NonNullable<SweepInput["nameSource"]>> = new Set(["stated", "spoken", "heard"]);

function callerDobFields(
  input: SweepInput,
): { patientBirthYear: string; patientBirthMonth: string; patientBirthDay: string } | undefined {
  // A caller-given name always reaches the decision with both halves.
  if (!input.callerDob || !input.nameSource || !CALLER_NAMED.has(input.nameSource)) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.callerDob);
  return m ? { patientBirthYear: m[1]!, patientBirthMonth: m[2]!, patientBirthDay: m[3]! } : undefined;
}

/**
 * v182: THE STAFF NOTE WHEN THE NAME CAME FROM THE CALLING NUMBER.
 *
 * Nobody on the call said a patient's name. The number belongs to one patient
 * in the person base, so the request is filed under that record rather than
 * dropped (operator ruling 2026-10-29, the phone-match half; approved as filed
 * 2026-11-06). It is not confirmed: the caller may be the patient, a relative
 * calling about the patient, or someone calling about somebody else, and the
 * note says so. Exported so the test reads the same words the ticket carries.
 */
export const NUMBER_RECORD_NOTE =
  `NAME FROM THE CALLING NUMBER'S PATIENT RECORD — no patient name was said on the call; the calling number belongs to this one patient on file. ` +
  `Not confirmed: the caller may be a relative or someone else calling about this patient, or about someone else. Check the recording and the chart before acting.`;

/**
 * The payload. `idempotencyKey` is derived from the call sid so a retry, a
 * re-run of the backfill over the same call, and the live sweep racing the
 * backfill all collapse to one ticket — the key is what held duplicate filing
 * to 3 calls in 2,086 when it was measured.
 */
export function buildSweptTicket(
  input: SweepInput,
  decision: Extract<SweepDecision, { file: true }>,
): SweptTicket {
  const departmentId = DEPARTMENT_BY_SLUG[input.slug]!;
  const callerSaid = decision.callerSaid;
  const readFromRecording =
    !input.draftedRequest?.trim() && input.requestFromRecording?.trim() ? input.requestFromRecording.trim() : undefined;
  const sentenceDescribes = readFromRecording;
  const reason = resolveSweepReason({
    departmentId,
    capturedReason: input.capturedReason,
    summary: input.summary,
    callerSaid,
    draftedRequest: input.draftedRequest,
    toolEvents: input.toolEvents,
  });
  const infoOnly = looksInfoOnly(input);
  const callerDob = callerDobFields(input);
  return {
    ...(callerDob ?? {}),
    slug: input.slug,
    departmentId,
    requestTypeId: reason.requestTypeId,
    requestReasonId: reason.requestReasonId,
    ...(decision.firstName ? { patientFirstName: decision.firstName } : {}),
    ...(decision.lastName ? { patientLastName: decision.lastName } : {}),
    patientPhone: input.callerPhone,
    /**
     * THE DESCRIPTION IS A PATIENT-FACING SMS BODY. Nothing from the call
     * goes in it — not the annotation, and NOT THE CALLER'S OWN WORDS.
     *
     * Round 5 took the recovery annotation, the call reference and the
     * callback number out of here and left `callerSaid`, on the reasoning
     * that the four ordinary filing tools put "the request, in the caller's
     * own words" in the description. That reasoning was wrong, and the
     * comment that stated it sat directly above the line that broke it
     * (Codex, PR #268 round 14).
     *
     * THE ORDINARY TOOLS DO NOT PUT THE TRANSCRIPT THERE. Their description
     * is written by the MODEL, which has isolated the request from the rest
     * of the call. This sweep runs at teardown with no model, and
     * `callerSaid` is every CALLER line joined — so on the normal recovered
     * path it carries the identity interview: the caller's name, their full
     * date of birth, and whatever else they said. All of it texted back to
     * the number on the ticket, unencrypted, and to a stranger if that
     * number was mis-keyed.
     *
     * Isolating the request from the interview is extraction, and extraction
     * is the model's job, not a regex's — the operator settled that. With no
     * model here there is no safe way to quote the caller at all, so the
     * description says only that a request was taken. Everything the caller
     * said goes to staff below, where the patient never sees it.
     */
    // v166: the model's drafted request, else a classified reason's name off
    // Medical Records, else the placeholder — see sweptTicketDescription.
    // Still never the caller's raw words.
    description: sweptTicketDescription(departmentId, reason, input.draftedRequest, sentenceDescribes),
    /**
     * The staff side. `callData` maps to the ticket's own call-metadata
     * columns and is not part of any message to the patient, so the
     * annotation, the call reference AND the caller's own words belong
     * here — where the person picking the ticket up sees them and the
     * caller never does. Losing the transcript entirely would have made the
     * ticket unactionable, which is the trade the leak was buying.
     */
    staffNote:
      `Recovered at teardown — the agent did not file this request.\n` +
      (decision.firstName && decision.lastName
        ? input.nameSource === "stated"
          ? `NAME AS THE CALLER GAVE IT — not matched to a patient record; confirm it against the chart before acting.\n`
          : input.nameSource === "spoken"
            ? `NAME FROM THE CALLING NUMBER'S PATIENT RECORD — the caller said this name on the call, but no date of birth was confirmed; check the chart before acting.\n`
            : input.nameSource === "heard"
              ? `NAME TAKEN FROM THE RECORDING — the caller said this name on the call; it is not matched to a patient record. Confirm it against the chart before acting.\n`
              : input.nameSource === "number"
                ? `${NUMBER_RECORD_NOTE}\n`
                : ""
        : `PATIENT NAME NOT CAPTURED — nobody was identified on this call; take the name from the recording before matching this to a chart.\n`) +
      (callerDob ? `${CALLER_DOB_NOTE}\n` : "") +
      (readFromRecording ? `${REQUEST_FROM_RECORDING_NOTE} ${readFromRecording}\n` : "") +
      (infoOnly ? `${INFO_ONLY_NOTE}\n` : "") +
      `Call back on ${input.callerPhone}. Call reference ${input.callSid}.\n` +
      `What the caller said: ${callerSaid}`,
    // Not "medium". Nobody has looked at this request yet and the caller has
    // been told nothing true about it; on three of today's five the agent said
    // it was filed when it was not.
    priority: "high",
    callSid: input.callSid,
    /**
     * THE SAME KEY THE AGENT'S OWN TOOLS USE — `call-<sid>`, deliberately.
     *
     * A sweep-specific key would make this idempotent only against itself. On
     * `call-<sid>` it is idempotent against the AGENT too: if a filing POST is
     * sitting in the outbox waiting to retry when the call ends, the sweep and
     * the retry collide on one key and the caller gets one ticket, not two.
     * `alreadyFiledByTool` cannot see that case — the tool did not succeed —
     * so this is the second lock under it, and duplicate filing measured 3 in
     * 2,086 with this key in place.
     *
     * It also inherits the guard in durableTicketFiling: only a real Twilio
     * sid is keyed. A sentinel would produce one key shared by every caller
     * who hit it, and the second one's request would be silently dropped.
     */
    idempotencyKey: `call-${input.callSid}`,
    /**
     * THE CALLER IS GONE, SO THE ASK IS EXHAUSTED BY DEFINITION. A refusal
     * for the office or the surgeon is a question, and at teardown there is
     * nobody to put it to. See TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS for the
     * measurement and for why the flag cannot cost a ticket its routing.
     */
    ...(TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS.has(departmentId)
      ? { routingAskExhausted: true as const }
      : {}),
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
