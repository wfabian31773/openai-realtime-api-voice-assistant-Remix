/**
 * v189: the NPX outreach call asks what day and time work best, and searches
 * every slot NPX may offer the patient for it (operator, 2026-11-08: "When we
 * call we should not have a set appointment to offer, we have availability
 * sooner at our partner location, in ?????, what day and time work best for
 * you? … we have to be able to pull availability rapidly from week to week or
 * day by day").
 *
 * THE CORPUS, 2026-11-08 (the second live day; transcripts on disk, not in
 * git): all three callers who confirmed their date of birth were read the
 * same two fixed slots with full street addresses and ZIP codes, about thirty
 * seconds of speech, and none booked —
 *   CAa32762176abe4994c95a9a065f3f086c  asked to book, hung up after the read
 *   CAbd3c3f09ba8bc3bb6b88c6a94cd20572  kept the current appointment
 *   CA3248392021e96e6fffaad72768300a68  (returned call) kept it too
 * Synthetic patients, practices and slots only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  DESCRIBE_AVAILABILITY_WAIT_MS,
  DESCRIBE_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  FIND_BUDGET_MS,
  FIND_TOOL_TIMEOUT_MS,
  MAX_SEARCHES,
  MIN_NPX_READ_MS,
  MAX_RANGE_READS,
  choicesLine,
  incompleteRange,
  withRange,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  warmOutreachAvailability,
} from './npxOutreachTools';
import {
  cityOf,
  minutesOf,
  offerLine,
  overviewLine,
  pickSpread,
  preferenceFrom,
  searchSlots,
  spokenAddress,
} from './npxAvailabilitySearch';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const CORPUS = [
  'CAa32762176abe4994c95a9a065f3f086c',
  'CAbd3c3f09ba8bc3bb6b88c6a94cd20572',
  'CA3248392021e96e6fffaad72768300a68',
] as const;

/** A slot at a Pacific wall-clock time. November 2041 is PST (UTC-8). */
function slot(id: string, ymd: string, hhmm: string, over: Partial<NpxSlot> = {}): NpxSlot {
  const [h, m] = hhmm.split(':').map(Number);
  const start = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), h + 8, m));
  return {
    slotId: id,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 20 * 60_000).toISOString(),
    timezone: 'America/Los_Angeles',
    day: ymd,
    partnerOrgId: 'p1',
    partnerName: 'Partner One Optometry',
    clinicId: 'c-test',
    clinicName: 'Clinic One',
    address: '1 Test St, Suite 2, Testville, CA 90000',
    city: 'Testville',
    phone: '555-010-0000',
    providerName: 'Dr Test',
    visitType: 'Comprehensive Exam',
    ...over,
  };
}
const SECOND = { clinicId: 'c-second', city: 'Second City', address: '9 Other Ave, Second City, CA 90001', providerName: 'Dr Other' };

// 2041-11-18 is a Monday.
const WEEK: NpxSlot[] = [
  slot('mon-0900', '2041-11-18', '09:00'),
  slot('mon-0920', '2041-11-18', '09:20'),
  slot('mon-1400', '2041-11-18', '14:00'),
  slot('tue-0900', '2041-11-19', '09:00', SECOND),
  slot('tue-1540', '2041-11-19', '15:40', SECOND),
  slot('thu-0800', '2041-11-21', '08:00'),
  slot('thu-1030', '2041-11-21', '10:30'),
  slot('thu-1300', '2041-11-21', '13:00'),
  slot('thu-1600', '2041-11-21', '16:00'),
  slot('mon2-1000', '2041-11-25', '10:00'),
];

