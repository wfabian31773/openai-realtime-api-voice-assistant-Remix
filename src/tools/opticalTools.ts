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
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'Can I get the first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'And the last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format.', askAs: 'And the date of birth?' },
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
    required: ['first_name', 'last_name', 'date_of_birth', 'callback_number', 'location', 'request_description'],
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
    if (!cleanLocation) {
      return missing(['location'], 'Which of our offices do you usually visit?');
    }

    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const { normalizeDobParts } = await import('./dobParts');
    const parts = normalizeDobParts(dob);
    if (!parts) {
      return missing(['date_of_birth'], 'I did not catch that date of birth — month, day and year?');
    }

    // Resolve the office to the ticketing app's numeric id BEFORE filing.
    //
    // `locationOfLastVisit` is only a text hint — create-ticket sets the
    // location foreign key from `locationId` and nothing else. Filing VA-50803
    // with the name alone produced location_id NULL and assigned_to_id NULL:
    // a real ticket, in the right department, that reached nobody. For a queue
    // whose assignment IS the location, that is the whole failure mode.
    const lookup = await ticketingApiClient.lookupProviderAndLocation({
      locationName: cleanLocation,
      ...(cleanProvider ? { providerName: cleanProvider } : {}),
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
    const lookupRan = lookup.success !== false;

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
      const candidates = lookup.locationMatches?.length
        ? ` I have ${lookup.locationMatches.map((m) => m.name).join(', ')} — is it one of those?`
        : '';
      return missing(
        ['location'],
        `I'm not finding an office by that name — which city is your optical office in?${candidates}`,
      );
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
     * unassigned ticket reaches nobody unless a human is told to look — which
     * is what the banner and the raised priority are for. The office the caller
     * gave is preserved verbatim in `locationOfLastVisit` and named in the
     * description, so the manual step is "set this office", not "phone them
     * back and ask again".
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
    // Staff read the description first, and an optical ticket with no office is
    // one nobody's queue view will surface. Name the office the caller gave, so
    // the manual step is a lookup and not a callback.
    const filedDescription = lookupRan
      ? routedDescription
      : `[NEEDS OFFICE ASSIGNMENT — the office lookup was unavailable when this was taken. `
        + `Caller said: "${cleanLocation}". Set the office before working this ticket.]\n\n`
        + routedDescription;
    if (redirect) {
      console.info(
        `[optical] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    const res = await ticketingApiClient.createTicket({
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
      // The id is what sets the foreign key; the name is what staff read.
      // Omitted rather than sent null when the lookup could not run — the name
      // still travels, and the description says the office needs setting.
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      locationOfLastVisit: cleanLocation,
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: filedDescription,
      priority: 'medium',
      callData: { agentUsed: 'optical', ...(callSid ? { callSid } : {}) },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
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
