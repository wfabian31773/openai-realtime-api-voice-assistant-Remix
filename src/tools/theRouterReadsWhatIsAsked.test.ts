/**
 * v205 — FIVE ROUTING MISSES IN v202 (#450).
 *
 * Operator, 2026-11-11: "v202: five routing misses. For example, a request for
 * visit notes moves from Surgery to the HVA Hub. A contact lens allergic
 * reaction goes to Optical even though it's a symptom. 'Needs scheduling for
 * an eye exam' stays in Surgery."
 *
 *   1. A document request that names a visit ("the visit notes", "the report
 *      from her last eye visit") was read as a routine-visit question on the
 *      surgery line and sent to the HVA Hub.
 *   2. A contact-lens complaint the shared symptom list does not know (an
 *      allergic reaction, an itch, an irritation, an infection) went from the
 *      medication line to Optical.
 *   3. "Needs scheduling for an eye exam" stayed in Surgery: the surgery
 *      taxonomy reads "needs scheduling" as surgery scheduling.
 *   4. The same phrase kept an after-hours appointment request out of the Hub.
 *   5. A drug named beside the lenses ("lost his contacts and needs a refill of
 *      his eye drops") went to Optical as a lens request.
 *
 * Measured over the fourteen Pacific days 2026-10-28..11-10 (Support Center
 * agent tickets): the change moves 1 surgery-line ticket (the one below, filed
 * to the Hub by v202's rule, moved by staff to the OCS Hub; it now stays in
 * Surgery Coordination); the 10 tech-line contact-lens tickets staff moved to
 * Optical still go to Optical; no ticket in the window had shapes 2 to 5.
 *
 * The real SIDs carry synthetic words in the same shape (RULE THREE: the
 * calls' own words stay on disk). Shapes 2 to 5 had no production call in the
 * window and use the operator's own examples.
 */
import { describe, expect, it } from 'vitest';
import { detectCrossQueue, namesAProcedure, asksAboutARoutineVisit } from './queueRouting';
import { routeAfterHoursTicket } from '../services/afterHoursRouting';

const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HUB = 9;

const departmentFor = (text: string, home: number) => detectCrossQueue(text, home)?.departmentId ?? home;

describe('1. a visit named only as a document\'s source stays on the surgery line', () => {
  it('CAdec68c02dd191c1a5387288ba30d2371: the report from her last eye visit (v202 sent it to the Hub)', () => {
    expect(departmentFor('Patient cannot sign the form online to get her report from her last eye visit.', SURGERY)).toBe(SURGERY);
  });

  it.each([
    'Patient needs a copy of the visit notes.',
    'Caller requesting the notes from her visit with the doctor.',
    'Patient needs a copy of the visit summary.',
    'Patient wants the notes from her last appointment.',
    'Patient needs the office visit notes sent to her primary doctor.',
  ])('stays home: %s', (text) => {
    expect(asksAboutARoutineVisit(text)).toBe(false);
    expect(departmentFor(text, SURGERY)).toBe(SURGERY);
  });

  it('a document and an ask for a visit still reach the Hub', () => {
    expect(departmentFor('Patient wants the visit notes and needs to book a new appointment.', SURGERY)).toBe(HUB);
    expect(departmentFor('Patient needs the visit notes and wants to set up a follow-up visit.', SURGERY)).toBe(HUB);
    expect(departmentFor('Patient wants the visit notes and needs to schedule a follow-up.', SURGERY)).toBe(HUB);
  });

  it('CA643d797c4828b526435323ffbba61055: a new patient with a referral note still reaches the Hub (staff moved it there)', () => {
    expect(departmentFor('New patient requesting an appointment, prefers a Friday morning. Has a referral note from her doctor.', SURGERY)).toBe(HUB);
  });

  it('CA9c0d50619cde06d1cb91a90a6fd6cc3d: a visit question that mentions "her record" still reaches the Hub', () => {
    expect(departmentFor('Caller wants to confirm her appointment Monday at 9 AM. No upcoming appointments appear on her record.', SURGERY)).toBe(HUB);
  });

  it('CAd80329fcc979672995b2567f8d9df1c4: "note" as a verb is not a document (staff moved it to the Hub)', () => {
    expect(departmentFor('Patient has an appointment on November 1st and does not know the details. He authorizes his daughter to receive and note all information on his behalf.', SURGERY)).toBe(HUB);
  });
});

