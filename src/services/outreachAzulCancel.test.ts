/**
 * The outreach cancel (v110): the Azul appointment is cancelled only when it
 * still belongs to the person the call was about, on the date offered, and a
 * reason is configured; every refusal is a short code NPX accepts. Synthetic
 * ids only; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAzulAppointment, AZUL_CANCEL_DEADLINE_MS, AZUL_CANCEL_MIN_STEP_MS } from './outreachAzulCancel';
import { NPX_REASON_CODE } from './npxOutreachClient';

const ENV = { EYECARE_AGENT_API_KEY: 'k', OUTREACH_CANCEL_REASON: 'Seen Elsewhere' };
const REQ = {
  appointmentId: 'aaaaaaaa-0000-0000-0000-000000000001',
  personId: 'bbbbbbbb-0000-0000-0000-000000000001',
  appointmentDate: '2041-03-20',
  comment: 'Moved to an NPX partner by the outreach call',
};
const DETAILS = { personId: REQ.personId, appointmentDate: '2041-03-20T09:00:00', isCancelled: false, isPseudoPatient: false };
const REASONS = { reasons: [{ id: 'r-patient', name: 'Patient Cancelled Not Rescheduled' }, { id: 'r-elsewhere', name: 'Seen Elsewhere' }] };

/** A fake scheduling service: one reply per tool name, recorded calls. */
function service(replies: Record<string, unknown>, status: Record<string, number> = {}) {
  const calls: Array<{ name: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const name = decodeURIComponent(url.split('/api/tools/')[1]);
    calls.push({ name, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ tool: name, result: replies[name] ?? {} }), { status: status[name] ?? 200 });
  });
  return { f: f as never, calls };
}

describe('cancels when everything matches', () => {
  it('reads the appointment, picks the configured reason by its whole name, then cancels', async () => {
    const s = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
    expect(await cancelAzulAppointment(REQ, ENV, s.f)).toEqual({ cancelled: true, alreadyCancelled: false });
    expect(s.calls.map((c) => c.name)).toEqual(['get_appointment_details', 'list_cancel_reasons', 'cancel_appointment']);
    expect(s.calls[2].body).toEqual({ appointmentId: REQ.appointmentId, cancelReasonId: 'r-elsewhere', comment: REQ.comment });
  });

  it('never sends the pilot fence or the zero-id header, and gives the service a deadline', async () => {
    const s = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
    await cancelAzulAppointment(REQ, ENV, s.f);
    for (const c of s.calls) {
      expect(c.headers['X-Pilot-Fence']).toBeUndefined();
      expect(c.headers['X-Zero-Id']).toBeUndefined();
      expect(c.headers['X-Deadline-Ms']).toBe(String(AZUL_CANCEL_DEADLINE_MS));
      expect(c.headers.Authorization).toBe('Bearer k');
    }
  });

  it('counts an appointment already cancelled as cancelled, without cancelling it again', async () => {
    const s = service({ get_appointment_details: { ...DETAILS, isCancelled: true } });
    expect(await cancelAzulAppointment(REQ, ENV, s.f)).toEqual({ cancelled: true, alreadyCancelled: true });
    expect(s.calls.map((c) => c.name)).toEqual(['get_appointment_details']);
  });
});

