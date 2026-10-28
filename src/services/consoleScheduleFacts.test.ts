/**
 * The Console's schedule mirror, shaped like a Hub `Schedule` row.
 *
 * Pure mapping tests: labels, status, doctor type, times. The join's wiring is
 * proven in `lookupJoinReadsTheConsole.test.ts`, through the real service.
 */
import { describe, it, expect } from 'vitest';
import {
  toScheduleRow,
  hubOfficeLabel,
  hubOfficeType,
  hubProviderLabel,
  hubDoctorType,
  endTimeHHMM,
  FACTS_FOR_PERSON_SQL,
  type ConsoleFactRow,
} from './consoleScheduleFacts';

const fact = (over: Partial<ConsoleFactRow> = {}): ConsoleFactRow => ({
  appointment_id: '00000000-0000-4000-8000-000000000001',
  appointment_date: '2026-10-15',
  begin_time: '0930',
  duration: 15,
  event_name: 'Follow Up',
  is_cancelled: false,
  is_rescheduled: false,
  is_kept: null,
  person_id: '00000000-0000-4000-8000-0000000000aa',
  equipment_only: false,
  location_name: 'Azul Vision San Bernardino',
  facility_kind: 'clinic',
  provider_name: 'Example Surgeon, M.D.',
  provider_type: 'Retina',
  first_name: 'Test',
  last_name: 'Patient',
  date_of_birth: '1970-01-01',
  email: null,
  cell_phone: null,
  home_phone: null,
  language: null,
  ...over,
});

describe('office labels are the Hub\'s, so routing does not change under the readers', () => {
  it('strips the brand prefix the Console carries and the Hub never did', () => {
    expect(hubOfficeLabel('Azul Vision San Bernardino')).toBe('San Bernardino');
    expect(hubOfficeLabel('Atlantis Eyecare Long Beach')).toBe('Long Beach');
    expect(hubOfficeLabel('Azul Vision Pasadena')).toBe('Pasadena');
  });
  it('uses the learned override where the prefix rule would be wrong', () => {
    expect(hubOfficeLabel('Azul Vision DTLA')).toBe('Downtown LA');
    expect(hubOfficeLabel('Azul Vision Mission Hlls')).toBe('Mission Hills');
    expect(hubOfficeLabel('Azul Vision Willow')).toBe('Long Beach Willow');
    expect(hubOfficeLabel('Atlantis Surgery Center At Montebello')).toBe('Montebello ASC');
    expect(hubOfficeLabel('Azul Vision Virtual Visit')).toBe('Virtual Visits');
  });
  it('speaks the current clinic name for a historical schedule label', () => {
    expect(hubOfficeLabel('North Valley Eye')).toBe('Mission Hills');
    expect(toScheduleRow(fact({ location_name: 'North Valley Eye' })).officeLocation).toBe('Mission Hills');
  });
  it('folds every offsite screening site under the DRS van, as the Hub did', () => {
    expect(hubOfficeLabel('Inland Empire Offside Fundus Screening')).toBe('Mobile DRS');
    expect(hubOfficeLabel('Mobile DRS Site')).toBe('Mobile DRS');
  });
  it('passes a surgery centre through unchanged, which is how the Hub wrote them', () => {
    expect(hubOfficeLabel('Chevy Chase Surgery Center')).toBe('Chevy Chase Surgery Center');
    expect(hubOfficeLabel(null)).toBeNull();
    expect(hubOfficeLabel('  ')).toBeNull();
  });
  it('types a hospital and a surgery centre as the Hub did, and a screening site as mobile', () => {
    expect(hubOfficeType('clinic')).toBe('Clinic');
    expect(hubOfficeType('surgery_center')).toBe('ASC - Prof');
    expect(hubOfficeType('hospital')).toBe('ASC - Prof');
    expect(hubOfficeType('screening_site')).toBe('Mobile');
    expect(hubOfficeType('admin')).toBeNull();
  });
});

describe('provider labels drop the dots the Hub never carried', () => {
  it('"M.D." and "O.D." become "MD" and "OD"', () => {
    expect(hubProviderLabel('Paymohn Example, M.D.')).toBe('Paymohn Example, MD');
    expect(hubProviderLabel('Rex Example, O.D.')).toBe('Rex Example, OD');
    expect(hubProviderLabel('Phoebe Example, O,D.')).toBe('Phoebe Example, OD');
    expect(hubProviderLabel('Cindy Example, P.A.')).toBe('Cindy Example, PA');
  });
  it('leaves a name with no degree, or an already dotless one, alone', () => {
    expect(hubProviderLabel('Sharon Example OD')).toBe('Sharon Example OD');
    expect(hubProviderLabel('Jay Example, MD')).toBe('Jay Example, MD');
    expect(hubProviderLabel(null)).toBeNull();
  });
});

