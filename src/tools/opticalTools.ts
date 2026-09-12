/**
 * The tools an Optical-queue agent needs, and nothing else.
 *
 * Optical's contract (`ticket-workflow/MASTER.md` §9, operator-dictated, FINAL):
 *   - anything optical EXCEPT appointment requests
 *   - LOCATION is hard-required — one optician per location, and a ticket
 *     without one is never assigned to anybody
 *   - assignment is driven by location
 *
 * So this agent has exactly three jobs: work out who is calling, work out which
 * office they use, and file the ticket. That is the whole tool set, and it is
 * why routing by queue makes the prompt small — nothing here has to decide
 * whether the call is optical.
 */
import { registerTool, missing, type ToolResult } from './registry';
// lookup_patient, resolve_location and check_open_tickets are registered by the
// shared module. Importing it here is what puts them in the registry for this
// queue — the same three definitions Surgery uses, not copies of them.
import { str, isTwilioCallSid, normalizePhone } from './sharedPatientTools';
import { createTicketDurable, postFailureToolResult } from '../services/durableTicketFiling';
import { gateRefusalsSoFar, noteGateRefusal } from './gateAttempts';
import { decideDobEscape, dobStatusNote, dobEscapeMarker, type DobStatus } from './dobEscape';

/** This tool's own name, for the per-call gate counter. */
const OPTICAL_FILE_TOOL = 'file_optical_ticket';

/**
 * THE SERVER'S OFFICE REFUSALS ARE COUNTED SEPARATELY FROM OUR OWN GATE'S,
 * AND THE THRESHOLD IS THE REASON WHY.
 *
 * Our local gate refuses with `missing(['location'], …)`, which is the
 * envelope the prompts teach the agent to answer by SPEAKING to the caller,
 * and one of those is enough to count the office as asked. The ticketing
 * app's HTTP 400 is not the same event: it arrives without anyone having
 * been asked anything, and the model is documented to repeat the tool call
 * within seconds, unchanged, before it says a word — traced on
 * CA101be0fe842e77fd83a6024ae06df244 (2026-09-02), where
 * `file_surgery_ticket` was refused at 15:25:24.064 and called again at
 * 15:25:25.270 with an identical payload; the question comes afterwards.
 *
 * Folding the server's 400 into the local counter would therefore let that
 * 1.2-second retry spend an ask nobody made, and the attempt after it would
 * file UNASSIGNED — which is the failure this whole exemption is guarded
 * against, since optical assigns BY office. `file_surgery_ticket` met this
 * exact problem first and answered it with `>= 2` (see the long note at its
 * `surgeonAskExhausted`): over 14 days, 38 of 196 surgeon refusals were
 * rescued on attempt 2 by an ask that did land, so firing at one refusal
 * pre-empts the ask rather than replacing it.
 *
 * Same shape here, so the same threshold, on its own key. (Codex P1 on
 * PR #288, round 2.)
 */
const OPTICAL_SERVER_OFFICE_FIELD = 'location:server';

// ---------------------------------------------------------------- what kind

