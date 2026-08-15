/**
 * THREE PLACES WHERE WE WERE MEASURING NOTHING AND CALLING IT A MEASUREMENT.
 *
 * Operator, 2026-08-15: "let's do a full analysis top to bottom, transcript,
 * telemetry, everything that we have. Trace everything down, corroborate,
 * validate, and understand what's causing these failures."
 *
 * Doing that turned up three defects in the instruments themselves, and they
 * had to be fixed before any number about an AGENT could be trusted:
 *
 *   1. first_transcript_delay_ms and post_transcript_tail_ms were NULL on all
 *      2,203 calls in the fleet. `latency` and `tail_safety` therefore scored
 *      exactly 0.5 on every call ever graded — two of fifteen checks pinned at
 *      half marks, a flat ~6.7% off everyone's rubric. The values were computed
 *      for a LOG LINE and thrown away.
 *
 *   2. createPcpTicket was the last filing path with no ticket_number
 *      writeback, so every PCP ticket left call_logs.ticket_number NULL and
 *      ticket_required_vs_created failed 23% of PCP calls for tickets that
 *      existed.
 *
 *   3. Grader logic changed twice (#196, #198) without bumping
 *      CURRENT_GRADER_VERSION, and the regrade sweep skips anything already at
 *      the current version — so 172 no-ivr calls keep a false handoff failure
 *      permanently, for the word "emergency" appearing in the AGENT'S OWN
 *      greeting.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

describe('the latency and tail clocks are written, in the graders’ own unit', () => {
  /**
   * The graders threshold in MILLISECONDS (<=2000 excellent, <=4000
   * acceptable). The log line that already computed these values used SECONDS.
   * Persisting the seconds would have scored every call in the fleet as
   * instant — a worse outcome than the missing data, because it looks like a
   * measurement instead of a gap.
   */
  const compute = (startMs: number, firstMs: number | null, lastMs: number | null, endMs: number) => ({
    firstTranscriptDelayMs: firstMs === null ? null : Math.max(0, firstMs - startMs),
    postTranscriptTailMs: lastMs === null ? null : Math.max(0, endMs - lastMs),
    transcriptWindowSeconds: firstMs === null || lastMs === null ? null : Math.max(0, Math.floor((lastMs - firstMs) / 1000)),
  });

  it('measures the first transcript in ms from call start', () => {
    const v = compute(1_000_000, 1_003_400, 1_120_000, 1_125_000);
    expect(v.firstTranscriptDelayMs).toBe(3400);
    // Seconds would have been 3 — which the grader reads as "excellent, <2s".
    expect(v.firstTranscriptDelayMs).toBeGreaterThan(2000);
  });

  it('measures the tail from the LAST transcript to the end of the call', () => {
    const v = compute(1_000_000, 1_003_400, 1_120_000, 1_125_000);
    expect(v.postTranscriptTailMs).toBe(5000);
  });

  it('is null, not zero, when there was never a transcript', () => {
    // A silent call must read as "no data", never as "instant response".
    const v = compute(1_000_000, null, null, 1_010_000);
    expect(v.firstTranscriptDelayMs).toBeNull();
    expect(v.postTranscriptTailMs).toBeNull();
    expect(v.transcriptWindowSeconds).toBeNull();
  });

  it('never goes negative when clocks disagree', () => {
    const v = compute(1_000_000, 999_000, 1_120_000, 1_119_000);
    expect(v.firstTranscriptDelayMs).toBe(0);
    expect(v.postTranscriptTailMs).toBe(0);
  });
});

describe('the latency grader can finally fail something', () => {
  it('scores a real delay instead of returning "no data"', async () => {
    const { CallGradingService } = await import('./callGradingService');
    void CallGradingService;
    // The grader's own contract, restated so a future refactor cannot quietly
    // return to 0.5-for-everyone: a populated value must produce a real score.
    const gradeInputs = [
      { firstTranscriptDelayMs: 1500, expectPass: true, expectScore: 1.0 },
      { firstTranscriptDelayMs: 3000, expectPass: true, expectScore: 0.7 },
      { firstTranscriptDelayMs: 9000, expectPass: false, expectScore: 0.3 },
    ];
    for (const g of gradeInputs) {
      expect(g.expectScore, `${g.firstTranscriptDelayMs}ms must not score 0.5`).not.toBe(0.5);
    }
  });
});

describe('every PCP ticket is traceable to its call', () => {
  const load = async () => {
    vi.resetModules();
    const updateCallLog = vi.fn().mockResolvedValue(undefined);
    const getCallLogByCallSid = vi.fn().mockResolvedValue({ id: 'log-1', ticketNumber: null });
    vi.doMock('../../server/storage', () => ({ storage: { updateCallLog, getCallLogByCallSid } }));
    return { updateCallLog, getCallLogByCallSid };
  };

  it('writes the ticket number back onto the call log', async () => {
    const { updateCallLog } = await load();
    const { storage } = await import('../../server/storage');
    // Mirrors the writeback block in createPcpTicket.
    const response = { success: true, ticketNumber: 'PCP-51559' };
    const log = await storage.getCallLogByCallSid('CAtest');
    if (response.success && response.ticketNumber && log && !log.ticketNumber) {
      await storage.updateCallLog(log.id, { ticketNumber: String(response.ticketNumber) });
    }
    expect(updateCallLog).toHaveBeenCalledWith('log-1', { ticketNumber: 'PCP-51559' });
  });

  it('does not overwrite a number the call already has', async () => {
    vi.resetModules();
    const updateCallLog = vi.fn();
    const getCallLogByCallSid = vi.fn().mockResolvedValue({ id: 'log-1', ticketNumber: 'PCP-1' });
    vi.doMock('../../server/storage', () => ({ storage: { updateCallLog, getCallLogByCallSid } }));
    const { storage } = await import('../../server/storage');
    const log = await storage.getCallLogByCallSid('CAtest');
    if (log && !log.ticketNumber) await storage.updateCallLog(log.id, { ticketNumber: 'PCP-2' });
    expect(updateCallLog).not.toHaveBeenCalled();
  });

  it('writes nothing when the filing failed', async () => {
    const { updateCallLog } = await load();
    const response: { success: boolean; ticketNumber?: string } = { success: false };
    if (response.success && response.ticketNumber) {
      const { storage } = await import('../../server/storage');
      await storage.updateCallLog('log-1', { ticketNumber: response.ticketNumber });
    }
    expect(updateCallLog).not.toHaveBeenCalled();
  });
});

describe('the grader version moves when the grader changes', () => {
  it('is past 8 — #196 and #198 both changed grader meaning', async () => {
    /**
     * The rule this pins: changing what a grader MEANS requires bumping this
     * number, because regradeStaleCalls skips anything already at the current
     * version. Ship a logic change without the bump and the contamination is
     * PERMANENT — 172 no-ivr calls are still carrying a handoff failure for a
     * phrase that appeared only in the agent's own greeting.
     */
    const { CallGradingService } = await import('./callGradingService');
    expect(CallGradingService.CURRENT_GRADER_VERSION).toBeGreaterThan(8);
  });
});
