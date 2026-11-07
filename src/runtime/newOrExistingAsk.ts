/**
 * ASK NEW-OR-EXISTING BEFORE LOOKING ANYBODY UP — RULE ZERO 2a.
 *
 * Wayne, 2026-09-12, and this is his wording, not a paraphrase:
 *
 *   "Are you a new patient or an existing patient? I'm a new patient — now I
 *    know I don't need to look for you anymore. Now I know you're not gonna be
 *    there. I'm not gonna need to find appointments. I'm an existing patient —
 *    now I know I need to find you."
 *
 * The answer closes a branch. NEW means a lookup miss is EXPECTED and is not a
 * failure to report, retry or gate on. EXISTING means a miss is a real problem
 * and worth pushing through.
 *
 * WHAT WAS ACTUALLY MISSING. `rampEngine.ts:60` (`classify`) still has this,
 * and `rampEngine` is imported by exactly one file — `voiceAgentRoutes.ts`,
 * the OLD CORE. So the runtime lanes, which take the volume, never ask it.
 * Zero hits across `opticalAgent`, `surgeryAgent`, `techAgent` and
 * `recordsAgent`. Wayne asked whether we still had it; on the lanes that
 * matter, we did not.
 *
 * WHY IT LIVES HERE AND NOT IN THE FOUR PROMPTS — the same two reasons as
 * `greetingAlreadyPlayed.ts`, and the second is again the load-bearing one.
 *
 * 1. Its SUPPRESSION CONDITION is a runtime fact. Rule 2a: "Do NOT ask it when
 *    Rule 1 already answered it. A caller recognised from their phone number
 *    is an existing patient by definition — asking anyway tells them we do not
 *    know who they are while we are looking at their chart." Whether
 *    pre-context vouched for somebody is known HERE, at the session seam, and
 *    `precontextMatched` already computes it. A prompt cannot condition on it
 *    except through a branch the prompt builder also has to be handed.
 * 2. Prompt budget. Four copies is four times the tokens and four places to
 *    forget it.
 *
 * AND THE DIRECTION OF THE BRANCH IS THE WHOLE POINT. `greetingAlreadyPlayed`
 * exists because "your greeting has already played" was written INSIDE the
 * recognition block — true guidance behind a branch that fires on almost
 * nothing (pre-context matched 0 of 143 substantive queue calls on
 * 2026-09-03). This line is the mirror image: it is appended when recognition
 * did NOT happen, which today is essentially every call. Putting it inside the
 * recognition block would repeat that mistake exactly, and putting it
 * unconditionally would break Rule 2a's own carve-out.
 *
 * IT NOW GATES, AND THAT IS THE OPERATOR'S ANSWER TO THE QUESTION THIS FILE
 * USED TO LEAVE OPEN. The paragraph here said "it does not GATE anything ... the
 * gate is his call". Asked, 2026-09-19: **"new should hard suppress lookup
 * patient."** So `lookup_patient` refuses to dispatch for a caller who said
 * they are new — `spokenPatientStatus.ts` reads the answer out of the record
 * and `sharedPatientTools.ts` is where it bites.
 *
 * THE FAILURE MODE IS STILL REAL AND IS NOW GUARDED RATHER THAN MERELY NOTED:
 * an existing patient who answers "new" would lose their record, on lanes where
 * 63% of found-nobody callers turn out to be in `patients_master`. Two things
 * hold it. Rule 1 OUTRANKS the answer — a caller whose identity the process has
 * already established is never suppressed, and in the ordinary sequence the
 * model has already looked up the injected caller phone before this question is
 * asked. And the suppression is reversible: `lookup_patient` takes
 * `patient_status: 'existing'`, its own refusal tells the model to send it, and
 * the reader takes the LATEST answer so an agent who asks again gets the
 * corrected one. There is no latch to get stuck in.
 */

/**
 * The four patient queue lanes, and ONLY those.
 *
 * PCP is excluded on purpose and it is not an oversight: its callers are
 * entities — doctors' offices, medical groups, surgery centres, insurers —
 * and `CAbf717457` is already on record as a Loma Linda Surgery Center caller
 * mishandled by being put down the patient branch. Asking a surgery centre
 * whether they are a new or existing PATIENT is that same error, spoken out
 * loud. no-ivr and answering-service are excluded for the same reason: they
 * are not single-purpose patient queues.
 */
/**
 * RECORDS IS DELIBERATELY NOT HERE — Codex round 5's second P1, and it is
 * MEASURED rather than argued.
 *
 * The question asks about the CALLER ("are YOU a new patient or an existing
 * patient?"), and on this lane the caller is routinely not the patient:
 * `recordsAgent.ts` handles attorneys, health plans, doctors' offices and
 * relatives, and warns in as many words that the caller may not be the patient.
 * So a proxy answering "New." describes THEMSELVES while the gate reads it as
 * the patient whose chart they are asking for — and suppresses that patient's
 * lookup. A category error, wrong even once.
 *
 * MEASURED over records, 2026-09-10..18, 206 substantive calls: **87 (42%)
 * carry a proxy cue** (attorney, law office, health plan, "on behalf of", "for
 * my mother/father", conservator, guardian, "calling from <organisation>")
 * against 20 carrying a self cue. That is not an outlier, it is close to the
 * modal caller, so the ask is removed from this lane rather than guarded.
 *
 * WHAT IT COSTS: records loses RULE ZERO 2a entirely — no ask, no suppression,
 * the lane behaves exactly as it does today. Asking about the TARGET PATIENT
 * after establishing who is requesting is the other half of Codex's remedy and
 * is a new question on a live intake, which is the operator's call rather than
 * a review's.
 */
