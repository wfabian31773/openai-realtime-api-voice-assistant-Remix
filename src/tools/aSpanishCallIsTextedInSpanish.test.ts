/**
 * v261: a booking made on a call the agent served in Spanish is confirmed by a
 * Spanish text. Operator, 2026-11-22: "Yes to the spanish version of the text."
 *
 * Before this build every confirmation was the approved English text (v222).
 * Measured, every NPX call booking 2026-11-07..22 (Hub tool_timeline): 23 of 80
 * were on a call the agent switched to Spanish, and all 23 were texted in
 * English. On 22 the switch came before the booking; on one
 * (CA0824b4d82426b74333b0ee53ba9d45df) it came 32 seconds after it, which is
 * why the hang-up decides the language as well as the booking.
 *
 * Corpus, by real CallSid, with a synthetic patient, practice and slot:
 *   CAbc83d5fb3913698181ce23444571fe9f  Spanish before the booking (2026-11-22)
 *   CA0824b4d82426b74333b0ee53ba9d45df  Spanish only after the booking (2026-11-12)
 *   CA36bf5f46ccedadfdbafe3c0fdc12198b  Spanish, English, Spanish, then booked (2026-11-12)
 *   CA90b8e05920d8611e94b56e541dc3b3d8  never switched: English, the control (2026-11-16)
 *
 * Through the real tools (registry), the real queue, the real hang-up and the
 * real confirmation tick, on a fake store, a fake NPX, a fake Azul cancel and a
 * fake SMS sender. The language store is written here as the bridge writes it
 * (mediaStreamBridge.test.ts pins the bridge's own write).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  confirmationRecordFor,
  endOutreachSession,
  npxBookingPageLane,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  textedDayEs,
} from './npxOutreachTools';
import { textedWhenEs } from './npxAvailabilitySearch';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';
import {
  confirmationBody,
  confirmationLanguageOf,
  confirmationOf,
  runConfirmationTick,
  type BookingConfirmationRecord,
} from '../runtime/outbound/bookingConfirmation';
import type { TextDeps } from '../runtime/outbound/outreachText';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import type { OutboundLanePolicy } from '../runtime/outbound/campaign';
import type { SmsSender } from '../plugin/sms';
import { nonGsm7Characters } from '../services/gsm7';
import {
  callLanguageFor,
  noteCallLanguage,
  releaseCallLanguage,
  resetCallLanguagesForTests,
} from '../services/callLanguage';

vi.mock('../../server/db', () => ({ db: {} }));

const SPANISH_FIRST = 'CAbc83d5fb3913698181ce23444571fe9f';
const SPANISH_AFTER_BOOKING = 'CA0824b4d82426b74333b0ee53ba9d45df';
const SPANISH_ENGLISH_SPANISH = 'CA36bf5f46ccedadfdbafe3c0fdc12198b';
const NEVER_SWITCHED = 'CA90b8e05920d8611e94b56e541dc3b3d8';

// Tuesday 10 AM Pacific: inside the calling window.
const NOW = new Date('2041-03-05T18:00:00Z');
const FROM = '+15555550100';
const PHONE = '+15555550111';
const ENV = { NPX_TEST_TEXTS: '1', OUTBOUND_TEST_FROM: FROM };

const SLOT_A: NpxSlot = {
  slotId: 'slot-a', startAt: '2041-02-04T17:00:00.000Z', endAt: '2041-02-04T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-02-04', partnerOrgId: 'p1', partnerName: 'Partner One Optometry',
  clinicId: 'c1', clinicName: 'Clinic One', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};
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

const SPANISH_BODY =
  'Azul Vision: tiene cita el lunes 4 de febrero a las 9:00 AM en Partner One Optometry, 1 Test St, Testville. ' +
  'Teléfono: 555-010-0000. Su cita del 20 de marzo con nosotros fue cancelada. ' +
  '¿Preguntas? Llame a este teléfono. Responda STOP para darse de baja.';
const ENGLISH_BODY =
  "Azul Vision: you're booked for Mon, Feb 4 at 9:00 AM at Partner One Optometry, 1 Test St, Testville. " +
  'Their phone: 555-010-0000. Your Mar 20 appointment with us is cancelled. Questions? Call this number. Reply STOP to opt out.';

const policy: OutboundLanePolicy = {
  campaignKey: 'test-campaign',
  enableEnv: 'OUTBOUND_CAMPAIGN_TEST',
  callerIdEnv: 'OUTBOUND_TEST_FROM',
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: () => 'Hello.',
  voicemail: () => 'Hello.',
  textOutreach: {
    enableEnv: 'NPX_TEST_TEXTS',
    perTick: 10,
    body: (link) => `Azul Vision: test ${link}. Reply STOP to opt out.`,
    page: npxBookingPageLane,
  },
};

let store: FakeOutboundStore;
let attemptId: string;
let cancel: ReturnType<typeof vi.fn>;
let sent: Array<{ to: string; from: string; body: string }>;
let sender: SmsSender;

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  resetCallLanguagesForTests();
  store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: 'c1', phone: PHONE, status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  const npx = {
    availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A], truncated: false })),
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A] })),
    book: vi.fn(async () => ({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
    reportCancel: vi.fn(async () => ({ ok: true })),
  };
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
    fileTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' })) as never,
  });
  sent = [];
  let n = 0;
  sender = { send: vi.fn(async (m) => { sent.push(m); return { sid: `SM${String(++n).padStart(32, '0')}` }; }) };
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  resetCallLanguagesForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const deps = (over: Partial<TextDeps> = {}): TextDeps => ({
  store,
  env: ENV,
  host: 'voice.example.test',
  sms: async () => sender,
  now: () => NOW,
  log: () => undefined,
  ...over,
});
const tick = () => runConfirmationTick('npx-outreach', policy, deps({ now: () => new Date(NOW.getTime() + 2 * 60_000) }));

const runOn = (sid: string, name: string, args: Record<string, unknown> = {}) =>
  getTool(name)!.handler({
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: PHONE,
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: sid,
    ...args,
  });

async function bookOn(sid: string) {
  await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  await runOn(sid, FIND_SOONER_TOOL_NAME);
  const r = (await runOn(sid, BOOK_SOONER_TOOL_NAME, { date: '2041-02-04', time: '09:00', city: 'Testville' })) as Record<string, unknown>;
  expect(r).toMatchObject({ success: true, booked: true });
}
/** The call ends as the runtime ends it: the attempt closes, the session ends
 * (running the held Azul cancel), and the call's language is released straight
 * after endOutreachSession is called, before it has finished (voiceRuntime.ts). */
