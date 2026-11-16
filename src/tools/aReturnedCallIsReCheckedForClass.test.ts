/**
 * ONLY NEW OR LAPSED PATIENTS ARE OFFERED A SOONER EXAM, ON A RETURNED CALL
 * TOO (v246, operator 2026-11-16: "make sure that only lapsed or new patients
 * are being outreached").
 *
 * v246 filtered the movable list and its dial-time re-check by patient class,
 * which stops the dials, the texts and the booking link. A patient ringing
 * the caller ID back is found among the campaign's rows, and those rows still
 * hold every Existing patient already called or texted, so before this change
 * the tools offered and booked them. On 2026-11-16, 19:44-23:00 UTC, 13
 * returned calls booked 3 times, 2 of them Existing patients:
 *
 *   CAc8f701da3610e1dab706c5cd143f3b33  Existing, booked (off the list now)
 *   CAebe21a2eb3aacc6ad53778814a073f2f  Existing, booked (off the list now)
 *   CAb84bc43b14136b999ab72eab30f62ca7  New, booked (must still book)
 *
 * The SIDs name the shapes; the patients, dates and slots here are synthetic.
 * The tools are driven through the registry the runtime dispatches from, on a
 * fake store, a fake NPX, a fake Azul cancel and a fake contact source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CLASS_GATE_BUDGET_MS,
  CONFIRM_DOB_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  STAFF_CALLBACK_TOOL_NAME,
  outreachSessionFor,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
} from './npxOutreachTools';
import { npxOutreachPolicy } from '../agents/npxOutreachAgent';
import { callbackSessionFor, openCallbackSession } from './outboundTools';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { ContactSource, SourceRecheck } from '../runtime/outbound/campaign';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

const EXISTING_A = 'CAc8f701da3610e1dab706c5cd143f3b33';
const EXISTING_B = 'CAebe21a2eb3aacc6ad53778814a073f2f';
const NEW_PATIENT = 'CAb84bc43b14136b999ab72eab30f62ca7';
const DIALLED_SID = 'CA00000000000000000000000000000246';

const SLOT_A: NpxSlot = {
  slotId: 'slot-a', startAt: '2041-02-04T17:00:00.000Z', endAt: '2041-02-04T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-02-04', partnerOrgId: 'p1', partnerName: 'Partner One Optometry',
  clinicId: 'c1', clinicName: 'Clinic One', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};
const DATA = {
  source: 'console_movable',
  appointment_id: 'appt-0246',
  person_id: 'person-0246',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  event_name: 'Dilated Exam',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};

let store: FakeOutboundStore;
let npx: { availability: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn>; book: ReturnType<typeof vi.fn>; reportCancel: ReturnType<typeof vi.fn>; cancelBooking: ReturnType<typeof vi.fn> };
let npxDemo: typeof npx;
let cancel: ReturnType<typeof vi.fn>;
let recheck: ReturnType<typeof vi.fn>;
let sourceFn: ReturnType<typeof vi.fn>;

function fakeNpx() {
  return {
    availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A], truncated: false })),
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT_A] })),
    book: vi.fn(async () => ({ ok: true, bookingId: 'booking-246', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT_A })),
    reportCancel: vi.fn(async () => ({ ok: true })),
    cancelBooking: vi.fn(async () => ({ ok: true, outcome: 'cancelled' })),
  };
}

function sourceAnswering(answer: () => Promise<SourceRecheck>): ContactSource {
  recheck = vi.fn(answer);
  return { name: 'test movable list', refreshEveryMs: 60_000, parkMs: 60_000, list: async () => [], recheck: recheck as never };
}
const CURRENT = (): Promise<SourceRecheck> =>
  Promise.resolve({ state: 'current', contact: { externalRef: 'appt-0246', phone: '+15555550111', firstName: 'Testa', lastName: 'Synthetic', data: { ...DATA } } });

beforeEach(() => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'answered', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
  npx = fakeNpx();
  npxDemo = fakeNpx();
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  sourceFn = vi.fn(async () => sourceAnswering(CURRENT));
  setNpxOutreachDepsForTests({
    npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
    npxDemo: { configured: true, ...npxDemo } as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
    fileTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-90246' })) as never,
    source: sourceFn as never,
  });
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A returned call on `sid`, identified as the contact by first name. */
async function returnedCall(sid: string, campaignKey = 'npx-outreach') {
  openCallbackSession({
    callSid: sid,
    campaignKey,
    campaignId: store.campaignId,
    callerPhone: '+15555550111',
    candidates: [],
    candidatesLoaded: true,
    purpose: 'we called about their upcoming appointment.',
    store,
  });
  const inbound = await store.openCallbackAttempt('c1', store.campaignId, sid);
  const cb = callbackSessionFor(sid)!;
  cb.chosen = { contactId: 'c1', phone: '+15555550111', firstName: 'Testa', verifiedBy: 'first_name' };
  cb.attemptId = inbound;
  const args = { outbound_callback_sid: sid, outbound_campaign: campaignKey };
  return (name: string, extra: Record<string, unknown> = {}) =>
    getTool(name)!.handler({ ...args, ...extra }) as Promise<Record<string, unknown>>;
}

