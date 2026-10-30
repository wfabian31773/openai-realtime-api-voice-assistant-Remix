/**
 * Location-acceptance helpers shared by the patient tools and the agents.
 * Kept free of tool registration so agents can import it statically
 * (see toolModulesAreImportedOneWay.test.ts).
 */

import type { TicketLocationSource, ValidatedPatient } from './ticketIdentity';

export interface TicketRoutingFields {
  departmentId?: number;
  validatedPatient?: ValidatedPatient;
  locationOfLastVisit?: string;
  /** Omitted on legacy caller input. Every automatic hydration must set history. */
  locationSource?: TicketLocationSource;
  locationId?: number;
  /** Defaults to the text's source when the ID was resolved from that text. */
  locationIdSource?: TicketLocationSource;
}

/** Apply facility policy at the final boundary, including previously hydrated text/IDs. */
export async function filterTicketRouting<T extends TicketRoutingFields>(params: T, fillMissing = false): Promise<T> {
  const optical = params.departmentId === 1 || params.departmentId === undefined;
  const patient = optical && params.validatedPatient
    ? await filterOpticalPatientLocations(params.validatedPatient) : params.validatedPatient;
  let office = params.locationOfLastVisit;
  let source = params.locationSource;
  const historyId = (params.locationIdSource ?? params.locationSource) === 'history';
  let acceptedHistoryOffice: string | undefined;
  if (optical && (source === 'history' || historyId)) {
    acceptedHistoryOffice = await mostRecentAcceptable(office?.trim() ? [office] : [], 'optical') || undefined;
    if (source === 'history') office = acceptedHistoryOffice;
  }
  if (!office?.trim() && (fillMissing || source === 'history')) {
    office = patient?.nextAppointment?.location || patient?.lastVisit?.location || patient?.confirmedClinic;
    if (office) source = 'history';
  }
  // A lookup ID resolved from rejected history still routes the ticket even
  // after its text was removed. Never retain that ID against a replacement
  // clinic. An independently caller-supplied ID keeps its own provenance.
  const dropId = optical && historyId && (!acceptedHistoryOffice || office !== params.locationOfLastVisit);
  return { ...params,
    ...(patient ? { validatedPatient: patient } : {}),
    ...(office !== undefined || 'locationOfLastVisit' in params ? { locationOfLastVisit: office } : {}),
    ...(source ? { locationSource: source } : {}),
    ...(dropId ? { locationId: undefined } : {}) };
}

/** Which queue is asking. Injected as call context, never a model argument. */
export type ToolQueue = 'optical' | 'surgery';

/** What kind of place this queue can actually action a request at. */
export function acceptsFacility(queue: ToolQueue | undefined, kind: string | null | undefined): boolean {
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

/** Filter a ticket's carried history without changing the held identity for other queues. */
export async function filterOpticalPatientLocations(patient: ValidatedPatient): Promise<ValidatedPatient> {
  const offices = new Map<string, Promise<string | null>>();
  const acceptable = async (office?: string) => {
    if (!office) return undefined;
    if (!offices.has(office)) offices.set(office, mostRecentAcceptable([office], 'optical'));
    return (await offices.get(office)) || undefined;
  };
  const [nextOffice, lastOffice, usualOffice] = await Promise.all([
    acceptable(patient.nextAppointment?.location), acceptable(patient.lastVisit?.location),
    acceptable(patient.confirmedClinic),
  ]);
  // The receiver prefers joined appointments over the fallback office.
  return { ...patient,
    nextAppointment: nextOffice ? patient.nextAppointment : undefined,
    lastVisit: lastOffice ? patient.lastVisit : undefined,
    confirmedClinic: usualOffice,
  };
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
export async function mostRecentAcceptable(
  locations: string[],
  queue: ToolQueue | undefined,
  deadlineAt?: number,
): Promise<string | null> {
  if (locations.length === 0) return null;

  /**
   * THE LAST UNBOUNDED AWAIT BEFORE THE TOOL ANSWERS.
   *
   * Codex P1 round 3 on PR #292. `lookupLocation` reads a cached snapshot, but
   * a COLD OR STALE one triggers a refresh with a 5s connection timeout — and
   * this is a LOOP, one lookup per past location. The 250ms margin covers
   * building the result, not a database round trip, so `runTool`'s race can
   * still fire here and discard an identity the join went to some trouble to
   * preserve.
   *
   * MY CHANGE MADE THIS REACHABLE, which is why it belongs in this PR rather
   * than in #68. Before the PersonID join a mirror-identified caller had NO
   * past locations, so this returned `null` immediately; now they have several
   * and the loop runs. The join created the population that pays this cost.
   *
   * Out of time falls back to `locations[0]` — the raw most-recent office —
   * which is exactly what this function already does when the directory is
   * unconfigured or a lookup throws. A known fallback, not a new behaviour:
   * the office is unrefined, `resolve_location` is still the gate that
   * matters, and the caller keeps their identity.
   */
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
  if (remaining <= 0) return locations[0];

  const refine = async (): Promise<string | null> => {
    const { lookupLocation, isDirectoryConfigured } = await import('../services/consoleDirectory');
    if (!isDirectoryConfigured()) return locations[0];

    for (const name of locations) {
      try {
        const hit = await lookupLocation(name);
        // An unknown location is more likely an office we have not mirrored
        // than a wrong one, so it is not disqualified here — resolve_location
        // is the gate that matters.
        if (!hit || acceptsFacility(queue, hit.facilityKind)) return name;
      } catch {
        return locations[0];
      }
    }
    return null;
  };

  if (remaining === Infinity) return refine();

  /**
   * CAPPED, not merely pre-checked. Checking the clock BEFORE each lookup
   * bounds nothing: the stall happens INSIDE one call, so the check that
   * matters has to be able to interrupt it. Same shape as the PersonID join —
   * a race, because the catch below only ever covered rejections.
   */
  /**
   * THE LOSING TIMER MUST BE CLEARED. Codex P2 on `ec45286`, and it is the kind
   * of bug this repo has been burned by twice: an instrument that fires when
   * nothing is wrong. Left dangling, the timer runs seconds AFTER the tool has
   * already answered — on every ordinary call, including the cached-directory
   * and unconfigured-directory paths — and logs "ran out of tool budget" for a
   * lookup that did not. That line is meant to be a live counter of a real
   * failure; firing it on success makes it count nothing. It also holds the
   * closure alive until the deadline.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      refine(),
      new Promise<string | null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            '[TOOLS] lookup_patient: the office refinement ran out of tool budget — ' +
              'using the most recent office unrefined',
          );
          resolve(locations[0]);
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
