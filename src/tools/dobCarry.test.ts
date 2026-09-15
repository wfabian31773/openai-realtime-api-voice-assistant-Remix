/**
 * WHY inherit did not fill date_of_birth — each arm of the enum, and that
 * the filing tools actually write it onto the refusal the timeline sees.
 *
 * Diagnosis is PR #307. `verifiedDobFor` returns a date or `undefined`;
 * those five `undefined`s were one bucket, which is why Bug B (32 certain
 * matches that still refused) could not be proven from what was persisted.
 * This suite pins the named exits, then pins that a refusal event carries
 * the enum and never the stored name or date.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const {
  rememberVerifiedIdentity,
  verifiedDobFor,
  dobCarry,
  resetVerifiedIdentities,
} = await import('./verifiedIdentity');
const { refuseDob } = await import('./registry');
const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');

const CALL = 'CA00000000000000000000000000000001';
const WAYNE = { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '03/17/1973' };

beforeEach(async () => {
  resetVerifiedIdentities();
  (await import('./dobEscape')).resetDobHistory();
  (await import('./spokenDob')).resetSpokenDobs();
  (await import('./gateAttempts')).resetGateAttempts();
  vi.restoreAllMocks();
});

describe('dobCarry names the same exits verifiedDobFor collapses', () => {
  it('bad_call_sid — a sentinel is not a key', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(dobCarry('unknown', 'Wayne', 'Fabian')).toBe('bad_call_sid');
    expect(dobCarry(undefined, 'Wayne', 'Fabian')).toBe('bad_call_sid');
    expect(dobCarry('', 'Wayne', 'Fabian')).toBe('bad_call_sid');
    expect(verifiedDobFor('unknown', 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('no_entry — nothing stored, or the TTL has run out', () => {
    expect(dobCarry(CALL, 'Wayne', 'Fabian')).toBe('no_entry');
    rememberVerifiedIdentity(CALL, WAYNE);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);
    expect(dobCarry(CALL, 'Wayne', 'Fabian')).toBe('no_entry');
    expect(verifiedDobFor(CALL, 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('name_mismatch — entry exists, the ticket is for someone else', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(dobCarry(CALL, 'Maria', 'Fabian')).toBe('name_mismatch');
    expect(dobCarry(CALL, 'Wayne', 'Nguyen')).toBe('name_mismatch');
    expect(verifiedDobFor(CALL, 'Maria', 'Fabian')).toBeUndefined();
  });

  it('entry_without_dob — names match, the date was never stored', () => {
    rememberVerifiedIdentity(CALL, { firstName: 'Wayne', lastName: 'Fabian' });
    expect(dobCarry(CALL, 'Wayne', 'Fabian')).toBe('entry_without_dob');
    expect(verifiedDobFor(CALL, 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('fired — names match and a date is in the map', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(dobCarry(CALL, 'Wayne', 'Fabian')).toBe('fired');
    expect(dobCarry(CALL, '  WAYNE ', 'fabian')).toBe('fired');
    expect(verifiedDobFor(CALL, 'Wayne', 'Fabian')).toBe('03/17/1973');
  });
});

describe('refuseDob attaches the enum and never a value', () => {
  it('writes carry and nothing that looks like the stored date or name', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    const out = refuseDob(CALL, 'Maria', 'Fabian', 'ask', 'fix');
    expect(out.success).toBe(false);
    expect(out.missingFields).toEqual(['date_of_birth']);
    expect(out.carry).toBe('name_mismatch');
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('03/17/1973');
    expect(blob).not.toContain('Wayne');
    expect(blob).not.toContain('1973');
  });
});

const FILING = [
  {
    tool: 'file_optical_ticket',
    extra: { location: 'Eastvale' },
  },
  {
    tool: 'file_surgery_ticket',
    extra: {},
  },
  {
    tool: 'file_tech_ticket',
    extra: {},
  },
  {
    tool: 'file_records_ticket',
    extra: { requester: 'I am the patient', deliver_to: 'to me', date_range: 'everything' },
  },
] as const;

function payload(callSid: string, first: string, last: string, extra: Record<string, string>) {
  return {
    first_name: first,
    last_name: last,
    callback_number: '5555550100',
    request_description: 'a refill',
    call_sid: callSid,
    ...extra,
  };
}

describe('each filing tool writes carry onto a date-of-birth refusal', () => {
  it('covers all four lanes', () => {
    expect(FILING.map((f) => f.tool).sort()).toEqual([
      'file_optical_ticket',
      'file_records_ticket',
      'file_surgery_ticket',
      'file_tech_ticket',
    ]);
  });

  it('no_entry when nothing was stored', async () => {
    for (const { tool, extra } of FILING) {
      const out = (await runTool(tool, payload(CALL, 'Wayne', 'Fabian', extra))) as Record<string, unknown>;
      expect(out.missingFields, tool).toEqual(['date_of_birth']);
      expect(out.carry, tool).toBe('no_entry');
    }
  });

  it('entry_without_dob when the map holds the name and no date', async () => {
    rememberVerifiedIdentity(CALL, { firstName: 'Wayne', lastName: 'Fabian' });
    for (const { tool, extra } of FILING) {
      const out = (await runTool(tool, payload(CALL, 'Wayne', 'Fabian', extra))) as Record<string, unknown>;
      expect(out.carry, tool).toBe('entry_without_dob');
    }
  });

  it('name_mismatch when the ticket is for a different spelling', async () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    for (const { tool, extra } of FILING) {
      const out = (await runTool(tool, payload(CALL, 'Maria', 'Fabian', extra))) as Record<string, unknown>;
      expect(out.carry, tool).toBe('name_mismatch');
    }
  });

  it('bad_call_sid when the model sent a sentinel', async () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    for (const { tool, extra } of FILING) {
      const out = (await runTool(tool, payload('unknown', 'Wayne', 'Fabian', extra))) as Record<string, unknown>;
      expect(out.carry, tool).toBe('bad_call_sid');
    }
  });

  /**
   * A parseable stored date never reaches this refusal — inherit fills it.
   * `fired` on a refusal is the remaining case: the date is in the map and
   * the parser will not take it. That is how this arm is reachable at all.
   */
  it('fired when a date is stored and still unreadable', async () => {
    rememberVerifiedIdentity(CALL, {
      firstName: 'Wayne',
      lastName: 'Fabian',
      dateOfBirth: 'not-a-date',
    });
    for (const { tool, extra } of FILING) {
      const out = (await runTool(tool, payload(CALL, 'Wayne', 'Fabian', extra))) as Record<string, unknown>;
      expect(out.missingFields, tool).toContain('date_of_birth');
      expect(out.carry, tool).toBe('fired');
      const blob = JSON.stringify(out);
      expect(blob, tool).not.toContain('not-a-date');
      expect(blob, tool).not.toContain('03/17/1973');
    }
  });

  it('a location refusal does not grow a carry field', async () => {
    const out = (await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      callback_number: '5555550100',
      request_description: 'glasses',
      call_sid: CALL,
    })) as Record<string, unknown>;
    expect(out.missingFields).toContain('location');
    expect(out).not.toHaveProperty('carry');
  });
});
