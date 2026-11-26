/**
 * The checks, run through the real runner against a fake database and fake
 * screens. Each check is shown failing on the defect it exists for (the
 * numbers measured on production 2026-11-26 02:50 UTC) and passing when the
 * screen agrees with the truth. Synthetic numbers only; no patient data.
 */
import { describe, expect, it } from 'vitest';
import { runChecks } from './accuracy.logic';
import {
  buildChecks,
  PACIFIC_DAY_OF_CREATED,
  TRUTH_CALLS_LAST_24H_SQL,
  TRUTH_CALLS_LAST_DAYS_SQL,
  TRUTH_CALLS_PACIFIC_TODAY_SQL,
  TRUTH_DROPPED_LAST_DAYS_SQL,
  TRUTH_SPEND_PACIFIC_TODAY_SQL,
  type AccuracyDeps,
  type ScreenReaders,
} from './checks';

const TRUTH: Record<string, Record<string, number>> = {
  [TRUTH_CALLS_PACIFIC_TODAY_SQL]: { n: 639 },
  [TRUTH_CALLS_LAST_DAYS_SQL]: { n: 4010 },
  [TRUTH_CALLS_LAST_24H_SQL]: { n: 662 },
  [TRUTH_DROPPED_LAST_DAYS_SQL]: { n: 539 },
  [TRUTH_SPEND_PACIFIC_TODAY_SQL]: { cents: 22330 },
};

function deps(screens: Partial<ScreenReaders>, truth = TRUTH): AccuracyDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    hub: {
      async query(text: string) {
        sent.push(text);
        const row = truth[text];
        if (!row) throw new Error('unexpected statement');
        return { rows: [row] };
      },
    },
    screens: {
      todayOverview: async () => ({ opsHub: [{ callsToday: 400 }, { callsToday: 238 }] }),
      scorecards: async () => [{ calls: 4009, droppedCalls: 539 }],
      budgetStatus: async () => ({ todaySpendCents: 22330 }),
      operationsMonitor: async () => ({ last24Hours: { totalCalls: 662 } }),
      ...screens,
    },
  };
}

async function result(id: string, d: AccuracyDeps) {
  const report = await runChecks(buildChecks(), d);
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`no check ${id}`);
  return r;
}

describe('the checks pass when every screen agrees with the truth', () => {
  it('passes all of them', async () => {
    const report = await runChecks(buildChecks(), deps({}));
    expect(report.counts).toEqual({ pass: buildChecks().length, fail: 0, unknown: 0 });
  });
});

describe('each check catches the defect it was written for', () => {
  it('Operations Monitor: 0 calls in 24 hours against 662', async () => {
    const r = await result('operations-monitor.calls-24h', deps({ operationsMonitor: async () => ({ last24Hours: { totalCalls: 0 } }) }));
    expect(r).toMatchObject({ status: 'fail', screenValue: 0, truthValue: 662 });
  });

  it('Operations Monitor: a missing count is unknown, not a pass', async () => {
    const r = await result('operations-monitor.calls-24h', deps({ operationsMonitor: async () => null }));
    expect(r.status).toBe('unknown');
  });

  it('Health: "Telephony errors" read 0 while 539 calls dropped', async () => {
    const r = await result('observatory.health.dropped-7d', deps({ scorecards: async () => [{ calls: 4009, telephonyErrors: 0 }] }));
    expect(r).toMatchObject({ status: 'fail', screenValue: 0, truthValue: 539 });
  });

  it('Health: the fixed droppedCalls field is read before the old one', async () => {
    const r = await result('observatory.health.dropped-7d', deps({ scorecards: async () => [{ calls: 4009, droppedCalls: 539, telephonyErrors: 0 }] }));
    expect(r.status).toBe('pass');
  });

  it('Health: cards that leave calls off fail once past the drift allowance', async () => {
    const r = await result('observatory.health.calls-7d', deps({ scorecards: async () => [{ calls: 3900, droppedCalls: 539 }] }));
    expect(r.status).toBe('fail');
  });

  it('Overview: one call missing its agent is inside the allowance; a missing lane is not', async () => {
    expect((await result('observatory.overview.calls-today', deps({ todayOverview: async () => ({ opsHub: [{ callsToday: 638 }] }) }))).status).toBe('pass');
    expect((await result('observatory.overview.calls-today', deps({ todayOverview: async () => ({ opsHub: [{ callsToday: 465 }] }) }))).status).toBe('fail');
  });

  it('Budget: the UTC-day, voice-only figure ($229.40) against the Pacific-day total ($223.30)', async () => {
    const r = await result('cost.budget.spend-today', deps({ budgetStatus: async () => ({ todaySpendCents: 22940 }) }));
    expect(r).toMatchObject({ status: 'fail', screenValue: 229.4, truthValue: 223.3 });
  });

  it('a screen that throws is unknown with the reason', async () => {
    const r = await result('cost.budget.spend-today', deps({ budgetStatus: async () => { throw new Error('budget route down'); } }));
    expect(r.status).toBe('unknown');
    expect(r.note).toContain('budget route down');
  });
});

describe('the truth statements', () => {
  it('count the Pacific day from created_at read as UTC', () => {
    expect(PACIFIC_DAY_OF_CREATED).toBe(`((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date`);
    expect(TRUTH_CALLS_PACIFIC_TODAY_SQL).toContain(PACIFIC_DAY_OF_CREATED);
    expect(TRUTH_SPEND_PACIFIC_TODAY_SQL).toContain(PACIFIC_DAY_OF_CREATED);
  });

  it('count a dropped call by the runtime outcome, not the never-written Twilio error column', () => {
    expect(TRUTH_DROPPED_LAST_DAYS_SQL).toContain(`runtime_outcome = 'provider_failure'`);
    expect(TRUTH_DROPPED_LAST_DAYS_SQL).not.toContain('twilio_error_code');
  });

  it('count spend as voice AI plus Twilio', () => {
    expect(TRUTH_SPEND_PACIFIC_TODAY_SQL).toContain('openai_cost_cents');
    expect(TRUTH_SPEND_PACIFIC_TODAY_SQL).toContain('twilio_cost_cents');
  });

  it('select no patient data', () => {
    for (const sql of Object.keys(TRUTH)) {
      expect(sql).not.toMatch(/transcript|caller_name|patient_name|phone|date_of_birth|patient_dob/i);
    }
  });

  it('every check has a unique id and says what it claims and where the truth comes from', () => {
    const checks = buildChecks();
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const c of checks) {
      expect(c.claim.length).toBeGreaterThan(10);
      expect(c.truthSource.length).toBeGreaterThan(10);
    }
  });
});
