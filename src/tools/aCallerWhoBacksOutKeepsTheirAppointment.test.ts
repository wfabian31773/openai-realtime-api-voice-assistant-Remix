/**
 * v224: a caller who changes their mind before hanging up keeps their Azul
 * appointment. Wayne, 2026-11-13: "Hold the cancel until hang-up: the Azul
 * cancel runs only when the call ends. If the caller backs out on the call,
 * their Azul appointment is kept." And: build an NPX outreach booking-cancel
 * endpoint so the agent can cancel the NPX booking itself during the call.
 *
 * Before this build the call cancelled the Azul appointment seconds after it
 * booked the NPX one. Of the 46 NPX bookings to 2026-11-12, 5 had the caller
 * try to undo on the same call; the agent could only file a ticket, and an
 * NPX booking left live past 15 minutes put its Azul appointment on NPX's
 * backup list for CEC to cancel.
 *
 * Corpus: the real CallSids of three of those calls, with a synthetic patient,
 * practice and slot. Through the real tools (registry), the real hang-up step,
 * the real fallback tick and the real confirmation tick, on a fake store, a
 * fake NPX, a fake Azul cancel and a fake SMS sender.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CANCEL_BOOKING_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  NPX_OUTREACH_TOOLS,
  UNDO_SEQUENCE_BUDGET_MS,
  UNDO_TOOL_TIMEOUT_MS,
  endOutreachSession,
  npxBookingPageLane,
  npxOutreachAfterCalls,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  runHeldAzulCancel,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';
import { confirmationOf, runConfirmationTick } from '../runtime/outbound/bookingConfirmation';
import {
  HELD_CANCEL_FALLBACK_MS,
  HELD_CANCEL_STALE_MS,
  heldCancelOf,
  runHeldCancelTick,
} from '../runtime/outbound/heldAzulCancel';
import type { TextDeps } from '../runtime/outbound/outreachText';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import type { OutboundLanePolicy } from '../runtime/outbound/campaign';
import type { SmsSender } from '../plugin/sms';
import { getAzulTimeline, recordToolEvent } from '../services/toolTimeline';
import { DEFAULT_DEAD_AIR_MS, TOOL_DISPATCH_GRACE_MS } from '../runtime/mediaStreamBridge';

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
const SLOT_B: NpxSlot = { ...SLOT_A, slotId: 'slot-b', startAt: '2041-02-06T22:30:00.000Z', endAt: '2041-02-06T23:00:00.000Z', day: '2041-02-06' };
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
let npx: {
  availability: ReturnType<typeof vi.fn>;
  offer: ReturnType<typeof vi.fn>;
  book: ReturnType<typeof vi.fn>;
  reportCancel: ReturnType<typeof vi.fn>;
  cancelBooking: ReturnType<typeof vi.fn>;
};
let cancel: ReturnType<typeof vi.fn>;
let fileTicket: ReturnType<typeof vi.fn>;
let sent: Array<{ to: string; from: string; body: string }>;
let sender: SmsSender;
let onCall = '';

beforeEach(async () => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  // One clock for the call, the store and the ticks, as one process has.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore(() => new Date());
  store.addContact({ id: 'c1', phone: PHONE, status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  let n = 0;
  npx = {
    availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B], truncated: false })),
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A, SLOT_B] })),
    book: vi.fn(async (req: { slotId: string }) => ({
      ok: true, bookingId: `booking-${++n}`, alreadyBooked: false, recordGroupDiffers: false, slot: req.slotId === 'slot-b' ? SLOT_B : SLOT_A,
    })),
    reportCancel: vi.fn(async () => ({ ok: true })),
    cancelBooking: vi.fn(async () => ({ ok: true, outcome: 'cancelled' })),
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
  let m = 0;
  sender = { send: vi.fn(async (msg) => { sent.push(msg); return { sid: `SM${String(++m).padStart(32, '0')}` }; }) };
  onCall = '';
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const runOn = (sid: string, name: string, args: Record<string, unknown> = {}) => {
  onCall = sid;
  return getTool(name)!.handler({
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: PHONE,
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: sid,
    ...args,
  }) as Promise<Record<string, unknown>>;
};
async function bookOn(sid: string, time = '09:00', date = '2041-02-04') {
  await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
  await runOn(sid, FIND_SOONER_TOOL_NAME);
  const r = await runOn(sid, BOOK_SOONER_TOOL_NAME, { date, time, city: 'Testville' });
  expect(r).toMatchObject({ success: true, booked: true, azul_cancel: 'held' });
  return r;
}
const undo = (sid: string) => runOn(sid, CANCEL_BOOKING_TOOL_NAME);
/** The call ends: Twilio closes the attempt, and the runtime's teardown ends the session. */
const hangUp = async () => {
  await store.finishAttempt(attemptId, { status: 'completed' } as never);
  if (onCall) await endOutreachSession(onCall);
};
const held = () => heldCancelOf(store.contacts.get('c1')!.customData);
const confirmation = () => confirmationOf(store.contacts.get('c1')!.customData);
const later = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));
const textTick = () =>
  runConfirmationTick('npx-outreach', policy, {
    store, env: ENV, host: 'voice.example.test', sms: async () => sender, log: () => undefined,
  } as TextDeps);
