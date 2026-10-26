import { describe, it, expect, beforeEach } from 'vitest';
import { noteTicketFiled, lastTicketFiledAtMs, resetTicketFilingPulse } from './ticketFilingPulse';

describe('ticketFilingPulse', () => {
  beforeEach(() => resetTicketFilingPulse());

  it('starts empty, so a fresh process cannot disconfirm anything', () => {
    expect(lastTicketFiledAtMs()).toBeNull();
  });

  it('records the moment a ticket was filed', () => {
    noteTicketFiled(1_000);
    expect(lastTicketFiledAtMs()).toBe(1_000);
  });

  it('moves forward as filings continue', () => {
    noteTicketFiled(1_000);
    noteTicketFiled(2_000);
    expect(lastTicketFiledAtMs()).toBe(2_000);
  });

  it('NEVER walks backwards — a slow path reporting late must not age the pulse', () => {
    // Four filing paths call this and they do not finish in order. An older
    // stamp landing last would make filing look staler than it is, which is
    // the exact direction that produces a false alarm.
    noteTicketFiled(5_000);
    noteTicketFiled(1_000);
    expect(lastTicketFiledAtMs()).toBe(5_000);
  });

  it('an equal stamp is a no-op rather than a rewrite', () => {
    noteTicketFiled(3_000);
    noteTicketFiled(3_000);
    expect(lastTicketFiledAtMs()).toBe(3_000);
  });

  it('defaults to now, so the filing paths need pass nothing', () => {
    const before = Date.now();
    noteTicketFiled();
    const after = Date.now();
    const at = lastTicketFiledAtMs()!;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });
});
