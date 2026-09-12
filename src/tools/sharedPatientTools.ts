/**
 * The tools every queue needs: who is calling, which office, have they asked
 * already.
 *
 * WHY THEY MOVED HERE
 *
 * These three were written for Optical and lived in `opticalTools.ts`. Surgery
 * needs the same three, and the choice was to copy them or to share them. The
 * library exists because copies drift — that is how this practice ended up with
 * provider names in four shapes — so they are shared.
 *
 * But they were not queue-neutral. Both of the first two encoded "a surgery
 * centre is the wrong kind of place", which is correct for an optician and
 * exactly backwards for a surgery coordinator:
 *
 *   lookup_patient    skipped surgery centres when picking the usual office,
 *                     and said "ask which office they use for glasses"
 *   resolve_location  reported `is_optical_office: false` for a surgery centre
 *                     and told the agent to ask for a clinic instead
 *
 * So they now take a `queue`. It is NOT a schema field and the model never sees
 * it: `realtimeToolsFor` merges call context underneath the model's arguments,
 * and `validateInput` only checks declared required fields, so an undeclared
 * key passes through to the handler untouched. The agent cannot set it, cannot
 * blank it, and cannot be asked for it.
 *
 * With no queue at all the behaviour is neutral — every real facility is
 * acceptable and the wording names no speciality. That is the right default for
 * the HTTP surface, where the caller is not a queue.
 */
import { registerTool, missing, type MissingFields, type ToolResult } from './registry';
import { gateRefusalsSoFar, noteGateRefusal, noteCallFact, callFactNoted } from './gateAttempts';

/** Which queue is asking. Injected as call context, never a model argument. */
export type ToolQueue = 'optical' | 'surgery';

/** What kind of place this queue can actually action a request at. */
function acceptsFacility(queue: ToolQueue | undefined, kind: string | null | undefined): boolean {
  // Unknown facility kinds are accepted everywhere. The Console mirror is
  // incomplete, and a location we have not classified is far more likely to be
  // a real office than a wrong one — `file_*_ticket` resolves it against the
  // ticketing app before anything is filed, which is the gate that matters.
  if (kind == null) return true;
  if (queue === 'optical') return kind === 'clinic';
  // Surgery coordinates AT surgery centres, and its patients are seen in
  // clinics for consults, measurements and post-op. Both are correct.
  if (queue === 'surgery') return kind === 'clinic' || kind === 'surgery_center';
  return true;
}

function facilityWord(queue: ToolQueue | undefined): string {
  return queue === 'optical' ? 'optical office' : queue === 'surgery' ? 'office' : 'office';
}

function askWhichOffice(queue: ToolQueue | undefined): string {
  return queue === 'optical'
    ? 'Ask which office they use for glasses or contacts.'
    : queue === 'surgery'
      ? 'Ask which office or surgery centre they are being seen at.'
      : 'Ask which of our offices they visit.';
}

// ---------------------------------------------------------------- who

/**
 * `lookup_patient`'s whole budget, and the ONE place it is written.
 *
 * `runTool` races the handler against this and the race RESOLVES rather than
 * cancelling, so anything inside that wants to answer first has to know the
 * ABSOLUTE moment the race fires — not its own relative timeout. Declared here
 * so the deadline handed to the service cannot drift from the budget the
 * registry enforces; `lookupBudgetDrift.test.ts` fails if the two separate.
 */
export const LOOKUP_PATIENT_BUDGET_MS = 6000;

/**
 * Answer this far before the race does. Enough to build the result object and
 * return it, and nothing more.
 */
const LOOKUP_BUDGET_MARGIN_MS = 250;

