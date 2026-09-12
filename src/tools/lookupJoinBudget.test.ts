/**
 * THE JOIN IS BUDGETED AGAINST THE TOOL RACE, NOT AGAINST ITSELF.
 *
 * Codex P1, round 2 on PR #292 — and the finding was as much about the test as
 * the code. The first fix gave the PersonID join a 1.5s deadline, and the test
 * for it stubbed every earlier rung as an immediate result and then asserted
 * `1500 < 6000`. Neither half touches the actual failure: a RELATIVE deadline
 * starts when the join starts, while `runTool`'s race is ABSOLUTE from the
 * moment the handler was entered. Spend 4.6s in the rungs above — three
 * unbounded schedule queries and the mirror, against a pool that permits a 15s
 * connection wait — and the join's deadline expires AFTER the race has already
 * answered "timed out". The identity is lost in exactly the case the deadline
 * was written to protect.
 *
 * A deadline already in the past IS the elapsed-budget case, stated so it
 * cannot flake on event-loop ordering. The three tests below cover the three
 * links: the join honours a spent budget, the tool hands one down, and the
 * number it hands down cannot drift from the one the registry enforces.
 *
 * Fixtures are invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

const { dir } = vi.hoisted(() => ({ dir: { hangs: true, calls: 0 } }));
const { chain, state, verifyPatient, findByPhone } = vi.hoisted(() => {
  // `queries` is the assertion that has teeth. Returning the right VALUE is not
  // enough: a join that waits out a 1.5s deadline it cannot afford and then
  // falls into the catch returns the same identity — while in production the
  // tool race has already answered "timed out" and the model never sees it.
  // What the fix changes is that the query is never ATTEMPTED. Count it.
  const state = { joinHangs: true, queries: 0 };
  const chain: Record<string, unknown> = {};
  for (const step of ['select', 'from', 'orderBy']) chain[step] = () => chain;
  chain.where = () => chain;
  chain.limit = () => {
    state.queries += 1;
    return state.joinHangs ? new Promise(() => {}) : Promise.resolve([]);
  };
  return { chain, state, verifyPatient: vi.fn(), findByPhone: vi.fn() };
});
vi.mock('../../server/db', () => ({ db: chain }));
vi.mock('../services/patientVerification', () => ({ verifyPatient, findByPhone }));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => true,
  // A cold/stale snapshot refresh that never returns. If the budget check is
  // missing, the handler waits here forever and the tool race answers instead.
  lookupLocation: async () => {
    dir.calls += 1;
    return dir.hangs ? new Promise(() => {}) : null;
  },
}));

const PERSON = {
  personId: '11111111-2222-3333-4444-555555555555',
  personNbr: null,
  firstName: 'Testcaller',
  lastName: 'Mirror',
  dob: '1950-01-01',
  hasMedicalRecord: true,
  language: null,
};

beforeEach(() => {
  state.joinHangs = true;
  state.queries = 0;
  dir.hangs = true;
  dir.calls = 0;
  verifyPatient.mockReset();
  findByPhone.mockReset();
  findByPhone.mockResolvedValue({
    verified: true, reason: 'match', candidates: 1, patient: PERSON, source: 'mirror',
  } as never);
});

describe('1 — the join honours a budget the rungs above have already spent', () => {
  it('SKIPS the join and keeps the identity when no budget remains', async () => {
    const { ScheduleLookupService } = await import('../services/scheduleLookupService');
    const svc = new ScheduleLookupService() as unknown as Record<string, unknown>;
    const EMPTY = {
      patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
    };
    for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
      svc[rung] = vi.fn().mockResolvedValue(EMPTY);
    }

    // The budget is gone — as it is on a call whose rungs took 5.8 of 6 seconds.
    // With a purely RELATIVE deadline this await never returns and the caller
    // is handed a timeout instead of the patient.
    const startedAt = Date.now();
    const out = await (svc as never as {
      lookupPatient: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).lookupPatient({ phone: '5555550147', deadlineAt: Date.now() - 1 });
    const elapsed = Date.now() - startedAt;

    expect(out.patientFound).toBe(true);
    expect(out.patientName).toBe('Testcaller Mirror');
    expect(out.totalAppointmentsFound).toBe(0);

    /**
     * THE TWO ASSERTIONS THAT ACTUALLY BITE, and the reason they are here:
     * without them this test passes with the fix REVERTED. A relative 1.5s
     * deadline also ends up returning the identity — it just waits out 1.5s it
     * does not have first, by which point `runTool`'s race has answered and
     * the model has the timeout instead. Returning the right value is not the
     * behaviour under test; not spending time we do not have is.
     */
    expect(state.queries, 'the join must not be ATTEMPTED on a spent budget').toBe(0);
    expect(elapsed, 'must answer at once, not wait out a deadline it cannot afford')
      .toBeLessThan(250);
  });

  it('does NOT skip when the caller omitted a deadline entirely', async () => {
    // Callers with no tool budget (tests, scripts, future call sites) must keep
    // the old behaviour rather than silently losing their history.
    state.joinHangs = false;
    const { ScheduleLookupService } = await import('../services/scheduleLookupService');
    const svc = new ScheduleLookupService() as unknown as Record<string, unknown>;
    const EMPTY = {
      patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
    };
    for (const rung of ['lookupByNameAndDOB', 'lookupByPhone', 'lookupByName']) {
      svc[rung] = vi.fn().mockResolvedValue(EMPTY);
    }

    const out = await (svc as never as {
      lookupPatient: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).lookupPatient({ phone: '5555550147' });

    expect(out.patientFound).toBe(true);
    expect(state.queries, 'with no deadline the join still runs').toBeGreaterThan(0);
  });
});

