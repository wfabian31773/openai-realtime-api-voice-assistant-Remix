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
 * ── THE READER IS SMALL ON PURPOSE, AND THIS IS THE THIRD ROUND'S ANSWER ────
 *
 * Codex found NINE P1s here across three rounds and every single one was the
 * same shape: a broad PROSE cue answered `new`, and a negation or a qualifier
 * in front of it made that answer false. Rounds 1 and 2 were fixed
 * structurally (governance, window kinds); round 3 arrived with three more of
 * the identical shape, which is the point at which another entry on a list
 * stops being a fix. The recommendation was published on #293 and in the v59
 * marker row before round 3 landed, so it is applied here rather than argued
 * again: **the prose families that answer `new` are DELETED, not guarded.**
 *
 * WHAT WENT, AND EACH FOR A REASON ABOUT THE CUE ITSELF RATHER THAN SAFETY:
 *
 *  - `first time` / `primera vez` — a first time CALLING is not a first time as
 *    a patient. "First time calling, I've been a patient for years" is a real
 *    sentence, and so is Codex's *"No, this isn't my first time."*
 *  - `never been (there|here)` / `nunca he venido` — a PLACE, not the practice,
 *    and the practice has **105 locations** (`si_locations`). "I've never been
 *    here, but I'm already a patient downtown" and "…I go to your Covina
 *    office" are both existing patients. This file already carries the West
 *    Covina/Covina lesson about treating one office as the practice.
 *  - `i'm new` / `soy nuevo` as a CUE — "I'm new to progressives", "I'm new to
 *    this insurance". The construction says nothing about patient status.
 *  - `NEW_TAKES_AN_OBJECT` and its Spanish mirror — two hand-maintained noun
 *    lists, subsumed by the sentence test below. "I need new glasses" is not
 *    the answer sentence, so no list has to enumerate `glasses`.
 *
 * ── ROUND 4 TOOK IT FURTHER: `new` NOW COMES FROM ONE ROUTE ────────────────
 *
 * Round 3 left three routes to `new` and round 4 found a P1 in TWO of them —
 * the twelfth P1 in this one reader across four rounds, and both the same shape
 * again:
 *
 *  - the DENIAL family admitted a LOCATION QUALIFIER after the cue. "I've never
 *    been seen at this office" and "I am not a patient at this location" both
 *    read `new`. Round 3 deleted the place-based cues by NAME and left the
 *    qualifier that can follow the ones it kept — my own criterion, applied to
 *    half the problem.
 *  - the explicit NEW PATIENT claim is a CONTAINS test, so a negation in a
 *    surrounding clause never reached it: "I don't think I'm a new patient",
 *    "I'm not sure if I'm a new patient".
 *
 * **THE ROUTE THAT HAS NEVER PRODUCED A P1 IN FOUR ROUNDS IS THE SENTENCE
 * TEST**, so it is now the only one. `new` is returned when, and only when, a
 * SENTENCE IN THE CALLER'S TURN *IS* THE ANSWER — "New.", "Uh, new.", "I'm a
 * new patient.", "Nuevo." — inside a window the patient question itself opened.
 *
 * That is a DELETION, not another guard, and it closes both findings by
 * construction: there is no prose left for a qualifier or a subordinate clause
 * to defeat. It is also the shape RULE ZERO 2c asks for — we shape the question
 * so the answer arrives in the form the field needs, and then we read that form
 * and nothing else.
 *
 * WHAT IT COSTS, and this is the whole of it: "I've never been a patient." and
 * "I'm not an existing patient." are no longer read as new-patient answers, and
 * a caller can no longer CORRECT themselves TO `new` in a bare re-ask window
 * (correcting to `existing` still works). Every one of those goes UNCLASSIFIED:
 * nothing is suppressed, the lookup runs, `LOOKUP_MISS_LIMIT` (v50) bounds the
 * asks, the ticket files. The asymmetry is the whole argument — a false
 * `existing` costs one tool call, a false `new` costs the record of somebody who
 * has one.
 *
 * THE COST IS COVERAGE, STATED RATHER THAN BURIED. A caller who answers "First
 * time calling." or "I've never been there." is now UNCLASSIFIED: the lookup
 * runs, misses, and `LOOKUP_MISS_LIMIT` (v50) bounds the asks before the ticket
 * files. Nothing is refused and no record is lost — it is the fail-safe
 * direction, and it is the same call `dobParts.ts` makes about Turkish. Whether
 * to buy that coverage back with more surface is the operator's dial, not a
 * test's.
 */

