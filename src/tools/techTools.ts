/**
 * The tools a Clinical Tech Support agent needs, and nothing else.
 *
 * This is the practice's largest queue — 9,288 tickets in 90 days, 103 a day —
 * and it is the medication queue: refills, glaucoma drops, prior
 * authorizations, pharmacy problems, and the paperwork around them.
 *
 * WHAT IS DIFFERENT FROM THE OTHER TWO QUEUES
 *
 *   Optical hard-requires a LOCATION, because one optician per office IS the
 *   assignment rule. Surgery attaches one when it can and never blocks on it.
 *   Tech Support is different again: a medication request is actionable without
 *   an office, but almost never without a PROVIDER — somebody has to sign the
 *   prescription. The live evidence is already in the data: descriptions
 *   carrying "NEEDS HUMAN REVIEW — could not complete on the call. Missing:
 *   provider name or doctor" are the answering service's own hard-require
 *   firing, and it is the right instinct.
 *
 *   So this tool ASKS for the prescriber and files without one rather than
 *   refusing — a refill request that reaches the queue late is recoverable, and
 *   a caller turned away because they cannot name their doctor is not.
 *
 * THE PHARMACY IS THE OTHER HALF OF A REFILL. A refill with no pharmacy is a
 * task somebody has to ring back about, so it is collected and passed through,
 * but it is likewise not a gate.
 *
 * NO HANDOFF. Operator ruling 2026-08-12: only PCP and Scheduling transfer.
 */
import { registerTool, missing, type ToolResult } from './registry';
import { str, isTwilioCallSid, normalizePhone } from './sharedPatientTools';
import { createTicketDurable, postFailureToolResult } from '../services/durableTicketFiling';

// ---------------------------------------------------------------- what kind

