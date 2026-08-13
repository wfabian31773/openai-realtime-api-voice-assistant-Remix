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
import { str } from './sharedPatientTools';

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

    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const { normalizeDobParts } = await import('./dobParts');
    const parts = normalizeDobParts(dob);
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
        : { providerId: undefined, locationId: undefined, locationMatches: [] };

    // Sight-preserving medication. A patient out of glaucoma drops is not a
    // routine refill: pressure rises within days and the damage does not come
    // back. The practice gave it its own reason; this gives it its own urgency.
    const priority = cls.requestReasonId === 155 ? 'high' : 'medium';

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    // Never submit-ticket: it re-derives the DEPARTMENT server-side and
    // defaults to 8, which is how VA-50811 reached nobody.
    const res = await ticketingApiClient.createTicket({
      departmentId: TECH_DEPARTMENT_ID,
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
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: cleanDescription.value,
      priority,
      callData: { agentUsed: 'tech', ...(callSid ? { callSid } : {}) },
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
      provider_id: lookup.providerId ?? null,
      // Say plainly what is missing, so the agent can still ask before the call
      // ends rather than the technician chasing it tomorrow.
      ...(cleanProvider ? {} : { note: 'No prescriber captured — ask who prescribed it if there is still time.' }),
      message: `Filed as ${res.ticketNumber}. Read the ticket number back to the caller.`,
    };
  },
});