/**
 * ONE NEGATOR SHAPE, SHARED, because two copies of a negator is how the noun
 * lists in `explicitAsk.ts` drifted apart and cost the operator his own
 * transfer on `CAa2a3a1c1`.
 *
 * THE HEDGES ARE CODEX ROUND 3's P1-B. `not\s+(an?\s+)?new` permitted only an
 * article between the negator and the word, so **"I'm not really a new
 * patient"** and **"I'm not exactly a new patient"** both missed the negation
 * AND missed the identical narrowing in `ungoverned`, leaving `new patient`
 * standing for the explicit layer to read as `new` — an existing caller whose
 * record we then refuse to look for. Hedged negation is ordinary speech, not an
 * outlier.
 */
const NEG = String.raw`(?:not|never|no|isn'?t|aren'?t|wasn'?t|ain'?t|dont|don'?t)`;
const HEDGE = String.raw`(?:really|exactly|actually|quite|technically|truly|entirely|completely|necessarily|totally|fully|even|just|only)\s+`;
const ART = String.raw`(?:an?\s+)?`;
const NEG_RUN = `\\b${NEG}\\s+(?:${HEDGE})*${ART}(?:${HEDGE})*`;

/** The negator governs this word, in English. */
function negatedBefore(word: string): RegExp {
  return new RegExp(`${NEG_RUN}(?:${word})\\b`);
}

/**
 * SAID THEY ARE NOT A *NEW* PATIENT — which means they are EXISTING, and this
 * is read before everything else.
 *
 * Every entry contains the word "new", so any reader that reaches for "new"
 * earlier gets these backwards. Round 1 caught the English half; round 2 caught
 * the Spanish, where `no soy paciente` had been written as a bare prefix in the
 * denial list and so answered "new" to *"No soy paciente nuevo; soy paciente
 * existente"* — an existing caller, suppressed. Round 3 caught the hedges.
 */
const NEGATED_NEW: readonly RegExp[] = [
  negatedBefore('new'),
  /\bno\s+(soy|es|era|fui)\s+(realmente\s+|exactamente\s+|del\s+todo\s+)?(un[oa]?\s+)?(paciente\s+)?nuev[oa]\b/,
];

/**
 * A DENIAL IS NOT A CLAIM, so its own words are removed before the existing
 * prose below is read.
 *
 * This is round 1's P1-A: `(been|was)\s+(a\s+)?patient` matches inside "I've
 * never been a patient", so that turn read as EXISTING and the lookup produced
 * the very "no record found" this gate exists to suppress. Strip what the
 * denial governs, then ask what is left — the same device as `ungoverned`,
 * pointed at the other direction.
 *
 * IT OUTLIVED THE FAMILY THAT USED TO ANSWER `new` WITH IT, and deliberately.
 * Round 4 stopped a denial answering `new`; it must still stop one answering
 * `existing`, because that is a claim the caller did not make. A stripped turn
 * with nothing left simply goes unclassified, which is the fail-safe direction.
 */
