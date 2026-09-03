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
  TRAFFIC_RECENCY_MS,
  isGreetingOnly,
  type TicketFilingSnapshot,
} from './ticketFilingHealth';

const MIN = 60_000;
const NOW = Date.parse('2026-08-31T20:23:06Z');

/**
 * A call with enough engagement to count — 8 turns over 95 seconds is an
 * ordinary queue conversation. Every existing case below was written before
 * greeting-only calls were skipped, and each one means "a real conversation
 * that filed nothing", so substantive is the right default to preserve them.
 */
const SUBSTANTIVE = { totalTurns: 8, durationSeconds: 95 } as const;

/** Newest first, one call every 90 seconds, `unfiled` of them with no ticket. */
function calls(unfiled: number, thenFiled: number, from = NOW): TicketFilingSnapshot['recentQueueCalls'] {
  const out: TicketFilingSnapshot['recentQueueCalls'] = [];
  for (let i = 0; i < unfiled; i++) {
    out.push({ createdAtMs: from - i * 90_000, hasTicket: false, ...SUBSTANTIVE });
  }
  for (let i = 0; i < thenFiled; i++) {
    out.push({ createdAtMs: from - (unfiled + i) * 90_000, hasTicket: true, ...SUBSTANTIVE });
  }
  return out;
}

function snapshot(over: Partial<TicketFilingSnapshot> = {}): TicketFilingSnapshot {
  return {
    recentQueueCalls: calls(0, 20),
    outboxPending: 0,
    outboxFailed: 0,
    outboxDeadLetter: 0,
    lastTicketFiledAtMs: null,
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
        { createdAtMs: NOW - 5 * MIN, hasTicket: false, ...SUBSTANTIVE },
        { createdAtMs: NOW - 40 * MIN, hasTicket: false, ...SUBSTANTIVE },
        { createdAtMs: NOW - 3 * 24 * 60 * MIN, hasTicket: true, ...SUBSTANTIVE },
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

/**
 * SILENCE FREEZES THE RUN — found in production on 2026-09-02, the morning
 * this alarm first ran live, and it is a false claim in this file's own header.
 *
 * That header says a run of calls "cannot be tripped by silence, which is the
 * failure mode every time-based version of this has." Wrong, and the way it is
 * wrong is the opposite of what I was guarding against. Silence does not
 * manufacture unfiled calls — it PRESERVES a run that already exists, because
 * only a call that files a ticket can reset it, and no calls arrive.
 *
 * What happened: the ticketing app wedged 23:25–23:58 on 2026-09-01 and 17
 * queue calls timed out unfiled. The queue lines then closed for the night.
 * At 12:30 the next day — with the outage twelve hours over, the app healthy
 * and not one queue call since — the alarm fired, emailed the operator, and
 * kept re-firing every five minutes because nothing could reset it until the
 * lines reopened at 14:00.
 *
 * Left alone this fires every single morning on the tail of the previous
 * evening, which is the "muted within a week" death the header claims to
 * avoid.
 *
 * The fix is to say what the run plane can actually speak to: filing has
 * STOPPED only if calls are still arriving. If the newest queue call is stale,
 * there is no live traffic and this plane has nothing to report — the outbox
 * planes are unaffected and still fire, and they are the ones that should
 * carry an overnight problem.
 */
describe('the run plane needs live traffic to mean anything', () => {
  it('does not fire when the whole run is hours old and the lines are quiet', () => {
    // The exact production shape: 17 unfiled, newest of them 12 hours ago.
    const twelveHours = 12 * 60 * MIN;
    const v = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(17, 20, NOW - twelveHours) }),
    );
    expect(v.stalled).toBe(false);
    // The count is still reported — it is true, and staff may want it.
    expect(v.unfiledRun).toBe(17);
  });

  it('still fires on the same run while calls are arriving', () => {
    // 2026-08-31: filing stopped and calls kept coming. Newest is seconds old,
    // so recency never protected that outage and must not now.
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls(17, 20) }));
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('17 queue calls in a row');
  });

  it('fires right up to the recency boundary and not past it', () => {
    const justInside = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(17, 20, NOW - 50 * MIN) }),
    );
    expect(justInside.stalled).toBe(true);

    const justOutside = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(17, 20, NOW - 70 * MIN) }),
    );
    expect(justOutside.stalled).toBe(false);
  });

  it('leaves the outbox planes alone — those must still fire overnight', () => {
    // A dead letter is a request we hold and have not filed. That is true at
    // 3am with no traffic, and it is the plane that should carry it.
    const old = calls(17, 20, NOW - 12 * 60 * MIN);
    expect(
      assessTicketFiling(snapshot({ recentQueueCalls: old, outboxDeadLetter: 1 })).stalled,
    ).toBe(true);
    expect(
      assessTicketFiling(snapshot({ recentQueueCalls: old, outboxPending: OUTBOX_HELD_ALARM })).stalled,
    ).toBe(true);
  });

  it('does not fire when there are no queue calls at all', () => {
    expect(assessTicketFiling(snapshot({ recentQueueCalls: [] })).stalled).toBe(false);
  });
});