describe('doctor type feeds the surgeon rule exactly as the Hub column did', () => {
  it('Retina and MD are surgeons; a DO is typed MD; an OD is not', () => {
    expect(hubDoctorType('Retina', false)).toBe('Retina');
    expect(hubDoctorType('MD ', false)).toBe('MD');
    expect(hubDoctorType('DO', false)).toBe('MD');
    expect(hubDoctorType('OD', false)).toBe('OD');
    expect(hubDoctorType(null, false)).toBeUndefined();
  });
  it('a slot with a resource and no provider is Equipment, so a machine is never the last physician', () => {
    expect(hubDoctorType('Retina', true)).toBe('Equipment');
    const row = toScheduleRow(fact({ equipment_only: true, provider_name: null, provider_type: null }));
    expect(row.doctorType).toBe('Equipment');
    expect(row.renderingPhysician).toBeNull();
  });
});

describe('the row buildContext receives', () => {
  it('follows the NextGen Bible §2 order: kept > rescheduled > cancelled (rewritten for v104)', () => {
    // Until v104 this asserted a moved appointment was Active — which is how a
    // caller heard about an appointment NextGen had already moved.
    expect(toScheduleRow(fact()).appointmentStatus).toBe('Active');
    expect(toScheduleRow(fact({ is_cancelled: true })).appointmentStatus).toBe('Removed');
    expect(toScheduleRow(fact({ is_rescheduled: true })).appointmentStatus).toBe('Removed');
    expect(toScheduleRow(fact({ is_rescheduled: true, is_cancelled: true })).appointmentStatus).toBe('Removed');
    // Kept wins even on a rescheduled row: the screen shows it Kept (Bible §2.1).
    expect(toScheduleRow(fact({ is_rescheduled: true, is_kept: true })).appointmentStatus).toBe('Active');
  });
  it('carries the kept flag as it came, unknown included', () => {
    expect(toScheduleRow(fact({ is_kept: true })).appointmentKept).toBe(true);
    expect(toScheduleRow(fact({ is_kept: false })).appointmentKept).toBe(false);
    expect(toScheduleRow(fact()).appointmentKept).toBeNull();
    expect(FACTS_FOR_PERSON_SQL).toMatch(/f\.is_kept/);
  });
  it('carries the Hub labels, the HHMM start, the computed end, and the person', () => {
    const row = toScheduleRow(fact());
    expect(row.officeLocation).toBe('San Bernardino');
    expect(row.officeLocationType).toBe('Clinic');
    expect(row.renderingPhysician).toBe('Example Surgeon, MD');
    expect(row.providerFromAppt).toBe('Example Surgeon, MD');
    expect(row.doctorType).toBe('Retina');
    expect(row.appointmentStart).toBe('0930');
    expect(row.appointmentEnd).toBe('0945');
    expect(row.appointmentDate).toBe('2026-10-15');
    expect(row.personId).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(row.serviceCategory1).toBe('Follow Up');
    expect(row.patientFirstName).toBe('Test');
    expect(row.patientLastName).toBe('Patient');
    expect(row.patientDateOfBirth).toBe('1970-01-01');
  });
  it('refuses an unreadable time rather than inventing one', () => {
    expect(toScheduleRow(fact({ begin_time: '9:30' })).appointmentStart).toBeNull();
    expect(endTimeHHMM('2400', 10)).toBeNull();
    expect(endTimeHHMM('2350', 20)).toBe('0010');
    expect(endTimeHHMM('0930', null)).toBeNull();
  });
});

describe('the statement', () => {
  it('is parameterised on the person and the cap and nothing else, so its text is constant', () => {
    expect(FACTS_FOR_PERSON_SQL).toContain('$1::uuid');
    expect(FACTS_FOR_PERSON_SQL).toContain('LIMIT $2');
    expect(FACTS_FOR_PERSON_SQL).not.toMatch(/\$3/);
    expect(FACTS_FOR_PERSON_SQL).toMatch(/FROM public\.si_appointment_facts f/);
    expect(FACTS_FOR_PERSON_SQL).toMatch(/LEFT JOIN public\.patients_master pm ON pm\.person_id = f\.person_id/);
  });
});
