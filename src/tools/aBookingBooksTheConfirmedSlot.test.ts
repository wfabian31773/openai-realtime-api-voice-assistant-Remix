/**
 * v218: book_sooner_exam books the slot the agent said back and the caller
 * confirmed, not an option number read against the last list.
 *
 * The corpus, by real SID: CA93903cf32d7636e047cbb5b9a9b109f6 (npx-outreach,
 * 2026-11-12). Two find_sooner_exam answers arrived 1.8 s apart in one turn;
 * the agent read both lists to the caller as one, the caller chose a 10:00 AM
 * slot from the first, the agent said that slot back, the caller said yes,
 * and book_sooner_exam was called with option 2. Option 2 of the LAST list
 * was a 9:20 AM slot eight days later, and that is what was booked (and the
 * caller's own appointment cancelled for it).
 *
 * Measured, every live NPX outreach booking 2026-10-29..11-12: 1 of 34 booked
 * a slot other than the one confirmed, and it is the only call where the list
 * changed between the caller's choice and the booking.
 *
 * Synthetic patient, ids and practices only; the transcript stays in
 * `call_logs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  chosenSlot,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import { slotDateTime } from './npxAvailabilitySearch';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const SID = 'CA93903cf32d7636e047cbb5b9a9b109f6';

// February 2041 is Pacific Standard Time: 09:00 local is 17:00Z.
function slot(id: string, startAt: string, city: 'Rancho Cucamonga' | 'Fontana', provider = 'Dr Test'): NpxSlot {
  const end = new Date(Date.parse(startAt) + 30 * 60_000).toISOString();
  return {
    slotId: id,
    startAt,
    endAt: end,
    timezone: 'America/Los_Angeles',
    day: startAt.slice(0, 10),
    partnerOrgId: 'p1',
    partnerName: 'Partner One Optometry',
    clinicId: city === 'Fontana' ? 'clinic-f' : 'clinic-rc',
    clinicName: `Clinic ${city}`,
    address: `1 Test Ave, ${city}, CA 91730`,
    phone: '555-010-0000',
    providerName: provider,
    visitType: 'Comprehensive Exam',
  };
}

// The first list (one day, spread): 9:00, 10:00, 11:00. The caller chose 10:00.
const FEB5_0900 = slot('feb5-0900', '2041-02-05T17:00:00.000Z', 'Rancho Cucamonga');
const FEB5_1000 = slot('feb5-1000', '2041-02-05T18:00:00.000Z', 'Rancho Cucamonga');
const FEB5_1100 = slot('feb5-1100', '2041-02-05T19:00:00.000Z', 'Rancho Cucamonga');
// The second list (a range, one a day). Option 2 here is what was booked.
const FEB13_0900 = slot('feb13-0900', '2041-02-13T17:00:00.000Z', 'Rancho Cucamonga');
const FEB14_0920 = slot('feb14-0920', '2041-02-14T17:20:00.000Z', 'Rancho Cucamonga');
const FEB15_0920 = slot('feb15-0920', '2041-02-15T17:20:00.000Z', 'Rancho Cucamonga');
// Another office at the confirmed minute, for the city to settle.
const FEB5_1000_FONTANA = slot('feb5-1000-f', '2041-02-05T18:00:00.000Z', 'Fontana', 'Dr Other');

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
let book: ReturnType<typeof vi.fn>;
let available: NpxSlot[];

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  available = [FEB5_0900, FEB5_1000, FEB5_1100, FEB13_0900, FEB14_0920, FEB15_0920];
  book = vi.fn(async (req: { slotId: string }) => ({
    ok: true,
    bookingId: `booking-${req.slotId}`,
    alreadyBooked: false,
    recordGroupDiffers: false,
    slot: available.find((s) => s.slotId === req.slotId),
  }));
  setNpxOutreachDepsForTests({
    npx: {
      configured: true,
      availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: available, truncated: false })),
      offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: available })),
      book,
      reportCancel: vi.fn(async () => ({ ok: true })),
    } as unknown as NpxOutreachClient,
    cancel: vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false })) as never,
    store: async () => store,
    fileTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' })) as never,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

function run(name: string, extra: Record<string, unknown> = {}) {
  return getTool(name)!.handler({
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: '+15555550111',
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: SID,
    ...extra,
  }) as Promise<Record<string, unknown>>;
}

/** The corpus shape: verified, then two finds in one turn, both read out. */
async function twoListsRead() {
  await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  const first = await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Rancho Cucamonga' });
  const second = await run(FIND_SOONER_TOOL_NAME, { from_date: '2041-02-13', to_date: '2041-02-15' });
  return { first, second };
}

const ids = (r: Record<string, unknown>) => (r.options as Array<{ slot_id?: string; date: string; time: string }>).map((o) => `${o.date} ${o.time}`);

