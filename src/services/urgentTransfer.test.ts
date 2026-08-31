/**
 * Urgent transfer routing.
 *
 * The property that matters most is the boring one: this can never route an
 * urgent caller somewhere worse than the on-call number it replaced. Every
 * failure path — no rules engine, fenced location, timeout, thrown fetch —
 * has to land on on-call, because the alternative is a patient with sudden
 * vision loss being dialled into a dead line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveUrgentTransferTarget } from './urgentTransfer';

const ON_CALL = '+16262229400';
const OFFICE = '+18185551234';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.EYECARE_AGENT_API_KEY = 'test-key';
  process.env.EYECARE_BASE_URL = 'https://eyecare.test';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

/** The service wraps every response as {tool, result:{...}}. */
const mockRulesEngine = (result: unknown, ok = true) => {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    json: async () => ({ tool: 'sage_handoff', result }),
  })) as unknown as typeof fetch;
};

describe('the no-IVR agent never asks the clock', () => {
  // Operator, 2026-08-30: "calls are forwarded to the no ivr agent from our
  // phone system, we set the hours in the system and those calls are all
  // forwarded to the no ivr so we manage the schedule for when our phones are
  // on or off" — and separately, that it runs "after hours and weekends and
  // holidays, never during lunch".
  //
  // So a call arriving here has ALREADY been judged out-of-hours by the
  // schedule that actually governs. isBusinessHours() is a worse copy of that
  // schedule: hour and weekend only, no holidays, and no idea when the hours
  // are changed in Nextiva. Consulting it can only disagree with the system
  // that routed the call.
  const clockReadings = [
    ['a weekday mid-morning, the worst case (a holiday reads like this)', true],
    ['outside business hours, the ordinary case', false],
  ] as const;

  for (const [label, businessHours] of clockReadings) {
    it(`goes to on-call on ${label}`, async () => {
      const spy = vi.fn();
      globalThis.fetch = spy as unknown as typeof fetch;
      const t = await resolveUrgentTransferTarget({
        reason: 'sudden vision loss', businessHours, onCallNumber: ON_CALL, agentSlug: 'no-ivr',
      });
      expect(t).toEqual({ number: ON_CALL, source: 'on_call_after_hours' });
      // Never asked. An office queue is not a destination this agent can have.
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('still returns null when there is no on-call number to reach', async () => {
    expect(await resolveUrgentTransferTarget({
      reason: 'x', businessHours: true, onCallNumber: '', agentSlug: 'no-ivr',
    })).toBeNull();
  });
});

describe('after hours → on-call, by explicit operator decision', () => {
  it('does not even ask the rules engine outside business hours', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const t = await resolveUrgentTransferTarget({
      reason: 'sudden vision loss', businessHours: false, onCallNumber: ON_CALL, agentSlug: 'no-ivr',
    });
    // The office phones are not answered at 3am; routing there would put an
    // urgent caller into a voicemail box.
    expect(t).toEqual({ number: ON_CALL, source: 'on_call_after_hours' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the on-call phone is allow-listed to the after-hours agent', () => {
  // Operator directive 2026-08-06: "The only agent that is authorized to call
  // me is the no ivr agent that is used for after hours triage." Before this,
  // azul-scheduling rang that phone 7 times between 07-22 and 08-06, every one
  // DURING business hours, from the in-hours no-route fallback below — and
  // none of those callers was urgent.
  it('never hands the on-call number to azul, even when no office is found', async () => {
    mockRulesEngine({ method: 'callback', queueTeam: 'Encinitas' });
    const t = await resolveUrgentTransferTarget({
      reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'azul-scheduling',
    });
    expect(t).toBeNull();
  });

  it('never hands it to azul after hours either', async () => {
    const t = await resolveUrgentTransferTarget({
      reason: 'x', businessHours: false, onCallNumber: ON_CALL, agentSlug: 'azul-scheduling',
    });
    expect(t).toBeNull();
  });

  it('still routes azul to a real office queue when the rules engine names one', async () => {
    // The gate removes the personal phone, not the ability to transfer.
    mockRulesEngine({ method: 'cold_transfer', transferNumberE164: OFFICE, queueTeam: 'Encinitas Front' });
    const t = await resolveUrgentTransferTarget({
      reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'azul-scheduling',
    });
    expect(t).toEqual({ number: OFFICE, source: 'office_queue', queueLabel: 'Encinitas Front' });
  });

  it('denies an unknown or missing agent by default — allow-list, not deny-list', async () => {
    mockRulesEngine({ method: 'callback' });
    expect(await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'some-new-agent' })).toBeNull();
    expect(await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL })).toBeNull();
  });
});

describe('no rules-engine failure can produce a bogus transfer', () => {
  // These run as azul-scheduling, not no-IVR. no-IVR short-circuits above and
  // never reaches the rules engine, so asserting these against it would pass
  // without executing a line of the code they name — green for the wrong
  // reason, which is the failure mode `ticket-creation-lock.md` records.
  //
  // azul is not on the on-call allow-list, so its safe degradation is `null`:
  // the caller keeps whatever destination the handoff policy already chose,
  // and no failure here can invent a number.
  const azul = { onCallNumber: ON_CALL, agentSlug: 'azul-scheduling', businessHours: true } as const;

  it('degrades when the location is fenced out (no cold_transfer)', async () => {
    mockRulesEngine({ method: 'callback', queueTeam: 'Encinitas' });
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul })).toBeNull();
  });

  it('degrades on a non-200 from the rules engine', async () => {
    mockRulesEngine({}, false);
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul })).toBeNull();
  });

  it('degrades when the fetch throws or times out', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul })).toBeNull();
  });

  it('degrades on unparseable JSON', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul })).toBeNull();
  });

  it('degrades when the eyecare credentials are missing', async () => {
    delete process.env.EYECARE_AGENT_API_KEY;
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul })).toBeNull();
  });

  it('still routes azul to a real office queue when one is named', async () => {
    // The control: without it every assertion above would pass on a function
    // that returned null unconditionally.
    mockRulesEngine({ method: 'cold_transfer', transferNumberE164: OFFICE, queueTeam: 'Glendale Front' });
    expect(await resolveUrgentTransferTarget({ reason: 'x', ...azul }))
      .toEqual({ number: OFFICE, source: 'office_queue', queueLabel: 'Glendale Front' });
  });
});
