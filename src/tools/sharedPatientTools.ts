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
    // The number the call ARRIVED on, when the model did not pass one.
    //
    // `caller_phone` is injected as call context on every tool. This tool's
    // schema field is `phone`, so until now the caller's own number reached the
    // lookup only if the model chose to type it out — even though the process
    // had already matched that number to a patient before the caller spoke.
    //
    // Live on 2026-08-13: the transcriber heard "Thanks." and "No. March 17th,
    // 1973." for a date of birth, the model looked up that mangled trio, and
    // the tool answered "no record found" for a patient it had recognised
    // seconds earlier. The ticket filed with no provider and no location.
    //
    // Same lesson as VA-50813 filing with a null call_sid: never make a value
    // the process already holds depend on the model remembering to pass it.
    const phone = str(input.phone) || str(input.caller_phone);
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

    // A name+DOB miss is very often ONE mis-transcribed field, not a stranger.
    // The number they are calling from is the one piece nobody misheard, so try
    // it before telling an agent this person is unknown.
    //
    // Rebound rather than mutated: `ctx` is the service's own returned object,
    // and writing into it would change a value the caller still owns. The first
    // version did `Object.assign(ctx, byPhone)` and a test caught it corrupting
    // a shared fixture — which is the same hazard in miniature.
    let resolved = ctx;
    if (!ctx.patientFound && phone && (first || last || dob)) {
      const byPhone = await scheduleLookupService.lookupPatient({ phone });
      if (byPhone.patientFound) {
        console.info('[TOOLS] lookup_patient: name+DOB missed, matched on the caller phone instead');
        resolved = byPhone;
      }
    }

    if (!resolved.patientFound) {
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
        (resolved.pastAppointments ?? []).map((a) => a.location).filter((l) => l && l !== 'Unknown'),
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
    const certain = resolved.identity?.unique !== false;

    /**
     * PASS THE RECORD ALONG — operator instruction, 2026-09-01.
     *
     * The service has already returned this patient's date of birth in
     * `patientData`, and nothing carried it the twenty lines to the filing
     * tool. So the agent asked for a date of birth the process was holding,
     * and when the caller could not give it the request was lost: 45 calls
     * refused for a date of birth in fourteen days, 23 of them for a patient
     * this tool had already identified.
     *
     * Only a CERTAIN match is remembered, and it is only ever read back for
     * the same name — see verifiedIdentity.ts. An uncertain match still has to
     * be confirmed out loud, which is the rule the identity_warning above
     * exists to enforce.
     */
    if (certain) {
      const { rememberVerifiedIdentity } = await import('./verifiedIdentity');
      rememberVerifiedIdentity(str(input.call_sid), {
        firstName: resolved.patientData?.firstName,
        lastName: resolved.patientData?.lastName,
        dateOfBirth: resolved.patientData?.dateOfBirth,
      });
    }

    return {
      success: true,
      found: true,
      patient_name: resolved.patientName,
      matched_by: resolved.matchedBy,
      identity_is_certain: certain,
      ...(certain
        ? {}
        : {
            identity_warning:
              `This ${phone && !first ? 'phone number' : 'name'} matches ` +
              `${resolved.identity?.candidateCount} different people on file, and what follows ` +
              `is only the most recently seen of them. Ask for their full name and date of ` +
              `birth before using any of it, and do not read their history back until they ` +
              `confirm who they are.`,
          }),
      // The field this queue routes on.
      usual_clinic: usualOffice,
      usual_office: usualOffice,
      // Where they were seen last, whatever kind of place that is.
      last_location_any_kind: resolved.lastLocationSeen ?? null,
      last_provider: resolved.lastProviderSeen ?? null,
      last_visit: resolved.lastVisitDate ?? null,
      recent_locations: seen.slice(0, 4),
      total_appointments: resolved.totalAppointmentsFound,
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
      /**
       * THIS USED TO RETURN `success: true`, AND IT WAS THE WORST LOOP WE HAD.
       *
       * Measured on the queue's first live day, 2026-08-13: `resolve_location`
       * ran 41 times across 29 optical calls, and 32 of those returned
       * `verified: false`. Five calls looped it three or more times, one of
       * them TEN times in a row with identical arguments. Those five averaged
       * 229 seconds against 134 for the rest — 95 extra seconds of a patient's
       * life each — and not one of them ended `resolved`.
       *
       * The trace is unambiguous. A caller said "Downtown LA", where we have no
       * optical office:
       *
       *   file_optical_ticket -> error: no optical office matched "Downtown LA"
       *   resolve_location    -> { success: true, verified: false }   x9
       *   file_optical_ticket -> error: no optical office matched "Downtown Los Angeles"
       *   resolve_location    -> { success: true, verified: false }
       *
       * `success: true` is what did it. The advisory `message` asked the agent
       * to go and ask the caller, but the envelope said the call had WORKED, so
       * the model had no reason to change anything and every reason to try
       * again. This is `local-tool-gates.md` exactly: answer a predictable
       * refusal with the refusal envelope, or the model retries it verbatim.
       *
       * Now it refuses, which hands the agent a sentence to say to the caller —
       * and the queue prompts already tell it that a tool asking for something
       * is not a fault.
       */
      return missing(
        ['spoken_location'],
        // See opticalTools' matching refusal: every queue prompt that uses
        // resolve_location forbids asking which city an office is in.
        `I'm not finding an office by that name — which of our offices do you usually visit?`,
      );
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
    // `fileAs` wins when the ticketing app calls the office something else
    // entirely. "Azul Vision DTLA" in the mirror is "Los Angeles" over there,
    // and brand-stripping alone yields "DTLA" — a name the receiver has never
    // heard of, which is how a resolved office still failed to file.
    const fileable = hit.fileAs || sanitizeLocationName(hit.canonical).value || hit.canonical;

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
 * True only for a real Twilio Call SID. `metadata.callId` fallback values
 * ("unknown", "latest", "none", "unknown_sid" — traced 2026-08-20 to
 * `metadata.callSid ?? metadata.callId` in the four queue agents) satisfy a
 * truthy check but are not call identity. Sent as an idempotency key, one of
 * those sentinels would key on the literal string instead of the call, so a
 * second caller's retry could read back a stranger's ticket number.
 */
// The definition moved to `./callSid` so `gateAttempts` and `verifiedIdentity`
// can validate their map keys without importing this module (which pulls in
// the registry and every queue tool). Re-exported here so the four filing
// tools keep their single import line and there is still ONE definition.
export { isTwilioCallSid } from './callSid';

// Re-exported so the four queue tools only need one import line from here,
// not a second import path into `utils/phone.ts`. See that file for what it
// does and why it lives there rather than here or in scheduleLookupService.
export { normalizePhone } from '../utils/phone';

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
