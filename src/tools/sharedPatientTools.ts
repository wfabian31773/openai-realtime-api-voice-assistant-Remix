/**
 * The tools every queue needs: who is calling, which office, have they asked
 * already.
 *
 * WHY THEY MOVED HERE
 *
 * These three were written for Optical and lived in `opticalTools.ts`. Surgery
 * needs the same three, and the choice was to copy them or to share them. The
 * library exists because copies drift — that is how this practice ended up with
 * provider names in four shapes — so they are shared.
 *
 * But they were not queue-neutral. Both of the first two encoded "a surgery
 * centre is the wrong kind of place", which is correct for an optician and
 * exactly backwards for a surgery coordinator:
 *
 *   lookup_patient    skipped surgery centres when picking the usual office,
 *                     and said "ask which office they use for glasses"
 *   resolve_location  reported `is_optical_office: false` for a surgery centre
 *                     and told the agent to ask for a clinic instead
 *
 * So they now take a `queue`. It is NOT a schema field and the model never sees
 * it: `realtimeToolsFor` merges call context underneath the model's arguments,
 * and `validateInput` only checks declared required fields, so an undeclared
 * key passes through to the handler untouched. The agent cannot set it, cannot
 * blank it, and cannot be asked for it.
 *
 * With no queue at all the behaviour is neutral — every real facility is
 * acceptable and the wording names no speciality. That is the right default for
 * the HTTP surface, where the caller is not a queue.
 */
import { registerTool, missing, type ToolResult } from './registry';

/** Which queue is asking. Injected as call context, never a model argument. */
export type ToolQueue = 'optical' | 'surgery';

/** What kind of place this queue can actually action a request at. */
function acceptsFacility(queue: ToolQueue | undefined, kind: string | null | undefined): boolean {
  // Unknown facility kinds are accepted everywhere. The Console mirror is
  // incomplete, and a location we have not classified is far more likely to be
  // a real office than a wrong one — `file_*_ticket` resolves it against the
  // ticketing app before anything is filed, which is the gate that matters.
  if (kind == null) return true;
  if (queue === 'optical') return kind === 'clinic';
  // Surgery coordinates AT surgery centres, and its patients are seen in
  // clinics for consults, measurements and post-op. Both are correct.
  if (queue === 'surgery') return kind === 'clinic' || kind === 'surgery_center';
  return true;
}

function facilityWord(queue: ToolQueue | undefined): string {
  return queue === 'optical' ? 'optical office' : queue === 'surgery' ? 'office' : 'office';
}

function askWhichOffice(queue: ToolQueue | undefined): string {
  return queue === 'optical'
    ? 'Ask which office they use for glasses or contacts.'
    : queue === 'surgery'
      ? 'Ask which office or surgery centre they are being seen at.'
      : 'Ask which of our offices they visit.';
}

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
    const queue = input.queue as ToolQueue | undefined;
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

    // The most recent visit is NOT necessarily a place THIS queue can use.
    //
    // Found by predicting this tool's answer for a real patient before testing
    // it: their last Active visit was Dwayne Logan at Loma Linda SURGERY
    // CENTER. An optical agent taking `lastLocationSeen` at face value would
    // file a glasses ticket against a building with no optician in it, and
    // Optical assigns by location — so it would never reach anyone. For
    // Surgery that same visit is the single most useful fact on the call.
    //
    // So the office is resolved against what the QUEUE accepts, and the raw
    // most-recent stays available but is clearly labelled.
    const usualOffice = await mostRecentAcceptable(seen, queue);

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
      // The field this queue routes on.
      usual_clinic: usualOffice,
      usual_office: usualOffice,
      // Where they were seen last, whatever kind of place that is.
      last_location_any_kind: ctx.lastLocationSeen ?? null,
      last_provider: ctx.lastProviderSeen ?? null,
      last_visit: ctx.lastVisitDate ?? null,
      recent_locations: seen.slice(0, 4),
      total_appointments: ctx.totalAppointmentsFound,
      ...(usualOffice
        ? {}
        : {
            message:
              `No ${facilityWord(queue)} found in their visit history. ` + askWhichOffice(queue),
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
    'file a ticket. A ticket without a location is harder to route, so if this ' +
    'cannot resolve it, ask the caller which office they visit.',
  input_schema: {
    type: 'object',
    properties: {
      spoken_location: { type: 'string', description: 'Whatever the caller said, verbatim.', askAs: 'Which of our offices do you usually visit?' },
    },
    required: ['spoken_location'],
  },
  handler: async (input): Promise<ToolResult> => {
    const queue = input.queue as ToolQueue | undefined;
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

    const usable = acceptsFacility(queue, hit.facilityKind);

    // `location` is the form the RECEIVER stores, not the form the mirror does.
    //
    // Found on the first live run against production: asked to resolve "Azul
    // Vision Eastvale" this returned `hit.canonical`, which is the Console's
    // nextgen_name — "Azul Vision Eastvale", brand and all. The Support Center's
    // own locations table stores "Eastvale". Handing an agent the mirror's form
    // hands it a name the ticketing app does not hold, and a ticket whose
    // location does not match is a ticket that reaches nobody on any queue that
    // assigns by location.
    //
    // file_*_ticket happens to sanitize this on the way out, so the Optical
    // path was covered by luck rather than by design. Any other caller of this
    // tool was not. Emit the fileable form, and keep the mirror's name beside
    // it for anyone who needs to look it up there.
    const fileable = sanitizeLocationName(hit.canonical).value || hit.canonical;

    return {
      success: true,
      resolved: true,
      verified: true,
      location: fileable,
      canonical_name: hit.canonical,
      facility_kind: hit.facilityKind,
      usable_for_this_queue: usable,
      // Kept for existing Optical callers, which read this name.
      is_optical_office: hit.facilityKind === 'clinic' || hit.facilityKind == null,
      ...(usable
        ? {}
        : {
            message:
              `${hit.canonical} is a ${hit.facilityKind?.replace('_', ' ')}, not an ` +
              `${facilityWord(queue)}. ` + askWhichOffice(queue),
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

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The first place in this list this queue can actually use.
 *
 * `locations` is already newest-first, so the first acceptable one is the most
 * recent. Returns null when nothing in the history fits — which is a real
 * answer, not a failure, and the agent should ask rather than assume.
 *
 * Falls back to the first entry when the Console mirror is unreachable: a best
 * guess beats blocking the call, and `resolve_location` will catch it before a
 * ticket is filed.
 */
async function mostRecentAcceptable(
  locations: string[],
  queue: ToolQueue | undefined,
): Promise<string | null> {
  if (locations.length === 0) return null;
  const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
  if (!isDirectoryConfigured()) return locations[0];

  for (const name of locations) {
    try {
      const hit = await lookupLocation(name);
      // An unknown location is more likely an office we have not mirrored than
      // a wrong one, so it is not disqualified here — resolve_location is the
      // gate that matters.
      if (!hit || acceptsFacility(queue, hit.facilityKind)) return name;
    } catch {
      return locations[0];
    }
  }
  return null;
}