async function hangUp(sid: string) {
  await store.finishAttempt(attemptId, { status: 'completed' } as never);
  const ending = endOutreachSession(sid);
  releaseCallLanguage(sid);
  await ending;
}
const confirmation = () => confirmationOf(store.contacts.get('c1')!.customData);

describe('the corpus', () => {
  it(`${SPANISH_FIRST}: Spanish before the booking, so the text is in Spanish`, async () => {
    noteCallLanguage(SPANISH_FIRST, 'es');
    await bookOn(SPANISH_FIRST);
    expect(confirmation()).toMatchObject({ language: 'es', state: 'awaiting_cancel' });
    await hangUp(SPANISH_FIRST);
    expect((await tick()).sent).toBe(1);
    expect(sent[0]).toMatchObject({ to: PHONE, from: FROM, body: SPANISH_BODY });
  });

  it(`${SPANISH_AFTER_BOOKING}: Spanish only after the booking, and the hang-up texts it in Spanish`, async () => {
    await bookOn(SPANISH_AFTER_BOOKING);
    expect(confirmation()?.language).toBeUndefined();
    noteCallLanguage(SPANISH_AFTER_BOOKING, 'es');
    await hangUp(SPANISH_AFTER_BOOKING);
    expect(confirmation()).toMatchObject({ language: 'es', state: 'due', cancel: 'cancelled' });
    await tick();
    expect(sent[0].body).toBe(SPANISH_BODY);
  });

  it(`${SPANISH_ENGLISH_SPANISH}: Spanish, English, Spanish before the booking is Spanish`, async () => {
    noteCallLanguage(SPANISH_ENGLISH_SPANISH, 'es');
    noteCallLanguage(SPANISH_ENGLISH_SPANISH, 'en');
    noteCallLanguage(SPANISH_ENGLISH_SPANISH, 'es');
    await bookOn(SPANISH_ENGLISH_SPANISH);
    await hangUp(SPANISH_ENGLISH_SPANISH);
    await tick();
    expect(sent[0].body).toBe(SPANISH_BODY);
  });

  it(`${NEVER_SWITCHED}: a call that never switched is texted the approved English, word for word`, async () => {
    await bookOn(NEVER_SWITCHED);
    await hangUp(NEVER_SWITCHED);
    expect(confirmation()?.language).toBeUndefined();
    await tick();
    expect(sent[0].body).toBe(ENGLISH_BODY);
  });
});

