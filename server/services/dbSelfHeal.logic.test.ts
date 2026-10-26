// Keep-alive self-heal escalation rule (2026-08-24 incident: the voice
// process pinged, failed, and logged every 2 minutes for 52+ hours without
// ever repairing its wedged pool).
import { describe, it, expect } from 'vitest';
import { selfHealAction, RECYCLE_AFTER_CONSECUTIVE_FAILURES } from './dbSelfHeal.logic';

describe('selfHealAction', () => {
  it('never recycles on a transient blip (fewer consecutive failures than the threshold)', () => {
    for (let n = 1; n < RECYCLE_AFTER_CONSECUTIVE_FAILURES; n++) {
      expect(selfHealAction(n)).toBe('none');
    }
  });

  it('recycles exactly at the threshold', () => {
    expect(selfHealAction(RECYCLE_AFTER_CONSECUTIVE_FAILURES)).toBe('recycle');
  });

  it('keeps retrying on every further multiple — a long outage is never given up on', () => {
    expect(selfHealAction(RECYCLE_AFTER_CONSECUTIVE_FAILURES * 2)).toBe('recycle');
    expect(selfHealAction(RECYCLE_AFTER_CONSECUTIVE_FAILURES * 5)).toBe('recycle');
  });

  it('does not recycle between multiples (the previous rebuild gets time to prove itself)', () => {
    expect(selfHealAction(RECYCLE_AFTER_CONSECUTIVE_FAILURES + 1)).toBe('none');
    expect(selfHealAction(RECYCLE_AFTER_CONSECUTIVE_FAILURES * 2 - 1)).toBe('none');
  });
});