describe(`${SID}: the slot confirmed is the slot booked`, () => {
  it('the two lists are the corpus shape: option 2 is a different slot in each', async () => {
    const { first, second } = await twoListsRead();
    expect(ids(first)).toEqual(['2041-02-05 09:00', '2041-02-05 10:00', '2041-02-05 11:00']);
    expect(ids(second)).toEqual(['2041-02-13 09:00', '2041-02-14 09:20', '2041-02-15 09:20']);
  });

  it('the date and time said back book that slot, whatever option number rides with them', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '2', date: '2041-02-05', time: '10:00', city: 'Rancho Cucamonga' });
    expect(r).toMatchObject({ success: true, booked: true, booked_by: 'date_time', option_disagreed: true });
    expect(book).toHaveBeenCalledTimes(1);
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000.slotId });
  });

  it('the time in the words the agent said ("10 AM") books it too', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10 AM' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(r).not.toHaveProperty('option_disagreed');
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000.slotId });
  });

  it('an option number alone after two lists is not one time: nothing is booked, and the model is told to send the date and time', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '2' });
    expect(r).toMatchObject({ success: false, error: 'which_list' });
    expect(r).not.toHaveProperty('say');
    expect(String(r.fix)).toMatch(/date and time/);
    expect(book).not.toHaveBeenCalled();
  });

  it('a date and time not read to them books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:30' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(r).not.toHaveProperty('say');
    expect(book).not.toHaveBeenCalled();
  });

  it('a slot that is open but was never offered on this call is not bookable', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { from_date: '2041-02-13', to_date: '2041-02-15' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('with one list read, an option number alone still books its slot, as before v218', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Rancho Cucamonga' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '2' });
    expect(r).toMatchObject({ success: true, booked_by: 'option' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000.slotId });
  });

  it('the same choice read in both lists books on its option number alone', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Rancho Cucamonga' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { option: '2' });
    expect(r).toMatchObject({ success: true, booked_by: 'option' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000.slotId });
  });

  it('nothing offered yet books nothing', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'no_such_option' });
    expect(await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00' })).toMatchObject({ error: 'not_offered' });
    expect(await run(BOOK_SOONER_TOOL_NAME, {})).toMatchObject({ error: 'no_choice' });
    expect(book).not.toHaveBeenCalled();
  });

  it('each choice find_sooner_exam offers carries its date and 24-hour time', async () => {
    const { first } = await twoListsRead();
    for (const o of first.options as Array<{ date: string; time: string }>) {
      expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.time).toMatch(/^\d{2}:\d{2}$/);
    }
    expect(slotDateTime(FEB14_0920)).toEqual({ date: '2041-02-14', time: '09:20' });
  });
});

describe('two choices at the confirmed minute', () => {
  beforeEach(() => {
    available = [FEB5_0900, FEB5_1000, FEB5_1100, FEB5_1000_FONTANA];
  });

  it('the city settles which', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Rancho Cucamonga' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Fontana' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00', city: 'Fontana' });
    expect(r).toMatchObject({ success: true });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000_FONTANA.slotId });
  });

  it('with no city, the option number settles which when it points at one of them', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Fontana' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00', option: '1' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB5_1000_FONTANA.slotId });
  });

  it('with no city and no option to settle it, the agent is asked which, and nothing is booked', async () => {
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Rancho Cucamonga' });
    await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Fontana' });
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00' });
    expect(r).toMatchObject({ success: false, error: 'which_one' });
    expect(String(r.fix)).toMatch(/Fontana/);
    expect(book).not.toHaveBeenCalled();
  });
});

describe('a slot taken while the caller decided', () => {
  it('is forgotten with every list read: the same date and time is not booked again', async () => {
    await twoListsRead();
    book.mockResolvedValueOnce({ ok: false, error: 'slot_unavailable', next: 'offer_again' });
    expect(await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00' })).toMatchObject({ error: 'slot_unavailable' });
    expect(await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05', time: '10:00' })).toMatchObject({ error: 'not_offered' });
    expect(book).toHaveBeenCalledTimes(1);
  });
});

describe('chosenSlot', () => {
  const offers = [[FEB5_0900, FEB5_1000, FEB5_1100], [FEB13_0900, FEB14_0920, FEB15_0920]];

  it('the pre-v218 rule (the option in the last list) is what option_disagreed measures', () => {
    expect(chosenSlot(offers, { option: '2', date: '2041-02-14', time: '09:20' })).toEqual({ slot: FEB14_0920, by: 'date_time' });
    expect(chosenSlot(offers, { option: '2', date: '2041-02-05', time: '10:00' })).toEqual({ slot: FEB5_1000, by: 'date_time', optionDisagreed: true });
  });

  it('an option given as a number reads the same as one given as a string', () => {
    expect(chosenSlot([[FEB5_0900, FEB5_1000]], { option: 2 })).toEqual({ slot: FEB5_1000, by: 'option' });
  });

  it('a malformed date or time is not read as a choice', () => {
    expect(chosenSlot(offers, { date: 'Feb 5', time: '10:00' })).toMatchObject({ refusal: { error: 'no_choice' } });
    expect(chosenSlot(offers, { date: '2041-02-05', time: 'morning' })).toMatchObject({ refusal: { error: 'no_choice' } });
  });
});
