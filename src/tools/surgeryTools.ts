/**
 * The tools a Surgery-Coordination agent needs, and nothing else.
 *
 * Surgery's contract, operator-dictated 2026-08-12 when asked directly what the
 * queue may take: pre-op logistics (drops, clearance forms, arrival times),
 * reschedules and cancellations, post-op questions, and deposit or balance
 * questions. In other words everything surgery-adjacent — this queue does not
 * hand callers off and does not decline the awkward half of its own subject.
 *
 * WHAT IS DIFFERENT FROM OPTICAL, and why it is not a copy of it:
 *
 *   Optical refuses to file without a location, because one optician per office
 *   IS the assignment rule and a location-less optical ticket reaches nobody.
 *   Measured for Surgery over 60 days: 3,396 of 3,446 tickets are assigned, and
 *   only 3 of the 50 unassigned lack a location. Assignment is not this queue's
 *   failure mode, so refusing a whole call over a missing office would cost
 *   more than it saves. Location is collected and attached when we can get it,
 *   and its absence is reported rather than fatal.
 *
 *   Classification IS the failure mode. 2,183 agent-filed tickets in 60 days
 *   used exactly two reasons between them and never touched the other
 *   seventeen. See `surgeryTaxonomy.ts` for the two hardcoded fallbacks that
 *   cause it.
 *
 * The three tools this queue shares with Optical — lookup_patient,
 * resolve_location, check_open_tickets — come from `sharedPatientTools`, one
 * definition each, made queue-aware rather than forked.
 */
import { registerTool, missing, type ToolResult } from './registry';
import { str, isTwilioCallSid, normalizePhone } from './sharedPatientTools';
import { createTicketDurable, postFailureToolResult } from '../services/durableTicketFiling';
import { gateRefusalsSoFar, noteGateRefusal } from './gateAttempts';

/** This tool's own name, for the per-call gate counter. */
const SURGERY_FILE_TOOL = 'file_surgery_ticket';

// ---------------------------------------------------------------- what kind