registerTool({
  name: 'lookup_patient',
  layer: 'agent',
  timeoutMs: LOOKUP_PATIENT_BUDGET_MS,
  description:
    'Find a patient and their recent visit history. Call this as soon as you have ' +
    'either their phone number, or their first name, last name and date of birth. ' +
    'It returns the offices and providers they have actually been seen at, which is ' +
    'how you confirm which office they mean.',
  input_schema: {
    type: 'object',
    properties: {
      /**
       * LEAD THE ASK. Operator ruling, 2026-09-03:
       *
       *   *"We should be proactively structuring the conversation. On any
       *   validation we should lead... May I please have your last name? May I
       *   please have your date of birth? And when you ask for date of birth
       *   it should say starting with the month, the day, and then the year.
       *   This way you get it in the way you want it. It's kind of a guard.
       *   If you just say can I have your date of birth, people give it to you
       *   in any format they want."*
       *
       * These strings are the words the agent actually says: `validateInput`
       * builds its refusal from `askAs`, and the model reads them in the
       * schema. Changing them here changes all four queue lanes at once, which
       * is why the wording lives with the field and not in four prompts.
       *
       * The date-of-birth guard is worth its characters twice over. Every
       * parser fix on 2026-09-03 — separators, sentences, two-digit centuries
       * — was widening what we accept AFTER the fact. Naming the order in the
       * question narrows what arrives, which is the cheaper half and the one
       * that was there before and got lost.
       */
      phone: { type: 'string', description: 'Any format. The number they are calling from is usually best.', askAs: 'What is the best phone number for you?' },
      first_name: { type: 'string', description: "Patient's first name as they said it.", askAs: 'And may I please have your first name?' },
      last_name: { type: 'string', description: "Patient's last name as they said it.", askAs: 'May I please have your last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format — "March 17th 1973", "03/17/1973".', askAs: 'And may I please have your date of birth, starting with the month, then the day, then the year?' },
    },
  },
  handler: async (input): Promise<ToolResult> => {
    /**
     * WHEN THE RACE FIRES, in absolute terms. Codex P1 (round 2) on PR #292:
     * a RELATIVE deadline inside the join is worthless if the rungs above it
     * have already spent the budget, because `runTool`'s race is absolute from
     * the moment the handler was entered. Captured here, at that moment, and
     * threaded down so the join can bound itself by what is actually LEFT.
     */
    const deadlineAt = Date.now() + LOOKUP_PATIENT_BUDGET_MS - LOOKUP_BUDGET_MARGIN_MS;
    const queue = input.queue as ToolQueue | undefined;
    // The number the call ARRIVED on, when the model did not pass one.
    //
    // `caller_phone` is injected as call context on every tool. This tool's
    // schema field is `phone`, so until now the caller's own number reached the
    // lookup only if the model chose to type it out — even though the process
    // had already matched that number to a patient before the caller spoke.
    //
    // Live on 2026-08-13: the transcriber heard "Thanks." and "No. March 17th,
    // 1973." for a date of birth, the model looked up that mangled trio, and
    // the tool answered "no record found" for a patient it had recognised
    // seconds earlier. The ticket filed with no provider and no location.
    //
    // Same lesson as VA-50813 filing with a null call_sid: never make a value
    // the process already holds depend on the model remembering to pass it.
    const phone = str(input.phone) || str(input.caller_phone);
    const first = str(input.first_name);
    const last = str(input.last_name);
    const dob = str(input.date_of_birth);

    // Either a phone, or the full name+DOB trio. Half a trio is not a lookup.
    if (!phone && !(first && last && dob)) {
      return missing(
        phone ? [] : ['first_name', 'last_name', 'date_of_birth'].filter((f) =>
          f === 'first_name' ? !first : f === 'last_name' ? !last : !dob,
        ),
        "I need either a phone number, or their full name and date of birth, to look them up.",
      );
    }

    const { scheduleLookupService } = await import('../services/scheduleLookupService');
    const ctx = await scheduleLookupService.lookupPatient({
      phone: phone || undefined,
      firstName: first || undefined,
      lastName: last || undefined,
      dateOfBirth: dob || undefined,
      deadlineAt,
    });

    // A name+DOB miss is very often ONE mis-transcribed field, not a stranger.
    // The number they are calling from is the one piece nobody misheard, so try
    // it before telling an agent this person is unknown.
    //
    // Rebound rather than mutated: `ctx` is the service's own returned object,
    // and writing into it would change a value the caller still owns. The first
    // version did `Object.assign(ctx, byPhone)` and a test caught it corrupting
    // a shared fixture — which is the same hazard in miniature.
    let resolved = ctx;

    /**
     * AN EXPLICIT AMBIGUITY IS TERMINAL. THE PHONE RETRY MAY NOT OVERWRITE IT.
     *
     * Codex P1 on PR #292. A name+DOB that resolves to SEVERAL people is not a
     * miss — it is a specific, stronger claim that came back unsettled. The
     * retry below then looked the CALLER'S NUMBER up on its own, and a unique
     * hit there replaced the ambiguous result wholesale. Nothing checks that
     * the phone's owner is one of the people the name matched, so the tool
     * could answer `found: true, identity_is_certain: true` with an unrelated
     * person's PersonID-joined record — a daughter's chart read back to a
     * caller who spoke her mother's name and birthday. Standing instruction 6
     * forbids exactly that, and the join makes it worse by attaching a full
     * history, office and provider to the wrong person.
     *
     * SMALL, AND FIXED ANYWAY. Measured 2026-09-12 on 400 sampled persons:
     * last name + date of birth collides for 8 (2.0%), and the full
     * first+last+DOB triple for 0 (<0.75% at 95%). The scenario needs that
     * collision AND a unique phone hit on someone else AND the schedule's own
     * phone rung to miss first — far below the 1% bar where a finding is worth
     * chasing. It is fixed because reading the wrong patient's record aloud is
     * a different class of harm from a lost request, and because the fix is
     * one condition in the direction instruction 6 already mandates.
     */
    const explicitlyAmbiguous = Boolean(ctx.identity && !ctx.identity.unique);

    if (!ctx.patientFound && !explicitlyAmbiguous && phone && (first || last || dob)) {
      const byPhone = await scheduleLookupService.lookupPatient({ phone, deadlineAt });
      if (byPhone.patientFound) {
        console.info('[TOOLS] lookup_patient: name+DOB missed, matched on the caller phone instead');
        resolved = byPhone;
      }
    }

    if (!resolved.patientFound) {
      /**
       * "SEVERAL PEOPLE" IS NOT "NOBODY", and the agent needs the difference.
       *
       * Codex P2 on PR #292. The person-base rung reports an ambiguous hit by
       * returning `identity` on an otherwise empty context — several people
       * share this number, and instruction 6 forbids picking one. This branch
       * read only `patientFound` and told the agent "no record found", which
       * is false and points it the wrong way: it would treat a known family as
       * a new patient instead of asking the one question that separates them.
       *
       * The finding also caught that the service-level test could not see
       * this, because the tool's own not-found branch is where the signal died.
       */
      const several = resolved.identity && !resolved.identity.unique;
      if (several) {
        return {
          success: true,
          found: false,
          identity_is_certain: false,
          candidate_count: resolved.identity!.candidateCount,
          message:
            `This number is on file for ${resolved.identity!.candidateCount} different people, so ` +
            'I cannot tell which one is calling. Ask for their full name and date of birth — do ' +
            'not read any history back until they have given both.',
        };
      }
      return {
        success: true,
        found: false,
        message:
          'No record found. They may be new, or calling from a different number. ' +
          'Ask for their name and date of birth if you have not already.',
      };
    }

    const seen = [
      ...new Set(
        (resolved.pastAppointments ?? []).map((a) => a.location).filter((l) => l && l !== 'Unknown'),
      ),
    ].slice(0, 6) as string[];

    // The most recent visit is NOT necessarily a place THIS queue can use.
    //
    // Found by predicting this tool's answer for a real patient before testing
    // it: their last Active visit was Dwayne Logan at Loma Linda SURGERY
    // CENTER. An optical agent taking `lastLocationSeen` at face value would
    // file a glasses ticket against a building with no optician in it, and
    // Optical assigns by location — so it would never reach anyone. For
    // Surgery that same visit is the single most useful fact on the call.
    //
    // So the office is resolved against what the QUEUE accepts, and the raw
    // most-recent stays available but is clearly labelled.
    const usualOffice = await mostRecentAcceptable(seen, queue, deadlineAt);

    // A phone number can carry more than one person, and a surname carries
    // whole families. The service reports which case this was, and the agent
    // needs it because it changes what may be SAID: an uncertain match is one
    // real person's record, but it is a guess among several, so the name must
    // be confirmed and the history must not be read back.
    const uniqueMatch = resolved.identity?.unique !== false;

    /**
     * A NAME-ONLY HIT IS NOT AN IDENTITY, AND THE TOOL SAYS SO NOW.
     *
     * `identity_is_certain` used to mean only "the match was unique". But
     * `lookupPatient` falls back from name+DOB to the PHONE NUMBER and then to
     * the NAME ALONE, and a lone Smith on file is unique — so a name-only hit
     * on a common surname came back `found: true, identity_is_certain: true`,
     * and it is somebody else's chart.
     *
     * Nothing stopped that except six lines of prompt telling the model to
     * distrust this very field:
     *
     *   "THEN CHECK matched_by BEFORE YOU BELIEVE IT ... If matched_by is not
     *    name_and_dob, treat it as NOT FOUND: say nothing about their
     *    appointments, read no history back"
     *
     * A safety rule that holds only while the model obeys an instruction is
     * not a safety rule. The check belongs here, where it cannot be talked
     * out of, and the prompt lines it replaces are deleted (task #25 — the
     * queue prompts carry workarounds written for a model that needed them).
     *
     * `phone` from the SCHEDULE stays certain: it is the one field nobody
     * mis-transcribed, and that rung only matches a number written on this
     * person's own appointment record.
     *
     * `phone` FROM THE PERSON BASE DOES NOT, and that distinction is new.
     * Codex P1 on PR #292. This PR made `matchedBy: 'phone'` mean two
     * different claims: the schedule rung above, and a caller-ID hit in a
     * 915,843-row person base. The second one establishes only who OWNS the
     * number — a family member on the household phone, a reassigned number
     * and a spoofed caller ID all look identical to it — and the PersonID
     * join now hands that answer a full visit history, office and provider.
     * The queue prompts ask for name and date of birth only when this flag is
     * false, so leaving it true is a PHI disclosure gated on nothing.
     *
     * It also contradicts Rule Zero, written the same day: MATCH, then
     * VALIDATE — "a phone number is a candidate to CONFIRM, never an
     * identity". The service says which kind it is via `identityUnconfirmed`.
     *
     * THE LESSON, since it is one CLAUDE.md already names: a change that
     * widens what a value MEANS invalidates the sentence that justified how
     * it was treated. I widened `matchedBy: 'phone'` and left the comment
     * above it standing.
     *
     * COST OF BEING WRONG THE OTHER WAY: an unconfirmed match no longer
     * auto-fills a date of birth through `rememberVerifiedIdentity`. That
     * removes nothing that existed before this PR — the mirror phone rung is
     * itself new, so these calls previously reached `emptyContext()` and
     * filled nothing. It declines to add an unsafe shortcut; it does not take
     * a working one away.
     */
    const certain =
      uniqueMatch &&
      resolved.matchedBy !== 'name' &&
      resolved.matchedBy !== 'dob' &&
      !resolved.identityUnconfirmed;

    /**
     * PASS THE RECORD ALONG — operator instruction, 2026-09-01.
     *
     * The service has already returned this patient's date of birth in
     * `patientData`, and nothing carried it the twenty lines to the filing
     * tool. So the agent asked for a date of birth the process was holding,
     * and when the caller could not give it the request was lost: 45 calls
     * refused for a date of birth in fourteen days, 23 of them for a patient
     * this tool had already identified.
     *
     * Only a CERTAIN match is remembered, and it is only ever read back for
     * the same name — see verifiedIdentity.ts. An uncertain match still has to
     * be confirmed out loud, which is the rule the identity_warning above
     * exists to enforce.
     */
    /**
     * DELIBERATELY `uniqueMatch`, NOT `certain` — do not "tidy" this to the
     * stricter flag above.
     *
     * This carry-forward is the operator's 2026-09-01 fix: it recovered 45
     * calls in a fortnight that were refused for a date of birth the process
     * was already holding, 23 of them for a patient this tool had identified.
     * Narrowing it to `certain` would drop every phone-matched caller back
     * into that gate and undo the fix.
     *
     * It stays safe on its own terms: `verifiedDobFor` only ever reads a
     * remembered date back for the SAME NAME, so a unique phone match carries
     * that person's date of birth and nobody else's.
     *
     * The remaining hazard is a unique NAME-ONLY match banking a date of birth
     * for a caller who is not on file. It is pre-existing, it is invisible in
     * the data today — `matched_by` was never recorded on the timeline, so
     * 2,819 lookups in fourteen days say nothing about how often this happens
     * — and BACKEND_HANDOFF forbids changing the ticket path on a number
     * nobody can measure. That is why `matched_by` joins the recorded outcome
     * below rather than being fixed blind here.
     */
    if (uniqueMatch) {
      const { rememberVerifiedIdentity } = await import('./verifiedIdentity');
      rememberVerifiedIdentity(str(input.call_sid), {
        firstName: resolved.patientData?.firstName,
        lastName: resolved.patientData?.lastName,
        // What makes the downgrade guard provable rather than name-based.
        personId: resolved.patientData?.personId,
        /**
         * NO DATE OF BIRTH FROM A CALLER-ID-ONLY MATCH. Codex P1 on 1d775a4,
         * answering a challenge I put to it — and my claim was FALSE. I said
         * an unconfirmed match "no longer auto-fills a date of birth". It
         * did: `certain` went false, but the DOB was still cached, and
         * `verifiedDobFor` returns `entry.dateOfBirth` WITHOUT reading
         * `entry.certain`. So a caller who then gives the matched name and
         * withholds their birthday gets the mirror's one auto-filled onto the
         * ticket, which is exactly the confirmation this change exists to
         * require.
         *
         * WHY THE WRITE AND NOT THE READ. `verifiedIdentity.ts` records a
         * deliberate decision to leave `verifiedDobFor` unnarrowed: it answers
         * a different question, has its own name guard, and narrowing it is a
         * ticket-path change that BACKEND_HANDOFF says needs a before/after
         * number. That reasoning was made when uncertain entries could only
         * come from a name-only hit. This PR adds a far larger uncertain
         * population — every caller-ID match — so the hole is mine to close,
         * and closing it at MY write leaves every pre-existing caller of that
         * reader behaving exactly as it does today. No measurement is owed for
         * behaviour that has not changed.
         *
         * The entry is still stored: `certain: false` is what the ambiguity
         * consumers read, and dropping the entry would break them.
         */
        ...(resolved.identityUnconfirmed ? {} : { dateOfBirth: resolved.patientData?.dateOfBirth }),
        /**
         * The office this queue routes on, carried rather than only spoken.
         *
         * It is computed twenty lines up and returned below as `usual_office`,
         * and until now that return value was the ONLY copy — so the filing
         * tool depended on the model relaying it back, which is the same
         * dependency that made `date_of_birth` arrive as "(none)" on 61 of 61
         * refusals. `null` when the history holds no office this queue can
         * use, which the store drops rather than writes.
         */
        ...(usualOffice ? { usualOffice } : {}),
        // The same `certain` reported to the model as `identity_is_certain`.
        // It was computed twenty lines up and then dropped here, so a
        // name-only hit was stored as though it were a verified identity
        // (Codex, PR #268 round 3).
        certain,
      });
    } else {
      /**
       * AN AMBIGUOUS ANSWER MUST NOT LEAVE A CONFIDENT ONE STANDING.
       *
       * Codex P1 on PR #291. There was no `else` here at all, so a call that
       * matched uniquely early and then came back ambiguous kept the FIRST
       * entry with its `certain: true` intact — and every reader answered
       * from a result this tool had just stopped believing. The office made
       * it reachable: `usualOfficeFor` leans on `certain` precisely because
       * an office string cannot be checked against the ticket, and `certain`
       * was stale.
       *
       * Scoped to the SAME NAME on purpose — see `forgetIfSameName`. Clearing
       * on every ambiguous lookup would discard a good identification the
       * moment the model ran a vaguer second search, and that entry is what
       * carries the date of birth past the gate that cost 53 of 75 calls.
       */
      const { forgetIfSameName } = await import('./verifiedIdentity');
      const dropped = forgetIfSameName(
        str(input.call_sid),
        resolved.patientData?.firstName,
        resolved.patientData?.lastName,
      );
      if (dropped) {
        // No name and no office: the fact that a call went ambiguous is not
        // PHI, and the count is what this line is for.
        console.info(
          '[TOOLS] lookup_patient: this call went ambiguous on a name we had ' +
            'already verified — forgetting the earlier match',
        );
      }
    }

    return {
      success: true,
      found: true,
      patient_name: resolved.patientName,
      matched_by: resolved.matchedBy,
      identity_is_certain: certain,
      ...(certain
        ? {}
        : {
            identity_warning: resolved.identityUnconfirmed
              ? 'This is the person our records show for the number they are calling from, but ' +
                'nobody has confirmed the CALLER is that person — a family member, a reassigned ' +
                'number or a withheld caller ID all look like this. Ask for their full name and ' +
                'date of birth before using any of it, and do not read their history back until ' +
                'they confirm who they are.'
              : `This ${phone && !first ? 'phone number' : 'name'} matches ` +
                `${resolved.identity?.candidateCount} different people on file, and what follows ` +
                `is only the most recently seen of them. Ask for their full name and date of ` +
                `birth before using any of it, and do not read their history back until they ` +
                `confirm who they are.`,
          }),
      // The field this queue routes on.
      usual_clinic: usualOffice,
      usual_office: usualOffice,
      // Where they were seen last, whatever kind of place that is.
      last_location_any_kind: resolved.lastLocationSeen ?? null,
      last_provider: resolved.lastProviderSeen ?? null,
      last_visit: resolved.lastVisitDate ?? null,
      recent_locations: seen.slice(0, 4),
      total_appointments: resolved.totalAppointmentsFound,
      ...(usualOffice
        ? {}
        : {
            message:
              `No ${facilityWord(queue)} found in their visit history. ` + askWhichOffice(queue),
          }),
    };
  },
});

