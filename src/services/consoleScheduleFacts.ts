/**
 * THE CONSOLE'S SCHEDULE MIRROR, SHAPED LIKE A HUB `Schedule` ROW.
 *
 * Standing instruction 14 (2026-08-31): one source of truth, the Eye Care
 * Patient Console. Its `si_appointment_facts` IS the schedule mirror (synced
 * from NextGen every few minutes, 129k rows a day). The Hub's own `Schedule`
 * copy was fed by an EDW job the operator retired on 2026-10-01 ("we do not
 * use EDW schedules anymore"), and that job's statement shape is what took the
 * Hub database down at 12:26 UTC that day (CLAUDE.md, the v83 row's
 * neighbour). So the PersonID join — the whole of RULE ZERO step 3 — reads the
 * Console here, and the Hub copy becomes a fallback that goes away with the
 * table.
 *
 * SHAPE, NOT A NEW READER. `buildContext` in `scheduleLookupService` reads a
 * dozen camelCase fields off a Drizzle `Schedule` row (appointmentDate,
 * appointmentStart, appointmentStatus, officeLocation, renderingPhysician,
 * doctorType, serviceCategory1, the patient's name and date of birth, ...).
 * This module returns rows in exactly that shape, so the office ladder, the
 * surgeon rule, the equipment filter and the upcoming/past split behave
 * identically whichever table answered. Nothing downstream learns a new name.
 *
 * THE LABELS ARE THE HUB'S, ON PURPOSE. The Console names offices "Azul Vision
 * San Bernardino" and providers "Paymohn Mahdavi, M.D."; the Hub, and every
 * reader that routes on it (optical by office, surgery by surgeon, the
 * ticketing app's location ids, 5star, Metabase), says "San Bernardino" and
 * "Paymohn Mahdavi, MD". The crosswalk below was learned from the Hub's own
 * rows by `ApptID = appointment_id` on 2026-10-01 — the same method the
 * replacement sync job uses for the Hub table — so the voice app and the Hub
 * copy agree by construction. A Console name with no entry falls back to the
 * Console name with the brand prefix removed, and is logged once.
 *
 * STATUS. The operator ruled on 2026-10-01: "no show or kept is determined by
 * an active status post appointment date." So `is_cancelled` -> 'Removed',
 * everything else -> 'Active'. There is no NoShow on this path.
 *
 * EQUIPMENT. A fact with no rendering provider and a resource is a diagnostic
 * slot (OCT, visual field). The Hub typed those `DoctorType = 'Equipment'`
 * and `buildContext` excludes them from "last physician seen"; the same
 * flag is set here so the surgeon rule cannot pick a machine.
 *
 * ONE IMPORT STYLE (v71): `patientVerification` is reached by dynamic import
 * everywhere in this repo, so it is reached that way here too.
 */

export const CONSOLE_SCHEDULE_ENV = 'OBS_CONSOLE_DATABASE_URL';

/** The Console pool is configured (the same secret `patientVerification` reads). */
export function isConsoleScheduleConfigured(): boolean {
  return Boolean(process.env[CONSOLE_SCHEDULE_ENV]);
}

/** What the Console answers, one row per appointment fact. */
export interface ConsoleFactRow {
  appointment_id: string;
  appointment_date: string; // YYYY-MM-DD
  begin_time: string | null; // HHMM, as the Hub's AppointmentStart
  duration: number | null; // minutes
  event_name: string | null;
  is_cancelled: boolean | null;
  is_rescheduled: boolean | null;
  person_id: string;
  equipment_only: boolean | null;
  location_name: string | null;
  facility_kind: string | null;
  provider_name: string | null;
  provider_type: string | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  email: string | null;
  cell_phone: string | null;
  home_phone: string | null;
  language: string | null;
}

/** A Hub `Schedule` row, as Drizzle would hand it to `buildContext`. */
export interface ScheduleShapedRow {
  appointmentDate: string;
  appointmentStart: string | null;
  appointmentEnd: string | null;
  sessionPartOfDay: string | null;
  appointmentStatus: 'Active' | 'Removed';
  personId: string;
  officeLocation: string | null;
  officeLocationType: string | null;
  renderingPhysician: string | null;
  providerFromAppt: string | null;
  doctorType: string | undefined;
  serviceCategory1: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  patientDateOfBirth: string | null;
  patientEmailAddress: string | null;
  patientCellPhone: string | null;
  patientHomePhone: string | null;
  patientLanguage: string | null;
}

