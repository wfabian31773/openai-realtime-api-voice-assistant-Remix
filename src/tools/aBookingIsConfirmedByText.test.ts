/**
 * v222: every NPX outreach booking, on a call or on the text's booking page,
 * is confirmed by a text with the appointment details. Operator, 2026-11-13:
 * "Anything booked on the calls or by sms has to have some message confirming
 * with the appointment details."
 *
 * Before this build nothing was sent after a booking. Of the 46 bookings to
 * 2026-11-12, three callers rang back asking for the details by text, and
 * three asked staff on the same call to undo what was just booked.
 *
 * Corpus: the real CallSids of those six calls, with a synthetic patient,
 * practice and slot. Through the real tools (registry), the real queue and the
 * real confirmation tick, on a fake store, a fake NPX, a fake Azul cancel and a
 * fake SMS sender.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  STAFF_CALLBACK_TOOL_NAME,
  bookingChangeLine,
  confirmationRecordFor,
  endOutreachSession,
  npxBookingPageLane,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  textedDay,
} from './npxOutreachTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';
import {
  CALL_AWAIT_CANCEL_MAX_MS,
  CALL_CONFIRMATION_DELAY_MS,
  confirmationBody,
  confirmationOf,
  runConfirmationTick,
} from '../runtime/outbound/bookingConfirmation';
import type { TextDeps } from '../runtime/outbound/outreachText';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import type { OutboundLanePolicy } from '../runtime/outbound/campaign';
import type { SmsSender } from '../plugin/sms';
import { SendOutcomeError } from '../plugin/sendFailure';
import { nonGsm7Characters } from '../services/gsm7';
import { getAzulTimeline, recordToolEvent } from '../services/toolTimeline';

// The timeline module opens server/db at load for its flush path; these tests
// read only what it records in memory.
vi.mock('../../server/db', () => ({ db: {} }));

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
let fileTicket: ReturnType<typeof vi.fn>;
let sent: Array<{ to: string; from: string; body: string }>;
let sender: SmsSender;

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
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
  fileTicket = vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' }));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
    fileTicket: fileTicket as never,
  });
  sent = [];
  let n = 0;
  sender = { send: vi.fn(async (m) => { sent.push(m); return { sid: `SM${String(++n).padStart(32, '0')}` }; }) };
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
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
const tick = (over: Partial<TextDeps> = {}) => runConfirmationTick('npx-outreach', policy, deps(over));

/** The call the tests are on, so the hang-up ends the right session. */
let onCall = '';
const runOn = (sid: string, name: string, args: Record<string, unknown> = {}) =>
  (onCall = sid, getTool(name)!.handler({
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: PHONE,
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: sid,
    ...args,
  }));

async function bookOn(sid: string) {
  await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  await runOn(sid, FIND_SOONER_TOOL_NAME);
  const r = (await runOn(sid, BOOK_SOONER_TOOL_NAME, { date: '2041-02-04', time: '09:00', city: 'Testville' })) as Record<string, unknown>;
  expect(r).toMatchObject({ success: true, booked: true });
}
/** The call ends: Twilio's status closes the attempt, and the runtime's
 * teardown ends the session, which runs the held Azul cancel (v226). */
const hangUp = async () => {
  await store.finishAttempt(attemptId, { status: 'completed' } as never);
  if (onCall) await endOutreachSession(onCall);
};
const confirmation = () => confirmationOf(store.contacts.get('c1')!.customData);

const BOOKED_BODY =
  "Azul Vision: you're booked for Mon, Feb 4 at 9:00 AM at Partner One Optometry, 1 Test St, Testville. " +
  'Their phone: 555-010-0000. Your Mar 20 appointment with us is cancelled. Questions? Call this number. Reply STOP to opt out.';

