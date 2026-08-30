import { describe, it, expect } from 'vitest';
import {
  assertOutputDirIsIgnored,
  buildManifest,
  chunkFileName,
  chunkRows,
  criticalFailureCount,
  extractGraders,
  extractToolEvents,
  isReplayable,
  toCorpusRow,
  type RawCallLogRow,
} from './corpusBuilder';

function row(over: Partial<RawCallLogRow> = {}): RawCallLogRow {
  return {
    id: 'cl-1',
    from_number: '+15551234567',
    caller_name: null,
    patient_name: 'Pat Sample',
    patient_dob: '1980-01-01',
    patient_found: true,
    ticket_number: 'VA-00001',
    transferred_to_human: false,
    total_turns: 8,
    duration: 120,
    transcript: 'AGENT: Thank you for calling.\nCALLER: I need a refill.',
    grader_results: null,
    tool_timeline: null,
    ...over,
  };
}

describe('the PHI guard', () => {
  /**
   * The reason this module exists. A corpus row is a full call transcript, and
   * `.gitignore` had no rule covering `*.jsonl` before this change.
   */
  it('refuses to write a corpus to a path git would track', () => {
    expect(() => assertOutputDirIsIgnored('docs/corpus', () => false)).toThrowError(
      /not ignored by git/,
    );
  });

  it('names what is at stake, so the error is actionable rather than a bare refusal', () => {
    let message = '';
    try {
      assertOutputDirIsIgnored('docs/corpus', () => false);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/transcripts/);
    expect(message).toMatch(/dates of birth/);
    expect(message).toMatch(/replay-corpus/);
  });

  it('allows a genuinely ignored path', () => {
    expect(() => assertOutputDirIsIgnored('replay-corpus/as', () => true)).not.toThrow();
  });

  it('asks about the exact directory it was given, not a prefix or a guess', () => {
    const asked: string[] = [];
    assertOutputDirIsIgnored('replay-corpus/answering-service', (d) => {
      asked.push(d);
      return true;
    });
    expect(asked).toEqual(['replay-corpus/answering-service']);
  });
});