// ---------------------------------------------------------------- where

const RESOLVE_TOOL = 'resolve_location';

/**
 * HOW MANY TIMES ONE CALL MAY BE ASKED WHICH OFFICE, BEFORE THE ASK IS A LOOP.
 *
 * Two, matching optical's filing gate: the first refusal is a question, the
 * second is the caller having another go, and a third has stopped being either.
 *
 * Measured on the grok runtime, 2026-09-03 to 2026-09-10: `resolve_location`
 * refused `spoken_location` 144 times across 66 calls, and ten calls reached
 * the 40-dispatch tool ceiling with this tool running 30-35 times. On the
 * eleven optical calls carrying two or more `location` refusals it averaged
 * 19-25 SUCCESSES and filed nothing at all — 0 of 11 — while the 61 calls that
 * took the filing gate's escape after a single refusal filed 53.
 *
 * The exit is deliberately NOT a refusal and NOT a guess. It hands the
 * caller's own words back with `resolved: false, verified: false`, which is
 * the same shape this tool already returns when the Console directory is not
 * configured. `file_*_ticket` then applies its OWN escape (`gateAttempts`,
 * the 2026-09-01 operator ruling) and takes the request unassigned at high
 * priority rather than losing it.
 */
const RESOLVE_ASK_LIMIT = 2;

