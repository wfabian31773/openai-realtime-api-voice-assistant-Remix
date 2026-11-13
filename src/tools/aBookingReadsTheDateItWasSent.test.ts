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
 * the option alone or the date in words is not recoverable; v218 read only
 * YYYY-MM-DD and treated any other date as no date at all, which falls to the
 * option number and, with two lists read, to `which_list` every time. Both
 * shapes are covered here, and the arguments' form is recorded from now on.
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
  readIsoDateTime,
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

    it('the date in words, with the option beside it, books the slot said back and is not refused which_list', async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13', time: '9:00 AM', option: '1', city: 'Beaumont' });
      expect(r).toMatchObject({ success: true, booked_by: 'date_time', received_date: 'words', received_time: 'read', received_option: true });
      expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
    });
  });
}

describe('every way the date of an offered choice can arrive is read to that day', () => {
  for (const date of [
    '2041-02-13',
    'February 13',
    'Feb 13',
    'Feb. 13th',
    'Wednesday, February 13',
    'Wednesday, February 13, 2041',
    '2/13',
    '02/13/2041',
    '2-13-41',
    '13 February',
  ]) {
    it(`"${date}" with 9 AM books the February 13 choice`, async () => {
      await twoListsRead();
      const r = await run(BOOK_SOONER_TOOL_NAME, { date, time: '9 AM' });
      expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
      expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
    });
  }

  it('a date and time sent together as one ISO string books with no time argument', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T09:00' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
  });

  it('a time with seconds or written "a.m." is read', () => {
    expect(readChosenTime('09:00:00')).toEqual({ minutes: 540, form: 'read' });
    expect(readChosenTime('9:00 a.m.')).toEqual({ minutes: 540, form: 'read' });
    expect(readChosenTime('9 a. m.')).toEqual({ minutes: 540, form: 'read' });
    expect(readChosenTime('2:30 p.m.')).toEqual({ minutes: 870, form: 'read' });
  });
});

// Codex P2 on #476 (head 7838fcc): a date-time carrying a UTC offset kept its
// clock and dropped its offset, so 17:00Z (09:00 in Los Angeles) was read as
// 17:00 against slots written in Pacific time.
describe('a date-time with a time zone is read on the practice clock', () => {
  it('17:00Z is 09:00 in Los Angeles and books the February 13 9:00 AM choice', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T17:00:00Z' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time', received_date: 'iso', received_time: 'read' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
  });

  it('a Pacific offset books the same choice', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T09:00:00-08:00' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
  });

  it('an offset that moves the day is read to the Pacific day', async () => {
    await twoListsRead();
    // 08:00 on the 16th at +14:00 is 10:00 on the 15th in Los Angeles.
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-16T08:00:00+14:00' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB15_1000.slotId });
  });

  it('a whole date-time in the time field is read on the practice clock too', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '2041-02-13T17:00:00Z' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
  });

  it('a zone that cannot be placed books nothing and the refusal names the choices', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T12:00 EST' });
    expect(r).toMatchObject({ success: false, received_date: 'unreadable', received_time: 'unreadable' });
    expect(r.choices).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2041-02-13', time: '09:00' })]));
    expect(book).not.toHaveBeenCalled();
  });

  it('a bare time with an offset cannot be placed on a day and books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '17:00Z' });
    expect(r).toMatchObject({ success: false, received_time: 'unreadable' });
    expect(book).not.toHaveBeenCalled();
  });

  it('readIsoDateTime converts an offset and reads a Pacific or zoneless time as written', () => {
    expect(readIsoDateTime('2041-02-13T17:00:00Z')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13T17:00:00.000Z')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13 17:00 UTC')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13T22:30+0530')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13T12:00-05')).toEqual({ day: '2041-02-13', minutes: 540 });
    // Summer: Los Angeles is UTC-7.
    expect(readIsoDateTime('2041-07-01T16:00:00Z')).toEqual({ day: '2041-07-01', minutes: 540 });
    expect(readIsoDateTime('2041-02-13T09:00')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13T09:00 PST')).toEqual({ day: '2041-02-13', minutes: 540 });
    expect(readIsoDateTime('2041-02-13 2:00 pm')).toBeNull();
    expect(readIsoDateTime('2041-02-13 02:00 pm')).toEqual({ day: '2041-02-13', minutes: 840 });
    expect(readIsoDateTime('2041-02-13T09:00 EST')).toBe('unreadable');
    expect(readIsoDateTime('2041-02-13T09:00+25:00')).toBe('unreadable');
    expect(readIsoDateTime('2041-02-13T24:00')).toBe('unreadable');
    expect(readIsoDateTime('2041-02-13')).toBeNull();
    expect(readIsoDateTime('February 13')).toBeNull();
  });
});

