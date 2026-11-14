/**
 * v233 — A SCHEDULING WORD THAT REPORTS A VISIT IS NOT A BOOKING.
 *
 * The overnight ticket-quality pass of 2026-11-14 read every agent ticket
 * staff moved on 2026-11-12 and 2026-11-13 (114). On the tech and optical
 * lines, a request about drops or glasses went to the HVA Hub because the
 * caller said when they had been in ("she was seen today"), asked for a
 * same-day CALLBACK, said a visit had been rescheduled, or named the exam the
 * glasses came from; staff moved each one back. Widened to the 14 days
 * 2026-10-31..11-13: every optical, surgery and tech agent ticket carrying a
 * scheduling cue and a drug, drop or eyewear word (427), run through this
 * router on `main` and on this branch: 6 change department, and staff had
 * moved all 6 out of the Hub to where the router now files them.
 *
 * Every row is one of: RESCUED (red on main, green here), RESIDUE (what it
 * does today and still does, and why no rule was written), CORRECTLY REFUSED
 * (a real ask for a visit, which stays with the Hub) or CONTROL. The real
 * call SIDs and ticket numbers index the rows; the words are synthetic
 * stand-ins in the shape the agent wrote (RULE THREE: transcripts and ticket
 * text stay on disk and in the Support Center).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

import { detectCrossQueue, schedulingWordsReportAVisit } from './queueRouting';
import { runTool } from './registry';
import './sharedPatientTools';
import './techTools';
import './opticalTools';

const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HUB = 9;
const RECORDS = 16;
const PCP = 18;

/** Where the router files it: the redirect's department, or the line's own. */
const filedIn = (text: string, home: number) => detectCrossQueue(text, home)?.departmentId ?? home;

describe('RESCUED — a drug or eyewear request stays where staff work it', () => {
  // [call SID, ticket, line, words, where staff moved it]
  const RESCUED: Array<[string, string, number, string, number]> = [
    // "after an eye exam" was already history for eyewear (v202); a drug was not.
    ['CAf0a45d75a412d32f3bb0f662c9f1f857', 'VA-79611', TECH,
      'Patient was given lubricating drops for dry eyes after an eye exam about a week ago, but insurance does not cover them. Wants to switch to drops that insurance will cover. Pharmacy is the corner pharmacy.',
      TECH],
    // A same-day CALLBACK is not a same-day appointment.
    ['CAed9a8f5b2aaa82d004c9455d09355d9d', 'VA-83745', TECH,
      'Patient is out of her glaucoma drops and needs a refill sent to her pharmacy. Requesting same-day callback.',
      TECH],
    // "was seen today" reports the visit the drops came from.
    ['CAd5d57fb3eee443b2eefc83a2a03a4eba', 'VA-85227', TECH,
      "Patient's prescription for eye drops is not at the pharmacy yet. She was seen today at the Example office by the doctor.",
      TECH],
    // "eye exam glasses" names the glasses an exam produced.
    ['CAbdc7ade0e49cbe8431de40c347e53298', 'VA-85131', OPTICAL,
      'Caller wants to know if their eye exam glasses are ready for pickup at the Example office.',
      OPTICAL],
  ];
  for (const [sid, ticket, line, words, staff] of RESCUED) {
    it(`${ticket} (${sid}) files where staff moved it`, () => {
      expect(filedIn(words, line)).toBe(staff);
    });
  }

  it('the tech tool files VA-85227 in Technicians, with no scheduling note (CAd5d57fb3eee443b2eefc83a2a03a4eba)', async () => {
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValue({ success: true, locationId: 31 } as never);
    const create = vi.spyOn(ticketingApiClient, 'createTicket').mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-1' } as never);
    await runTool('file_tech_ticket', {
      call_sid: 'CAd5d57fb3eee443b2eefc83a2a03a4eba',
      location: 'Testville',
      first_name: 'Alex',
      last_name: 'Synthetic',
      date_of_birth: '01/02/1970',
      callback_number: '555-555-0100',
      request_description:
        "Patient's prescription for eye drops is not at the pharmacy yet. She was seen today at the Example office by the doctor.",
    });
    const payload = create.mock.calls[0][0] as { departmentId: number; description: string };
    expect(payload.departmentId).toBe(TECH);
    expect(payload.description).not.toMatch(/Scheduling request/);
  });
});