registerTool({
  name: 'classify_surgery_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    "Work out which kind of surgery request this is, in the practice's own " +
    'categories. Call it with the caller\'s own words once you understand what they ' +
    'want, and before filing. It covers the logistics people actually ring about — ' +
    'drops that never arrived, clearance forms, arrival times, reschedules, deposits, ' +
    'chasing a callback — as well as the operations themselves, so it always returns ' +
    'something. Pass its request_reason_id to file_surgery_ticket.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description:
          "What the caller wants, in their words. e.g. 'my surgery is Monday and the " +
          "drops never came'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifySurgeryRequest, SURGERY_DEPARTMENT_ID } = await import('./surgeryTaxonomy');
    const { classification, isCatchAll, isLogistics } = classifySurgeryRequest(
      str(input.request_description),
    );

    return {
      success: true,
      // Always true now. Before request type 65 existed this said false for
      // most of the queue, because there was nothing true to return.
      classified: !isCatchAll,
      department_id: SURGERY_DEPARTMENT_ID,
      request_type: classification.requestType,
      request_type_id: classification.requestTypeId,
      request_reason: classification.requestReason,
      request_reason_id: classification.requestReasonId,
      ...(isLogistics ? { logistics: true } : {}),
      ...(isCatchAll
        ? {
            message:
              'Nothing matched, so this is filed as "Other - See Description". That is a ' +
              'real category, not a guess — but it means the description is the only thing ' +
              'a coordinator has. Make sure it says what they actually asked for.',
          }
        : {}),
      ...(classification.urgent
        ? {
            urgent: true,
            message:
              'These are the words we treat as a surgical emergency. Tell the caller to ' +
              'seek emergency care or call 911 now, and file this at urgent priority. ' +
              'Do not take a routine message and hang up.',
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_surgery_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the surgery request for the coordinator. This is the last step of the ' +
    "call. It needs the patient's name, date of birth and a callback number. Pass " +
    'the request_reason_id from classify_surgery_request if you got one, and the ' +
    'description_prefix if it gave you one instead. Pass the office or surgery ' +
    'centre if you have it.',
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
      request_description: { type: 'string', description: 'What they need, in their words.', askAs: 'What can we help you with?' },
      request_reason_id: { type: 'string', description: 'From classify_surgery_request. Omit if it could not classify.' },
      description_prefix: { type: 'string', description: 'From classify_surgery_request when it could not classify but recognised the kind of request.' },
      location: { type: 'string', description: 'The office or surgery centre, as returned by resolve_location.', askAs: 'Which office or surgery centre are you being seen at?' },
      surgeon: {
        type: 'string',
        description:
          'The surgeon, ONLY when the caller names one. Do NOT pass '
          + "lookup_patient's last_provider — that is the last clinician seen, often an "
          + 'optometrist doing a post-op check, and passing it here overrides the '
          + "physician-only lookup this tool already runs against the patient's record.",
        askAs: 'And which surgeon are you seeing?',
      },
      surgery_date: { type: 'string', description: 'The date of their surgery, if they gave one. Put it in the description too.' },
      urgent: { type: 'string', description: 'Pass "true" only when classify_surgery_request said urgent.' },
      email: { type: 'string', description: 'Optional — looked up if omitted.' },
      call_sid: { type: 'string', description: 'The call id, so a retry cannot double-file.' },
      caller_phone: { type: 'string', description: 'The number they called from, if different from the callback number.' },
      dialed_number: { type: 'string', description: 'The number they dialled.' },
    },
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

    const { SURGERY_DEPARTMENT_ID, surgeryReasonById, classifySurgeryRequest, isSurgeryPostOpSymptom } =
      await import('./surgeryTaxonomy');

    // The reason must be one of SURGERY's own, whatever we were handed. This is
    // the guard that keeps this queue off request_reason_id 153 — the
    // Technicians-Support medication-refill reason that 1,443 surgery tickets
    // carried until June — and off 42 as a catch-all, which is what replaced it.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? surgeryReasonById(named) : null) ??
      classifySurgeryRequest(description).classification;

    // Lead with the bucket when there is no reason id to carry the meaning.
    // A coordinator scanning a queue reads the first three words.
    const surgeryDate = str(input.surgery_date);
    const body = [
      description,
      surgeryDate ? `\n\nSurgery date given by caller: ${surgeryDate}` : '',
    ].join('');

    // Free text we send becomes the body of a patient-facing SMS on the other
    // side. One character outside GSM-7 turns the whole message from one
    // segment into three (160 chars → 70) and, worse, multi-segment long-code
    // traffic is far more exposed to US carrier A2P filtering. Measured on the
    // Support Center 2026-08-12: 1,700 of 17,446 voice tickets in 90 days
    // (9.7%) carry smart punctuation in the description.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(body);
    if (cleanDescription.changed) {
      console.info('[Surgery] description normalised to GSM-7 before filing');
    }

    const { sanitizeProviderName, sanitizeLocationName } = await import(
      '../services/ticketFieldSanitizers'
    );
    const cleanLocation = sanitizeLocationName(str(input.location)).value;
    const cleanSurgeon = sanitizeProviderName(str(input.surgeon)).value;

    const { ticketingApiClient, lookupWasUnavailable } = await import(
      '../../server/services/ticketingApiClient'
    );
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
        console.info('[surgery] date of birth taken from the verified record for this call');
      }
    }
    if (!parts) {
      return missing(
        ['date_of_birth'],
        'I did not catch that — may I please have the date of birth, starting with the month, then the day, then the year?',
      );
    }

    // Resolve office and surgeon to the ticketing app's numeric ids when we
    // have names for them.
    //
    // Unlike Optical this is NOT a gate. Optical refuses without a location
    // because location IS its assignment rule; Surgery assigns 98.5% of its
    // tickets and only 3 of the 50 unassigned in 60 days were missing one.
    // Blocking a caller who cannot name their surgery centre would cost real
    // calls to prevent a failure this queue does not have.

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    //
    // Not submit-ticket, ever. VA-50811 was filed by the OPTICAL agent through
    // that fallback, its description said "a question about my account that
    // fits no optical category", and it landed in department 8 — After Hours
    // Call Service — with assigned_to_id NULL. submit-ticket re-derives the
    // DEPARTMENT, not just the reason, and defaults to 8 when it cannot.
    //
    // create-ticket REQUIRES the (departmentId, requestTypeId, requestReasonId)
    // triple: measured twice on 2026-08-12, requestTypeId 0 is rejected and
    // omitting the fields is rejected identically. That used to mean an
    // unclassifiable request had to borrow a reason from a procedure it was not
    // about. It no longer does — request type 65, "Surgery Logistics", was
    // added to department 2 with the six measured reasons and a catch-all, so
    // `cls` is always a reason this request genuinely earned.
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
    const redirect = detectCrossQueue(description, SURGERY_DEPARTMENT_ID);
    const filedDepartmentId = redirect?.departmentId ?? SURGERY_DEPARTMENT_ID;
    /** Only THIS queue routes by surgeon; a redirect changes what may be filed. */
    const filedOnSurgeryQueue = filedDepartmentId === SURGERY_DEPARTMENT_ID;

    /**
     * HAS THIS CALL ALREADY BEEN ASKED FOR THE SURGEON?
     *
     * Unlike optical, this tool has never had a surgeon gate of its own — it
     * always files, and the refusal comes from the ticketing app, which
     * answers 400 "Missing required information: surgeon" and rejects the
     * whole ticket. `postFailureToolResult` turns that into a question the
     * agent asks the caller, so the ticketing app's refusal IS this queue's
     * ask. The counter is therefore written where that refusal is handled,
     * below, rather than at a local gate that does not exist.
     *
     * Read BEFORE this attempt can record anything, so the first pass through
     * always reads 0.
     *
     * TWO REFUSALS, NOT ONE — and the threshold is the whole design.
     *
     * A refusal is not proof the caller was asked. Traced on
     * CA101be0fe842e77fd83a6024ae06df244 (2026-09-02), whose tool_timeline
     * shows `file_surgery_ticket` refused at 15:25:24.064 and called AGAIN at
     * 15:25:25.270 — 1.2 seconds later, with an identical payload. The
     * question "And which surgeon are you seeing?" is not in that gap; it
     * comes afterwards. The model spent a retry before it asked anything.
     *
     * Timing cannot tell the two apart: over the 14 days to 2026-09-02 the
     * gap from a refusal to the next attempt has p10 15.2s / median 32.4s
     * when the caller HAD answered (the surgeon changed), and p10 14.0s /
     * median 35.3s when nothing changed. The distributions sit on top of
     * each other, so there is no floor to put a clock at.
     *
     * What the counter can do is refuse to fire on the attempt where the ask
     * usually lands. Same 14 days, 196 surgery calls took a surgeon refusal:
     *
     *   139 ended with no ticket at all      <- what this exit is for
     *    38 were rescued ON ATTEMPT 2        <- the ask worked; do not pre-empt it
     *    19 were rescued on attempt 3+
     *
     * Firing at >= 1 would take all 139, but it fires exactly where those 38
     * rescues happen, so it would file them unassigned instead of routed.
     * Firing at >= 2 takes 111 of the 139 (80%) and risks 19 rather than 38.
     * The 28 calls that hang up after a single refusal are the cost, and the
     * better trade — dept 2 provider fill has been driven from ~98% to 49%
     * once already (docs/BACKEND_HANDOFF.md).
     */
    const surgeonAskExhausted = gateRefusalsSoFar(callSid, SURGERY_FILE_TOOL, 'surgeon') >= 2;
    const filedTypeId = redirect?.requestTypeId ?? cls.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? cls.requestReasonId;
    const filedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    if (redirect) {
      console.info(
        `[surgery] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    /**
     * NEVER FILE THIS TICKET UNASSIGNED IF THE RECORD HAS ANYONE ON IT.
     *
     * OPERATOR, 2026-08-18: "every ticket that doesn't have a provider ends up
     * being a manual process that someone has to go through, go into NextGen,
     * look up, and then assign to someone. Because nobody wants to work a
     * ticket that's unassigned."
     *
     * That is the rule this ladder encodes, and it is the one I got wrong. On
     * 08-13 and 08-14 this queue filed 92 and 96 tickets with a provider on
     * every single one. What produced that was the model relaying
     * `lookup_patient`'s `last_provider` — a value that INCLUDES optometrists.
     * I then told it to stop, on the grounds that an optometrist is not a
     * surgeon. Correct about the medicine, wrong about the operation: a ticket
     * on the OD who actually saw the patient is workable, and a null is a
     * NextGen lookup and a manual assign that nobody picks up.
     *
     * So both things are true at once, in order of preference:
     *
     *   1. the surgeon the CALLER named
     *   2. the physician the record shows — upcoming first, then last seen
     *      (MD and Retina; see SURGEON_DOCTOR_TYPES)
     *   3. ANY clinician the patient actually saw, optometrist included
     *
     * Only when the record holds nobody at all does this file unassigned, and
     * then it is a fact about the patient rather than a failure of the call.
     *
     * Equipment never enters the ladder — `lastProviderSeen` already excludes
     * it, and "A-Scan" matches no provider anyway, so it would spend an attempt
     * to arrive back at null.
     *
     * THE LADDER RUNS ON THE RESULT, NOT THE ARGUMENT. Each rung is judged by
     * whether it produced a real `providerId`, so a name the model invented, or
     * one that matches nobody active, falls through to the next rung instead of
     * blocking it. That is the defect this replaces: on 2026-08-18 Susan
     * Warnholtz filed unassigned with David Choi, MD plainly on her chart,
     * because a non-empty `surgeon` argument skipped the record entirely.
     */
    const resolveWith = async (providerName?: string) =>
      cleanLocation || providerName
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
            ...(providerName ? { providerName } : {}),
          })
        : // Nothing to look up. That is a ran-and-matched-nothing, not an
          // outage — say so explicitly so `lookupWasUnavailable` cannot read
          // a bare object as a failure.
          {
            success: true,
            outcome: 'no_match' as const,
            locationId: undefined,
            providerId: undefined,
            locationMatches: [],
            error: undefined,
          };

    /**
     * THE LADDER RUNS ON A BUDGET, BECAUSE FILING BEATS ROUTING.
     *
     * Each `/lookup` is bounded at 15s and this whole tool at 30s, and `runTool`
     * RACES the handler rather than cancelling it. So three slow rungs would
     * hand the agent a retryable timeout while this handler kept going and
     * created the ticket anyway — a ticket number the caller never hears, or a
     * duplicate when the agent retries. This queue has been bitten by duplicate
     * filings before; an unassigned ticket is a manual step, a duplicate is two.
     *
     * So the rungs stop when the budget is spent, leaving the rest of the tool's
     * 30s for the create that actually files the request. Found in review,
     * 2026-08-18.
     */
    const RESOLVE_BUDGET_MS = 10_000;
    const resolveStartedAt = Date.now();
    const budgetLeft = () => Date.now() - resolveStartedAt < RESOLVE_BUDGET_MS;

    let surgeonName = cleanSurgeon;
    let surgeonSource: 'caller' | 'patient_record' | 'last_clinician' | 'none' =
      cleanSurgeon ? 'caller' : 'none';
    let lookup = await resolveWith(surgeonName || undefined);

    // Walk the patient's own record only while the ticket is still unrouted,
    // and never on a request being redirected to a queue that does not route
    // by surgeon.
    if (!lookup.providerId && !redirect && budgetLeft()) {
      try {
        const { scheduleLookupService } = await import('../services/scheduleLookupService');
        /**
         * NAME AND DATE OF BIRTH, EXACTLY — never the phone fallback.
         *
         * `lookupPatient` tries name+DOB, then PHONE, then name alone. That
         * chain is right for an agent recognising a caller and wrong here. This
         * runs precisely BECAUSE something did not resolve, and the commonest
         * reason is a mis-heard date of birth; the phone step would then match
         * whoever else that number belongs to — a spouse, an adult child, the
         * previous owner of a reassigned mobile — and `identity.unique` would
         * still be true, because it only describes the phone result. We would
         * attach that person's clinician. Found in review, 2026-08-18.
         */
        const ctx = await scheduleLookupService.lookupByNameAndDOB(
          first,
          last,
          `${parts.year}-${parts.month}-${parts.day}`,
          { logIdentifiers: false },
        );
        if (ctx.patientFound && ctx.identity?.unique !== false) {
          const rungs: Array<['patient_record' | 'last_clinician', string | undefined]> = [
            ['patient_record', ctx.lastPhysicianSeen],
            ['last_clinician', ctx.lastProviderSeen],
          ];
          for (const [source, candidate] of rungs) {
            if (!budgetLeft()) {
              console.warn('[surgery] provider ladder stopped — resolve budget spent');
              break;
            }
            const name = sanitizeProviderName(candidate ?? '').value;
            if (!name || name === surgeonName) continue;
            const attempt = await resolveWith(name);
            if (attempt.providerId) {
              lookup = attempt;
              surgeonName = name;
              surgeonSource = source;
              console.info(`[surgery] provider resolved from the patient record (${source})`);
              break;
            }
          }
        }
      } catch (error) {
        // Never let this stop a ticket. An unassigned ticket is a manual step;
        // a lost request is a patient problem.
        console.warn('[surgery] provider lookup from schedule failed:', error);
      }
    }

    /**
     * A LOOKUP THAT FAILS MUST NOT FAIL SILENTLY.
     *
     * `lookupProviderAndLocation` catches its own error and returns
     * `{success:false}` — "don't fail ticket creation if lookup fails". That is
     * the right call for the caller and the wrong one for us: it is why 66
     * unrouted tickets left no trace anywhere except the null column itself.
     *
     * AND A LOOKUP THAT NEVER RAN IS NOT A SURGEON WHO DOES NOT EXIST.
     *
     * Until 2026-09-01 both states printed this one line, so an n8n outage and
     * a surgeon we do not hold were indistinguishable in the logs as well as in
     * the return value — see `LookupOutcome` in ticketingApiClient for what the
     * 08-31 collapse cost optical. They are two different problems: one is
     * ours and transient, the other is a fact about the call.
     *
     * `lookup` is whatever the ladder finished holding. A rung that resolves a
     * provider replaces it, so 'unavailable' here means no rung got an answer —
     * the conservative reading, and the one that errs towards surfacing.
     */
    const surgeonUnresolved = Boolean(surgeonName) && !lookup.providerId;
    const lookupUnavailable = lookupWasUnavailable(lookup);
    if (surgeonUnresolved) {
      console.error(
        lookupUnavailable
          ? // Distinctive on purpose: this string is how an outage is found
            // afterwards, and it must not collide with the line below.
            `[surgery] ✗ SURGEON LOOKUP UNAVAILABLE — filing '${surgeonName}' UNROUTED. ` +
              `Dept 2 routes by surgeon, so this ticket needs manual assignment. ` +
              `Cause: ${lookup.error ?? 'unknown'}`
          : `[surgery] ✗ SURGEON DID NOT RESOLVE — ticket will file unrouted (dept 2 routes by surgeon)`,
      );
    }
    /**
     * The outage cost us the routing field on the queue that routes by it —
     * and only on that queue. A request `detectCrossQueue` sent to Optical or
     * the HVA Hub deliberately carries no surgeon (see the payload below), so
     * raising its priority over a surgeon it was never going to have would be
     * noise in someone else's queue view.
     */
    const unroutedByOutage = filedOnSurgeryQueue && surgeonUnresolved && lookupUnavailable;

    const urgent = str(input.urgent).toLowerCase() === 'true' || cls?.urgent === true;

    /**
     * A POST-OPERATIVE SYMPTOM sits between the two priorities we had.
     *
     * On the queue's first live day this arrived and filed at medium:
     * "I had cataract surgery on my right eye, but it feels like there's
     * something stuck in my eye and I need to see the doctor." Surgery flagged
     * 0 of 32 tickets that day at any raised priority; tech flagged 18 of 57.
     *
     * It is NOT `urgent` — that flag tells the caller to seek emergency care or
     * dial 911, which is right for a detaching retina and wrong for a gritty
     * eye after a cataract operation. It is not routine either.
     *
     * Computed from the caller's own words rather than trusted from the model,
     * because the model is the thing that called it routine.
     */
    const postOpSymptom = !urgent && isSurgeryPostOpSymptom(description);
    /**
     * AND THE THIRD REASON TO RAISE IT: the outage, not the request.
     *
     * When the resolve never ran, the caller named their surgeon correctly and
     * we lost it — so the ticket lands on the queue that routes by surgeon with
     * nothing to route on, indistinguishable in a queue view from one whose
     * patient genuinely has no physician on file. Optical raises priority for
     * exactly this reason and it is the only signal available: there is no
     * staff-notes field on `CreateTicketParams`, and the description is a
     * patient-facing SMS body (docs/BACKEND_HANDOFF.md lists annotating it
     * under changes that made things worse).
     *
     * Never above `urgent`, and never for a name the lookup ran and rejected —
     * a raise that fires on every unresolved surgeon would mean nothing.
     */
    const priority = urgent ? 'urgent' : postOpSymptom || unroutedByOutage ? 'high' : 'medium';

    /**
     * THE UNROUTED TICKET SAYS NOTHING TO THE PATIENT.
     *
     * There was an annotation here — "NO SURGEON ON THIS TICKET ... please
     * assign one before working it" — appended to `description`. Three lines
     * above, this file documents what `description` is: "Free text we send
     * becomes the body of a patient-facing SMS on the other side."
     *
     * So every unrouted ticket texted a patient an internal routing
     * instruction, and told them their record shows no physician. Written by me,
     * caught in review 2026-08-18, never shipped.
     *
     * There is nowhere else to put it. `CreateTicketParams` carries no
     * staff-only field — `unresolvedInfo` belongs to a different tool
     * (createTicketTool) and never reaches this payload. So the note is gone,
     * and the signal a coordinator actually works from is the one that was
     * always there: `provider_id` is null, and the ticket shows as unassigned.
     * The failure is also logged at error, above.
     *
     * A staff-notes field is the second ask in the ticketing change request.
     */
    /**
     * DEPLOY MARKER, and a live counter. Prints only when this call has
     * already been asked for the surgeon and still has none — the exact
     * population that used to end with no ticket. Absent from the logs, the
     * exit is not deployed and any conclusion drawn from a call is worthless
     * (CLAUDE.md, "How to tell whether a deploy actually took").
     */
    if (filedOnSurgeryQueue && surgeonAskExhausted && !lookup.providerId) {
      console.warn(
        '[surgery] SURGEON ASK ALREADY SPENT — filing UNASSIGNED rather than ' +
          'refusing a second time (operator ruling 2026-09-02). ' +
          `Caller said: ${surgeonName ? `"${surgeonName}"` : '(no surgeon given)'}`,
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
      patientBirthMonth: parts.month,
      patientBirthDay: parts.day,
      patientBirthYear: parts.year,
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      /**
       * THE SURGEON GOES ONLY ON A SURGERY TICKET.
       *
       * `detectCrossQueue` can file this call into Optical or the HVA Hub, and
       * those queues do not route by surgeon. Attaching the patient's operating
       * physician to a department-9 scheduling ticket assigns it to someone with
       * no part in that request. The note below was already gated; the fields
       * themselves were not. Found in review, 2026-08-18.
       */
      ...(filedOnSurgeryQueue && lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(filedOnSurgeryQueue && surgeonName ? { lastProviderSeen: surgeonName } : {}),
      /**
       * TAKE THE REQUEST RATHER THAN LOSE IT — operator ruling, 2026-09-02,
       * extending to surgery the exit optical already had for its own bounded
       * ask ("if you gate the location, the agent will ask and if no answer,
       * unassigned", 2026-09-01).
       *
       * The ticketing app refuses a department-2 ticket with no resolvable
       * surgeon. That refusal is a question the first time — the agent asks
       * the caller who their surgeon is and refiles. The SECOND time there is
       * nothing left to ask: the call ends and the request is gone. On
       * 2026-09-02 two of the six lost surgery requests died exactly there —
       * one caller had no provider anywhere on their record, the other named
       * a surgeon absent from the providers table entirely.
       *
       * So on a re-attempt this tells the app the ask has been spent, and it
       * files the ticket UNASSIGNED into department 2 with an advisory on the
       * audit trail instead of refusing again.
       *
       * THREE GUARDS, all load-bearing:
       *  - `surgeonAskExhausted` comes from the per-call refusal counter,
       *    which is keyed on a REAL CallSid — never from a model argument.
       *    Sent unconditionally this would switch the app's gate off, and
       *    department 2's provider fill has already been driven from ~98% to
       *    49% once by changes that looked smaller than this one.
       *  - `!lookup.providerId`, so a ticket that DID resolve a surgeon never
       *    claims to need manual routing.
       *  - `filedOnSurgeryQueue`, because a request `detectCrossQueue` sent to
       *    Optical or the HVA Hub is not gated on a surgeon at all.
       */
      ...(filedOnSurgeryQueue && surgeonAskExhausted && !lookup.providerId
        ? { routingAskExhausted: true }
        : {}),
      description: filedDescription,
      priority,
      callData: { agentUsed: 'surgery', ...(callSid ? { callSid } : {}) },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
    });

    if (!res.success || !res.ticketNumber) {
      // The POST failed. createTicketDurable has already put the payload in the
      // outbox if it could; this only decides what the agent says about it.
      //
      // A terminal refusal naming the surgeon is this queue's ASK: the line
      // below turns it into a question the agent puts to the caller. Count it,
      // so a second trip through here carries routingAskExhausted and the app
      // takes the request unassigned instead of refusing it again. Counted
      // only for the surgeon — a refusal for any other field has not asked
      // this question and must not spend it.
      if (res.terminal && res.missingField === 'surgeon') {
        noteGateRefusal(callSid, SURGERY_FILE_TOOL, 'surgeon');
      }
      return postFailureToolResult(res, 'file_surgery_ticket');
    }

    return {
      success: true,
      ticket_number: res.ticketNumber,
      // REPORT WHAT WAS FILED, not what the home queue classified it as.
      //
      // These used to report `cls`, the home-queue classification, even when
      // the ticket had been redirected. A live curl on 2026-08-13 filed "my
      // glasses broke at the hinge" into Optical and reported reason 542 —
      // department 3's catch-all, which is not on the ticket and not the
      // department's. The number the agent reads back has to be the number a
      // person will find.
      request_reason: redirect ? redirect.requestReason : cls.requestReason,
      request_reason_id: filedReasonId,
      priority,
      location_id: lookup.locationId ?? null,
      /**
       * REPORT WHAT WAS FILED, not what resolved.
       *
       * A redirected ticket deliberately carries no surgeon (the receiving queue
       * does not route by one), but the result used to report the provider that
       * had resolved anyway — so timelines and replays would show a redirected
       * ticket as assigned to a surgeon it never carried. Review, 2026-08-18.
       */
      provider_id: filedOnSurgeryQueue ? lookup.providerId ?? null : null,
      // Where the surgeon came from, so a replay can tell "the caller named
      // them" apart from "we read it off the chart" without guessing.
      surgeon_source: filedOnSurgeryQueue ? surgeonSource : 'none',
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
