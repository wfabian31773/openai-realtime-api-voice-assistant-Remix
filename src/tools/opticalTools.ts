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
import { str } from './sharedPatientTools';

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
    if (!lookup.locationId) {
      // Refuse rather than file something nobody will see. The agent can ask
      // again; an unassigned optical ticket is indistinguishable from a lost one.
      return {
        success: false,
        error: `no optical office matched "${cleanLocation}"`,
        retryable: true,
        ...(lookup.locationMatches?.length
          ? {
              message:
                `I have a few offices that could be it — ` +
                `${lookup.locationMatches.map((m) => m.name).join(', ')}. Which one do they mean?`,
            }
          : {
              message:
                `I could not match that to one of our offices. Ask the caller which office ` +
                `they visit, then call resolve_location with their answer before filing.`,
            }),
      };
    }

    // TWO ENDPOINTS, chosen by whether we have a classification.
    //
    // create-ticket takes an explicit (departmentId, requestTypeId,
    // requestReasonId) triple, which is the whole point of routing by queue: an
    // agent that arrived on the optical line already knows the department and
    // has just classified the request, and submit-ticket would discard that and
    // re-derive it from free text — which is how 42% of optical tickets ended
    // up with no request type and 953 with a Technicians-Support reason.
    //
    // But create-ticket REQUIRES the triple. Measured against production on
    // 2026-08-12, twice: `requestTypeId: 0` is rejected ("Validation failed"),
    // and OMITTING the fields is rejected identically. So there is no way to
    // express "no category" through it, and a request that genuinely fits none
    // of Optical's eighteen pairs — a billing question that reached this line —
    // would be unfileable.
    //
    // submit-ticket accepts free text and derives its own taxonomy. That is
    // exactly the wrong tool when we KNOW the answer and the right one when we
    // do not: the ticket exists, the location resolves server-side, the
    // optician sees it, and the description carries the truth. Better a
    // filed ticket with a weak category than a caller told we cannot help.
    //
    // The proper fix is nullable columns on create-ticket; raised with the
    // ticketing app. Until then this is the honest fallback rather than
    // inventing a category that nearly fits.
    const res = cls
      ? await ticketingApiClient.createTicket({
          departmentId: OPTICAL_DEPARTMENT_ID,
          requestTypeId: cls.requestTypeId,
          requestReasonId: cls.requestReasonId,
          patientFirstName: first,
          patientLastName: last,
          patientPhone: phone,
          patientEmail: str(input.email) || undefined,
          preferredContactMethod: 'phone',
          patientBirthMonth: parts.month,
          patientBirthDay: parts.day,
          patientBirthYear: parts.year,
          // The id is what sets the foreign key; the name is what staff read.
          locationId: lookup.locationId,
          locationOfLastVisit: cleanLocation,
          ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
          lastProviderSeen: cleanProvider || undefined,
          description: cleanDescription.value,
          priority: 'medium',
          callData: { agentUsed: 'optical', ...(callSid ? { callSid } : {}) },
        })
      : await ticketingApiClient.submitTicket({
          patientFullName: `${first} ${last}`,
          patientDOB: `${parts.month}/${parts.day}/${parts.year}`,
          reasonForCalling: cleanDescription.value,
          preferredContactMethod: 'phone',
          patientPhone: phone,
          patientEmail: str(input.email) || undefined,
          locationOfLastVisit: cleanLocation,
          lastProviderSeen: cleanProvider || undefined,
          priority: 'medium',
          callData: { agentUsed: 'optical', ...(callSid ? { callSid } : {}) },
          ...(callSid ? { idempotencyKey: `call-${callSid}` } : {}),
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
      request_reason: cls?.requestReason ?? null,
      // The id we actually attached, so a caller can tell a real assignment
      // from a ticket that merely mentions an office in its text.
      location_id: lookup.locationId,
      // Say the number back. Callers ask for it, and staff quote it.
      message: `Filed as ${res.ticketNumber}. Read the ticket number back to the caller.`,
    };
  },
});