describe('RESIDUE — still the Hub, and why', () => {
  it('VA-82548 (CA06aef7e0bfd274cc123488b8d85071b2): the drugs are named only by brand, so nothing says the request is about a drug', () => {
    // Staff moved it to Technicians. A brand lexicon is not a rule worth
    // writing for one ticket in 14 days; it stays with the Hub as on main.
    expect(filedIn('Patient was seen today and the doctor ordered Lumigan and Restasis. The store says the order never arrived.', TECH)).toBe(HUB);
  });
  it('VA-84677 (CAbcbf32d3d3d5be0c2fef92ca19b88afd): a Spanish past exam is not read; staff moved it to the OCS Hub, which the router never names', () => {
    expect(filedIn('La esposa llama para saber si ya están listos los lentes. Se hizo el examen de la vista en la oficina.', OPTICAL)).toBe(HUB);
  });
});

describe('CORRECTLY REFUSED — an ask for a visit stays with the Hub', () => {
  const REFUSED: Array<[string, string, number, string]> = [
    // Staff moved it to Technicians, but the caller asked whether to keep the
    // drops OR schedule an appointment; the ask is real.
    ['CA233ea9c4e646602ecaf9d30f63d0dbfc', 'VA-84948', TECH,
      'Patient had a visit two weeks ago and was given eye drops. She wants to know if she should keep using them or schedule an appointment with the doctor.'],
    ['CA0f57ef138e49a91ea877b3f2b04daf61', 'VA-80601', TECH,
      'Patient missed his appointment yesterday for an eye exam related to glasses and asks if there is any availability now or on another day.'],
    ['CA551f19c18c27d2ab4a08e600511e785d', 'VA-83483', TECH,
      "Patient needs an eye exam sooner than his existing appointment. His glasses aren't working well."],
    ['CA6e01401ee491dec809486c8f959963ea', 'VA-84515', TECH,
      'Caller asks about a text about a prescription and also wants to schedule an appointment with the doctor.'],
    ['CAb4b98731fbeab24dd1aa1241aea0efc5', 'VA-81238', OPTICAL,
      'Caller wants a copy of his glasses prescription. Also asked about coming in for an eye exam for eyeglasses.'],
  ];
  for (const [sid, ticket, line, words] of REFUSED) {
    it(`${ticket} (${sid}) still files to the Hub`, () => {
      expect(filedIn(words, line)).toBe(HUB);
    });
  }
});