registerTool({
  name: 'classify_tech_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    "Work out which kind of request this is, in the practice's own categories. " +
    "Call it with the caller's own words once you understand what they need, and " +
    'before filing. It knows the medication categories — glaucoma drops, post-surgery ' +
    'drops, refills, prior authorizations, pharmacy transfers — as well as records, ' +
    'forms and referrals, so it always returns something. Pass its request_reason_id ' +
    'to file_tech_ticket.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description:
          "What the caller wants, in their words. e.g. 'I need a refill of my " +
          "Latanoprost sent to the CVS on Foothill'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifyTechRequest, TECH_DEPARTMENT_ID } = await import('./techTaxonomy');
    const { classification, isCatchAll } = classifyTechRequest(str(input.request_description));

    return {
      success: true,
      classified: !isCatchAll,
      department_id: TECH_DEPARTMENT_ID,
      request_type: classification.requestType,
      request_type_id: classification.requestTypeId,
      request_reason: classification.requestReason,
      request_reason_id: classification.requestReasonId,
      ...(isCatchAll
        ? {
            message:
              'Nothing matched, so this is filed as "Other - See Description". That is a ' +
              'real category, not a guess — but it means the description is the only thing ' +
              'the team has. Make sure it says what they actually asked for.',
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_tech_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the request for the clinical tech support team. This is the last step of ' +
    "the call. It needs the patient's name, date of birth and a callback number. For " +
    'a medication request also get the PRESCRIBING DOCTOR and the PHARMACY — a refill ' +
    'without a prescriber is one somebody has to ring back about. Pass the ' +
    'request_reason_id from classify_tech_request.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'Can I get the first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'And the last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format.', askAs: 'And the date of birth?' },
      callback_number: { type: 'string', description: 'Best number to reach them.', askAs: 'What is the best number to reach you?' },
      request_description: { type: 'string', description: 'What they need, in their words.', askAs: 'What can we help you with?' },
      request_reason_id: { type: 'string', description: 'From classify_tech_request.' },
      medication: { type: 'string', description: 'The medication by name, if they gave one.', askAs: 'Which medication is it?' },
      pharmacy: { type: 'string', description: 'Pharmacy name and cross-street or city.', askAs: 'Which pharmacy should it go to?' },
      provider: { type: 'string', description: 'The prescribing doctor.', askAs: 'Which doctor prescribed it?' },
      location: { type: 'string', description: 'The office they attend, if it came up.' },
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

    const { TECH_DEPARTMENT_ID, techReasonById, classifyTechRequest } = await import('./techTaxonomy');

    // The reason must be one of THIS department's, whatever we were handed.
    // Department 3 is where reason 153 actually belongs, so the guard here is
    // not about keeping 153 out — it is about keeping Optical's and Surgery's
    // reasons out, and about never inventing one.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? techReasonById(named) : null) ??
      classifyTechRequest(description).classification;

    // The medication and the pharmacy are the two facts a refill cannot be
    // worked without, and both are routinely lost between the call and the
    // ticket. Putting them on their own lines means a technician reads them
    // rather than hunting for them in a paragraph.
    const medication = str(input.medication);
    const pharmacy = str(input.pharmacy);
    const body = [
      description,
      medication ? `\n\nMedication: ${medication}` : '',
      pharmacy ? `\nPharmacy: ${pharmacy}` : '',
    ].join('');

    // Free text becomes the body of a patient-facing SMS on the other side. One
    // character outside GSM-7 turns a 160-character segment into 70 and makes
    // the message far more exposed to US carrier A2P filtering.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(body);
    if (cleanDescription.changed) {
      console.info('[Tech] description normalised to GSM-7 before filing');
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
        console.info('[tech] date of birth taken from the verified record for this call');
      }
    }
    if (!parts) {
      return missing(['date_of_birth'], 'I did not catch that date of birth — month, day and year?');
    }

    // Resolve the prescriber and office to ids when we have names. Not a gate:
    // this queue's own hard-require lives in the ticketing app, and a refill
    // that arrives without a resolved provider is recoverable in a way a
    // refused call is not.
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
     * A LOOKUP THAT NEVER RAN IS NOT A PRESCRIBER WHO DOES NOT EXIST.
     *
     * `lookupProviderAndLocation` used to catch its own error and answer
     * `{success:false}` — the same shape as a name that matched nobody. Optical
     * read only `locationId`, collapsed the two, and on 2026-08-31 told 43
     * callers their real office did not exist; see `LookupOutcome` in
     * ticketingApiClient. This queue never told anyone anything, which is its
     * own failure: a prescriber the caller named correctly went in the bin with
     * no trace, on the queue that files 103 tickets a day and cannot work a
     * refill without somebody to sign it.
     *
     * Nothing here refuses. The module header is explicit that the prescriber
     * is not a gate, and a caller sent away because they cannot name their
     * doctor is not recoverable. So the request is taken exactly as before, and
     * what changes is that the loss is visible: the caller's words still travel
     * in `lastProviderSeen` / `locationOfLastVisit`, the ids are omitted rather
     * than sent null, this logs loudly, and the priority is raised so a
     * technician sees a ticket that needs a name resolved.
     *
     * NOT in the description — that becomes the body of a patient-facing SMS,
     * and `docs/BACKEND_HANDOFF.md` lists annotating it under changes that made
     * things worse. There is no staff-notes field on `CreateTicketParams`.
     */
    const lookupUnavailable = lookupWasUnavailable(lookup);
    const lostToOutage =
      lookupUnavailable &&
      ((Boolean(cleanProvider) && !lookup.providerId) ||
        (Boolean(cleanLocation) && !lookup.locationId));
    if (lostToOutage) {
      console.error(
        `[tech] ✗ PROVIDER LOOKUP UNAVAILABLE — filing ` +
          `'${cleanProvider || cleanLocation}' with no id. This ticket needs manual ` +
          `assignment. Cause: ${lookup.error ?? 'unknown'}`,
      );
    }

    // Sight-preserving medication. A patient out of glaucoma drops is not a
    // routine refill: pressure rises within days and the damage does not come
    // back. The practice gave it its own reason; this gives it its own urgency.
    //
    // An outage raises it too, for the reason above — never for a name the
    // lookup ran and rejected, which is an ordinary fact about the call.
    const priority = cls.requestReasonId === 155 || lostToOutage ? 'high' : 'medium';

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    // Never submit-ticket: it re-derives the DEPARTMENT server-side and
    // defaults to 8, which is how VA-50811 reached nobody.
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
    const redirect = detectCrossQueue(description, TECH_DEPARTMENT_ID);
    const filedDepartmentId = redirect?.departmentId ?? TECH_DEPARTMENT_ID;
    const filedTypeId = redirect?.requestTypeId ?? cls.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? cls.requestReasonId;
    const filedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    if (redirect) {
      console.info(
        `[tech] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
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
      patientBirthMonth: parts.month,
      patientBirthDay: parts.day,
      patientBirthYear: parts.year,
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: filedDescription,
      priority,
      callData: { agentUsed: 'tech', ...(callSid ? { callSid } : {}) },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
    });

    if (!res.success || !res.ticketNumber) {
      return postFailureToolResult(res, 'file_tech_ticket');
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
      provider_id: lookup.providerId ?? null,
      // Say plainly what is missing, so the agent can still ask before the call
      // ends rather than the technician chasing it tomorrow.
      // Only when the ticket actually stayed on the medication queue. A
      // glasses request routed to Optical does not need a prescriber, and the
      // live curl on 2026-08-13 returned that note on exactly that.
      ...(cleanProvider || redirect ? {} : { note: 'No prescriber captured — ask who prescribed it if there is still time.' }),
      ...(redirect
        ? { routed_to: redirect.departmentName, routed_department_id: redirect.departmentId }
        : {}),
      message: redirect
        ? `Filed as ${res.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
        : `Filed as ${res.ticketNumber}. Read the ticket number back to the caller.`,
    };
  },
});
