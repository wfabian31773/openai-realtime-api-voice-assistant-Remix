/**
 * THE SECOND MISS ENDS THE IDENTITY ASK — v50.
 *
 * On 2026-09-16 the runtime lanes asked for a date of birth two or more times
 * on 35 substantive calls, and on tech 15 of 16 were cold callers the
 * recognised-caller fixes never reach. The loop runs through THIS tool: the
 * miss message said "ask for their name and date of birth" every time, with
 * no count. Driven through `runTool`, the entry point the model calls, with
 * an invented caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const { runTool } = await import('./registry');
const { LOOKUP_MISS_LIMIT } = await import('./sharedPatientTools');
const { resetGateAttempts } = await import('./gateAttempts');

const SID = 'CA000000000000000000000000000000a5';
const OTHER = 'CA000000000000000000000000000000a6';
const EMPTY = {
  patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
};
const FOUND = {
  patientFound: true, patientName: 'Zelda Quixote', matchedBy: 'name_dob', identityUnconfirmed: false,
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
};
const identity = { queue: 'surgery', first_name: 'Zelda', last_name: 'Quixote', date_of_birth: '01/04/1958' };

type Out = Record<string, unknown>;
const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Out>;

beforeEach(() => {
  lookupSpy.mockReset();
  lookupSpy.mockResolvedValue(EMPTY as never);
  resetGateAttempts();
});

describe('what counts as a miss', () => {
  it('the limit is the number the prose quotes', () => {
    expect(LOOKUP_MISS_LIMIT).toBe(2);
  });

  it('a phone-only miss is not an ask the caller answered: no count, no coaching, the old wording', async () => {
    const out = await lookup({ queue: 'surgery', call_sid: SID, caller_phone: '555-555-0147' });
    expect(out.found).toBe(false);
    expect(out.lookup_misses).toBe(0);
    expect(out.fix).toBeUndefined();
    expect(String(out.message)).toMatch(/No record found/);
    expect(String(out.message)).toMatch(/Ask for their name and date of birth/);
  });

  it('the first identity miss coaches ONE re-ask in the format the funnel needs', async () => {
    const out = await lookup({ ...identity, call_sid: SID });
    expect(out.lookup_misses).toBe(1);
    expect(String(out.message)).toMatch(/No record found/);
    expect(String(out.fix)).toMatch(/ONCE more/);
    expect(String(out.fix)).toMatch(/spell the last name/i);
    expect(String(out.fix)).toMatch(/month, then day, then year/i);
    expect(String(out.fix)).toMatch(/do not ask a third time/i);
  });

  it('the second identity miss ends the ask and says to file', async () => {
    await lookup({ ...identity, call_sid: SID });
    const out = await lookup({ ...identity, last_name: 'Quixotte', call_sid: SID });
    expect(out.found).toBe(false);
    expect(out.lookup_misses).toBe(2);
    expect(String(out.fix)).toMatch(/Do NOT ask the caller for their name or date of birth again/);
    expect(String(out.fix)).toMatch(/file it now/i);
    // The spoken line no longer sends the model back for another round.
    expect(String(out.message)).toMatch(/^No record found/);
    expect(String(out.message)).not.toMatch(/Ask for their name/);
    expect(String(out.message)).toMatch(/take the request/i);
  });

  it('the ambiguous branch is an identity question, not a miss', async () => {
    lookupSpy.mockResolvedValueOnce({ ...EMPTY, identity: { unique: false, candidateCount: 3, candidates: [] } } as never);
    const several = await lookup({ ...identity, call_sid: SID });
    expect(several.candidate_count).toBe(3);
    expect(several.lookup_misses).toBeUndefined();
    const out = await lookup({ ...identity, call_sid: SID });
    expect(out.lookup_misses).toBe(1);
  });

  it('a hit carries no count, and a later miss on the same call starts from where it was', async () => {
    await lookup({ ...identity, call_sid: SID });
    lookupSpy.mockResolvedValueOnce(FOUND as never);
    const hit = await lookup({ ...identity, call_sid: SID });
    expect(hit.found).toBe(true);
    expect(hit.lookup_misses).toBeUndefined();
    const out = await lookup({ ...identity, first_name: 'Zed', call_sid: SID });
    expect(out.lookup_misses).toBe(2);
  });
});

describe('the count is the CALL\'s', () => {
  it('another call\'s misses do not count against this one', async () => {
    await lookup({ ...identity, call_sid: OTHER });
    await lookup({ ...identity, call_sid: OTHER });
    const out = await lookup({ ...identity, call_sid: SID });
    expect(out.lookup_misses).toBe(1);
    expect(String(out.fix)).toMatch(/ONCE more/);
  });

  it('a sentinel CallSid never reaches the limit — gateAttempts\' own rule', async () => {
    // The count is off for a sentinel (one caller's misses must not count for
    // another's), so the STOP instruction can never fire; the first-miss
    // coaching is self-limiting text and still goes out.
    for (let i = 0; i < 4; i++) {
      const out = await lookup({ ...identity, call_sid: 'unknown' });
      expect(out.lookup_misses).toBe(0);
      expect(String(out.fix ?? '')).not.toMatch(/Do NOT ask the caller/);
      expect(String(out.message)).toMatch(/Ask for their name and date of birth/);
    }
  });
});

describe('the count reaches the table', () => {
  it('toolTimeline keeps lookup_misses on the outcome', () => {
    const src = readFileSync(new URL('../services/toolTimeline.ts', import.meta.url), 'utf8');
    const allow = src.slice(src.indexOf("'found', 'candidate_count',"), src.indexOf("'say',"));
    expect(allow).toMatch(/'lookup_misses',/);
  });
});
