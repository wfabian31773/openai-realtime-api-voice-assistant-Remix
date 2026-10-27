import type { PatientScheduleContext } from './scheduleLookupService';

export interface AppointmentClaim {
  provider?: string;
  office?: string;
}

function label(value: string | undefined, kind: keyof AppointmentClaim): string {
  let text = (value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  text = text.replace(/[.,]/g, '');
  text = kind === 'provider'
    ? text.replace(/^dr\s+/, '').replace(/\s+(md|do|od)$/, '')
    : text.replace(/^(azul vision|atlantis eyecare)\s+/, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Read-only view of the joined record. No demographics, persistence or routing. */
export function appointmentAccess(
  context: PatientScheduleContext,
  certain: boolean,
  claim: AppointmentClaim = {},
) {
  if (!certain) return {
    appointment_access: 'identity_required', read_only: true,
    scheduling_action: 'establish_identity',
    appointment_instruction: 'Confirm the patient before reading appointment details. Do not guess between records.',
  };
  if (context.scheduleReadStatus === 'unavailable' ||
      (!context.scheduleReadStatus && !context.patientFound)) return {
    appointment_access: 'unavailable', read_only: true,
    has_upcoming_appointments: null,
    scheduling_action: 'request_schedule_review',
    appointment_instruction: 'The schedule could not be read now. This does not mean there are no bookings. Take a request to check the schedule; do not promise a new booking.',
  };
  const appointments = (context.upcomingAppointments ?? []).map((a) => ({
    date: a.isoDate, time: a.startTime || a.timeOfDay || null,
    time_zone: 'America/Los_Angeles', provider: a.provider, office: a.location,
  }));
  const known = (value: string | undefined) => Boolean(value && value !== 'Unknown');
  const matches = (a: typeof appointments[number], key: keyof AppointmentClaim) =>
    known(a[key]) && label(a[key], key) === label(claim[key], key);
  const checks = (key: keyof AppointmentClaim) => !claim[key]?.trim() ? 'not_requested'
    : appointments.some((a) => matches(a, key)) ? 'matched'
    : context.scheduleTruncated || appointments.some((a) => !known(a[key])) ? 'unknown' : 'not_matched';
  const provider_check = checks('provider');
  const office_check = checks('office');
  const claimed = Boolean(claim.provider?.trim() || claim.office?.trim());
  const booking_details_match = claimed ? appointments.some((a) =>
    (!claim.provider?.trim() || matches(a, 'provider')) &&
    (!claim.office?.trim() || matches(a, 'office'))) : null;
  return {
    appointment_access: context.scheduleTruncated ? 'partial' : 'available',
    read_only: true,
    upcoming_appointments: appointments,
    has_upcoming_appointments: appointments.length > 0 ? true : context.scheduleTruncated ? null : false,
    provider_check, office_check, booking_details_match,
    scheduling_action: claimed && !booking_details_match ? 'clarify_record_difference'
      : appointments.length ? 'review_existing_booking'
      : context.scheduleTruncated ? 'request_schedule_review' : 'take_scheduling_request',
    appointment_instruction: 'You can read these appointments. Before requesting a new one, review existing bookings with the caller to avoid a duplicate. Compare the provider and office on the SAME appointment. If details differ or are unknown, explain what the record shows and clarify the intended request; never replace the record with a guess. Include the existing booking and any unresolved difference in the request. This is read-only: do not promise that anything was booked, changed or cancelled.' +
      (context.scheduleTruncated ? ' This is a partial schedule; absence is not proof there is no booking.' : ''),
  };
}
