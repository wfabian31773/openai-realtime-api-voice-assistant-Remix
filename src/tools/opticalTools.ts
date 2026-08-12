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

// ---------------------------------------------------------------- who

registerTool({
  name: 'lookup_patient',
  layer: 'agent',
  timeoutMs: 6000,
  description:
    'Find a patient and their recent visit history. Call this as soon as you have ' +
    'either their phone number, or their first name, last name and date of birth. ' +
    'It returns the offices and providers they have actually been seen at, which is ' +
    'how you confirm which office they mean.',
  input_schema: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Any format. The number they are calling from is usually best.', askAs: 'What is the best phone number for you?' },
      first_name: { type: 'string', description: "Patient's first name as they said it.", askAs: 'Can I get your first name?' },
      last_name: { type: 'string', description: "Patient's last name as they said it.", askAs: 'And your last name?' },
      date_of_birth: { type: 'string', description: 'Any spoken format — "March 17th 1973", "03/17/1973".', askAs: 'And your date of birth?' },
    },
  },
  handler: async (input): Promise<ToolResult> => {
    const phone = str(input.phone);
    const first = str(input.first_name);
    const last = str(input.last_name);
    const dob = str(input.date_of_birth);

    // Either a phone, or the full name+DOB trio. Half a trio is not a lookup.
    if (!phone && !(first && last && dob)) {
      return missing(
        phone ? [] : ['first_name', 'last_name', 'date_of_birth'].filter((f) =>
          f === 'first_name' ? !first : f === 'last_name' ? !last : !dob,
        ),
        "I need either a phone number, or their full name and date of birth, to look them up.",
      );
    }

    const { scheduleLookupService } = await import('../services/scheduleLookupService');
    const ctx = await scheduleLookupService.lookupPatient({
      phone: phone || undefined,
      firstName: first || undefined,
      lastName: last || undefined,
      dateOfBirth: dob || undefined,
    });

    if (!ctx.patientFound) {
      return {
        success: true,
        found: false,
        message:
          'No record found. They may be new, or calling from a different number. ' +
          'Ask for their name and date of birth if you have not already.',
      };
    }

    const seen = [
      ...new Set(
        (ctx.pastAppointments ?? []).map((a) => a.location).filter((l) => l && l !== 'Unknown'),
      ),
    ].slice(0, 6) as string[];

    // The most recent visit is NOT necessarily an optical office.
    //
    // Found by predicting this tool's answer for a real patient before testing
    // it: their last Active visit was Dwayne Logan at Loma Linda SURGERY
    // CENTER. An optical agent taking `lastLocationSeen` at face value would
    // file a glasses ticket against a building with no optician in it, and
    // Optical assigns by location — so it would never reach anyone.
    //
    // So the clinic is resolved separately, and the raw most-recent stays
    // available but is clearly labelled.
    const usualClinic = await mostRecentClinic(seen);

    // A phone number can carry more than one person, and a surname carries
    // whole families. The service reports which case this was, and the agent
    // needs it because it changes what may be SAID: an uncertain match is one
    // real person's record, but it is a guess among several, so the name must
    // be confirmed and the history must not be read back.
    const certain = ctx.identity?.unique !== false;

    return {
      success: true,
      found: true,
      patient_name: ctx.patientName,
      matched_by: ctx.matchedBy,
      identity_is_certain: certain,
      ...(certain
        ? {}
        : {
            identity_warning:
              `This ${phone && !first ? 'phone number' : 'name'} matches ` +
              `${ctx.identity?.candidateCount} different people on file, and what follows ` +
              `is only the most recently seen of them. Ask for their full name and date of ` +
              `birth before using any of it, and do not read their history back until they ` +
              `confirm who they are.`,
          }),
      // The field Optical routes on — a clinic, never a surgery center.
      usual_clinic: usualClinic,
      // Where they were seen last, whatever kind of place that is.
      last_location_any_kind: ctx.lastLocationSeen ?? null,
      last_provider: ctx.lastProviderSeen ?? null,
      last_visit: ctx.lastVisitDate ?? null,
      recent_locations: seen.slice(0, 4),
      total_appointments: ctx.totalAppointmentsFound,
      ...(usualClinic
        ? {}
        : {
            message:
              'No optical office found in their visit history — the places they have been ' +
              'seen are surgery centers or screening sites. Ask which office they use for ' +
              'glasses or contacts.',
          }),
    };
  },
});

// ---------------------------------------------------------------- where

