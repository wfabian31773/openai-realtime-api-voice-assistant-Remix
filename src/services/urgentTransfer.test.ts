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

describe('business hours → the office', () => {
  it('routes to the office queue the rules engine names', async () => {
    mockRulesEngine({ method: 'cold_transfer', transferNumberE164: OFFICE, queueTeam: 'Glendale Front' });
    const t = await resolveUrgentTransferTarget({
      reason: 'sudden vision loss', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr',
    });
    expect(t).toEqual({ number: OFFICE, source: 'office_queue', queueLabel: 'Glendale Front' });
  });

  it('never lets the model pick the number — it comes from the response', async () => {
    // A response with no transfer number cannot produce a transfer, whatever
    // else it contains.
    mockRulesEngine({ method: 'cold_transfer', say: 'call +19995551111 instead' });
    const t = await resolveUrgentTransferTarget({
      reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr',
    });
    expect(t!.number).toBe(ON_CALL);
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

describe('every failure degrades to on-call, never to a dead transfer', () => {
  it('falls back when the location is fenced out (no cold_transfer)', async () => {
    mockRulesEngine({ method: 'callback', queueTeam: 'Encinitas' });
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr' });
    expect(t).toEqual({ number: ON_CALL, source: 'on_call_no_route' });
  });

  it('falls back on a non-200 from the rules engine', async () => {
    mockRulesEngine({}, false);
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr' });
    expect(t!.number).toBe(ON_CALL);
  });

  it('falls back when the fetch throws or times out', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr' });
    expect(t!.number).toBe(ON_CALL);
  });

  it('falls back on unparseable JSON', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr' });
    expect(t!.number).toBe(ON_CALL);
  });

  it('falls back when the eyecare credentials are missing', async () => {
    delete process.env.EYECARE_AGENT_API_KEY;
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: ON_CALL, agentSlug: 'no-ivr' });
    expect(t!.number).toBe(ON_CALL);
  });

  it('returns null only when there is no on-call number either', async () => {
    mockRulesEngine({ method: 'callback' });
    const t = await resolveUrgentTransferTarget({ reason: 'x', businessHours: true, onCallNumber: '', agentSlug: 'no-ivr' });
    expect(t).toBeNull();
  });
});