describe('tool_timeline is an object, not an array', () => {
  /**
   * This shape has already produced a wrong answer: querying it as an array
   * returns nothing, which reads as "no tools were ever called".
   */
  it('reads events from the object wrapper', () => {
    const events = extractToolEvents({
      agentSlug: 'optical',
      toolCallCount: 2,
      events: [
        { tool: 'lookup_patient', args: { phone: 'x' }, outcome: { success: true } },
        { tool: 'file_optical_ticket', outcome: { error: 'nope' } },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events?.[0].tool).toBe('lookup_patient');
    expect(events?.[1].outcome).toEqual({ error: 'nope' });
  });

  it('returns null for a bare array, which is the shape that does not occur', () => {
    expect(extractToolEvents([{ tool: 'lookup_patient' }])).toBeNull();
  });

  it('drops events with no tool name rather than emitting undefined entries', () => {
    expect(extractToolEvents({ events: [{ outcome: {} }, { tool: 'a' }] })).toEqual([
      { tool: 'a', args: undefined, outcome: undefined },
    ]);
  });

  it('returns null rather than an empty array when nothing survives', () => {
    expect(extractToolEvents({ events: [] })).toBeNull();
    expect(extractToolEvents({ events: [{ outcome: {} }] })).toBeNull();
    expect(extractToolEvents(null)).toBeNull();
  });
});

describe('critical failure counting', () => {
  it('reads the stored summary', () => {
    expect(criticalFailureCount({ summary: { criticalFailures: 3 } })).toBe(3);
  });

  it('treats a missing or zero count as zero, not as unknown', () => {
    expect(criticalFailureCount({ summary: {} })).toBe(0);
    expect(criticalFailureCount({ summary: { criticalFailures: 0 } })).toBe(0);
    expect(criticalFailureCount(null)).toBe(0);
  });
});

describe('row mapping', () => {
  it('maps a call_logs row into the shape replayStoredCall consumes', () => {
    const out = toCorpusRow(row());
    expect(out.id).toBe('cl-1');
    // `from_number` -> `from`: the corpus key differs from the column name.
    expect(out.from).toBe('+15551234567');
    expect(out.patient_found).toBe(true);
    expect(out.transcript).toContain('CALLER: I need a refill.');
  });

  it('keeps the graders array and drops the rest of the grader envelope', () => {
    const out = toCorpusRow(
      row({ grader_results: { gradedAt: 'x', summary: { total: 15 }, graders: [{ grader: 'latency' }] } }),
    );
    expect(out.grader_results).toEqual({ graders: [{ grader: 'latency' }] });
  });

  it('never emits undefined for a transcript, since replay reads it directly', () => {
    expect(toCorpusRow(row({ transcript: null })).transcript).toBe('');
  });

  it('rejects a call with no transcript — there are no caller turns to replay', () => {
    expect(isReplayable(row({ transcript: null }))).toBe(false);
    expect(isReplayable(row({ transcript: '   ' }))).toBe(false);
    expect(isReplayable(row())).toBe(true);
  });

  it('returns null graders when the envelope has none', () => {
    expect(extractGraders({ gradedAt: 'x' })).toBeNull();
    expect(extractGraders(null)).toBeNull();
  });
});

describe('chunking', () => {
  it('splits in order and keeps every row', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(chunkRows(rows, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows(rows, 2).flat()).toEqual(rows);
  });

  it('handles an empty corpus without producing an empty chunk file', () => {
    expect(chunkRows([], 25)).toEqual([]);
  });

  it('refuses a chunk size that would loop forever', () => {
    expect(() => chunkRows([1], 0)).toThrowError(/chunkSize/);
  });

  it('names chunks so they sort lexicographically, which is how the runner globs them', () => {
    expect(chunkFileName(0)).toBe('chunk-000.jsonl');
    expect([chunkFileName(10), chunkFileName(2)].sort()).toEqual([
      'chunk-002.jsonl',
      'chunk-010.jsonl',
    ]);
  });
});

describe('the manifest', () => {
  /** The manifest is the part that CAN be committed — provenance, no content. */
  it('records provenance and counts without carrying any call content', () => {
    const rows = [
      toCorpusRow(row({ id: 'a', grader_results: { graders: [{ grader: 'x', severity: 'critical', pass: false }] } })),
      toCorpusRow(row({ id: 'b', grader_results: { graders: [{ grader: 'x', severity: 'critical', pass: true }] } })),
    ];
    const m = buildManifest({
      agent: 'answering-service',
      from: '2026-08-10',
      to: '2026-08-12',
      rows,
      chunkSize: 25,
      ordering: 'worst-first',
      skippedNoTranscript: 4,
      now: new Date('2026-08-30T00:00:00Z'),
    });

    expect(m).toEqual({
      agent: 'answering-service',
      from: '2026-08-10',
      to: '2026-08-12',
      calls: 2,
      chunks: 1,
      chunkSize: 25,
      ordering: 'worst-first',
      callsWithCriticalFailure: 1,
      skippedNoTranscript: 4,
      builtAt: '2026-08-30T00:00:00.000Z',
    });

    // The whole manifest must be safe to commit: no transcript, no name, no DOB.
    const serialised = JSON.stringify(m);
    expect(serialised).not.toContain('Pat Sample');
    expect(serialised).not.toContain('1980-01-01');
    expect(serialised).not.toContain('refill');
    expect(serialised).not.toContain('+1555');
  });

  it('counts a call once however many critical graders it failed', () => {
    const rows = [
      toCorpusRow(
        row({
          grader_results: {
            graders: [
              { grader: 'a', severity: 'critical', pass: false },
              { grader: 'b', severity: 'critical', pass: false },
            ],
          },
        }),
      ),
    ];
    const m = buildManifest({
      agent: 'tech',
      from: '2026-08-14',
      to: '2026-08-14',
      rows,
      chunkSize: 25,
      ordering: 'worst-first',
      skippedNoTranscript: 0,
      now: new Date('2026-08-30T00:00:00Z'),
    });
    expect(m.callsWithCriticalFailure).toBe(1);
  });
});
