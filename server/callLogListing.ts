/**
 * THE CALL LOG LIST'S FILTERS AND SORT ORDERS, as storage.getCallLogs applies
 * them. Measured against the Hub on 2026-11-26 (14 days, 8,502 calls) before
 * this was written:
 *
 *  - "Oldest First" sorted newest first: the date case ignored the order.
 *  - Cost and duration sorts put rows with no value first on a descending
 *    sort (Postgres sorts NULL high), and had no tie-break, so rows with the
 *    same duration could appear on two pages or none.
 *  - "Ghost Calls" was "no recording and no transcript, or under 60 s": 2,578
 *    calls, 1,006 of them with the caller heard (368 of those filed a ticket),
 *    while 167 calls nobody was heard on read as "Real". A ghost is now a
 *    call on which the caller was never heard, the runtime's own rule
 *    (v131): on a runtime call `first_transcript_delay_ms` is written only
 *    once the caller has spoken (callRecord.ts), on 6,763 of 6,763 heard
 *    calls and 9 of 1,738 unheard; an old-core row is read from its
 *    transcript. 654 ms over the whole table.
 *  - "Transferred" read `transferred_to_human`, which a queue transfer never
 *    sets (v20: nothing on that path proves a human answered): 3 calls, while
 *    713 ended in a transfer (`runtime_outcome = 'transferred'`).
 */
import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { callLogs } from '../shared/schema';

/** The caller was heard: a runtime call's first caller transcript, or an old-core transcript's caller line. */
export const callerWasHeard: SQL = sql`(${callLogs.firstTranscriptDelayMs} IS NOT NULL OR (${callLogs.voiceProvider} IS NULL AND strpos(coalesce(${callLogs.transcript}, ''), 'CALLER:') > 0))`;

export function callQualityCondition(quality: 'ghost' | 'real' | undefined): SQL | undefined {
  if (quality === 'ghost') return sql`NOT ${callerWasHeard}`;
  if (quality === 'real') return callerWasHeard;
  return undefined;
}

/** A transfer of either kind: to a person who accepted, or into a queue. */
export function transferredCondition(transferred: boolean | undefined): SQL | undefined {
  if (transferred === true) {
    return or(eq(callLogs.transferredToHuman, true), eq(callLogs.runtimeOutcome, 'transferred'));
  }
  if (transferred === false) {
    return and(
      or(eq(callLogs.transferredToHuman, false), isNull(callLogs.transferredToHuman)),
      or(isNull(callLogs.runtimeOutcome), ne(callLogs.runtimeOutcome, 'transferred')),
    );
  }
  return undefined;
}

/**
 * The ORDER BY, always ending on the row id so a page boundary is stable.
 * A missing cost or duration sorts last in either direction.
 */
export function callLogOrder(sortBy: 'date' | 'cost' | 'duration' | undefined, sortOrder: 'asc' | 'desc' | undefined): SQL[] {
  const up = sortOrder === 'asc';
  const dir = up ? asc : desc;
  const nullsLast = (col: typeof callLogs.totalCostCents | typeof callLogs.duration) =>
    up ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
  switch (sortBy) {
    case 'cost':
      return [nullsLast(callLogs.totalCostCents), desc(callLogs.createdAt), desc(callLogs.id)];
    case 'duration':
      return [nullsLast(callLogs.duration), desc(callLogs.createdAt), desc(callLogs.id)];
    default:
      return [dir(callLogs.createdAt), dir(callLogs.id)];
  }
}
