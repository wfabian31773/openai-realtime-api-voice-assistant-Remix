/**
 * A RETURNED CALL FROM A PATIENT WHO HAS ALREADY BOOKED HEARS THEIR BOOKING
 * (v247, operator 2026-11-16: "go on the fix").
 *
 * The confirmation text says "Questions? Call this number", and a patient who
 * booked calls it. Until v247 the tools read the contact's record, which still
 * holds the Azul appointment the booking replaced, so the agent read that
 * cancelled appointment back as theirs and offered sooner times again. Of the
 * 128 returned calls identified on npx-outreach to 2026-11-16, 9 came from 4
 * patients who had already booked, and all 9 were offered again:
 *
 *   CA05da0d4434a9f01c1d8b0a64aa94817a  booked the day before, offered again
 *   CA60cfd3d2f7cf38d0b292dd6554c19295  booked 4 minutes before, booked a second slot, undid it
 *   CA60ab54a71c57974904aacc2eed788dfb  booked three days before, offered again
 *   CA386f88c848dcd4d74bf07d29c314fcc8  six calls in 72 minutes from one patient who booked
 *   CAb85f01ef80f81108b23765ba3b966bf8    at 20:42 and asked each time for the partner's
 *   CA905d586103b7a1fa484b1813c53bcd75    phone number; each was told their (cancelled)
 *   CA59e06c14429d4fadd43b73974cd9462c    appointment "stays exactly as it is", and the
 *   CAacad46b42a6699b982adb10e936e6466    staff ticket's note dropped the booking marker
 *   CAd9744c26bc5cab62421b660cae8f9c53
 *
 * The SIDs name the shapes; the patients, dates, slots and phones are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  STAFF_CALLBACK_TOOL_NAME,
  bookedVisitDay,
  confirmationRecordFor,
  priorBookingOf,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  spokenFromTexted,
  spokenPhone,
} from './npxOutreachTools';
import { callbackSessionFor, openCallbackSession } from './outboundTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { ContactSource, OutboundContact, SourceRecheck } from '../runtime/outbound/campaign';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const CORPUS = [
  'CA05da0d4434a9f01c1d8b0a64aa94817a',
  'CA60cfd3d2f7cf38d0b292dd6554c19295',
  'CA60ab54a71c57974904aacc2eed788dfb',
  'CA386f88c848dcd4d74bf07d29c314fcc8',
  'CAb85f01ef80f81108b23765ba3b966bf8',
  'CA905d586103b7a1fa484b1813c53bcd75',
  'CA59e06c14429d4fadd43b73974cd9462c',
  'CAacad46b42a6699b982adb10e936e6466',
  'CAd9744c26bc5cab62421b660cae8f9c53',
];
const SECOND_SLOT = 'CA60cfd3d2f7cf38d0b292dd6554c19295';
const ASKED_FOR_THE_PHONE = 'CAd9744c26bc5cab62421b660cae8f9c53';
const BOOKING = 'booking-earlier-247';

const SLOT_A: NpxSlot = {
  slotId: 'slot-a', startAt: '2041-02-04T17:00:00.000Z', endAt: '2041-02-04T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-02-04', partnerOrgId: 'p1', partnerName: 'Partner One Optometry',
  clinicId: 'c1', clinicName: 'Clinic One', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};
const APPOINTMENT = {
  source: 'console_movable',
  appointment_id: 'appt-0247',
  person_id: 'person-0247',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  event_name: 'Dilated Exam',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};
/** The record a call booking leaves on the contact (v222 confirmation, v226 held cancel). */
function bookedRecord(over: { confirmation?: Record<string, unknown>; held?: Record<string, unknown> | null } = {}) {
  return {
    ...APPOINTMENT,
    outreach_text: {
      confirmation: {
        state: 'sent',
        booking_id: BOOKING,
        by: 'call',
        call_sid: 'CA00000000000000000000000000000001',
        when: 'Tue, Feb 5 at 9:00 AM',
        place: 'Partner Two Eyecare, 2 Sample Ave, Ste 4, Sampletown',
        phone: '5550120000',
        replaced_day: 'Mar 20',
        cancel: 'cancelled',
        queued_at: '2041-01-10T20:00:00.000Z',
        due_at: '2041-01-10T20:02:00.000Z',
        ...over.confirmation,
      },
      ...(over.held === null
        ? {}
        : {
            held_cancel: {
              state: 'cancelled',
              booking_id: BOOKING,
              call_sid: 'CA00000000000000000000000000000001',
              demo: false,
              appointment_id: 'appt-0247',
              appointment_date: '2041-03-20',
              person_id: 'person-0247',
              held_at: '2041-01-10T20:00:00.000Z',
              run_after: '2041-01-10T20:11:00.000Z',
              ...over.held,
            },
          }),
    },
  };
}