describe('the text', () => {
  it('names the day, time, practice, address and phone, and says the Azul appointment is cancelled', () => {
    const r = confirmationRecordFor({ contact: { contactId: 'c1', phone: PHONE, firstName: 'Testa', lastName: 'Synthetic', data: DATA } as never, slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: true });
    expect(confirmationBody(r)).toBe(BOOKED_BODY);
  });

  it('says our team will cancel when the Azul cancel did not land', () => {
    const r = confirmationRecordFor({ contact: { contactId: 'c1', phone: PHONE, data: DATA } as never, slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: false });
    expect(confirmationBody(r)).toContain('Our team will cancel your Mar 20 appointment with us.');
    expect(confirmationBody(r)).not.toContain('is cancelled');
  });

  it('is GSM-7, names no doctor and no date of birth, and fits in two segments', () => {
    const r = confirmationRecordFor({ contact: { contactId: 'c1', phone: PHONE, data: DATA } as never, slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: true });
    const body = confirmationBody(r);
    expect(nonGsm7Characters(body)).toEqual([]);
    expect(body).not.toContain('Dr Test');
    expect(body).not.toContain('1950');
    expect(body.length).toBeLessThanOrEqual(306);
  });

  it('a call booking waits for the call; a link booking goes now', () => {
    const contact = { contactId: 'c1', phone: PHONE, data: DATA } as never;
    const call = confirmationRecordFor({ contact, slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: true, now: NOW });
    expect(call).toMatchObject({ by: 'call', call_sid: 'CA1', state: 'due' });
    expect(new Date(call.due_at).getTime() - NOW.getTime()).toBe(CALL_CONFIRMATION_DELAY_MS);
    // v226: a call booking whose Azul cancel is held waits for the hang-up to
    // release it, and goes anyway, saying our team will cancel, after 20 minutes.
    const held = confirmationRecordFor({ contact, slot: SLOT_A, bookingId: 'b', callRef: 'CA1', cancelled: true, awaitCancel: true, now: NOW });
    expect(held).toMatchObject({ state: 'awaiting_cancel', cancel: 'pending' });
    expect(new Date(held.due_at).getTime() - NOW.getTime()).toBe(CALL_AWAIT_CANCEL_MAX_MS);
    // A link booking never waits for a hang-up.
    expect(confirmationRecordFor({ contact, slot: SLOT_A, bookingId: 'b', callRef: 'text-link-c1', cancelled: true, awaitCancel: true, now: NOW }))
      .toMatchObject({ state: 'due', cancel: 'cancelled' });
    const link = confirmationRecordFor({ contact, slot: SLOT_A, bookingId: 'b', callRef: 'text-link-c1', cancelled: true, now: NOW });
    expect(link).toMatchObject({ by: 'link', state: 'due', due_at: NOW.toISOString() });
    expect(link.call_sid).toBeUndefined();
  });

  it('reads the Azul date as a calendar day', () => {
    expect(textedDay('2041-03-20')).toBe('Mar 20');
    expect(textedDay('2041-01-05')).toBe('Jan 5');
  });
});

describe('the Azul cancel is recorded on the booking (v222)', () => {
  /** What the tool timeline keeps of the result, through its own allow-list. */
  const kept = (sid: string, r: Record<string, unknown>) => {
    recordToolEvent(`timeline-${sid}`, BOOK_SOONER_TOOL_NAME, {}, JSON.stringify(r), 1, { callSid: sid });
    const events = getAzulTimeline(`timeline-${sid}`) ?? [];
    return events[events.length - 1]?.outcome as Record<string, unknown>;
  };
  const book = async (sid: string) => {
    await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await runOn(sid, FIND_SOONER_TOOL_NAME);
    return (await runOn(sid, BOOK_SOONER_TOOL_NAME, { date: '2041-02-04', time: '09:00', city: 'Testville' })) as Record<string, unknown>;
  };

  it('a call booking is azul_cancel held, kept by the timeline; the hang-up writes what it came to on the contact (v226)', async () => {
    const r = await book('CA00000000000000000000000000000231');
    expect(r).toMatchObject({ success: true, azul_cancel: 'held' });
    expect(r).not.toHaveProperty('azul_cancel_reason');
    expect(kept('CA00000000000000000000000000000231', r)).toMatchObject({ azul_cancel: 'held' });
    expect(cancel).not.toHaveBeenCalled();
    await hangUp();
    expect(store.heldCancelOf(store.contacts.get('c1')!)).toMatchObject({ state: 'cancelled', booking_id: 'booking-1', by: 'hang_up' });
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', state: 'due', cancel: 'cancelled' });
  });

  it('a cancel that did not land at hang-up is not_cancelled with its own code on the contact, and the text is pending', async () => {
    cancel.mockResolvedValueOnce({ cancelled: false, reason: 'nextgen_timeout' } as AzulCancelResult);
    const r = await book('CA00000000000000000000000000000232');
    expect(r).toMatchObject({ success: true, azul_cancel: 'held' });
    await hangUp();
    expect(store.heldCancelOf(store.contacts.get('c1')!)).toMatchObject({ state: 'not_cancelled', reason: 'nextgen_timeout' });
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'pending' });
  });

  it('a link booking still cancels at once and is cancelled or not_cancelled', async () => {
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    const contact = (await store.loadCallContact('c1', attemptId))!;
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'slot-a', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r).toMatchObject({ ok: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store.heldCancelOf(store.contacts.get('c1')!)).toBeNull();
    expect(confirmation()).toMatchObject({ by: 'link', state: 'due', cancel: 'cancelled' });
  });
});