/** Per-call fact: this call has already printed the exhausted marker. */
const RESOLVE_ASK_SPENT = 'resolve_location:ask_spent';

/** The caller has been asked as often as this call is allowed to ask. */
function officeAskSpent(callSid: string | undefined): boolean {
  return gateRefusalsSoFar(callSid, RESOLVE_TOOL, 'spoken_location') >= RESOLVE_ASK_LIMIT;
}

/**
 * The caller's words, carried on unverified. Never invented, never a guess —
 * `resolved: false` is the tool saying plainly that it could not place this.
 */
function unresolvedPassthrough(callSid: string | undefined, spoken: string): ToolResult {
  /**
   * A LIVE COUNTER OF CALLS, AND IT HAS TO BE ONE PER CALL TO BE THAT.
   *
   * This is the after-control for the whole change, so it is worth saying why
   * it is guarded. Printed unconditionally, it fired on every invocation
   * rather than every call — and the model may keep calling this tool after
   * the limit, which is the very loop being fixed. One 30-call loop printed
   * about 28 lines, so `grep -c` would have reported ~28 exhausted CALLS and
   * the after-number would have been inflated by the failure it exists to
   * detect. Found by Codex on PR #282; the tests hold it at one.
   *
   * `unresolvedPassthrough` is only reachable once `officeAskSpent` is true,
   * and that needs a real Twilio SID — `gateRefusalsSoFar` returns 0 for a
   * sentinel — so there is always a key to dedupe on.
   *
   * The CallSid is on the line deliberately: it makes the count distinct and
   * a single call traceable. No caller words are logged — a spoken office
   * name is the caller's own speech and this line is not the place for it.
   */
  if (!callFactNoted(callSid, RESOLVE_ASK_SPENT)) {
    noteCallFact(callSid, RESOLVE_ASK_SPENT);
    console.info(
      `[RESOLVE LOCATION] the office ask is spent on ${callSid} — passing the ` +
        "caller's words through unverified so the filing tool can take the request",
    );
  }
  return { success: true, resolved: false, location: spoken, verified: false, ask_exhausted: true };
}

