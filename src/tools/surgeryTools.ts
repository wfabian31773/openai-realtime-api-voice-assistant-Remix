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
    'want, and before filing. Many real surgery calls — drops that never arrived, ' +
    'clearance forms, arrival times, reschedules, deposits — have NO category in ' +
    'our system, and this will tell you so. When it does, file anyway with a clear ' +
    'description and no category. Never force a request into a box that nearly fits.',
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
    const { classifySurgery, classifySurgeryLogistics, SURGERY_DEPARTMENT_ID } = await import(
      './surgeryTaxonomy'
    );
    const text = str(input.request_description);
    const hit = classifySurgery(text);

    if (hit) {
      return {
        success: true,
        classified: true,
        department_id: SURGERY_DEPARTMENT_ID,
        request_type: hit.requestType,
        request_type_id: hit.requestTypeId,
        request_reason: hit.requestReason,
        request_reason_id: hit.requestReasonId,
        ...(hit.urgent
          ? {
              urgent: true,
              message:
                'These are the words we treat as a surgical emergency. Tell the caller to ' +
                'seek emergency care or call 911 now, and file this at urgent priority. ' +
                'Do not take a routine message and hang up.',
            }
          : {}),
      };
    }

    // No reason exists for this. Say WHICH kind of no — a coordinator reading
    // "RESCHEDULE / CANCEL" at the top of a description can act on it without
    // reading the rest, and the practice can count these later to size the
    // reasons the Support Center is missing.
    const bucket = classifySurgeryLogistics(text);
    return {
      success: true,
      classified: false,
      department_id: SURGERY_DEPARTMENT_ID,
      ...(bucket
        ? {
            recognised_as: bucket.key,
            description_prefix: bucket.label,
            message:
              `This is a ${bucket.label.toLowerCase()} request. Our system has no category ` +
              `for it, which is expected — file it with description_prefix "${bucket.label}" ` +
              `and no category. Do not pick a category that nearly fits.`,
          }
        : {
            message:
              'This does not match one of our surgery categories. That is fine — file the ' +
              'ticket with a clear description of what they asked for and leave the category ' +
              'off. Do not pick a category that nearly fits.',
          }),
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
      surgeon: { type: 'string', description: 'Their surgeon, if it came up. Optional — looked up if omitted.' },
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

    const { SURGERY_DEPARTMENT_ID, surgeryClassificationByReasonId, classifySurgery } =
      await import('./surgeryTaxonomy');

    // The reason must be one of SURGERY's own, whatever we were handed. This is
    // the guard that keeps this queue off request_reason_id 153 — the
    // Technicians-Support medication-refill reason that 1,443 surgery tickets
    // carried until June — and off 42 as a catch-all, which is what replaced it.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? surgeryClassificationByReasonId(named) : null) ??
      classifySurgery(description);

    // Lead with the bucket when there is no reason id to carry the meaning.
    // A coordinator scanning a queue reads the first three words.
    // When there is no true reason, the description carries the meaning — so it
    // is prefixed ALWAYS, not only when the agent remembered to pass a bucket.
    // A coordinator reads the first three words; the placeholder reason id must
    // never be the only thing describing this ticket.
    const prefix = str(input.description_prefix);
    const surgeryDate = str(input.surgery_date);
    // Plain hyphen, not an em dash: an em dash is outside GSM-7, so
    // sanitizeForSms would rewrite it and log a normalisation on every single
    // unclassified ticket — which is most of them on this queue.
    const leader = cls ? '' : `${prefix || 'UNCATEGORISED'} - `;
    const body = [
      leader,
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
    const lookup =
      cleanLocation || cleanSurgeon
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
            ...(cleanSurgeon ? { providerName: cleanSurgeon } : {}),
          })
        : { locationId: undefined, providerId: undefined, locationMatches: [] };

    const urgent = str(input.urgent).toLowerCase() === 'true' || cls?.urgent === true;
    const priority = urgent ? 'urgent' : 'medium';

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    //
    // This used to fall back to submit-ticket when nothing classified, copying
    // Optical. Proving it against production killed that: VA-50811 was filed by
    // the OPTICAL agent through submit-ticket, its description said "a question
    // about my account that fits no optical category", and it landed in
    // department 8 — After Hours Call Service — with assigned_to_id NULL and a
    // subject reading "Wayne Fabian - After Hours Call". Nothing in the text
    // said after hours. submit-ticket re-derives the DEPARTMENT, not just the
    // reason, and defaults to 8 when it cannot.
    //
    // For Optical that is the rare tail. For Surgery the unclassifiable case is
    // the MAJORITY — drops, clearance forms, arrival times, reschedules,
    // deposits and status chases are roughly 55% of the queue and none of them
    // match a reason. Routing those through submit-ticket would have sent more
    // than half of this queue to After Hours, unassigned: worse than the defect
    // this agent exists to fix, which at least reaches department 2.
    //
    // So the reason is a placeholder when nothing fits, the department never
    // is, and the description leads with what the request actually is. See
    // SURGERY_PLACEHOLDER for why 43 and not 42.
    const { SURGERY_PLACEHOLDER } = await import('./surgeryTaxonomy');
    const filing = cls ?? SURGERY_PLACEHOLDER;

    //
    // create-ticket takes an explicit (departmentId, requestTypeId,
    // requestReasonId) triple, which is the whole point of routing by queue: an
    // agent that arrived on the surgery line already knows the department and
    // has just classified the request, and submit-ticket would discard that and
    // re-derive it from free text.
    //
    // But create-ticket REQUIRES the triple. Measured against production on
    // 2026-08-12, twice: `requestTypeId: 0` is rejected ("Validation failed"),
    // and OMITTING the fields is rejected identically. So there is no way to
    // express "no category" through it — and for THIS queue the no-category
    // case is the majority of calls, not the tail. Drops, clearance forms,
    // arrival times, reschedules, deposits and status chases have no reason id
    // in the Support Center at all.
    //
    // submit-ticket accepts free text and derives its own taxonomy server-side.
    // That is the honest fallback: the ticket exists, the coordinator sees it,
    // and the description leads with what kind of request it is. Whatever the
    // server derives, the first words a human reads are true.
    //
    // The proper fix is nullable taxonomy columns on create-ticket, or the six
    // missing reasons added to department 2. Both are raised with the ticketing
    // app; neither is ours to apply unilaterally.
    const res = await ticketingApiClient.createTicket({
      departmentId: SURGERY_DEPARTMENT_ID,
      requestTypeId: filing.requestTypeId,
      requestReasonId: filing.requestReasonId,
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
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      lastProviderSeen: cleanSurgeon || undefined,
      description: cleanDescription.value,
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
      classified: Boolean(cls),
      request_reason: cls?.requestReason ?? null,
      // Say so out loud. A caller reading this result must be able to tell a
      // reason the request earned from one it was given to satisfy a required
      // field — otherwise this becomes the next 1,710-ticket statistic.
      reason_is_placeholder: !cls,
      ...(cls ? {} : { filed_under: SURGERY_PLACEHOLDER.requestReason, description_leads_with: leader.replace(' — ', '') }),
      priority,
      location_id: lookup.locationId ?? null,
      provider_id: lookup.providerId ?? null,
      // Say the number back. Callers ask for it, and staff quote it.
      message: `Filed as ${res.ticketNumber}. Read the ticket number back to the caller.`,
    };
  },
});
