/**
 * The tools an HVA Hub agent needs, and nothing else.
 *
 * WHAT IS DIFFERENT FROM THE OTHER QUEUES
 *
 *   This one does NOT book anything. The Hub takes scheduling requests and the
 *   schedulers work them; actual booking lives in the Eye Care service's rules
 *   engine behind `azulSchedulingAgent` (San Diego pilot), and that is a
 *   different line with a different contract. An agent on this line that says
 *   "you're booked for Tuesday" is lying.
 *
 *   The three facts a scheduler cannot work without are WHICH OFFICE, WHICH
 *   PROVIDER (or which kind of doctor), and WHEN THEY CAN COME. None is a gate
 *   — a request that arrives needing a callback is recoverable, and a caller
 *   turned away is not — but the prompt asks for all three every time.
 *
 * THE ONE THING THIS FIXES BY EXISTING. 224 department 9 tickets carry reason
 * 153, Prescription Refill Request, which belongs to department 3. They are on
 * request type 32, Appointment Request, which is not a combination anyone
 * chose. It is the hardcoded fallback in `config/answeringServiceTicketing.ts`.
 * This tool cannot produce a reason that is not department 9's.
 *
 * NO HANDOFF. Operator ruling 2026-08-12: only PCP and Scheduling SD transfer,
 * and this is not that line.
 */
import { registerTool, missing, type ToolResult } from './registry';
import { str } from './sharedPatientTools';

// ---------------------------------------------------------------- what kind

