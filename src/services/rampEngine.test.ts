import { describe, it, expect, beforeEach } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from './callFactsLedger';
import { startRamp, onCallerUtterance, rampActive, releaseRamp, RAMP_LINES } from './rampEngine';

const verifyYes = async () => true;
const verifyNo = async () => false;

describe('rampEngine — approved scripts S1-S5', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('c'); });

  it('S1 happy path: intent → confirm → yes → DOB → verified, identity locked', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    let s = await onCallerUtterance('c', 'I need to check on my refill', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmId('Maria'));
    s = await onCallerUtterance('c', 'yes this is she', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmDob);
    s = await onCallerUtterance('c', 'May 10 1983', verifyYes);
    expect(s.line).toBe(RAMP_LINES.verified('Maria'));
    expect(getLedger('c')!.identityVerified).toBe(true);
    expect(rampActive('c')).toBe(false);
  });

  it('S2: matched but "no" → classify → existing → collect name/DOB', async () => {
    seedLedger('c', { matchedFirstName: 'Maria' });
    startRamp('c');
    let s = await onCallerUtterance('c', 'calling about an appointment', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmId('Maria'));
    s = await onCallerUtterance('c', 'no, calling for my mother', verifyYes);
    expect(s.line).toBe(RAMP_LINES.classify);
    s = await onCallerUtterance('c', 'she is an existing patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectName);
    s = await onCallerUtterance('c', 'Rosa Alvarez', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectDob);
  });

  it('S3/S4: unmatched → intent → classify → new patient details, no verification gate', async () => {
    seedLedger('c', {});
    startRamp('c');
    let s = await onCallerUtterance('c', 'I want to make an appointment', verifyYes);
    expect(s.line).toBe(RAMP_LINES.classify);
    s = await onCallerUtterance('c', 'brand new patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.newPatientTickets);
    s = await onCallerUtterance('c', 'John Smith', verifyYes);
    s = await onCallerUtterance('c', '3/4/1990', verifyYes);
    expect(s.status.state).toBe('DONE_MESSAGE');
  });

  it('S5: two verification failures → no third attempt, message exit', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    await onCallerUtterance('c', 'checking on my glasses order', verifyNo);
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

  it('first unparsable answer RE-ASKS the question forced; second disengages', async () => {
    seedLedger('c', { matchedFirstName: 'Maria' });
    startRamp('c');
    await onCallerUtterance('c', 'calling about my appointment', verifyYes); // → CONFIRM_ID
    let s = await onCallerUtterance('c', 'uh', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmId('Maria')); // rigidity: re-ask, not silence
    s = await onCallerUtterance('c', 'hm', verifyYes);
    expect(s.status.state).toBe('DISENGAGED');
  });

  it('verify lookup error follows the fail ladder, never crashes the ramp', async () => {
    seedLedger('c', { matchedFirstName: 'Maria', matchedLastName: 'Lopez' });
    startRamp('c');
    await onCallerUtterance('c', 'need to reschedule something', verifyYes);
    await onCallerUtterance('c', 'yes', verifyYes);
    const s = await onCallerUtterance('c', '5/10/1983', async () => { throw new Error('db down'); });
    expect(s.line).toBe(RAMP_LINES.verifyFail1);
  });
});

describe('rampEngine — PCP professional mode (S §3)', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('p'); });

  it('captures intent, collects caller/medical group, then exits to the model', async () => {
    seedLedger('p', { callerPhone: '+15551234567' });
    startRamp('p', 'professional');
    let s = await onCallerUtterance('p', 'I need records faxed for a mutual patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectCaller);
    s = await onCallerUtterance('p', 'This is Dana from Scripps Coastal Medical Group', verifyYes);
    expect(s.line).toBeNull();
    expect(rampActive('p')).toBe(false);
    const f = getLedger('p')!;
    expect(f.intent).toContain('records faxed');
    expect(f.medicalGroup).toContain('Scripps Coastal');
  });
});

describe('rampEngine — SD front mode (CP-6)', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('s'); });

  it('confirm yes → forced DOB ask → hands DOB answer to the verify tool flow', async () => {
    seedLedger('s', { matchedFirstName: 'Wayne', matchedLastName: 'Fabian' });
    startRamp('s', 'sd_front');
    let st = await onCallerUtterance('s', 'yes speaking', verifyYes);
    expect(st.line).toBe(RAMP_LINES.confirmDob);
    st = await onCallerUtterance('s', 'June 4th 1975', verifyYes);
    expect(st.line).toBeNull();
    expect(rampActive('s')).toBe(false);
  });

  it('new patient on SD gets the exact approved transfer script', async () => {
    seedLedger('s', {});
    startRamp('s', 'sd_front');
    const st = await onCallerUtterance('s', 'I would be a new patient', verifyYes);
    expect(st.line).toContain('unable to schedule new patients');
    expect(rampActive('s')).toBe(false);
  });
});
