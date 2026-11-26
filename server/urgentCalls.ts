/**
 * server/urgentCalls.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH CALLS THE URGENT CALLS PAGE LISTS, AND OVER WHICH DAYS.
 *
 * Measured 2026-11-26 over 90 days, the page listed `transferred_to_human =
 * true` and that was wrong both ways:
 *   - it MISSED 101 after-hours escalations to the on-call provider that nobody
 *     answered (transfer_outcome DECLINED 66, NO_ANSWER 35), which are the ones
 *     that most need a follow-up;
 *   - it INCLUDED 70 PCP queue transfers, under the heading "calls transferred
 *     to the on-call provider".
 * An urgent call is now an after-hours call that dialled the on-call provider:
 * the after-hours lanes, with transferred_to_human set or a transfer outcome
 * recorded.
 *
 * The window was a UTC day: the default end date was the UTC date and the
 * server read it as midnight UTC, so the page stopped at 4 PM Pacific
 * yesterday and last night's after-hours urgent calls (52 of 122 in 90 days
 * fell between 00:00 and 08:00 UTC) did not appear until the next afternoon.
 * Dates are now Pacific calendar dates and the end date is the whole day.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sql, type SQL } from 'drizzle-orm';

/** The lanes that ring the on-call provider (standing instruction 13). */
export const AFTER_HOURS_LANES = ['no-ivr', 'no-ivr-v2', 'dev-no-ivr'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Pacific time, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** A Pacific date `days` before `date`. */
export function pacificDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type UrgentWindow = { from: string; to: string } | { error: string };

/**
 * The window from the query: Pacific calendar dates, both ends included.
 * A missing end is today (Pacific); a missing start is 90 days before the end.
 * Anything that is not a real YYYY-MM-DD date is refused rather than guessed.
 */
export function urgentWindow(query: Record<string, unknown>, now: Date = new Date()): UrgentWindow {
  const rawTo = typeof query.endDate === 'string' && query.endDate ? query.endDate : null;
  const rawFrom = typeof query.startDate === 'string' && query.startDate ? query.startDate : null;
  if (rawTo && !isRealDate(rawTo)) return { error: 'endDate must be a date, YYYY-MM-DD (Pacific)' };
  if (rawFrom && !isRealDate(rawFrom)) return { error: 'startDate must be a date, YYYY-MM-DD (Pacific)' };
  const to = rawTo ?? pacificToday(now);
  const from = rawFrom ?? pacificDaysBefore(to, 90);
  if (from > to) return { error: 'startDate is after endDate' };
  return { from, to };
}

/** The urgent calls between two Pacific dates, both whole days included. */
export function urgentCondition(from: string, to: string): SQL {
  const lanes = sql.join(AFTER_HOURS_LANES.map((l) => sql`${l}`), sql`, `);
  return sql`agent_used IN (${lanes})
    AND (transferred_to_human = true OR transfer_outcome IS NOT NULL)
    AND created_at >= ((${from}::date)::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
    AND created_at < (((${to}::date + 1))::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'`;
}

type LogLike = {
  toolTimeline?: unknown;
  tool_timeline?: unknown;
  transferOutcome?: unknown;
  transfer_outcome?: unknown;
  transferredToHuman?: boolean | null;
  transferred_to_human?: boolean | null;
};

/**
 * Why the agent escalated: the reason it gave `escalate_to_human`, the last
 * one on the call. (The page read `detected_conditions`, NULL on every urgent
 * call, and an `escalationReason` field that is not a column.)
 */
export function urgentReason(log: LogLike): string | null {
  const tl = (log.toolTimeline ?? log.tool_timeline) as { events?: Array<{ tool?: string; args?: Record<string, unknown> }> } | null;
  const events = Array.isArray(tl?.events) ? tl!.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.tool === 'escalate_to_human' && typeof e.args?.reason === 'string' && e.args.reason.trim()) {
      return e.args.reason.trim().slice(0, 300);
    }
  }
  return null;
}

export type TransferResult = 'connected' | 'not_answered' | 'unknown';

/** Whether the on-call provider picked up, from the dial's own recorded outcome. */
export function transferResult(log: LogLike): TransferResult {
  const t = (log.transferOutcome ?? log.transfer_outcome) as { status?: unknown } | null;
  const status = typeof t?.status === 'string' ? t.status.toUpperCase() : null;
  if (status === 'CONNECTED' || status === 'COMPLETED' || status === 'ACCEPTED') return 'connected';
  if (status && ['DECLINED', 'NO_ANSWER', 'NO-ANSWER', 'FAILED', 'BUSY', 'CANCELED', 'UNAVAILABLE'].includes(status)) return 'not_answered';
  // Older rows recorded only the boolean.
  if (!status && (log.transferredToHuman ?? log.transferred_to_human) === true) return 'connected';
  return 'unknown';
}

/** The fields the page shows that are not columns. */
export function urgentFields(log: LogLike) {
  return { urgentReason: urgentReason(log), transferResult: transferResult(log) };
}
