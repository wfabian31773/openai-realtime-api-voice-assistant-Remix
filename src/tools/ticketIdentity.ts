import { confirmedClinicFor, nameKey, verifiedIdentityFor, type VerifiedIdentity, type IdentityAppointment } from './verifiedIdentity';
import { readDobQuietly } from './dobParts';
import { spokenDobFor } from './spokenDob';
import type { PatientScheduleContext, AppointmentSummary } from '../services/scheduleLookupService';

export type { IdentityAppointment } from './verifiedIdentity';
export interface ValidatedPatient {
  status: 'validated'; callSid: string; personId?: string;
  firstName: string; lastName: string; dateOfBirth?: string; confirmedClinic?: string;
  nextAppointment?: IdentityAppointment; lastVisit?: IdentityAppointment;
}
const value = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const isoDOB = (v?: string) => { const d = v ? readDobQuietly(v) : null; return d ? `${d.year}-${d.month}-${d.day}` : undefined; };
export function joinedAppointments(context: PatientScheduleContext): Pick<VerifiedIdentity, 'nextAppointment' | 'lastVisit' | 'usualOffice' | 'lastPhysicianSeen' | 'lastProviderSeen'> {
  const convert = (a?: AppointmentSummary): IdentityAppointment | undefined => a?.isoDate && a.location && a.location !== 'Unknown'
    ? { date: a.isoDate.slice(0, 10), location: a.location, ...(a.provider && a.provider !== 'Unknown' ? { provider: a.provider } : {}) } : undefined;
  const nextAppointment = convert(context.upcomingAppointments?.[0]);
  const lastVisit = convert(context.pastAppointments?.[0]);
  return { ...(nextAppointment ? { nextAppointment } : {}), ...(lastVisit ? { lastVisit } : {}),
    ...(context.lastPhysicianSeen ? { lastPhysicianSeen: context.lastPhysicianSeen } : {}),
    ...(context.lastProviderSeen ? { lastProviderSeen: context.lastProviderSeen } : {}),
    ...((nextAppointment?.location || lastVisit?.location || context.lastLocationSeen) ? { usualOffice: nextAppointment?.location || lastVisit?.location || context.lastLocationSeen } : {}) };
}
export function validatedPatientFor(callSid?: string, first?: string, last?: string, dob?: string): ValidatedPatient | undefined {
  const held = verifiedIdentityFor(callSid);
  if (!held || !callSid) return undefined;
  if ((first && nameKey(first) !== nameKey(held.firstName)) || (last && nameKey(last) !== nameKey(held.lastName))) return undefined;
  if (dob && isoDOB(dob) && isoDOB(held.dateOfBirth) && isoDOB(dob) !== isoDOB(held.dateOfBirth)) return undefined;
  return { status: 'validated', callSid, firstName: held.firstName, lastName: held.lastName,
    ...(held.personId ? { personId: held.personId } : {}),
    ...(isoDOB(held.dateOfBirth) ? { dateOfBirth: isoDOB(held.dateOfBirth) } : {}),
    ...(held.usualOffice ? { confirmedClinic: held.usualOffice } : {}),
    ...(held.nextAppointment ? { nextAppointment: held.nextAppointment } : {}),
    ...(held.lastVisit ? { lastVisit: held.lastVisit } : {}) };
}
export function ticketIdentityFields(callSid: string, first: string, last: string, dob?: string, clinic?: string) {
  const validatedPatient = validatedPatientFor(callSid, first, last, dob);
  if (!validatedPatient) return {};
  // Optical's caller-named fallback must agree with the carried context at
  // the receiver. Joined appointment history still outranks this fallback.
  if (clinic && !validatedPatient.nextAppointment && !validatedPatient.lastVisit) validatedPatient.confirmedClinic = clinic;
  return { validatedPatient };
}
/** Shared live filing gate: ask one missing field, never ask for held facts. */
export function prepareTicketIdentity(input: Record<string, unknown>): { input: Record<string, unknown>; missing?: string; message?: string } {
  const match = validatedPatientFor(value(input.call_sid), value(input.first_name), value(input.last_name), value(input.date_of_birth));
  const filled = { ...input };
  if (match) {
    filled.first_name = value(input.first_name) || match.firstName;
    filled.last_name = value(input.last_name) || match.lastName;
    if (match.dateOfBirth) filled.date_of_birth = match.dateOfBirth;
    const office = match.nextAppointment?.location || match.lastVisit?.location || match.confirmedClinic;
    if (office) filled.location = office;
  }
  if (!isoDOB(value(filled.date_of_birth))) {
    const spoken = spokenDobFor(value(input.call_sid));
    if (spoken) filled.date_of_birth = spoken;
  }
  if (!isoDOB(value(filled.date_of_birth))) return { input: filled, missing: 'date_of_birth', message: 'What is your date of birth, starting with the month, then the day, then the year?' };
  if (!value(filled.location)) filled.location = confirmedClinicFor(value(input.call_sid));
  if (!value(filled.location)) return { input: filled, missing: 'location', message: 'Which of our clinics do you visit?' };
  return { input: filled };
}
