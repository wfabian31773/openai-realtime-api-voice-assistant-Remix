import { describe, it, expect } from 'vitest';
import { PcpDirector } from './director';

/**
 * Live call 2026-08-09: a Scripps Surgery Center nurse said "I need to speak
 * with someone about one of our patients" and was interviewed about her role
 * and her reason before the line would even attempt a transfer — because the
 * director required a classified purpose and complete intake first.
 */
describe('PCP director — an explicit ask for a person', () => {
  it('is handoff-eligible with no purpose and no intake collected', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    expect(d.next('c1').handoffEligible).toBe(false); // nothing known yet
    d.markCallerRequestedHuman('c1');
    const after = d.next('c1');
    expect(after.handoffEligible).toBe(true);
    expect(after.disposition).toBe('HAND_OFF');
  });

  it('still defers to the lunch closure — nobody is at the desk', () => {
    const d = new PcpDirector({ lunchClosure: () => true });
    d.markCallerRequestedHuman('c2');
    expect(d.next('c2').handoffEligible).toBe(false);
  });

  it('does not re-promise a transfer that already failed', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.markCallerRequestedHuman('c3');
    d.recordHandoffResult('c3', { status: 'NO_ANSWER' });
    const after = d.next('c3');
    expect(after.handoffEligible).toBe(false);
    expect(after.disposition).toBe('CREATE_TASK');
  });
});
