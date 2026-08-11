/**
 * One resolver for the two fields the ticketing app looks up by name.
 *
 * WHY THIS EXISTS — measured against 90 days of `/api/voice-agent/submit-ticket`
 * in the Support Center (2026-08-11):
 *
 *   provider lookups: 3,088 of 15,663 failed  (19.7%)
 *   location lookups: 2,385 of 15,411 failed  (15.5%)
 *
 * A failed provider lookup is not harmless. The ticketing app falls back to a
 * Schedule-DB search by name + date of birth, which roughly DOUBLES the time
 * the caller waits:
 *
 *   providerMatched=true   avg  5,184ms   4.1% over 15s
 *   providerMatched=false  avg 10,741ms  21.5% over 15s
 *
 * 48% of the worst waits in the system are failed provider matches — about
 * 4.8 hours of dead air per 90 days. The fallback usually rescues the routing
 * (only 0.4% of surgery tickets end with no provider), so this is a latency
 * defect, not a misrouting one. It is still the largest one we have.
 *
 * Of the 1,637 failures that carried a name, cleaning them here fixes 970:
 *
 *   483  seven placeholder strings that are not people at all
 *   487  real providers whose credential suffix broke the match
 *   667  genuinely absent from the providers table — nothing to do here
 *
 * Everything in this file is a pure function so it can be proven without a
 * phone call.
 */

/**
 * Values the schedule hands us as "last provider seen" that are not providers.
 *
 * `OCT-VF`, `A-Scan` and `DRS` are diagnostic tests; the rest are placeholders.
 * Seven strings, 483 failed lookups. The answering-service prompt already warns
 * about exactly this — "the schedule's last provider seen may be a scan, test,
 * or technician (e.g. 'A-Scan'), not the caller's doctor" — but a warning in a
 * prompt does not stop the value reaching the wire. This does.
 *
 * Matched case-insensitively against the WHOLE trimmed string, never as a
 * substring: a real person named Drs or Nunez must not be caught by it.
 */
const NON_PROVIDER_VALUES = new Set([
  'oct-vf',
  'a-scan',
  'drs',
  'lipiscan',
  'diagnostics',
  'testing',
  'test',
  'technician',
  'n/a',
  'na',
  'none',
]);

/**
 * "We don't know who" — the largest family in the corpus, and bilingual.
 *
 * The caller genuinely could not name their doctor, and the agent wrote that
 * down honestly. Passing the sentence to a name lookup cannot work; dropping it
 * lets the ticketing app go straight to its own patient-based surgeon search,
 * which is the thing that actually resolves these.
 *
 * Anchored at the start so a real surname is never caught mid-string.
 */
const NO_PROVIDER_KNOWN = [
  /^(not|no)\s+(yet\s+)?(specified|provided|identified|available|assigned|selected|determined|seen|doctor|surgeon|specific)/i,
  /^unknown\b/i,
  /^unspecified\b/i,
  /^unavailable\b/i,
  /^(desconocido|no\s+especificado|no\s+asignado|no\s+recuerda|no\s+está)/i,
  /^(first|next|any)\s+available/i,
  /^on-?call\b/i,
  /^any\s+(surgeon|ophthalmologist|doctor)/i,
];

/** Trailing credentials. The comma is required, so "Dr. Le" survives. */
const CREDENTIAL_SUFFIX = /,\s*(OD|MD|DO|PA|NP|DNP|PhD|OD\/MD|M\.D\.|O\.D\.)\.?\s*$/i;

/** Leading honorific. The ticketing app stores bare names. */
const HONORIFIC_PREFIX = /^(Dr\.?|Doctor|Dra\.?)\s+/i;

/** Brand prefixes NextGen puts on clinic names that the Support Center does not store. */
const BRAND_PREFIX = /^(Azul Vision|Atlantis Eyecare)\s+/i;

export interface SanitizedField {
  /** What to put on the wire. `undefined` means send nothing at all. */
  value?: string;
  /** True when the input was rejected outright rather than cleaned. */
  dropped: boolean;
  /** Short machine-readable note for the log. Absent when nothing changed. */
  reason?: string;
}

/**
 * Clean a provider name, or refuse to send one.
 *
 * Refusing is the point. Sending `A-Scan` costs the caller a five-second
 * Schedule-DB round trip that cannot possibly succeed; sending nothing lets
 * the app go straight to its own patient-based surgeon lookup.
 */
export function sanitizeProviderName(raw: string | null | undefined): SanitizedField {
  if (raw == null) return { dropped: false };
  const trimmed = raw.trim();
  if (!trimmed) return { dropped: false };

  if (NON_PROVIDER_VALUES.has(trimmed.toLowerCase())) {
    return { dropped: true, reason: `not-a-provider:${trimmed}` };
  }
  if (NO_PROVIDER_KNOWN.some((re) => re.test(trimmed))) {
    return { dropped: true, reason: `no-provider-known:${trimmed.slice(0, 40)}` };
  }

  let cleaned = trimmed.replace(CREDENTIAL_SUFFIX, '').replace(HONORIFIC_PREFIX, '').trim();
  // Collapse the double spaces that NextGen master data carries.
  cleaned = cleaned.replace(/\s{2,}/g, ' ');

  if (!cleaned) return { dropped: true, reason: `empty-after-cleaning:${trimmed}` };
  if (cleaned === trimmed) return { value: cleaned, dropped: false };
  return { value: cleaned, dropped: false, reason: `cleaned:${trimmed}->${cleaned}` };
}