let store: FakeOutboundStore;
let npx: { availability: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn>; book: ReturnType<typeof vi.fn>; reportCancel: ReturnType<typeof vi.fn>; cancelBooking: ReturnType<typeof vi.fn> };
let cancel: ReturnType<typeof vi.fn>;
let recheck: ReturnType<typeof vi.fn>;
let fileTicket: ReturnType<typeof vi.fn>;
let recheckAnswer: SourceRecheck['state'];

function fakeNpx() {
  return {
    availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A], truncated: false })),
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A] })),
    book: vi.fn(async () => ({ ok: true, bookingId: 'booking-second', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
    reportCancel: vi.fn(async () => ({ ok: true })),
    cancelBooking: vi.fn(async () => ({ ok: true, outcome: 'cancelled' })),
  };
}

function source(): ContactSource {
  recheck = vi.fn(async (): Promise<SourceRecheck> =>
    recheckAnswer === 'current'
      ? { state: 'current', contact: { externalRef: 'appt-0247', phone: '+15555550111', firstName: 'Testa', lastName: 'Synthetic', data: { ...APPOINTMENT } } }
      : ({ state: recheckAnswer } as SourceRecheck),
  );
  return { name: 'test movable list', refreshEveryMs: 60_000, parkMs: 60_000, list: async () => [], recheck: recheck as never };
}

function withContact(customData: Record<string, unknown>) {
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'completed', firstName: 'Testa', lastName: 'Synthetic', customData });
}

