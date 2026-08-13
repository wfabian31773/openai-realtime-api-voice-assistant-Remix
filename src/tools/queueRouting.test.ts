/**
 * Nobody gets told to call back.
 *
 * Operator ruling 2026-08-13: these queues are forwarded, so a patient who
 * pressed the medication option with an optical question must not be sent away
 * to dial again. Scheduling goes to the HVA Hub from every queue.
 *
 * The opposite failure matters just as much. A detector that fires on a keyword
 * would take a medication call OFF the medication line because the caller
 * mentioned their surgery, and the line that rang is better evidence than a
 * word. Half of these tests are about staying silent.
 */
import { describe, it, expect } from 'vitest';
import { detectCrossQueue } from './queueRouting';

const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HVA = 9;

describe('scheduling goes to the HVA Hub from every queue', () => {
  const lines: Array<[number, string]> = [
    [TECH, 'I need to schedule an eye exam'],
    [OPTICAL, 'can I make an appointment for next week'],
    [SURGERY, 'I need to reschedule my appointment'],
    [TECH, 'cancel my appointment please'],
    [OPTICAL, 'do you have any openings sooner'],
    [TECH, 'quiero hacer una cita'],
  ];

  for (const [home, text] of lines) {
    it(`from department ${home}: "${text.slice(0, 40)}…"`, () => {
      const r = detectCrossQueue(text, home);
      expect(r?.departmentId, text).toBe(HVA);
      expect(r?.requestTypeId).toBe(32); // Appointment Request — the live type
    });
  }

  it('picks the reason the words earned', () => {
    expect(detectCrossQueue('I need to reschedule my appointment', TECH)?.requestReasonId).toBe(147);
    expect(detectCrossQueue('cancel my appointment', TECH)?.requestReasonId).toBe(148);
    expect(detectCrossQueue('can I be seen today', TECH)?.requestReasonId).toBe(151);
    expect(detectCrossQueue('I need to schedule an appointment', TECH)?.requestReasonId).toBe(146);
  });

  it('does not redirect a Hub call to the Hub', () => {
    expect(detectCrossQueue('I need to reschedule my appointment', HVA)).toBeNull();
  });

  it('leaves a SURGERY date change with Surgery', () => {
    // The operator created reason 531, Reschedule / Cancel Surgery, for
    // department 2 earlier the same day. Appointments go to the Hub;
    // operations stay with the coordinators.
    expect(detectCrossQueue('I need to reschedule my surgery', SURGERY)).toBeNull();
    expect(detectCrossQueue('please cancel my surgery on the 10th', SURGERY)).toBeNull();
  });
});

describe('the operator\'s example: optical question on the medication line', () => {
  it('routes glasses from Tech Support to Optical', () => {
    const r = detectCrossQueue('my glasses broke at the hinge', TECH);
    expect(r?.departmentId).toBe(OPTICAL);
    expect(r?.requestTypeId).toBe(66);
    expect(r?.requestReasonId).toBe(536);
    expect(r?.note).toMatch(/routed here/i);
  });

  it('routes frames from Surgery to Optical', () => {
    expect(detectCrossQueue('I want to pick out new frames', SURGERY)?.departmentId).toBe(OPTICAL);
  });

  it('does not route an optical call away from Optical', () => {
    expect(detectCrossQueue('my glasses broke', OPTICAL)).toBeNull();
  });
});

describe('it stays silent when the line that rang is already right', () => {
  it('keeps a medication call on the medication line', () => {
    expect(detectCrossQueue('I need a refill of my Latanoprost', TECH)).toBeNull();
    expect(detectCrossQueue('my pharmacy never got the prescription', TECH)).toBeNull();
  });

  it('keeps post-surgery drops on the medication line', () => {
    // Mentions a surgery, but it is a prescription request and it arrived on
    // the prescription line. A keyword-happy detector would move it.
    expect(detectCrossQueue('refill the drops for my cataract surgery', TECH)).toBeNull();
  });

  it('keeps a surgery logistics call with Surgery', () => {
    expect(detectCrossQueue('my surgery is Monday and the drops never came', SURGERY)).toBeNull();
    expect(detectCrossQueue('what time should I arrive for my surgery', SURGERY)).toBeNull();
  });

  it('keeps a contact lens PRESCRIPTION with Tech Support', () => {
    // 157 is a Tech Support reason. The eyewear itself is Optical; the
    // prescription for it is not.
    expect(detectCrossQueue('I need to renew my contact lens prescription', TECH)).toBeNull();
  });

  it('says nothing about an empty or unremarkable request', () => {
    expect(detectCrossQueue('', TECH)).toBeNull();
    expect(detectCrossQueue('   ', TECH)).toBeNull();
    expect(detectCrossQueue('I have a question', TECH)).toBeNull();
  });
});

describe('medication and surgery calls reaching the optical line', () => {
  it('routes a refill from Optical to Tech Support', () => {
    const r = detectCrossQueue('I need a refill on my eye drops', OPTICAL);
    expect(r?.departmentId).toBe(TECH);
    expect(r?.requestReasonId).toBe(542);
  });

  it('routes a surgery question from Optical to Surgery', () => {
    expect(detectCrossQueue('a question about my cataract surgery', OPTICAL)?.departmentId).toBe(SURGERY);
  });
});