describe('CONTROLS — each part of the rule', () => {
  it('"be seen today" is an ask, "was seen today" is not', () => {
    expect(filedIn('Wants to be seen today, her drops are not helping.', TECH)).toBe(HUB);
    expect(filedIn('She got seen today and her drops are not at the pharmacy.', TECH)).toBe(TECH);
  });
  it('a same-day appointment is an ask; a same-day callback is not', () => {
    expect(filedIn('Would like a same-day appointment, she ran out of her drops.', TECH)).toBe(HUB);
    expect(filedIn('Out of her drops and needs a refill. Asks for a same day call back.', TECH)).toBe(TECH);
  });
  it('"to be rescheduled" and "reschedule" ask; "was rescheduled" reports', () => {
    expect(filedIn('Her appointment needs to be rescheduled, and she needs a refill of her drops.', TECH)).toBe(HUB);
    expect(filedIn('Wants to cancel and reschedule; also needs a refill of her drops.', TECH)).toBe(HUB);
    expect(filedIn('Her check was rescheduled and she needs a refill of her drops.', TECH)).toBe(TECH);
  });
  it('an exam named any other way still goes to the Hub, as on main', () => {
    expect(filedIn('Needs a refill of her drops before her eye exam next month.', TECH)).toBe(HUB);
    expect(filedIn('Had an eye exam last month and the glasses are not ready. Also coming in for an eye exam for eyeglasses.', OPTICAL)).toBe(HUB);
  });
  it('every cue the request fires must report a visit', () => {
    expect(filedIn('She was seen today, her drops are not at the pharmacy, and she wants the next available opening.', TECH)).toBe(HUB);
  });
  it('an ask for a visit in words no cue lists keeps the Hub', () => {
    expect(filedIn('She was seen today, her drops are not at the pharmacy, and she wants another appointment.', TECH)).toBe(HUB);
    expect(filedIn('She was seen today, her drops are not at the pharmacy, and she needs to move her appointment.', TECH)).toBe(HUB);
    // An exam asked for by a verb no cue lists (the rule `examAlreadyHappened` already reads).
    expect(filedIn('She was seen today, her drops are not at the pharmacy, and she wants an exam.', TECH)).toBe(HUB);
  });
  it('a request about neither a drug nor eyewear keeps the Hub', () => {
    expect(filedIn('Patient was seen today and asks what time her follow-up is.', TECH)).toBe(HUB);
  });
  it('only the optical and tech lines read it', () => {
    const words = "Patient's prescription for eye drops is not at the pharmacy yet. She was seen today at the Example office.";
    for (const line of [SURGERY, RECORDS, PCP]) {
      expect(schedulingWordsReportAVisit(words, line), String(line)).toBe(false);
    }
    expect(schedulingWordsReportAVisit(words, TECH)).toBe(true);
    expect(schedulingWordsReportAVisit(words, OPTICAL)).toBe(true);
    expect(filedIn(words, PCP)).toBe(HUB);
  });
  it('no cue fired is no report', () => {
    expect(schedulingWordsReportAVisit('Needs a refill of her drops.', TECH)).toBe(false);
  });
});

describe('Codex P2 on #481 — a visit that did NOT happen is not a report, and a new date is an ask', () => {
  // Synthetic. On head 094ca19 each of these stayed in Technicians or Optical.
  const STILL_THE_HUB: Array<[string, number]> = [
    ['Her appointment has not been rescheduled. She is out of drops and is calling to get a new date.', TECH],
    ["Her appointment hasn't been rescheduled yet and she is out of her drops.", TECH],
    ["She wasn't seen today and her drops are not at the pharmacy.", TECH],
    ['She was not seen today and needs a refill of her drops.', TECH],
    ['Her glasses are not ready and she never had an eye exam.', OPTICAL],
    ['She did not have an eye exam and wants to know about her glasses.', OPTICAL],
  ];
  for (const [words, line] of STILL_THE_HUB) {
    it(`files to the Hub: ${words}`, () => {
      expect(filedIn(words, line)).toBe(HUB);
    });
  }
  it('"get a new date" and "a new appointment date" ask for a visit', () => {
    expect(filedIn('Her visit was rescheduled, she is out of her drops and wants to get a new date.', TECH)).toBe(HUB);
    expect(filedIn('Her visit was rescheduled; she needs a new appointment date and a refill of her drops.', TECH)).toBe(HUB);
  });
  it('a negation in an earlier sentence does not reach the cue', () => {
    expect(filedIn('She does not remember the drug name. She was seen today and the drops are not at the pharmacy.', TECH)).toBe(TECH);
    expect(filedIn('Did not get them. She was seen today and the drops are not at the pharmacy.', TECH)).toBe(TECH);
  });
});