describe('1b — so does the office refinement that runs AFTER the service', () => {
  it('CAPS the refinement at the remaining budget instead of waiting on it', async () => {
    /**
     * A cold or stale snapshot refreshes with a 5s connection timeout, in a
     * LOOP — once per past location. Checking the clock BETWEEN lookups bounds
     * nothing, because the stall happens INSIDE one; only a race can interrupt
     * it. Tested directly rather than through `runTool`, because the cap IS
     * the tool budget and a test that waits it out measures vitest's own 5s
     * timeout instead of the code.
     */
    dir.hangs = true;
    const { mostRecentAcceptable } = await import('./sharedPatientTools');

    const started = performance.now();
    const out = await mostRecentAcceptable(['Testoffice One', 'Testoffice Two'], 'optical',
      Date.now() + 60);
    const elapsed = performance.now() - started;

    // The raw most-recent office, unrefined — the same fallback this function
    // already uses when the directory is unconfigured or a lookup throws.
    expect(out).toBe('Testoffice One');
    expect(dir.calls, 'it did attempt the refinement').toBeGreaterThan(0);
    expect(elapsed, 'must not wait out a hanging directory refresh').toBeLessThan(1_000);
  });

  it('skips the directory entirely when the budget is already gone', async () => {
    dir.hangs = true;
    const { mostRecentAcceptable } = await import('./sharedPatientTools');

    const out = await mostRecentAcceptable(['Testoffice One'], 'optical', Date.now() - 1);

    expect(out).toBe('Testoffice One');
    expect(dir.calls, 'nothing should be attempted on a spent budget').toBe(0);
  });

  it('still refines when there is budget and the directory answers', async () => {
    // The cap must not cost the refinement in the normal case.
    dir.hangs = false;
    const { mostRecentAcceptable } = await import('./sharedPatientTools');

    const out = await mostRecentAcceptable(['Testoffice One'], 'optical', Date.now() + 5_000);

    expect(out).toBe('Testoffice One');
    expect(dir.calls).toBeGreaterThan(0);
  });

  it('does NOT warn about a budget it did not run out of', async () => {
    /**
     * Codex P2 on ec45286. The losing timer was never cleared, so on every
     * ordinary call it fired seconds after the tool had already answered and
     * logged "ran out of tool budget" for a lookup that did not. This repo
     * reads that line as a LIVE COUNTER of a real failure — firing it on
     * success makes it count nothing, which is the instrument-lies trap
     * CLAUDE.md documents twice over.
     */
    dir.hangs = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mostRecentAcceptable } = await import('./sharedPatientTools');

    // A SHORT budget, so a dangling timer would fire well inside this test.
    await mostRecentAcceptable(['Testoffice One'], 'optical', Date.now() + 40);
    await new Promise((r) => setTimeout(r, 120));

    const budgetWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('ran out of tool budget'));
    expect(budgetWarnings, 'the refinement succeeded; nothing timed out').toEqual([]);
    warn.mockRestore();
  });
});

describe('2 — the tool hands an ABSOLUTE deadline down', () => {
  it('passes a deadlineAt derived from the tool budget, not a relative timeout', async () => {
    const lookupSpy = vi.fn().mockResolvedValue({
      patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
    });
    vi.doMock('../services/scheduleLookupService', () => ({
      scheduleLookupService: { lookupPatient: lookupSpy },
    }));
    vi.doMock('../services/consoleDirectory', () => ({
      isDirectoryConfigured: () => false,
      lookupLocation: async () => null,
    }));
    vi.resetModules();

    const { runTool } = await import('./registry');
    await import('./sharedPatientTools');
    const { LOOKUP_PATIENT_BUDGET_MS } = await import('./sharedPatientTools');

    const before = Date.now();
    await runTool('lookup_patient', {
      queue: 'optical',
      call_sid: 'CA00000000000000000000000000000077',
      caller_phone: '555-555-0147',
    });

    expect(lookupSpy).toHaveBeenCalled();
    const passed = lookupSpy.mock.calls[0][0] as { deadlineAt?: number };
    expect(typeof passed.deadlineAt).toBe('number');
    // An ABSOLUTE moment near now + the budget — not a relative 1.5s.
    expect(passed.deadlineAt!).toBeGreaterThan(before);
    expect(passed.deadlineAt!).toBeLessThanOrEqual(before + LOOKUP_PATIENT_BUDGET_MS);
    vi.doUnmock('../services/scheduleLookupService');
    vi.doUnmock('../services/consoleDirectory');
  });
});

describe('3 — the budget constant cannot drift from what the registry enforces', () => {
  it('is the same number the tool is registered with', async () => {
    // Two copies of 6000 is how a deadline quietly stops beating its own race.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./sharedPatientTools.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/timeoutMs:\s*LOOKUP_PATIENT_BUDGET_MS/);
    expect(src).toMatch(/LOOKUP_PATIENT_BUDGET_MS\s*=\s*6000/);
  });
});
