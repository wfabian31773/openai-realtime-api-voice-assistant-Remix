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
 * ACCENTS ARE FOLDED, NOT STRIPPED TO SPACES. The character class keeps only
 * `a-z0-9'\s.?!`, so without decomposing first every accented letter became a
 * SPACE and "sí" read as "s" — which would make Spanish unreadable rather than
 * merely unsupported. `nameKey` already treats an accent as the same person.
 *
 * Every cue below is word-based, so keeping three marks changes none of them:
 * "new glasses." still reads as an object, and so does "new, glasses", because
 * a comma is still folded to a space.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
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
 * The patient-status question, in the languages these lanes actually speak.
 *
 * ENGLISH AND SPANISH, and the second is Codex P1 on this PR rather than a
 * nice-to-have. Every queue lane tells the model to translate its questions and
 * continue in the caller's language, so a Spanish exchange — "¿paciente nuevo o
 * paciente existente?" / "nuevo" — opened no window at all and the gate simply
 * did not exist for that caller. **Measured over the four runtime queue lanes,
 * 2026-09-12..18, 1,843 substantive calls: 199 caller sides carry a Spanish cue
 * — 10.8%, tech 60, surgery 71, optical 68.** One caller in nine is not an
 * outlier, which is why this is supported rather than noted.
 *
 * WHAT IS NOT COVERED, stated rather than implied: every other language. The
 * runtime can switch to any of them mid-call (proven live on a Turkish caller,
 * 2026-09-03) and this reader opens no window for them, so nothing is
 * suppressed and the call behaves exactly as it does today. That is the
 * fail-safe direction, and it is the same call `dobParts.ts` makes about
 * Turkish for the same field. Guessing at a translation inside a gate that
 * REFUSES TO LOOK FOR A RECORD is worse than not firing.
 *
 * THE NOUN MUST BE THERE — Codex P1, this PR. Without it any same-sentence
 * new/existing pair opened a window, so *"Do you need a new prescription or
 * refill an existing one?"* answered with a bare "New." read as a NEW PATIENT
 * and suppressed the lookup. That is the wrong direction: an existing patient
 * who wants a new prescription, whose record we then refuse to look for. It is
 * the hazard the 94%-wrong measurement below describes, arriving through the
 * AGENT's line rather than the caller's — and the object test cannot catch it,
 * because the noun is in the question while the caller said one word.
 *
 * Measured over the same 1,843 calls: the agent offered a new/existing
 * alternation on exactly ONE, and that one was NOT about patient status. A low
 * base rate today because the question is not asked yet, and the narrowing is
 * free: the prompt says "new patient or an existing patient".
 *
 * Spanish puts the adjective after the noun, so the patterns are written per
 * language rather than translated word for word.
 */
const STATUS_QUESTION: readonly RegExp[] = [
  // English: the noun bound to one side of the alternation.
  /\bnew\s+patient\b[^.?!]{0,30}\bor\b[^.?!]{0,25}\bexisting\b/,
  /\bnew\b[^.?!]{0,20}\bor\b[^.?!]{0,25}\bexisting\s+patient\b/,
  /\bexisting\s+patient\b[^.?!]{0,30}\bor\b[^.?!]{0,25}\bnew\b/,
  /\bexisting\b[^.?!]{0,20}\bor\b[^.?!]{0,25}\bnew\s+patient\b/,
  // Spanish.
  /\bpaciente\s+nuev[oa]\b[^.?!]{0,30}\bo\b[^.?!]{0,25}\bexistente\b/,
  /\bnuev[oa]\b[^.?!]{0,20}\bo\b[^.?!]{0,25}\bpaciente\s+existente\b/,
  /\bpaciente\s+existente\b[^.?!]{0,30}\bo\b[^.?!]{0,25}\bnuev[oa]\b/,
];

