/**
 * v229: book_sooner_exam reads the date it was sent, and a refusal names the
 * exact date and time to send back.
 *
 * The corpus, by real SID (npx-outreach, 2026-11-13):
 *  - CA3eec4f155e08f15868b34008bd15d988: two find_sooner_exam lists were read
 *    to the caller, the caller chose the first choice of the SECOND list, and
 *    book_sooner_exam was refused `which_list` four times running (18:48:22,
 *    18:48:22, 18:48:26, 18:48:40). Nothing was booked; the call ended on a
 *    staff callback. The refusal told the model to "call again with the date
 *    and time from find_sooner_exam's answer" and it did not manage it.
 *  - CA6a380faa68cb2f30fe61fb3f6d0dc4e2: five lists read, three `which_list`
 *    refusals in under a second, then a booking by date and time 16 s later.
 *
 * 2 of the 4 NPX calls since v218 that tried to book hit `which_list`. The
 * timeline kept none of the booking's arguments, so whether the model sent
 * the option alone or the date in another form is not recoverable; v218 read
 * only YYYY-MM-DD and treated any other date as no date at all, which falls to
 * the option number and, with two lists read, to `which_list` every time.
 *
 * The fix is the refusal, not the reader (operator, 2026-11-13, after six
 * review rounds on a reader that took words, numbers and time zones): the
 * date is still read only as YYYY-MM-DD, exactly as find_sooner_exam writes
 * each choice, the time as v218 read it, and every refusal now hands
 * back the choices in that form, `which_list` naming the slots the option
 * points at. Any other form is named as unreadable and books nothing. The
 * arguments' form is recorded from now on.
 *
 * Synthetic patient, practices and slots only; the transcripts stay in
 * `call_logs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  bookingArgsReceived,
  chosenSlot,
  readChosenDate,
  readChosenTime,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const CORPUS = ['CA3eec4f155e08f15868b34008bd15d988', 'CA6a380faa68cb2f30fe61fb3f6d0dc4e2'] as const;

// February 2041 is Pacific Standard Time: 09:00 local is 17:00Z.
function slot(id: string, startAt: string, city: 'Beaumont' | 'Moreno Valley'): NpxSlot {
  return {
    slotId: id,
    startAt,
    endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(),
    timezone: 'America/Los_Angeles',
    day: startAt.slice(0, 10),
    partnerOrgId: 'p1',
    partnerName: 'Partner One Optometry',
    clinicId: city === 'Beaumont' ? 'clinic-b' : 'clinic-mv',
    clinicName: `Clinic ${city}`,
    address: `1 Test Ave, ${city}, CA 92223`,
    phone: '555-010-0000',
    providerName: 'Dr Test',
    visitType: 'Comprehensive Exam',
  };
}

// The first list (one day, spread): option 1 is 9:00 on Feb 5.
const FEB5_0900 = slot('feb5-0900', '2041-02-05T17:00:00.000Z', 'Beaumont');
const FEB5_1000 = slot('feb5-1000', '2041-02-05T18:00:00.000Z', 'Beaumont');
const FEB5_1100 = slot('feb5-1100', '2041-02-05T19:00:00.000Z', 'Beaumont');
// The second list (a range, one a day): option 1 is 9:00 on Feb 13, the one
// the caller chose.
const FEB13_0900 = slot('feb13-0900', '2041-02-13T17:00:00.000Z', 'Beaumont');
const FEB14_0940 = slot('feb14-0940', '2041-02-14T17:40:00.000Z', 'Beaumont');
const FEB15_1000 = slot('feb15-1000', '2041-02-15T18:00:00.000Z', 'Moreno Valley');

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
let sid: string;
const available = [FEB5_0900, FEB5_1000, FEB5_1100, FEB13_0900, FEB14_0940, FEB15_1000];

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  sid = CORPUS[0];
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
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
    outbound_call_sid: sid,
    ...extra,
  }) as Promise<Record<string, unknown>>;
}

/** The corpus shape: verified, then two lists read, option 1 in each a different slot. */
async function twoListsRead() {
  await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  const first = await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05', city: 'Beaumont' });
  const second = await run(FIND_SOONER_TOOL_NAME, { from_date: '2041-02-13', to_date: '2041-02-15' });
  const at = (r: Record<string, unknown>) => (r.options as Array<{ date: string; time: string }>).map((o) => `${o.date} ${o.time}`);
  return { first: at(first), second: at(second) };
}