describe('a New or Lapsed patient who rings back is still offered and booked', () => {
  it(`${NEW_PATIENT}: re-checked once, current, offered, verified, searched and booked`, async () => {
    const call = await returnedCall(NEW_PATIENT);
    const d = await call(DESCRIBE_TOOL_NAME);
    expect(d).toMatchObject({ success: true, class_gate: 'current', appointment: 'a dilated eye exam on Wednesday, March 20' });
    expect(String(d.say)).toContain('We have availability sooner');
    expect(await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' })).toMatchObject({ verified: true });
    await call(FIND_SOONER_TOOL_NAME);
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ success: true, booked: true });
    expect(npx.book).toHaveBeenCalledTimes(1);
    // One Console read for the whole call, against the appointment it is about.
    expect(sourceFn).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck.mock.calls[0][0]).toBe('appt-0246');
  });
});

describe('an Existing patient who rings back is offered nothing and booked nothing', () => {
  beforeEach(() => {
    sourceFn.mockImplementation(async () => sourceAnswering(async () => ({ state: 'off_list' })));
  });

  it(`${EXISTING_A}: describe says the opening is not theirs and their appointment stays, and nothing about it`, async () => {
    const call = await returnedCall(EXISTING_A);
    const d = await call(DESCRIBE_TOOL_NAME);
    expect(d).toMatchObject({ success: false, error: 'not_offered', class_gate: 'off_list' });
    expect(String(d.say)).toContain("isn't one we can offer you after all");
    expect(String(d.say)).toContain('your appointment with us stays just as it is');
    // Not the visit, its date, the time, the office, the partner, or the offer.
    expect(JSON.stringify(d)).not.toMatch(/dilated|March 20|9:00|Test Office|Partner One|availability sooner/i);
    // The instruction is the model's, and names the staff callback.
    expect(String(d.fix)).toContain(STAFF_CALLBACK_TOOL_NAME);
    expect(String(d.fix)).toContain(FIND_SOONER_TOOL_NAME);
    expect(outreachSessionFor(EXISTING_A)!.described).toBe(false);
  });

  it(`${EXISTING_A}: the date of birth, the search and the booking all refuse after it`, async () => {
    const call = await returnedCall(EXISTING_A);
    await call(DESCRIBE_TOOL_NAME);
    for (const [name, args] of [
      [CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' }],
      [FIND_SOONER_TOOL_NAME, {}],
      [BOOK_SOONER_TOOL_NAME, { option: '1' }],
    ] as const) {
      expect(await call(name, args)).toMatchObject({ success: false, error: 'not_offered', class_gate: 'off_list' });
    }
    expect(outreachSessionFor(EXISTING_A)!.verified).toBe(false);
    expect(npx.book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(sourceFn).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it(`${EXISTING_B}: a model that skips describe is refused at the date of birth, the search and the booking`, async () => {
    const call = await returnedCall(EXISTING_B);
    expect(await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' })).toMatchObject({ error: 'not_offered' });
    expect(outreachSessionFor(EXISTING_B)!.dobTries).toBe(0);
    expect(await call(FIND_SOONER_TOOL_NAME)).toMatchObject({ error: 'not_offered' });
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'not_offered' });
    expect(npx.book).not.toHaveBeenCalled();
    expect(npx.availability).not.toHaveBeenCalled();
  });

  it(`${EXISTING_B}: a patient who was already verified is still refused at the search and the booking`, async () => {
    const call = await returnedCall(EXISTING_B);
    await call(DESCRIBE_TOOL_NAME);
    // A session verified some other way still meets the gate at every step.
    outreachSessionFor(EXISTING_B)!.verified = true;
    expect(await call(FIND_SOONER_TOOL_NAME)).toMatchObject({ error: 'not_offered' });
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'not_offered' });
    expect(npx.book).not.toHaveBeenCalled();
  });
});

describe('an appointment that is over, or a source that cannot answer, fails closed', () => {
  it('gone (cancelled, moved or past): the opening is no longer available, and nothing is said about their appointment staying', async () => {
    sourceFn.mockImplementation(async () => sourceAnswering(async () => ({ state: 'gone' })));
    const call = await returnedCall(EXISTING_A);
    const d = await call(DESCRIBE_TOOL_NAME);
    expect(d).toMatchObject({ error: 'not_offered', class_gate: 'gone' });
    expect(String(d.say)).toBe('Thank you for calling us back. The sooner opening we called about is no longer available.');
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'not_offered' });
    expect(npx.book).not.toHaveBeenCalled();
  });

  it('no source in this process: unavailable, nothing offered', async () => {
    sourceFn.mockImplementation(async () => null);
    const call = await returnedCall(NEW_PATIENT);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ error: 'not_offered' });
  });

  it('a re-check that throws: unavailable, nothing offered', async () => {
    sourceFn.mockImplementation(async () => sourceAnswering(async () => { throw new Error('console down'); }));
    const call = await returnedCall(NEW_PATIENT);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
  });

  it('a source that throws: unavailable, nothing offered', async () => {
    sourceFn.mockImplementation(async () => { throw new Error('no pool'); });
    const call = await returnedCall(NEW_PATIENT);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
  });

  it('a re-check that does not answer inside the budget: unavailable, and describe still answers inside its own timeout', async () => {
    vi.useFakeTimers();
    sourceFn.mockImplementation(async () => sourceAnswering(() => new Promise(() => undefined)));
    const call = await returnedCall(NEW_PATIENT);
    const pending = call(DESCRIBE_TOOL_NAME);
    await vi.advanceTimersByTimeAsync(CLASS_GATE_BUDGET_MS);
    expect(await pending).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
    expect(CLASS_GATE_BUDGET_MS).toBeLessThan(getTool(DESCRIBE_TOOL_NAME)!.timeoutMs!);
  });

  it('a contact with no appointment id cannot be re-checked: unavailable', async () => {
    store.addContact({ id: 'c1', phone: '+15555550111', status: 'answered', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA, appointment_id: '' } });
    const call = await returnedCall(NEW_PATIENT);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
    expect(sourceFn).not.toHaveBeenCalled();
  });

  it('nothing registered and nothing injected: the production default offers nothing', async () => {
    setNpxOutreachDepsForTests({
      npx: { configured: true, ...npx } as unknown as NpxOutreachClient,
      cancel: cancel as never,
      store: async () => store,
    });
    // npxOutreachAgent registered the lane's source on import; in live mode it
    // is the Console's movable list, which this process does not have.
    vi.stubEnv('OBS_CONSOLE_DATABASE_URL', '');
    const spy = vi.spyOn(npxOutreachPolicy, 'source');
    const call = await returnedCall(NEW_PATIENT);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ error: 'not_offered', class_gate: 'unavailable' });
    // The registered function is the lane's own source, the dialler's.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('what is not re-checked here', () => {
  it('a dialled call: the dial re-checked it seconds before; no second Console read', async () => {
    const attemptId = await store.startAttempt('c1', store.campaignId, 1);
    const run = (name: string, extra: Record<string, unknown> = {}) =>
      getTool(name)!.handler({
        outbound_contact_id: 'c1',
        outbound_attempt_id: attemptId,
        outbound_phone: '+15555550111',
        outbound_campaign: 'npx-outreach',
        outbound_call_sid: DIALLED_SID,
        ...extra,
      }) as Promise<Record<string, unknown>>;
    expect(await run(DESCRIBE_TOOL_NAME)).toMatchObject({ success: true, class_gate: 'at_dial' });
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await run(FIND_SOONER_TOOL_NAME);
    expect(await run(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ booked: true });
    expect(sourceFn).not.toHaveBeenCalled();
  });

  it('a demo returned call: synthetic patients, the demo NPX, no Console — not re-checked, still books', async () => {
    sourceFn.mockImplementation(async () => sourceAnswering(async () => ({ state: 'off_list' })));
    const call = await returnedCall(NEW_PATIENT, NPX_OUTREACH_DEMO_CAMPAIGN_KEY);
    expect(await call(DESCRIBE_TOOL_NAME)).toMatchObject({ success: true, class_gate: 'demo' });
    await call(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    await call(FIND_SOONER_TOOL_NAME);
    expect(await call(BOOK_SOONER_TOOL_NAME, { option: '1' })).toMatchObject({ booked: true });
    expect(npxDemo.book).toHaveBeenCalledTimes(1);
    expect(npx.book).not.toHaveBeenCalled();
    expect(sourceFn).not.toHaveBeenCalled();
  });
});

describe('the wiring', () => {
  it('npxOutreachAgent registers the lane policy\'s own source for returned calls', () => {
    const src = readFileSync(new URL('../agents/npxOutreachAgent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/useLaneSourceForReturnedCalls\(\(\) => npxOutreachPolicy\.source/);
  });
});
