/**
 * Replaying 2026-08-31 against the alarm that did not exist that night.
 *
 * Filing stopped at 20:16 UTC when the gateway hit its execution cap. The last
 * ticket landed at 20:15:38. 185 queue calls then arrived and left without one,
 * until 23:54:54. Nobody was told; staff eventually told the operator.
 *
 * The numbers in these tests are the production rows, not invented shapes:
 * over the 14 days to 2026-09-01 the run-length distribution of consecutive
 * queue calls that filed no ticket was 185 once (the outage), then 8, 7, 7,
 * and 6 six times, and nothing else above 5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assessTicketFiling,
  UNFILED_RUN_ALARM,
  OUTBOX_HELD_ALARM,
  type TicketFilingSnapshot,
} from './ticketFilingHealth';

const MIN = 60_000;
const NOW = Date.parse('2026-08-31T20:23:06Z');

/** Newest first, one call every 90 seconds, `unfiled` of them with no ticket. */
function calls(unfiled: number, thenFiled: number, from = NOW): TicketFilingSnapshot['recentQueueCalls'] {
  const out: TicketFilingSnapshot['recentQueueCalls'] = [];
  for (let i = 0; i < unfiled; i++) out.push({ createdAtMs: from - i * 90_000, hasTicket: false });
  for (let i = 0; i < thenFiled; i++) {
    out.push({ createdAtMs: from - (unfiled + i) * 90_000, hasTicket: true });
  }
  return out;
}

function snapshot(over: Partial<TicketFilingSnapshot> = {}): TicketFilingSnapshot {
  return {
    recentQueueCalls: calls(0, 20),
    outboxPending: 0,
    outboxFailed: 0,
    outboxDeadLetter: 0,
    nowMs: NOW,
    ...over,
  };
}

describe('plane A — calls arriving and leaving without a ticket', () => {
  it('does not fire on the worst run a normal fortnight produced', () => {
    // Eight. Seen once in 14 days, and nothing was wrong.
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls(8, 12) }));
    expect(v.stalled).toBe(false);
    expect(v.unfiledRun).toBe(8);
  });

  it('fires on the outage', () => {
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls(185, 5) }));
    expect(v.stalled).toBe(true);
    expect(v.unfiledRun).toBe(185);
    expect(v.reason).toMatch(/185 queue calls in a row/);
  });

  it('is exact at the boundary the threshold was chosen for', () => {
    expect(assessTicketFiling(snapshot({ recentQueueCalls: calls(UNFILED_RUN_ALARM - 1, 5) })).stalled).toBe(false);
    expect(assessTicketFiling(snapshot({ recentQueueCalls: calls(UNFILED_RUN_ALARM, 5) })).stalled).toBe(true);
  });

  it('cannot be tripped by silence, which is the whole reason it counts calls', () => {
    // A closed line. The clock-based version of this alarm — the obvious one —
    // fires here every night and gets muted within a week.
    expect(assessTicketFiling(snapshot({ recentQueueCalls: [] })).stalled).toBe(false);

    // And a real weekend: the last ticket was three days ago because nobody
    // rang, not because filing broke. The longest healthy gap between two
    // filed tickets in the measured fortnight is days long.
    const weekend = snapshot({
      recentQueueCalls: [
        { createdAtMs: NOW - 5 * MIN, hasTicket: false },
        { createdAtMs: NOW - 40 * MIN, hasTicket: false },
        { createdAtMs: NOW - 3 * 24 * 60 * MIN, hasTicket: true },
      ],
    });
    const v = assessTicketFiling(weekend);
    expect(v.stalled).toBe(false);
    expect(v.minutesSinceLastFiled).toBe(3 * 24 * 60);
  });

  it('reports the last filed call, not the last call', () => {
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls(4, 6) }));
    expect(v.lastFiledAtMs).toBe(NOW - 4 * 90_000);
    expect(v.minutesSinceLastFiled).toBe(6);
  });
});

describe('plane B — our own POSTs failing, before any run builds up', () => {
  it('fires on a dead letter even while calls are filing normally', () => {
    // A request that exhausted every retry. The table held no non-sent row at
    // all between 2026-05-12 and 2026-09-01, so one is already abnormal.
    const v = assessTicketFiling(snapshot({ outboxDeadLetter: 1 }));
    expect(v.stalled).toBe(true);
    expect(v.reason).toMatch(/gave up after every retry/);
    // And it says the thing a person needs to hear next.
    expect(v.reason).toMatch(/replayable|nothing is lost/i);
  });

  it('fires when the outbox is holding requests it cannot send', () => {
    const v = assessTicketFiling(snapshot({ outboxPending: 2, outboxFailed: 1 }));
    expect(v.stalled).toBe(true);
    expect(v.outboxHeld).toBe(OUTBOX_HELD_ALARM);
    expect(v.reason).toMatch(/refusing POSTs/);
    // The caller was told their request was recorded — that promise is now
    // this alarm's problem to keep.
    expect(v.reason).toMatch(/told their request was recorded/);
  });

  it('tolerates one retry in flight', () => {
    expect(assessTicketFiling(snapshot({ outboxPending: 1 })).stalled).toBe(false);
  });

  it('catches the outage sooner than plane A would', () => {
    // The point of two planes. During 08-31 the POSTs were being refused from
    // the first minute; plane A had to wait for twelve calls to arrive.
    const early = snapshot({ recentQueueCalls: calls(3, 10), outboxFailed: 4 });
    const v = assessTicketFiling(early);
    expect(v.stalled).toBe(true);
    expect(v.unfiledRun).toBe(3); // plane A is nowhere near firing
  });
});