describe('refuses rather than cancel the wrong thing', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['another person\'s appointment', { ...DETAILS, personId: 'cccccccc-0000-0000-0000-000000000001' }, 'person_mismatch'],
    ['an appointment on another date', { ...DETAILS, appointmentDate: '2041-03-27T09:00:00' }, 'appointment_moved'],
    ['a schedule block', { ...DETAILS, isPseudoPatient: true }, 'schedule_block'],
    ['an appointment NextGen does not have', { notFound: true }, 'appointment_not_found'],
  ];
  for (const [label, details, reason] of cases) {
    it(label, async () => {
      const s = service({ get_appointment_details: details, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
      expect(await cancelAzulAppointment(REQ, ENV, s.f)).toEqual({ cancelled: false, reason });
      expect(s.calls.map((c) => c.name)).not.toContain('cancel_appointment');
    });
  }

  it('matches the person id whatever its case', async () => {
    const s = service({ get_appointment_details: { ...DETAILS, personId: REQ.personId.toUpperCase() }, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
    expect(await cancelAzulAppointment(REQ, ENV, s.f)).toEqual({ cancelled: true, alreadyCancelled: false });
  });
});

describe('refuses when it is not set up', () => {
  it('with no scheduling key, or no reason configured, sends nothing', async () => {
    const s = service({});
    expect(await cancelAzulAppointment(REQ, { OUTREACH_CANCEL_REASON: 'Seen Elsewhere' }, s.f)).toEqual({ cancelled: false, reason: 'scheduling_not_configured' });
    expect(await cancelAzulAppointment(REQ, { EYECARE_AGENT_API_KEY: 'k' }, s.f)).toEqual({ cancelled: false, reason: 'cancel_reason_not_configured' });
    expect(s.calls).toEqual([]);
  });

  it('when the configured reason is not a NextGen reason — never a fuzzy pick', async () => {
    const s = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS });
    expect(await cancelAzulAppointment(REQ, { ...ENV, OUTREACH_CANCEL_REASON: 'Seen' }, s.f)).toEqual({ cancelled: false, reason: 'cancel_reason_not_found' });
    expect(s.calls.map((c) => c.name)).not.toContain('cancel_appointment');
  });
});

describe('a slow or failing service', () => {
  it('reports a service timeout and a refused cancel by name', async () => {
    const slow = service({}, { get_appointment_details: 504 });
    expect(await cancelAzulAppointment(REQ, ENV, slow.f)).toEqual({ cancelled: false, reason: 'nextgen_timeout' });
    const bad = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: false, error: 'x' } });
    expect(await cancelAzulAppointment(REQ, ENV, bad.f)).toEqual({ cancelled: false, reason: 'nextgen_cancel_failed' });
  });

  it('every refusal is a code NPX accepts as a cancel-report reason', () => {
    for (const r of ['scheduling_not_configured', 'cancel_reason_not_configured', 'cancel_reason_not_found', 'appointment_not_found', 'person_mismatch', 'appointment_moved', 'schedule_block', 'nextgen_timeout', 'nextgen_cancel_failed']) {
      expect(NPX_REASON_CODE.test(r), r).toBe(true);
    }
  });
});

describe('a deadline from the caller (Codex P1, #361: the booking answers inside its own budget)', () => {
  afterEach(() => vi.useRealTimers());

  it('starts nothing when too little is left, and says so as a timeout', async () => {
    const s = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
    const r = await cancelAzulAppointment({ ...REQ, deadlineAt: Date.now() + AZUL_CANCEL_MIN_STEP_MS - 1 }, ENV, s.f);
    expect(r).toEqual({ cancelled: false, reason: 'nextgen_timeout' });
    expect(s.calls).toEqual([]);
  });

  it('tells the service only what is left, never the full ten seconds', async () => {
    const s = service({ get_appointment_details: DETAILS, list_cancel_reasons: REASONS, cancel_appointment: { cancelled: true } });
    await cancelAzulAppointment({ ...REQ, deadlineAt: Date.now() + 6_000 }, ENV, s.f);
    for (const c of s.calls) expect(Number(c.headers['X-Deadline-Ms'])).toBeLessThanOrEqual(4_000);
  });

  it('does not start the next step once the time is spent — the cancel itself is never begun late', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      const name = decodeURIComponent(url.split('/api/tools/')[1]);
      calls.push(name);
      vi.advanceTimersByTime(2_500); // the read-back was slow
      const result = name === 'get_appointment_details' ? DETAILS : REASONS;
      return new Response(JSON.stringify({ tool: name, result }), { status: 200 });
    });
    const r = await cancelAzulAppointment({ ...REQ, deadlineAt: Date.now() + 5_000 }, ENV, f as never);
    expect(r).toEqual({ cancelled: false, reason: 'nextgen_timeout' });
    expect(calls).toEqual(['get_appointment_details']);
  });

  it('stops waiting for a hung step at the deadline, not twelve seconds later', async () => {
    vi.useFakeTimers();
    const f = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    const pending = cancelAzulAppointment({ ...REQ, deadlineAt: Date.now() + 4_000 }, ENV, f as never);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toEqual({ cancelled: false, reason: 'nextgen_timeout' });
  });
});