const DENIAL_PHRASES: readonly RegExp[] = [
  /\bnever\s+(been|was)\s+(an?\s+)?patient\b/g,
  /\bnever\s+been\s+seen\b/g,
  /\b(haven't|have\s+not|hadn't|had\s+not|hasn't|has\s+not)\s+been\s+(an?\s+)?patient\b/g,
  /\bnot\s+a\s+patient\b/g,
  /\bnunca\s+he\s+sido\s+paciente\b/g,
  /\bno\s+soy\s+paciente\b/g,
];

function withoutDenials(said: string): string {
  let out = said;
  for (const re of DENIAL_PHRASES) out = out.replace(re, ' ');
  return out;
}

/**
 * Said they have been here before. PROSE, and it may only answer EXISTING.
 *
 * This family is kept where the `new` families were deleted, and the asymmetry
 * is the point rather than an oversight: a wrong `existing` costs ONE tool call
 * — the lookup runs, misses, and RULE ZERO 2a says a miss on a new patient is
 * EXPECTED and not a failure to report or gate on. A wrong `new` costs the
 * record of a caller who has one, on lanes where 63% of found-nobody callers
 * are in `patients_master`. The two directions are not symmetric, so they do
 * not get symmetric surface.
 *
 * It also sits IN FRONT of the denial list, which is what makes Codex round
 * 3's *"I've never been here, but I'm already a patient downtown"* read
 * `existing` — the right answer, not merely the safe one.
 *
 * The bare words `existing` / `existente` are deliberately NOT here: they are
 * `EXPLICIT_EXISTING`, which is read through `ungoverned` one layer up.
 */
const EXISTING_CUES: readonly RegExp[] = [
  /\bi'?m\s+(an?\s+)?(current|established|returning|old)\b/,
  /\bi'?ve\s+been\s+(there|here|seen|coming|going)\b/,
  // `i\s+'m` cannot match "i'm" — there is no space inside the contraction, so
  // this cue only ever fired on "i am already" until Codex round 3's second
  // case walked into it. Written the way every sibling above is written.
  /\b(i'?m|i\s+am)\s+already\s+(an?\s+)?patient\b/,
  /\b(been|was)\s+(a\s+)?patient\b/,
  /\bi\s+(have|had)\s+an?\s+(appointment|surgery|exam)\b/,
  /\bi\s+(see|saw)\s+(dr|doctor)\b/,
  /\blast\s+(year|month|week|time)\s+i\b/,
  // Spanish.
  /\bya\s+soy\s+paciente\b/,
  /\bya\s+(he|habia)\s+(venido|estado|ido)\b/,
  /\bsoy\s+paciente\s+(de|del|aqui)\b/,
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
    // English: the negator, any hedges, then the word. Shares NEG_RUN with
    // NEGATED_NEW so the two cannot drift — round 3 found them drifted.
    .replace(new RegExp(`${NEG_RUN}(new|existing)\\b`, 'g'), ' ')
    /**
     * SPANISH PUTS THE VERB IN BETWEEN — "no SOY PACIENTE existente" — so the
     * English shape cannot reach the word it governs. This was caught by the
     * round-2 test failing on its own Spanish case, not by review: the English
     * assertion passed and the Spanish one returned "existing" for a caller
     * who had just denied being an existing patient.
     */
    .replace(
      /\bno\s+(soy|es|era|fui|somos|son)\s+(realmente\s+|exactamente\s+|del\s+todo\s+)?(un[oa]?\s+)?(paciente\s+)?(nuev[oa]s?|existente)\b/g,
      ' ',
    )
    .replace(/\b(no|nunca)\s+(un[oa]?\s+)?(nuev[oa]s?|existente)\b/g, ' ');
  return word.test(stripped);
}

/**
 * Read through `ungoverned`, and the ONLY explicit claim left in the reader.
 *
 * There is no `EXPLICIT_NEW` any more: a CONTAINS test for "new patient" is
 * what round 4's second P1 defeated with "I don't think I'm a new patient", and
 * the sentence test covers every case it was there for. `existing` keeps its
 * contains read because the failure direction is one wasted lookup.
 */
const EXPLICIT_EXISTING = /\b(existing|existente)\b/;

/**
 * THE ANSWER IS A SENTENCE, NOT A SUBSTRING — and this replaces both noun
 * lists.
 *
 * The old bare-word layer asked "does the turn contain `new` and none of these
 * 20 nouns?", which is a list that can always be one noun short and was the
 * door round 3's P1-C came through. A funnel question (RULE ZERO 2c) is
 * answered with the answer, so the test is whether a SENTENCE IN THE TURN *is*
 * the answer. `fold` keeps `.?!` precisely so sentences exist to split on.
 *
 * It keeps the coverage that matters — "New.", "Uh, new.", "I'm a new
 * patient.", "New. I've never been there before." all read — and refuses the
 * whole family of things a noun list had to enumerate: "I need new glasses",
 * "I'm new to progressives", "Necesito un número nuevo".
 */
function sentences(turn: string): string[] {
  return turn
    .split(/[.?!]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LEAD_EN = String.raw`(?:(?:uh|um|er|ah|oh|well|so|yeah|yes|yep|yup|okay|ok|sure)\s+)*`;
const SUBJ_EN = String.raw`(?:(?:i'?m|i\s+am|it'?s|that'?s|we'?re|this\s+is)\s+)?`;
const LEAD_ES = String.raw`(?:(?:eh|este|pues|bueno|si|sip)\s+)*`;

const ANSWER_IS_NEW: readonly RegExp[] = [
  new RegExp(`^${LEAD_EN}${SUBJ_EN}(?:an?\\s+)?new(?:\\s+patients?)?$`),
  new RegExp(`^${LEAD_ES}(?:(?:soy|es)\\s+)?(?:un[oa]?\\s+)?(?:paciente\\s+)?nuev[oa]$`),
];

function answerSentenceIsNew(turns: readonly string[]): boolean {
  return turns.some((turn) =>
    sentences(turn).some((s) => ANSWER_IS_NEW.some((re) => re.test(s))),
  );
}

/**
 * Read one window's caller turns.
 *
 * THE INVARIANT, and round 4 is why it is this narrow: **`new` is returned by
 * ONE route — a SENTENCE THAT IS THE ANSWER, in a QUALIFIED window. Nothing
 * else in this reader can produce it.** Prose may only infer `existing`, whose
 * failure costs one tool call.
 *
 * Twelve P1s across four rounds were all the same shape — a broad read of prose
 * answering `new`, with a negation, a qualifier or a subordinate clause in front
 * of it making that answer false. Each round removed a route rather than adding
 * a guard; this is the last one standing, and it is the only one that never
 * produced a finding.
 *
 * ORDER IS STILL LOAD-BEARING IN THE THREE `existing` LAYERS:
 *
 *  1. **A NEGATED NEW CLAIM FIRST** (round 1 English, round 2 Spanish, round 3
 *     hedges). Every one of those contains the word "new".
 *  2. **AN EXPLICIT EXISTING CLAIM, ungoverned** (round 2). *"Existing, but I've
 *     never been to this office"* is existing; *"I'm not an existing patient"*
 *     is not — and is now UNCLASSIFIED rather than `new`.
 *  3. **EXISTING PROSE, with the denials stripped out of it** (round 1 needs the
 *     stripping, round 3 needs this layer here). *"I've never been here, but I'm
 *     already a patient downtown"* is existing.
 *  4. **A SENTENCE THAT IS THE ANSWER** -> new, and only in a QUALIFIED window:
 *     a bare "New." is what an unrelated alternation draws, so a re-ask window
 *     refuses one (round 2's guard 2). With this the only `new` route, that
 *     guard now means a caller cannot correct themselves TO `new` — which is the
 *     cheap direction to lose, and correcting to `existing` still works.
 */
function readWindow(turns: readonly string[], kind: WindowKind): PatientStatus | undefined {
  const said = turns.join(' ');
  if (!said) return undefined;
  if (NEGATED_NEW.some((re) => re.test(said))) return 'existing';
  if (ungoverned(said, EXPLICIT_EXISTING)) return 'existing';
  const claim = withoutDenials(said);
  if (EXISTING_CUES.some((re) => re.test(claim))) return 'existing';
  if (kind !== 'qualified') return undefined;
  if (answerSentenceIsNew(turns)) return 'new';
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
 * RE-ASK ELIGIBILITY EXPIRES WITH THE EXCHANGE — Codex round 3's P1-C. A bare
 * pair is a re-ask only while the status conversation is still the most recent
 * thing that happened; once the caller has said something OUTSIDE any window,
 * that conversation is over and a later "Are the glasses new or existing?" is
 * not a re-ask of anything. Without this the eligibility lasted the whole call
 * and any clause-final pair minutes later became a status window. No timer and
 * no magic number: the caller moving on is the signal.
 */
export function readPatientStatus(lines: readonly string[]): PatientStatus | undefined {
  let answer: PatientStatus | undefined;
  let kind: WindowKind | null = null;
  let reaskEligible = false;
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
      kind = opensStatusWindow(agent, reaskEligible);
      if (kind === 'qualified') reaskEligible = true;
      continue;
    }
    const caller = callerLine(line);
    if (caller === null) continue;
    if (kind) turns.push(caller);
    // The caller has moved on, so the status exchange is over.
    else reaskEligible = false;
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
 * final ones.
 *
 * A RECOMPUTATION THAT FINDS NO ANSWER DELETES THE STORED ONE — Codex round 4's
 * third P1, and this function's own docstring used to claim the opposite while
 * the code did the opposite of that: it said "this store never holds a verdict
 * the transcript has stopped supporting" and then returned early, keeping one.
 *
 * `CallTranscriptLog.callerCompleted` REPLACES a caller line in place when Grok
 * re-emits the same item (`this.lines[open.index] = ...`), so "New." can become
 * "I need new glasses." — the read correctly goes to undefined and the store
 * used to keep `new`, suppressing an existing caller's lookup on words no longer
 * in the transcript.
 *
 * DELETING IS SAFE BECAUSE THE LOG NEVER DROPS A LINE — checked, not assumed:
 * `transcriptLog.ts` only ever pushes or replaces in place, with no cap and no
 * eviction, so the whole record is re-read on every post and an answer given in
 * an earlier window is still found. The only way a later read comes back empty
 * is that the transcript stopped saying it, which is exactly when the verdict
 * should go. The model's OVERRIDE is in its own map and is untouched by this.
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
  const now = Date.now();
  sweep(now);
  heard.delete(callSid);
  if (!read) return;
  heard.set(callSid, { status: read, at: now }); // re-inserted, so order tracks recency
}

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