for (const callSid of CORPUS) {
  describe(`${callSid}: an option number after two lists names the slots it could mean`, () => {
    beforeEach(() => {
      sid = callSid;
    });

    it('the lists are the corpus shape: option 1 is a different slot in each', async () => {
      const { first, second } = await twoListsRead();
      expect(first[0]).toBe('2041-02-05 09:00');
      expect(second[0]).toBe('2041-02-13 09:00');
    });

    it('which_list writes each slot option 1 points at with the exact date and time to send', async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
      expect(r).toMatchObject({ success: false, error: 'which_list' });
      expect(r).not.toHaveProperty('say');
      expect(String(r.fix)).toContain('(date 2041-02-05, time 09:00)');
      expect(String(r.fix)).toContain('(date 2041-02-13, time 09:00)');
      expect(String(r.fix)).toContain('in Beaumont');
      expect(r.choices).toEqual([
        expect.objectContaining({ date: '2041-02-05', time: '09:00', city: 'Beaumont' }),
        expect.objectContaining({ date: '2041-02-13', time: '09:00', city: 'Beaumont' }),
      ]);
      expect(book).not.toHaveBeenCalled();
    });

    it('sending back the date and time as written books the one the caller chose', async () => {
      await twoListsRead();
      await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
      const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '09:00', option: '1' });
      expect(r).toMatchObject({ success: true, booked: true, booked_by: 'date_time' });
      expect(book).toHaveBeenCalledTimes(1);
      expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
    });

    it('a date or time in another form, with the option beside it, is refused which_list with the slots named, then the written form books', async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13', time: '9:00 AM', option: '1', city: 'Beaumont' });
      expect(r).toMatchObject({
        success: false,
        error: 'which_list',
        received_date: 'unreadable',
        received_time: 'read',
        received_option: true,
      });
      expect(String(r.fix)).toContain('(date 2041-02-13, time 09:00)');
      expect(book).not.toHaveBeenCalled();
      const booked = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '09:00', city: 'Beaumont' });
      expect(booked).toMatchObject({ success: true, booked_by: 'date_time' });
      expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
    });
  });
}