/**
 * A RUN MUST NOT REACH ACROSS A CLOSED NIGHT — production, 2026-09-02, the
 * SECOND time the same night's 17 calls fired this alarm.
 *
 * The recency bound above fixed when the run plane is allowed to speak. It did
 * not fix what the run COUNTS. At 15:04 the queue lines reopened; by then three
 * calls had come in and, entirely normally, none had filed a ticket — only
 * about half of healthy queue calls do. The run walked straight back through
 * the overnight closure and added last night's 17, reaching 20, and with the
 * traffic now live the alarm fired again on an outage that had been over for
 * fifteen hours.
 *
 * Measured before writing this: at 15:06 UTC on 2026-09-02 the Hub had
 * `queue_calls_today: 3 | filed: 0 | newest_queue_call: 15:04:09`, and the
 * merged recency fix returns `STALLED: true | run: 20` on exactly that shape.
 *
 * So the run is a run of calls that were arriving TOGETHER. A gap of an hour
 * with no queue call at all is the lines being shut, and two calls either side
 * of it are not consecutive in any sense the threshold was measured over — the
 * run-length distribution (185, then 8, 7, 7, 6…) was measured within business
 * hours, on calls minutes apart.
 *
 * This cannot hide 2026-08-31: that outage ran 185 calls over three hours and
 * thirty-nine minutes, roughly one every seventy seconds, with no gap anywhere
 * near an hour.
 */