describe('the language rule', () => {
  it('a call switched back to English after the booking is texted in English', async () => {
    const sid = 'CA00000000000000000000000000000261';
    noteCallLanguage(sid, 'es');
    await bookOn(sid);
    noteCallLanguage(sid, 'en');
    await hangUp(sid);
    expect(confirmation()?.language).toBe('en');
    await tick();
    expect(sent[0].body).toBe(ENGLISH_BODY);
  });

  it('a held cancel the fallback ran, not the hang-up, keeps the language the booking recorded', async () => {
    const sid = 'CA00000000000000000000000000000262';
    noteCallLanguage(sid, 'es');
    await bookOn(sid);
    // The process died: no hang-up, and the language store went with it. The
    // fallback runs only once no call is open on the phone, then releases the
    // confirmation with no language of its own.
    releaseCallLanguage(sid);
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    await store.releaseConfirmation('c1', 'booking-1', 'cancelled', new Date());
    expect(confirmation()).toMatchObject({ language: 'es', state: 'due' });
    await tick();
    expect(sent[0].body).toBe(SPANISH_BODY);
  });

  it('a queue that lands after the hang-up takes the language the call ended in', async () => {
    // The booking's queue missed its settle budget and the caller hung up
    // first: the hang-up writes a released placeholder (Codex P2 on #474).
    await store.releaseConfirmation('c1', 'booking-9', 'cancelled', NOW, 'es');
    const late = confirmationRecordFor({
      contact: { contactId: 'c1', phone: PHONE, data: DATA } as never,
      slot: SLOT_A, bookingId: 'booking-9', callRef: SPANISH_AFTER_BOOKING, cancelled: false, awaitCancel: true, now: NOW,
    });
    expect(late.language).toBeUndefined();
    expect(await store.queueConfirmation('c1', late)).toBe(true);
    expect(confirmation()).toMatchObject({ booking_id: 'booking-9', state: 'due', cancel: 'cancelled', language: 'es' });
    expect(confirmationBody(confirmation()!)).toBe(SPANISH_BODY);
  });

  it('a text-link booking stays English: the page is English, and no call language reaches it', async () => {
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    const contact = (await store.loadCallContact('c1', attemptId))!;
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'slot-a', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r).toMatchObject({ ok: true });
    const c = confirmation()!;
    expect(c).toMatchObject({ by: 'link' });
    expect(c.language).toBeUndefined();
    expect(c.when_es).toBeUndefined();
    await tick();
    expect(sent[0].body).toBe(ENGLISH_BODY);
  });

  it('reads Spanish from any Spanish tag, English from any other language, and nothing from no switch', () => {
    expect(confirmationLanguageOf('es')).toBe('es');
    expect(confirmationLanguageOf('es-MX')).toBe('es');
    expect(confirmationLanguageOf(' ES ')).toBe('es');
    expect(confirmationLanguageOf('en')).toBe('en');
    expect(confirmationLanguageOf('tr')).toBe('en');
    expect(confirmationLanguageOf(undefined)).toBeUndefined();
    expect(confirmationLanguageOf('')).toBeUndefined();
  });
});