describe('the search, in memory (no network between a question and its answer)', () => {
  it('nothing asked: the earliest opening on each of three days', () => {
    expect(searchSlots(WEEK, {}).picked.map((s) => s.slotId)).toEqual(['mon-0900', 'tue-0900', 'thu-0800']);
  });

  it('"Thursday afternoon": only Thursday after noon', () => {
    const r = searchSlots(WEEK, preferenceFrom({ weekdays: 'thursday', time_of_day: 'afternoon' }));
    expect(r.relaxed).toBeNull();
    expect(r.picked.map((s) => s.slotId)).toEqual(['thu-1300', 'thu-1600']);
  });

  it('"any morning next week": a date range and mornings, a day each', () => {
    const r = searchSlots(WEEK, preferenceFrom({ from_date: '2041-11-18', to_date: '2041-11-22', time_of_day: 'morning' }));
    expect(r.picked.map((s) => s.slotId)).toEqual(['mon-0900', 'tue-0900', 'thu-0800']);
  });

  it('one day asked for: times spread across it, at least an hour apart', () => {
    const r = searchSlots(WEEK, preferenceFrom({ on_date: '2041-11-21' }));
    expect(r.picked.map((s) => s.slotId)).toEqual(['thu-0800', 'thu-1030', 'thu-1300']);
  });

  it('a full day is not read back as three times twenty minutes apart', () => {
    const busy = ['08:00', '08:20', '08:40', '09:00', '11:00', '14:00'].map((t, i) => slot(`wed-${i}`, '2041-11-20', t));
    const r = searchSlots(busy, preferenceFrom({ on_date: '2041-11-20' }));
    expect(r.picked.map((s) => s.slotId)).toEqual(['wed-0', 'wed-3', 'wed-4']);
  });

  it('a time window: "after 3"', () => {
    const r = searchSlots(WEEK, preferenceFrom({ earliest_time: '15:00' }));
    expect(r.picked.map((s) => s.slotId)).toEqual(['tue-1540', 'thu-1600']);
  });

  it('a city they named', () => {
    const r = searchSlots(WEEK, preferenceFrom({ city: 'second city' }));
    expect(r.picked.every((s) => s.city === 'Second City')).toBe(true);
  });

  it('nothing at that time: the same day at another time, and it says so', () => {
    const r = searchSlots(WEEK, preferenceFrom({ on_date: '2041-11-19', time_of_day: 'morning', earliest_time: '11:00' }));
    expect(r.relaxed).toBe('time');
    expect(r.picked.map((s) => s.slotId)).toEqual(['tue-0900', 'tue-1540']);
  });

  it('nothing that day: the nearest days to the one asked for, not the earliest overall', () => {
    const r = searchSlots(WEEK, preferenceFrom({ on_date: '2041-11-24' }));
    expect(r.relaxed).toBe('day');
    // Mon 25 (a day off), Thu 21 (three), Tue 19 (five) — read in date order.
    expect(r.picked.map((s) => s.slotId)).toEqual(['tue-0900', 'thu-0800', 'mon2-1000']);
  });

  // Codex P2, #439: day, time and city all named; nothing that day in that
  // city, another time on a nearby day there, and the exact day and time in
  // another city. The caller's city is kept before it is given up.
  it('the day and the time are both let go before the city is', () => {
    // Second City has only Tuesday at 9:00 and 3:40. Asked: Thursday after 4:30 there.
    const r = searchSlots(WEEK, preferenceFrom({ on_date: '2041-11-21', earliest_time: '16:30', city: 'second city' }));
    expect(r.relaxed).toBe('when');
    expect(r.picked.map((s) => s.slotId)).toEqual(['tue-0900', 'tue-1540']);
    expect(choicesLine(r.picked, r.relaxed)).toBe(
      "I don't have that day or time open, but on Tuesday, November 19 I have 9:00 AM or 3:40 PM, in Second City. Would either of those work for you?",
    );
    // Only when nothing in that city matches either does the city go.
    const away = searchSlots(WEEK, preferenceFrom({ on_date: '2041-11-21', time_of_day: 'morning', city: 'nowhere' }));
    expect(away.relaxed).toBe('city');
    expect(away.picked.map((s) => s.slotId)).toEqual(['thu-0800', 'thu-1030']);
  });

  it('two providers at one office at one time are one choice', () => {
    const twin = slot('mon-0900-b', '2041-11-18', '09:00', { providerName: 'Dr Twin' });
    expect(pickSpread([WEEK[0], twin]).length).toBe(1);
  });

  it('never offers a slot it was not given', () => {
    const given = new Set(WEEK.map((s) => s.slotId));
    for (const p of [{}, { weekdays: 'friday' }, { on_date: '2041-12-25' }, { city: 'Nowhere' }]) {
      for (const s of searchSlots(WEEK, preferenceFrom(p)).picked) expect(given.has(s.slotId)).toBe(true);
    }
  });

  it('reads the times and days the model sends, leniently', () => {
    expect(minutesOf('15:00')).toBe(900);
    expect(minutesOf('9am')).toBe(540);
    expect(minutesOf('2:30 pm')).toBe(870);
    expect(minutesOf('12 am')).toBe(0);
    expect(minutesOf('noonish')).toBeNull();
    expect(preferenceFrom({ weekdays: 'Tuesdays, thursday', time_of_day: 'evening', on_date: 'next week' })).toEqual({ weekdays: ['tuesday', 'thursday'] });
  });
});