describe('only the date as written, and the time as v218 read it, are read; any other form books nothing and hands back the choices', () => {
  for (const date of [
    'February 13',
    'Feb 13',
    'Feb. 13th',
    'Wednesday, February 13',
    'Wednesday, February 13, 2041',
    '2/13',
    '02/13/2041',
    '2-13-41',
    '13 February',
    '2041-02-13.',
    ' 2041-02-13 or 2041-02-14',
    '2041-02-13 garbage',
    '2041-02-13T09:00',
    '2041-02-13T17:00:00Z',
    'next Thursday',
  ]) {
    it(`date "${date}" is unreadable and books nothing`, async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date, time: '09:00' });
      expect(r).toMatchObject({ success: false, error: 'no_choice', received_date: 'unreadable', received_time: 'read' });
      expect(String(r.fix)).toMatch(/the date could not be read: send the date as YYYY-MM-DD and the time as 24-hour HH:MM/);
      expect(r.choices).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2041-02-13', time: '09:00', city: 'Beaumont' })]));
      expect((r.choices as unknown[]).length).toBe(6);
      expect(book).not.toHaveBeenCalled();
    });
  }

  for (const time of ['09:00:00', '09:00:99', '0900', '17:00Z', '2041-02-13T09:00', '9 a. m.', 'nine']) {
    it(`time "${time}" is unreadable and books nothing`, async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time });
      expect(r).toMatchObject({ success: false, error: 'no_choice', received_date: 'iso', received_time: 'unreadable' });
      expect(String(r.fix)).toMatch(/the time could not be read/);
      expect(book).not.toHaveBeenCalled();
    });
  }

  it('a date sent as a date-time with no time beside it gives no time', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T09:00' });
    expect(r).toMatchObject({ success: false, error: 'no_choice', received_date: 'unreadable', received_time: 'none' });
    expect(book).not.toHaveBeenCalled();
  });

  it('readChosenDate reads YYYY-MM-DD and nothing else', () => {
    expect(readChosenDate('2041-02-13')).toEqual({ day: '2041-02-13', form: 'iso' });
    expect(readChosenDate(' 2041-02-13 ')).toEqual({ day: '2041-02-13', form: 'iso' });
    expect(readChosenDate('2041-02-13.')).toEqual({ form: 'unreadable' });
    expect(readChosenDate('2041-2-13')).toEqual({ form: 'unreadable' });
    expect(readChosenDate('Feb 13')).toEqual({ form: 'unreadable' });
    expect(readChosenDate('2041-02-13T09:00')).toEqual({ form: 'unreadable' });
    expect(readChosenDate('')).toEqual({ form: 'none' });
    expect(readChosenDate(undefined)).toEqual({ form: 'none' });
  });

  it('a time in the forms v218 read books, as it does on main', async () => {
    for (const time of ['09:00', '9:00', '9 AM', '9:00 AM', '9:00 a.m.']) {
      book.mockClear();
      resetOutreachSessionsForTests();
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time });
      expect(r).toMatchObject({ success: true, booked_by: 'date_time', received_time: 'read' });
      expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
    }
  });

  it('readChosenTime reads what v218 read and nothing else', () => {
    expect(readChosenTime('09:00')).toEqual({ minutes: 540, form: 'read' });
    expect(readChosenTime('14:30')).toEqual({ minutes: 870, form: 'read' });
    expect(readChosenTime('2:30 PM')).toEqual({ minutes: 870, form: 'read' });
    expect(readChosenTime('00:00')).toEqual({ minutes: 0, form: 'read' });
    expect(readChosenTime(' 09:00 ')).toEqual({ minutes: 540, form: 'read' });
    expect(readChosenTime('24:00')).toEqual({ form: 'unreadable' });
    expect(readChosenTime('09:60')).toEqual({ form: 'unreadable' });
    expect(readChosenTime('09:00:00')).toEqual({ form: 'unreadable' });
    expect(readChosenTime('09:00Z')).toEqual({ form: 'unreadable' });
    expect(readChosenTime('')).toEqual({ form: 'none' });
    expect(readChosenTime(undefined)).toEqual({ form: 'none' });
  });
});

// Every shape the review rounds on #476 found in the wider reader (a zone, a
// rolled-over day, two moments stitched into a third, a trailing second date,
// seconds out of range, a weekday that contradicts the date) is now a form
// this reads as unreadable or as a day no choice is on, so none can book.
describe('the shapes the review rounds found book nothing', () => {
  for (const [label, args] of [
    ['a UTC date-time', { date: '2041-02-13T17:00:00Z' }],
    ['a day the calendar does not have', { date: '2041-02-30T17:00:00Z' }],
    ['a time on another day than the date', { date: '2041-02-13', time: '2041-02-05T17:00:00Z' }],
    ['a +14:00 time that converts to the day before', { date: '2041-02-16', time: '2041-02-16T08:00:00+14:00' }],
    ['a date-time beside a time at another hour', { date: '2041-02-05T09:00', time: '10:00' }],
    ['a second date after the first', { date: '2041-02-13 or 2041-02-14', time: '09:00' }],
    ['seconds out of range', { date: '2041-02-13', time: '09:00:99' }],
    ['a weekday that contradicts the date', { date: 'Thursday, February 13, 2041', time: '09:00' }],
    ['a year with a full stop', { date: 'February 13, 2042.', time: '09:00' }],
    ['a two-digit year', { date: 'February 13, 42', time: '09:00' }],
  ] as const) {
    it(`${label}`, async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { ...args });
      expect(r).toMatchObject({ success: false });
      expect(r.choices).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2041-02-13', time: '09:00' })]));
      expect(book).not.toHaveBeenCalled();
    });
  }

  it('a day the calendar does not have, written as a date, is a day no choice is on', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-30', time: '09:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered', received_date: 'iso' });
    expect(book).not.toHaveBeenCalled();
  });
});