describe('Codex P2 on #481 (inline) — a completed reschedule followed by an ask to act on the visit again', () => {
  // Synthetic. On head 094ca19 each of these stayed in Technicians or Optical.
  const ASKS_AGAIN: Array<[string, number]> = [
    ['Her appointment was rescheduled, but she wants it moved again and also needs drops.', TECH],
    ['Her appointment was rescheduled and she needs to reschedule it; she also needs a refill of her drops.', TECH],
    ['Her visit was rescheduled, she wants to cancel that, and her drops are not at the pharmacy.', TECH],
    ['Her appointment was rescheduled and she wants it changed; she is also out of her drops.', TECH],
    ['Her visit was rescheduled and she wants to confirm it. Her glasses are not ready.', OPTICAL],
    ['Her visit was rescheduled; she needs a new appointment and her drops are not at the pharmacy.', TECH],
    // Only "again" asks here.
    ['Her visit was rescheduled and she wants to come in again; she is also out of her drops.', TECH],
    // Only "new appointment" asks here.
    ['Her visit was rescheduled and she is asking about the new appointment; her drops are not at the pharmacy.', TECH],
  ];
  for (const [words, line] of ASKS_AGAIN) {
    it(`files to the Hub: ${words}`, () => {
      expect(filedIn(words, line)).toBe(HUB);
    });
  }
  it('a pronoun that is not about a visit does not keep the Hub', () => {
    expect(filedIn('Her check was rescheduled and she needs a refill of her drops; the pharmacy has it on hold.', TECH)).toBe(TECH);
  });
});

describe('THE COST of the round-2 rule — a reported visit beside a time to come keeps the Hub', () => {
  // Codex round 2 on #481, coordinator ruling 2026-11-14: the past-visit
  // suppression applies only when the description holds no forward-looking
  // visit language at all, and when that costs a rescue the stricter rule
  // stands, because the failure it prevents is a lost appointment request.
  // These two were rescued on 094ca19 and 28e0e33 and are filed in the Hub
  // again, as on `main`: a calendar month (VA-80971), a month and a weekday
  // (VA-82854). Staff moved both to Technicians.
  const COST: Array<[string, string, string]> = [
    ['CA1636b4d10c88cb9fecb39c59cc6530e3', 'VA-80971',
      'Patient reports burning from her drops and wants to know if she should keep using them until her appointment. Her follow-up check was rescheduled from today to next month.'],
    ['CA75f0e6c0b12f35b1b28f041e9c705fc7', 'VA-82854',
      'Patient was told to keep using the eye drops twice a day. She was given a four-week appointment but rescheduled and now has one in January. Wants to know whether to continue the eye drops until then.'],
  ];
  for (const [sid, ticket, words] of COST) {
    it(`${ticket} (${sid}) files to the Hub, as on main`, () => {
      expect(filedIn(words, TECH)).toBe(HUB);
    });
  }
});

