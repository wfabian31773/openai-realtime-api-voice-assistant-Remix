import { confirmedClinicFor, nameKey, verifiedIdentityFor, type VerifiedIdentity, type IdentityAppointment } from './verifiedIdentity';
import { readDobQuietly } from './dobParts';
import { spokenDobFor } from './spokenDob';
import type { PatientScheduleContext, AppointmentSummary } from '../services/scheduleLookupService';

export type { IdentityAppointment } from './verifiedIdentity';
/** Internal routing metadata. Never supplied by a model; retained by the outbox. */
export type TicketLocationSource = 'caller' | 'history';
export interface ValidatedPatient {
  status: 'validated'; callSid: string; personId?: string;
  firstName: string; lastName: string; dateOfBirth?: string; confirmedClinic?: string;
  nextAppointment?: IdentityAppointment; lastVisit?: IdentityAppointment;
}
const value = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const isoDOB = (v?: string) => { const d = v ? readDobQuietly(v) : null; return d ? `${d.year}-${d.month}-${d.day}` : undefined; };
/**
 * What a lookup's context adds to the held identity beyond the name and date
 * of birth: the joined appointments, and (v179) the other charts' last names
 * when one patient is charted twice. Every identity write spreads this, so
 * the aliases reach the store on every lane that locks a lookup (Codex P2 on
 * #430: the after-hours lane's two writes left them out).
 */
export function joinedAppointments(context: PatientScheduleContext): Pick<VerifiedIdentity, 'nextAppointment' | 'lastVisit' | 'usualOffice' | 'lastPhysicianSeen' | 'lastProviderSeen' | 'alsoKnownAs'> {
  const convert = (a?: AppointmentSummary): IdentityAppointment | undefined => a?.isoDate && a.location && a.location !== 'Unknown'
    ? { date: a.isoDate.slice(0, 10), location: a.location, ...(a.provider && a.provider !== 'Unknown' ? { provider: a.provider } : {}) } : undefined;
  const nextAppointment = convert(context.upcomingAppointments?.[0]);
  const lastVisit = convert(context.pastAppointments?.[0]);
  return { ...(nextAppointment ? { nextAppointment } : {}), ...(lastVisit ? { lastVisit } : {}),
    ...(context.alsoKnownAs?.length ? { alsoKnownAs: context.alsoKnownAs } : {}),
    ...(context.lastPhysicianSeen ? { lastPhysicianSeen: context.lastPhysicianSeen } : {}),
    ...(context.lastProviderSeen ? { lastProviderSeen: context.lastProviderSeen } : {}),
    ...((nextAppointment?.location || lastVisit?.location || context.lastLocationSeen) ? { usualOffice: nextAppointment?.location || lastVisit?.location || context.lastLocationSeen } : {}) };
}
export function validatedPatientFor(callSid?: string, first?: string, last?: string, dob?: string): ValidatedPatient | undefined {
  const held = verifiedIdentityFor(callSid);
  if (!held || !callSid) return undefined;
  // v179: a patient charted twice answers to either chart's last name.
  const knownLast = [held.lastName, ...(held.alsoKnownAs ?? [])].map((l) => nameKey(l));
  // v199: and to a spelling of the first name the person base accepted as
  // this patient with the date of birth on this call (`heardAs`).
  const knownFirst = [held.firstName, ...(held.heardAs ?? [])].map((f) => nameKey(f));
  if ((first && !knownFirst.includes(nameKey(first))) || (last && !knownLast.includes(nameKey(last)))) return undefined;
  if (dob && isoDOB(dob) && isoDOB(held.dateOfBirth) && isoDOB(dob) !== isoDOB(held.dateOfBirth)) return undefined;
  return { status: 'validated', callSid, firstName: held.firstName, lastName: held.lastName,
    ...(held.personId ? { personId: held.personId } : {}),
    ...(isoDOB(held.dateOfBirth) ? { dateOfBirth: isoDOB(held.dateOfBirth) } : {}),
    ...(held.usualOffice ? { confirmedClinic: held.usualOffice } : {}),
    ...(held.nextAppointment ? { nextAppointment: held.nextAppointment } : {}),
    ...(held.lastVisit ? { lastVisit: held.lastVisit } : {}) };
}
/** A held identity alone does not establish whose appointments are cached. */
export function scheduleMatchesIdentity(
  context: PatientScheduleContext | undefined,
  identity: ValidatedPatient | undefined,
): context is PatientScheduleContext {
  if (!identity || !context?.patientFound || context.matchedBy !== 'name_and_dob' ||
      context.identity?.unique !== true || context.identityUnconfirmed) return false;
  const patient = context.patientData;
  if (patient?.personId && identity.personId && patient.personId !== identity.personId) return false;
  const dob = isoDOB(patient?.dateOfBirth);
  return nameKey(patient?.firstName) === nameKey(identity.firstName) &&
    nameKey(patient?.lastName) === nameKey(identity.lastName) &&
    Boolean(dob && dob === identity.dateOfBirth);
}
export function ticketIdentityFields(callSid: string, first: string, last: string, dob?: string, clinic?: string) {
  const validatedPatient = validatedPatientFor(callSid, first, last, dob);
  if (!validatedPatient) return {};
  // Optical's caller-named fallback must agree with the carried context at
  // the receiver. Joined appointment history still outranks this fallback.
  if (clinic && !validatedPatient.nextAppointment && !validatedPatient.lastVisit) validatedPatient.confirmedClinic = clinic;
  return { validatedPatient };
}
/**
 * v258: the names a create-ticket payload carries beside its validated patient.
 *
 * The validated patient carries the record's names (`validatedPatientFor`),
 * and the ticketing app refuses a payload whose names differ from them
 * (`applyValidatedPatient`: "Invalid or conflicting validated patient
 * context"). The held person answers to more than the record's spelling: a
 * first name the person base accepted with the date of birth (`heardAs`, v199)
 * and the other chart's last name (`alsoKnownAs`, v179). So a filing in the
 * caller's spelling was refused, and the request filed only at teardown, after
 * the caller had gone. The record wins (RULE ZERO step 4).
 *
 * Returns the record's names only when the payload's names are names the held
 * person answers to AND the attached patient is that held person, by its person
 * id and date of birth, not its name alone; anything else is left for the app
 * to refuse, never written over with another person's name.
 */
