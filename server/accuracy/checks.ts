/**
 * server/accuracy/checks.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHECKS. One per number a screen shows that has an independent truth.
 *
 * Rules every check follows (accuracy.logic.ts says why):
 *  - the SCREEN side calls the function the screen's route calls, injected as
 *    `deps.screens.*`, never a copy of its SQL;
 *  - the TRUTH side is SQL below, on the table that records the fact, written
 *    to the measurement rules in CLAUDE.md (a day is the Pacific day; a call
 *    is a call_logs row; created_at is timestamp WITHOUT time zone holding UTC);
 *  - no statement selects a name, phone, date of birth, address or transcript:
 *    every truth is a count or a sum.
 *
 * Tolerances: live counts move between the two reads (a call can land between
 * them), so a count over a live window allows a few calls of drift. A check
 * whose window is closed allows none.
 *
 * Every truth statement is exported so checks.test.ts can pin what it reads.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { AccuracyCheck } from './accuracy.logic';

/** The one thing a check needs from a pool. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** What each screen's route returns, reduced to the fields the checks read. */
export interface ScreenReaders {
  /** Observatory › Overview: GET /api/observatory/today → todayOverview(). */
  todayOverview(): Promise<{ opsHub: Array<{ callsToday: number }> }>;
  /** Observatory › Health: GET /api/observatory/scorecards → opsHubAgentScorecards(days). */
  scorecards(days: number): Promise<Array<{ calls: number; telephonyErrors?: number; droppedCalls?: number }>>;
  /** Cost Dashboard › Daily Budget: GET /api/budget/status → budgetGuardService.getStatus(). */
  budgetStatus(): Promise<{ todaySpendCents: number }>;
  /** Operations Monitor: GET /api/observatory/operations → readOperations(hub, 24). */
  operationsMonitor(): Promise<{ calls?: { total?: number | null } } | null>;
}

export interface AccuracyDeps {
  hub: Queryable;
  screens: ScreenReaders;
}

/** The Pacific day a call_logs row belongs to (created_at is UTC wall time without a zone). */
export const PACIFIC_DAY_OF_CREATED = `((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date`;
export const PACIFIC_TODAY = `(now() AT TIME ZONE 'America/Los_Angeles')::date`;
/**
 * "Now" as UTC wall time, the form created_at is stored in. Comparing
 * created_at with a bare now() would read created_at in the database
 * session's time zone, which is UTC on the Hub today but is not promised
 * (Codex review of #525).
 */
export const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

export const TRUTH_CALLS_PACIFIC_TODAY_SQL = `
SELECT count(*)::int AS n FROM call_logs WHERE ${PACIFIC_DAY_OF_CREATED} = ${PACIFIC_TODAY}`;

export const TRUTH_CALLS_LAST_DAYS_SQL = `
SELECT count(*)::int AS n FROM call_logs WHERE created_at >= ${UTC_NOW} - make_interval(days => $1::int)`;

export const TRUTH_CALLS_LAST_24H_SQL = `
SELECT count(*)::int AS n FROM call_logs WHERE created_at >= ${UTC_NOW} - interval '24 hours'`;

/**
 * A call that dropped or failed: the runtime records a provider drop as
 * runtime_outcome = 'provider_failure'; a call that never connected is
 * status = 'failed'. (twilio_error_code is never written: 0 rows ever.)
 */
export const TRUTH_DROPPED_LAST_DAYS_SQL = `
SELECT count(*)::int AS n FROM call_logs
 WHERE created_at >= ${UTC_NOW} - make_interval(days => $1::int)
   AND (runtime_outcome = 'provider_failure' OR status = 'failed')`;

/**
 * The voice-AI cost of the Pacific day's calls: openai_cost_cents, the column
 * that holds xAI spend on the runtime. The budget counts this alone (Twilio is
 * not part of it), so this is the truth the budget must match.
 */
export const TRUTH_VOICE_AI_PACIFIC_TODAY_SQL = `
SELECT coalesce(sum(coalesce(openai_cost_cents, 0)), 0)::bigint AS cents
  FROM call_logs WHERE ${PACIFIC_DAY_OF_CREATED} = ${PACIFIC_TODAY}`;

async function one(q: Queryable, sql: string, params: unknown[] = [], col = 'n'): Promise<number | null> {
  const { rows } = await q.query(sql, params);
  const v = rows[0]?.[col];
  return v === null || v === undefined ? null : Number(v);
}