beforeEach(() => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  npx = fakeNpx();
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  // The appointment the class gate would re-check is the one the booking
  // cancelled: on v246 it reads `gone`, so the caller heard "no longer available".
  recheckAnswer = 'gone';
  fileTicket = vi.fn(async () => ({ success: true, ticketNumber: 'VA-90247' }));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    npxDemo: { configured: true, ...fakeNpx() } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
    fileTicket: fileTicket as never,
    source: vi.fn(async () => source()) as never,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

async function returnedCall(sid: string) {
  openCallbackSession({
    callSid: sid,
    campaignKey: 'npx-outreach',
    campaignId: store.campaignId,
    callerPhone: '+15555550111',
    candidates: [],
    candidatesLoaded: true,
    purpose: 'we called about their upcoming appointment.',
    store,
  });
  const inbound = await store.openCallbackAttempt('c1', store.campaignId, sid);
  const cb = callbackSessionFor(sid)!;
  cb.chosen = { contactId: 'c1', phone: '+15555550111', firstName: 'Testa', verifiedBy: 'first_name' };
  cb.attemptId = inbound;
  const args = { outbound_callback_sid: sid, outbound_campaign: 'npx-outreach' };
  return (name: string, extra: Record<string, unknown> = {}) =>
    getTool(name)!.handler({ ...args, ...extra }) as Promise<Record<string, unknown>>;
}

const contactWith = (data: Record<string, unknown>): OutboundContact =>
  ({ contactId: 'c1', campaignId: 'k', attemptId: 'a', phone: '+15555550111', firstName: 'Testa', lastName: 'Synthetic', data }) as OutboundContact;

describe('the corpus: a patient who booked and rings back hears the booking, not a new offer', () => {
  for (const sid of CORPUS) {
    it(`${sid}: describe reads the booking back and offers nothing`, async () => {
      withContact(bookedRecord());
      const call = await returnedCall(sid);
      const r = await call(DESCRIBE_TOOL_NAME);
      expect(r.success).toBe(true);
      expect(r.already_booked).toBe(true);
      expect(r.say).toBe(
        "Our records show you're booked for a sooner appointment on Tuesday, February 5 at our partner practice in Sampletown. " +
          'Your appointment with us on March 20 has been cancelled.',
      );
      // Not the cancelled Azul appointment, and no offer.
      expect(String(r.say)).not.toMatch(/Dilated|availability sooner|What day and time/);
      expect(r.fix).toMatch(/Offer no other time/);
      // Nothing is offered, so neither the class gate nor NPX is asked.
      expect(recheck).toBeUndefined();
      expect(npx.availability).not.toHaveBeenCalled();
    });
  }

  it(`${SECOND_SLOT}: a second booking is refused, NPX is not asked to book, nothing is cancelled`, async () => {
    withContact(bookedRecord());
    const call = await returnedCall(SECOND_SLOT);
    await call(DESCRIBE_TOOL_NAME);
    const dob = await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2, 1950' });
    expect(dob.verified).toBe(true);
    const find = await call(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-04' });
    expect(find).toMatchObject({ success: false, error: 'already_booked' });
    const book = await call(BOOK_SOONER_TOOL_NAME, { date: '2041-02-04', time: '09:00', city: 'Testville' });
    expect(book).toMatchObject({ success: false, error: 'already_booked' });
    expect(npx.availability).not.toHaveBeenCalled();
    expect(npx.book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it(`${ASKED_FOR_THE_PHONE}: once the date of birth matches, the booking in full, the phone said in groups`, async () => {
    withContact(bookedRecord());
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    const r = await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2, 1950' });
    expect(r).toMatchObject({ success: true, verified: true, already_booked: true });
    expect(r.say).toBe(
      "You're booked for Tuesday, February 5 at 9:00 AM at Partner Two Eyecare, 2 Sample Ave, Ste 4, Sampletown. " +
        'Their phone number is 555, 012, 0000. Your appointment with us on March 20 has been cancelled.',
    );
    expect(r).not.toHaveProperty('current_appointment');
  });

  it('a wrong date of birth hears none of the booking details', async () => {
    withContact(bookedRecord());
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    const r = await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'July 9, 1961' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/Partner Two|555|9:00 AM|Sample Ave/);
  });

  it(`${ASKED_FOR_THE_PHONE}: the staff ticket names the booking, the note keeps its marker, the caller hears it stands`, async () => {
    withContact(bookedRecord());
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    const r = await call(STAFF_CALLBACK_TOOL_NAME, { request: 'the phone number for the partner office' });
    expect(r.success).toBe(true);
    expect(r.say).toBe("I've asked our scheduling team to call you back. Your sooner appointment on Tuesday, February 5 stays booked.");
    expect(String(r.say)).not.toMatch(/stays exactly as it is/);
    const ticket = fileTicket.mock.calls[0][0] as { description: string; priority: string };
    expect(ticket.priority).toBe('medium');
    expect(ticket.description).toMatch(`They booked a sooner exam before this call (NPX booking ${BOOKING})`);
    expect(ticket.description).not.toMatch(/Their appointment has not been changed/);
    expect(store.contacts.get('c1')!.notes).toBe(`npx_booking:${BOOKING}; staff_callback:VA-90247`);
  });

  it('a request to change it files urgent, tells staff what to do, and holds the text', async () => {
    withContact(bookedRecord({ confirmation: { state: 'due' } }));
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    const hold = vi.spyOn(store, 'holdConfirmation');
    const r = await call(STAFF_CALLBACK_TOOL_NAME, { request: 'cancel the new one', changes_booking: true });
    expect(r.say).toBe(
      "I've asked our scheduling team to call you back to change that. Until they call, your sooner appointment on Tuesday, February 5 is still booked.",
    );
    const ticket = fileTicket.mock.calls[0][0] as { description: string; priority: string };
    expect(ticket.priority).toBe('urgent');
    expect(ticket.description).toMatch(`URGENT: they asked to cancel or change the NPX booking ${BOOKING}, made before this call.`);
    expect(ticket.description).toMatch(/was cancelled: rebook it if they want it back/);
    expect(hold).toHaveBeenCalledWith('c1', BOOKING, 'staff_change');
  });
});

describe('what counts as already booked', () => {
  it('a booking undone on its call is no booking: the caller is offered as before, through the class gate', async () => {
    recheckAnswer = 'current';
    withContact(bookedRecord({ confirmation: { state: 'skipped', reason: 'booking_undone' }, held: { state: 'dropped', reason: 'booking_undone' } }));
    const call = await returnedCall(CORPUS[0]);
    const r = await call(DESCRIBE_TOOL_NAME);
    expect(r.already_booked).toBeUndefined();
    expect(String(r.say)).toMatch(/^Our records show you have a dilated eye exam/);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('a held cancel dropped as undone is no booking either', () => {
    expect(priorBookingOf(contactWith(bookedRecord({ held: { state: 'dropped', reason: 'booking_undone' } })))).toBeNull();
  });

  it('nor is a confirmation skipped as undone when the held cancel never reached the store', () => {
    expect(priorBookingOf(contactWith(bookedRecord({ confirmation: { state: 'skipped', reason: 'booking_undone' }, held: null })))).toBeNull();
    // A text skipped for another reason (the number opted out) leaves the booking standing.
    expect(priorBookingOf(contactWith(bookedRecord({ confirmation: { state: 'skipped', reason: 'do_not_contact' }, held: null })))).not.toBeNull();
  });

  it('a contact with no booking is not read as booked (the control)', async () => {
    recheckAnswer = 'current';
    withContact({ ...APPOINTMENT });
    const call = await returnedCall(CORPUS[0]);
    const r = await call(DESCRIBE_TOOL_NAME);
    expect(r.already_booked).toBeUndefined();
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('an Existing patient who booked before v246 still hears their booking (the bookings stand, operator 2026-11-16)', async () => {
    recheckAnswer = 'off_list';
    withContact(bookedRecord());
    const call = await returnedCall(CORPUS[2]);
    const r = await call(DESCRIBE_TOOL_NAME);
    expect(r.already_booked).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('what became of the Azul appointment is said as it happened', () => {
    const azul = (held: Record<string, unknown> | null, conf: Record<string, unknown> = {}) =>
      priorBookingOf(contactWith(bookedRecord({ held, confirmation: conf })))!.azul;
    expect(azul({ state: 'cancelled' })).toBe('cancelled');
    expect(azul({ state: 'held' })).toBe('cancelling');
    expect(azul({ state: 'claimed' })).toBe('cancelling');
    expect(azul({ state: 'not_cancelled' })).toBe('staff_will_cancel');
    expect(azul({ state: 'dropped', reason: 'staff_change' })).toBe('kept');
    expect(azul(null, { cancel: 'cancelled' })).toBe('cancelled');
    expect(azul(null, { cancel: 'pending' })).toBe('staff_will_cancel');
  });

  it('a change they asked for on an earlier call is said', async () => {
    withContact(bookedRecord({ confirmation: { state: 'held', reason: 'staff_change' }, held: { state: 'dropped', reason: 'staff_change' } }));
    const call = await returnedCall(CORPUS[0]);
    const r = await call(DESCRIBE_TOOL_NAME);
    expect(r.say).toMatch(/Your appointment with us on March 20 is kept, and our scheduling team will call you about the new one\./);
    expect(r.say).toMatch(/Our scheduling team will call you about the change you asked for\.$/);
  });

  it('a link booking reads the same way', () => {
    const b = priorBookingOf(contactWith(bookedRecord({ confirmation: { by: 'link', call_sid: undefined }, held: null })));
    expect(b).toMatchObject({ bookingId: BOOKING, city: 'Sampletown', azul: 'cancelled' });
  });
});

describe('a booking whose visit has passed is not read back (Codex P2 on #492)', () => {
  // Booked 2026-10-01 for Oct 20, a day already past whenever this runs.
  const PAST = { when: 'Tue, Oct 20 at 9:00 AM', queued_at: '2026-10-01T20:00:00.000Z', due_at: '2026-10-01T20:02:00.000Z' };
  const PAST_HELD = { appointment_date: '2026-11-01', held_at: '2026-10-01T20:00:00.000Z', run_after: '2026-10-01T20:11:00.000Z' };

  it('the visit day is the slot start, in Pacific time, when the record carries it', () => {
    // 01:30 UTC on Feb 6 is 5:30 PM on Feb 5 in Pacific time.
    expect(bookedVisitDay({ when: 'Tue, Feb 5 at 5:30 PM', queued_at: '2041-01-10T20:00:00.000Z', appointment_at: '2041-02-06T01:30:00.000Z' })).toBe('2041-02-05');
    // The slot start wins over the text.
    expect(bookedVisitDay({ when: 'Tue, Feb 5 at 9:00 AM', queued_at: '2041-01-10T20:00:00.000Z', appointment_at: '2041-03-01T17:00:00.000Z' })).toBe('2041-03-01');
  });

  it('a record written before v247 reads the day from the text, in the year after it was booked', () => {
    expect(bookedVisitDay({ when: 'Tue, Feb 5 at 9:00 AM', queued_at: '2041-01-10T20:00:00.000Z' })).toBe('2041-02-05');
    expect(bookedVisitDay({ when: 'Fri, Jan 8 at 9:00 AM', queued_at: '2040-12-20T20:00:00.000Z' })).toBe('2041-01-08');
    // Booked on the day of the visit itself.
    expect(bookedVisitDay({ when: 'Thu, Dec 20 at 4:00 PM', queued_at: '2040-12-20T17:00:00.000Z' })).toBe('2040-12-20');
    expect(bookedVisitDay({ when: 'a day nobody wrote down', queued_at: '2040-12-20T20:00:00.000Z' })).toBeNull();
    expect(bookedVisitDay({ when: 'Tue, Feb 5 at 9:00 AM', queued_at: '' })).toBeNull();
  });

  it('past: no booking; the visit day itself: still booked; a day that does not read: still booked', () => {
    const rec = (c: Record<string, unknown>) => contactWith(bookedRecord({ confirmation: c }));
    // Midnight Pacific on Feb 6 (PST) is 08:00 UTC.
    expect(priorBookingOf(rec({}), new Date('2041-02-06T08:00:00.000Z'))).toBeNull();
    expect(priorBookingOf(rec({}), new Date('2041-02-06T07:59:00.000Z'))).not.toBeNull();
    expect(priorBookingOf(rec({ when: 'a day nobody wrote down' }), new Date('2041-06-01T00:00:00.000Z'))).not.toBeNull();
  });

  it('on a returned call the ordinary checks run, and nothing says they are booked', async () => {
    withContact(bookedRecord({ confirmation: PAST, held: PAST_HELD }));
    const call = await returnedCall(CORPUS[0]);
    const r = await call(DESCRIBE_TOOL_NAME);
    expect(r.already_booked).toBeUndefined();
    expect(recheck).toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/booked for a sooner appointment|Partner Two|Sampletown/);
    expect(await call(FIND_SOONER_TOOL_NAME)).not.toMatchObject({ error: 'already_booked' });
  });

  it('the staff callback still keeps the booking marker first in the note', async () => {
    withContact(bookedRecord({ confirmation: PAST, held: PAST_HELD }));
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    const r = await call(STAFF_CALLBACK_TOOL_NAME, { request: 'a question about the visit' });
    expect(r.success).toBe(true);
    expect(String(r.say)).not.toMatch(/stays booked|still booked/);
    expect(store.contacts.get('c1')!.notes).toBe(`npx_booking:${BOOKING}; staff_callback:VA-90247`);
  });

  it('a booking the caller undid leaves no marker in the note', async () => {
    withContact(bookedRecord({ held: { state: 'dropped', reason: 'booking_undone' } }));
    const call = await returnedCall(ASKED_FOR_THE_PHONE);
    await call(DESCRIBE_TOOL_NAME);
    await call(STAFF_CALLBACK_TOOL_NAME, { request: 'a question about the visit' });
    expect(store.contacts.get('c1')!.notes).toBe('staff_callback:VA-90247');
  });

  it('a new confirmation carries the slot start', () => {
    const r = confirmationRecordFor({ contact: contactWith({ ...APPOINTMENT }), slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: true });
    expect(r.appointment_at).toBe(SLOT_A.startAt);
  });
});

describe('the words', () => {
  it('the text form is said in full', () => {
    expect(spokenFromTexted('Wed, Nov 25 at 2:30 PM')).toBe('Wednesday, November 25 at 2:30 PM');
    expect(spokenFromTexted('Jan 6')).toBe('January 6');
  });
  it('a phone is said in three groups, so it can be written down', () => {
    expect(spokenPhone('5550120000')).toBe('555, 012, 0000');
    expect(spokenPhone('+15550120000')).toBe('555, 012, 0000');
    expect(spokenPhone('ext 12')).toBe('ext 12');
  });
});
