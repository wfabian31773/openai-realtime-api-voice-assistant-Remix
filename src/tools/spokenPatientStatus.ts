/**
 * WHAT THE CALLER SAID WHEN ASKED WHETHER THEY ARE NEW OR EXISTING.
 *
 * Operator ruling, 2026-09-19, answering the question PR #293 left open in as
 * many words: **"new should hard suppress lookup patient."**
 *
 * RULE ZERO 2a already said it and only the prompt was obeying it:
 *
 *   | **new** | **Stop looking.** No lookup, no appointment search, no "we
 *   have no record of you". A miss is now EXPECTED and is not a failure to
 *   report, retry or gate on. |
 *
 * #293 appended that as guidance and gated nothing — its own body said so and
 * put the gate to Wayne. This module is the gate's evidence source, and
 * `lookup_patient` is where it bites.
 *
 * ── WHY THE TRANSCRIPT AND NOT THE MODEL'S ARGUMENT ────────────────────────
 *
 * Because the model does not send arguments it is not forced to send, and that
 * is measured rather than assumed: on 2026-09-08 the date-of-birth gate refused
 * 75 substantive queue calls and `dobShape` read `(none)` on 75 of 75 — the
 * model omitted the field every single time, while in 51 of them the caller's
 * own transcribed words contained the answer. `spokenDob.ts` exists because of
 * that, and this is the same shape for a different field: the bridge posts the
 * record as it grows, and the tool reads the answer back by CallSid.
 *
 * `lookup_patient` does also declare `patient_status`, but only as the OVERRIDE
 * (see the tool). The transcript is the primary, because it is the one that
 * fires without the model's cooperation.
 *
 * ── THE WINDOW RULE IS THE WHOLE DESIGN, AND IT IS MEASURED ────────────────
 *
 * `spokenDob.ts` learned this the expensive way: callers say dates constantly
 * that are not their birthday, so the signal is not the date, it is WHERE they
 * said it. The same is true of the word "new", and these are the numbers, over
 * the four runtime queue lanes, 2026-09-15..18, 1,238 substantive calls with at
 * least one caller line:
 *
 *   | lane    | calls | "new" anywhere | "new <noun>" | "new patient" |
 *   |---------|-------|----------------|--------------|---------------|
 *   | tech    |   577 |             36 |           16 |             1 |
 *   | surgery |   400 |             10 |            4 |             2 |
 *   | optical |   261 |              7 |            3 |             0 |
 *
 * So a reader that swept the whole transcript for "new" would fire on 53 of
 * 1,238 calls (4.3%) and only 3 of those 53 contain "new patient" at all: the
 * rest are new glasses, a new prescription, a new insurance card, a new phone
 * number. It would be wrong on roughly 94% of its own firings, and every one
 * of those is a caller whose record we then refuse to look for.
 *
 * A PREMISE THIS CORRECTED, recorded because it was mine: I expected optical to
 * be the WORST lane, on the reasoning that "I need new glasses" is the commonest
 * sentence on an optical line. Optical is the LOWEST of the three, at 2.7%.
 * The window rule is right for the reason above and not for the one I assumed.
 *
 * AND THE TABLE IS THE BASELINE NOISE, NOT THE POPULATION. The question is not
 * asked in production yet (#293 is unmerged), so nobody in that data was
 * answering it. Those 53 calls are exactly what a windowless reader would
 * misfire on once the question starts being asked.
 *
 * So: a window opens on an AGENT line that ASKS the question, and closes at the
 * next thing the agent says. Nothing outside a window is looked at, and the
 * LATEST window wins — which is what gives a caller who corrects themselves a
 * way back without any latch to get stuck (CLAUDE.md already carries one sticky
 * misclassification that "silently forfeits the transfer for the rest of the
 * call"; this must not become a second).
 *
 * THE WINDOW SHAPE IS NARROW ON PURPOSE. `NEW_OR_EXISTING_ASK` is our own
 * sentence — RULE ZERO 2c, we shape the question so the answer arrives in the
 * shape the field needs — so requiring the alternation it instructs costs
 * nothing and fails SAFE: a model that phrases it some other way opens no
 * window, nothing is suppressed, and the call behaves exactly as it does today.
 */

import { isTwilioCallSid } from './callSid';

