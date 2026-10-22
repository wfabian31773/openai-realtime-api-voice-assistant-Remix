import { describe, it, expect } from 'vitest';
import { directionFor, withToolDirection, releaseDirectionState, acknowledgeDayMismatch, MEDICATION_GATE_REFUSAL } from './toolDirection';

describe('toolDirection', () => {
  it('appends the approved filed line on ticket success (answering service)', async () => {
    const exec = withToolDirection('answering-service', 'call1', 'create_ticket', async () => 'VA-1700000000000-456');
    const out = (await exec()) as string;
    expect(out).toContain('VA-1700000000000-456');
    expect(out).toContain("You're all set");
  });

  it('first error directs a silent retry; second error directs the noted line', () => {
    releaseDirectionState('call2');
    const d1 = directionFor('answering-service', 'create_ticket', 'ERROR: timeout', 'call2')!;
    expect(d1).toContain('Silently call create_ticket again ONCE');
    const d2 = directionFor('answering-service', 'create_ticket', 'ERROR: timeout', 'call2')!;
    expect(d2).toContain("I've noted everything");
  });

  it('success resets the attempt counter', () => {
    releaseDirectionState('call3');
    directionFor('pcp', 'create_ticket', 'ERROR: x', 'call3');
    directionFor('pcp', 'create_ticket', 'VA-1', 'call3');
    const d = directionFor('pcp', 'create_ticket', 'ERROR: y', 'call3')!;
    expect(d).toContain('Silently');
  });

  it('unknown tools pass through untouched', async () => {
    const exec = withToolDirection('pcp', 'c', 'lookup_location', async () => '{"city":"Encinitas"}');
    expect(await exec()).toBe('{"city":"Encinitas"}');
  });

  it('pcp success uses the office follow-up line', () => {
    const d = directionFor('pcp', 'create_ticket', 'VA-2', 'call4')!;
    expect(d).toContain('follow up with your office');
  });
});

describe('acknowledgeDayMismatch — S6', () => {
  const say = (t: string) => JSON.stringify({ result: { say: t, options: 2 } });

  it('prefixes the admission when the offer is on a different day', () => {
    const out = acknowledgeDayMismatch(say('I have Wednesday, August 12 at 1:40 PM with Dr. Kim.'), '2026-08-11');
    expect(JSON.parse(out).result.say).toMatch(/^I don't have anything on Tuesday — the closest I have is:/);
  });

  it('leaves matching-day offers untouched', () => {
    const raw = say('I have Tuesday, August 11 at 3:10 PM with Dr. Kim.');
    expect(acknowledgeDayMismatch(raw, '2026-08-11')).toBe(raw);
  });

  it('leaves no-availability messages and malformed results untouched', () => {
    const raw = say('I have no openings for that visit type right now.');
    expect(acknowledgeDayMismatch(raw, '2026-08-11')).toBe(raw);
    expect(acknowledgeDayMismatch('not json', '2026-08-11')).toBe('not json');
  });
});

describe('gateBeforeExecution — no abrupt endings (PCP)', () => {
  it('blocks terminate_call while medical group or fax number is missing', async () => {
    const { seedLedger, clearAllLedgers } = await import('./callFactsLedger');
    clearAllLedgers();
    seedLedger('g1', { contactMethod: 'fax' });
    let executed = false;
    const exec = withToolDirection('pcp', 'g1', 'terminate_call', async () => { executed = true; return 'ended'; });
    const out = (await exec()) as string;
    expect(executed).toBe(false);
    expect(out).toContain('NOT DONE YET');
    expect(out).toContain('FAX number');
  });

  it('allows terminate_call once required slots are filled', async () => {
    const { seedLedger, clearAllLedgers } = await import('./callFactsLedger');
    clearAllLedgers();
    seedLedger('g2', { medicalGroup: 'Scripps Coastal', contactMethod: 'fax', faxNumber: '760-555-1234' });
    const exec = withToolDirection('pcp', 'g2', 'terminate_call', async () => 'ended');
    expect(await exec()).toBe('ended');
  });
});

describe('the medication gate asks once (v112)', () => {
  const refill = { request_category: 'medication_refill', request_summary: 'Refill of Betoptic drops.' };

  it('refuses once per call, then lets the filing through', async () => {
    releaseDirectionState('m1');
    let ran = 0;
    const exec = withToolDirection('no-ivr', 'm1', 'create_ticket', async (_a?: unknown) => { ran++; return 'VA-1'; });
    expect(await exec(refill)).toBe(MEDICATION_GATE_REFUSAL);
    expect(ran).toBe(0);
    expect(String(await exec(refill))).toContain('VA-1');
    expect(String(await exec(refill))).toContain('VA-1');
    expect(ran).toBe(2);
  });

  it('a call with no id is never refused — it cannot be counted, so it cannot be bounded', async () => {
    let ran = 0;
    const exec = withToolDirection('no-ivr', undefined, 'create_ticket', async (_a?: unknown) => { ran++; return 'VA-2'; });
    await exec(refill);
    expect(ran).toBe(1);
  });

  it('releasing the call asks again', async () => {
    releaseDirectionState('m2');
    const exec = withToolDirection('no-ivr', 'm2', 'create_ticket', async (_a?: unknown) => 'VA-3');
    expect(await exec(refill)).toBe(MEDICATION_GATE_REFUSAL);
    releaseDirectionState('m2');
    expect(await exec(refill)).toBe(MEDICATION_GATE_REFUSAL);
  });

  it('hands the refusal to the recorder, and a recorder that throws changes nothing', async () => {
    releaseDirectionState('m3');
    const seen: Array<Record<string, unknown>> = [];
    const exec = withToolDirection('no-ivr', 'm3', 'create_ticket', async (_a?: unknown) => 'VA-4', {
      recordRefusal: (_a, outcome) => { seen.push(outcome); throw new Error('telemetry down'); },
    });
    expect(await exec(refill)).toBe(MEDICATION_GATE_REFUSAL);
    expect(seen).toEqual([{ success: false, refused: 'medication_name', missingFields: ['medication'] }]);
  });

  it('a terminate_call refusal is not recorded as a medication refusal', async () => {
    const { seedLedger, clearAllLedgers } = await import('./callFactsLedger');
    clearAllLedgers();
    seedLedger('m4', { contactMethod: 'fax' });
    const seen: unknown[] = [];
    const exec = withToolDirection('pcp', 'm4', 'terminate_call', async () => 'ended', { recordRefusal: (a) => seen.push(a) });
    expect(String(await exec())).toContain('NOT DONE YET');
    expect(seen).toHaveLength(0);
  });

  it('the count is capped, oldest call first', async () => {
    for (let i = 0; i < 1001; i++) {
      await withToolDirection('no-ivr', `cap-${i}`, 'create_ticket', async (_a?: unknown) => 'VA')(refill);
    }
    // cap-0 was evicted, so it is asked again; cap-1000 is still counted.
    expect(await withToolDirection('no-ivr', 'cap-0', 'create_ticket', async (_a?: unknown) => 'VA')(refill)).toBe(MEDICATION_GATE_REFUSAL);
    expect(await withToolDirection('no-ivr', 'cap-1000', 'create_ticket', async (_a?: unknown) => 'VA-ok')(refill)).not.toBe(MEDICATION_GATE_REFUSAL);
  });
});