registerTool({
  name: 'classify_optical_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    'Work out which kind of optical request this is, in the practice\'s own ' +
    'categories. Call it with the caller\'s own words once you understand what ' +
    'they want, and before filing. If it cannot place the request it says so — ' +
    'file anyway with a clear description rather than forcing it into a box.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description: "What the caller wants, in their words. e.g. 'my glasses broke at the hinge'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifyOptical, OPTICAL_DEPARTMENT_ID } = await import('./opticalTaxonomy');
    const hit = classifyOptical(str(input.request_description));
    if (!hit) {
      return {
        success: true,
        classified: false,
        department_id: OPTICAL_DEPARTMENT_ID,
        message:
          'This does not match one of our optical categories. That is fine — file the ' +
          'ticket with a clear description of what they asked for and leave the category ' +
          'off. Do not pick a category that nearly fits.',
      };
    }
    return {
      success: true,
      classified: true,
      department_id: OPTICAL_DEPARTMENT_ID,
      request_type: hit.requestType,
      request_type_id: hit.requestTypeId,
      request_reason: hit.requestReason,
      request_reason_id: hit.requestReasonId,
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_optical_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the optical request for the team. This is the last step of the call. ' +
    'It needs the patient\'s name, date of birth, a callback number and the office ' +
    'they use — an optical ticket without an office cannot be assigned to anyone, ' +
    'because each office has its own optician. Pass the request_reason_id from ' +
    'classify_optical_request if you got one.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'May I please have the first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'May I please have the last name?' },
      /**
       * LEAD THE ASK, AND ALWAYS SEND IT BACK. Two separate 2026-09-03 findings
       * in one field; see sharedPatientTools for the operator's wording.
       *
       * The ORDER in the question is the guard — *"if you just say can I have
       * your date of birth, people give it to you in any format they want"*.
       *
       * The description is the other half. dobShape went live at 23:18 and the
       * first three filing calls after it all recorded "(none)": the model was
       * not sending this field AT ALL. Those three filed anyway because
       * lookup_patient had made a certain match and the handler fell back to the
       * verified record — which is exactly why the loss looked random. It stays
       * out of `required` (validateInput refuses before the handler, and that
       * would kill the fallback), so the description is where it gets said.
       */
      date_of_birth: { type: 'string', description: 'What the caller said, exactly as they said it. ALWAYS pass this when they have given it — leaving it out is what refuses the ticket.', askAs: 'And may I please have the date of birth, starting with the month, then the day, then the year?' },
      callback_number: { type: 'string', description: 'Best number to reach them.', askAs: 'What is the best number to reach you?' },
      location: { type: 'string', description: 'The office, as returned by resolve_location.', askAs: 'Which of our offices do you usually visit?' },
      request_description: { type: 'string', description: "What they need, in their words.", askAs: 'What can we help you with?' },
      request_reason_id: { type: 'string', description: 'From classify_optical_request. Omit if it could not classify.' },
      provider: { type: 'string', description: 'Their doctor, if it came up. Optional — looked up if omitted.' },
      email: { type: 'string', description: 'Optional — looked up if omitted.' },
      call_sid: { type: 'string', description: 'The call id, so a retry cannot double-file.' },
      caller_phone: { type: 'string', description: 'The number they called from, if different from the callback number.' },
      dialed_number: { type: 'string', description: 'The number they dialled.' },
    },
    /**
     * `location` is NOT in this list, and that is the operator ruling, not a
     * relaxation of the gate.
     *
     * Wayne, 2026-09-01: *"if you gate the location, the agent will ask and if
     * no answer, unassigned."* `validateInput` refuses before the handler runs,
     * so while `location` sat here the handler could never reach the second
     * half of that sentence — a caller who could not name an office was refused
     * for as long as they stayed on the line, and then lost.
     *
     * The gate still exists and still asks first; it lives in the handler now,
     * where it can count how many times this call has already been asked. The
     * refusal a caller hears on the first attempt is the same one, in the same
     * words, from `missing(['location'], …)`.
     */
    /**
     * `date_of_birth` is NOT in this list, and the gate on it is unchanged.
     *
     * `validateInput` refuses before the handler runs, so while it sat here the
     * handler could never consult the record `lookup_patient` had already
     * matched — and the caller was asked for a date of birth the process was
     * holding. 45 calls in the fourteen days to 2026-09-01 were refused for one
     * and ended with no ticket; on 23 of them the patient had already been
     * identified.
     *
     * The handler still refuses when it has neither the caller's answer nor a
     * verified record for that same name, in the same words as before.
     */
    required: ['first_name', 'last_name', 'callback_number', 'request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const first = str(input.first_name);
    const last = str(input.last_name);
    const dob = str(input.date_of_birth);
    const phone = str(input.callback_number);
    const location = str(input.location);
    const description = str(input.request_description);
    const callSid = str(input.call_sid);

    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      return missing(['callback_number'], 'I only caught part of that number — can I get all ten digits?');
    }
    /**
     * THE CEILING THAT WAS MISSING, NOT JUST THE WRONG VALUE SENT.
     *
     * A floor with no ceiling let a second number or an extension through as
     * a plausible-looking phone. Sending it (even normalized) would have
     * filed a ticket with a callback number nobody could reach — worse than
     * the loud 400 it replaces, and invisible in the ticket count. 90-day
     * distribution of real filed patient_phone digit lengths: 10 (180), 11
     * (1219), 12 (1 — an outlier, not evidence to widen this). 11 covers
     * >99.9% of real captures; refuse above it rather than guess.
     *
     * 11 digits not starting with 1 is refused too — normalizePhone() is
     * slice(-10), correctly loose for the lookup use it was written for, but
     * an 11-digit capture with a wrong leading digit (a mis-heard digit, a
     * stray keypress) would silently drop that digit and produce a
     * plausible, wrong, 10-digit number. Same failure shape as the raw
     * string this fix replaced, one digit narrower.
     */
    if (digits.length > 11 || (digits.length === 11 && digits[0] !== '1')) {
      return missing(
        ['callback_number'],
        "That's more digits than one phone number — can you give me just the callback number, without an extension or a second number?",
      );
    }

    const { OPTICAL_DEPARTMENT_ID, classificationByReasonId, classifyOptical } = await import(
      './opticalTaxonomy'
    );

    // The reason must be one of OPTICAL's own, whatever we were handed. This is
    // the guard that keeps this queue off request_reason_id 153 — the
    // Technicians-Support medication-refill reason that 953 optical tickets in
    // 90 days are currently filed under.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? classificationByReasonId(named) : null) ??
      classifyOptical(description);

    // Free text we send becomes the body of a patient-facing SMS on the other
    // side. One character outside GSM-7 turns the whole message from one
    // segment into three (160 chars → 70) and, worse, multi-segment long-code
    // traffic is far more exposed to US carrier A2P filtering. Measured on the
    // Support Center 2026-08-12: 1,700 of 17,446 voice tickets in 90 days
    // (9.7%) carry smart punctuation in the description. This is ours to fix
    // before it leaves.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(description);
    if (cleanDescription.changed) {
      console.info('[Optical] description normalised to GSM-7 before filing');
    }

    const { sanitizeProviderName, sanitizeLocationName } = await import(
      '../services/ticketFieldSanitizers'
    );
    const cleanLocation = sanitizeLocationName(location).value;
    const cleanProvider = sanitizeProviderName(str(input.provider)).value;

    /**
     * ASK ONCE, THEN FILE IT ANYWAY. Operator ruling, 2026-09-01:
     * *"In optical, if you gate the location, the agent will ask and if no
     * answer, unassigned."*
     *
     * The gate itself is right and stays — this queue assigns BY office. What
     * was wrong is that it had no exit. Measured over the 14 days to
     * 2026-09-01: 107 calls reached a filing tool, were refused for a missing
     * field, and ended with nothing filed. **62 of them were this gate**, with
     * the office as the only thing still missing; the caller had already given
     * their name, date of birth, callback number and the request itself.
     *
     * `gateRefusalsSoFar` is read BEFORE this refusal is recorded, so the first
     * attempt asks and a later one files. The far side accepts it: a
     * department-1 create-ticket carrying neither a location id nor a location
     * name was answered 200 in this same window, so "unassigned" is a ticket
     * that exists, not a second way to lose the request.
     */
    const askedForOfficeAlready = gateRefusalsSoFar(callSid, OPTICAL_FILE_TOOL, 'location') > 0;
    /**
     * The SERVER's refusals, on their own key and at their own threshold —
     * see `OPTICAL_SERVER_OFFICE_FIELD`. Read here, before this attempt can
     * record anything, so the first pass always reads 0.
     *
     * It is deliberately NOT part of `askedForOfficeAlready`: that value also
     * decides whether the LOCAL gate asks, and a server 400 must not silence
     * our own question. It only joins in `officeAskSpent`, which is read by
     * nothing but the exemption.
     */
    const serverRefusedOfficeTwice =
      gateRefusalsSoFar(callSid, OPTICAL_FILE_TOOL, OPTICAL_SERVER_OFFICE_FIELD) >= 2;
    const { ticketingApiClient, lookupWasUnavailable } = await import(
      '../../server/services/ticketingApiClient'
    );

    /**
     * THE OFFICE ON THE PATIENT'S OWN RECORD, CONSULTED BEFORE WE ASK.
     *
     * Operator ruling, 2026-09-12: when we already hold the office this
     * patient attends, route to it and do NOT ask them which office they use.
     *
     * THIS BLOCK SITS ABOVE THE GATE ON PURPOSE, and that placement IS the
     * fix. Codex P1 on PR #291 found the first version of this feature sitting
     * BELOW the gate, where it was inert for the population it was written
     * for: the gate returns `missing(['location'])` on the first call, so the
     * record was consulted only if the model invoked the tool a SECOND time —
     * and this repo's own measurement says it frequently does not (in 42 of 75
     * date-of-birth refusals the refusal is the LAST tool event of the call).
     * Reproduced before fixing: with a certain record and the directory fully
     * up, call one filed nothing and call two filed routed.
     *
     * WHAT IS TRADED, stated plainly because it is a real cost. A patient
     * ringing about an office OTHER than their usual one, who names none, now
     * gets routed to their usual one instead of landing unassigned for a human
     * to triage. The operator weighed that against 8 of 25 such calls ending
     * with NO ticket at all on 2026-09-11 and chose routing. The narrowness
     * that remains is unchanged and load-bearing: an office the caller NAMES
     * always wins (`!cleanLocation` guards this whole block), and
     * `usualOfficeFor` refuses an ambiguous match outright.
     *
     * An UNAVAILABLE answer also skips the ask. If the directory is down, an
     * office the caller names cannot resolve either, so asking is friction
     * with no upside; the request is taken by the unassigned exit below, which
     * is what standing instruction 10 asks for.
     */
    let recordLookup:
      | Awaited<ReturnType<typeof ticketingApiClient.lookupProviderAndLocation>>
      | undefined;
    let officeFromRecord: string | undefined;
    if (!cleanLocation) {
      const { usualOfficeFor } = await import('./verifiedIdentity');
      const onRecord = usualOfficeFor(callSid, first, last);
      if (onRecord) {
        const byRecord = await ticketingApiClient.lookupProviderAndLocation({
          locationName: onRecord,
          ...(cleanProvider ? { providerName: cleanProvider } : {}),
        });
        if (byRecord.locationId) {
          recordLookup = byRecord;
          officeFromRecord = onRecord;
          // Names no office and no patient: the office is not PHI on its own,
          // but pairing it with a call identifier is a step toward one, and
          // the count is what this line is for.
          console.info(
            '[optical] the caller named no office — routed to the one on their record',
          );
        } else if (lookupWasUnavailable(byRecord)) {
          // Adopted rather than dropped, so the outage is reported as an
          // outage instead of as an office we do not hold (Codex P2, #291).
          recordLookup = byRecord;
        }
      }
    }

    if (!cleanLocation && !recordLookup && !askedForOfficeAlready) {
      noteGateRefusal(callSid, OPTICAL_FILE_TOOL, 'location');
      return missing(['location'], 'Which of our offices do you usually visit?');
    }

    /**
     * DECLINING TO ASK SPENDS THE ASK. This line is not bookkeeping — without
     * it the change above silently reintroduces the #105 loop.
     *
     * `routingAskExhausted` is the flag the ticketing app requires before it
     * will accept an optical ticket with no office; without it the POST is
     * answered HTTP 400 "Missing required information: office" and NOTHING
     * files. It is gated on `officeAskSpent`, which until now could only be
     * set by a refusal counter — i.e. by having actually asked.
     *
     * The block above introduces the first path that files with no office
     * having never asked: the record named an office and the DIRECTORY was
     * down, so there was nothing to ask for. Caught by the outage test, which
     * failed on `routingAskExhausted` being undefined.
     *
     * It does not weaken the guard the flag exists for. The comment at the
     * POST says the danger is sending it unconditionally, on a value a MODEL
     * could supply; this is our own code recording that it decided not to ask,
     * and it still cannot fire while `lookup.locationId` is set.
     */
    const officeAskWaived = recordLookup !== undefined && !recordLookup.locationId;
    const officeAskSpent =
      askedForOfficeAlready || serverRefusedOfficeTwice || officeAskWaived;
    const { normalizeDobParts } = await import('./dobParts');
    let parts = normalizeDobParts(dob);
    if (!parts) {
      /**
       * ASK ONCE, NOT TWICE. Operator instruction, 2026-09-01: *"if we do our
       * job and validate and pass the patient records along, you will not have
       * this issue."*
       *
       * `lookup_patient` found this caller — it does on 95% of queue calls —
       * and the service returned their date of birth with the match. Nothing
       * carried it here, so the agent asked for something the process already
       * held, and 45 calls in fourteen days ended with no ticket because the
       * caller could not answer. On 23 of those we already knew who they were.
       *
       * Only ever for the SAME NAME as the verified match, and only from a
       * match the lookup was certain about. See verifiedIdentity.ts.
       */
      const { verifiedDobFor } = await import('./verifiedIdentity');
      const known = verifiedDobFor(callSid, first, last);
      parts = known ? normalizeDobParts(known) : null;
      if (parts) {
        // No name in the log line: this is the one place a masked identifier
        // would still be the patient.
        console.info('[optical] date of birth taken from the verified record for this call');
      }
    }
    if (!parts) {
      /**
       * THE CALLER ALREADY ANSWERED — STOP DEPENDING ON THE MODEL TO RELAY IT.
       *
       * 2026-09-08, the queue lanes, one full business day: 75 substantive
       * calls hit this gate and 53 of them filed nothing. It is the single
       * biggest cause of a call producing no ticket, and the measurement says
       * the gate is not where it fails:
       *
       *  - On 75 of 75, the model called this tool with NO `date_of_birth`
       *    argument at all. `dobShape` reads "(none)" on every refusal, across
       *    surgery, tech and optical.
       *  - In 51 of the 75, the caller's own transcribed words contain a birth
       *    year or a month name. They answered the question that was asked.
       *  - In 42 of the 75 the refusal is the LAST TOOL CALL OF THE CALL, so
       *    the ask-once-then-file escape below never gets its second attempt.
       *    It is unreachable in the majority of cases.
       *
       * The two sources above both go through the model or the record. This
       * one does not: it is what the caller said on this call, taken from the
       * transcript the bridge was already keeping and nothing else could see.
       *
       * ONLY FROM THE TURN THAT ANSWERED THE QUESTION. A caller says surgery
       * dates and appointment dates too, and filing a wrong birthday is worse
       * than filing none — see spokenDob.ts for the adjacency rule and what it
       * still cannot catch.
       */
      const { spokenDobFor } = await import('./spokenDob');
      const heard = spokenDobFor(callSid);
      parts = heard ? normalizeDobParts(heard) : null;
      if (parts) {
        // The line names neither the value nor the patient, for the same
        // reason as the one above it.
        console.info('[optical] date of birth taken from what the caller said on this call');
      }
    }
    /**
     * ASK ONCE, THEN FILE IT ANYWAY. Operator ruling 2026-09-04, and the same
     * ruling he gave for optical's office on 2026-09-01. The measurement that
     * settles it: the location gate has this escape and recovered 9 of 11; this
     * gate did not and recovered 0 of 23. See dobEscape.ts.
     */
    let dobStatus: DobStatus | null = null;
    if (!parts) {
      const escape = decideDobEscape(callSid, OPTICAL_FILE_TOOL, dob);
      if (escape.askAgain) {
        /**
         * The first refusal only, and it carries BOTH channels: `message` is
         * the coaching line the agent says, `fix` is what the model itself got
         * wrong. The two branches of `fix` need OPPOSITE corrections — telling
         * the model "ask the caller again" when it simply omitted the argument
         * is what built the loop.
         */
        return missing(
          ['date_of_birth'],
          'I did not catch that — may I please have the date of birth, starting with the month, then the day, then the year?',
          dob
            ? 'The date_of_birth you sent could not be read as a date. Say the message to the caller, '
              + 'then call this tool again with exactly what they say next.'
            : 'You did not send the date_of_birth argument at all — that, not the caller, is why this '
              + 'was refused. If they have ALREADY given you a date of birth, call this tool again '
              + 'right now with date_of_birth set to what they said, and do NOT ask them again. Only '
              + 'say the message if they have not given it yet.',
        );
      }
      dobStatus = escape.status;
      console.info(dobEscapeMarker(OPTICAL_FILE_TOOL, dobStatus, callSid));
    }

    // Resolve the office to the ticketing app's numeric id BEFORE filing.
    //
    // `locationOfLastVisit` is only a text hint — create-ticket sets the
    // location foreign key from `locationId` and nothing else. Filing VA-50803
    // with the name alone produced location_id NULL and assigned_to_id NULL:
    // a real ticket, in the right department, that reached nobody. For a queue
    // whose assignment IS the location, that is the whole failure mode.
    // Nothing to resolve if the caller never named an office and never named a
    // provider — and calling /lookup with an empty name is how a queue asks a
    // question it already knows the answer to.
    // The record's answer, when there is one, IS this call's lookup — resolved
    // above so the gate could see it. Falls through to the caller's own words,
    // then to the synthetic no-match, exactly as before.
    let lookup =
      recordLookup ??
      (cleanLocation || cleanProvider
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
            ...(cleanProvider ? { providerName: cleanProvider } : {}),
          })
        : {
            success: true,
            outcome: 'no_match' as const,
            locationId: undefined,
            providerId: undefined,
            locationMatches: [],
            error: undefined,
          });
    /**
     * A LOOKUP THAT NEVER RAN IS NOT A NAME THAT DID NOT MATCH.
     *
     * `lookupProviderAndLocation` catches its own error and returns
     * `{success:false}` — the SAME shape it returns for a name that matches
     * nobody. Reading only `locationId` collapses the two, and only one of them
     * is the caller's problem to solve.
     *
     * On 2026-08-31 that collapse took optical to zero. `/api/voice-agent/lookup`
     * rode the n8n gateway; n8n hit its plan's execution cap at 20:16 UTC and
     * refused every execution at the webhook, answering 200 with a body that is
     * not JSON. Optical is the only queue that hard-requires this resolve, so it
     * failed a step earlier than the others and never reached create-ticket.
     * Forty-three callers were told "I'm not finding an office by that name"
     * about Mission Hills, Downey, Glendale, Santa Ana and the rest of the map.
     * The sentence was false, so the caller repeated the office, so the tool
     * asked again: one call ran 19 tool calls over 8 minutes.
     */
    // Read through the shared predicate rather than off `success`, so this
    // queue and the other three answer the question the same way. The client
    // now states it outright as `outcome: 'unavailable'`; the predicate keeps
    // the old boolean working for fixtures that predate the field.
    const lookupRan = !lookupWasUnavailable(lookup);


    if (lookupRan && !lookup.locationId) {
      /**
       * A NAME THAT DOES NOT MATCH IS NOT A TRANSIENT ERROR, and this used to
       * say `retryable: true` while telling the agent to go and call
       * resolve_location again. It did — nine times in a row, on one 236-second
       * call on 2026-08-13 where the caller said "Downtown LA" and we have no
       * optical office there.
       *
       * Refuse rather than file something nobody will see — an unassigned
       * optical ticket is indistinguishable from a lost one, and this queue
       * assigns BY location. But refuse as a MISSING FIELD, which is the
       * envelope the prompts already teach the agent to answer by speaking to
       * the caller, rather than as an error it is invited to retry.
       */
      /**
       * Second time here on the same call, per the operator ruling above: the
       * agent has asked, the answer still does not resolve, so the request is
       * taken and the office becomes a manual step rather than a lost call.
       * The caller's own words travel on `locationOfLastVisit`, and the raised
       * priority below is what surfaces it for assignment.
       */
      if (askedForOfficeAlready) {
        console.warn(
          `[optical] office "${cleanLocation}" still does not resolve after asking — ` +
            'filing UNASSIGNED at high priority (operator ruling 2026-09-01)',
        );
      } else {
        const candidates = lookup.locationMatches?.length
          ? ` I have ${lookup.locationMatches.map((m) => m.name).join(', ')} — is it one of those?`
          : '';
        noteGateRefusal(callSid, OPTICAL_FILE_TOOL, 'location');
        return missing(
          ['location'],
          // NOT "which city is your office in?". Four agent prompts — optical,
          // surgery, tech, records — say "NEVER ask a patient which city one of
          // our offices is in; they came to us, we know where we are", and this
          // tool was handing the model that exact sentence to say. Read back the
          // candidates when there are any, which is what the prompts ask for.
          `I'm not finding an office by that name.${
            candidates || ' Which of our offices do you usually visit?'
          }`,
        );
      }
    }

    /**
     * The lookup is down. Take the request — losing it is the worse outcome,
     * and standing instruction 10 is that a caller's request gets taken and
     * routed, never deferred back to them. Surgery already files unrouted on
     * exactly this failure (`SURGEON DID NOT RESOLVE`, dept 2 routes by
     * surgeon) on the same reasoning: an unassigned ticket is a manual step,
     * a lost one is a patient problem.
     *
     * The difference here is that optical's assignment IS the location, so an
     * unassigned ticket reaches nobody unless something surfaces it. Two
     * signals do that, and neither touches patient-readable text: the office
     * the caller named is preserved verbatim in `locationOfLastVisit`, and the
     * priority is raised so the ticket does not sit at the bottom of a queue
     * view sorted by it. Staff then see a high-priority optical ticket with no
     * office set and the caller's own words for the office — the manual step is
     * "set this office", not "phone them back and ask again".
     *
     * NOT in the description. `docs/BACKEND_HANDOFF.md` lists annotating an
     * unrouted ticket's description under changes that made things worse,
     * because description is free text that has fed patient-facing SMS. No
     * current template pulls it (checked 2026-09-01 against every `sendSMS`
     * call site, and against 85 sent messages), but the field is the wrong
     * place for an instruction to staff and there is no internal-notes column
     * to put one in.
     */
    if (!lookupRan) {
      console.error(
        `[Optical] ✗ LOCATION LOOKUP UNAVAILABLE — filing '${cleanLocation}' UNASSIGNED. ` +
          `Dept 1 assigns by location, so this ticket needs manual assignment. ` +
          `Cause: ${lookup.error ?? 'unknown'}`,
      );
    }

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    //
    // This used to fall back to submit-ticket when nothing classified. Proving
    // the Surgery build against production killed that: VA-50811 was filed by
    // THIS agent through that fallback, its description said in plain words "a
    // question about my account that fits no optical category", and it landed
    // in department 8 — After Hours Call Service — with assigned_to_id NULL and
    // a subject reading "Wayne Fabian - After Hours Call". Nothing in the text
    // said after hours. submit-ticket re-derives the DEPARTMENT server-side,
    // not merely the reason, and defaults to 8 when it cannot derive one.
    //
    // The old comment here reasoned that a filed ticket with a weak category
    // beats telling a caller we cannot help. That was right. What it got wrong
    // was believing the fallback produced a weak CATEGORY, when it produced a
    // weak DEPARTMENT — a ticket no optician will ever open.
    //
    // create-ticket REQUIRES the triple: measured 2026-08-12, `requestTypeId: 0`
    // and omitting the fields are both rejected. A request fitting none of the
    // eighteen pairs therefore had nowhere honest to go, and briefly borrowed
    // reason 4, Style Consultation. It does not any more — see below.
    // The catch-all comes from the shared table, keyed on THIS queue's
    // department — so an unclassifiable optical call is filed as Other in
    // Optical Support, not in whichever department a server-side guess landed
    // on. Operator, 2026-08-12: "instead of going to department one, it goes to
    // the department that took the call."
    //
    // This used to borrow reason 4, Style Consultation, as the least clinical
    // of the eighteen optical reasons. It was still a claim the request had not
    // made. Nothing here borrows a reason any more.
    const { otherReasonFor } = await import('./otherReason');
    const other = otherReasonFor(OPTICAL_DEPARTMENT_ID);
    if (!cls && !other) {
      // Cannot happen with the current table, and if it ever does, refusing is
      // right: a ticket in the wrong department is indistinguishable from a
      // lost one.
      return {
        success: false,
        error: `no catch-all reason for department ${OPTICAL_DEPARTMENT_ID}`,
        retryable: false,
      };
    }
    const filing = cls ?? other!;

    // A CALLER WHO PRESSED THE WRONG OPTION IS NOT SENT AWAY.
    //
    // Operator ruling 2026-08-13: these queues are forwarded, so a patient who
    // pressed the medication option with an optical question must not be told
    // to call back and dial again. If the words clearly belong to another
    // department, the ticket is filed THERE, and the receiving team is told how
    // it arrived. Scheduling goes to the HVA Hub from every queue.
    //
    // The detector stays silent unless the misroute is obvious — the line that
    // rang is better evidence than a keyword, and a redirect on a guess would
    // be worse than none.
    const { detectCrossQueue } = await import('./queueRouting');
    const redirect = detectCrossQueue(description, OPTICAL_DEPARTMENT_ID);
    const filedDepartmentId = redirect?.departmentId ?? OPTICAL_DEPARTMENT_ID;
    const filedTypeId = redirect?.requestTypeId ?? filing.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? filing.requestReasonId;
    const routedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    /**
     * THE STATUS GOES FIRST, ABOVE THE CALLER'S OWN WORDS.
     *
     * Operator, 2026-09-04: *"where date of birth would be, you just put
     * unavailable or unmatched, so this way we know what was happening."*
     * It cannot go in the birth columns — they are varchar(2)/(2)/(4) — so it
     * goes where staff actually look, and first, because the point is that
     * nobody matches this to a chart without checking the recording.
     */
    /**
     * THE STATUS DOES NOT GO IN THE DESCRIPTION.
     *
     * That field becomes the body of a patient-facing SMS — `opticalTools`
     * sanitizes it to GSM-7 for exactly that reason, and BACKEND_HANDOFF
     * section 6 lists "annotating unrouted tickets in description" among the
     * changes caught in review. Prepending "Confirm identity from the call
     * recording before matching this to a chart" would have texted the
     * caller an instruction meant for staff (Codex, PR #268 round 5).
     *
     * The operator's ruling — *"where date of birth would be, you just put
     * unavailable or unmatched, so this way we know what was happening"* —
     * is about STAFF knowing. `callData` carries it to the ticket's own
     * call-metadata columns, which no message to the patient reads.
     */
    const routedDescriptionWithDobStatus = routedDescription;
    const dobStaffNote = dobStatus ? dobStatusNote(dobStatus) : undefined;
    /**
     * ONLY WHILE THE TICKET IS STILL OPTICAL'S — Codex, PR #244.
     *
     * An optical ticket with no office is one nobody's queue view will
     * surface, and raising the priority is what surfaces it (see the block
     * above for why the signal does not go in the description). That reasoning
     * is entirely about the OPTICAL queue view.
     *
     * Once `detectCrossQueue` has sent the ticket somewhere else — a
     * scheduling request going to the HVA Hub under the 2026-08-13 ruling —
     * the receiving team's ticket does not depend on an optical office at all.
     * Boosting it there marks a routine appointment request urgent because the
     * caller never mentioned an optician's branch, or because the lookup
     * happened to be down. Falsely urgent tickets in someone else's queue are
     * how a priority column stops meaning anything.
     */
    const filedPriority = !redirect && !lookup.locationId ? 'high' : 'medium';
    if (redirect) {
      console.info(
        `[optical] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    const res = await createTicketDurable({
      departmentId: filedDepartmentId,
      requestTypeId: filedTypeId,
      requestReasonId: filedReasonId,
      patientFirstName: first,
      patientLastName: last,
      // Last ten digits, not the raw string and not all of `digits` — see
      // normalizePhone() in utils/phone.ts. The floor+ceiling above already
      // refused anything that isn't one plausible phone number, so this is
      // exactly ten digits or it wasn't reached. Traced 2026-08-21: the raw
      // string is what filed zero tickets across 3 calls / 32 POSTs over 14
      // days (their schema caps patientPhone at 20 chars, the raw string has
      // no upper bound). Safe format-wise: their own sendSMS() normalizer
      // strips non-digits and re-derives this same string before dialing out.
      patientPhone: normalizePhone(phone),
      patientEmail: str(input.email) || undefined,
      preferredContactMethod: 'phone',
      // Omitted entirely when the escape was taken. create-ticket takes these
      // as optional (traced 2026-09-03), and the columns are varchar(2)/(2)/(4)
      // so a word like "unavailable" could not be stored there even if we tried
      // — the status rides in the description instead, which is what staff read.
      ...(parts
        ? {
            patientBirthMonth: parts.month,
            patientBirthDay: parts.day,
            patientBirthYear: parts.year,
          }
        : {}),
      /**
       * THE FLAG THAT SANCTIONS AN UNASSIGNED OPTICAL TICKET — surgery has
       * sent this since 2026-09-02 and optical never has.
       *
       * MEASURED 2026-09-11 in `voice_agent_api_logs`: over 30 days, every
       * POST carrying `routingAskExhausted` is department 2, 56 of 56, all
       * answered 200. Department 1 sent it ZERO times, and 48 distinct
       * optical calls in the same window were answered HTTP 400 "Missing
       * required information: office".
       *
       * That 400 is what the loop actually is. The escape above fires
       * correctly and POSTs the unassigned ticket; the app refuses it; the
       * tool surfaces the refusal as `missingFields: ["location"]`, which
       * reads in the timeline exactly like our own gate refusing a third
       * time; the model asks again and re-runs `resolve_location` thirty-odd
       * times into the 40-tool ceiling. Two requests were lost that way on
       * 2026-09-11 alone, 42 minutes apart, and on the second the office was
       * never in doubt — recognised by phone, read back off the record,
       * confirmed, and said again out loud.
       *
       * NEITHER SIDE LOOKS WRONG ALONE, which is why this survived. Our
       * escape is correct and proven offline. The app's gate is correct and
       * deliberately staged — `DEPARTMENTS_WITH_UNASSIGNED_EXIT` is
       * `new Set([2])` and its own comment says "Optical's 62 lost requests
       * are the next measurement, not this one". The defect is the seam: we
       * never sent the flag that would have asked.
       *
       * THREE GUARDS, copied from `file_surgery_ticket` because each earns
       * its place there and the same reasoning holds here:
       *  - `officeAskSpent` comes from the per-call refusal counters, which
       *    are keyed on a REAL CallSid and never on a model argument. Sent
       *    unconditionally this switches the app's gate off, and optical
       *    assigns BY location — the department-2 shape that went ~98% to 49%
       *    once already. One LOCAL refusal spends it; the SERVER's 400 takes
       *    two, because a 400 is not proof anyone was asked — see
       *    `OPTICAL_SERVER_OFFICE_FIELD`.
       *  - `!lookup.locationId`, so a ticket that DID resolve an office never
       *    claims to need manual routing.
       *  - the ticket is still on the OPTICAL queue: a request `detectCrossQueue`
       *    sent to the HVA Hub or another department is not gated on an office
       *    at all, and must not spend this exemption.
       */
      ...(filedDepartmentId === OPTICAL_DEPARTMENT_ID
        && officeAskSpent
        && !lookup.locationId
        ? { routingAskExhausted: true }
        : {}),
      // The id is what sets the foreign key; the name is what staff read.
      // Omitted rather than sent null when the lookup could not run — the name
      // still travels, and the raised priority surfaces it for assignment.
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: routedDescriptionWithDobStatus,
      priority: filedPriority,
      callData: {
        agentUsed: 'optical',
        ...(callSid ? { callSid } : {}),
        // Staff-only. Never the description — that is an SMS body.
        ...(dobStaffNote ? { transcript: dobStaffNote } : {}),
      },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
    });

    if (!res.success || !res.ticketNumber) {
      // The POST failed. createTicketDurable has already put the payload in the
      // outbox if it could; this only decides what the agent says about it.
      /**
       * THE SERVER'S REFUSAL IS ALSO AN ASK, AND OPTICAL WAS NOT COUNTING IT.
       *
       * `file_surgery_ticket` has done this since 2026-09-02 and this tool
       * never has. Codex P1 on PR #288 found the hole it leaves: our own
       * office gate is skipped whenever the caller DID name something, and
       * skipped entirely when the lookup is unavailable (`lookupRan` false,
       * the "take the request rather than lose it" path). On those calls
       * nothing local ever spends the ask, so `askedForOfficeAlready` stays
       * false, the exemption above is never attached, and the app answers the
       * same missing-office 400 on every retry — indefinitely.
       *
       * Counting the server's refusal closes that without weakening the
       * guard. The refusal becomes the question: `postFailureToolResult`
       * turns it into a sentence the agent says to the caller, and a later
       * attempt carries the exemption and files unassigned rather than
       * taking the same 400 forever.
       *
       * NOT the alternative Codex proposed, which was to add the
       * lookup-unavailable path straight into the exemption. That files
       * unassigned on the FIRST attempt during an outage, without ever asking
       * — it fixes the 400 by skipping the question, and optical assigns BY
       * location, so the office is worth an ask before giving up on it.
       *
       * ON ITS OWN KEY, AND IT TAKES TWO. Round 2 of the same review: folded
       * into the local counter, the model's documented 1.2-second identical
       * retry would spend an ask nobody made and the attempt after it would
       * file unassigned. `OPTICAL_SERVER_OFFICE_FIELD` carries the whole
       * argument and surgery's measured threshold.
       *
       * Counted ONLY for the office: `REMOTE_FIELD_CANDIDATES` maps the
       * server's `office` and `location` onto this tool's `location`, and a
       * refusal for any other field has not put this question to anyone.
       */
      if (
        res.terminal &&
        (res.missingField === 'office' || res.missingField === 'location')
      ) {
        noteGateRefusal(callSid, OPTICAL_FILE_TOOL, OPTICAL_SERVER_OFFICE_FIELD);
      }
      return postFailureToolResult(res, 'file_optical_ticket');
    }

    return {
      success: true,
      ticket_number: res.ticketNumber,
      classified: Boolean(cls),
      // REPORT WHAT WAS FILED, not what the home queue classified it as.
      // See the note in techTools — a live curl on 2026-08-13 reported a
      // department 3 reason on a ticket filed into Optical.
      request_reason: redirect ? redirect.requestReason : filing.requestReason,
      request_reason_id: filedReasonId,
      // The id we actually attached, so a caller can tell a real assignment
      // from a ticket that merely mentions an office in its text.
      location_id: lookup.locationId,
      // Say the number back. Callers ask for it, and staff quote it.
      ...(redirect
        ? { routed_to: redirect.departmentName, routed_department_id: redirect.departmentId }
        : {}),
      message: redirect
        ? `Filed as ${res.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
        : `Filed as ${res.ticketNumber}. Read the ticket number back to the caller.`,
    };
  },
});