/**
 * The statement. One parameter for the person, one for the row cap, text
 * constant on every call — the opposite of the shape that bloated the Hub.
 */
export const FACTS_FOR_PERSON_SQL = `
SELECT f.appointment_id::text                                   AS appointment_id,
       to_char(f.appointment_date, 'YYYY-MM-DD')                AS appointment_date,
       f.begin_time, f.duration, f.event_name, f.is_cancelled, f.is_rescheduled,
       f.person_id::text                                        AS person_id,
       (f.rendering_provider_id IS NULL AND f.resource_id IS NOT NULL) AS equipment_only,
       l.nextgen_name                                           AS location_name,
       l.facility_kind,
       p.nextgen_name                                           AS provider_name,
       coalesce(p.admin_provider_type, p.provider_type_inferred) AS provider_type,
       pm.first_name, pm.last_name,
       to_char(pm.date_of_birth, 'YYYY-MM-DD')                  AS date_of_birth,
       pm.email, pm.cell_phone, pm.home_phone, pm.language
  FROM public.si_appointment_facts f
  LEFT JOIN public.si_locations   l  ON l.location_id = f.location_id
  LEFT JOIN public.si_providers   p  ON p.provider_id = f.rendering_provider_id
  LEFT JOIN public.patients_master pm ON pm.person_id = f.person_id
 WHERE f.person_id = $1::uuid
 ORDER BY f.appointment_date DESC, f.begin_time DESC NULLS LAST
 LIMIT $2`;

/**
 * Console office name -> the Hub's short label. Learned 2026-10-01 from the
 * Hub's own rows (one `ApptID = appointment_id` sample per Console location);
 * every clinic not listed here is the Console name minus its brand prefix,
 * which is what the Hub wrote for all of them.
 */
export const OFFICE_LABEL_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'Azul Vision DTLA': 'Downtown LA',
  'Azul Vision Mission Hlls': 'North Valley Eye',
  'Azul Vision Willow': 'Long Beach Willow',
  'Azul Vision Riverside Latham': 'Riverside',
  'Azul Vision Virtual Visit': 'Virtual Visits',
  'Atlantis Surgery Center At Montebello': 'Montebello ASC',
  'MemorialCare Outpatient Surgical Center': 'MemorialCare Surgery Center',
  'Mobile DRS Site': 'Mobile DRS',
});

const OFFICE_PREFIXES = ['Azul Vision ', 'Atlantis Eyecare '];

const unmappedLogged = new Set<string>();

/** The Hub's short office label for a Console `si_locations.nextgen_name`. */
export function hubOfficeLabel(nextgenName: string | null | undefined): string | null {
  if (!nextgenName) return null;
  const t = nextgenName.trim();
  if (!t) return null;
  const override = OFFICE_LABEL_OVERRIDES[t];
  if (override) return override;
  if (/offsi[dt]e fundus scree/i.test(t)) return 'Mobile DRS';
  for (const prefix of OFFICE_PREFIXES) {
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim();
  }
  return t;
}

/**
 * Hub `OfficeLocationType` from the Console's `facility_kind`. The Hub typed
 * hospitals and surgery centres alike as "ASC - Prof", and screening sites
 * ride under "Mobile" with the DRS van.
 */
export function hubOfficeType(facilityKind: string | null | undefined): string | null {
  switch ((facilityKind ?? '').trim().toLowerCase()) {
    case 'clinic':
    case 'virtual':
      return 'Clinic';
    case 'surgery_center':
    case 'hospital':
      return 'ASC - Prof';
    case 'mobile':
    case 'screening_site':
      return 'Mobile';
    default:
      return null;
  }
}

/**
 * "Paymohn Mahdavi, M.D." -> "Paymohn Mahdavi, MD". The Hub strips the dots
 * from the degree; the surgeon roster, the transcription hints and the
 * ticketing app's provider ids all carry the dotless form.
 */
