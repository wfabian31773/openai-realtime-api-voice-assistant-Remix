/**
 * The NPX outreach client (v110): the three calls, each failing closed, the
 * NPX error codes passed through, and nothing sent without a key. Synthetic
 * patients only; no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { createNpxOutreachClient, NPX_OUTREACH_DEFAULT_BASE_URL, NPX_TIMEOUT_MS } from './npxOutreachClient';

const ENV = { NPX_OUTREACH_API_KEY: 'test-key' };
const SLOT = {
  slotId: 's1', startAt: '2041-01-02T17:00:00.000Z', endAt: '2041-01-02T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-01-02', partnerOrgId: 'p1', partnerName: 'Partner One',
  clinicId: 'c1', clinicName: 'Clinic One', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};
const BOOK = {
  slotId: 's1', medicalGroupName: 'Test Group CAP',
  patient: { firstName: 'Testa', lastName: 'Synthetic', dateOfBirth: '1950-01-02', ngePersonId: 'person-1' },
  replacedAppointment: { ngeAppointmentId: 'appt-1', date: '2041-03-20' },
};

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('without a key', () => {
  it('sends nothing and says it is not configured', async () => {
    const f = vi.fn();
    const c = createNpxOutreachClient({}, f as never);
    expect(c.configured).toBe(false);
    expect(await c.offer({ medicalGroupName: 'x', partnerNames: ['y'], replacedAppointmentDate: '2041-01-01' })).toEqual({ ok: false, error: 'not_configured' });
    expect(await c.book(BOOK)).toMatchObject({ ok: false, error: 'not_configured' });
    expect(await c.reportCancel('b1', 'cancelled')).toEqual({ ok: false, error: 'not_configured' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('offer', () => {
  it('posts to the offer endpoint with the bearer key and hands back at most two slots', async () => {
    const f = reply(200, { ok: true, latestDay: '2041-02-27', count: 3, slots: [SLOT, SLOT, SLOT] });
    const r = await createNpxOutreachClient(ENV, f as never).offer({ medicalGroupName: 'Test Group CAP', partnerNames: ['Partner One'], replacedAppointmentDate: '2041-03-20' });
    expect(r).toEqual({ ok: true, latestDay: '2041-02-27', slots: [SLOT, SLOT] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${NPX_OUTREACH_DEFAULT_BASE_URL}/api/exchange/outreach/offer`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('is an answer, not an error, when nothing is soon enough', async () => {
    const r = await createNpxOutreachClient(ENV, reply(200, { ok: true, latestDay: '2041-02-27', count: 0, slots: [] }) as never).offer({ medicalGroupName: 'g', partnerNames: ['p'], replacedAppointmentDate: '2041-03-20' });
    expect(r).toEqual({ ok: true, latestDay: '2041-02-27', slots: [] });
  });

  it('passes NPX codes through and names the rest', async () => {
    const ask = { medicalGroupName: 'g', partnerNames: ['p'], replacedAppointmentDate: '2041-03-20' };
    const of = (status: number, body: unknown) => createNpxOutreachClient(ENV, reply(status, body) as never).offer(ask);
    expect(await of(422, { error: 'unknown_medical_group' })).toEqual({ ok: false, error: 'unknown_medical_group' });
    expect(await of(422, { error: 'no_partners' })).toEqual({ ok: false, error: 'no_partners' });
    expect(await of(401, { error: 'Unauthorized' })).toEqual({ ok: false, error: 'unauthorized' });
    expect(await of(429, { error: 'Rate limited' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await of(400, { error: 'Invalid request' })).toEqual({ ok: false, error: 'bad_request' });
    expect(await of(500, { error: 'Internal error' })).toEqual({ ok: false, error: 'server' });
  });

  it('times out instead of hanging, including on a body that never arrives', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
      }));
      const p = createNpxOutreachClient(ENV, f as never).offer({ medicalGroupName: 'g', partnerNames: ['p'], replacedAppointmentDate: '2041-03-20' });
      await vi.advanceTimersByTimeAsync(NPX_TIMEOUT_MS.offer + 1);
      expect(await p).toEqual({ ok: false, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a base URL override', async () => {
    const f = reply(200, { ok: true, latestDay: '', slots: [] });
    await createNpxOutreachClient({ ...ENV, NPX_OUTREACH_BASE_URL: 'https://npx.example.test/' }, f as never).offer({ medicalGroupName: 'g', partnerNames: ['p'], replacedAppointmentDate: '2041-03-20' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://npx.example.test/api/exchange/outreach/offer');
  });
});

describe('book', () => {
  it('returns the booking on 201 and on an already-booked 200', async () => {
    const created = await createNpxOutreachClient(ENV, reply(201, { ok: true, bookingId: 'b1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT }) as never).book(BOOK);
    expect(created).toEqual({ ok: true, bookingId: 'b1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT });
    const again = await createNpxOutreachClient(ENV, reply(200, { ok: true, bookingId: 'b1', alreadyBooked: true, slot: SLOT }) as never).book(BOOK);
    expect(again).toMatchObject({ ok: true, alreadyBooked: true });
  });

  it('carries NPX\'s next step on a refusal', async () => {
    expect(await createNpxOutreachClient(ENV, reply(409, { error: 'slot_unavailable', next: 'offer_again' }) as never).book(BOOK))
      .toEqual({ ok: false, error: 'slot_unavailable', next: 'offer_again' });
    expect(await createNpxOutreachClient(ENV, reply(409, { error: 'held_by_other_practice', next: 'hand_to_staff' }) as never).book(BOOK))
      .toEqual({ ok: false, error: 'held_by_other_practice', next: 'hand_to_staff' });
  });

  it('never logs the patient it sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createNpxOutreachClient(ENV, reply(500, { error: 'Internal error' }) as never).book(BOOK);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toMatch(/Testa|Synthetic|1950/);
    warn.mockRestore();
  });
});

describe('cancel report', () => {
  it('reports cancelled, and failed with a short code only', async () => {
    const f = reply(200, { ok: true });
    const c = createNpxOutreachClient(ENV, f as never);
    expect(await c.reportCancel('b1', 'cancelled')).toEqual({ ok: true });
    expect(await c.reportCancel('b1', { failed: 'nextgen_timeout' })).toEqual({ ok: true });
    await c.reportCancel('b1', { failed: 'Free text with a Name in it' });
    const bodies = f.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies).toEqual([
      { outcome: 'cancelled' },
      { outcome: 'failed', reason: 'nextgen_timeout' },
      { outcome: 'failed', reason: 'unspecified' },
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${NPX_OUTREACH_DEFAULT_BASE_URL}/api/exchange/outreach/bookings/b1`);
    expect(init.method).toBe('PATCH');
  });
});
