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
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not GATE anything. A caller who
 * says "new" is not prevented in code from being looked up. Wayne's rule says
 * the answer tells us we do not need to look; whether a spoken "new" should
 * hard-suppress `lookup_patient` is a behaviour change with a real failure
 * mode — an existing patient who answers "new" would lose their record — and
 * he has not been asked. Prompt guidance now; the gate is his call.
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
  'keep going until you do.';

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