/**
 * Clean a clinic name.
 *
 * NextGen brandifies its master data — "Atlantis Eyecare Encinitas" is surfaced
 * to the agent as "Azul Vision Encinitas", which is the right thing to say to a
 * patient. The Support Center's `locations` table stores the bare city name
 * ("Encinitas"), and nothing translated between the two.
 *
 * NOTE: this only fixes the naming half. The larger half is that surgery
 * centers are absent from `locations` entirely — `... where name ilike
 * '%surgery%'` returns zero rows — and no amount of string cleaning finds a row
 * that is not there. That one is a data load, tracked separately.
 */
export function sanitizeLocationName(raw: string | null | undefined): SanitizedField {
  if (raw == null) return { dropped: false };
  const trimmed = raw.trim().replace(/\s{2,}/g, ' ');
  if (!trimmed) return { dropped: false };

  if (NON_PROVIDER_VALUES.has(trimmed.toLowerCase())) {
    return { dropped: true, reason: `not-a-location:${trimmed}` };
  }

  const cleaned = trimmed.replace(BRAND_PREFIX, '').trim();
  if (!cleaned) return { value: trimmed, dropped: false };
  if (cleaned === trimmed) return { value: cleaned, dropped: false };
  return { value: cleaned, dropped: false, reason: `cleaned:${trimmed}->${cleaned}` };
}

/**
 * Both fields at once, with one log line when anything changed.
 *
 * The log matters as much as the fix: it is how we confirm the change is live
 * and working without waiting for the ticketing app's own metrics.
 */
export function sanitizeTicketLookupFields(
  input: { lastProviderSeen?: string | null; locationOfLastVisit?: string | null },
  callSid?: string,
): { lastProviderSeen?: string; locationOfLastVisit?: string } {
  const provider = sanitizeProviderName(input.lastProviderSeen);
  const location = sanitizeLocationName(input.locationOfLastVisit);

  const notes = [provider.reason, location.reason].filter(Boolean);
  if (notes.length) {
    console.info(`[TICKET-FIELDS] ${callSid ?? ''} ${notes.join(' | ')}`);
  }

  return {
    lastProviderSeen: provider.value,
    locationOfLastVisit: location.value,
  };
}

/**
 * The same two fields, checked against the one source of truth.
 *
 * The string rules above are guesses about what a provider name looks like.
 * This asks the NextGen mirror instead. Where the two disagree, the mirror
 * wins — that is the whole point of having one source of truth.
 *
 * What it adds over the string rules alone:
 *
 *   - A name the mirror has never heard of is not sent. No hardcoded list of
 *     test codes can keep up with what the schedule invents; the mirror simply
 *     knows who exists.
 *   - A provider who exists but has seen nobody in 90 days is flagged, because
 *     routing a ticket to someone who has left is worse than not routing it.
 *   - The drift class becomes VISIBLE. When the Console knows a provider and
 *     we can predict the ticketing app will still miss them, that is logged
 *     rather than silently costing the caller five seconds.
 *
 * Never throws and never blocks: if the Console is unreachable this degrades
 * to exactly the string-rule behaviour.
 */
export async function resolveTicketLookupFields(
  input: { lastProviderSeen?: string | null; locationOfLastVisit?: string | null },
  callSid?: string,
): Promise<{ lastProviderSeen?: string; locationOfLastVisit?: string }> {
  const base = sanitizeTicketLookupFields(input, callSid);

  // Lazily imported so the pure string path stays dependency-free and the
  // sanitizer remains testable without a database.
  const { lookupProvider, lookupLocation, isDirectoryConfigured } = await import('./consoleDirectory');
  if (!isDirectoryConfigured()) return base;

  const notes: string[] = [];
  const out = { ...base };

  if (base.lastProviderSeen) {
    try {
      const hit = await lookupProvider(base.lastProviderSeen);
      if (!hit) {
        notes.push(`provider-unknown-to-nextgen:${base.lastProviderSeen}`);
        out.lastProviderSeen = undefined;
      } else if (hit.volume90d === 0) {
        notes.push(`provider-inactive-90d:${hit.canonical}`);
      }
    } catch {
      /* directory unavailable — keep the string-rule answer */
    }
  }

  if (base.locationOfLastVisit) {
    try {
      const hit = await lookupLocation(base.locationOfLastVisit);
      if (hit && hit.facilityKind && hit.facilityKind !== 'clinic') {
        // The ticketing app's `locations` table holds clinics only, so a
        // surgery center or screening site cannot resolve there no matter how
        // it is spelled. Say so once, here, instead of losing it silently.
        notes.push(`location-not-a-clinic:${hit.canonical} (${hit.facilityKind})`);
      } else if (!hit) {
        notes.push(`location-unknown-to-nextgen:${base.locationOfLastVisit}`);
      }
    } catch {
      /* keep the string-rule answer */
    }
  }

  if (notes.length) console.info(`[DIRECTORY] ${callSid ?? ''} ${notes.join(' | ')}`);
  return out;
}
