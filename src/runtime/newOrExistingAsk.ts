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
const LANES_THAT_ASK = new Set(['optical', 'surgery', 'tech', 'records']);

export const NEW_OR_EXISTING_ASK =
  ' Before you try to identify anybody — before lookup_patient, before asking ' +
  'for a name or a date of birth — ask once: "Are you a new patient or an ' +
  'existing patient?" NEW means STOP LOOKING: no lookup, no appointment ' +
  'search, and never tell them we have no record of them — there is none to ' +
  'find and that is expected, not a failure. EXISTING means find them, and ' +
  'keep going until you do. Pass their answer to lookup_patient as ' +
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
