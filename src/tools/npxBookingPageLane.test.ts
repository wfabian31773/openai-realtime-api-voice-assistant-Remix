/**
 * v211: the booking page's NPX half. The text's link offers and books through
 * the call's own code — the availability find_sooner_exam searches, and
 * bookOutreachSlot, which book_sooner_exam uses: NPX, then the Azul cancel,
 * then the cancel report, then the contact settled `completed`. A demo link
 * books in the demo NPX with the cancel simulated. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bookingOpening,
  npxBookingPageLane,
  resetOutreachAvailabilityForTests,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import type { OutboundContact } from '../runtime/outbound/campaign';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

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
  event_name: 'Dilated Exam',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};
const CONTACT: OutboundContact = {
  contactId: 'c1',
  campaignId: 'campaign-1',
  attemptId: '',
  phone: '+15555550111',
  firstName: 'Testa',
  lastName: 'Synthetic',
  data: DATA,
};

let store: FakeOutboundStore;
let npx: Record<'availability' | 'offer' | 'book' | 'reportCancel', ReturnType<typeof vi.fn>>;
let npxDemo: Record<'availability' | 'offer' | 'book' | 'reportCancel', ReturnType<typeof vi.fn>>;
let cancel: ReturnType<typeof vi.fn>;

const fakeNpx = () => ({
  availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B], truncated: false })),
  offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B] })),
  book: vi.fn(async () => ({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
  reportCancel: vi.fn(async () => ({ ok: true })),
});

beforeEach(() => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  npx = fakeNpx();
  npxDemo = fakeNpx();
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    npxDemo: { configured: true, ...npxDemo } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

describe('an opening on the page', () => {
  it('says when, where and with whom, in the practice\'s day, and nothing about the patient', () => {
    expect(bookingOpening(SLOT_A)).toEqual({
      id: 'slot-a',
      day: '2041-02-04',
      dayLabel: 'Monday, February 4',
      timeLabel: '9:00 AM',
      city: 'Testville',
      place: 'Partner One Optometry, 1 Test St, Testville',
      provider: 'Dr Test',
    });
  });
});

describe('the openings the page shows', () => {
  it('are the availability the call searches, read once and kept', async () => {
    const r = await npxBookingPageLane.openings(CONTACT, false);
    expect('openings' in r && r.openings.map((o) => o.id)).toEqual(['slot-a', 'slot-b']);
    await npxBookingPageLane.openings(CONTACT, false);
    expect(npx.availability).toHaveBeenCalledTimes(1);
    expect(npx.availability).toHaveBeenCalledWith(
      expect.objectContaining({ medicalGroupName: 'Test Group CAP', partnerNames: ['Partner One Optometry'], replacedAppointmentDate: '2041-03-20' }),
      undefined,
    );
  });

  it('come from the demo NPX on a demo link', async () => {
    await npxBookingPageLane.openings(CONTACT, true);
    expect(npxDemo.availability).toHaveBeenCalledTimes(1);
    expect(npx.availability).not.toHaveBeenCalled();
  });

  it('are an error, never an empty list, when NPX cannot answer', async () => {
    npx.availability.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    expect(await npxBookingPageLane.openings(CONTACT, false)).toEqual({ error: 'timeout' });
  });
});

describe('booking from the page', () => {
  const book = (openingId: string, demo = false) =>
    npxBookingPageLane.book({ contact: CONTACT, demo, openingId, callRef: 'text-link:c1', deadline: Date.now() + 36_000 });

  it('books through the call\'s sequence: NPX, the Azul cancel, the report, the contact settled', async () => {
    const r = await book('slot-a');
    expect(r).toMatchObject({ ok: true, bookingId: 'booking-1' });
    expect(r.ok && r.confirmation).toMatch(/^You're booked for Monday, February 4 at 9:00 AM with Dr Test/);
    expect(r.ok && r.confirmation).toMatch(/I've also cancelled your appointment with us on Wednesday, March 20/);
    expect(npx.book).toHaveBeenCalledWith(
      expect.objectContaining({
        slotId: 'slot-a',
        callRef: 'text-link:c1',
        patient: expect.objectContaining({ dateOfBirth: '1950-01-02', ngePersonId: 'person-0001' }),
        replacedAppointment: { ngeAppointmentId: 'appt-0001', date: '2041-03-20' },
      }),
    );
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'appt-0001', personId: 'person-0001' }));
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
    expect(store.contacts.get('c1')).toMatchObject({ status: 'completed', notes: 'npx_booking:booking-1' });
  });

  it('books only an opening this person\'s availability holds', async () => {
    expect(await book('slot-from-somewhere-else')).toEqual({ ok: false, error: 'slot_unavailable' });
    expect(npx.book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('says a slot NPX just gave away was taken, and touches nothing', async () => {
    npx.book.mockResolvedValueOnce({ ok: false, error: 'slot_taken', next: 'offer_again' });
    expect(await book('slot-a')).toEqual({ ok: false, error: 'slot_unavailable' });
    expect(cancel).not.toHaveBeenCalled();
    expect(store.contacts.get('c1')!.status).toBe('pending');
    // ... and the taken slot is not offered again.
    const r = await npxBookingPageLane.openings(CONTACT, false);
    expect('openings' in r && r.openings.map((o) => o.id)).toEqual(['slot-b']);
  });

  it('on a demo link books in the demo NPX and only simulates the Azul cancel', async () => {
    const r = await book('slot-a', true);
    expect(r.ok).toBe(true);
    expect(npxDemo.book).toHaveBeenCalledTimes(1);
    expect(npx.book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('decides a demo link the call\'s way', () => {
    expect(npxBookingPageLane.isDemo(CONTACT, 'npx-outreach-demo')).toBe(true);
    expect(npxBookingPageLane.isDemo({ ...CONTACT, data: { ...DATA, source: 'npx_outreach_demo' } }, 'npx-outreach')).toBe(true);
    expect(npxBookingPageLane.isDemo(CONTACT, 'npx-outreach')).toBe(false);
    vi.stubEnv('NPX_OUTREACH_MODE', '');
    expect(npxBookingPageLane.isDemo(CONTACT, 'npx-outreach')).toBe(true);
  });

  it('says the appointment being replaced once the date of birth has matched', () => {
    expect(npxBookingPageLane.currentAppointment(CONTACT)).toBe(
      'a dilated eye exam on Wednesday, March 20 at 9:00 AM at our Test Office office',
    );
  });
});
