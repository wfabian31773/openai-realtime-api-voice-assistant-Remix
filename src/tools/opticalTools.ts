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

    return {
      success: true,
      found: true,
      patient_name: ctx.patientName,
      matched_by: ctx.matchedBy,
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
    return {
      success: true,
      resolved: true,
      verified: true,
      location: hit.canonical,
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
