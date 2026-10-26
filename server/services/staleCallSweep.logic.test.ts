// Stale-call sweeper decision logic — the bookkeeping honesty rules from the
// 2026-08-24 incident (4 rows shown "Live now" for 52 hours after a Supabase
// restart wedged the voice process's DB layer).
//
// These assert on PRODUCED BEHAVIOR of decideSweep (measurement-traps.md:
// source-scanning tests prove a line exists, not that it behaves).
import { describe, it, expect } from 'vitest';
import {
  decideSweep,
  isTerminalTwilioStatus,
  summarizeSweepLine,
  STALE_CALL_CEILING_MS,
  STALE_SWEEP_DISPOSITION,
  type StaleRow,
} from './staleCallSweep.logic';

const row: StaleRow = { id: 'log-1', callSid: 'CA42273a74a7436f21dd7c727d521d9443', status: 'in_progress' };
const now = new Date('2026-08-27T00:00:00Z');

describe('decideSweep', () => {
  it('records Twilio ground truth when Twilio says the call completed — real duration, real end time, distinct disposition', () => {
    const twilioEnd = new Date('2026-08-24T20:31:00Z');
    const action = decideSweep(
      row,
      { kind: 'terminal', twilioStatus: 'completed', durationSeconds: 843, endTime: twilioEnd },
      now,
    );
    expect(action.type).toBe('close');
    if (action.type !== 'close') return;
    expect(action.patch.status).toBe('completed');
    expect(action.patch.duration).toBe(843);
    expect(action.patch.endTime).toBe(twilioEnd);
    expect(action.patch.twilioStatus).toBe('completed');
    // The one non-negotiable: a swept row is forever distinguishable
    expect(action.patch.callDisposition).toBe(STALE_SWEEP_DISPOSITION);
  });

  it('maps busy / no-answer / canceled to honest terminal statuses, never to completed', () => {
    const cases: Array<[string, string]> = [
      ['busy', 'busy'],
      ['no-answer', 'no_answer'],
      ['canceled', 'failed'],
      ['failed', 'failed'],
    ];
    for (const [twilio, ours] of cases) {
      const action = decideSweep(row, { kind: 'terminal', twilioStatus: twilio, durationSeconds: null, endTime: null }, now);
      expect(action.type).toBe('close');
      if (action.type !== 'close') continue;
      expect(action.patch.status).toBe(ours);
      expect(action.patch.status).not.toBe(twilio === 'completed' ? 'x' : 'completed');
    }
  });

  it('NEVER invents a duration when Twilio did not report one', () => {
    const action = decideSweep(row, { kind: 'terminal', twilioStatus: 'completed', durationSeconds: null, endTime: null }, now);
    if (action.type !== 'close') throw new Error('expected close');
    expect(action.patch.duration).toBeNull();
    // falls back to sweep time for endTime, not a guess at when it "should" have ended
    expect(action.patch.endTime).toBe(now);
  });

  it('closes a row Twilio has no record of as failed — no faked completion, no invented duration', () => {
    const action = decideSweep(row, { kind: 'not_found' }, now);
    if (action.type !== 'close') throw new Error('expected close');
    expect(action.patch.status).toBe('failed');
    expect(action.patch.duration).toBeNull();
    expect(action.patch.callDisposition).toBe(STALE_SWEEP_DISPOSITION);
  });

  it('closes a row as failed when Twilio cannot be asked (no CallSid / no credentials)', () => {
    const action = decideSweep({ ...row, callSid: null }, { kind: 'unavailable' }, now);
    if (action.type !== 'close') throw new Error('expected close');
    expect(action.patch.status).toBe('failed');
    expect(action.patch.duration).toBeNull();
    expect(action.patch.callDisposition).toBe(STALE_SWEEP_DISPOSITION);
  });

  it('leaves a call Twilio says is genuinely live COMPLETELY untouched', () => {
    const action = decideSweep(row, { kind: 'live', twilioStatus: 'in-progress' }, now);
    expect(action.type).toBe('leave_live');
  });

  it('skips (retries next sweep) on a transient Twilio API error instead of guessing', () => {
    const action = decideSweep(row, { kind: 'error', message: 'ETIMEDOUT' }, now);
    expect(action.type).toBe('skip_error');
  });
});

describe('ceiling derivation', () => {
  it('exceeds the coordinator absolute force-kill (25 min) and measured p99.9 duration (1,537s)', () => {
    // ABSOLUTE_MAX_CALL_DURATION_MS = max per-agent cap (20 min) + 5 min grace.
    // Not imported: callLifecycleCoordinator starts timers and opens the DB on import.
    const COORDINATOR_ABSOLUTE_MAX_MS = 25 * 60 * 1000;
    const MEASURED_P999_DURATION_MS = 1537 * 1000; // 60 days of call_logs, 2026-08-27
    expect(STALE_CALL_CEILING_MS).toBeGreaterThan(COORDINATOR_ABSOLUTE_MAX_MS);
    expect(STALE_CALL_CEILING_MS).toBeGreaterThan(MEASURED_P999_DURATION_MS);
  });
});

describe('isTerminalTwilioStatus', () => {
  it('treats queued/ringing/in-progress as live', () => {
    for (const s of ['queued', 'ringing', 'in-progress']) expect(isTerminalTwilioStatus(s)).toBe(false);
    for (const s of ['completed', 'busy', 'no-answer', 'failed', 'canceled']) expect(isTerminalTwilioStatus(s)).toBe(true);
  });
});

describe('summarizeSweepLine', () => {
  it('reports every disposition class so a sweep is auditable from one log line', () => {
    const line = summarizeSweepLine({
      examined: 4,
      closedFromTwilioTruth: 2,
      closedUnresolvable: 1,
      stillLiveAtTwilio: 1,
      errors: 0,
    });
    expect(line).toContain('[StaleCallSweeper]');
    expect(line).toContain('swept 3 of 4');
    expect(line).toContain('2 closed from Twilio truth');
    expect(line).toContain('1 unresolvable');
    expect(line).toContain('1 still live at Twilio');
  });
});
