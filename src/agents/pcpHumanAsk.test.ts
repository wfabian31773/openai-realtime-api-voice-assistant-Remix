import { describe, it, expect } from 'vitest';

/**
 * The exact phrasings that must — and must not — dial the office queue.
 * Live call 2026-08-09: a surgery-center nurse asked twice and was
 * interviewed instead of connected. The correction must not swing the other
 * way and dial the queue for a caller who never asked.
 */
const ASKED =
  /\b(speak|talk)\b\s+(?:to|with)\b[^.]{0,25}\b(person|human|someone|somebody|rep|representative|agent|front desk|receptionist)\b/i;
const CONNECT =
  /\b(connect|transfer|put me through|put me|get me)\b[^.]{0,25}\b(person|human|someone|somebody|rep|representative|agent|front desk|office|team)\b/i;
const PLAIN = /\b(live person|real person|actual person|human being)\b/i;
const askedForAPerson = (t: string) => ASKED.test(t) || CONNECT.test(t) || PLAIN.test(t);

describe('PCP — did the caller ask for a person?', () => {
  it('yes: the real call that exposed the bug', () => {
    expect(askedForAPerson('I need to speak with someone about one of our patients')).toBe(true);
    expect(askedForAPerson('No, I just need you to connect me to the front desk')).toBe(true);
    expect(askedForAPerson('can you transfer me to a representative')).toBe(true);
    expect(askedForAPerson('I want to talk to a real person')).toBe(true);
  });

  it('no: ordinary narratives that merely mention an office', () => {
    expect(askedForAPerson('caller from the front desk asking about a referral')).toBe(false);
    expect(askedForAPerson('caller wants to talk about office hours')).toBe(false);
    expect(askedForAPerson('requesting records be faxed to our office')).toBe(false);
    expect(askedForAPerson('checking whether the patient kept their appointment')).toBe(false);
  });
});
