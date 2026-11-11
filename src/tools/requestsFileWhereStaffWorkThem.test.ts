/**
 * v202 — REQUESTS FILE WHERE STAFF WORK THEM, ON THE QUEUE LANES.
 *
 * Operator, 2026-11-11: "We're doing more transferring of tickets than
 * anything else … Staff are working too hard chasing down the right person
 * for the tickets." On the Pacific business day 2026-11-10, 121 of 551 agent
 * tickets were moved by staff after filing; a transcript read of every moved
 * ticket named 48 where the agent filed in the wrong department for what the
 * caller said. This file is that corpus for the queue lanes, by the real call
 * SID, with synthetic words in the shape the agent wrote (RULE THREE: the
 * transcripts and ticket text stay on disk and in the Support Center).
 *
 * The before-numbers for each rule are the fourteen Pacific days 2026-10-28..
 * 11-10, every agent ticket on optical, surgery and tech, the router run over
 * the ticket's own description and checked against the department staff moved
 * it to (sweep placeholders excluded). Each block says which rule it pins and
 * what the window measured.
 *
 * Every row is one of: RESCUED (red on main, green here), RESIDUE (what it
 * does today and still does, with the measured reason no rule was written),
 * or CONTROL.
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

import {
  asksAboutARoutineVisit,
  detectCrossQueue,
  examAlreadyHappened,
  namesAnOperation,
} from './queueRouting';
import { runTool } from './registry';
import './surgeryTools';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';

const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HUB = 9;
const PCP = 18;
const RECORDS = 16;

/** Where the router files it: the redirect's department, or the line's own. */
const filedIn = (text: string, home: number) => detectCrossQueue(text, home)?.departmentId ?? home;

describe('A1 — a routine visit asked about on the surgery line files to the HVA Hub', () => {
  // Rule 5 (`asksAboutARoutineVisit`). Window: 60 surgery-line tickets the rule
  // re-routes; staff had moved 37 to the Hub, left 16 in Surgery, moved 7
  // elsewhere (precision 37 of 53).
  const RESCUED: Array<[string, string, string, number]> = [
    ['CAb4ca42c106935a4b672c9063d31ff757', 'VA-83486',
      'Patient called last week and has not had a callback. Wants to know what is planned for the appointment tomorrow at the Example office. Remembers only that it is with an eye specialist.',
      539],
    ['CAed6c0dc49b152be1f3c4a7758b8b33db', 'VA-83000',
      'Patient asking whether the eyes will be dilated at the appointment tomorrow with the optometrist at the Example office.',
      539],
    ['CAbc6f10077feda207f962380ffd1aab79', 'VA-83302',
      'New patient requesting an ophthalmology appointment at the Example office. No surgeon preference.',
      146],
    ['CAd6b43321ac4929f09cd79f5c5ecce6a3', 'VA-83515',
      'Patient has an appointment tomorrow with a doctor at the Example office and wants to know what the visit will involve and how long it will take, because a ride is arranged. Requesting a callback.',
      539],
  ];
  for (const [sid, ticket, words, reason] of RESCUED) {
    it(`${ticket} (${sid}) files to the Hub`, () => {
      const r = detectCrossQueue(words, SURGERY);
      expect(r?.departmentId).toBe(HUB);
      expect(r?.requestReasonId).toBe(reason);
    });
  }

  it('CA2747d986d20c40c8e5111d73689b5472 (VA-83254) — "no surgery date" is a denial, so the checkup goes to the Hub', () => {
    // Staff moved this one to the OCS Hub (15) and then to Technicians; it is
    // a new-patient exam, which standing instruction 10 sends to the Hub. The
    // denial used to fire the `surgery date` cue and keep it in Surgery.
    expect(filedIn('New patient was referred for a general eye checkup/exam. First time patient, no surgery date.', SURGERY)).toBe(HUB);
  });

  // RESIDUE. Same-day: staff left 7 of the 10 same-day visit questions in
  // Surgery Coordination, so the rule stands aside on today's visit.
  it('CA0e88e1440f61e3afd8516aa09f57fcbc (VA-82986) — late for TODAY\'s visit stays in Surgery (residue)', () => {
    expect(filedIn('Patient is lost, could not find the Example office, and arrived late for the 8:10 AM appointment with the optometrist today.', SURGERY)).toBe(SURGERY);
  });
  it('CA1280d8c31eb3c9bd30a37824724aa20a (VA-82877) — "why did you call me" names no visit; stays (residue)', () => {
    expect(filedIn('Patient is asking why we called her and wants the coordinator to explain the reason for the call.', SURGERY)).toBe(SURGERY);
  });
  it('CAaf74c556a87e6672ec4996168e7af421 (VA-83306) — which office is closest names no visit; stays (residue)', () => {
    expect(filedIn('Patient is asking which office and doctors are closest to her area and does not remember which office she went to before. No specific surgery mentioned.', SURGERY)).toBe(SURGERY);
  });
  it('CA50a263798659b80be80d81e1fa9a11b7 (VA-83008) — a past surgery and pain stay in Surgery (correctly refused)', () => {
    expect(filedIn('Had surgery over a week ago. Needs to see a retinal specialist; vision has been getting worse with pain.', SURGERY)).toBe(SURGERY);
  });
  it('CA20fd95377649469add3e5cba7f00383a (VA-83249) — the optical line keeps its appointment questions (residue)', () => {
    // Measured: an optical-line version of rule 5 would have re-routed 23 and
    // staff moved 3 of them to the Hub; 13 stayed in Optical. Not written.
    expect(filedIn('New patient scheduling an appointment for a child at the Example office.', OPTICAL)).toBe(OPTICAL);
  });

  it('the classification tool agrees with the filing, so no surgeon or surgery date is asked', async () => {
    const r = await runTool('classify_surgery_request', {
      request_description: 'Patient asking whether the eyes will be dilated at the appointment tomorrow with the optometrist at the Example office.',
    });
    expect(r).toMatchObject({ success: true, department_id: HUB });
    expect(String((r as Record<string, unknown>).fix)).toMatch(/Do not ask for a surgery date or surgeon/);
  });
});