registerTool({
  name: 'resolve_location',
  layer: 'agent',
  timeoutMs: 4000,
  /**
   * "BEFORE YOU FILE A TICKET" WAS READ AS "ALWAYS", AND IT COST 14 CALLS.
   *
   * 2026-09-03: this tool was called with NO ARGUMENT 34 times across 16 calls.
   * `spoken_location` is in `required`, so validateInput refused every one
   * before the handler ran — and only 5 of those 16 calls went on to file, the
   * worst recovery rate of any gate that day.
   *
   * The old wording named a MOMENT ("before you file") and never named a
   * PRECONDITION, so a model with nothing to resolve called it anyway, on
   * schedule, and burnt a turn asking a question standing instruction 10
   * forbids — "never ask a patient where our offices are".
   */
  description:
    'Turn what the caller said about an office into the real office name — ' +
    '"the Encinitas one", "Azul Vision Redlands". ONLY call this when the caller ' +
    'has actually named a place; there is nothing to resolve otherwise, and ' +
    'calling it empty just wastes a turn. If they have not named one, use the ' +
    'office already on their record instead.',
  input_schema: {
    type: 'object',
    properties: {
      spoken_location: { type: 'string', description: 'Whatever the caller said, verbatim.', askAs: 'Which of our offices do you usually visit?' },
    },
    required: ['spoken_location'],
  },
  handler: async (input): Promise<ToolResult> => {
    const queue = input.queue as ToolQueue | undefined;
    const spoken = str(input.spoken_location);
    const callSid = str(input.call_sid);
    const { sanitizeLocationName } = await import('../services/ticketFieldSanitizers');
    const cleaned = sanitizeLocationName(spoken);
    if (!cleaned.value) {
      return missing(['spoken_location'], 'Which of our offices do you usually visit?');
    }

    const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
    if (!isDirectoryConfigured()) {
      // No mirror: pass the cleaned string through rather than block a call.
      return { success: true, resolved: false, location: cleaned.value, verified: false };
    }

    const hit = await lookupLocation(cleaned.value);
    if (!hit) {
      /**
       * THIS USED TO RETURN `success: true`, AND IT WAS THE WORST LOOP WE HAD.
       *
       * Measured on the queue's first live day, 2026-08-13: `resolve_location`
       * ran 41 times across 29 optical calls, and 32 of those returned
       * `verified: false`. Five calls looped it three or more times, one of
       * them TEN times in a row with identical arguments. Those five averaged
       * 229 seconds against 134 for the rest — 95 extra seconds of a patient's
       * life each — and not one of them ended `resolved`.
       *
       * The trace is unambiguous. A caller said "Downtown LA", where we have no
       * optical office:
       *
       *   file_optical_ticket -> error: no optical office matched "Downtown LA"
       *   resolve_location    -> { success: true, verified: false }   x9
       *   file_optical_ticket -> error: no optical office matched "Downtown Los Angeles"
       *   resolve_location    -> { success: true, verified: false }
       *
       * `success: true` is what did it. The advisory `message` asked the agent
       * to go and ask the caller, but the envelope said the call had WORKED, so
       * the model had no reason to change anything and every reason to try
       * again. This is `local-tool-gates.md` exactly: answer a predictable
       * refusal with the refusal envelope, or the model retries it verbatim.
       *
       * Now it refuses, which hands the agent a sentence to say to the caller —
       * and the queue prompts already tell it that a tool asking for something
       * is not a fault.
       */
      // BOUNDED. Refusing forever is what turned this into a 35-call well.
      if (officeAskSpent(callSid)) return unresolvedPassthrough(callSid, cleaned.value);
      noteGateRefusal(callSid, RESOLVE_TOOL, 'spoken_location');
      return missing(
        ['spoken_location'],
        // See opticalTools' matching refusal: every queue prompt that uses
        // resolve_location forbids asking which city an office is in.
        `I'm not finding an office by that name — which of our offices do you usually visit?`,
      );
    }

    const usable = acceptsFacility(queue, hit.facilityKind);

    /**
     * THE WRONG KIND OF PLACE IS A REFUSAL, NOT A SUCCESS.
     *
     * The `!hit` branch above already learned this and says so at length: an
     * advisory `message` inside a `success: true` envelope tells the model the
     * call WORKED, so it has no reason to change anything and every reason to
     * try again. That fix stopped at the branch above. This one — an office
     * found, but a surgery centre named on the optical line — kept returning
     * success with a message, and it is the branch the 2026-09-10 ceiling
     * calls ran through: `resolve_location` x35, every one reporting success,
     * while `file_optical_ticket` refused for `location` beside it.
     *
     * Bounded like its sibling, so the refusal cannot become the same well.
     */
    if (!usable) {
      const wrongKind =
        `${hit.canonical} is a ${hit.facilityKind?.replace('_', ' ')}, not an ` +
        `${facilityWord(queue)}. ` + askWhichOffice(queue);
      if (officeAskSpent(callSid)) return unresolvedPassthrough(callSid, cleaned.value);
      noteGateRefusal(callSid, RESOLVE_TOOL, 'spoken_location');
      // The ENVELOPE changes; the diagnostic fields do not. Callers read
      // `usable_for_this_queue` to explain the refusal, and dropping it here
      // would trade one loop for a silent one.
      // Typed as the refusal PLUS diagnostics: `MissingFields` is closed, and
      // widening it would stop catching a misspelt `missingFields` everywhere
      // else. The intersection keeps that check where it matters and admits
      // the extra fields only here.
      const refusal: MissingFields & Record<string, unknown> = {
        ...missing(['spoken_location'], wrongKind),
        resolved: false,
        canonical_name: hit.canonical,
        facility_kind: hit.facilityKind,
        usable_for_this_queue: false,
        is_optical_office: false,
      };
      return refusal;
    }

    // `location` is the form the RECEIVER stores, not the form the mirror does.
    //
    // Found on the first live run against production: asked to resolve "Azul
    // Vision Eastvale" this returned `hit.canonical`, which is the Console's
    // nextgen_name — "Azul Vision Eastvale", brand and all. The Support Center's
    // own locations table stores "Eastvale". Handing an agent the mirror's form
    // hands it a name the ticketing app does not hold, and a ticket whose
    // location does not match is a ticket that reaches nobody on any queue that
    // assigns by location.
    //
    // file_*_ticket happens to sanitize this on the way out, so the Optical
    // path was covered by luck rather than by design. Any other caller of this
    // tool was not. Emit the fileable form, and keep the mirror's name beside
    // it for anyone who needs to look it up there.
    // `fileAs` wins when the ticketing app calls the office something else
    // entirely. "Azul Vision DTLA" in the mirror is "Los Angeles" over there,
    // and brand-stripping alone yields "DTLA" — a name the receiver has never
    // heard of, which is how a resolved office still failed to file.
    const fileable = hit.fileAs || sanitizeLocationName(hit.canonical).value || hit.canonical;

    return {
      success: true,
      resolved: true,
      verified: true,
      location: fileable,
      canonical_name: hit.canonical,
      facility_kind: hit.facilityKind,
      // Always true by the time we reach here: an unusable facility refused
      // above. Kept in the payload because callers read it.
      usable_for_this_queue: true,
      // Kept for existing Optical callers, which read this name.
      is_optical_office: hit.facilityKind === 'clinic' || hit.facilityKind == null,
    };
  },
});