function sum<T>(rows: readonly T[], pick: (r: T) => number | null | undefined): number {
  return rows.reduce((acc, r) => acc + (Number(pick(r)) || 0), 0);
}

export function buildChecks(): AccuracyCheck<AccuracyDeps>[] {
  return [
    {
      id: 'observatory.overview.calls-today',
      screen: 'Observatory › Overview',
      widget: 'Today — calls per agent (sum of the cards)',
      claim: 'Every call taken today (Pacific day), counted once on its agent’s card.',
      truthSource: 'call_logs rows whose created_at falls on today’s Pacific date, counted directly.',
      unit: 'count',
      tolerance: { abs: 3 },
      async screenValue(d) {
        const t = await d.screens.todayOverview();
        return { value: sum(t.opsHub, (a) => a.callsToday) };
      },
      async truthValue(d) {
        return { value: await one(d.hub, TRUTH_CALLS_PACIFIC_TODAY_SQL) };
      },
    },
    {
      id: 'observatory.health.calls-7d',
      screen: 'Observatory › Health',
      widget: 'Calls (7 days, sum of the agent cards)',
      claim: 'Every call of the last 7 days, counted once on its agent’s card.',
      truthSource: 'call_logs rows created in the last 7 days, counted directly.',
      unit: 'count',
      tolerance: { abs: 3, rel: 0.002 },
      async screenValue(d) {
        return { value: sum(await d.screens.scorecards(7), (a) => a.calls) };
      },
      async truthValue(d) {
        return { value: await one(d.hub, TRUTH_CALLS_LAST_DAYS_SQL, [7]) };
      },
    },
    {
      id: 'observatory.health.dropped-7d',
      screen: 'Observatory › Health',
      widget: 'Dropped / failed calls (7 days, sum of the agent cards)',
      claim: 'Calls that dropped on the voice provider’s side or never connected.',
      truthSource:
        'call_logs rows of the last 7 days with runtime_outcome = provider_failure or status = failed. ' +
        '(The old "Telephony errors" tile read twilio_error_code, which is never written.)',
      unit: 'count',
      tolerance: { abs: 3, rel: 0.01 },
      async screenValue(d) {
        const cards = await d.screens.scorecards(7);
        // The fixed card reports droppedCalls; the old one reported telephonyErrors.
        return { value: sum(cards, (a) => a.droppedCalls ?? a.telephonyErrors ?? 0) };
      },
      async truthValue(d) {
        return { value: await one(d.hub, TRUTH_DROPPED_LAST_DAYS_SQL, [7]) };
      },
    },
    {
      id: 'operations-monitor.calls-24h',
      screen: 'Operations Monitor',
      widget: '24h Calls',
      claim: 'Every call of the last 24 hours.',
      truthSource: 'call_logs rows created in the last 24 hours, counted directly.',
      unit: 'count',
      tolerance: { abs: 3 },
      async screenValue(d) {
        const m = await d.screens.operationsMonitor();
        const v = m?.calls?.total;
        return v === null || v === undefined ? { value: null, note: 'the screen returned no call count' } : { value: Number(v) };
      },
      async truthValue(d) {
        return { value: await one(d.hub, TRUTH_CALLS_LAST_24H_SQL) };
      },
    },
    {
      id: 'cost.budget.spend-today',
      screen: 'Cost Dashboard',
      widget: 'Daily voice-AI budget — today’s spend',
      claim: 'The voice-AI (xAI) cost of today’s calls so far, Pacific day.',
      truthSource:
        'The sum of openai_cost_cents (the voice-AI cost column, which holds xAI spend on the runtime) over call_logs rows ' +
        'of today’s Pacific date. (It read the UTC day until 2026-11-26.)',
      unit: 'dollars',
      // Calls landing between the two reads move it by a few cents.
      tolerance: { abs: 1, rel: 0.01 },
      async screenValue(d) {
        const s = await d.screens.budgetStatus();
        return { value: Number(s.todaySpendCents) / 100 };
      },
      async truthValue(d) {
        const cents = await one(d.hub, TRUTH_VOICE_AI_PACIFIC_TODAY_SQL, [], 'cents');
        return { value: cents === null ? null : cents / 100 };
      },
    },
  ];
}