describe('the Spanish text', () => {
  const record = (over: Partial<BookingConfirmationRecord> = {}): BookingConfirmationRecord => ({
    ...confirmationRecordFor({
      contact: { contactId: 'c1', phone: PHONE, data: DATA } as never,
      slot: SLOT_A, bookingId: 'b', callRef: SPANISH_FIRST, cancelled: true, language: 'es', now: NOW,
    }),
    cancel: 'cancelled',
    ...over,
  });

  it('keeps every clause of the approved English: when and where, their phone, the Azul appointment, who to call, STOP', () => {
    expect(confirmationBody(record())).toBe(SPANISH_BODY);
  });

  it('says our team will cancel when the Azul cancel did not land', () => {
    const body = confirmationBody(record({ cancel: 'pending' }));
    expect(body).toContain('Cancelaremos su cita del 20 de marzo con nosotros.');
    expect(body).not.toContain('fue cancelada');
  });

  it('leaves the phone out when the practice has none', () => {
    expect(confirmationBody(record({ phone: '' }))).not.toContain('Teléfono:');
  });

  it('says "su cita actual" when the Azul date does not read', () => {
    expect(textedDayEs('not a date')).toBe('');
    expect(textedDayEs('2041-13-20')).toBe('');
    expect(textedDayEs('2041-03-32')).toBe('');
    expect(textedDayEs('2041-03-00')).toBe('');
    const body = confirmationBody(record({ replaced_day_es: '' }));
    expect(body).toContain('Su cita actual con nosotros fue cancelada.');
    expect(confirmationBody(record({ replaced_day_es: '', cancel: 'pending' }))).toContain('Cancelaremos su cita actual con nosotros.');
  });

  // github-actions review of #509 (head cfaddb74): a day the month does not
  // have read as a date, so the text could cancel an appointment on February 30.
  it('reads no day the calendar does not have', () => {
    expect(textedDayEs('2041-02-30')).toBe('');
    expect(textedDayEs('2041-02-29')).toBe('');
    expect(textedDayEs('2041-04-31')).toBe('');
    expect(textedDayEs('2040-02-29')).toBe('29 de febrero');
    expect(textedDayEs('2041-12-31')).toBe('31 de diciembre');
  });

  it('is GSM-7 and fits two segments at the longest place, phone and date the campaign has sent', () => {
    // Hub, every confirmation queued to 2026-11-22: place at most 81
    // characters, phone at most 12. The longest Spanish date and day.
    const longest = record({
      place: 'P'.repeat(81),
      phone: '555-010-0000',
      when_es: 'miércoles 30 de septiembre a las 10:30 AM',
      replaced_day_es: '30 de septiembre',
    });
    for (const cancelState of ['cancelled', 'pending'] as const) {
      const body = confirmationBody({ ...longest, cancel: cancelState });
      expect(nonGsm7Characters(body)).toEqual([]);
      expect(body.length).toBeLessThanOrEqual(306);
    }
    expect(nonGsm7Characters(SPANISH_BODY)).toEqual([]);
  });

  it('names no doctor and no date of birth', () => {
    const body = confirmationBody(record());
    expect(body).not.toContain('Dr Test');
    expect(body).not.toContain('1950');
  });

  it('a record written before v261 has no Spanish words and is texted in English whatever its language', () => {
    const old = record();
    delete old.when_es;
    delete old.replaced_day_es;
    expect(confirmationBody(old)).toBe(ENGLISH_BODY);
  });
});