export function hubProviderLabel(nextgenName: string | null | undefined): string | null {
  if (!nextgenName) return null;
  const t = nextgenName.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t
    .replace(/,\s*M\.?D\.?$/i, ', MD')
    .replace(/,\s*D\.?O\.?$/i, ', DO')
    .replace(/,\s*O[.,]?D\.?$/i, ', OD')
    .replace(/,\s*P\.?A\.?$/i, ', PA')
    .replace(/,\s*N\.?P\.?$/i, ', NP');
}

const DOCTOR_TYPES = new Set(['MD', 'Retina', 'OD', 'NP', 'PA', 'DO']);

/**
 * Hub `DoctorType` from the Console's provider type. `SURGEON_DOCTOR_TYPES`
 * in `scheduleLookupService` is {MD, Retina}; the Console types DOs as MD
 * already ("Brett Tompkins, DO" -> MD), which is the Hub's convention too.
 */
export function hubDoctorType(providerType: string | null | undefined, equipmentOnly: boolean | null | undefined): string | undefined {
  if (equipmentOnly) return 'Equipment';
  const t = (providerType ?? '').trim();
  if (!t) return undefined;
  if (DOCTOR_TYPES.has(t)) return t === 'DO' ? 'MD' : t;
  return t;
}

/** HHMM + minutes -> HHMM. Anything unreadable stays null. */
export function endTimeHHMM(begin: string | null | undefined, durationMin: number | null | undefined): string | null {
  if (!begin || !/^\d{4}$/.test(begin) || durationMin == null || !Number.isFinite(durationMin)) return null;
  const h = Number(begin.slice(0, 2));
  const m = Number(begin.slice(2, 4));
  if (h > 23 || m > 59) return null;
  const total = h * 60 + m + Math.max(0, Math.trunc(durationMin));
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}${String(em).padStart(2, '0')}`;
}

/** One Console fact -> one Hub-shaped row. Pure; no I/O. */
export function toScheduleRow(f: ConsoleFactRow): ScheduleShapedRow {
  const office = hubOfficeLabel(f.location_name);
  if (f.location_name && office === f.location_name.trim() && !unmappedLogged.has(office)) {
    // A Console name with no crosswalk entry and no brand prefix: surgery
    // centres and hospitals are written identically on both sides, so this is
    // expected for them and worth one line for anything else.
    unmappedLogged.add(office);
    console.info(`[ConsoleSchedule] office label passed through unchanged: ${office}`);
  }
  return {
    appointmentDate: f.appointment_date,
    appointmentStart: f.begin_time && /^\d{4}$/.test(f.begin_time) ? f.begin_time : null,
    appointmentEnd: endTimeHHMM(f.begin_time, f.duration),
    sessionPartOfDay: null,
    appointmentStatus: f.is_cancelled ? 'Removed' : 'Active',
    personId: f.person_id,
    officeLocation: office,
    officeLocationType: hubOfficeType(f.facility_kind),
    renderingPhysician: f.equipment_only ? null : hubProviderLabel(f.provider_name),
    providerFromAppt: f.equipment_only ? null : hubProviderLabel(f.provider_name),
    doctorType: hubDoctorType(f.provider_type, f.equipment_only),
    serviceCategory1: f.event_name ?? null,
    patientFirstName: f.first_name ?? null,
    patientLastName: f.last_name ?? null,
    patientDateOfBirth: f.date_of_birth ?? null,
    patientEmailAddress: f.email ?? null,
    patientCellPhone: f.cell_phone ?? null,
    patientHomePhone: f.home_phone ?? null,
    patientLanguage: f.language ?? null,
  };
}

/**
 * The person's appointment facts from the Console, newest first, as Hub rows.
 * Throws on a Console failure — the caller decides what an unreachable
 * schedule means (it never means "no appointments"; see `lookupByPersonId`).
 */
export async function fetchFactsForPerson(personId: string, limit: number): Promise<ScheduleShapedRow[]> {
  const { getConsolePool } = await import('./patientVerification');
  const { rows } = await getConsolePool().query<ConsoleFactRow>(FACTS_FOR_PERSON_SQL, [personId, limit]);
  return rows.map(toScheduleRow);
}