/**
 * A DEAD LETTER DOES NOT AGE OUT — Codex, PR #244.
 *
 * The snapshot query applied one six-hour window to every unsent status, so an
 * overnight outage's dead letters dropped out of it and both the scheduled
 * check and the Observatory banner returned to green while those requests sat
 * unfiled, their payloads still needing a manual replay. Healthy-because-old is
 * the same lie as a zero that means "nothing recorded" — the failure the
 * logging banner was built for a week earlier.
 *
 * Read as SQL text: the query needs a database, the predicate does not.
 */
describe('what the snapshot query is allowed to forget', () => {
  const source = readFileSync(new URL('./ticketFilingHealth.ts', import.meta.url), 'utf8');
  const outboxQuery = source.slice(source.indexOf('FROM ticket_outbox'), source.indexOf('GROUP BY status'));

  it('counts a dead letter however old it is', () => {
    expect(outboxQuery).toMatch(/status = 'dead_letter'/);
    // And not behind the window — the OR has to reach it.
    const windowClause = outboxQuery.slice(outboxQuery.indexOf('INTERVAL'));
    expect(windowClause).not.toMatch(/dead_letter'\s*$/);
  });

  it('still bounds the transient states, which are mid-retry by definition', () => {
    expect(outboxQuery).toMatch(/NOT IN \('sent', 'dead_letter'\)/);
    expect(outboxQuery).toMatch(/INTERVAL '6 hours'/);
  });

  it('is the same predicate the Observatory uses', () => {
    // Two copies of one rule is how a banner goes green while an alarm is red.
    const observatory = readFileSync(
      new URL('../observatory/queries.ts', import.meta.url),
      'utf8',
    );
    const theirs = observatory.slice(
      observatory.indexOf('FROM ticket_outbox'),
      observatory.indexOf('GROUP BY 1`'),
    );
    const normalise = (q: string) => q.replace(/\s+/g, ' ').trim();
    expect(normalise(theirs)).toContain("status = 'dead_letter'");
    expect(normalise(theirs)).toContain("NOT IN ('sent', 'dead_letter')");
    expect(normalise(theirs)).toContain("INTERVAL '6 hours'");
  });
});

/**
 * A CALL STILL ON THE LINE HAS NOT ARRIVED AND LEFT — Codex, PR #244.
 *
 * `voiceAgentRoutes.ts:2571` creates the call_logs row at call START with
 * `status: 'in_progress'`; it becomes 'completed' at the end. The snapshot
 * takes the newest 40 rows, so without a status filter every call currently on
 * the line is counted as one that filed nothing — and none of them CAN have a
 * ticket yet, because the filing tool has not run.
 *
 * Five concurrent calls on a busy morning, on top of the worst NORMAL run of
 * eight completed non-filing calls, is thirteen — past the threshold of twelve.
 * The alarm cries outage while nothing is wrong, and the Observatory banner
 * goes red with it.
 *
 * 'completed' exactly, and not "anything not in-flight": the run-length
 * distribution the threshold came from was measured over a population that is
 * 100% 'completed' — not one row of any other status exists in fourteen days.
 * Widening it would apply the number to a population it was never measured on.
 */
describe('which calls the alarm is allowed to count', () => {
  const source = readFileSync(new URL('./ticketFilingHealth.ts', import.meta.url), 'utf8');
  const callsQuery = source.slice(source.indexOf('FROM call_logs'), source.indexOf('LIMIT ${LOOKBACK_CALLS}'));

  it('counts only calls that have finished', () => {
    expect(callsQuery).toMatch(/status = 'completed'/);
  });

  it('restricts by equality, so no in-flight status can slip through', () => {
    // Deliberately not `not.toMatch(/in_progress/)`: that string was never in
    // the query, so such a test passes whether or not the fix is present — it
    // survived a mutation that removed the filter entirely. An equality on
    // 'completed' is the assertion with teeth, because every other status is
    // excluded by construction rather than by enumeration.
    expect(callsQuery).toMatch(/AND\s+status = 'completed'/);
    expect(callsQuery).not.toMatch(/status\s*(!=|<>|NOT IN)/i);
  });

  it('is the same restriction the Observatory banner uses', () => {
    // Two copies of one rule is how a banner goes red while the alarm is green.
    //
    // ANCHORED ON `AS has_ticket`, which appears exactly once in that file.
    // The first version of this test sliced from `FROM call_logs` — which
    // occurs SIXTEEN times in queries.ts — so it read an unrelated query and
    // passed no matter what. It only came out because removing the filter from
    // the Observatory copy failed to redden anything.
    const observatory = readFileSync(new URL('../observatory/queries.ts', import.meta.url), 'utf8');
    const anchor = observatory.indexOf('AS has_ticket');
    expect(anchor).toBeGreaterThan(-1);
    const theirs = observatory.slice(anchor, observatory.indexOf('LIMIT 40`', anchor));
    expect(theirs.replace(/\s+/g, ' ')).toContain("status = 'completed'");
  });
});