describe('2. a contact-lens symptom stays clinical on the medication line', () => {
  it.each([
    'Patient is having an allergic reaction to her contact lenses.',
    'Contacts are irritating her eyes.',
    'Her contacts make her eyes itchy.',
    'Patient thinks she has an infection from her contact lenses.',
    'Contact lens is stinging and her eye is watering.',
  ])('stays on tech: %s', (text) => {
    expect(departmentFor(text, TECH)).toBe(TECH);
  });

  it('a scratched LENS is the lens, and goes to Optical', () => {
    expect(departmentFor('My contact lens is scratched and I need a replacement.', TECH)).toBe(OPTICAL);
  });
});

describe('5. a drug named beside the lenses stays on the medication line', () => {
  it.each([
    'Patient lost his contacts and needs a refill of his eye drops.',
    'Wears contacts and needs her eye drop medication refilled.',
    'Needs a refill of her antibiotic ointment; she wears contacts.',
  ])('stays on tech: %s', (text) => {
    expect(departmentFor(text, TECH)).toBe(TECH);
  });

  it.each([
    ['CA444500efdd1ba99d15c7f34e093da403', 'Refill of contact lenses, the monthly brand, pharmacy CVS. Prescribing doctor unknown.'],
    ['CA43b05c8beac54114998f1a502448e34c', 'Patient needs a refill of her contact lens prescription. Pharmacy is CVS.'],
    ['CA83cb23171ebbdf9a4893f637d3953295', 'Patient wants her contact lens prescription extended and emailed. She is not using a pharmacy.'],
  ])('%s: a lens refill at a pharmacy is still Optical\'s (staff moved all 10 there)', (_sid, text) => {
    expect(departmentFor(text, TECH)).toBe(OPTICAL);
  });

  it('drops made for the lens are the lens\'s', () => {
    expect(departmentFor('Needs rewetting drops for her contacts.', TECH)).toBe(OPTICAL);
  });
});

describe('3. "needs scheduling" for an eye exam reaches the Hub from the surgery line', () => {
  it.each([
    'Patient needs scheduling for an eye exam.',
    'Needs scheduling for her annual exam.',
    'Patient has not been scheduled for her eye exam yet.',
  ])('reaches the Hub: %s', (text) => {
    expect(namesAProcedure(text)).toBe(false);
    expect(departmentFor(text, SURGERY)).toBe(HUB);
  });

  it.each([
    'Patient needs scheduling.',
    'Patient needs scheduling after her eye exam.',
    'Surgery needs scheduling, she had her eye exam last week.',
    'Patient needs to reschedule her surgery.',
    'Needs scheduling for an eye exam before her cataract surgery.',
    'Needs scheduling for a vitrectomy and an eye exam.',
    'Needs scheduling for an eye exam and her sx date.',
  ])('the surgery-date exception holds, stays home: %s', (text) => {
    expect(departmentFor(text, SURGERY)).toBe(SURGERY);
  });
});

describe('4. the same phrase after hours', () => {
  const now = new Date('2026-11-11T05:00:00Z');
  it('an after-hours "needs scheduling for an eye exam" reaches the Hub', () => {
    expect(routeAfterHoursTicket({ text: 'Patient needs scheduling for an eye exam.', appointmentIntent: true, now }).kind).toBe('scheduling');
  });

  it.each([
    'Needs scheduling.',
    'Reschedule my cataract surgery.',
    'Needs scheduling after her eye exam.',
  ])('leaves the app to route: %s', (text) => {
    expect(routeAfterHoursTicket({ text, appointmentIntent: true, now }).kind).toBe('default');
  });
});