/**
 * THE BARE RE-ASK — "Sorry, new or existing?" — and it is a SEPARATE, WEAKER
 * window rather than another entry above, which is Codex round 2's P1.
 *
 * Round 1 narrowed the window to alternations naming the patient, and that
 * killed the bare re-ask — the correction path this gate's reversibility leans
 * on. Admitting it back as a clause-final pattern reopened the hole from the
 * OTHER side: nothing was required BEFORE the pair, so *"Is the prescription
 * new or existing?"* still opened a window and a bare "New." still suppressed a
 * real patient's lookup.
 *
 * So a bare pair is a re-ask only under TWO conditions, and they are
 * independent rather than belt-and-braces theatre — each closes cases the other
 * does not:
 *
 *  1. **A QUALIFIED window must already have opened on this call.** A bare pair
 *     cannot START a status conversation; it can only continue one. That is
 *     what makes it a re-ask rather than a guess.
 *  2. **A bare WORD does not answer it.** Inside a re-ask window only an
 *     EXPLICIT cue counts, so "New." — which is what an unrelated alternation
 *     draws — reads as no answer at all, while "Existing, I came in last year"
 *     still lands. This is the one that closes the noun-before-the-pair case
 *     even when condition 1 happens to be satisfied.
 */
const BARE_REASK: readonly RegExp[] = [
  /\bnew\s+or\s+(an?\s+)?existing\s*[.?!]*$/,
  /\bexisting\s+or\s+(an?\s+)?new\s*[.?!]*$/,
  /\bnuev[oa]\s+o\s+existente\s*[.?!]*$/,
  /\bexistente\s+o\s+nuev[oa]\s*[.?!]*$/,
];

/**
 * Does this agent line ASK the new-or-existing question?
 *
 * The ALTERNATION is required, which is the mention-is-not-an-ask rule
 * `spokenDob` had to be corrected into (Codex P1b on PR #275: "I have your date
 * of birth, thank you" opened a window because it merely named the subject).
 * "I have you as a new patient, thank you" names the subject too, and it is not
 * a question. `STATUS_QUESTION` carries the rest of the reasoning.
 */
type WindowKind = 'qualified' | 'reask';

function opensStatusWindow(agent: string, seenQualified: boolean): WindowKind | null {
  if (STATUS_QUESTION.some((re) => re.test(agent))) return 'qualified';
  // A bare pair continues a status conversation; it cannot start one.
  if (seenQualified && BARE_REASK.some((re) => re.test(agent))) return 'reask';
  return null;
}

/**
 * A noun with "new" means the caller is describing a THING, not themselves.
 *
 * "I need new glasses", "a new prescription", "my new insurance card" — these
 * are 16 of tech's 36 and 3 of optical's 7. `patient` is deliberately absent:
 * "new patient" IS the answer.
 *
 * SPANISH PUTS THE ADJECTIVE AFTER THE NOUN, so the same idea needs the mirror
 * order — "lentes nuevos", not "nuevos lentes". Translating the English pattern
 * word for word would have matched nothing and read it as an answer.
 */
const NEW_TAKES_AN_OBJECT =
  /\bnew\s+(glasses|frames?|lenses?|lens|prescriptions?|pairs?|insurances?|cards?|numbers?|phones?|addresses|address|doctors?|providers?|contacts?|appointments?|referrals?|jobs?|plans?|ones?)\b/;

const NEW_TAKES_AN_OBJECT_ES =
  /\b(lentes|gafas|anteojos|receta|recetas|seguro|numero|tarjeta|cita|citas|direccion|marcos|armazon)\s+nuev[oa]s?\b/;

/**
 * SAID THEY ARE NOT AN EXISTING PATIENT — checked BEFORE everything else.
 *
 * Codex P1, this PR, and a real inversion: `EXISTING_CUES` carries a broad
 * `\b(been|was)\s+(a\s+)?patient\b`, so **"I've never been a patient" matched it
 * and read as EXISTING** — the lookup then ran and produced the very "no record
 * found" this gate exists to suppress. The specific negation has to be read
 * before the broad claim it negates.
 *
 * The mirror case stays intact and is tested both ways: "not a new patient" is
 * EXISTING, and nothing here matches it — `not a patient` cannot span the word
 * "new" that sits between, and `not an existing` does not appear in it.
 */
