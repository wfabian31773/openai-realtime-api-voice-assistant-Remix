/**
 * The NPX outreach call's tools (v109), through the registry the runtime
 * dispatches from, on a fake store, a fake NPX and a fake Azul cancel.
 * Synthetic patient, ids and practices only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  MIN_DAYS_SOONER,
  outreachSessionFor,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  spokenClock,
  spokenDay,
} from './npxOutreachTools';
import { callbackSessionFor, openCallbackSession } from './outboundTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const SID = 'CA00000000000000000000000000000109';
const SLOT_A: NpxSlot = {
  slotId: 'slot-a', startAt: '2041-02-04T17:00:00.000Z', endAt: '2041-02-04T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-02-04', partnerOrgId: 'p1', partnerName: 'Partner One Optometry',
  clinicId: 'c1', clinicName: 'Clinic One', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};
const SLOT_B: NpxSlot = { ...SLOT_A, slotId: 'slot-b', startAt: '2041-02-06T22:30:00.000Z', day: '2041-02-06' };
const DATA = {
  source: 'console_movable',
  appointment_id: 'appt-0001',
  person_id: 'person-0001',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};

let store: FakeOutboundStore;
let attemptId: string;
let npx: { offer: ReturnType<typeof vi.fn>; book: ReturnType<typeof vi.fn>; reportCancel: ReturnType<typeof vi.fn> };
let cancel: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetOutreachSessionsForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  npx = {
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B] })),
    book: vi.fn(async () => ({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
    reportCancel: vi.fn(async () => ({ ok: true })),
  };
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
  });
});

afterEach(() => setNpxOutreachDepsForTests(null));

const DIALLED = () => ({
  outbound_contact_id: 'c1',
  outbound_attempt_id: attemptId,
  outbound_phone: '+15555550111',
  outbound_campaign: 'npx-outreach',
  outbound_call_sid: SID,
});
const run = (name: string, args: Record<string, unknown> = {}) => getTool(name)!.handler({ ...DIALLED(), ...args });
const verify = () => run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });

describe('confirm_patient_birthdate', () => {
  it('confirms on the date of birth on file, and only then hands over the appointment', async () => {
    const r = (await verify()) as Record<string, unknown>;
    expect(r).toMatchObject({ success: true, verified: true });
    expect(String(r.current_appointment)).toMatch(/Wednesday, March 20 at 9:00 AM at our Test Office office/);
    expect(outreachSessionFor(SID)!.verified).toBe(true);
  });

  it('a wrong date gets one more try, with nothing about the appointment and no hint of the date on file', async () => {
    const r = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'March 3rd, 1961' });
    expect(r).toMatchObject({ success: false, error: 'birthdate_does_not_match' });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/March 20|Test Office|1950|January/);
    expect(text).toMatch(/once more/);
  });

  it('two wrong dates end it: nothing disclosed, call back later', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'March 3rd, 1961' });
    const r = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'March 3rd, 1961' });
    expect(r).toMatchObject({ success: false, error: 'not_confirmed' });
    expect(JSON.stringify(r)).toMatch(/call_back_later/);
    const late = await verify();
    expect(late).toMatchObject({ success: false, error: 'not_confirmed' });
  });

  it('refuses on a call that is not an outreach call', async () => {
    expect(await getTool(CONFIRM_DOB_TOOL_NAME)!.handler({ date_of_birth: '01/02/1950' })).toMatchObject({ error: 'not_an_outreach_call' });
  });

  it('asks the model only for what the person said', () => {
    expect(Object.keys(getTool(CONFIRM_DOB_TOOL_NAME)!.input_schema.properties)).toEqual(['date_of_birth']);
    expect(getTool(FIND_SOONER_TOOL_NAME)!.input_schema.properties).toEqual({});
    expect(Object.keys(getTool(BOOK_SOONER_TOOL_NAME)!.input_schema.properties)).toEqual(['option']);
  });
});

describe('find_sooner_exam', () => {
  it('will not look before the person is confirmed', async () => {
    expect(await run(FIND_SOONER_TOOL_NAME)).toMatchObject({ success: false, error: 'not_confirmed_yet' });
    expect(npx.offer).not.toHaveBeenCalled();
  });

  it('asks NPX with the record\'s medical group, partners and appointment date, and reads the slots back', async () => {
    await verify();
    const r = (await run(FIND_SOONER_TOOL_NAME)) as unknown as { options: Array<{ option: number; when_and_where: string }> };
    expect(npx.offer).toHaveBeenCalledWith({
      medicalGroupName: 'Test Group CAP',
      partnerNames: ['Partner One Optometry'],
      replacedAppointmentDate: '2041-03-20',
      minDaysSooner: MIN_DAYS_SOONER,
    });
    expect(r.options.map((o) => o.option)).toEqual([1, 2]);
    expect(r.options[0].when_and_where).toBe('Monday, February 4 at 9:00 AM, at Partner One Optometry, 1 Test St, Testville, CA 90000');
  });

  it('nothing sooner is an answer: the current appointment stays', async () => {
    await verify();
    npx.offer.mockResolvedValueOnce({ ok: true, latestDay: '2041-02-27', slots: [] });
    const r = await run(FIND_SOONER_TOOL_NAME);
    expect(r).toMatchObject({ success: true, options: [] });
    expect(JSON.stringify(r)).toMatch(/stays as it is/);
  });

  it('an NPX failure is never spoken as one', async () => {
    await verify();
    npx.offer.mockResolvedValueOnce({ ok: false, error: 'server' });
    const r = await run(FIND_SOONER_TOOL_NAME);
    expect(r).toMatchObject({ success: false, error: 'server' });
    expect(JSON.stringify(r)).toMatch(/Do not say anything failed/);
  });
});

describe('book_sooner_exam', () => {
  async function offered() {
    await verify();
    await run(FIND_SOONER_TOOL_NAME);
  }

  it('books the chosen slot with the record\'s identity, cancels the Azul appointment, reports it, settles the contact', async () => {
    await offered();
    const r = (await run(BOOK_SOONER_TOOL_NAME, { option: '1' })) as Record<string, unknown>;
    expect(npx.book).toHaveBeenCalledWith(expect.objectContaining({
      slotId: 'slot-a',
      medicalGroupName: 'Test Group CAP',
      patient: expect.objectContaining({ firstName: 'Testa', lastName: 'Synthetic', dateOfBirth: '1950-01-02', ngePersonId: 'person-0001' }),
      replacedAppointment: { ngeAppointmentId: 'appt-0001', date: '2041-03-20' },
      callRef: SID,
    }));
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'appt-0001', personId: 'person-0001', appointmentDate: '2041-03-20' }));
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
    expect(store.contacts.get('c1')!.status).toBe('completed');
    expect(store.contacts.get('c1')!.notes).toBe('npx_booking:booking-1');
    expect(String(r.say)).toMatch(/You're booked for Monday, February 4 at 9:00 AM, at Partner One Optometry/);
    expect(String(r.say)).toMatch(/I've also cancelled your appointment with us on Wednesday, March 20/);
  });

  it('cancels only after NPX has booked', async () => {
    await offered();
    const order: string[] = [];
    npx.book.mockImplementationOnce(async () => { order.push('book'); return { ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A }; });
    cancel.mockImplementationOnce(async () => { order.push('cancel'); return { cancelled: true, alreadyCancelled: false }; });
    npx.reportCancel.mockImplementationOnce(async () => { order.push('report'); return { ok: true }; });
    await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    expect(order).toEqual(['book', 'cancel', 'report']);
  });

  it('a cancel that did not land is reported as failed, and the patient is not told it was cancelled', async () => {
    await offered();
    cancel.mockResolvedValueOnce({ cancelled: false, reason: 'person_mismatch' });
    const r = (await run(BOOK_SOONER_TOOL_NAME, { option: '2' })) as Record<string, unknown>;
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', { failed: 'person_mismatch' });
    expect(String(r.say)).not.toMatch(/I've also cancelled/);
    expect(String(r.say)).toMatch(/Our team will cancel your appointment with us/);
  });

  it('a slot taken in the meantime touches nothing and sends the agent back to look again', async () => {
    await offered();
    npx.book.mockResolvedValueOnce({ ok: false, error: 'slot_unavailable', next: 'offer_again' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    expect(r).toMatchObject({ success: false, error: 'slot_unavailable' });
    expect(cancel).not.toHaveBeenCalled();
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'no_such_option' });
    await run(FIND_SOONER_TOOL_NAME);
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ success: true, booked: true });
  });

  it('a booking NPX hands to staff promises nothing and cancels nothing', async () => {
    await offered();
    npx.book.mockResolvedValueOnce({ ok: false, error: 'held_by_other_practice', next: 'hand_to_staff' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    expect(r).toMatchObject({ success: false, error: 'held_by_other_practice' });
    expect(JSON.stringify(r)).toMatch(/do not promise a call/);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('books once: asking again on the same call repeats the confirmation', async () => {
    await offered();
    await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    const again = await run(BOOK_SOONER_TOOL_NAME, { option: '2' });
    expect(again).toMatchObject({ success: true, booked: true });
    expect(npx.book).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('will not book an option that was never offered, or before the person is confirmed', async () => {
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'not_confirmed_yet' });
    await verify();
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'no_such_option' });
    expect(npx.book).not.toHaveBeenCalled();
  });
});

describe('a patient who rings the number back', () => {
  const RETURNED = { outbound_callback_sid: SID };

  function openReturnedCall() {
    openCallbackSession({
      callSid: SID,
      campaignKey: 'npx-outreach',
      campaignId: store.campaignId,
      callerPhone: '+15555550111',
      candidates: [],
      candidatesLoaded: true,
      purpose: 'we were calling with some information for them.',
      store,
    });
  }

  it('gets nothing until identify_callback_caller has settled who they are', async () => {
    openReturnedCall();
    const r = await getTool(CONFIRM_DOB_TOOL_NAME)!.handler({ ...RETURNED, date_of_birth: 'January 2nd, 1950' });
    expect(r).toMatchObject({ success: false, error: 'caller_not_identified' });
  });

  it('once identified, still confirms the date of birth, then can be offered and booked like a dialled call', async () => {
    openReturnedCall();
    const inbound = await store.openCallbackAttempt('c1', store.campaignId, SID);
    const cb = callbackSessionFor(SID)!;
    cb.chosen = { contactId: 'c1', phone: '+15555550111', firstName: 'Testa' };
    cb.attemptId = inbound;
    expect(await getTool(FIND_SOONER_TOOL_NAME)!.handler({ ...RETURNED })).toMatchObject({ error: 'not_confirmed_yet' });
    expect(await getTool(CONFIRM_DOB_TOOL_NAME)!.handler({ ...RETURNED, date_of_birth: '01/02/1950' })).toMatchObject({ verified: true });
    await getTool(FIND_SOONER_TOOL_NAME)!.handler({ ...RETURNED });
    expect(await getTool(BOOK_SOONER_TOOL_NAME)!.handler({ ...RETURNED, option: '1' })).toMatchObject({ success: true, booked: true });
  });
});

describe('dates and times in words', () => {
  it('reads a calendar day without a time-zone shift, and NextGen\'s clock', () => {
    expect(spokenDay('2041-03-20')).toBe('Wednesday, March 20');
    expect(spokenClock('0900')).toBe('9:00 AM');
    expect(spokenClock('1330')).toBe('1:30 PM');
    expect(spokenClock('12:15')).toBe('12:15 PM');
    expect(spokenClock('0015')).toBe('12:15 AM');
    expect(spokenClock('')).toBe('');
  });
});
