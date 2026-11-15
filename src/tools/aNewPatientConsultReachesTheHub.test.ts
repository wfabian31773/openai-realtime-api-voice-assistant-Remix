/**
 * v240 — A NEW PATIENT ASKING FOR A CONSULT IS ASKING FOR AN APPOINTMENT.
 *
 * Standing instruction 10: schedule-related goes to the HVA Hub from every
 * queue, except a surgery date. A new patient asking the surgery line for a
 * cataract, LASIK, retina or eyelid consult has no surgery date: they are asking
 * for their first appointment. The router kept every one of them in Surgery
 * Coordination because the request names an operation (v202's `namesAnOperation`
 * keeps a surgery-line request home, and `asksAboutARoutineVisit` stands down on
 * a named procedure).
 *
 * Measured over the fourteen days 2026-10-31 08:00 to 11-14 08:00 UTC, every
 * surgery-line agent ticket filed in department 2 whose description names a new
 * patient (41), the router run over the ticket's own description on `main` and
 * on this build, against the department staff moved it to: 19 change department.
 * Staff had moved 13 of them to the Hub, 4 to Technicians, and left 2 in
 * Surgery. No other ticket in the 41 changes.
 *
 * Every row is the real call SID and ticket number with synthetic words in the
 * shape the agent wrote (RULE THREE: the ticket text stays in the Support
 * Center). RESCUED is red on `main` and green here; the rest pin what does not
 * change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const lookup = vi.fn();
vi.mock('../services/durableTicketFiling', () => ({
  createTicketDurable: (...args: unknown[]) => create(...args),
  postFailureToolResult: (r: unknown) => r,
  repeatFilingFields: () => ({}),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { lookupProviderAndLocation: (...args: unknown[]) => lookup(...args) },
  lookupWasUnavailable: () => false,
}));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: {} }));

import { detectCrossQueue, newPatientAsksForAConsult } from './queueRouting';
import { namesADate } from './surgeryTools';
import { runTool } from './registry';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';

const SURGERY = 2;
const TECH = 3;
const OPTICAL = 1;
const HUB = 9;

beforeEach(() => {
  create.mockReset();
  lookup.mockReset();
  resetGateAttempts();
  resetVerifiedIdentities();
});

type Row = [sid: string, ticket: string, words: string, reason: number];

describe('RESCUED — a new patient asking for a consult files to the HVA Hub, where staff moved it', () => {
  const RESCUED: Row[] = [
    ['CA973e5f0cbf9befd3636f4ec27ea9a4b2', 'VA-79288',
      'New patient wants an appointment with an ophthalmologist for cataract surgery in the right eye.', 146],
    ['CAe04c939d901c7f5a1bd5e3ad628db2a1', 'VA-79526',
      'New patient referred by his doctor for cataract surgery. He needs an appointment for cataract surgery. He has a referral. He does not know which surgeon yet; he was sent for an evaluation to find out who will do the surgery.', 146],
    ['CA0662b918adc374a9b1ee292c3da0aae4', 'VA-79583',
      'New patient requesting a laser surgery consult. Does not know which surgeon.', 146],
    ['CA228e4c57bd949751ec2efa96978753ea', 'VA-79586',
      'Caller wants to schedule cataract surgery for his wife, a new patient, at the Example office.', 146],
    ['CA86ed50edba2993b7e82c69bc5c5878be', 'VA-79699',
      'New patient wants to schedule a blepharoplasty surgery with Dr. Example.', 146],
    ['CA7d199c9227391dbaf8bba1ed9dc59cc4', 'VA-79784',
      'New patient with referral, wants consultation for Mohs surgery on the lower eyelid.', 146],
    ['CA8e0e192c95343f94aabfa816dbbb598f', 'VA-81296',
      'New patient requesting a consultation for cataract surgery. Referred by an outside optometrist. Referral sent to the medical group with an HMO plan.', 146],
    ['CA82c0d3f36e651fe28c548f1287e115c0', 'VA-81837',
      'New patient scheduling cataract surgery at the Example office. Mother of caller. No surgery date yet. Caller does not know the surgeon.', 146],
    ['CAe89c5fec082bbaf2c9c58da4fdcd6f41', 'VA-82826',
      'New patient requesting a glaucoma operation consultation and appointment.', 146],
    ['CA6207e6dc7016895589b619f44d1aa96f', 'VA-84245',
      'New patient calling to make an appointment for cataract surgery.', 146],
    ['CA0793d747ba8a43479c4214050fc2e43a', 'VA-84410',
      'New patient wants an appointment for strabismus surgery.', 146],
    ['CA673ba5a71cbc7918f25496f1d08d29c8', 'VA-85168',
      'New patient requesting a cataract appointment.', 146],
    ['CA31571a50b33754ca2b7e38bf4f774cea', 'VA-85310',
      'New patient wants to set up a consultation for LASIK surgery.', 146],
  ];
  for (const [sid, ticket, words, reason] of RESCUED) {
    it(`${ticket} (${sid}) files to the Hub as a new appointment`, () => {
      const r = detectCrossQueue(words, SURGERY);
      expect(r).toMatchObject({ departmentId: HUB, requestTypeId: 32, requestReasonId: reason });
    });
  }
});

describe('ELSEWHERE — the Hub now, Technicians where staff moved them (a move still needed, not a new one)', () => {
  const ELSEWHERE: Row[] = [
    ['CA327acb1be15b19ab12da3a2342f59796', 'VA-84575',
      'New patient wants to schedule a retina surgery appointment, not sure of the exact type.', 146],
    ['CAd9904b304f6d4c65d8a1d140a48ad199', 'VA-84754',
      'New patient referred by her doctor for cataract surgery. She would like to make an appointment.', 146],
    ['CAd4ad6c103976a84966ffeafb3fde9d41', 'VA-84954',
      'New patient requesting to schedule a cataract surgery consultation.', 146],
    ['CA15da6daffd25c6862e7f8347ffe8639d', 'VA-82514',
      'First-time patient requesting an appointment on the 8th for eye care at the Example office. No upcoming appointments on file. Caller does not know which surgeon.', 146],
  ];
  for (const [sid, ticket, words, reason] of ELSEWHERE) {
    it(`${ticket} (${sid}) files to the Hub (staff moved it to Technicians; it left Surgery either way)`, () => {
      expect(detectCrossQueue(words, SURGERY)).toMatchObject({ departmentId: HUB, requestReasonId: reason });
    });
  }
});

describe('COST — the Hub now, where staff had left them in Surgery (the accepted cost)', () => {
  it('VA-79539 (CA4416637f37ec9dc9488bfe3de2104c91) files to the Hub', () => {
    expect(detectCrossQueue('New patient requesting a cataract surgery consultation at the Example office.', SURGERY)?.departmentId).toBe(HUB);
  });
  it('VA-83972 (CA15b3b0004dc09fa87fb319d7d173511e) files to the Hub as a specialist referral', () => {
    const r = detectCrossQueue(
      'Patient wants to start the process for cataract surgery in both eyes. New patient starting cataract evaluation, no surgery date yet. Wants to be seen at the Example office.',
      SURGERY,
    );
    expect(r).toMatchObject({ departmentId: HUB, requestReasonId: 152 });
  });
});

describe('UNCHANGED — what the rule does not touch', () => {
  it('VA-85148 (CA091d5e5b1f9094b1a81c6679d96a1b35): a surgery date the caller gave keeps it in Surgery', () => {
    const words = 'Calling for grandmother, surgery on Monday the 16th, wants to know what time the surgery is. New patient. Caller does not know the surgeon. Surgery date given by caller: November 16, 2026';
    expect(detectCrossQueue(words, SURGERY)).toBeNull();
  });
  it('VA-79249 (CAda74b097e1e74a31d49e102e7cb89880): a same-day cancel is not a consult (main\'s route stands)', () => {
    const words = 'New patient calling to cancel her 3 PM appointment today because a family member is sick.';
    expect(newPatientAsksForAConsult(words)).toBe(false);
    expect(detectCrossQueue(words, SURGERY)).toBeNull();
  });
  it('VA-79697 (CAd8bf132cb25b300450036bc1a2f523c5): a status question about surgery approval is not a consult', () => {
    const words = 'New patient asking about documents sent for approval for her eye surgery and wants to know the status.';
    expect(newPatientAsksForAConsult(words)).toBe(false);
    expect(detectCrossQueue(words, SURGERY)).toBeNull();
  });
  // RESIDUES: staff moved these to the Hub too, but nothing in the words asks
  // for an appointment, and reading one in would be a guess.
  const RESIDUE: Array<[string, string, string]> = [
    ['CAccb33175a3da31db07d9eed4f35b8fef', 'VA-79926', 'New patient asking whether their eyes are ready for cataract removal surgery and whether they are a candidate. Second opinion. No surgeon selected yet.'],
    ['CA29ee1cffeeac79c853536077dfa344e0', 'VA-80743', 'New patient wants to pay the amount due for laser surgery upfront.'],
    ['CA990e4e21a7e81865e488b2cfe50392bd', 'VA-82894', 'New patient inquiry about cataract surgery. Caller wants to know if the practice accepts an HMO plan.'],
    ['CA883a06ce6e315cf4a38ad75f4f23966b', 'VA-85303', 'New patient asking for pricing on cataract surgery on both eyes.'],
  ];
  for (const [sid, ticket, words] of RESIDUE) {
    it(`${ticket} (${sid}) stays in Surgery (no ask for an appointment in the words)`, () => {
      expect(newPatientAsksForAConsult(words)).toBe(false);
      expect(detectCrossQueue(words, SURGERY)).toBeNull();
    });
  }
  it('VA-81870 (CA54e44bab4eda04a75135e4282fcc05f7): a new patient whose vision is failing is a clinical complaint, not routed by this rule', () => {
    expect(newPatientAsksForAConsult('New patient asking how much a consultation costs to check their eye because they cannot see well and their vision is failing.')).toBe(false);
  });
  it('VA-80287 (CA613e8f602a61031a51aad8d4672c0d80): a new patient with a symptom is not routed by this rule', () => {
    expect(newPatientAsksForAConsult('New patient was told someone would call about a clinic appointment. Has watery eyes and blurry vision. Wants to schedule that appointment.')).toBe(false);
  });
});

describe('CONTROLS — the rule is about a NEW patient on the SURGERY line', () => {
  it('an existing patient scheduling cataract surgery stays in Surgery', () => {
    expect(detectCrossQueue('Patient wants to schedule cataract surgery on the right eye.', SURGERY)).toBeNull();
  });
  it('"not a new patient" is not a new patient', () => {
    const words = 'Caller is not a new patient; wants to schedule her cataract surgery consultation.';
    expect(newPatientAsksForAConsult(words)).toBe(false);
    expect(detectCrossQueue(words, SURGERY)).toBeNull();
  });
  it('a new patient who already holds an appointment is not asking for one', () => {
    const words = 'New patient has an appointment on the 12th for a cataract consultation and wants to know what to bring.';
    expect(newPatientAsksForAConsult(words)).toBe(false);
  });
  it('a new patient rescheduling an existing booking is the reschedule rule\'s, not this one', () => {
    expect(newPatientAsksForAConsult('New patient needs to reschedule her cataract consultation.')).toBe(false);
  });
  it('a new patient asking to be seen today is not this rule\'s', () => {
    expect(newPatientAsksForAConsult('New patient wants to be seen today for a cataract consultation.')).toBe(false);
  });
  it('Spanish: a new patient asking for a consult reads the same', () => {
    expect(detectCrossQueue('Paciente nuevo quiere una cita para consulta de cirugía de cataratas.', SURGERY)?.departmentId).toBe(HUB);
  });
  it('the rule fires on the surgery line only', () => {
    const words = 'New patient wants an appointment for cataract surgery.';
    expect(newPatientAsksForAConsult(words)).toBe(true);
    // On another line the router's own rules decide; this rule never fires there.
    for (const home of [OPTICAL, TECH]) {
      expect(detectCrossQueue(words, home)?.note ?? '').not.toMatch(/New patient consult/);
    }
  });
  it('a new patient whose surgery is already set, asking about the visit before it, stays in Surgery', () => {
    const words = 'New patient, surgery is on Monday the 16th, wants to schedule the appointment before it.';
    expect(newPatientAsksForAConsult(words)).toBe(false);
    expect(detectCrossQueue(words, SURGERY)).toBeNull();
  });
  it('a surgery date passed by the model keeps it home', () => {
    expect(detectCrossQueue('New patient wants an appointment for cataract surgery.', SURGERY, { surgeryDateGiven: true })).toBeNull();
  });
});

describe('the surgery date the model sent', () => {
  it.each([
    ['', false], ['unknown', false], ['Unknown', false], ['not yet', false], ['N/A', false], ['TBD', false], ['none', false],
    ['when the doctor decides', false], ['after the consultation', false], ['the office will call', false],
    ['11/16/2026', true], ['November 16', true], ['Dec 1', true], ['next Monday', true], ['Monday', true],
    ['el lunes', true], ['diciembre', true], ['el miércoles', true], ['sábado', true],
  ])('%j names a date: %s', (value, expected) => {
    expect(namesADate(value)).toBe(expected);
  });
});

describe('through the filing tool', () => {
  const base = {
    first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '2025550142', location: 'Testville',
    call_sid: 'CA6207e6dc7016895589b619f44d1aa96f',
  };

  it('VA-84245 files to the Hub from file_surgery_ticket', async () => {
    create.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST' });
    lookup.mockResolvedValue({ success: true, locationId: 7 });
    await runTool('file_surgery_ticket', { ...base, request_description: 'New patient calling to make an appointment for cataract surgery.' });
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId: HUB, requestTypeId: 32, requestReasonId: 146 });
  });

  it('a surgery date the model sent keeps it in Surgery Coordination', async () => {
    create.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST' });
    lookup.mockResolvedValue({ success: true, providerId: 88, locationId: 7 });
    await runTool('file_surgery_ticket', {
      ...base, surgeon: 'Synthetic Surgeon', surgery_date: '12/01/2026',
      request_description: 'New patient calling to make an appointment for cataract surgery.',
    });
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId: SURGERY });
  });

  it('a placeholder surgery date does not', async () => {
    create.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST' });
    lookup.mockResolvedValue({ success: true, locationId: 7 });
    await runTool('file_surgery_ticket', {
      ...base, surgery_date: 'unknown',
      request_description: 'New patient calling to make an appointment for cataract surgery.',
    });
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId: HUB });
  });

  it('classify_surgery_request answers the Hub and does not send the model for a surgeon', async () => {
    const r = await runTool('classify_surgery_request', { request_description: 'New patient requesting a cataract appointment.' });
    expect(r).toMatchObject({ success: true, department_id: HUB });
    expect(String((r as Record<string, unknown>).fix)).toMatch(/Do not ask for a surgery date or surgeon/);
  });
});