// ---------------------------------------------------------------- already asked?

registerTool({
  name: 'check_open_tickets',
  layer: 'agent',
  timeoutMs: 5000,
  description:
    'Check whether this caller already has an open request with us. Call it before ' +
    'filing anything, so a patient chasing an existing request is told where it ' +
    'stands instead of having a second ticket opened.',
  input_schema: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'The number they are calling from.', askAs: 'What is the best phone number for you?' },
    },
    required: ['phone'],
  },
  handler: async (input): Promise<ToolResult> => {
    const phone = str(input.phone);
    const { SyncAgentService } = await import('../services/syncAgentService');
    const open = await SyncAgentService.checkOpenTickets(phone);
    return {
      success: true,
      has_open_tickets: open.length > 0,
      open_tickets: open.map((t) => ({
        ticket_number: t.ticketNumber,
        reason: t.reason,
        days_ago: t.daysAgo,
      })),
    };
  },
});

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * True only for a real Twilio Call SID. `metadata.callId` fallback values
 * ("unknown", "latest", "none", "unknown_sid" — traced 2026-08-20 to
 * `metadata.callSid ?? metadata.callId` in the four queue agents) satisfy a
 * truthy check but are not call identity. Sent as an idempotency key, one of
 * those sentinels would key on the literal string instead of the call, so a
 * second caller's retry could read back a stranger's ticket number.
 */