/**
 * Collapse to something the cues can be matched against, KEEPING `.?!`.
 *
 * Sentence ends are load-bearing and this nearly shipped without them: the
 * window test bounds itself with `[^.?!]`, and a fold that turned every `.`
 * into a space made that bound INERT. Probed before it was fixed, and the
 * probe is now a test: "I have a new prescription. Or is it an existing
 * order?" OPENED a window across two sentences and read the next caller turn
 * as an answer. `spokenDob.ts` splits on sentences for the same reason.
 *
 * Every cue below is word-based, so keeping three marks changes none of them:
 * "new glasses." still reads as an object, and so does "new, glasses", because
 * a comma is still folded to a space.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9'\s.?!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function callerLine(line: string): string | null {
  return line.startsWith('CALLER:') ? fold(line.slice('CALLER:'.length)) : null;
}

function agentLine(line: string): string | null {
  return line.startsWith('AGENT:') ? fold(line.slice('AGENT:'.length)) : null;
}

/**
 * Does this agent line ASK the new-or-existing question?
 *
 * The ALTERNATION is required, and that is the discriminator — the same
 * mention-is-not-an-ask rule `spokenDob` had to be corrected into (Codex P1b on
 * PR #275: "I have your date of birth, thank you" opened a window because it
 * merely named the subject). "I have you as a new patient, thank you" names the
 * subject too, and it is not a question.
 */
function opensStatusWindow(agent: string): boolean {
  // "new patient or an existing patient", "new or existing patient",
  // "existing patient or a new patient" — either order, with or without the
  // repeated noun, and tolerant of the articles in between.
  return (
    /\bnew\b[^.?!]{0,30}\bor\b[^.?!]{0,20}\bexisting\b/.test(agent) ||
    /\bexisting\b[^.?!]{0,30}\bor\b[^.?!]{0,20}\bnew\b/.test(agent)
  );
}

/**
 * A noun after "new" means the caller is describing a THING, not themselves.
 *
 * "I need new glasses", "a new prescription", "my new insurance card" — these
 * are 16 of tech's 36 and 3 of optical's 7. `patient` is deliberately absent
 * from this list: "new patient" IS the answer.
 */
const NEW_TAKES_AN_OBJECT =
  /\bnew\s+(glasses|frames?|lenses?|lens|prescriptions?|pairs?|insurances?|cards?|numbers?|phones?|addresses|address|doctors?|providers?|contacts?|appointments?|referrals?|jobs?|plans?|ones?)\b/;

/** Said they have been here before. Checked FIRST — see `readStatus`. */
const EXISTING_CUES = [
  /\bexisting\b/,
  /\bnot\s+(a\s+)?new\b/,
  /\bi'?m\s+(an?\s+)?(current|established|returning|old)\b/,
  /\bi'?ve\s+been\s+(there|here|seen|coming|going)\b/,
  /\bi\s+(am|'m)\s+already\s+a\s+patient\b/,
  /\b(been|was)\s+(a\s+)?patient\b/,
  /\bi\s+(have|had)\s+an?\s+(appointment|surgery|exam)\b/,
  /\bi\s+(see|saw)\s+(dr|doctor)\b/,
  /\blast\s+(year|month|week|time)\s+i\b/,
];

/** Said this is their first contact. */
const NEW_CUES = [
  /\bnew\s+patient\b/,
  /\bfirst\s+time\b/,
  /\bnever\s+been\b/,
  /\bnot\s+a\s+patient\b/,
  /\bi'?m\s+new\b/,
  /\bi\s+am\s+new\b/,
];

export type PatientStatus = 'new' | 'existing';

/**
 * Read one window's caller turns.
 *
 * ORDER IS LOAD-BEARING. Existing is checked before new because every existing
 * cue that contains the word "new" is a NEGATION of it — "not a new patient",
 * "I'm not new" — and a new-first reader would classify those backwards, which
 * is the direction that loses a real patient's record.
 */
function readWindow(turns: readonly string[]): PatientStatus | undefined {
  const said = turns.join(' ');
  if (!said) return undefined;
  if (EXISTING_CUES.some((re) => re.test(said))) return 'existing';
  if (NEW_CUES.some((re) => re.test(said))) return 'new';
  /**
   * A bare "new" is an answer only when it is not describing something. The
   * object test is what keeps "I need new glasses", said in answer to the
   * question, from reading as the answer.
   */
  if (/\bnew\b/.test(said) && !NEW_TAKES_AN_OBJECT.test(said)) return 'new';
  return undefined;
}

/**
 * The caller's answer to the LATEST window that produced one.
 *
 * Latest rather than first, so an agent who asks again after a caller corrects
 * themselves gets the corrected answer, and a mis-heard first answer is not
 * permanent. A window whose turns say nothing either way is skipped rather than
 * clearing the earlier answer — silence is not a correction.
 */
export function readPatientStatus(lines: readonly string[]): PatientStatus | undefined {
  let answer: PatientStatus | undefined;
  let open = false;
  let turns: string[] = [];
  const close = () => {
    if (open) {
      const read = readWindow(turns);
      if (read) answer = read;
    }
    open = false;
    turns = [];
  };
  for (const line of lines) {
    const agent = agentLine(line);
    if (agent !== null) {
      close();
      if (opensStatusWindow(agent)) open = true;
      continue;
    }
    const caller = callerLine(line);
    if (caller !== null && open) turns.push(caller);
  }
  close();
  return answer;
}

// ------------------------------------------------------------------ the store

interface Entry {
  status: PatientStatus;
  at: number;
}

const heard = new Map<string, Entry>();

/**
 * The model's overrides, kept apart from the transcript's reading. Declared
 * here beside `heard` rather than next to its writer, so neither store can be
 * referenced before it exists. `noteStatusOverride` says why they are two.
 */
const overridden = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of heard) {
    if (now - v.at > TTL_MS) heard.delete(k);
  }
  if (heard.size > MAX_ENTRIES) {
    let excess = heard.size - MAX_ENTRIES;
    for (const k of heard.keys()) {
      heard.delete(k);
      if (--excess <= 0) break;
    }
  }
}