// Codex P1s on #476 (head 6ae4bb4b): a day the calendar does not have was
// rolled over (2041-02-30T17:00Z read as March 2), and a date and a time that
// named different moments were stitched into a third.
describe('a date-time names one real moment or books nothing', () => {
  it('a day the calendar does not have is unreadable, never rolled over', () => {
    expect(readIsoDateTime('2041-02-30T17:00:00Z')).toBe('unreadable');
    expect(readIsoDateTime('2041-02-29T09:00')).toBe('unreadable');
    expect(readIsoDateTime('2041-13-01T09:00')).toBe('unreadable');
    expect(readIsoDateTime('2040-02-29T09:00')).toEqual({ day: '2040-02-29', minutes: 540 });
  });

  it('February 30 at 17:00Z does not book a slot on another day', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-30T17:00:00Z' });
    expect(r).toMatchObject({ success: false, received_date: 'unreadable' });
    expect(book).not.toHaveBeenCalled();
  });

  it('a time that is a date-time on another day than the date books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13', time: '2041-02-05T17:00:00Z' });
    expect(r).toMatchObject({ success: false, error: 'date_time_disagree' });
    expect(r.choices).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2041-02-13', time: '09:00' })]));
    expect(book).not.toHaveBeenCalled();
  });

  it('a date-time beside a time at another hour books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-05T09:00', time: '10:00' });
    expect(r).toMatchObject({ success: false, error: 'date_time_disagree' });
    expect(book).not.toHaveBeenCalled();
  });

  it('a date-time and a time that agree book, whichever field carries the zone', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: '2041-02-13T17:00:00Z', time: '9:00 AM' });
    expect(r).toMatchObject({ success: true, booked_by: 'date_time' });
    expect(book.mock.calls[0][0]).toMatchObject({ slotId: FEB13_0900.slotId });
  });
});

