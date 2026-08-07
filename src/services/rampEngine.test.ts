import { describe, it, expect, beforeEach } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from './callFactsLedger';
import { startRamp, onCallerUtterance, rampActive, releaseRamp, RAMP_LINES } from './rampEngine';

const verifyYes = async () => true;
const verifyNo = async () => false;

describe('rampEngine — approved scripts S1-S5', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('c'); });

  it('S1 happy path: matched → yes → DOB → verified, identity locked', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    let s = await onCallerUtterance('c', 'yes this is she', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmDob);
    s = await onCallerUtterance('c', 'May 10 1983', verifyYes);
    expect(s.line).toBe(RAMP_LINES.verified('Maria'));
    expect(getLedger('c')!.identityVerified).toBe(true);
    expect(rampActive('c')).toBe(false);
  });

  it('S2: matched but "no" → classify → existing → collect name/DOB', async () => {
    seedLedger('c', { matchedFirstName: 'Maria' });
    startRamp('c');
    let s = await onCallerUtterance('c', 'no, calling for my mother', verifyYes);
    expect(s.line).toBe(RAMP_LINES.classify);
    s = await onCallerUtterance('c', 'she is an existing patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectName);
    s = await onCallerUtterance('c', 'Rosa Alvarez', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectDob);
  });

  it('S3/S4: unmatched → new patient → details flow, no verification gate', async () => {
    seedLedger('c', {});
    startRamp('c');
    let s = await onCallerUtterance('c', 'brand new patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.newPatientTickets);
    s = await onCallerUtterance('c', 'John Smith', verifyYes);
    s = await onCallerUtterance('c', '3/4/1990', verifyYes);
    expect(s.status.state).toBe('DONE_MESSAGE');
  });

  it('S5: two verification failures → no third attempt, message exit', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    await onCallerUtterance('c', 'yes', verifyNo);
    let s = await onCallerUtterance('c', '5/10/1983', verifyNo);
    expect(s.line).toBe(RAMP_LINES.verifyFail1);
    s = await onCallerUtterance('c', 'Maria Gonzalez', verifyNo);
    s = await onCallerUtterance('c', '5/10/1983', verifyNo);
    expect(s.line).toBe(RAMP_LINES.verifyFail2Tickets);
    expect(rampActive('c')).toBe(false);
  });

  it('urgency disengages instantly to model + guardrails', async () => {
    seedLedger('c', { matchedFirstName: 'M' });
    startRamp('c');
    const s = await onCallerUtterance('c', 'this is an emergency, chest pain', verifyYes);
    expect(s.status.state).toBe('DISENGAGED');
    expect(s.line).toBeNull();
  });

  it('two unparsable answers disengage — the ramp never traps a caller', async () => {
    seedLedger('c', { matchedFirstName: 'M' });
    startRamp('c');
    await onCallerUtterance('c', 'banana rocket ship', verifyYes);
    const s = await onCallerUtterance('c', 'purple monkey dishwasher', verifyYes);
    expect(s.status.state).toBe('DISENGAGED');
  });

  it('verify lookup error follows the fail ladder, never crashes the ramp', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    await onCallerUtterance('c', 'yes', verifyYes);
    const s = await onCallerUtterance('c', '5/10/1983', async () => { throw new Error('db down'); });
    expect(s.line).toBe(RAMP_LINES.verifyFail1);
  });
});