describe('a booking on a call', () => {
  it('queues one confirmation, sends it once the call has ended, and never twice', async () => {
    // The booking reads the clock the tick does, as one process does.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await bookOn('CA00000000000000000000000000000221');
    // v226: it waits for the held Azul cancel, which runs at hang-up.
    expect(confirmation()).toMatchObject({ state: 'awaiting_cancel', by: 'call', booking_id: 'booking-1', cancel: 'pending' });

    // Still on the phone with us: it waits.
    const during = await tick();
    expect(during.sent).toBe(0);
    expect(sent).toEqual([]);
    expect(confirmation()).toMatchObject({ state: 'awaiting_cancel' });

    await hangUp();
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
    const after = await tick({ now: () => new Date(NOW.getTime() + 2 * 60_000) });
    expect(after.sent).toBe(1);
    expect(sent).toEqual([{ to: PHONE, from: FROM, body: BOOKED_BODY }]);
    expect(confirmation()).toMatchObject({ state: 'sent' });

    const again = await tick({ now: () => new Date(NOW.getTime() + 10 * 60_000) });
    expect(again.sent).toBe(0);
    expect(sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it('the same booking queued again is not sent again; a different booking is', async () => {
    await bookOn('CA00000000000000000000000000000229');
    await hangUp();
    await tick({ now: () => new Date(NOW.getTime() + 2 * 60_000) });
    expect(sent).toHaveLength(1);
    const record = confirmation()!;

    // A retried booking that NPX answers with the same booking id.
    expect(await store.queueConfirmation('c1', { ...record, state: 'due' })).toBe(false);
    await tick({ now: () => new Date(NOW.getTime() + 20 * 60_000) });
    expect(sent).toHaveLength(1);

    // A new booking on the contact gets its own text.
    expect(await store.queueConfirmation('c1', { ...record, state: 'due', booking_id: 'booking-2' })).toBe(true);
    await tick({ now: () => new Date(NOW.getTime() + 30 * 60_000) });
    expect(sent).toHaveLength(2);
  });

  it('says our team will cancel when the Azul cancel failed', async () => {
    cancel.mockResolvedValueOnce({ cancelled: false, reason: 'nextgen_timeout' } as AzulCancelResult);
    await bookOn('CA00000000000000000000000000000222');
    await hangUp();
    await tick();
    expect(sent[0].body).toContain('Our team will cancel your Mar 20 appointment with us.');
  });

  it('is never sent to a number on do_not_contact', async () => {
    await bookOn('CA00000000000000000000000000000223');
    await hangUp();
    await store.stampDoNotContact(PHONE, 'voice');
    const r = await tick();
    expect(r.held).toEqual({ do_not_contact: 1 });
    expect(sent).toEqual([]);
    expect(confirmation()).toMatchObject({ state: 'skipped', reason: 'do_not_contact' });
  });

  it('is not sent when the campaign texts are switched off, or outside the calling window', async () => {
    await bookOn('CA00000000000000000000000000000224');
    await hangUp();
    expect(await tick({ env: { OUTBOUND_TEST_FROM: FROM } })).toMatchObject({ skipped: 'disabled', sent: 0 });
    // 9 PM Pacific.
    const late = await tick({ now: () => new Date('2041-03-06T05:00:00Z') });
    expect(late.sent).toBe(0);
    expect(late.skipped).toBeDefined();
    expect(sent).toEqual([]);
  });

  it('a send that may have gone out is never sent again; a refusal is retried', async () => {
    await bookOn('CA00000000000000000000000000000225');
    await hangUp();
    sender = { send: vi.fn(async () => Promise.reject(new SendOutcomeError('sms_timeout', true))) };
    await tick();
    expect(confirmation()).toMatchObject({ state: 'unknown' });
    expect((await tick({ now: () => new Date(NOW.getTime() + 60 * 60_000) })).sent).toBe(0);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('a clear refusal waits and tries again', async () => {
    await bookOn('CA00000000000000000000000000000226');
    await hangUp();
    let fail = true;
    sender = {
      send: vi.fn(async (m) => {
        if (fail) throw new SendOutcomeError('twilio_rejected', false);
        sent.push(m);
        return { sid: 'SM1' };
      }),
    };
    await tick();
    expect(confirmation()).toMatchObject({ state: 'retry', tries: 1 });
    fail = false;
    expect((await tick({ now: () => new Date(NOW.getTime() + 20 * 60_000) })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('a booking on the text link', () => {
  it('queues a link confirmation and the tick sends it', async () => {
    await hangUp();
    const contact = (await store.loadCallContact('c1', attemptId))!;
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'slot-a', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r).toMatchObject({ ok: true, bookingId: 'booking-1' });
    expect(confirmation()).toMatchObject({ by: 'link', state: 'due' });
    expect((await tick()).sent).toBe(1);
    expect(sent[0].body).toBe(BOOKED_BODY);
  });
});

// The three calls of 2026-11-11..12 that booked and then asked staff for the
// details by text: the confirmation is what they asked for.
describe.each([
  'CA9e93a873fd96a5a80672c18d1e0cd69c',
  'CA2d3c9ad8a9f410b80d11082c2591d095',
  'CA458ca5c0a716ac642b25b9256f3d75fb',
])('%s: booked, then asked for the details by text', (sid) => {
  it('files the staff ticket at medium priority and still sends the confirmation after the call', async () => {
    await bookOn(sid);
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Send the appointment details by text', changes_booking: false });
    expect(fileTicket.mock.calls[0][0]).toMatchObject({ priority: 'medium' });
    expect(fileTicket.mock.calls[0][0].description).not.toContain('URGENT');
    await hangUp();
    expect((await tick()).sent).toBe(1);
  });
});

// The three calls that booked and then asked staff on the same call to undo it.
describe.each([
  'CAa73b9fea680caad6b075c32167464f2c',
  'CAe91152bd2fbc5055319e1249a4389827',
  'CA27a67f6ad80ff9be334268efd0247324',
])('%s: booked, then asked to undo it', (sid) => {
  it('files an urgent ticket that says what staff must do, holds the text, and tells the caller where things stand', async () => {
    await bookOn(sid);
    const r = (await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel the new appointment', changes_booking: true })) as Record<string, unknown>;
    const params = fileTicket.mock.calls[0][0];
    expect(params.priority).toBe('urgent');
    expect(params.description).toContain('URGENT: they asked to cancel or change the NPX booking booking-1.');
    // v226: the cancel was held, so asking staff to change it keeps the Azul
    // appointment: the held cancel is dropped and staff are told not to cancel it.
    expect(params.description).toContain('was kept (the call did not cancel it): do not cancel it unless they still want the move');
    expect(params.description).not.toContain('rebook it');
    expect(params.description).toMatch(/^NPX Recall: /);
    expect(String(r.say)).toBe(
      "I've asked our scheduling team to call you back to change that. Until they call, the new appointment is still booked, and your appointment with us is still on file.",
    );
    expect(confirmation()).toMatchObject({ state: 'held', reason: 'staff_change' });
    expect(store.heldCancelOf(store.contacts.get('c1')!)).toMatchObject({ state: 'dropped', reason: 'staff_change' });
    await hangUp();
    expect(cancel).not.toHaveBeenCalled();
    expect((await tick()).sent).toBe(0);
    expect(sent).toEqual([]);
  });
});

// Codex P2 on #470: a call that booked, filed a staff ticket for something
// else, then asked to undo the booking. The undo needs its own urgent ticket
// and a held text; the one-ticket-per-call return used to answer it first.
describe('a booking change asked after another staff ticket on the call', () => {
  const sid = 'CA00000000000000000000000000000229';
  it('files its own urgent ticket naming the first, holds the text, and lists both tickets', async () => {
    await bookOn(sid);
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Does my insurance cover it', changes_booking: false });
    expect(fileTicket.mock.calls[0][0]).toMatchObject({ priority: 'medium', idempotencyKey: `${sid}-outreach-staff` });
    fileTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-90002' });
    const r = (await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel the new appointment', changes_booking: true })) as Record<string, unknown>;
    expect(fileTicket).toHaveBeenCalledTimes(2);
    const second = fileTicket.mock.calls[1][0];
    expect(second.priority).toBe('urgent');
    expect(second.idempotencyKey).toBe(`${sid}-outreach-staff-change`);
    expect(second.description).toContain('URGENT: they asked to cancel or change the NPX booking booking-1.');
    expect(second.description).toContain('This adds to VA-90001, filed earlier on this call.');
    expect(r.ticket_number).toBe('VA-90002');
    expect(String(r.say)).toContain("I've asked our scheduling team to call you back to change that.");
    expect(confirmation()).toMatchObject({ state: 'held', reason: 'staff_change' });
    expect(store.contacts.get('c1')!.notes).toBe('npx_booking:booking-1; staff_callback:VA-90001; staff_callback:VA-90002');
    // A third ask, change or not, files nothing more.
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel it please', changes_booking: true });
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'One more question', changes_booking: false });
    expect(fileTicket).toHaveBeenCalledTimes(2);
    await hangUp();
    expect((await tick()).sent).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a second request that does not change the booking still files nothing', async () => {
    await bookOn(sid);
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Does my insurance cover it', changes_booking: false });
    const r = (await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'And the parking', changes_booking: false })) as Record<string, unknown>;
    expect(fileTicket).toHaveBeenCalledTimes(1);
    expect(r.ticket_number).toBe('VA-90001');
    await hangUp();
    expect((await tick()).sent).toBe(1);
  });
});

// Codex P2 on #470 (head b3337a4): the scheduler claims a confirmation, then
// asks whether the call is open. A staff change that lands in that gap found
// the row `claimed`, could not hold it, and the scheduler's release put it
// back to `retry`, so the text went out after the call.
describe('a booking change that lands while the scheduler holds the claim', () => {
  const sid = 'CA00000000000000000000000000000230';
  it('is held, and the release does not undo it', async () => {
    await bookOn(sid);
    const open = store.callOpenOnPhone.bind(store);
    let changed = false;
    store.callOpenOnPhone = async (contactId, since) => {
      if (!changed) {
        changed = true;
        expect(confirmation()).toMatchObject({ state: 'claimed' });
        await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel the new appointment', changes_booking: true });
      }
      return open(contactId, since);
    };
    expect((await tick()).sent).toBe(0);
    expect(changed).toBe(true);
    expect(confirmation()).toMatchObject({ state: 'held', reason: 'staff_change' });
    await hangUp();
    expect((await tick({ now: () => new Date(NOW.getTime() + 10 * 60_000) })).sent).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a send is still recorded as sent', async () => {
    await bookOn(sid);
    await hangUp();
    const claimed = await store.claimConfirmation('c1', NOW);
    expect(claimed).not.toBeNull();
    await store.holdConfirmation('c1', 'booking-1', 'staff_change');
    await store.patchConfirmation('c1', { state: 'sent', sent_at: NOW.toISOString(), message_sid: 'SM1' });
    expect(confirmation()).toMatchObject({ state: 'sent', message_sid: 'SM1' });
    await store.patchConfirmation('c1', { state: 'retry', reason: 'call_open' });
    expect(confirmation()).toMatchObject({ state: 'sent' });
  });
});

// Codex P2 on #470 (head 58128f6): the queue runs inside the booking tool's
// settle budget, so a slow store can answer the caller before the
// confirmation exists. A booking change then found nothing to hold, and the
// queue, landing later, wrote the confirmation as due.
describe('a booking change that lands before its confirmation is queued', () => {
  const sid = 'CA00000000000000000000000000000231';
  it('is held, and the late queue does not undo it', async () => {
    const queue = store.queueConfirmation.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let queued: Promise<boolean> | undefined;
    store.queueConfirmation = (contactId, record) => {
      queued = gate.then(() => queue(contactId, record));
      return queued;
    };
    await bookOn(sid);
    expect(confirmation()).toBeNull();
    await runOn(sid, STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel the new appointment', changes_booking: true });
    expect(confirmation()).toMatchObject({ state: 'held', reason: 'staff_change', booking_id: 'booking-1' });
    release();
    expect(await queued).toBe(false);
    expect(confirmation()).toMatchObject({ state: 'held', booking_id: 'booking-1' });
    await hangUp();
    expect((await tick({ now: () => new Date(NOW.getTime() + 10 * 60_000) })).sent).toBe(0);
    expect(sent).toEqual([]);
  }, 10_000);
});

// Codex P2 on #470 (head 58128f6): a check before the send that throws used
// to leave the confirmation `claimed`, which no later tick selects.
describe('a check before the send that fails', () => {
  it('puts the claim back to retry, and a later tick sends it', async () => {
    await bookOn('CA00000000000000000000000000000232');
    await hangUp();
    const dnc = store.isDoNotContact.bind(store);
    store.isDoNotContact = async () => { throw new Error('connection reset'); };
    const first = await tick({ now: () => new Date(NOW.getTime() + 2 * 60_000) });
    expect(first).toMatchObject({ sent: 0, held: { check_failed: 1 } });
    expect(confirmation()).toMatchObject({ state: 'retry', reason: 'check_failed', tries: 1 });
    store.isDoNotContact = dnc;
    expect((await tick({ now: () => new Date(NOW.getTime() + 60 * 60_000) })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('changes_booking with nothing booked', () => {
  it('is an ordinary staff callback', async () => {
    await runOn('CA00000000000000000000000000000227', STAFF_CALLBACK_TOOL_NAME, { request: 'Cancel my appointment', changes_booking: true });
    expect(fileTicket.mock.calls[0][0]).toMatchObject({ priority: 'medium' });
    expect(fileTicket.mock.calls[0][0].description).not.toContain('URGENT');
  });
});

describe('the undo line for each state of the Azul appointment', () => {
  const contact = { contactId: 'c1', phone: PHONE, data: DATA } as never;
  const record = { state: 'held', booking_id: 'b', call_sid: 'CA1', demo: false, appointment_id: 'a', appointment_date: '2041-03-20', person_id: 'p', held_at: '', run_after: '' } as const;
  it('tells staff not to cancel an Azul appointment the cancel did not reach', () => {
    const line = bookingChangeLine(contact, { bookingId: 'b', slot: SLOT_A, azul: { kind: 'done', result: { cancelled: false, reason: 'nextgen_timeout' } } });
    expect(line).toContain('is still on file: do not cancel it');
  });
  it('tells staff to check NextGen when the call could not confirm the Azul appointment was kept', () => {
    const line = bookingChangeLine(contact, { bookingId: 'b', slot: SLOT_A, azul: { kind: 'dropped', record: { ...record }, kept: 'unconfirmed', storeDropPending: true } });
    expect(line).toContain('was meant to be kept, but the call could not confirm it: check NextGen');
  });
});
