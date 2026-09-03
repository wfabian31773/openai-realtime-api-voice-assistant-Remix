/**
 * The tools a Medical Records agent needs, and nothing else.
 *
 * WHAT IS DIFFERENT FROM THE OTHER QUEUES
 *
 *   Optical hard-requires a LOCATION, because one optician per office is the
 *   assignment rule. Tech Support asks for the PRESCRIBER, because somebody has
 *   to sign a prescription. Medical Records turns on two different facts:
 *
 *     WHO IS ASKING     a patient, a clinic, a health plan, an attorney
 *     WHERE IT GOES     a fax number, an office, an address, or the patient
 *
 *   Those two decide the paperwork, and both are routinely lost between the
 *   call and the ticket. Neither is a gate — a records request that arrives
 *   needing a callback is recoverable; a caller turned away is not.
 *
 * WHAT THIS AGENT MUST NOT DO
 *
 *   Release of records requires a signed authorization. Staff say so inside
 *   these tickets — "Please advise the patient that a signed Auth for Release
 *   of Medical Records is required". The agent takes the request and says the
 *   records team will follow up with what is needed. It does NOT quote the
 *   requirement as procedure, does not promise anything will be sent by any
 *   date, and never reads a record back to anyone.
 *
 *   OPEN QUESTION FOR THE OPERATOR, deliberately not invented here: should the
 *   agent proactively tell a caller an authorization form is coming? The
 *   ticket text shows staff doing it, which is evidence of practice but not an
 *   instruction to an agent.
 *
 * NO HANDOFF. Operator ruling 2026-08-12: only PCP and Scheduling transfer.
 */
import { registerTool, missing, type ToolResult } from './registry';
import { str, isTwilioCallSid, normalizePhone } from './sharedPatientTools';
import { createTicketDurable, postFailureToolResult } from '../services/durableTicketFiling';

// ---------------------------------------------------------------- what kind