// The definition moved to `./callSid` so `gateAttempts` and `verifiedIdentity`
// can validate their map keys without importing this module (which pulls in
// the registry and every queue tool). Re-exported here so the four filing
// tools keep their single import line and there is still ONE definition.
export { isTwilioCallSid } from './callSid';

// Re-exported so the four queue tools only need one import line from here,
// not a second import path into `utils/phone.ts`. See that file for what it
// does and why it lives there rather than here or in scheduleLookupService.
export { normalizePhone } from '../utils/phone';

/**
 * The first place in this list this queue can actually use.
 *
 * `locations` is already newest-first, so the first acceptable one is the most
 * recent. Returns null when nothing in the history fits — which is a real
 * answer, not a failure, and the agent should ask rather than assume.
 *
 * Falls back to the first entry when the Console mirror is unreachable: a best
 * guess beats blocking the call, and `resolve_location` will catch it before a
 * ticket is filed.
 */
export async function mostRecentAcceptable(
  locations: string[],
  queue: ToolQueue | undefined,
  deadlineAt?: number,
): Promise<string | null> {
  if (locations.length === 0) return null;

  /**
   * THE LAST UNBOUNDED AWAIT BEFORE THE TOOL ANSWERS.
   *
   * Codex P1 round 3 on PR #292. `lookupLocation` reads a cached snapshot, but
   * a COLD OR STALE one triggers a refresh with a 5s connection timeout — and
   * this is a LOOP, one lookup per past location. The 250ms margin covers
   * building the result, not a database round trip, so `runTool`'s race can
   * still fire here and discard an identity the join went to some trouble to
   * preserve.
   *
   * MY CHANGE MADE THIS REACHABLE, which is why it belongs in this PR rather
   * than in #68. Before the PersonID join a mirror-identified caller had NO
   * past locations, so this returned `null` immediately; now they have several
   * and the loop runs. The join created the population that pays this cost.
   *
   * Out of time falls back to `locations[0]` — the raw most-recent office —
   * which is exactly what this function already does when the directory is
   * unconfigured or a lookup throws. A known fallback, not a new behaviour:
   * the office is unrefined, `resolve_location` is still the gate that
   * matters, and the caller keeps their identity.
   */
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
  if (remaining <= 0) return locations[0];

  const refine = async (): Promise<string | null> => {
    const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
    if (!isDirectoryConfigured()) return locations[0];

    for (const name of locations) {
      try {
        const hit = await lookupLocation(name);
        // An unknown location is more likely an office we have not mirrored
        // than a wrong one, so it is not disqualified here — resolve_location
        // is the gate that matters.
        if (!hit || acceptsFacility(queue, hit.facilityKind)) return name;
      } catch {
        return locations[0];
      }
    }
    return null;
  };

  if (remaining === Infinity) return refine();

  /**
   * CAPPED, not merely pre-checked. Checking the clock BEFORE each lookup
   * bounds nothing: the stall happens INSIDE one call, so the check that
   * matters has to be able to interrupt it. Same shape as the PersonID join —
   * a race, because the catch below only ever covered rejections.
   */
  /**
   * THE LOSING TIMER MUST BE CLEARED. Codex P2 on `ec45286`, and it is the kind
   * of bug this repo has been burned by twice: an instrument that fires when
   * nothing is wrong. Left dangling, the timer runs seconds AFTER the tool has
   * already answered — on every ordinary call, including the cached-directory
   * and unconfigured-directory paths — and logs "ran out of tool budget" for a
   * lookup that did not. That line is meant to be a live counter of a real
   * failure; firing it on success makes it count nothing. It also holds the
   * closure alive until the deadline.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      refine(),
      new Promise<string | null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            '[TOOLS] lookup_patient: the office refinement ran out of tool budget — ' +
              'using the most recent office unrefined',
          );
          resolve(locations[0]);
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