const NOT_AN_EXISTING_PATIENT = [
  /\bnever\s+(been|was)\s+(an?\s+)?patient\b/,
  /\bnever\s+been\s+seen\b/,
  /\bnot\s+an?\s+existing\b/,
  /\bnot\s+a\s+patient\b/,
  /\b(haven't|have\s+not|hadn't|had\s+not)\s+been\s+(an?\s+)?patient\b/,
  /\bfirst\s+time\b/,
  /\bnever\s+been\s+(there|here)\b/,
  // Spanish. `no soy paciente` is deliberately NOT here as a bare prefix — see
  // NEGATED_NEW, because "no soy paciente NUEVO" is an EXISTING caller.
  /\bprimera\s+vez\b/,
  /\bnunca\s+he\s+(venido|estado|sido)\s*(paciente)?\s*[.?!]*$/,
  /\bnunca\s+he\s+sido\s+paciente\b/,
  /\bno\s+soy\s+paciente\s*[.?!]*$/,
  // Denied being an EXISTING patient, with the Spanish verb in between.
  /\bno\s+(soy|es|era|fui)\s+(un[oa]?\s+)?(paciente\s+)?existente\b/,
];

/**
 * SAID THEY ARE NOT A *NEW* PATIENT — which means they are EXISTING, and this
 * list is read before everything else.
 *
 * Every entry contains the word "new", so any reader that reaches for "new"
 * earlier gets these backwards. Round 1 caught the English half; Codex round 2
 * caught the Spanish, where `no soy paciente` had been written as a bare prefix
 * in the negated-EXISTING list and so answered "new" to *"No soy paciente
 * nuevo; soy paciente existente"* — an existing caller, suppressed.
 */
const NEGATED_NEW = [
  /\bnot\s+(an?\s+)?new\b/,
  /\bno\s+soy\s+paciente\s+nuev[oa]\b/,
  /\bno\s+es\s+paciente\s+nuev[oa]\b/,
  /\bno\s+soy\s+nuev[oa]\b/,
];