function sweepOverrides(now: number): void {
  for (const [k, v] of overridden) {
    if (now - v.at > TTL_MS) overridden.delete(k);
  }
  if (overridden.size > MAX_ENTRIES) {
    let excess = overridden.size - MAX_ENTRIES;
    for (const k of overridden.keys()) {
      overridden.delete(k);
      if (--excess <= 0) break;
    }
  }
}

/**
 * The bridge, posting the call's record as it grows.
 *
 * The WHOLE record every time, for the reason `noteSpokenDob` gives: a caller
 * turn is REPLACED in place as its cumulative transcript is re-emitted, so
 * posting one line would store their first partial words instead of their
 * final ones. Re-reading the record is also what makes a later correction
 * land — the answer is recomputed from scratch on every post, so this store
 * never holds a verdict the transcript has stopped supporting.
 *
 * A read that finds no answer OVERWRITES NOTHING, so a caller who answers and
 * then talks for two minutes keeps their answer.
 *
 * A SENTINEL IS NOT A CALL. `spokenDob.ts` and `verifiedIdentity.ts` both state
 * this rule and this is the third: a model with no injected value supplies
 * "unknown" or "latest", and a truthiness check would make every such call
 * share one key — so one caller saying "new" would suppress the lookup for
 * every other caller whose SID was also missing.
 */
export function notePatientStatus(callSid: string | undefined, lines: readonly string[]): void {
  if (!isTwilioCallSid(callSid)) return;
  const read = readPatientStatus(lines);
  if (!read) return;
  const now = Date.now();
  sweep(now);
  heard.delete(callSid); // re-insert so insertion order tracks recency
  heard.set(callSid, { status: read, at: now });
}

/**
 * What this call's caller said they were, or undefined.
 *
 * Validated on the READ as well as the write, for the reason `spokenDobFor`
 * gives: not because a sentinel could be in the map, since the write refuses
 * one, but so the guard survives someone later relaxing the write.
 */
export function patientStatusFor(callSid: string | undefined): PatientStatus | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const now = Date.now();
  // The model's override wins, and it is the only thing that can. See
  // `noteStatusOverride` for why it cannot live in the same map.
  const override = overridden.get(callSid);
  if (override && now - override.at <= TTL_MS) return override.status;
  const entry = heard.get(callSid);
  if (!entry) return undefined;
  if (now - entry.at > TTL_MS) return undefined;
  return entry.status;
}

/**
 * The model's override, in ITS OWN STORE — and that separation is the whole
 * reason this function is not three lines shorter.
 *
 * The first version of this wrote into `heard`, which cannot work and is worth
 * recording: `notePatientStatus` RECOMPUTES from the transcript on every caller
 * turn, and the transcript's latest window still says "new" — that is why the
 * suppression fired in the first place. So an override written there would have
 * been clobbered by the next thing the caller said, and the escape hatch the
 * refusal advertises would have closed again a second after the model used it.
 *
 * It is deliberately STICKY. An override errs toward LOOKING SOMEBODY UP, and
 * the two directions do not cost the same: a lookup that misses costs one tool
 * call, while a suppression that should not have happened loses a record on the
 * lanes where 63% of found-nobody callers are in `patients_master`.
 */
export function noteStatusOverride(callSid: string | undefined, status: PatientStatus): void {
  if (!isTwilioCallSid(callSid)) return;
  const now = Date.now();
  sweepOverrides(now);
  overridden.delete(callSid);
  overridden.set(callSid, { status, at: now });
}

/** Tests only. */
export function resetPatientStatuses(): void {
  heard.clear();
  overridden.clear();
}