describe('in words: day, date, time and city — the street address only once it is booked', () => {
  it('one city, several days', () => {
    expect(offerLine([WEEK[0], WEEK[5]])).toBe(
      'I have Monday, November 18 at 9:00 AM or Thursday, November 21 at 8:00 AM, in Testville. Would either of those work for you?',
    );
  });

  it('one day, several times', () => {
    expect(offerLine([WEEK[5], WEEK[6], WEEK[7]])).toBe(
      'On Thursday, November 21 I have 8:00 AM, 10:30 AM or 1:00 PM, in Testville. Would any of those work for you?',
    );
  });

  it('two cities name each', () => {
    expect(offerLine([WEEK[0], WEEK[3]])).toBe(
      'I have Monday, November 18 at 9:00 AM in Testville or Tuesday, November 19 at 9:00 AM in Second City. Would either of those work for you?',
    );
  });

  it('a stepped-back search says it could not have what was asked', () => {
    expect(choicesLine([WEEK[3], WEEK[4]], 'time')).toBe(
      "I don't have that time open, but on Tuesday, November 19 I have 9:00 AM or 3:40 PM, in Second City. Would either of those work for you?",
    );
    expect(choicesLine([WEEK[0]], 'day')).toBe(
      "I don't have that day open, but I have Monday, November 18 at 9:00 AM, in Testville. Would that work for you?",
    );
  });

  it('what is open overall, for "what do you have?"', () => {
    expect(overviewLine(WEEK)).toBe(
      'Openings on Mondays, Tuesdays and Thursdays, mornings and afternoons, from Monday, November 18 through Monday, November 25, in Testville and Second City.',
    );
  });

  it('a city from NPX, or from the address when an older NPX sends none', () => {
    expect(cityOf(WEEK[0])).toBe('Testville');
    expect(cityOf({ ...WEEK[0], city: undefined, address: '11 Main St, 185, Example Valley, CA 91730' })).toBe('Example Valley');
    expect(spokenAddress(WEEK[0])).toBe('1 Test St, Suite 2, Testville');
  });
});

// ── Through the tools ────────────────────────────────────────────────────────

const DATA = {
  source: 'console_movable',
  appointment_id: 'appt-0001',
  person_id: 'person-0001',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-12-23',
  begin_time: '0900',
  event_name: 'Consult',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};

let store: FakeOutboundStore;
let attemptId: string;
let npx: { availability: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn>; book: ReturnType<typeof vi.fn>; reportCancel: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  npx = {
    availability: vi.fn(async () => ({ ok: true, latestDay: '2041-12-02', slots: WEEK, truncated: false })),
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 2) })),
    book: vi.fn(async (req: { slotId: string }) => ({
      ok: true,
      bookingId: 'booking-1',
      alreadyBooked: false,
      recordGroupDiffers: false,
      slot: WEEK.find((s) => s.slotId === req.slotId)!,
    })),
    reportCancel: vi.fn(async () => ({ ok: true })),
  };
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    cancel: vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false })) as never,
    store: async () => store,
    fileTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' })) as never,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const args = (sid: string) => ({
  outbound_contact_id: 'c1',
  outbound_attempt_id: attemptId,
  outbound_phone: '+15555550111',
  outbound_campaign: 'npx-outreach',
  outbound_call_sid: sid,
});
const run = (sid: string, name: string, extra: Record<string, unknown> = {}) => getTool(name)!.handler({ ...args(sid), ...extra });
const contact = async () => (await store.loadCallContact('c1', attemptId))!;

