/**
 * The NPX outreach tracking screen's numbers, decided by pure functions.
 *
 * Every patient here is synthetic ("Testa Synthetic", phones ending 555x);
 * the real campaign's rows stay on the Hub. The shapes are the Hub's own,
 * measured 2026-11-13: 602 live contacts; 45 contacts with a successful
 * book_sooner_exam on a call, 12 of whom had lost the `npx_booking:` note to
 * a later `staff_callback:` note; one link booking; three SMS STOPs and one
 * voice opt-out.
 *
 * Each block names the misreading it prevents and is written so reverting the
 * rule turns it red (failure mode 10 in /CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import {
  CANCEL_LANDED_PHRASE,
  CANCEL_NOT_LANDED_PHRASE,
  attemptLabel,
  bookingIdFromNotes,
  buildContact,
  buildTracking,
  cancelFromSay,
  dayBefore,
  dayDate,
  inDay,
  pacificDay,
  staffTicketsFromNotes,
  ticketsOnCall,
  type RawAttempt,
  type RawContact,
} from './npxOutreach.logic';
import { confirmation } from '../../src/tools/npxOutreachTools';
import type { NpxSlot } from '../../src/services/npxOutreachClient';

// 2026-11-13 10:00 Pacific (PST, UTC-8) is 18:00Z.
const NOW = new Date('2026-11-13T18:00:00.000Z');
const TODAY_9AM = '2026-11-13T17:00:00.000Z';
const YESTERDAY_9AM = '2026-11-12T17:00:00.000Z';
const LAST_WEEK = '2026-11-06T17:00:00.000Z';

function contact(over: Partial<RawContact> = {}): RawContact {
  return {
    id: 'c1',
    firstName: 'Testa',
    lastName: 'Synthetic',
    phoneLast4: '5551',
    status: 'pending',
    agentNotes: null,
    nextAttemptAt: null,
    eventName: 'Comprehensive Exam',
    appointmentDate: '2041-02-20',
    beginTime: '0930',
    office: 'Test Office',
    textState: null,
    textSentAt: null,
    textClaimedAt: null,
    textReason: null,
    dobTries: null,
    verifiedAt: null,
    linkBookedAt: null,
    linkBookingId: null,
    confirmationBookingId: null,
    confirmationCancel: null,
    smsStopAt: null,
    voiceOptOutAt: null,
    ...over,
  };
}

let seq = 0;
function attempt(over: Partial<RawAttempt> = {}): RawAttempt {
  seq += 1;
  return {
    id: `a${seq}`,
    contactId: 'c1',
    direction: 'outbound',
    status: 'no-answer',
    answeredBy: null,
    durationSec: null,
    callSid: `CA${String(seq).padStart(32, '0')}`,
    attemptedAt: TODAY_9AM,
    callLogId: null,
    runtimeOutcome: null,
    callerSpoke: false,
    bookingAt: null,
    bookingSay: null,
    bookingAzulCancel: null,
    staffAt: null,
    staffTicket: null,
    tickets: [],
    ...over,
  };
}

const SLOT: NpxSlot = {
  slotId: 's1',
  startAt: '2041-02-05T18:00:00.000Z',
  endAt: '2041-02-05T18:30:00.000Z',
  timezone: 'America/Los_Angeles',
  day: '2041-02-05',
  partnerOrgId: 'p1',
  partnerName: 'Partner One Optometry',
  clinicId: 'clinic-1',
  clinicName: 'Clinic One',
  address: '1 Test Ave, Testville, CA 91730',
  phone: '555-010-0000',
  providerName: 'Dr Test',
  visitType: 'Comprehensive Exam',
} as NpxSlot;

describe('the Azul cancel is read from the booking confirmation the caller heard', () => {
  it('agrees with the real confirmation sentence, both ways', () => {
    // If npxOutreachTools rewords `confirmation`, this is the test that goes
    // red, rather than every phone booking quietly reading "not recorded".
    const landed = confirmation(SLOT, { cancelled: true } as never, 'Friday, February 20');
    const notLanded = confirmation(SLOT, { cancelled: false, reason: 'nextgen_timeout' } as never, 'Friday, February 20');
    expect(landed).toContain(CANCEL_LANDED_PHRASE);
    expect(notLanded).toContain(CANCEL_NOT_LANDED_PHRASE);
    expect(cancelFromSay(landed)).toBe('landed');
    expect(cancelFromSay(notLanded)).toBe('not_landed');
  });

  it('says not recorded when there is no confirmation or it says neither', () => {
    expect(cancelFromSay(null)).toBe('not_recorded');
    expect(cancelFromSay("You're booked for Friday.")).toBe('not_recorded');
  });
});

describe('the notes on a contact', () => {
  it('reads the NPX booking id and every staff ticket, the v216 combined note included', () => {
    expect(bookingIdFromNotes('npx_booking:abc-123; staff_callback:VA-9001')).toBe('abc-123');
    expect(staffTicketsFromNotes('npx_booking:abc-123; staff_callback:VA-9001')).toEqual(['VA-9001']);
    expect(bookingIdFromNotes('staff_callback:VA-9001')).toBeNull();
    expect(staffTicketsFromNotes(null)).toEqual([]);
  });
});

describe('the Pacific day', () => {
  it('reads an instant in the practice day, not UTC', () => {
    // 2026-11-14 03:00Z is 7 PM on the 13th in Pacific time.
    expect(pacificDay(new Date('2026-11-14T03:00:00.000Z'))).toBe('2026-11-13');
  });

  it('takes yesterday by the calendar, so a 23-hour day is not skipped', () => {
    // 2026-03-09 00:30 PDT (07:30Z). Twenty-four hours earlier is 23:30 PST on
    // March 7, two days back: March 8 is only 23 hours long.
    const justAfterMidnight = new Date('2026-03-09T07:30:00.000Z');
    expect(dayDate('yesterday', justAfterMidnight)).toBe('2026-03-08');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayDate('all', NOW)).toBeNull();
    expect(dayDate('today', NOW)).toBe('2026-11-13');
  });

  it('counts an event with no time for all time only', () => {
    expect(inDay(null, null)).toBe(true);
    expect(inDay(null, '2026-11-13')).toBe(false);
    expect(inDay(TODAY_9AM, '2026-11-13')).toBe(true);
    expect(inDay(YESTERDAY_9AM, '2026-11-13')).toBe(false);
  });
});

describe('answered by a person is somebody speaking, not AMD', () => {
  it('a silent pickup is put through but not answered', () => {
    const silent = attempt({ status: 'completed', answeredBy: 'human', callerSpoke: false, callLogId: 'log1' });
    expect(attemptLabel(silent)).toBe('Picked up, silent');
    const t = buildTracking({ contacts: [contact()], attempts: [silent] }, { day: 'all', now: NOW });
    expect(t.totals.called).toBe(1);
    expect(t.totals.connected).toBe(1);
    expect(t.totals.answeredByPerson).toBe(0);
    expect(t.contacts[0].reached).toBe(false);
  });

  it('a dial Twilio refused is not a call', () => {
    const refused = attempt({ status: 'not_placed' });
    const t = buildTracking({ contacts: [contact()], attempts: [refused] }, { day: 'all', now: NOW });
    expect(t.totals.called).toBe(0);
    expect(t.contacts[0].result).toBe('not_called');
  });

  it('a returned call is counted apart from the dials', () => {
    const back = attempt({ direction: 'inbound', status: 'completed', answeredBy: 'human', callerSpoke: true });
    const t = buildTracking({ contacts: [contact()], attempts: [back] }, { day: 'all', now: NOW });
    expect(t.totals.returnedCalls).toBe(1);
    expect(t.totals.called).toBe(0);
    expect(t.totals.answeredByPerson).toBe(0);
    expect(t.contacts[0].reached).toBe(true);
    expect(t.contacts[0].calls.returned).toBe(1);
  });
});

describe('a booking', () => {
  const landedSay = `You're booked. ${CANCEL_LANDED_PHRASE} on Friday, so there's nothing else you need to do.`;
  const notLandedSay = `You're booked. ${CANCEL_NOT_LANDED_PHRASE} on Friday; you don't need to do anything.`;

  it('by phone is the timeline event, even when the note lost its marker (the v216 shape)', () => {
    const t = buildTracking(
      {
        contacts: [contact({ status: 'completed', agentNotes: 'staff_callback:VA-9001' })],
        attempts: [
          attempt({
            status: 'completed',
            callerSpoke: true,
            callLogId: 'log1',
            bookingAt: TODAY_9AM,
            bookingSay: landedSay,
            staffAt: '2026-11-13T17:05:00.000Z',
            staffTicket: 'VA-9001',
          }),
        ],
      },
      { day: 'all', now: NOW },
    );
    const c = t.contacts[0];
    expect(c.booking).toEqual({ id: null, by: 'phone', at: TODAY_9AM, cancel: 'landed', callLogId: 'log1' });
    expect(c.result).toBe('booked');
    expect(c.staffTickets).toEqual(['VA-9001']);
    expect(c.bookedThenStaffSameCall).toBe(true);
    expect(t.totals.bookedByPhone).toBe(1);
    expect(t.totals.cancelLanded).toBe(1);
    expect(t.totals.staffTickets).toBe(1);
    expect(t.needsPerson[0].reasons).toEqual(['staff_ticket', 'booked_then_staff_same_call']);
  });

  it('by phone takes its NPX id from the note', () => {
    const c = buildContact(contact({ agentNotes: 'npx_booking:npx-777' }), [
      attempt({ status: 'completed', callerSpoke: true, bookingAt: TODAY_9AM, bookingSay: notLandedSay }),
    ]);
    expect(c.booking).toMatchObject({ id: 'npx-777', by: 'phone', cancel: 'not_landed' });
  });

  it('a cancel that did not land is a job for a person', () => {
    const t = buildTracking(
      {
        contacts: [contact({ status: 'completed', agentNotes: 'npx_booking:npx-777' })],
        attempts: [attempt({ status: 'completed', callerSpoke: true, bookingAt: TODAY_9AM, bookingSay: notLandedSay })],
      },
      { day: 'all', now: NOW },
    );
    expect(t.totals.cancelNotLanded).toBe(1);
    expect(t.needsPerson).toHaveLength(1);
    expect(t.needsPerson[0]).toMatchObject({ reasons: ['cancel_not_landed'], bookingId: 'npx-777', bookedBy: 'phone' });
  });

  it('by link is the text record, and its cancel is not recorded in the Hub', () => {
    const t = buildTracking(
      {
        contacts: [
          contact({
            status: 'completed',
            agentNotes: 'npx_booking:npx-link-1',
            textState: 'sent',
            textSentAt: YESTERDAY_9AM,
            dobTries: 1,
            verifiedAt: TODAY_9AM,
            linkBookedAt: TODAY_9AM,
            linkBookingId: 'npx-link-1',
          }),
        ],
        attempts: [],
      },
      { day: 'all', now: NOW },
    );
    const c = t.contacts[0];
    expect(c.booking).toEqual({ id: 'npx-link-1', by: 'link', at: TODAY_9AM, cancel: 'not_recorded', callLogId: null });
    expect(c.reached).toBe(true);
    expect(t.totals.bookedByLink).toBe(1);
    expect(t.totals.bookedByPhone).toBe(0);
    expect(t.totals.cancelNotRecorded).toBe(1);
    expect(t.totals.linkDobConfirmed).toBe(1);
    expect(t.totals.linkDobTried).toBe(1);
    expect(t.needsPerson[0].reasons).toEqual(['cancel_not_recorded']);
  });

  it('the recorded Azul cancel wins over the spoken words (v222)', () => {
    const landed = buildContact(contact({ agentNotes: 'npx_booking:npx-1' }), [
      attempt({ status: 'completed', callerSpoke: true, bookingAt: TODAY_9AM, bookingSay: notLandedSay, bookingAzulCancel: 'cancelled' }),
    ]);
    expect(landed.booking?.cancel).toBe('landed');
    const notLanded = buildContact(contact({ agentNotes: 'npx_booking:npx-2' }), [
      attempt({ status: 'completed', callerSpoke: true, bookingAt: TODAY_9AM, bookingSay: landedSay, bookingAzulCancel: 'not_cancelled' }),
    ]);
    expect(notLanded.booking?.cancel).toBe('not_landed');
  });

  it('a link booking reads its cancel from the confirmation for that booking only', () => {
    const base = { status: 'completed', agentNotes: 'npx_booking:npx-link-1', linkBookedAt: TODAY_9AM, linkBookingId: 'npx-link-1' };
    expect(buildContact(contact({ ...base, confirmationBookingId: 'npx-link-1', confirmationCancel: 'cancelled' }), []).booking?.cancel).toBe('landed');
    expect(buildContact(contact({ ...base, confirmationBookingId: 'npx-link-1', confirmationCancel: 'pending' }), []).booking?.cancel).toBe('not_landed');
    expect(buildContact(contact({ ...base, confirmationBookingId: 'npx-other', confirmationCancel: 'cancelled' }), []).booking?.cancel).toBe('not_recorded');
  });

  it('every call shows every ticket it created: the call log ticket, the timeline tickets and the staff ticket', () => {
    const c = buildContact(contact(), [
      attempt({ status: 'completed', callerSpoke: true, tickets: ['VA-1001', 'VA-1002'], staffTicket: 'VA-1002' }),
      attempt({ status: 'completed', callerSpoke: true, tickets: [], staffTicket: 'VA-1003' }),
      attempt({ status: 'no-answer' }),
    ]);
    expect(c.attempts.map((a) => a.tickets)).toEqual([['VA-1001', 'VA-1002'], ['VA-1003'], []]);
  });

  it('ticketsOnCall puts the call log ticket first and keeps each ticket number once', () => {
    expect(ticketsOnCall('VA-9', ['PCP-8', 'VA-9', 'not-a-ticket', null])).toEqual(['VA-9', 'PCP-8']);
    expect(ticketsOnCall(null, null)).toEqual([]);
  });

  it('a note with no call behind it is still a booking, its cancel not recorded', () => {
    const c = buildContact(contact({ agentNotes: 'npx_booking:npx-888' }), []);
    expect(c.booking).toEqual({ id: 'npx-888', by: 'phone', at: null, cancel: 'not_recorded', callLogId: null });
  });

  it('a staff ticket asked for BEFORE the booking is not "booked then staff"', () => {
    const c = buildContact(contact(), [
      attempt({ status: 'completed', callerSpoke: true, staffAt: TODAY_9AM, staffTicket: 'VA-1', bookingAt: '2026-11-13T17:10:00.000Z', bookingSay: landedSay }),
    ]);
    expect(c.bookedThenStaffSameCall).toBe(false);
  });
});

// Codex P2 on #471: the staff time kept only the newest ticket, so a contact
// who asked for staff yesterday and again today dropped out of yesterday.
describe('staff tickets on more than one day', () => {
  const twoDays = {
    contacts: [contact({ id: 'c1', agentNotes: 'staff_callback:VA-11; staff_callback:VA-12' })],
    attempts: [
      attempt({ contactId: 'c1', status: 'completed', callerSpoke: true, attemptedAt: YESTERDAY_9AM, staffAt: YESTERDAY_9AM, staffTicket: 'VA-11' }),
      attempt({ contactId: 'c1', status: 'completed', callerSpoke: true, attemptedAt: TODAY_9AM, staffAt: TODAY_9AM, staffTicket: 'VA-12' }),
    ],
  };

  it('counts the contact on each day it asked for staff', () => {
    expect(buildTracking(twoDays, { day: 'yesterday', now: NOW }).totals.staffTickets).toBe(1);
    expect(buildTracking(twoDays, { day: 'today', now: NOW }).totals.staffTickets).toBe(1);
    expect(buildTracking(twoDays, { day: 'all', now: NOW }).totals.staffTickets).toBe(1);
  });

  it('a ticket on the note with no call carrying its time counts for all time and no single day', () => {
    const noTime = { contacts: [contact({ id: 'c2', agentNotes: 'staff_callback:VA-13' })], attempts: [] };
    expect(buildTracking(noTime, { day: 'all', now: NOW }).totals.staffTickets).toBe(1);
    expect(buildTracking(noTime, { day: 'today', now: NOW }).totals.staffTickets).toBe(0);
  });

  it('the needs-a-person item is dated by the newest ticket', () => {
    const item = buildTracking(twoDays, { day: 'all', now: NOW }).needsPerson[0];
    expect(item.at).toBe(TODAY_9AM);
  });
});

describe('opt-outs', () => {
  it('reads SMS STOP and a voice opt-out apart', () => {
    const t = buildTracking(
      {
        contacts: [
          contact({ id: 'c1', smsStopAt: TODAY_9AM }),
          contact({ id: 'c2', voiceOptOutAt: TODAY_9AM, status: 'do_not_call' }),
          contact({ id: 'c3', status: 'do_not_call' }),
        ],
        attempts: [],
      },
      { day: 'all', now: NOW },
    );
    expect(t.totals.optedOutSms).toBe(1);
    expect(t.totals.optedOutVoice).toBe(2);
    expect(t.contacts.map((c) => c.result)).toEqual(['opted_out', 'opted_out', 'opted_out']);
  });

  it('a do_not_call status the dialler set because of a STOP is not also a voice opt-out', () => {
    // dialer.ts settles a row do_not_call on finding ANY do-not-contact row.
    const c = buildContact(contact({ status: 'do_not_call', smsStopAt: TODAY_9AM }), []);
    expect(c.optOut).toMatchObject({ sms: true, voice: false });
    expect(c.result).toBe('opted_out');
  });

  // Codex P2 on #471: a phone can carry a voice and an sms_stop row, and the
  // headline summed the two channels, so one contact read as 2 opted out.
  it('counts a contact opted out on both channels once in the headline', () => {
    const t = buildTracking(
      {
        contacts: [
          contact({ id: 'c1', smsStopAt: TODAY_9AM, voiceOptOutAt: TODAY_9AM, status: 'do_not_call' }),
          contact({ id: 'c2', smsStopAt: TODAY_9AM }),
          contact({ id: 'c3' }),
        ],
        attempts: [],
      },
      { day: 'all', now: NOW },
    );
    expect(t.totals.optedOutVoice).toBe(1);
    expect(t.totals.optedOutSms).toBe(2);
    expect(t.totals.optedOut).toBe(2);
  });
});

describe('the headline result', () => {
  const build = (over: Partial<RawContact>, attempts: RawAttempt[] = []) => buildContact(contact(over), attempts);

  it('separates no answer yet (still being tried) from never reached (done trying)', () => {
    expect(build({ status: 'voicemail' }, [attempt({ status: 'voicemail', answeredBy: 'machine_end_beep' })]).result).toBe('no_answer_yet');
    expect(build({ status: 'max_attempts' }, [attempt({ status: 'no-answer' })]).result).toBe('never_reached');
    expect(build({ status: 'pending' }).result).toBe('not_called');
  });

  it('reads declined, wrong number and a moved appointment from the status', () => {
    expect(build({ status: 'declined' }, [attempt({ status: 'completed', callerSpoke: true })]).result).toBe('declined');
    expect(build({ status: 'wrong_number' }, [attempt({ status: 'fax' })]).result).toBe('wrong_number');
    expect(build({ status: 'rescheduled' }, [attempt()]).result).toBe('appointment_over');
  });

  it('a person reached with nothing else recorded is "reached"', () => {
    expect(build({ status: 'answered' }, [attempt({ status: 'completed', callerSpoke: true })]).result).toBe('reached');
  });
});

describe('the day filter', () => {
  const contacts = [
    contact({ id: 'today', status: 'declined' }),
    contact({ id: 'yesterday', status: 'wrong_number' }),
    contact({ id: 'lastweek', textState: 'sent', textSentAt: LAST_WEEK }),
  ];
  const attempts = [
    attempt({ contactId: 'today', status: 'completed', callerSpoke: true, attemptedAt: TODAY_9AM }),
    attempt({ contactId: 'yesterday', status: 'fax', attemptedAt: YESTERDAY_9AM }),
  ];

  it('counts each fact on the Pacific day it happened, and lists only the contacts touched that day', () => {
    const today = buildTracking({ contacts, attempts }, { day: 'today', now: NOW });
    expect(today.day).toEqual({ key: 'today', date: '2026-11-13' });
    expect(today.totals.onList).toBe(3);
    expect(today.totals.called).toBe(1);
    expect(today.totals.declined).toBe(1);
    expect(today.totals.wrongNumber).toBe(0);
    expect(today.totals.textsSent).toBe(0);
    expect(today.contacts.map((c) => c.id)).toEqual(['today']);

    const yesterday = buildTracking({ contacts, attempts }, { day: 'yesterday', now: NOW });
    expect(yesterday.totals.wrongNumber).toBe(1);
    expect(yesterday.totals.declined).toBe(0);
    expect(yesterday.contacts.map((c) => c.id)).toEqual(['yesterday']);

    const all = buildTracking({ contacts, attempts }, { day: 'all', now: NOW });
    expect(all.totals.textsSent).toBe(1);
    expect(all.contacts).toHaveLength(3);
  });

  it('leaves a date-of-birth try out of a single day, because it carries no time', () => {
    const t = buildTracking({ contacts: [contact({ dobTries: 2 })], attempts: [] }, { day: 'today', now: NOW });
    expect(t.totals.linkDobTried).toBeNull();
  });

  it('counts a booking whose time the Hub does not hold for all time only', () => {
    const undated = [contact({ agentNotes: 'npx_booking:npx-888' })];
    expect(buildTracking({ contacts: undated, attempts: [] }, { day: 'today', now: NOW }).totals.bookedByPhone).toBe(0);
    expect(buildTracking({ contacts: undated, attempts: [] }, { day: 'all', now: NOW }).totals.bookedByPhone).toBe(1);
  });

  it('keeps the needs-a-person list whatever the day', () => {
    const old = [contact({ agentNotes: 'staff_callback:VA-1' })];
    const t = buildTracking({ contacts: old, attempts: [] }, { day: 'today', now: NOW });
    expect(t.needsPerson).toHaveLength(1);
    expect(t.totals.staffTickets).toBe(0);
  });
});

describe('what the page receives', () => {
  it('carries no date of birth and only the last four digits of the phone', () => {
    const t = buildTracking({ contacts: [contact()], attempts: [attempt()] }, { day: 'all', now: NOW });
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/date_?of_?birth|dob"/i);
    expect(t.contacts[0].phoneLast4).toBe('5551');
    // The booking confirmation is read for the cancel and never sent on.
    expect(text).not.toContain('bookingSay');
  });
});