describe('the Spanish date', () => {
  const at = (startAt: string): NpxSlot => ({ ...SLOT_A, startAt });

  it('names the weekday, day and month, in GSM-7: Saturday is "sabado"', () => {
    // 2041-02-09 is a Saturday; 10:30 AM Pacific.
    expect(textedWhenEs(at('2041-02-09T18:30:00.000Z'))).toBe('sabado 9 de febrero a las 10:30 AM');
    expect(textedWhenEs(at('2041-02-06T17:00:00.000Z'))).toBe('miércoles 6 de febrero a las 9:00 AM');
  });

  it('says "a la" for one o’clock and "a las" for every other hour', () => {
    expect(textedWhenEs(at('2041-02-04T21:00:00.000Z'))).toBe('lunes 4 de febrero a la 1:00 PM');
    expect(textedWhenEs(at('2041-02-04T20:00:00.000Z'))).toBe('lunes 4 de febrero a las 12:00 PM');
  });

  it('reads the day in the practice’s own time zone', () => {
    // 11:30 PM Pacific on the 4th is the 5th in UTC.
    expect(textedWhenEs(at('2041-02-05T07:30:00.000Z'))).toBe('lunes 4 de febrero a las 11:30 PM');
  });

  it('renders the Azul day as a calendar day', () => {
    expect(textedDayEs('2041-03-20')).toBe('20 de marzo');
    expect(textedDayEs('2041-01-06T00:00:00Z')).toBe('6 de enero');
  });
});

describe('the store', () => {
  it('keeps one language per call, a canonical CallSid only, and forgets it at release and after two hours', () => {
    noteCallLanguage('CA-test', 'es');
    expect(callLanguageFor('CA-test')).toBeUndefined();
    noteCallLanguage(SPANISH_FIRST, 'es', 1_000);
    expect(callLanguageFor(SPANISH_FIRST, 1_000)).toBe('es');
    noteCallLanguage(SPANISH_FIRST, 'en', 2_000);
    expect(callLanguageFor(SPANISH_FIRST, 2_000)).toBe('en');
    expect(callLanguageFor(SPANISH_FIRST, 2_000 + 2 * 60 * 60 * 1000 + 1)).toBeUndefined();
    noteCallLanguage(SPANISH_FIRST, 'es');
    releaseCallLanguage(SPANISH_FIRST);
    expect(callLanguageFor(SPANISH_FIRST)).toBeUndefined();
  });

  it('holds at most 500 calls, oldest first out', () => {
    const sid = (i: number) => `CA${i.toString(16).padStart(32, '0')}`;
    for (let i = 0; i < 501; i++) noteCallLanguage(sid(i), 'es', 1_000 + i);
    expect(callLanguageFor(sid(0), 2_000)).toBeUndefined();
    expect(callLanguageFor(sid(500), 2_000)).toBe('es');
    // A sentinel CallSid never takes a place: the oldest real call stays.
    noteCallLanguage('CA-test', 'es', 3_000);
    noteCallLanguage('unknown', 'es', 3_000);
    expect(callLanguageFor(sid(1), 3_000)).toBe('es');
  });
});

describe('the wiring', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('the runtime releases the call language only after it has called endOutreachSession', () => {
    const src = read('runtime/voiceRuntime.ts');
    const end = src.indexOf('void endOutreachSession(entry.callSid);');
    const release = src.indexOf('releaseCallLanguage(entry.callSid);');
    expect(end).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(end);
  });

  it('the bridge and the tools reach the store through static imports (v141)', () => {
    for (const rel of ['runtime/mediaStreamBridge.ts', 'tools/npxOutreachTools.ts', 'runtime/voiceRuntime.ts']) {
      const src = read(rel);
      expect(src).toMatch(/^import \{[^}]*\} from ['"]\.\.\/services\/callLanguage['"];/m);
      expect(src).not.toMatch(/import\(['"][^'"]*callLanguage['"]\)/);
    }
  });
});