describe('A2 / A6 — a request naming an operation stays in Surgery Coordination on the surgery line', () => {
  // `namesAnOperation` on the surgery line. Window: 42 tickets the router had
  // sent away (20 to Technicians as medication, 22 to the Hub as a
  // reschedule); staff moved 24 back to Surgery, left 16, moved 2 elsewhere.
  const RESCUED: Array<[string, string, string]> = [
    ['CAfe52c434a7d8bc3d11a66ffccad82c12', 'VA-83079',
      "Patient's surgery is Monday. The doctor was supposed to send prescription drops for the two days before surgery but they have not arrived. Waiting for the drops and the arrival time."],
    ['CAc4dd3cb8a3efc6f4ce66962e0089aa67', 'VA-82247',
      'Do I need to take medication? Surgery is Wednesday at 10:30 AM at the Example office.'],
    ['CA977882a3614b678f53711465b3d461bc', 'VA-83199',
      'Husband calling to confirm she will attend her surgery appointment on Monday at 2 PM. Also asking whether she needs to stop any diabetes medications before surgery.'],
    ['CA779bd776c5faa4bdac59a769bd425e5f', 'VA-83436',
      'Eye drops that need to be prescribed prior to surgery'],
    ['CAa812777d90e8ce9627327bf2f64d0e10', 'VA-83310',
      "Patient's surgery scheduled for last week was cancelled and nobody called to reschedule. She wants to know when her next surgery will be scheduled."],
  ];
  for (const [sid, ticket, words] of RESCUED) {
    it(`${ticket} (${sid}) stays in Surgery Coordination`, () => {
      expect(detectCrossQueue(words, SURGERY)).toBeNull();
    });
  }

  it('the filing tool sends the pre-op drops request to department 2, not Technicians', async () => {
    create.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST' });
    lookup.mockResolvedValue({ success: true, providerId: 88, locationId: 7 });
    await runTool('file_surgery_ticket', {
      first_name: 'Avery', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '2025550142',
      request_description: 'Eye drops that need to be prescribed prior to surgery',
      surgeon: 'Synthetic Surgeon', location: 'Testville',
    });
    expect(create.mock.calls[0][0]).toMatchObject({ departmentId: SURGERY });
  });

  // RESIDUE: the tech line keeps its pre-op and post-op drops. A rule sending
  // them to Surgery would have re-routed 41 in the window and staff moved 16;
  // 22 stayed in Technicians. Not written — the Technicians team works most.
  const TECH_RESIDUE: Array<[string, string, string]> = [
    ['CAe1db0617ba259619029224e76a882131', 'VA-83289',
      'Daughter says the eye drops were ordered to the pharmacy but the pharmacy has no order. Patient needs the drops before her cataract surgery next week.'],
    ['CAcf72ecc43c12815c8db4fbcee38bf13c', 'VA-83054',
      'Patient needs a post-surgery eye drop prescription for her surgery this Thursday. Does not have the prescription.'],
    ['CA7e679b139b984d3aa38cdb9998342b1a', 'VA-83311',
      'Patient was given new drops at the pharmacy and told to stop the old ones. She is 8 days after eye surgery and wants to confirm it is okay.'],
    ['CAb9e700c7b55567685642939f54aa0f1c', 'VA-83048', 'They sent me three prescriptions. I have only two.'],
    ['CAe257a520c7eb3a5a736ff4336be0dc41', 'VA-83327',
      'Patient has questions for the surgical team about her surgery and is requesting an urgent callback.'],
  ];
  for (const [sid, ticket, words] of TECH_RESIDUE) {
    it(`${ticket} (${sid}) on the tech line stays in Technicians (residue)`, () => {
      expect(filedIn(words, TECH)).toBe(TECH);
    });
  }
});

