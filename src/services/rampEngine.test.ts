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

  it('captures intent, collects caller/medical group, then continues on rails (records → fax)', async () => {
    seedLedger('p', { callerPhone: '+15551234567' });
    startRamp('p', 'professional');
    let s = await onCallerUtterance('p', 'I need records faxed for a mutual patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectCaller);
    s = await onCallerUtterance('p', 'This is Dana from Scripps Coastal Medical Group', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectFax);
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

describe('rampEngine — full rails (Answering Service end-to-end)', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('f'); });

  it('recognized: intent → confirm → DOB verify → message → callback confirm → file directive', async () => {
    seedLedger('f', { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '+18455317471' });
    startRamp('f', 'full_rails');
    let s = await onCallerUtterance('f', 'I need a medication refill', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmId('Wayne'));
    s = await onCallerUtterance('f', 'yes it is', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmDob);
    s = await onCallerUtterance('f', 'March 17th, 1973', verifyYes);
    expect(s.line).toBe(RAMP_LINES.verified('Wayne'));
    expect(s.status.state).toBe('TAKE_MESSAGE');
    s = await onCallerUtterance('f', 'I need latanoprost refilled at the Encinitas office', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmCallback('7471'));
    s = await onCallerUtterance('f', 'yes that works', verifyYes);
    expect(s.line).toContain('call create_ticket');
    expect(s.line).toContain('latanoprost');
    expect(rampActive('f')).toBe(false);
  });

  it('callback declined → collects a new number then files', async () => {
    seedLedger('f', { matchedFirstName: 'Ana', matchedLastName: 'Diaz', callerPhone: '+15551112222' });
    startRamp('f', 'full_rails');
    await onCallerUtterance('f', 'calling about my glasses order', verifyYes);
    await onCallerUtterance('f', 'yes', verifyYes);
    await onCallerUtterance('f', '5/10/1983', verifyYes);
    await onCallerUtterance('f', 'my glasses order status please', verifyYes);
    let s = await onCallerUtterance('f', 'no use my work line', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectCallback);
    s = await onCallerUtterance('f', 'sure, 760-555-9999', verifyYes);
    expect(s.line).toContain('call create_ticket');
    expect(getLedger('f')!.callbackNumber).toContain('7605559999');
  });

  it('failed verification still rails into message-taking, never dead-ends', async () => {
    seedLedger('f', { matchedFirstName: 'Luis', matchedLastName: 'Perez', callerPhone: '+15553334444' });
    startRamp('f', 'full_rails');
    await onCallerUtterance('f', 'checking on a bill', verifyNo);
    await onCallerUtterance('f', 'yes', verifyNo);
    await onCallerUtterance('f', '1/2/1970', verifyNo);
    await onCallerUtterance('f', 'Luis Perez', verifyNo);
    const s = await onCallerUtterance('f', '1/2/1970', verifyNo);
    expect(s.line).toBe(RAMP_LINES.verifyFail2Tickets);
    expect(s.status.state).toBe('TAKE_MESSAGE');
    const s2 = await onCallerUtterance('f', 'my billing question about the last visit', verifyNo);
    expect(s2.line).toBe(RAMP_LINES.confirmCallback('4444'));
  });
});

describe('rampEngine — PCP full rails (professional end-to-end)', () => {
  beforeEach(() => { clearAllLedgers(); releaseRamp('p2'); });

  it('records request → collect caller → fax number → file directive', async () => {
    seedLedger('p2', { callerPhone: '+17605551000' });
    startRamp('p2', 'professional');
    let s = await onCallerUtterance('p2', 'I need medical records for a mutual patient', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectCaller);
    s = await onCallerUtterance('p2', 'Dr. Perez from Scripps Coastal', verifyYes);
    expect(s.line).toBe(RAMP_LINES.collectFax);
    s = await onCallerUtterance('p2', 'fax it to 760-555-1234', verifyYes);
    expect(s.line).toContain('file this request');
    expect(getLedger('p2')!.faxNumber).toContain('7605551234');
    expect(rampActive('p2')).toBe(false);
  });

  it('scheduling request → immediate PCP queue transfer directive', async () => {
    seedLedger('p2', {});
    startRamp('p2', 'professional');
    await onCallerUtterance('p2', 'I want to schedule a patient for a screening', verifyYes);
    const s = await onCallerUtterance('p2', 'Maria at High Desert Medical Group', verifyYes);
    expect(s.line).toContain('handoff_to_pcp');
    expect(rampActive('p2')).toBe(false);
  });

  it('other request → callback confirm from caller-ID → PCP file directive', async () => {
    seedLedger('p2', { callerPhone: '+17605552000' });
    startRamp('p2', 'professional');
    await onCallerUtterance('p2', 'question about a referral status', verifyYes);
    let s = await onCallerUtterance('p2', 'front desk at Oceanside Family Practice', verifyYes);
    expect(s.line).toBe(RAMP_LINES.confirmCallback('2000'));
    s = await onCallerUtterance('p2', 'yes', verifyYes);
    expect(s.line).toContain("I'll make sure that gets to the right team");
  });
});