export function recordNamesFor(
  callSid: string | undefined, first: string | undefined, last: string | undefined, dob: string | undefined,
  attached: ValidatedPatient | undefined,
): { firstName: string; lastName: string } | undefined {
  if (!attached || !callSid || attached.callSid !== callSid) return undefined;
  const same = validatedPatientFor(callSid, first, last, dob);
  if (!same) return undefined;
  // The attached patient is the held person only when a key says so: the same
  // person id and the same date of birth, present or absent on both, and at
  // least one of them present. A shared record name with neither key (two
  // people charted under one name, a parent and a child) is not proof, so the
  // payload is left for the app to refuse (Codex P1 on #506).
  const attachedDob = isoDOB(attached.dateOfBirth);
  if (same.personId !== attached.personId || same.dateOfBirth !== attachedDob) return undefined;
  if (!same.personId && !same.dateOfBirth) return undefined;
  if (nameKey(same.firstName) !== nameKey(attached.firstName) || nameKey(same.lastName) !== nameKey(attached.lastName)) return undefined;
  return { firstName: attached.firstName, lastName: attached.lastName };
}
/**
 * Shared live filing gate: ask one missing field, never ask for held facts.
 * `recordNames` (the queue lanes' filing tools, v258) files a validated
 * patient under the record's names, not the caller's spelling of them.
 */
export function prepareTicketIdentity(input: Record<string, unknown>, opts: { recordNames?: boolean } = {}): { input: Record<string, unknown>; missing?: string; message?: string } {
  const match = validatedPatientFor(value(input.call_sid), value(input.first_name), value(input.last_name), value(input.date_of_birth));
  const filled = { ...input };
  if (!value(filled.location)) {
    const callerClinic = confirmedClinicFor(value(input.call_sid));
    if (callerClinic) {
      filled.location = callerClinic;
      filled.locationSource = 'caller' satisfies TicketLocationSource;
    }
  }
  if (match) {
    filled.first_name = opts.recordNames ? match.firstName : value(input.first_name) || match.firstName;
    filled.last_name = opts.recordNames ? match.lastName : value(input.last_name) || match.lastName;
    if (match.dateOfBirth) filled.date_of_birth = match.dateOfBirth;
    const office = match.nextAppointment?.location || match.lastVisit?.location || match.confirmedClinic;
    if (office && !value(filled.location)) {
      filled.location = office;
      filled.locationSource = 'history' satisfies TicketLocationSource;
    }
  }
  if (!isoDOB(value(filled.date_of_birth))) {
    const spoken = spokenDobFor(value(input.call_sid));
    if (spoken) filled.date_of_birth = spoken;
  }
  if (!value(filled.first_name)) return { input: filled, missing: 'first_name', message: 'May I please have the first name?' };
  if (!value(filled.last_name)) return { input: filled, missing: 'last_name', message: 'May I please have the last name?' };
  if (!isoDOB(value(filled.date_of_birth))) return { input: filled, missing: 'date_of_birth', message: 'What is your date of birth, starting with the month, then the day, then the year?' };
  if (!value(filled.location)) filled.location = undefined;
  return { input: filled };
}