const fallbackTick = () =>
  runHeldCancelTick('npx-outreach', { campaignKey: 'test-campaign' }, { store, run: runHeldAzulCancel, log: () => undefined });
const kept = (sid: string, name: string, r: Record<string, unknown>) => {
  recordToolEvent(`timeline-${sid}-${name}`, name, {}, JSON.stringify(r), 1, { callSid: sid });
  const events = getAzulTimeline(`timeline-${sid}-${name}`) ?? [];
  return events[events.length - 1]?.outcome as Record<string, unknown>;
};

const CORPUS = [
  'CAa73b9fea680caad6b075c32167464f2c',
  'CAe91152bd2fbc5055319e1249a4389827',
  'CA27a67f6ad80ff9be334268efd0247324',
];

describe.each(CORPUS)('%s: booked, then changed their mind before hanging up', (sid) => {
  it('the NPX booking is cancelled on the call, the Azul appointment is kept, and nothing confirms the booking', async () => {
    await bookOn(sid);
    // While they are on the line nothing has touched the Azul appointment.
    expect(cancel).not.toHaveBeenCalled();
    expect(held()).toMatchObject({ state: 'held', booking_id: 'booking-1' });

    const r = await undo(sid);
    expect(r).toMatchObject({ success: true, booking_undone: true, npx_cancel: 'cancelled', azul_kept: true });
    expect(r.say).toBe("I've cancelled the new booking. Your appointment with us on Wednesday, March 20 stays as it is.");
    expect(npx.cancelBooking).toHaveBeenCalledWith('booking-1', { callRef: sid, reason: 'caller_changed_mind' });
    expect(held()).toMatchObject({ state: 'dropped', reason: 'booking_undone' });
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', state: 'skipped', reason: 'booking_undone' });
    // The contact records the undo, and is no longer counted as a booking.
    const c = store.contacts.get('c1')!;
    expect(c.status).toBe('declined');
    expect(c.notes).toBe('npx_booking_undone:booking-1');
    expect(c.notes!.startsWith('npx_booking:')).toBe(false);
    // No staff ticket: nothing is left for staff to do.
    expect(fileTicket).not.toHaveBeenCalled();
    // The timeline keeps what happened, as codes.
    expect(kept(sid, CANCEL_BOOKING_TOOL_NAME, r)).toMatchObject({ booking_undone: true, npx_cancel: 'cancelled', azul_kept: true });

    // The call ends: the Azul appointment is never cancelled, NPX is told nothing more, and no text goes.
    await hangUp();
    later(30 * 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect((await textTick()).sent).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(npx.reportCancel).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('the held Azul cancel is dropped before the NPX booking is touched', async () => {
    await bookOn(sid);
    const order: string[] = [];
    const drop = store.dropHeldCancel.bind(store);
    store.dropHeldCancel = async (...a) => { order.push('drop'); return drop(...a); };
    npx.cancelBooking.mockImplementationOnce(async () => { order.push('npx cancel'); return { ok: true, outcome: 'cancelled' }; });
    await undo(sid);
    expect(order).toEqual(['drop', 'npx cancel']);
  });

  it('NPX will not cancel it: staff are asked, urgently, and the Azul appointment is still kept', async () => {
    await bookOn(sid);
    npx.cancelBooking.mockResolvedValueOnce({ ok: false, error: 'not_active' });
    const r = await undo(sid);
    expect(r).toMatchObject({ success: true, booking_undone: false, npx_cancel: 'not_active', azul_kept: true, ticket_number: 'VA-90001' });
    expect(r.say).toBe(
      "I wasn't able to cancel the new booking myself, so I've asked our scheduling team to call you back. Your appointment with us on Wednesday, March 20 is kept.",
    );
    const params = fileTicket.mock.calls[0][0];
    expect(params.priority).toBe('urgent');
    expect(params.description).toMatch(/^NPX Recall: /);
    expect(params.description).toContain('URGENT: they asked to cancel or change the NPX booking booking-1.');
    expect(params.description).toContain('was kept (the call did not cancel it)');
    // NPX's backup list must ask CEC to cancel the NPX booking, not the Azul one.
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', { failed: 'caller_kept_appointment' });
    // Held by the undo before NPX was asked (Codex P2 on #474); the staff hold finds it held.
    expect(confirmation()).toMatchObject({ state: 'held', reason: 'booking_undo' });
    expect(store.contacts.get('c1')!.notes).toBe('npx_booking:booking-1; staff_callback:VA-90001');

    await hangUp();
    later(30 * 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect((await textTick()).sent).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('the store cannot say the held cancel is dropped', () => {
  const sid = CORPUS[0];

  it('NPX is not cancelled, staff are asked to check NextGen, and the hang-up records the drop when the store is back', async () => {
    await bookOn(sid);
    store.heldCancelStoreDown = true;
    const r = await undo(sid);
    expect(npx.cancelBooking).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: true, booking_undone: false, azul_kept: false });
    expect(String(r.say)).toContain("They'll make sure your appointment with us on Wednesday, March 20 is still booked.");
    expect(fileTicket.mock.calls[0][0].description).toContain('was meant to be kept, but the call could not confirm it: check NextGen');
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', { failed: 'caller_kept_appointment' });

    store.heldCancelStoreDown = false;
    await hangUp();
    expect(held()).toMatchObject({ state: 'dropped', reason: 'booking_undone' });
    expect(cancel).not.toHaveBeenCalled();
    later(30 * 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a held record that never reached the store is written dropped, so a late write changes nothing', async () => {
    store.heldCancelStoreDown = true;
    await bookOn(sid);
    expect(held()).toBeNull();
    store.heldCancelStoreDown = false;
    const r = await undo(sid);
    expect(r).toMatchObject({ booking_undone: true });
    expect(held()).toMatchObject({ state: 'dropped', booking_id: 'booking-1' });
    // The write that was lost lands late: it is refused.
    expect(await store.queueHeldCancel('c1', { ...held()!, state: 'held' })).toBe(false);
    expect(held()).toMatchObject({ state: 'dropped' });
    await hangUp();
    later(30 * 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a cancel already running is never undone over: staff are asked, and NPX is left alone', async () => {
    await bookOn(sid);
    await store.claimHeldCancel('c1', 'booking-1', new Date(), new Date(Date.now() - HELD_CANCEL_STALE_MS));
    const r = await undo(sid);
    expect(npx.cancelBooking).not.toHaveBeenCalled();
    expect(npx.reportCancel).not.toHaveBeenCalled();
    expect(r).toMatchObject({ booking_undone: false, azul_kept: false });
    expect(fileTicket.mock.calls[0][0].description).toContain('check NextGen that it is still booked and rebook it if not');
  });
});

describe('on the call', () => {
  const sid = CORPUS[1];

  it('a different time: cancel the first, then book the new one, and the hang-up cancels the Azul appointment once', async () => {
    await bookOn(sid);
    expect(await undo(sid)).toMatchObject({ booking_undone: true });
    await runOn(sid, FIND_SOONER_TOOL_NAME);
    const r = await runOn(sid, BOOK_SOONER_TOOL_NAME, { date: '2041-02-06', time: '14:30', city: 'Testville' });
    expect(r).toMatchObject({ success: true, booked: true, azul_cancel: 'held' });
    expect(held()).toMatchObject({ state: 'held', booking_id: 'booking-2' });
    expect(store.contacts.get('c1')!).toMatchObject({ status: 'completed', notes: 'npx_booking:booking-2' });
    await hangUp();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-2', 'cancelled');
    expect(npx.reportCancel).not.toHaveBeenCalledWith('booking-1', expect.anything());
    expect(confirmation()).toMatchObject({ booking_id: 'booking-2', state: 'due', cancel: 'cancelled' });
  });

  it('nothing booked: there is nothing to cancel, and the appointment stays', async () => {
    await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    const r = await undo(sid);
    expect(r).toMatchObject({ success: false, error: 'nothing_booked' });
    expect(String(r.fix)).toContain('appointment with us stays as it is');
    expect(npx.cancelBooking).not.toHaveBeenCalled();
  });

  it('asking twice undoes once', async () => {
    await bookOn(sid);
    await undo(sid);
    const again = await undo(sid);
    expect(again).toMatchObject({ success: true, booking_undone: true });
    expect(npx.cancelBooking).toHaveBeenCalledTimes(1);
  });

  it('two undos in one turn share one run', async () => {
    await bookOn(sid);
    const [a, b] = await Promise.all([undo(sid), undo(sid)]);
    expect(a).toMatchObject({ booking_undone: true });
    expect(b).toMatchObject({ booking_undone: true });
    expect(npx.cancelBooking).toHaveBeenCalledTimes(1);
  });

  it('is one of the lane\'s tools, answers inside its budget, and asks the model for nothing', () => {
    expect(NPX_OUTREACH_TOOLS).toContain(CANCEL_BOOKING_TOOL_NAME);
    const tool = getTool(CANCEL_BOOKING_TOOL_NAME)!;
    expect(tool.timeoutMs).toBe(UNDO_TOOL_TIMEOUT_MS);
    expect(UNDO_SEQUENCE_BUDGET_MS).toBeLessThan(UNDO_TOOL_TIMEOUT_MS);
    expect(UNDO_TOOL_TIMEOUT_MS).toBeLessThan(DEFAULT_DEAD_AIR_MS + TOOL_DISPATCH_GRACE_MS);
    expect(tool.input_schema.properties).toEqual({});
  });

  it('a staff callback asked to change the booking keeps the Azul appointment too', async () => {
    await bookOn(sid);
    await runOn(sid, 'request_staff_callback', { request: 'Move it to another day', changes_booking: true });
    expect(held()).toMatchObject({ state: 'dropped', reason: 'staff_change' });
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', { failed: 'caller_kept_appointment' });
    await hangUp();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a staff callback that does not change the booking leaves the cancel for the hang-up', async () => {
    await bookOn(sid);
    await runOn(sid, 'request_staff_callback', { request: 'A question about parking', changes_booking: false });
    expect(held()).toMatchObject({ state: 'held' });
    await hangUp();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('the hang-up runs the held cancel, once', () => {
  const sid = CORPUS[2];

  it('a call that ends normally runs it at hang-up, then releases the text with what it came to', async () => {
    await bookOn(sid);
    expect(confirmation()).toMatchObject({ state: 'awaiting_cancel', cancel: 'pending' });
    await hangUp();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'appt-0001', personId: 'person-0001', appointmentDate: '2041-03-20' }));
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
    expect(held()).toMatchObject({ state: 'cancelled', by: 'hang_up' });
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
    later(2 * 60_000);
    expect((await textTick()).sent).toBe(1);
    expect(sent[0].body).toContain('Your Mar 20 appointment with us is cancelled.');
    later(HELD_CANCEL_FALLBACK_MS + 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a process that died before its teardown: the fallback runs it once the call is over and its time has come', async () => {
    await bookOn(sid);
    resetOutreachSessionsForTests(); // the process died: no teardown ran
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    later(HELD_CANCEL_FALLBACK_MS - 60_000);
    expect((await fallbackTick()).ran).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    later(HELD_CANCEL_FALLBACK_MS);
    expect((await fallbackTick()).ran).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(held()).toMatchObject({ state: 'cancelled', by: 'fallback' });
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
    later(HELD_CANCEL_FALLBACK_MS + 60_000);
    expect((await fallbackTick()).ran).toBe(0);
  });

  it('the fallback never runs it while the person is still on the phone with us', async () => {
    await bookOn(sid);
    resetOutreachSessionsForTests();
    later(HELD_CANCEL_FALLBACK_MS + 60_000);
    const r = await fallbackTick();
    expect(r).toMatchObject({ ran: 0, held: { call_open: 1 } });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('the fallback and a late teardown: only one of them runs it', async () => {
    await bookOn(sid);
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    later(HELD_CANCEL_FALLBACK_MS + 60_000);
    expect((await fallbackTick()).ran).toBe(1);
    await endOutreachSession(sid);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store.heldCancelClaims).toBe(1);
  });

  it('a claim that died part way is run again once it is stale', async () => {
    await bookOn(sid);
    resetOutreachSessionsForTests();
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    later(HELD_CANCEL_FALLBACK_MS);
    await store.claimHeldCancel('c1', 'booking-1', new Date(), new Date(0));
    later(HELD_CANCEL_FALLBACK_MS + HELD_CANCEL_STALE_MS - 1_000);
    expect((await fallbackTick()).ran).toBe(0);
    later(HELD_CANCEL_FALLBACK_MS + HELD_CANCEL_STALE_MS);
    expect((await fallbackTick()).ran).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('the store down at hang-up: the call runs its own copy, and NPX is still told', async () => {
    await bookOn(sid);
    store.heldCancelStoreDown = true;
    await hangUp();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
  });

  it('a held record that never reached the store is run from the call at hang-up', async () => {
    store.heldCancelStoreDown = true;
    await bookOn(sid);
    store.heldCancelStoreDown = false;
    await hangUp();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a hang-up during the booking waits for it, then runs the cancel', async () => {
    await runOn(sid, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await runOn(sid, FIND_SOONER_TOOL_NAME);
    let release!: () => void;
    npx.book.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A });
      }),
    );
    const booking = runOn(sid, BOOK_SOONER_TOOL_NAME, { date: '2041-02-04', time: '09:00', city: 'Testville' });
    await Promise.resolve();
    const ending = hangUp();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await booking;
    await ending;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('the after-calls step the lane registers is the fallback, with its counts', async () => {
    await bookOn(sid);
    resetOutreachSessionsForTests();
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    later(HELD_CANCEL_FALLBACK_MS + 60_000);
    const counts = await npxOutreachAfterCalls({ slug: 'npx-outreach', store, now: () => new Date(), log: () => undefined }, 'test-campaign');
    expect(counts).toEqual({ held_cancels_run: 1 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('the text link is unchanged', () => {
  it('cancels the Azul appointment at once and holds nothing', async () => {
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    const contact = (await store.loadCallContact('c1', attemptId))!;
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'slot-a', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r).toMatchObject({ ok: true, bookingId: 'booking-1' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
    expect(held()).toBeNull();
    expect(confirmation()).toMatchObject({ by: 'link', state: 'due', cancel: 'cancelled' });
  });
});

describe('a settle that throws does not cost the booking its confirmation (Codex P1 on #470)', () => {
  const settleThrows = () => {
    store.settleContact = async () => { throw new Error('store blip on the settle'); };
  };

  it('on a call: the confirmation is queued, waiting for the cancel, and goes after the hang-up', async () => {
    settleThrows();
    await bookOn(CORPUS[0]);
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', by: 'call', state: 'awaiting_cancel' });
    await hangUp();
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
    later(10 * 60_000);
    expect((await textTick()).sent).toBe(1);
  });

  it('on the text link: the confirmation is queued due, with the cancel it came to', async () => {
    settleThrows();
    await store.finishAttempt(attemptId, { status: 'completed' } as never);
    const contact = (await store.loadCallContact('c1', attemptId))!;
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'slot-a', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r).toMatchObject({ ok: true, bookingId: 'booking-1' });
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', by: 'link', state: 'due', cancel: 'cancelled' });
  });
});

describe('an undo that lands before the confirmation is queued (the hold\'s rule, Codex P2 on #470)', () => {
  it('the undo writes a skipped placeholder, and the late queue cannot replace it', async () => {
    // The booking tool's queue is still on its way when the undo runs.
    const queue = store.queueConfirmation.bind(store);
    let lateQueue: (() => Promise<boolean>) | null = null;
    store.queueConfirmation = async (...a) => { lateQueue = () => queue(...a); return true; };
    await bookOn(CORPUS[1]);
    expect(confirmation()).toBeNull();
    const r = await undo(CORPUS[1]);
    expect(r).toMatchObject({ booking_undone: true });
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', state: 'skipped', reason: 'booking_undone' });
    expect(await lateQueue!()).toBe(false);
    expect(confirmation()).toMatchObject({ state: 'skipped' });
    await hangUp();
    later(30 * 60_000);
    expect((await textTick()).sent).toBe(0);
  });

  it('a confirmation the scheduler holds a claim on is skipped too, so its put-back cannot revive it', async () => {
    await bookOn(CORPUS[2]);
    const c = store.contacts.get('c1')!;
    const t = c.customData.outreach_text as Record<string, unknown>;
    t.confirmation = { ...(t.confirmation as object), state: 'claimed', claimed_at: new Date().toISOString() };
    expect(await store.skipConfirmation('c1', 'booking-1', 'booking_undone')).toBe(true);
    await store.patchConfirmation('c1', { state: 'retry', reason: 'call_open' } as never);
    expect(confirmation()).toMatchObject({ state: 'skipped', reason: 'booking_undone' });
  });
});

describe('the hang-up releases before the confirmation is queued (Codex P2 on #474)', () => {
  const sid = CORPUS[2];
  /** The booking tool's queue is still on its way when the call ends. */
  const holdTheQueue = () => {
    const queue = store.queueConfirmation.bind(store);
    let lateQueue: (() => Promise<boolean>) | null = null;
    store.queueConfirmation = async (...a) => { lateQueue = () => queue(...a); return true; };
    return () => lateQueue!();
  };

  it('the late queue takes the release over: the text goes after the hang-up and says the appointment is cancelled', async () => {
    const lateQueue = holdTheQueue();
    await bookOn(sid);
    later(60_000);
    await hangUp();
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', state: 'released', cancel: 'cancelled' });
    // A released placeholder is never sent on its own.
    later(30 * 60_000);
    expect((await textTick()).sent).toBe(0);
    expect(await lateQueue()).toBe(true);
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', by: 'call', state: 'due', cancel: 'cancelled', due_at: new Date(NOW.getTime() + 60_000).toISOString() });
    expect((await textTick()).sent).toBe(1);
    expect(sent[0].body).toContain('Your Mar 20 appointment with us is cancelled.');
    expect(sent[0].body).not.toContain('Our team will cancel');
  });

  it('a cancel that did not land is released as pending, and the text says our team will cancel', async () => {
    cancel.mockResolvedValueOnce({ cancelled: false, reason: 'nextgen_cancel_failed' });
    const lateQueue = holdTheQueue();
    await bookOn(sid);
    await hangUp();
    expect(confirmation()).toMatchObject({ state: 'released', cancel: 'pending' });
    expect(await lateQueue()).toBe(true);
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'pending' });
    later(3 * 60_000);
    expect((await textTick()).sent).toBe(1);
    expect(sent[0].body).toContain('Our team will cancel your Mar 20 appointment with us.');
  });

  it('a queue that lands first is released as before, and a second queue never replaces it', async () => {
    await bookOn(sid);
    await hangUp();
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
    expect(await store.queueConfirmation('c1', { ...confirmation()!, state: 'awaiting_cancel', cancel: 'pending' })).toBe(false);
    expect(confirmation()).toMatchObject({ state: 'due', cancel: 'cancelled' });
  });
});

describe('the undo holds the confirmation before NPX cancels the booking (Codex P2 on #474)', () => {
  const sid = CORPUS[0];

  it('a skip that throws after NPX cancelled the booking leaves the confirmation held: nothing confirms a cancelled booking', async () => {
    await bookOn(sid);
    store.skipConfirmation = async () => { throw new Error('store blip on the skip'); };
    const r = await undo(sid);
    expect(r).toMatchObject({ success: true, booking_undone: true, npx_cancel: 'cancelled', azul_kept: true });
    expect(confirmation()).toMatchObject({ booking_id: 'booking-1', state: 'held', reason: 'booking_undo' });
    await hangUp();
    later(30 * 60_000);
    expect((await textTick()).sent).toBe(0);
    expect((await fallbackTick()).ran).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('the hold lands before NPX is asked', async () => {
    await bookOn(sid);
    const order: string[] = [];
    const hold = store.holdConfirmation.bind(store);
    store.holdConfirmation = async (...a) => { order.push('hold'); return hold(...a); };
    npx.cancelBooking.mockImplementationOnce(async () => { order.push('npx_cancel'); return { ok: true, outcome: 'cancelled' }; });
    await undo(sid);
    expect(order).toEqual(['hold', 'npx_cancel']);
    expect(confirmation()).toMatchObject({ state: 'skipped', reason: 'booking_undone' });
  });

  it('a hold that cannot be written: NPX is not cancelled, NPX is told the Azul appointment is kept, and staff are asked', async () => {
    await bookOn(sid);
    store.holdConfirmation = async () => { throw new Error('store blip on the hold'); };
    const r = await undo(sid);
    expect(npx.cancelBooking).not.toHaveBeenCalled();
    expect(npx.reportCancel).toHaveBeenCalledWith('booking-1', { failed: 'caller_kept_appointment' });
    expect(r).toMatchObject({ success: true, booking_undone: false, npx_cancel: 'confirmation_not_held', azul_kept: true, ticket_number: 'VA-90001' });
    expect(fileTicket.mock.calls[0][0].priority).toBe('urgent');
    expect(held()).toMatchObject({ state: 'dropped' });
    await hangUp();
    later(30 * 60_000);
    expect(cancel).not.toHaveBeenCalled();
  });
});