describe('nothing is invented: the date and time as written must be a choice read on the call', () => {
  it('a day no choice is on is refused as not offered, with the choices written out', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-20', time: '09:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect((r.choices as unknown[]).length).toBe(6);
    expect(book).not.toHaveBeenCalled();
  });

  it('the right month and day in another year is not the offered day', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2042-02-13', time: '09:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('the right day at a time not offered books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '10:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('a lone option number with one list read still books, as before v229', () => {
    expect(chosenSlot([[FEB5_0900, FEB5_1000]], { option: '2' })).toEqual({ slot: FEB5_1000, by: 'option' });
  });
});

// The timeline half is in src/services/toolTimeline.test.ts (it needs the db mock).
describe('what the booking received is recorded, never the values', () => {
  it('the three received_* words ride on every booking answer', async () => {
    await twoListsRead();
    const refused = await run(BOOK_SOONER_TOOL_NAME, { option: '1' });
    expect(refused).toMatchObject({ received_date: 'none', received_time: 'none', received_option: true });
    const booked = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '09:00' });
    expect(booked).toMatchObject({ received_date: 'iso', received_time: 'read', received_option: false });
  });

  it('bookingArgsReceived names forms only', () => {
    expect(bookingArgsReceived({ date: 'Feb 13', time: 'nine', option: 2 })).toEqual({
      received_date: 'unreadable',
      received_time: 'unreadable',
      received_option: true,
    });
    expect(bookingArgsReceived({ date: '2041-02-13', time: '09:00' })).toEqual({
      received_date: 'iso',
      received_time: 'read',
      received_option: false,
    });
  });
});

// Codex P2s on #476 (head 8ece0df7): the received_* words were added only on
// the booking path, so an early answer carried none and a second call that
// joined a booking in flight carried the first call's; and `which_one` was the
// one booking refusal with no choices.
describe('every answer carries what that call received, and which_one carries the choices', () => {
  it('a booking before the date of birth is confirmed carries its own received_* words', async () => {
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '09:00' });
    expect(r).toMatchObject({ success: false, received_date: 'iso', received_time: 'read', received_option: false });
    expect(book).not.toHaveBeenCalled();
  });

  it('a second call that joins a booking in flight records its own arguments, not the first call’s', async () => {
    await twoListsRead();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = book.getMockImplementation()!;
    book.mockImplementationOnce(async (req: { slotId: string }) => {
      await gate;
      return original(req);
    });
    const first = run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '09:00' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = run(BOOK_SOONER_TOOL_NAME, { option: '2' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ success: true, received_date: 'iso', received_time: 'read', received_option: false });
    expect(b).toMatchObject({ success: true, received_date: 'none', received_time: 'none', received_option: true });
    expect(book).toHaveBeenCalledTimes(1);
  });

  it('two choices at one date and time are refused which_one with both written out', () => {
    const otherCity = slot('feb13-0900-mv', '2041-02-13T17:00:00.000Z', 'Moreno Valley');
    const r = chosenSlot([[FEB13_0900, otherCity]], { date: '2041-02-13', time: '09:00' });
    expect(r).toMatchObject({ refusal: { error: 'which_one' } });
    expect((r as { refusal: { choices: unknown[] } }).refusal.choices).toEqual([
      expect.objectContaining({ date: '2041-02-13', time: '09:00', city: 'Beaumont' }),
      expect.objectContaining({ date: '2041-02-13', time: '09:00', city: 'Moreno Valley' }),
    ]);
  });
});