describe('A3 — eyewear goes to Optical', () => {
  // Contact lenses on the medication line: 11 of 11 in the window moved to
  // Optical by staff.
  it('CA304456c360b3151e7f5fd9ccc06a75ec (VA-83092) — contact lens refills on the tech line go to Optical', () => {
    const r = detectCrossQueue('Caller left a message yesterday about contact lens refills and has no update. Does not know which lenses she needs. Pharmacy is on file.', TECH);
    expect(r).toMatchObject({ departmentId: OPTICAL, requestTypeId: 3, requestReasonId: 11 });
  });
  it('CA33ace8b00a74e8fb6a52e8be559c32e5 (VA-83556) — a contact lens reorder to pick up is an order', () => {
    const r = detectCrossQueue('Patient needs to reorder contact lenses, the same brand as before, to pick them up at the Example office.', TECH);
    expect(r).toMatchObject({ departmentId: OPTICAL, requestTypeId: 3, requestReasonId: 11 });
  });

  // An exam that already happened: window, 8 re-routed, 4 moved to Optical by
  // staff, 1 left in the Hub, 3 elsewhere.
  it('CA895ad2d3df9a92cde77b253106e2feeb (VA-83402) — a glasses prescription from a past exam goes to Optical, not the Hub', () => {
    expect(filedIn('Patient needs a copy of the eyeglass prescription written after the eye exam, to order glasses as soon as possible.', TECH)).toBe(OPTICAL);
  });
  it('CA01323c19a55f083716b07eb96603fe34 (VA-83245) — on the optical line it stays in Optical', () => {
    expect(filedIn('Patient had an eye exam about a week ago and asked for her glasses prescription to be mailed. It has not arrived and she wants the status.', OPTICAL)).toBe(OPTICAL);
  });

  // The operation word on the optical line, with no eyewear and no symptom:
  // 2 of 2 in the window moved to Surgery.
  it('CA88d1812f358d31c2e11794c997d2e8cc (VA-82997) — a message for the surgical coordinator on the optical line goes to Surgery', () => {
    expect(filedIn('Urgent message for the surgical coordinator regarding eye surgery. Previous follow-ups have not happened.', OPTICAL)).toBe(SURGERY);
  });

  it('CA9f03c2bf356e08bfa9e5cfbb015807e0 (VA-82993) — a callback in Spanish from a clinic names nothing to route (residue)', () => {
    expect(filedIn('Mother of the patient requests a callback in Spanish from the clinic, at her own cell.', SURGERY)).toBe(SURGERY);
  });
});

describe('A4 — records requests are NOT redirected into Medical Records (residue, a policy question)', () => {
  // A rule would have re-routed 6 in the window and staff moved 5 to Medical
  // Records; it reverses this file's documented "Medical Records is never a
  // destination" on the department under a Corrective Action Plan, where a
  // ticket opens a records case. Left for the operator.
  const RESIDUE: Array<[string, string, string, number]> = [
    ['CA5ee43e4f09dfe28b002cd6937fc465d7', 'VA-83229', 'Patient requesting test results from last year.', TECH],
    ['CAea58e4e702dc9bba90d5e9f0e69eaa21', 'VA-83620', 'Caller asked the doctor to send medical records here for her husband and wants to know if they were received.', TECH],
    ['CA6baee981928e67b3b6be69d4cc73f407', 'VA-83496', 'Send past medical records to another eye clinic.', SURGERY],
    ['CAfdf79a1e395901fd76c4d3df92c3a108', 'VA-83578', "Calling from a doctor's office requesting a visit note for a patient.", TECH],
  ];
  for (const [sid, ticket, words, home] of RESIDUE) {
    it(`${ticket} (${sid}) stays on its line`, () => {
      expect(filedIn(words, home)).toBe(home);
    });
  }
});