describe.each(CORPUS)('the corpus call %s, on this build', (sid) => {
  it('opens with where the openings are and what day and time work best — no fixed slot', async () => {
    const r = (await run(sid, DESCRIBE_TOOL_NAME)) as Record<string, unknown>;
    expect(r.say).toBe(
      'Our records show you have a consultation on Monday, December 23. We have availability sooner at our partner locations in Testville and Second City. What day and time work best for you?',
    );
    expect(JSON.stringify(r)).not.toMatch(/9:00|AM|1 Test St|Dr Test/);
  });

  it('searches for the day and time they said, and offers what matches in a few seconds of speech', async () => {
    await run(sid, DESCRIBE_TOOL_NAME);
    await run(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(sid, FIND_SOONER_TOOL_NAME, { weekdays: 'thursday', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(r.exact).toBe(true);
    expect(r.say).toBe('On Thursday, November 21 I have 1:00 PM or 4:00 PM, in Testville. Would either of those work for you?');
    // The 2026-11-08 read was 380–396 characters; this is under half.
    expect(String(r.say).length).toBeLessThan(190);
    // They change their mind: answered from memory, no second read of NPX.
    const again = (await run(sid, FIND_SOONER_TOOL_NAME, { weekdays: 'tuesday' })) as Record<string, unknown>;
    expect(again.say).toMatch(/^On Tuesday, November 19 I have 9:00 AM or 3:40 PM, in Second City\./);
    expect(npx.availability).toHaveBeenCalledTimes(1);
    // And books the third choice of a three-choice answer.
    const three = (await run(sid, FIND_SOONER_TOOL_NAME, { on_date: '2041-11-21' })) as unknown as { options: unknown[] };
    expect(three.options).toHaveLength(3);
    const booked = await run(sid, BOOK_SOONER_TOOL_NAME, { option: '3' });
    expect(booked).toMatchObject({ success: true, booked: true });
    expect(npx.book).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'thu-1300' }));
  });
});