/** Said they have been here before. */
const EXISTING_CUES = [
  /\bexisting\b/,
  /\bi'?m\s+(an?\s+)?(current|established|returning|old)\b/,
  /\bi'?ve\s+been\s+(there|here|seen|coming|going)\b/,
  /\bi\s+(am|'m)\s+already\s+a\s+patient\b/,
  /\b(been|was)\s+(a\s+)?patient\b/,
  /\bi\s+(have|had)\s+an?\s+(appointment|surgery|exam)\b/,
  /\bi\s+(see|saw)\s+(dr|doctor)\b/,
  /\blast\s+(year|month|week|time)\s+i\b/,
  // Spanish.
  /\bexistente\b/,
  /\bya\s+soy\s+paciente\b/,
  /\bya\s+(he|habia)\s+(venido|estado|ido)\b/,
  /\bsoy\s+paciente\s+(de|del|aqui)\b/,
];

/** Said this is their first contact. */
const NEW_CUES = [
  /\bnew\s+patient\b/,
  /\bi'?m\s+new\b/,
  /\bi\s+am\s+new\b/,
  // Spanish.
  /\bpaciente\s+nuev[oa]\b/,
  /\bsoy\s+nuev[oa]\b/,
];


export type PatientStatus = 'new' | 'existing';

/**
 * STRIP THE OCCURRENCES A NEGATION GOVERNS, so what is left is a real claim.
 *
 * This is the governance rule this repo already paid for once. The grader's
 * `connect you` check was written THREE times because a narrative-wide negation
 * suppressed the affirmative half of "I can't transfer you, BUT I can connect
 * you with the team"; the rule that finally held is that a negation refuses a
 * phrase only when it GOVERNS it. Codex round 2 is the same lesson on this
 * field, arriving from the other side:
 *
 *   "I'm not an existing patient."                  -> the negation GOVERNS
 *                                                      "existing", so it is not
 *                                                      an existing claim
 *   "Existing, but I've never been to this office." -> it does not, so it IS
 *
 * A whole-turn test cannot separate those; both contain "existing" and a
 * negator. Stripping the governed occurrences and asking what remains can.
 */
function ungoverned(said: string, word: RegExp): boolean {
  const stripped = said
    // English: the negator sits directly in front of the word.
    .replace(/\b(not|never|no|isn't|aren't|wasn't)\s+(an?\s+)?(new|existing)\b/g, ' ')
    /**
     * SPANISH PUTS THE VERB IN BETWEEN — "no SOY PACIENTE existente" — so the
     * English shape cannot reach the word it governs. This was caught by the
     * round-2 test failing on its own Spanish case, not by review: the English
     * assertion passed and the Spanish one returned "existing" for a caller
     * who had just denied being an existing patient.
     */
    .replace(
      /\bno\s+(soy|es|era|fui|somos|son)\s+(un[oa]?\s+)?(paciente\s+)?(nuev[oa]s?|existente)\b/g,
      ' ',
    )
    .replace(/\b(no|nunca)\s+(un[oa]?\s+)?(nuev[oa]s?|existente)\b/g, ' ');
  return word.test(stripped);
}

const EXPLICIT_EXISTING = /\b(existing|existente)\b/;
const EXPLICIT_NEW = /\b(new\s+patient|paciente\s+nuev[oa])\b/;

/**
 * Read one window's caller turns.
 *
 * ORDER IS LOAD-BEARING IN THREE PLACES NOW, and each one cost a Codex P1.
 *
 *  1. **A NEGATED NEW CLAIM FIRST.** "Not a new patient", "I'm not new", "no soy
 *     paciente nuevo" are all EXISTING, and every one of them contains the word
 *     "new", so anything that reads "new" earlier gets them backwards. Round 2
 *     found the Spanish half of this: `no soy paciente` matched the
 *     negated-EXISTING list and returned "new" for a caller who had just said
 *     *"No soy paciente nuevo; soy paciente existente"*.
 *  2. **AN EXPLICIT EXISTING CLAIM BEATS A QUALIFYING CLAUSE.** Round 2 again:
 *     *"Existing, but I've never been to this office"* hit the broad `never
 *     been` cue and returned "new", suppressing a real patient. The direct
 *     answer to the question outranks a remark about one office — but only when
 *     no negation governs it, which is what `ungoverned` decides.
 *  3. **A NEGATED EXISTING CLAIM BEFORE THE BROAD EXISTING PROSE.** Round 1:
 *     "I've never been a patient" contains "been a patient".
 *
 * Then the explicit new claim, then the prose either way, and the BARE WORD
 * last and only in a qualified window — a bare "new" is what an unrelated
 * alternation draws, so a re-ask window does not accept one.
 */
function readWindow(turns: readonly string[], kind: WindowKind): PatientStatus | undefined {
  const said = turns.join(' ');
  if (!said) return undefined;
  if (NEGATED_NEW.some((re) => re.test(said))) return 'existing';
  if (ungoverned(said, EXPLICIT_EXISTING)) return 'existing';
  if (NOT_AN_EXISTING_PATIENT.some((re) => re.test(said))) return 'new';
  if (ungoverned(said, EXPLICIT_NEW)) return 'new';
  if (EXISTING_CUES.some((re) => re.test(said))) return 'existing';
  if (NEW_CUES.some((re) => re.test(said))) return 'new';
  /**
   * A bare word is an answer only when it is not describing something, and only
   * in a window the patient question itself opened. `kind === 'reask'` is the
   * weaker window (see BARE_REASK) and deliberately refuses bare words.
   */
  if (kind !== 'qualified') return undefined;
  if (/\bnew\b/.test(said) && !NEW_TAKES_AN_OBJECT.test(said)) return 'new';
  if (/\bnuev[oa]s?\b/.test(said) && !NEW_TAKES_AN_OBJECT_ES.test(said)) return 'new';
  return undefined;
}

/**
 * The caller's answer to the LATEST window that produced one.
 *
 * Latest rather than first, so an agent who asks again after a caller corrects
 * themselves gets the corrected answer, and a mis-heard first answer is not
 * permanent. A window whose turns say nothing either way is skipped rather than
 * clearing the earlier answer — silence is not a correction.
 *
 * `seenQualified` is why this cannot be a pure per-line function: a bare pair is
 * a re-ask only AFTER the patient question has been asked once on this call.
 */
export function readPatientStatus(lines: readonly string[]): PatientStatus | undefined {
  let answer: PatientStatus | undefined;
  let kind: WindowKind | null = null;
  let seenQualified = false;
  let turns: string[] = [];
  const close = () => {
    if (kind) {
      const read = readWindow(turns, kind);
      if (read) answer = read;
    }
    kind = null;
    turns = [];
  };
  for (const line of lines) {
    const agent = agentLine(line);
    if (agent !== null) {
      close();
      kind = opensStatusWindow(agent, seenQualified);
      if (kind === 'qualified') seenQualified = true;
      continue;
    }
    const caller = callerLine(line);
    if (caller !== null && kind) turns.push(caller);
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