describe('Codex round 2 on #481 — any forward-looking visit language keeps the Hub', () => {
  // Synthetic. On head 28e0e33 each of these stayed in Technicians or Optical.
  const LOOKS_AHEAD: Array<[string, string, number]> = [
    ['the round-2 example', 'She was seen today and was prescribed drops, but needs to be seen tomorrow because her symptoms are worse.', TECH],
    ['tomorrow', 'She was seen today and the drops are not at the pharmacy; she is coming by tomorrow.', TECH],
    ['next week', 'She was seen today and her drops are not at the pharmacy. Her follow-up is next week.', TECH],
    ['a weekday', 'She was seen today, her drops are not at the pharmacy, and her check is Thursday.', TECH],
    ['in N days', 'She was seen today and her drops are not at the pharmacy; her check is in 3 days.', TECH],
    ['a calendar month', 'She was seen today and her drops are not at the pharmacy. Her check is in December.', TECH],
    ['a numeric date', 'She was seen today and her drops are not at the pharmacy. Her check is 12/3.', TECH],
    ['come in', 'She was seen today and her drops are not at the pharmacy, and she wants to come in.', TECH],
    ['get in', 'She was seen today and the drops are not working; can she get in sooner.', TECH],
    ['see the doctor', 'She was seen today and the drops burn; she wants to see the doctor.', TECH],
    ['an appointment for', 'Her eye exam glasses are not ready and she has an appointment for her son.', OPTICAL],
    ['a weekday on the optical line', 'Caller wants to know if their eye exam glasses are ready by Friday.', OPTICAL],
    ['a month before a day', 'She was seen today and her drops are not at the pharmacy. Her check is May 3.', TECH],
    ['an ordinal day', 'She was seen today and her drops are not at the pharmacy. Her check is on the 20th.', TECH],
    ['a weekday, plural', 'She was seen today and her drops are not at the pharmacy. Her checks are on Tuesdays.', TECH],
    ['be seen, alone', 'She was seen today and her drops burn; she needs to be seen.', TECH],
    ['schedule, alone', 'She was seen today and her drops burn; she is calling to schedule.', TECH],
    ['again, alone', 'Her appointment was rescheduled but it was changed again; she needs her drops.', TECH],
    ['a new day', 'Her visit was rescheduled and she wants a new day; she needs her drops.', TECH],
    // The connector's review of 28e0e33 (inline 4571106152): a question about when.
    ['what time', 'Her appointment was rescheduled; she wants to know what time it is, and she needs a refill of her drops.', TECH],
    ['the original date', 'Her appointment was rescheduled; she wants the original date, and she needs a refill of her drops.', TECH],
    ['when', 'She was seen today and her drops are not at the pharmacy; she asks when her check is.', TECH],
    ['which day', 'Her visit was rescheduled and she is out of her drops; she asks which day it moved to.', TECH],
  ];
  for (const [family, words, line] of LOOKS_AHEAD) {
    it(`${family}: files to the Hub`, () => {
      expect(filedIn(words, line)).toBe(HUB);
    });
  }
  it('a reported visit with nothing ahead still stays on the line', () => {
    expect(filedIn('She was seen today and her drops are not at the pharmacy.', TECH)).toBe(TECH);
    expect(filedIn('Out of her drops, requesting a same-day callback.', TECH)).toBe(TECH);
  });
  it('a date of birth is not a visit\'s date', () => {
    expect(filedIn('She was seen today and gave her date of birth; her drops are not at the pharmacy.', TECH)).toBe(TECH);
  });
  it('the word "today" alone is not a time to come', () => {
    expect(filedIn('She was seen today at the Example office and the drops are not at the pharmacy.', TECH)).toBe(TECH);
  });
});

describe('Codex round 3 on #481 — an appointment or a visit named anywhere keeps the Hub', () => {
  // Synthetic. On head 1f283c53 the first stayed in Technicians; the base
  // routes it to the HVA Hub. An ask phrased in words no family lists ("asking
  // for another appointment") cannot be told from a report, so any
  // appointment or visit noun keeps the Hub. None of the 4 rescued corpus
  // tickets (VA-79611, VA-83745, VA-85227, VA-85131) names one, measured on
  // the Support Center 2026-11-14.
  it('the review example files to the Hub', () => {
    expect(filedIn('She was seen today and her drops are not helping; she is asking for another appointment.', TECH)).toBe(HUB);
  });
  it('a visit noun beside a reported cue keeps the Hub', () => {
    expect(filedIn('She was seen today; she would love a visit soon, her drops are not helping.', TECH)).toBe(HUB);
    expect(filedIn('Her eye exam glasses are not ready and she mentioned her appt.', OPTICAL)).toBe(HUB);
  });
  it('THE COST: a reported visit that names the visit goes to the Hub, as on main', () => {
    expect(filedIn('Her visit was rescheduled and she needs a refill of her drops.', TECH)).toBe(HUB);
  });
  it('the rescue shape without an appointment noun still stands aside', () => {
    expect(filedIn('She was seen today and her drops are not at the pharmacy.', TECH)).toBe(TECH);
  });
});

