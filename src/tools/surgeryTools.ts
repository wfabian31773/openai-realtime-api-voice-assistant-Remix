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
import { str } from './sharedPatientTools';

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
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'Can I get the first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'And the last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format.', askAs: 'And the date of birth?' },
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
    required: ['first_name', 'last_name', 'date_of_birth', 'callback_number', 'request_description'],
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

    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const { normalizeDobParts } = await import('./dobParts');
    const parts = normalizeDobParts(dob);
    if (!parts) {
      return missing(['date_of_birth'], 'I did not catch that date of birth — month, day and year?');
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
     * THE SURGEON IS RESOLVED FROM THE RECORD, NOT FROM THE ARGUMENT LIST.
     *
     * This queue is assigned BY SURGEON. A ticket without one reaches nobody —
     * it sits on a coordinator with no routing rule and no way to know whether
     * the question was even asked.
     *
     * The provider was never coming from the caller. Measured over three days
     * of transcripts, the agent asked "who is your surgeon" on 2 of 104 calls
     * (08-13) and 2 of 126 (08-14) — and BOTH those days filed a provider on
     * essentially every ticket. It came from `lookup_patient`'s `last_provider`,
     * relayed by the model as `surgeon`. So the field only ever worked while the
     * model happened to pass along a value it was never told to collect.
     *
     * On 08-17 it stopped passing it, and 66 of 74 tickets filed unrouted. The
     * signature is `surgeryTools.ts` skipping the lookup ENTIRELY when neither
     * name is supplied — which is why provider and location went null together
     * on the same tickets (Gail Herrick: provider 51 / location 22 on 08-14,
     * both NULL on 08-17, same patient, same code).
     *
     * A field this queue cannot route without must not depend on whether a
     * model chose to include an optional argument. So: ask the schedule
     * directly. `lastPhysicianSeen` is the same rule that reproduced the
     * system's own historical assignments when the 08-17 tickets were
     * backfilled — Vincent Medina resolved to 49, which is exactly what the
     * pipeline had assigned him on 08-14.
     *
     * The model's answer still WINS when it has one: a caller who names their
     * surgeon is better evidence than the last chart entry.
     */
    let surgeonName = cleanSurgeon;
    let surgeonFromRecord = false;
    if (!surgeonName && !redirect) {
      try {
        const { scheduleLookupService } = await import('../services/scheduleLookupService');
        /**
         * NAME AND DATE OF BIRTH, EXACTLY — never the phone fallback.
         *
         * `lookupPatient` tries name+DOB, then PHONE, then name alone. That
         * chain is right for an agent trying to recognise a caller and wrong
         * here. This code runs precisely BECAUSE something did not resolve, and
         * the commonest reason is a mis-heard date of birth; the phone step
         * would then match whoever else that number belongs to — a spouse, an
         * adult child, the previous owner of a reassigned mobile — and
         * `identity.unique` would be true, because it only describes the phone
         * result. We would attach that person's surgeon and route the ticket to
         * them. A confidently wrong surgeon is worse than a null one: the null
         * shows up as unassigned, the wrong one looks handled.
         *
         * So: the exact lookup only. Found in review, 2026-08-18.
         */
        const ctx = await scheduleLookupService.lookupByNameAndDOB(
          first,
          last,
          `${parts.year}-${parts.month}-${parts.day}`,
          { logIdentifiers: false },
        );
        // And only when it resolved to ONE person — a name and date of birth
        // can still carry twins or a junior.
        if (ctx.patientFound && ctx.identity?.unique !== false && ctx.lastPhysicianSeen) {
          surgeonName = sanitizeProviderName(ctx.lastPhysicianSeen).value;
          surgeonFromRecord = true;
          console.info('[surgery] surgeon resolved from the patient record');
        }
      } catch (error) {
        // Never let this stop a ticket. A missing surgeon is a routing problem;
        // a lost request is a patient problem.
        console.warn('[surgery] surgeon lookup from schedule failed:', error);
      }
    }

    const lookup =
      cleanLocation || surgeonName
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
            ...(surgeonName ? { providerName: surgeonName } : {}),
          })
        : { locationId: undefined, providerId: undefined, locationMatches: [] };

    /**
     * A LOOKUP THAT FAILS MUST NOT FAIL SILENTLY.
     *
     * `lookupProviderAndLocation` catches its own error and returns
     * `{success:false}` — "don't fail ticket creation if lookup fails". That is
     * the right call for the caller and the wrong one for us: it is why 66
     * unrouted tickets left no trace anywhere except the null column itself.
     */
    if (surgeonName && !lookup.providerId) {
      console.error(
        `[surgery] ✗ SURGEON DID NOT RESOLVE — ticket will file unrouted (dept 2 routes by surgeon)`,
      );
    }

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
    const priority = urgent ? 'urgent' : postOpSymptom ? 'high' : 'medium';

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
    const res = await ticketingApiClient.createTicket({
      departmentId: filedDepartmentId,
      requestTypeId: filedTypeId,
      requestReasonId: filedReasonId,
      patientFirstName: first,
      patientLastName: last,
      patientPhone: phone,
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
      ...(filedDepartmentId === SURGERY_DEPARTMENT_ID && lookup.providerId
        ? { providerId: lookup.providerId }
        : {}),
      ...(filedDepartmentId === SURGERY_DEPARTMENT_ID && surgeonName
        ? { lastProviderSeen: surgeonName }
        : {}),
      description: filedDescription,
      priority,
      callData: { agentUsed: 'surgery', ...(callSid ? { callSid } : {}) },
    });

    if (!res.success || !res.ticketNumber) {
      return {
        success: false,
        error: res.error ?? 'ticket creation failed',
        retryable: true,
      };
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
      provider_id: lookup.providerId ?? null,
      // Where the surgeon came from, so a replay can tell "the caller named
      // them" apart from "we read it off the chart" without guessing.
      surgeon_source: surgeonName ? (surgeonFromRecord ? 'patient_record' : 'caller') : 'none',
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