/**
 * The lanes that ask the question — and therefore the ONLY lanes whose
 * transcript may be read for its answer.
 *
 * EXPORTED FOR `sharedPatientTools.ts`, Codex round 7's second P1: the reader
 * was lane-blind, so a window opened by a records agent improvising the question
 * let a PROXY's "New." — describing themselves — suppress the lookup for the
 * PATIENT whose chart they rang about. Round 5 took the ask off that lane and
 * round 6 took `new` off the override; the READER still read every lane. One
 * table, imported by both, because two copies of a lane list is the
 * `explicitAsk.ts` drift that cost the operator his own transfer.
 */
export const LANES_THAT_ASK: ReadonlySet<string> = new Set(['optical', 'surgery', 'tech']);

/**
 * A CALLER FROM A BUSINESS IS NOT ASKED — operator, 2026-11-07: "go ahead and
 * skip new-or-existing for business callers."
 *
 * The question asks whether the CALLER is a patient. On the queue lanes a
 * pharmacy, a health plan, a doctor's office or a clinic calls about a
 * patient, and the question is about the wrong person: it is the records
 * finding of Codex round 5 on a lane that keeps the question. MEASURED,
 * optical + surgery + tech, 2026-10-24..11-06, substantive calls on which the
 * agent asked it: **652 calls, 90 of them a business caller** (tech 83, almost
 * all pharmacies; surgery 5; optical 2). **73 of the 90 answered the question
 * by naming their business** ("Pharmacy."), which the reader correctly reads
 * as no answer, and **13 were asked it twice or three times**. 62 of the 90
 * carried a ticket on the call row (69%) against 458 of the other 562 (81%),
 * and **28 left no ticket of any provenance** (checked by SID in the Support
 * Center). `businessCallersAreNotAskedNewOrExisting.test.ts` is indexed by
 * those 28 and the 5 more that were asked twice and filed.
 *
 * THE EXCEPTION IS STATED BEFORE THE QUESTION, deliberately (the v29 lesson):
 * a model reading in order meets "ask once" before it meets the carve-out
 * otherwise. And the second clause — an answer naming a business makes them a
 * business caller — is for the caller who never said where they were calling
 * from until they were asked; it is what stops the second and third asks.
 *
 * WHAT IT DOES NOT COVER: a relative or a caregiver calling for a patient is
 * not a business and is still asked. The operator accepted that residue on
 * 2026-09-21 ("forget about that 1.2%"). The reader is unchanged: it never
 * read a business name as new or existing, so nothing a business caller says
 * can suppress a lookup.
 */
export const NEW_OR_EXISTING_ASK =
  " A caller from a business — a pharmacy, a health plan or insurer, a doctor's " +
  "or provider's office, a clinic, a hospital, a lab or a medical group — is " +
  'not the patient: never ask them whether they are new or existing; go ' +
  'straight to the patient they are calling about. Everyone else: before you ' +
  'try to identify anybody — before lookup_patient, before asking for a name ' +
  'or a date of birth — ask once: "Are you a new patient or an existing ' +
  'patient?" If they answer with a business ("Pharmacy."), they are a ' +
  'business caller: do not ask again. NEW means STOP LOOKING: no lookup, no ' +
  'appointment search, and never tell them we have no record of them — there ' +
  'is none to find and that is expected, not a failure. EXISTING means find ' +
  'them, and keep going until you do. Pass their answer to lookup_patient as ' +
  'patient_status.';

/**
 * Append the ask, unless this caller has already been recognised or this lane
 * does not take patient calls.
 *
 * `callerRecognised` is `precontextMatched(precontext)` — the classification
 * helper, deliberately NOT `recognisedFirstName`. `AzulPrecontext` permits
 * `{ matched: true }` with no usable name, and that caller is still an
 * existing patient whom Rule 1 has answered for; suppressing on the NAME
 * would ask a recognised person to classify themselves because we happened to
 * have nothing to call them.
 */
export function withNewOrExistingAsk(
  instructions: string,
  slug: string,
  callerRecognised: boolean,
): string {
  if (!LANES_THAT_ASK.has(slug)) return instructions;
  if (callerRecognised) return instructions;
  // Idempotent, and it also stands down for a lane whose own prompt grows this
  // question later — the same guard `withGreetingAlreadyPlayed` carries.
  if (instructions.includes('new patient or an existing patient')) return instructions;
  return instructions + NEW_OR_EXISTING_ASK;
}