registerTool({
  name: 'resolve_location',
  layer: 'agent',
  timeoutMs: 4000,
  description:
    'Turn what the caller said about an office into the real office name. Call it ' +
    'with their words — "the Encinitas one", "Azul Vision Redlands" — before you ' +
    'file a ticket. Optical tickets cannot be assigned without a location, so if ' +
    'this cannot resolve it, ask the caller which office they visit.',
  input_schema: {
    type: 'object',
    properties: {
      spoken_location: { type: 'string', description: 'Whatever the caller said, verbatim.', askAs: 'Which of our offices do you usually visit?' },
    },
    required: ['spoken_location'],
  },
  handler: async (input): Promise<ToolResult> => {
    const spoken = str(input.spoken_location);
    const { sanitizeLocationName } = await import('../services/ticketFieldSanitizers');
    const cleaned = sanitizeLocationName(spoken);
    if (!cleaned.value) {
      return missing(['spoken_location'], 'Which of our offices do you usually visit?');
    }

    const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
    if (!isDirectoryConfigured()) {
      // No mirror: pass the cleaned string through rather than block a call.
      return { success: true, resolved: false, location: cleaned.value, verified: false };
    }

    const hit = await lookupLocation(cleaned.value);
    if (!hit) {
      return {
        success: true,
        resolved: false,
        location: cleaned.value,
        verified: false,
        message:
          `I could not match "${spoken}" to one of our offices. Ask the caller to name ` +
          `the city, and pass that instead.`,
      };
    }

    // A surgery center or screening site is a real place but not an optical
    // office. Say so rather than filing a ticket nobody can action.
    const isClinic = hit.facilityKind === 'clinic' || hit.facilityKind == null;

    // `location` is the form the RECEIVER stores, not the form the mirror does.
    //
    // Found on the first live run against production: asked to resolve "Azul
    // Vision Eastvale" this returned `hit.canonical`, which is the Console's
    // nextgen_name — "Azul Vision Eastvale", brand and all. The Support Center's
    // own locations table stores "Eastvale". Handing an agent the mirror's form
    // hands it a name the ticketing app does not hold, and an optical ticket
    // whose location does not match reaches nobody, because Optical assigns by
    // location.
    //
    // file_optical_ticket happens to sanitize this on the way out, so the
    // Optical path was covered by luck rather than by design. Any other caller
    // of this tool was not. Emit the fileable form, and keep the mirror's name
    // beside it for anyone who needs to look it up there.
    const fileable = sanitizeLocationName(hit.canonical).value || hit.canonical;

    return {
      success: true,
      resolved: true,
      verified: true,
      location: fileable,
      canonical_name: hit.canonical,
      facility_kind: hit.facilityKind,
      is_optical_office: isClinic,
      ...(isClinic
        ? {}
        : {
            message:
              `${hit.canonical} is a ${hit.facilityKind?.replace('_', ' ')}, not an optical ` +
              `office. Ask which clinic they use for glasses or contacts.`,
          }),
    };
  },
});

// ---------------------------------------------------------------- already asked?

registerTool({
  name: 'check_open_tickets',
  layer: 'agent',
  timeoutMs: 5000,
  description:
    'Check whether this caller already has an open request with us. Call it before ' +
    'filing anything, so a patient chasing an existing request is told where it ' +
    'stands instead of having a second ticket opened.',
  input_schema: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'The number they are calling from.', askAs: 'What is the best phone number for you?' },
    },
    required: ['phone'],
  },
  handler: async (input): Promise<ToolResult> => {
    const phone = str(input.phone);
    const { SyncAgentService } = await import('../services/syncAgentService');
    const open = await SyncAgentService.checkOpenTickets(phone);
    return {
      success: true,
      has_open_tickets: open.length > 0,
      open_tickets: open.map((t) => ({
        ticket_number: t.ticketNumber,
        reason: t.reason,
        days_ago: t.daysAgo,
      })),
    };
  },
});

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

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The first place in this list that is actually a clinic.
 *
 * `locations` is already newest-first, so the first clinic is the most recent
 * one. Returns null when the patient has only ever been seen at surgery
 * centers or screening sites — which is a real answer, not a failure, and the
 * caller should ask rather than assume.
 *
 * Falls back to the first entry when the Console mirror is unreachable: a
 * best guess beats blocking the call, and `resolve_location` will catch it
 * before a ticket is filed.
 */
async function mostRecentClinic(locations: string[]): Promise<string | null> {
  if (locations.length === 0) return null;
  const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
  if (!isDirectoryConfigured()) return locations[0];

  for (const name of locations) {
    try {
      const hit = await lookupLocation(name);
      // An unknown location is more likely a clinic we have not mirrored than
      // a surgery center, so it is not disqualified here — resolve_location
      // is the gate that matters.
      if (!hit || hit.facilityKind === 'clinic' || hit.facilityKind == null) return name;
    } catch {
      return locations[0];
    }
  }
  return null;
}