describe('nothing is invented: a date read in words lands only on a day a choice is on', () => {
  it('a month and day no choice is on is refused as not offered, with the choices written out', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 20', time: '9:00 AM' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect((r.choices as unknown[]).length).toBe(6);
    expect(book).not.toHaveBeenCalled();
  });

  it('the right month and day in another year is not the offered day', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13, 2042', time: '9:00 AM' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('the right day at a time not offered books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13', time: '10:00 AM' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('a date that is not a date is named as unreadable and books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'next Thursday', time: '9:00 AM' });
    expect(r).toMatchObject({ success: false, error: 'no_choice', received_date: 'unreadable', received_time: 'read' });
    expect(String(r.fix)).toMatch(/the date could not be read/i);
    expect((r.choices as unknown[]).length).toBe(6);
    expect(book).not.toHaveBeenCalled();
  });

  it('readChosenDate reads only to an offered day, and says how it read it', () => {
    const offered = [FEB5_0900, FEB13_0900];
    expect(readChosenDate('2041-02-13', offered)).toEqual({ day: '2041-02-13', form: 'iso' });
    expect(readChosenDate('Feb 13', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('Feb 20', offered)).toEqual({ day: '2041-02-20', form: 'words' });
    expect(readChosenDate('13/02', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('tomorrow', offered)).toEqual({ form: 'unreadable' });
    // A word under three letters is never a month: "de" is not December.
    expect(readChosenDate('13 de febrero', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('', offered)).toEqual({ form: 'none' });
    expect(readChosenDate(undefined, offered)).toEqual({ form: 'none' });
  });

  // Codex P1 on #476 (head 7838fcc): "2042." failed the four-digit year test,
  // the year fell back to the offered February 13 in 2041, and that slot booked.
  it('a year with punctuation after it is read, so the wrong year is never booked', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13, 2042.', time: '9:00 AM' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('readChosenDate keeps a year however it is punctuated or abbreviated, and refuses one it cannot read', () => {
    const offered = [FEB5_0900, FEB13_0900];
    expect(readChosenDate('February 13, 2042.', offered)).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate('February 13, 2041.', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('Wednesday, February 13th, 2041!', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('(Feb. 13, 2042)', offered)).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate('2/13/2042.', offered)).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate("Feb 13 '42", offered)).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate('Feb 13 \u201941', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('February 13, 2041 2042', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13, 20422', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13, 204', offered)).toEqual({ form: 'unreadable' });
  });

  // Codex P2 on #476 (head fd296ed4): words the reader did not use were
  // dropped, so "February 13, 42" read as the offered 2041 and "February 13
  // or February 14" as the 13th. Every word is now a month, a day, a year, a
  // weekday or "of" / "the" / "on", or the date is unreadable.
  it('a two-digit year after the day is the year, and the 2041 slot is not booked for it', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13, 42', time: '09:00' });
    expect(r).toMatchObject({ success: false, error: 'not_offered' });
    expect(book).not.toHaveBeenCalled();
  });

  it('two dates, or a date with anything else in it, books nothing', async () => {
    await twoListsRead();
    const r = await run(BOOK_SOONER_TOOL_NAME, { date: 'February 13 or February 14', time: '09:00' });
    expect(r).toMatchObject({ success: false, received_date: 'unreadable' });
    expect(book).not.toHaveBeenCalled();
  });

  it('readChosenDate uses every word or reads nothing', () => {
    const offered = [FEB5_0900, FEB13_0900];
    expect(readChosenDate('February 13, 42', offered)).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate('Feb 13 14', offered)).toEqual({ day: '2014-02-13', form: 'words' });
    expect(readChosenDate('the 13th of February', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('on Wednesday, February 13', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('Wed Feb 13 2041', offered)).toEqual({ day: '2041-02-13', form: 'words' });
    expect(readChosenDate('February 13 or February 14', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13 and 14', offered)).toEqual({ form: 'unreadable' });
    // Two months and nothing else: never read as the first one.
    expect(readChosenDate('February 13, March 2041', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13 at 9 AM', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13, 2041, 2042', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13th 14th', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('February 13 4', offered)).toEqual({ form: 'unreadable' });
    expect(readChosenDate('next February 13', offered)).toEqual({ form: 'unreadable' });
  });

  it('a month and day two offered days share is not read to either', () => {
    const nextYear = slot('feb13-2042', '2042-02-13T17:00:00.000Z', 'Beaumont');
    expect(readChosenDate('Feb 13', [FEB13_0900, nextYear])).toEqual({ form: 'unreadable' });
    expect(readChosenDate('Feb 13, 2042', [FEB13_0900, nextYear])).toEqual({ day: '2042-02-13', form: 'words' });
    expect(readChosenDate('Sept 3', [slot('sep3', '2041-09-03T16:00:00.000Z', 'Beaumont')])).toEqual({ day: '2041-09-03', form: 'words' });
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
    expect(bookingArgsReceived({ date: 'Feb 13', time: 'nine', option: 2 }, [[FEB13_0900]])).toEqual({
      received_date: 'words',
      received_time: 'unreadable',
      received_option: true,
    });
  });
});