describe('controls', () => {
  it('a surgery date stays in Surgery Coordination, from the surgery line and from another line', () => {
    expect(detectCrossQueue('I need to reschedule my cataract surgery', SURGERY)).toBeNull();
    expect(detectCrossQueue('Surgery was cancelled, when will it be rescheduled', SURGERY)).toBeNull();
    expect(filedIn('I need to reschedule my surgery', TECH)).toBe(SURGERY);
    expect(filedIn('I need to reschedule my surgery', OPTICAL)).toBe(SURGERY);
  });
  it('a cataract removal appointment stays in Surgery (the surgery taxonomy names it)', () => {
    expect(detectCrossQueue('Wants to set up an appointment with the doctor to have her cataract removed. No specific surgery date yet.', SURGERY)).toBeNull();
  });
  it('a genuine medication refill stays in Technicians', () => {
    expect(detectCrossQueue('Refill my glaucoma drops at the pharmacy', TECH)).toBeNull();
    expect(detectCrossQueue('refill the drops for my cataract surgery', TECH)).toBeNull();
  });
  it('a clinical symptom is not sent to Optical or the Hub by these rules', () => {
    expect(filedIn('My contact lens is stuck and my eye hurts', TECH)).toBe(TECH);
    expect(filedIn('My eye has been red and painful since yesterday, can someone call me about my visit next week', SURGERY)).toBe(SURGERY);
    expect(filedIn('Blurry vision after my eye surgery, message for the surgical team', OPTICAL)).toBe(OPTICAL);
  });
  it('a surgery-line visit with a named surgeon stays in Surgery', () => {
    expect(detectCrossQueue('Patient wants to know what to bring to the appointment with the surgeon next week.', SURGERY)).toBeNull();
  });
  it('a booking for a new eye exam is still scheduling, not an exam that happened', () => {
    expect(examAlreadyHappened('Patient wants an eye exam to get new glasses')).toBe(false);
    expect(filedIn('Patient wants an eye exam to get new glasses', TECH)).toBe(HUB);
  });
  it('the optical-line operation rule leaves eyewear and drops where main files them', () => {
    // Eyewear beside an operation is still a glasses request on the optical line.
    expect(filedIn('Patient had surgery last month and wants to know when her new glasses will be ready.', OPTICAL)).toBe(OPTICAL);
    // A drop named beside an operation stays a medication question, as on main.
    expect(filedIn('Patient has a question about which eye drop to use before the procedure.', OPTICAL)).toBe(TECH);
  });
  it('an exam that already happened stands aside only when nothing else is asked', () => {
    // A visit is asked for in its own words.
    expect(filedIn('Had an eye exam last week, wants a copy of the glasses prescription, and wants an appointment for her son.', TECH)).toBe(HUB);
    // The exam is not in the past.
    expect(filedIn('Wants her glasses prescription and an eye exam.', TECH)).toBe(HUB);
    // A scheduling cue that is not an exam name.
    expect(detectCrossQueue('Had an eye exam, has a glasses prescription question, and needs to reschedule.', TECH)?.requestReasonId).toBe(147);
  });
  it('the lines this ship does not touch read as before', () => {
    // PCP (department 18) and the records line: none of the v202 rules are
    // reached from either.
    expect(detectCrossQueue('Patient asking whether the eyes will be dilated at the appointment tomorrow.', PCP)).toBeNull();
    // The contact-lens rule is the medication line's only: on the records line
    // the request stays where it was, as on main.
    expect(detectCrossQueue('Patient needs to reorder contact lenses.', RECORDS)).toBeNull();
  });
});

describe('the helpers, directly', () => {
  it('namesAnOperation reads the word and not a denial', () => {
    expect(namesAnOperation("Patient's surgery is Monday")).toBe(true);
    expect(namesAnOperation('post-operative visit next week')).toBe(true);
    // Codex on #450 (38890aea): the spaced forms are an operation too.
    expect(namesAnOperation('reschedule my post op appointment')).toBe(true);
    expect(namesAnOperation('reschedule my pre op appointment')).toBe(true);
    expect(namesAnOperation('the post operative visit')).toBe(true);
    expect(namesAnOperation('Post Op check on Monday')).toBe(true);
    expect(namesAnOperation('a postop visit')).toBe(true);
    // "op" alone, or a word that only starts with it, is not.
    expect(namesAnOperation('my post office box changed')).toBe(false);
    expect(namesAnOperation('the optical order')).toBe(false);
    expect(namesAnOperation('no surgery date')).toBe(false);
    expect(namesAnOperation('No specific surgery mentioned')).toBe(false);
  });
  it('asksAboutARoutineVisit refuses an operation, a surgeon, a symptom and today', () => {
    expect(asksAboutARoutineVisit('What should I bring to my appointment next week?')).toBe(true);
    expect(asksAboutARoutineVisit('What should I bring to my post-op appointment?')).toBe(false);
    expect(asksAboutARoutineVisit('What should I bring to my appointment with the surgeon?')).toBe(false);
    expect(asksAboutARoutineVisit('My eye hurts, can I come to my appointment early?')).toBe(false);
    expect(asksAboutARoutineVisit('I am running late for my appointment')).toBe(false);
    expect(asksAboutARoutineVisit('A biopsy result at my visit next week')).toBe(false);
  });
});

beforeEach(() => {
  create.mockReset();
  lookup.mockReset();
  resetGateAttempts();
  resetVerifiedIdentities();
});