describe('the availability is read once, early, and only by the rules NPX applied', () => {
  it('the agent factory warms it while the greeting plays; the opening and every search reuse that read', async () => {
    warmOutreachAvailability(await contact());
    expect(npx.availability).toHaveBeenCalledTimes(1);
    await run(CORPUS[0], DESCRIBE_TOOL_NAME);
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    await run(CORPUS[0], FIND_SOONER_TOOL_NAME, {});
    await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { time_of_day: 'morning' });
    expect(npx.availability).toHaveBeenCalledTimes(1);
  });

  it('the opening never waits long: an availability still loading leaves the city out', async () => {
    vi.useFakeTimers();
    npx.availability.mockImplementation(() => new Promise(() => undefined));
    const pending = run(CORPUS[0], DESCRIBE_TOOL_NAME);
    await vi.advanceTimersByTimeAsync(DESCRIBE_AVAILABILITY_WAIT_MS + 10);
    const r = (await pending) as Record<string, unknown>;
    expect(r.say).toMatch(/We have availability sooner at one of our partner locations nearby\. What day and time work best for you\?$/);
  });

  it('nothing sooner open: the opening says so instead of asking what works', async () => {
    npx.availability.mockResolvedValue({ ok: true, latestDay: '2041-12-02', slots: [], truncated: false });
    const r = (await run(CORPUS[1], DESCRIBE_TOOL_NAME)) as Record<string, unknown>;
    expect(r).toMatchObject({ nothing_sooner: true });
    expect(String(r.say)).toMatch(/nothing sooner is open right now, so your appointment stays as it is\.$/);
    expect(String(r.next)).toContain('record_call_outcome with done');
  });

  it('a slot taken before it was booked leaves the list and is never offered again', async () => {
    await run(CORPUS[1], DESCRIBE_TOOL_NAME);
    await run(CORPUS[1], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    await run(CORPUS[1], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-18' });
    npx.book.mockResolvedValueOnce({ ok: false, error: 'slot_unavailable', next: 'offer_again' });
    expect(await run(CORPUS[1], BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'slot_unavailable' });
    const r = (await run(CORPUS[1], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-18' })) as unknown as { options: Array<{ when: string }> };
    expect(r.options.map((o) => o.when)).not.toContain('Monday, November 18 at 9:00 AM');
  });

  it('an NPX without the availability endpoint: the two-slot offer, searched the same way', async () => {
    npx.availability.mockResolvedValue({ ok: false, error: 'not_supported' });
    await run(CORPUS[2], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[2], FIND_SOONER_TOOL_NAME, {})) as unknown as { options: Array<{ when: string }> };
    expect(npx.offer).toHaveBeenCalledTimes(1);
    expect(r.options.map((o) => o.when)).toEqual(['Monday, November 18 at 9:00 AM', 'Monday, November 18 at 9:20 AM']);
  });

  it('a day past the end of a truncated list is read from NPX for that range', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 3), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: [WEEK[9]], truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-25' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenLastCalledWith(expect.objectContaining({ fromDay: '2041-11-25', toDay: '2041-11-25' }), {
      timeoutMs: expect.any(Number),
    });
    expect(r.exact).toBe(true);
  });

  // Codex P2, #439: a list cut short part way through a day says nothing about
  // the rest of that day. Mon 18 and Tue 19 are whole; the list stops at
  // Thursday 10:30, so Thursday afternoon must be read before anything is relaxed.
  it('a truncated list that ends on the day asked for: that day is read again, not relaxed', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(5, 9), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-21', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(npx.availability).toHaveBeenLastCalledWith(expect.objectContaining({ fromDay: '2041-11-21', toDay: '2041-11-21' }), {
      timeoutMs: expect.any(Number),
    });
    expect(r.exact).toBe(true);
    expect(r.say).toBe('On Thursday, November 21 I have 1:00 PM or 4:00 PM, in Testville. Would either of those work for you?');
  });

  it('a range that crosses the cut: read from the last day on, and the whole days before it kept', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(5), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, {
      from_date: '2041-11-18',
      to_date: '2041-11-25',
      time_of_day: 'afternoon',
    })) as unknown as { options: Array<{ when: string }> };
    expect(npx.availability).toHaveBeenLastCalledWith(expect.objectContaining({ fromDay: '2041-11-21', toDay: '2041-11-25' }), {
      timeoutMs: expect.any(Number),
    });
    expect(r.options.map((o) => o.when)).toEqual([
      'Monday, November 18 at 2:00 PM',
      'Tuesday, November 19 at 3:40 PM',
      'Thursday, November 21 at 1:00 PM',
    ]);
  });

  // Codex round 2, #439: a weekday, a time or a city with no date asked for is
  // read again from the last day on when nothing in the cut-short list fits.
  it('a weekday and time with nothing in a cut-short list: read from the last day on, then offered', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(5), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    const [req] = npx.availability.mock.calls[1] as unknown as [{ fromDay?: string; toDay?: string }];
    expect(req.fromDay).toBe('2041-11-21');
    expect(req.toDay).toBeUndefined();
    expect(r.exact).toBe(true);
    expect(r.say).toBe('On Thursday, November 21 I have 1:00 PM or 4:00 PM, in Testville. Would either of those work for you?');
  });

  it('a city with nothing in a cut-short list: read again, not stepped back to another city', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 3), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 5), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { city: 'Second City' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(r.exact).toBe(true);
    expect(String(r.say)).toContain('Second City');
  });

  it('the rest was read and still has nothing for that day: then, and only then, it steps back', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(5), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'wednesday' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(r.unchecked).toBeUndefined();
    expect(r.exact).toBe(false);
    expect(String(r.say)).toMatch(/^I don't have that day open, but/);
  });

  it('a weekday the cut-short list already has: no second read', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'tuesday' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(1);
    expect(r.exact).toBe(true);
  });

  it('the read that could answer them failed: nothing stepped back, and the earlier choices still book', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: false, error: 'network' } as never);
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const first = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, {})) as unknown as { options: Array<{ when: string }> };
    expect(first.options.length).toBeGreaterThan(0);
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(r).toMatchObject({ success: true, options: [], unchecked: true });
    expect(r.say).toBeUndefined();
    expect(String(r.fix)).toMatch(/could not be checked/);
    expect(String(r.fix)).toMatch(/do not offer another day/i);
    await run(CORPUS[0], BOOK_SOONER_TOOL_NAME, { option: '1' });
    expect(npx.book).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'mon-0900' }));
  });

  it('a one-day truncated list whose re-read comes back empty: not "nothing sooner", the call goes on', async () => {
    const monday = WEEK.slice(0, 3);
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: monday, truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: [], truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-18' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: true, options: [], unchecked: true });
    expect(String(r.fix)).not.toMatch(/end_call/);
  });

  // Codex round 3, #439: the read on can itself come back cut short.
  it('a read on that is itself cut short is read on again from its own last day', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 3), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 5), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(3), truncated: false });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(3);
    const [req2] = npx.availability.mock.calls[1] as unknown as [{ fromDay?: string }];
    const [req3] = npx.availability.mock.calls[2] as unknown as [{ fromDay?: string }];
    expect(req2.fromDay).toBe('2041-11-18');
    expect(req3.fromDay).toBe('2041-11-19');
    expect(r.exact).toBe(true);
    expect(r.say).toBe('On Thursday, November 21 I have 1:00 PM or 4:00 PM, in Testville. Would either of those work for you?');
  });

  it('a read on that is cut short on the same day cannot go further: unchecked, not stepped back', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(5, 7), truncated: true });
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-21', time_of_day: 'afternoon' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: true, options: [], unchecked: true });
  });

  it('reading on stops after MAX_RANGE_READS, and what is still unread is not stepped back from', async () => {
    const days = ['2041-11-18', '2041-11-19', '2041-11-20', '2041-11-22', '2041-11-23'];
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: [slot('d0', days[0], '09:00')], truncated: true });
    for (let i = 1; i < days.length; i++) {
      npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: [slot(`d${i}`, days[i], '09:00')], truncated: true });
    }
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(1 + MAX_RANGE_READS);
    expect(r).toMatchObject({ success: true, options: [], unchecked: true });
  });

  it('the read failed but the list in hand fits: those are offered as asked', async () => {
    npx.availability.mockResolvedValueOnce({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true });
    npx.availability.mockResolvedValueOnce({ ok: false, error: 'network' } as never);
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-21' })) as Record<string, unknown>;
    expect(npx.availability).toHaveBeenCalledTimes(2);
    expect(r.exact).toBe(true);
    expect(r.unchecked).toBeUndefined();
  });

  it('which part of a request a cut-short list cannot answer', () => {
    const cut = { slots: WEEK.slice(0, 7), truncated: true };
    expect(incompleteRange({ ...cut, truncated: false }, { onDate: '2041-11-21' })).toBeNull();
    expect(incompleteRange(cut, {})).toBeNull();
    expect(incompleteRange(cut, { onDate: '2041-11-19' })).toBeNull();
    expect(incompleteRange(cut, { fromDate: '2041-11-18', toDate: '2041-11-20' })).toBeNull();
    expect(incompleteRange(cut, { onDate: '2041-11-21' })).toEqual({ fromDay: '2041-11-21', toDay: '2041-11-21' });
    expect(incompleteRange(cut, { onDate: '2041-11-25' })).toEqual({ fromDay: '2041-11-25', toDay: '2041-11-25' });
    expect(incompleteRange(cut, { fromDate: '2041-11-20' })).toEqual({ fromDay: '2041-11-21' });
    expect(incompleteRange(cut, { toDate: '2041-11-30' })).toEqual({ fromDay: '2041-11-21', toDay: '2041-11-30' });
    // No date asked: read again only when nothing in the list fits.
    expect(incompleteRange(cut, { weekdays: ['monday'] })).toBeNull();
    expect(incompleteRange(cut, { city: 'Second City' })).toBeNull();
    expect(incompleteRange(cut, { weekdays: ['wednesday'] })).toEqual({ fromDay: '2041-11-21' });
    expect(incompleteRange(cut, { weekdays: ['thursday'], timeOfDay: 'afternoon' })).toEqual({ fromDay: '2041-11-21' });
    expect(incompleteRange(cut, { city: 'Nowhere' })).toEqual({ fromDay: '2041-11-21' });
    // The range read replaces the cut day; the whole days before it stay, once each.
    const merged = withRange(WEEK.slice(0, 7), '2041-11-21', [WEEK[6], WEEK[7], WEEK[3]]);
    expect(merged.map((x) => x.slotId)).toEqual(['mon-0900', 'mon-0920', 'mon-1400', 'tue-0900', 'tue-1540', 'thu-1030', 'thu-1300']);
  });

  // Codex P2, #439: one read may take its whole 10 seconds, and a retry or a
  // range read after it another 10 — past the tool's own 15. Every read a
  // search makes now answers inside FIND_BUDGET_MS, so the caller hears the
  // safe answer and never a tool timeout.
  describe('every read a search makes answers inside the tool timeout', () => {
    /** A fake NPX that takes the whole time it is given, then times out. */
    const hangs = (_req: unknown, opts?: { timeoutMs?: number }) =>
      new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), opts?.timeoutMs ?? 10_000));

    it('the budget leaves the tool room to answer', () => {
      expect(getTool(FIND_SOONER_TOOL_NAME)!.timeoutMs).toBe(FIND_TOOL_TIMEOUT_MS);
      expect(FIND_BUDGET_MS + MIN_NPX_READ_MS).toBeLessThanOrEqual(FIND_TOOL_TIMEOUT_MS - 1_000);
    });

    it('a read that takes all its time: the safe answer inside the budget, and no second read', async () => {
      await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
      npx.availability.mockImplementation(hangs as never);
      vi.useFakeTimers();
      const start = Date.now();
      let done = false;
      const p = run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday' }).then((r) => ((done = true), r));
      await vi.advanceTimersByTimeAsync(FIND_BUDGET_MS);
      expect(done).toBe(true);
      const r = (await p) as Record<string, unknown>;
      expect(Date.now() - start).toBeLessThanOrEqual(FIND_BUDGET_MS);
      expect(r).toMatchObject({ success: false, error: 'timeout' });
      expect(String(r.fix)).toMatch(/current appointment stays as it is/);
      expect(npx.availability).toHaveBeenCalledTimes(1);
      expect(npx.availability.mock.calls[0][1]).toEqual({ timeoutMs: FIND_BUDGET_MS });
    });

    it('a read that fails at once is tried again, inside what is left', async () => {
      await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
      npx.availability.mockResolvedValueOnce({ ok: false, error: 'network' } as never);
      const r = (await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'thursday', time_of_day: 'afternoon' })) as Record<string, unknown>;
      expect(r.exact).toBe(true);
      expect(npx.availability).toHaveBeenCalledTimes(2);
      for (const [, opts] of npx.availability.mock.calls as unknown as Array<[unknown, { timeoutMs: number }]>) {
        expect(opts.timeoutMs).toBeLessThanOrEqual(FIND_BUDGET_MS);
      }
    });

    it('the read the greeting started, still hanging, is held to the budget', async () => {
      // The greeting's read has no deadline of its own; this one hangs past even its own limit.
      npx.availability.mockImplementation(((req: unknown, opts?: { timeoutMs?: number }) =>
        opts ? hangs(req, opts) : new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), 30_000))) as never);
      warmOutreachAvailability(await contact());
      await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
      vi.useFakeTimers();
      const start = Date.now();
      const p = run(CORPUS[0], FIND_SOONER_TOOL_NAME, {});
      await vi.advanceTimersByTimeAsync(FIND_BUDGET_MS);
      expect(await p).toMatchObject({ success: false, error: 'timeout' });
      expect(Date.now() - start).toBeLessThanOrEqual(FIND_BUDGET_MS);
    });

    it('a range read that would outlast the budget is cut short, and the list in hand answers', async () => {
      await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
      npx.availability
        .mockImplementationOnce(
          () => new Promise((res) => setTimeout(() => res({ ok: true, latestDay: '2041-12-02', slots: WEEK.slice(0, 7), truncated: true }), 9_000)) as never,
        )
        .mockImplementationOnce(hangs as never);
      vi.useFakeTimers();
      const start = Date.now();
      const p = run(CORPUS[0], FIND_SOONER_TOOL_NAME, { on_date: '2041-11-21', time_of_day: 'afternoon' });
      await vi.advanceTimersByTimeAsync(FIND_BUDGET_MS);
      const r = (await p) as Record<string, unknown>;
      expect(Date.now() - start).toBeLessThanOrEqual(FIND_BUDGET_MS);
      expect(npx.availability).toHaveBeenCalledTimes(2);
      expect((npx.availability.mock.calls[1] as unknown as [unknown, { timeoutMs: number }])[1].timeoutMs).toBeLessThanOrEqual(3_000);
      // Thursday afternoon was never read, so nothing is stepped back to (Codex round 2, #439).
      expect(r).toMatchObject({ success: true, options: [], unchecked: true });
      expect(r.say).toBeUndefined();
    });
  });

  it('a model in a loop is stopped', async () => {
    await run(CORPUS[0], CONFIRM_DOB_TOOL_NAME, { date_of_birth: '01/02/1950' });
    for (let i = 0; i < MAX_SEARCHES; i++) await run(CORPUS[0], FIND_SOONER_TOOL_NAME, {});
    expect(await run(CORPUS[0], FIND_SOONER_TOOL_NAME, {})).toMatchObject({ success: false, error: 'search_limit' });
  });

  it('still searches nothing before the date of birth matches', async () => {
    expect(await run(CORPUS[0], FIND_SOONER_TOOL_NAME, { weekdays: 'monday' })).toMatchObject({ error: 'not_confirmed_yet' });
  });
});