registerTool({
  name: 'classify_records_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    "Work out which kind of records request this is, in the practice's own " +
    "categories. Call it with the caller's own words once you understand what they " +
    'need, and before filing. It knows the difference between a copy for the ' +
    'patient, records going to another doctor, records for a health plan or an ' +
    'attorney, a letter or form, and an in-person review — so it always returns ' +
    'something. Pass its request_reason_id to file_records_ticket.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description:
          "What the caller wants, in their words. e.g. 'I need my records from " +
          "the July visit faxed to Dr. Warn's office'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifyRecordsRequest, MEDICAL_RECORDS_DEPARTMENT_ID } = await import(
      './medicalRecordsTaxonomy'
    );
    const description = str(input.request_description);
    const { classification, isCatchAll } = classifyRecordsRequest(description);
    const { rememberQueueCall } = await import('../services/queueCallState');
    rememberQueueCall(str(input.call_sid), {
      agentSlug: 'records',
      requestDescription: description,
      departmentId: MEDICAL_RECORDS_DEPARTMENT_ID,
      requestTypeId: classification.requestTypeId,
      requestReasonId: classification.requestReasonId,
    });

    return {
      success: true,
      classified: !isCatchAll,
      department_id: MEDICAL_RECORDS_DEPARTMENT_ID,
      request_type: classification.requestType,
      request_type_id: classification.requestTypeId,
      request_reason: classification.requestReason,
      request_reason_id: classification.requestReasonId,
      ...(isCatchAll
        ? {
            message:
              'Nothing matched, so this is filed as "Other - See Description". That is a ' +
              'real category, not a guess — but it means the description is the only thing ' +
              'the team has. Make sure it says what they actually asked for, and who is ' +
              'asking.',
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_records_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the request for the medical records team. This is the last step of the ' +
    "call. It needs the patient's name, date of birth and a callback number. Also " +
    'get WHO IS ASKING (the patient themselves, another doctor\'s office, a health ' +
    'plan, an attorney) and WHERE IT SHOULD GO (a fax number, an office, or to the ' +
    'patient) — those two decide what paperwork the team needs. Pass the ' +
    'request_reason_id from classify_records_request.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'Can I get the patient\'s first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'And the last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format.', askAs: 'And the date of birth?' },
      callback_number: { type: 'string', description: 'Best number to reach the caller.', askAs: 'What is the best number to reach you?' },
      request_description: { type: 'string', description: 'What they need, in their words.', askAs: 'What records do you need?' },
      request_reason_id: { type: 'string', description: 'From classify_records_request.' },
      requester: {
        type: 'string',
        description:
          'REQUIRED. Who is asking, in their own words — the patient themselves, a ' +
          'relative or someone with power of attorney, another doctor\'s office, a health ' +
          'plan, an attorney or records company. Include the organisation name when there ' +
          'is one. This decides whether a statutory records clock applies, so it cannot ' +
          'be guessed or left out.',
        askAs: 'And just so I route this correctly — are you the patient yourself, or calling on someone\'s behalf?',
      },
      deliver_to: {
        type: 'string',
        description: 'Where it should go: a fax number, an office and city, an address, or "to the patient".',
        askAs: 'Where should these be sent?',
      },
      date_range: {
        type: 'string',
        description: 'Which visits or dates they need, if they said.',
        askAs: 'Which dates do you need covered?',
      },
      location: { type: 'string', description: 'The office they attend, if it came up.' },
      provider: { type: 'string', description: 'The doctor they saw, if it came up.' },
      email: { type: 'string', description: 'Optional — looked up if omitted.' },
      call_sid: { type: 'string', description: 'The call id, so a retry cannot double-file.' },
      caller_phone: { type: 'string', description: 'The number they called from.' },
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
    required: ['first_name', 'last_name', 'callback_number', 'request_description', 'requester'],
  },
  handler: async (input): Promise<ToolResult> => {
    const first = str(input.first_name);
    const last = str(input.last_name);
    const dob = str(input.date_of_birth);
    const phone = str(input.callback_number);
    const description = str(input.request_description);
    const callSid = str(input.call_sid);
    {
      const { rememberQueueCall } = await import('../services/queueCallState');
      rememberQueueCall(callSid, {
        agentSlug: 'records',
        firstName: first,
        lastName: last,
        callbackNumber: phone,
        requestDescription: description,
        verifiedLocation: str(input.location) || undefined,
        lastProvider: str(input.provider) || undefined,
      });
    }

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

    const { MEDICAL_RECORDS_DEPARTMENT_ID, recordsReasonById, classifyRecordsRequest,
            classifyRequester, determineCapClock } = await import('./medicalRecordsTaxonomy');

    // WHO IS ASKING IS HARD-REQUIRED ON THIS QUEUE, the way LOCATION is on
    // Optical — and for a stronger reason than assignment.
    //
    // Azul Vision is under a Corrective Action Plan with HHS OCR over late
    // medical records. A PATIENT's request runs on a statutory clock the
    // practice must report on; a health plan's or an attorney's does not.
    // Measured 2026-08-13: all 470 mr_cases rows are pathway 'roa_patient',
    // 421 of them minted by the voice agent, and NOT ONE has a requestor
    // captured. At least 77 are demonstrably third-party. Nothing downstream
    // can reconstruct this after the call ends, so the call is the only place
    // it can be got.
    const requesterRaw = str(input.requester);
    if (!requesterRaw) {
      return missing(
        ['requester'],
        'And just so I route this correctly — are you the patient yourself, or calling on someone\'s behalf?',
      );
    }
    const requesterType = classifyRequester(requesterRaw) ?? 'other';
    const cap = determineCapClock(requesterType);

    // ON THE CLOCK MEANS THE FIELDS ARE NOT OPTIONAL.
    //
    // Operator, 2026-08-13: "can we hard gate the records to require the
    // appropriate fields". For a patient right-of-access request the practice
    // must report on timing under the CAP, and an `mr_cases` row is built from
    // exactly these: what records, over what dates, delivered how. A case
    // opened without them starts a statutory clock that nobody can actually
    // work, which is the worst of both.
    //
    // GATED ONLY WHEN THE CLOCK APPLIES. A health plan or an attorney asking
    // for a chart is not on the clock, and refusing their request over a
    // missing date range would turn a reporting requirement into a reason to
    // turn callers away — the thing this queue exists not to do.
    //
    // The gate is on PRESENCE, not content. "All of it" and "I'm not sure" are
    // both valid answers; the agent asks once, the caller says something, it
    // files. What is not acceptable is silence in a column the CAP report reads.
    if (cap.onClock) {
      const gaps: string[] = [];
      if (!str(input.deliver_to)) gaps.push('deliver_to');
      if (!str(input.date_range)) gaps.push('date_range');
      if (gaps.length) {
        return missing(
          gaps,
          gaps.length === 2
            ? 'Two quick things so the records team can start on this — where should these be sent, and which dates do you need covered?'
            : gaps[0] === 'deliver_to'
              ? 'And where should these be sent — to you, or to an office?'
              : 'And which dates do you need covered? "Everything" is a fine answer.',
        );
      }
    }

    // The reason must be one of THIS department's, whatever we were handed.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? recordsReasonById(named) : null) ??
      classifyRecordsRequest(description).classification;

    // Who is asking and where it goes are the two facts this queue turns on.
    // On their own lines so a records clerk reads them rather than hunting
    // through a paragraph for a fax number.
    const deliverTo = str(input.deliver_to);
    const dateRange = str(input.date_range);
    // The clock line goes FIRST. A records clerk opening this ticket should not
    // have to read to the bottom to learn whether it is CAP-reportable.
    const body = [
      `${cap.note}`,
      `\n\n${description}`,
      `\n\nRequested by: ${requesterRaw} [${requesterType}]`,
      deliverTo ? `\nSend to: ${deliverTo}` : '',
      dateRange ? `\nDates needed: ${dateRange}` : '',
    ].join('');

    // Free text becomes the body of a patient-facing SMS on the other side. One
    // character outside GSM-7 turns a 160-character segment into 70 and makes
    // the message far more exposed to US carrier A2P filtering.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(body);
    if (cleanDescription.changed) {
      console.info('[Records] description normalised to GSM-7 before filing');
    }

    const { sanitizeProviderName, sanitizeLocationName } = await import(
      '../services/ticketFieldSanitizers'
    );
    const cleanProvider = sanitizeProviderName(str(input.provider)).value;
    const cleanLocation = sanitizeLocationName(str(input.location)).value;

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
        console.info('[records] date of birth taken from the verified record for this call');
      }
    }
    if (!parts) {
      return missing(['date_of_birth'], 'I did not catch that date of birth — month, day and year?');
    }

    const lookup =
      cleanProvider || cleanLocation
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanProvider ? { providerName: cleanProvider } : {}),
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
          })
        : // Nothing to look up. That is a ran-and-matched-nothing, not an
          // outage — say so explicitly so `lookupWasUnavailable` cannot read
          // a bare object as a failure.
          {
            success: true,
            outcome: 'no_match' as const,
            providerId: undefined,
            locationId: undefined,
            locationMatches: [],
            error: undefined,
          };

    /**
     * A LOOKUP THAT NEVER RAN IS NOT AN OFFICE THAT DOES NOT EXIST.
     *
     * `lookupProviderAndLocation` used to catch its own error and answer
     * `{success:false}` — the same shape as a name that matched nobody. Optical
     * read only `locationId`, collapsed the two, and on 2026-08-31 told 43
     * callers their real office did not exist; see `LookupOutcome` in
     * ticketingApiClient. This queue said nothing at all, which on a department
     * under a Corrective Action Plan with HHS OCR is its own problem: the
     * office and doctor a caller named were dropped, and the ticket looks
     * exactly like one where they were never asked.
     *
     * Nothing here refuses. Neither field is a gate on this queue — the module
     * header says so, and a records request that arrives needing a callback is
     * recoverable where a refused caller is not. What changes is that the loss
     * is visible: the caller's words still travel in `locationOfLastVisit` /
     * `lastProviderSeen`, the ids are omitted rather than sent null, this logs
     * loudly, and the priority is raised so the ticket is not filed away as
     * routine with a hole in it.
     *
     * NOT in the description. It carries the CAP clock line and the caller's
     * own words, and it becomes the body of a patient-facing SMS —
     * `docs/BACKEND_HANDOFF.md` lists annotating it under changes that made
     * things worse. There is no staff-notes field on `CreateTicketParams`.
     */
    const lookupUnavailable = lookupWasUnavailable(lookup);
    const lostToOutage =
      lookupUnavailable &&
      ((Boolean(cleanLocation) && !lookup.locationId) ||
        (Boolean(cleanProvider) && !lookup.providerId));
    if (lostToOutage) {
      console.error(
        `[records] ✗ LOOKUP UNAVAILABLE — filing ` +
          `'${cleanLocation || cleanProvider}' with no id. Cause: ${lookup.error ?? 'unknown'}`,
      );
    }

    // A CALLER WHO PRESSED THE WRONG OPTION IS NOT SENT AWAY.
    //
    // On this line the detector mostly stays quiet on purpose: a records
    // request names other departments' subjects constantly ("the notes from my
    // cataract surgery"), and queueRouting holds those here. What it still
    // catches is the genuinely different request — someone who reached records
    // and wants an appointment.
    const { detectCrossQueue } = await import('./queueRouting');
    const redirect = detectCrossQueue(description, MEDICAL_RECORDS_DEPARTMENT_ID);
    const filedDepartmentId = redirect?.departmentId ?? MEDICAL_RECORDS_DEPARTMENT_ID;
    const filedTypeId = redirect?.requestTypeId ?? cls.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? cls.requestReasonId;
    const filedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    if (redirect) {
      console.info(
        `[records] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    // Never submit-ticket: it re-derives the DEPARTMENT server-side and
    // defaults to 8.
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
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: filedDescription,
      // Raised only when an outage cost us an id we had the name for — never
      // for a name the lookup ran and rejected, which is an ordinary fact
      // about the call. See the block above the lookup for why this is the
      // signal rather than a note in the text.
      priority: lostToOutage ? 'high' : 'medium',
      // Structured, so the ticketing app can stop defaulting mr_cases to
      // 'roa_patient'. Extra fields are ignored by an endpoint that does not
      // read them yet, which is why they are safe to send today — but the
      // ticketing app is the half that has to change for the clock to be right.
      requestorType: cap.requesterType,
      requestPathway: cap.pathway,
      capClockApplies: cap.onClock,
      // A NAME, not a description. The ticketing agent, 2026-08-13: "Send
      // requestorName even when the requester is the patient. Zero of 470 rows
      // carry one. The name is the evidence that a classification was made;
      // without it an audit cannot tell 'confirmed patient' from 'defaulted to
      // patient', which is the hole we are climbing out of."
      //
      // "I am the patient" is not evidence of anything. When the requester IS
      // the patient the name is theirs; otherwise it is whatever they said,
      // which is where the organisation usually sits ("SCAN Health Plan",
      // "an attorney at Lexitas").
      requestorName:
        cap.requesterType === 'patient' ? `${first} ${last}`.trim() : requesterRaw,
      callData: { agentUsed: 'records', ...(callSid ? { callSid } : {}) },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
    });

    if (!res.success || !res.ticketNumber) {
      if (res.queued) {
        const { rememberQueueCall } = await import('../services/queueCallState');
        rememberQueueCall(callSid, { filedPending: true });
      }
      return postFailureToolResult(res, 'file_records_ticket');
    }
    {
      const { rememberQueueCall } = await import('../services/queueCallState');
      rememberQueueCall(callSid, { filedTicketNumber: res.ticketNumber });
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
      // Say plainly what is missing, so the agent can still ask before the call
      // ends rather than a clerk chasing it tomorrow.
      requester_type: cap.requesterType,
      cap_clock_applies: cap.onClock,
      ...(deliverTo ? {} : { note_destination: 'No destination captured — ask where these should be sent.' }),
      ...(redirect
        ? { routed_to: redirect.departmentName, routed_department_id: redirect.departmentId }
        : {}),
      message: redirect
        ? `Filed as ${res.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
        : `Filed as ${res.ticketNumber}. Read the ticket number back to the caller. Do not promise a date or say the records have been sent.`,
    };
  },
});
