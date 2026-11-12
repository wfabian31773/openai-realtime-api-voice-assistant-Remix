/**
 * v216: a booked caller who then asks for staff keeps the booking's marker.
 *
 * `book_sooner_exam` settles the contact `completed` with
 * `npx_booking:<id>`, which is how a booking is counted on the contact
 * (`agent_notes LIKE 'npx_booking:%'`). `request_staff_callback` then settled
 * it again with `staff_callback:<ticket>` alone, and the settle writes the
 * note it is given, so the booking's marker was gone.
 *
 * Measured, the live npx-outreach campaign to 2026-11-12: 21 calls booked;
 * on 4 of them the caller asked for staff after booking (none before), and
 * those 4 contacts read `staff_callback:` with no booking marker. The
 * campaign's contacts read 16 bookings where 20 contacts were booked.
 *
 * The corpus, by real SID. Synthetic patient, ids and practices only; the
 * transcripts stay in `call_logs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  STAFF_CALLBACK_TOOL_NAME,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const CORPUS = [
  'CAa73b9fea680caad6b075c32167464f2c',
  'CA9e93a873fd96a5a80672c18d1e0cd69c',
  'CAe91152bd2fbc5055319e1249a4389827',
  'CA77bca268d5969018324df94aa8fa491a',
] as const;

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

let store: FakeOutboundStore;
let attemptId: string;
let fileTicket: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  fileTicket = vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' }));
  setNpxOutreachDepsForTests({
    npx: {
      configured: true,
      availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B], truncated: false })),
      offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B] })),
      book: vi.fn(async () => ({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
      reportCancel: vi.fn(async () => ({ ok: true })),
    } as unknown as NpxOutreachClient,
    cancel: vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false })) as never,
    store: async () => store,
    fileTicket: fileTicket as never,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

function on(sid: string) {
  const args = {
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: '+15555550111',
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: sid,
  };
  return (name: string, extra: Record<string, unknown> = {}) => getTool(name)!.handler({ ...args, ...extra });
}

async function bookThenAskForStaff(sid: string) {
  const run = on(sid);
  await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  await run(FIND_SOONER_TOOL_NAME);
  const booked = (await run(BOOK_SOONER_TOOL_NAME, { option: '1' })) as Record<string, unknown>;
  expect(booked.success).toBe(true);
  expect(store.contacts.get('c1')!.notes).toBe('npx_booking:booking-1');
  return run(STAFF_CALLBACK_TOOL_NAME, { request: 'I want to talk to someone about my old appointment' });
}

describe('a booked caller who then asks for staff keeps the booking marker (the 4 SIDs of the campaign to 2026-11-12)', () => {
  for (const sid of CORPUS) {
    it(`${sid}: the contact still reads as booked, first, with the staff ticket beside it`, async () => {
      const r = (await bookThenAskForStaff(sid)) as Record<string, unknown>;
      expect(r).toMatchObject({ success: true, ticket_number: 'VA-90001' });
      const c = store.contacts.get('c1')!;
      expect(c.status).toBe('completed');
      expect(c.notes).toBe('npx_booking:booking-1; staff_callback:VA-90001');
      // The count the campaign is read by.
      expect(c.notes!.startsWith('npx_booking:')).toBe(true);
    });
  }

  it('a staff callback with no booking on the call writes the staff ticket alone, as before', async () => {
    await on('CA00000000000000000000000000000216')(STAFF_CALLBACK_TOOL_NAME, { request: 'a person please' });
    expect(store.contacts.get('c1')).toMatchObject({ status: 'completed', notes: 'staff_callback:VA-90001' });
  });

  it('a staff ticket that did not file leaves the booking marker untouched', async () => {
    fileTicket.mockResolvedValueOnce({ success: false, error: 'HTTP 500' });
    const r = (await bookThenAskForStaff(CORPUS[0])) as Record<string, unknown>;
    expect(r).toMatchObject({ success: false, error: 'ticket_not_filed' });
    expect(store.contacts.get('c1')!.notes).toBe('npx_booking:booking-1');
  });

  it('an opt-out after the booking still stands, and its note is not rewritten', async () => {
    const run = on(CORPUS[1]);
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME);
    await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    await store.settleContact('c1', 'do_not_call');
    await run(STAFF_CALLBACK_TOOL_NAME, { request: 'a person please' });
    expect(store.contacts.get('c1')).toMatchObject({ status: 'do_not_call', notes: 'npx_booking:booking-1' });
  });
});