describe('a run is calls arriving together, not calls either side of a closure', () => {
  /** 2026-09-02 as it actually was: last night's tail, the night, this morning. */
  function reopenedAfterABadNight(freshUnfiled: number) {
    const nightGap = 15 * 60 * MIN;
    const lastNight = calls(17, 20, NOW - nightGap);
    const thisMorning: TicketFilingSnapshot['recentQueueCalls'] = [];
    for (let i = 0; i < freshUnfiled; i++) {
      thisMorning.push({ createdAtMs: NOW - i * 3 * MIN, hasTicket: false, ...SUBSTANTIVE });
    }
    return [...thisMorning, ...lastNight];
  }

  it('does not count last night into this morning', () => {
    const v = assessTicketFiling(snapshot({ recentQueueCalls: reopenedAfterABadNight(3) }));
    expect(v.unfiledRun).toBe(3);
    expect(v.stalled).toBe(false);
  });

  it('still fires when this morning is the one that is broken', () => {
    // The control. Same closure behind it, but the live side is itself a run
    // past the threshold — that is a real stoppage and must still be caught.
    const v = assessTicketFiling(
      snapshot({ recentQueueCalls: reopenedAfterABadNight(UNFILED_RUN_ALARM) }),
    );
    expect(v.unfiledRun).toBe(UNFILED_RUN_ALARM);
    expect(v.stalled).toBe(true);
  });

  it('does not hide the outage it was built for', () => {
    // 185 calls over 3h39m — one every ~71 seconds, no gap near an hour.
    const outage: TicketFilingSnapshot['recentQueueCalls'] = [];
    for (let i = 0; i < 185; i++) outage.push({ createdAtMs: NOW - i * 71_000, hasTicket: false, ...SUBSTANTIVE });
    outage.push({ createdAtMs: NOW - 185 * 71_000, hasTicket: true, ...SUBSTANTIVE });
    const v = assessTicketFiling(snapshot({ recentQueueCalls: outage }));
    expect(v.stalled).toBe(true);
    expect(v.unfiledRun).toBe(185);
  });

  it('breaks the run at the gap and not before it', () => {
    const spaced = (gapMs: number) => [
      { createdAtMs: NOW, hasTicket: false, ...SUBSTANTIVE },
      { createdAtMs: NOW - gapMs, hasTicket: false, ...SUBSTANTIVE },
      { createdAtMs: NOW - gapMs - MIN, hasTicket: false, ...SUBSTANTIVE },
    ];
    expect(assessTicketFiling(snapshot({ recentQueueCalls: spaced(TRAFFIC_RECENCY_MS - MIN) })).unfiledRun).toBe(3);
    expect(assessTicketFiling(snapshot({ recentQueueCalls: spaced(TRAFFIC_RECENCY_MS + MIN) })).unfiledRun).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-03: the email that said filing had stopped while it had not
// ─────────────────────────────────────────────────────────────────────────────

describe('greeting-only hangups do not count toward the run', () => {
  const GREETING = { totalTurns: 1, durationSeconds: 17 } as const;

  /** Newest first, mixing substantive and greeting-only unfiled calls. */
  function mixed(shape: Array<'sub' | 'greet'>, from = NOW): TicketFilingSnapshot['recentQueueCalls'] {
    return shape.map((kind, i) => ({
      createdAtMs: from - i * 90_000,
      hasTicket: false,
      ...(kind === 'greet' ? GREETING : SUBSTANTIVE),
    }));
  }

  it('a caller who hangs up in the greeting is not a request that failed to file', () => {
    expect(isGreetingOnly({ createdAtMs: NOW, hasTicket: false, ...GREETING })).toBe(true);
    expect(isGreetingOnly({ createdAtMs: NOW, hasTicket: false, ...SUBSTANTIVE })).toBe(false);
  });

  it('counts a call short on EITHER axis — one turn, or under twenty seconds', () => {
    const one = { createdAtMs: NOW, hasTicket: false, totalTurns: 1, durationSeconds: 300 };
    const brief = { createdAtMs: NOW, hasTicket: false, totalTurns: 9, durationSeconds: 19 };
    expect(isGreetingOnly(one)).toBe(true);
    expect(isGreetingOnly(brief)).toBe(true);
  });

  it('is exclusive at both bounds — 2 turns and 20 seconds are substantive', () => {
    expect(
      isGreetingOnly({ createdAtMs: NOW, hasTicket: false, totalTurns: 2, durationSeconds: 20 }),
    ).toBe(false);
  });

  it('FAILS LOUD: a call the database could not describe counts as substantive', () => {
    // Skipping is the quiet direction. A row with neither figure is not
    // evidence that nothing was asked for, and an outage that also broke
    // telemetry must not silence the alarm.
    expect(
      isGreetingOnly({ createdAtMs: NOW, hasTicket: false, totalTurns: null, durationSeconds: null }),
    ).toBe(false);
  });

  /**
   * THE ACTUAL RUN, 2026-09-03 18:13:37 → 18:22:13. Twelve queue calls, of
   * which four were greeting-only: 11s/1 turn, 17s/1 turn, 17s/1 turn and
   * 34s/3 turns. unfiledRun reached 12, the threshold, and emailed the
   * operator "TICKET FILING HAS STOPPED".
   */
  it('does not fire on the run that emailed the operator — eight substantive, not twelve', () => {
    const shape: Array<'sub' | 'greet'> = [
      'sub', 'greet', 'greet', 'sub', 'sub', 'greet',
      'greet', 'sub', 'sub', 'sub', 'sub', 'sub',
    ];
    const v = assessTicketFiling(snapshot({ recentQueueCalls: mixed(shape) }));
    expect(v.unfiledRun).toBe(8);
    expect(v.greetingOnlySkipped).toBe(4);
    expect(v.stalled).toBe(false);
  });

  it('still fires once twelve SUBSTANTIVE calls miss, however many hangups are mixed in', () => {
    const shape: Array<'sub' | 'greet'> = [];
    for (let i = 0; i < 12; i++) shape.push('sub', 'greet');
    const v = assessTicketFiling(snapshot({ recentQueueCalls: mixed(shape) }));
    expect(v.unfiledRun).toBe(12);
    expect(v.greetingOnlySkipped).toBe(12);
    expect(v.stalled).toBe(true);
  });

  /**
   * 2026-08-31, the outage this alarm exists for: 184 completed queue calls
   * over three hours and thirty-nine minutes, none of which filed. 39 of them
   * are greeting-only, leaving 145 — twelve times the threshold. Skipping
   * hangups must not blind the alarm to this.
   */
  it('still catches the 2026-08-31 outage with its greeting-only calls removed', () => {
    const shape: Array<'sub' | 'greet'> = [];
    for (let i = 0; i < 184; i++) shape.push(i % 184 < 39 ? 'greet' : 'sub');
    const v = assessTicketFiling(snapshot({ recentQueueCalls: mixed(shape) }));
    expect(v.greetingOnlySkipped).toBe(39);
    expect(v.unfiledRun).toBe(145);
    expect(v.stalled).toBe(true);
  });

  it('a hangup BRIDGES the gap rule — it is traffic, so the run continues across it', () => {
    /**
     * The ordering that matters: `previousCallAtMs` must advance on a
     * greeting-only call BEFORE it is skipped. Otherwise the gap is measured
     * from the last SUBSTANTIVE call, the hangup's own arrival is invisible,
     * and two ordinary calls fifty minutes apart on either side of it look
     * like a hundred-minute closure — so the run breaks early and the alarm
     * under-counts.
     *
     * Here the hangup arrives 50 minutes after the newest call and 50 minutes
     * before the next one. Nothing exceeds the one-hour bound, so all three
     * are one stretch of live traffic and both substantive calls count.
     */
    const calls: TicketFilingSnapshot['recentQueueCalls'] = [
      { createdAtMs: NOW, hasTicket: false, ...SUBSTANTIVE },
      { createdAtMs: NOW - 50 * MIN, hasTicket: false, totalTurns: 1, durationSeconds: 17 },
      { createdAtMs: NOW - 100 * MIN, hasTicket: false, ...SUBSTANTIVE },
    ];
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls }));
    expect(v.greetingOnlySkipped).toBe(1);
    expect(v.unfiledRun).toBe(2);
  });

  it('a hangup still feeds the gap rule, so the run cannot walk back through a closure', () => {
    // Twelve substantive misses, but an overnight closure sits between the
    // second and the third. The run must stop at the gap even though the call
    // on the far side of it is one the count would otherwise have skipped.
    const calls: TicketFilingSnapshot['recentQueueCalls'] = [
      { createdAtMs: NOW, hasTicket: false, ...SUBSTANTIVE },
      { createdAtMs: NOW - 90_000, hasTicket: false, ...SUBSTANTIVE },
      { createdAtMs: NOW - 5 * 60 * 60_000, hasTicket: false, ...GREETING },
      ...Array.from({ length: 12 }, (_, i) => ({
        createdAtMs: NOW - 5 * 60 * 60_000 - (i + 1) * 90_000,
        hasTicket: false,
        ...SUBSTANTIVE,
      })),
    ];
    const v = assessTicketFiling(snapshot({ recentQueueCalls: calls }));
    expect(v.unfiledRun).toBe(2);
    expect(v.stalled).toBe(false);
  });
});

describe('a confirmed filing inside the run disconfirms the stall', () => {
  it('holds the alarm when a ticket was filed inside the run span', () => {
    // The run reaches back 12 * 90s from NOW; the pulse lands in the middle.
    const v = assessTicketFiling(
      snapshot({
        recentQueueCalls: calls(12, 5),
        lastTicketFiledAtMs: NOW - 6 * 90_000,
      }),
    );
    expect(v.unfiledRun).toBe(12);
    expect(v.stalled).toBe(false);
    expect(v.suppressedByConfirmedFiling).toBe(true);
  });

  it('the 2026-09-03 case: filed 41 seconds before the alarm evaluated', () => {
    const v = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(12, 5), lastTicketFiledAtMs: NOW - 41_000 }),
    );
    expect(v.stalled).toBe(false);
    expect(v.suppressedByConfirmedFiling).toBe(true);
  });

  it('does NOT hold it when the last confirmed filing predates the run', () => {
    // One second older than the oldest call in the run — outside the span.
    const v = assessTicketFiling(
      snapshot({
        recentQueueCalls: calls(12, 5),
        lastTicketFiledAtMs: NOW - 11 * 90_000 - 1,
      }),
    );
    expect(v.stalled).toBe(true);
    expect(v.suppressedByConfirmedFiling).toBe(false);
  });

  it('fires exactly at the span boundary — a filing at the run’s oldest call still counts', () => {
    const v = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(12, 5), lastTicketFiledAtMs: NOW - 11 * 90_000 }),
    );
    expect(v.stalled).toBe(false);
  });

  it('an empty pulse behaves exactly as before — a restart must not silence the alarm', () => {
    const v = assessTicketFiling(
      snapshot({ recentQueueCalls: calls(12, 5), lastTicketFiledAtMs: null }),
    );
    expect(v.stalled).toBe(true);
    expect(v.suppressedByConfirmedFiling).toBe(false);
  });

  it('cannot silence the outbox planes — those are requests we are holding', () => {
    // A ticket filing normally elsewhere says nothing about payloads stuck in
    // our own outbox, so the pulse must not reach plane A or B.
    const dead = assessTicketFiling(
      snapshot({ outboxDeadLetter: 1, lastTicketFiledAtMs: NOW }),
    );
    expect(dead.stalled).toBe(true);
    const held = assessTicketFiling(
      snapshot({ outboxFailed: 3, lastTicketFiledAtMs: NOW }),
    );
    expect(held.stalled).toBe(true);
  });

  it('cannot silence the 2026-08-31 outage — nothing filed anywhere in its span', () => {
    const v = assessTicketFiling(
      snapshot({
        recentQueueCalls: calls(40, 0),
        // The last confirmed filing was before the outage began.
        lastTicketFiledAtMs: NOW - 40 * 90_000 - 60_000,
      }),
    );
    expect(v.stalled).toBe(true);
  });
});