registerTool({
  name: 'classify_hub_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    "Work out which kind of scheduling request this is, in the practice's own " +
    "categories. Call it with the caller's own words once you understand what they " +
    'need, and before filing. It knows new appointments, reschedules, cancellations, ' +
    'confirmations, same-day requests, specialist referrals, insurance and ' +
    'authorization questions, and interpreter bookings — so it always returns ' +
    'something. Pass its request_reason_id to file_hub_ticket.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description:
          "What the caller wants, in their words. e.g. 'I need to reschedule my " +
          "appointment with the retina specialist'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifyHubRequest, HUB_DEPARTMENT_ID } = await import('./hubTaxonomy');
    const { classification, isCatchAll } = classifyHubRequest(str(input.request_description));

    return {
      success: true,
      classified: !isCatchAll,
      department_id: HUB_DEPARTMENT_ID,
      request_type: classification.requestType,
      request_type_id: classification.requestTypeId,
      request_reason: classification.requestReason,
      request_reason_id: classification.requestReasonId,
      ...(isCatchAll
        ? {
            message:
              'Nothing matched, so this is filed as "Other - See Description". That is a ' +
              'real category, not a guess — but it means the description is the only thing ' +
              'the scheduler has. Make sure it says which office, which doctor and when ' +
              'they can come.',
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_hub_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the scheduling request for the scheduling team. This is the last step of ' +
    "the call. It needs the patient's name, date of birth and a callback number. Also " +
    'get WHICH OFFICE, WHICH DOCTOR (or which kind of doctor) and WHEN THEY CAN COME — ' +
    'a scheduler without those three has to ring the patient back. This tool does NOT ' +
    'book anything; it files the request. Pass the request_reason_id from ' +
    'classify_hub_request.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'Can I get the first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'And the last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format.', askAs: 'And the date of birth?' },
      callback_number: { type: 'string', description: 'Best number to reach them.', askAs: 'What is the best number to reach you?' },
      request_description: { type: 'string', description: 'What they need, in their words.', askAs: 'What can we help you with?' },
      request_reason_id: { type: 'string', description: 'From classify_hub_request.' },
      location: { type: 'string', description: 'The office they want, in their words.', askAs: 'Which office works best for you?' },
      provider: { type: 'string', description: 'The doctor they want, or the kind of specialist.', askAs: 'Is there a particular doctor you would like to see?' },
      availability: { type: 'string', description: 'Days and times they can come.', askAs: 'Which days or times generally work for you?' },
      interpreter_language: { type: 'string', description: 'The language, if they need an interpreter.' },
      email: { type: 'string', description: 'Optional — looked up if omitted.' },
      call_sid: { type: 'string', description: 'The call id, so a retry cannot double-file.' },
      caller_phone: { type: 'string', description: 'The number they called from.' },
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

    const { HUB_DEPARTMENT_ID, hubReasonById, classifyHubRequest } = await import('./hubTaxonomy');

    // The reason must be one of THIS department's, whatever we were handed.
    // This is the guard that makes reason 153 impossible here.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? hubReasonById(named) : null) ??
      classifyHubRequest(description).classification;

    // The three facts a scheduler works from, on their own lines so they are
    // read rather than hunted for in a paragraph.
    const availability = str(input.availability);
    const wantedProvider = str(input.provider);
    const language = str(input.interpreter_language);
    const body = [
      description,
      wantedProvider ? `\n\nDoctor requested: ${wantedProvider}` : '',
      availability ? `\nAvailability: ${availability}` : '',
      language ? `\nInterpreter needed: ${language}` : '',
    ].join('');

    // Free text becomes the body of a patient-facing SMS on the other side.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(body);
    if (cleanDescription.changed) {
      console.info('[Hub] description normalised to GSM-7 before filing');
    }

    const { sanitizeProviderName, sanitizeLocationName } = await import(
      '../services/ticketFieldSanitizers'
    );
    const cleanProvider = sanitizeProviderName(wantedProvider).value;
    const cleanLocation = sanitizeLocationName(str(input.location)).value;

    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const { normalizeDobParts } = await import('./dobParts');
    const parts = normalizeDobParts(dob);
    if (!parts) {
      return missing(['date_of_birth'], 'I did not catch that date of birth — month, day and year?');
    }

    const lookup =
      cleanProvider || cleanLocation
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanProvider ? { providerName: cleanProvider } : {}),
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
          })
        : { providerId: undefined, locationId: undefined, locationMatches: [] };

    // A CALLER WHO PRESSED THE WRONG OPTION IS NOT SENT AWAY.
    //
    // On this line the scheduling rule cannot fire — detectCrossQueue returns
    // null for a scheduling request whose home is already the Hub — so what
    // this catches is the other direction: someone who reached scheduling and
    // wants glasses, a refill or a surgery date.
    const { detectCrossQueue } = await import('./queueRouting');
    const redirect = detectCrossQueue(description, HUB_DEPARTMENT_ID);
    const filedDepartmentId = redirect?.departmentId ?? HUB_DEPARTMENT_ID;
    const filedTypeId = redirect?.requestTypeId ?? cls.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? cls.requestReasonId;
    const filedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    if (redirect) {
      console.info(
        `[hub] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    // A same-day request is time-critical by definition: filed tomorrow it is
    // not a same-day request any more.
    const priority = filedReasonId === 151 ? 'high' : 'medium';

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    // Never submit-ticket: it re-derives the DEPARTMENT server-side and
    // defaults to 8.
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
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: filedDescription,
      priority,
      callData: { agentUsed: 'hub', ...(callSid ? { callSid } : {}) },
    });

    if (!res.success || !res.ticketNumber) {
      return { success: false, error: res.error ?? 'ticket creation failed', retryable: true };
    }

    return {
      success: true,
      ticket_number: res.ticketNumber,
      request_reason: cls.requestReason,
      request_reason_id: cls.requestReasonId,
      priority,
      // Say plainly what is missing, so the agent can still ask before the call
      // ends rather than a scheduler chasing it tomorrow.
      ...(cleanLocation ? {} : { note_location: 'No office captured — ask which office if there is still time.' }),
      ...(availability ? {} : { note_availability: 'No availability captured — ask which days or times work.' }),
      ...(redirect
        ? { routed_to: redirect.departmentName, routed_department_id: redirect.departmentId }
        : {}),
      message: redirect
        ? `Filed as ${res.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
        : `Filed as ${res.ticketNumber}. Read the ticket number back. Say the scheduling team will call to book it — do NOT say the appointment is booked.`,
    };
  },
});
