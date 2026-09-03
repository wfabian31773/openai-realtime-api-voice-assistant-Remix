/**
 * THE ALARM THAT WOULD HAVE MADE 2026-08-31 A TWENTY-MINUTE OUTAGE.
 *
 * At 20:16 UTC the n8n gateway hit its monthly execution cap and began
 * refusing every create-ticket at the webhook, before any node ran, answering
 * 200 with a body that is not JSON. Filing stopped dead. It was found hours
 * later because staff told Wayne.
 *
 * Nothing anywhere watched the ticket path. `docs/observatory/02-diagnosis-rules.md`
 * has R1–R12 and not one of them covers it, which is the queue lines' entire
 * job. The exact twin had been built a week earlier for call logging — the
 * command center shows "logging is DOWN" when the newest `call_logs` row is
 * more than two hours old, so all-zero cards can never again pass as quiet
 * lines — and nobody built the analogous check for the neighbouring pipe.
 *
 * THE THRESHOLD IS MEASURED, NOT GUESSED. Runs of consecutive queue calls
 * that filed no ticket, over the 14 days to 2026-09-01:
 *
 *     run length   times seen
 *     185          1     <- the outage, 20:15:45 to 23:54:54
 *     8            1
 *     7            2
 *     6            6
 *     5 and below  485
 *
 * Exactly one run of nine or more in a fortnight, and it was the outage. So
 * twelve is roughly 1.5x the worst normal day and an eighth of the real event.
 * Replayed against the production rows, a run of twelve fires at
 * **20:23:06** — seven minutes after the last ticket was filed, against the
 * hours it actually took.
 *
 * WHY A RUN OF CALLS AND NOT A CLOCK. Only about half of queue calls file a
 * ticket even when everything works, and the lines go quiet overnight and at
 * weekends: the longest gap between two filed tickets in the same fortnight is
 * days long and entirely healthy. A count of calls that arrived and left
 * without a ticket cannot be MANUFACTURED by silence, which is the failure
 * mode every time-based version of this has.
 *
 * BUT SILENCE FREEZES A RUN THAT ALREADY EXISTS — production, 2026-09-02, the
 * first morning this ran live, and this paragraph used to claim otherwise.
 * Only a call that FILES a ticket resets the run, so when the lines close on
 * the tail of a bad evening the count is preserved intact until they reopen.
 * The ticketing app wedged at 23:25 on 09-01 and 17 queue calls timed out
 * unfiled; at 12:30 the next day, outage long over and the app healthy, the
 * alarm fired on that frozen run and re-fired every five minutes because
 * nothing could reset it. Left alone it does that every morning — the
 * "muted within a week" death this alarm was shaped to avoid.
 *
 * So the run plane speaks only while calls are arriving, and the run itself
 * stops at any hour-long gap between consecutive calls: see
 * `TRAFFIC_RECENCY_MS`, which bounds both. Filing has STOPPED is a claim about
 * now, and it needs a now to be about — and a run of calls that were arriving
 * together, not two piles either side of a closed night.
 *
 * TWO PLANES, as BACKEND_HANDOFF.md:244-248 requires, both of them local to
 * the Operations Hub so the alarm never depends on the system it is watching:
 *
 *   A. Calls arriving and leaving without a ticket — catches a far side that
 *      accepts and drops, which is exactly what the gateway did.
 *   B. The outbox holding entries it has not sent — catches our own POSTs
 *      failing within a minute, before any run has built up. Before
 *      2026-09-01 that table had never held a non-sent row.
 */

/** One queue call, as the alarm needs to see it. */
export interface QueueCallSample {
  createdAtMs: number;
  /** A ticket number landed on the call row. */
  hasTicket: boolean;
  /** Agent+caller turns on the call. Null when the row never recorded any. */
  totalTurns: number | null;
  /** Seconds. Null when the row never recorded one. */
  durationSeconds: number | null;
}

/**
 * A call that never got as far as a request.
 *
 * A caller who hangs up during the greeting has not "arrived and left without
 * a ticket" in any sense the run is about — there was no request to file. Over
 * the fourteen days to 2026-09-03, completed queue calls split like this:
 *
 *   greeting-only (<= 1 turn, or under 20s):   504 calls,     5 filed  (1.0%)
 *   substantive:                             2,479 calls, 1,564 filed (63.1%)
 *
 * They are 17% of queue traffic and they file one percent of the time, and the
 * run counted them identically to a real conversation that failed. That is
 * what emailed the operator at 2026-09-03 18:24:56: a run of twelve of which
 * FOUR were greeting-only hangups — 11s/1 turn, 17s/1 turn, 17s/1 turn,
 * 34s/3 turns. Excluding them the run was eight, which is the worst run seen
 * on an ordinary fortnight and below any threshold.
 *
 * This does NOT blind the alarm to the event it exists for. Of the 184
 * completed queue calls in the 2026-08-31 outage, none of which filed, 145
 * are substantive — twelve times the threshold.
 *
 * FAIL LOUD ON MISSING DATA. A row with neither figure recorded counts as
 * substantive. Skipping is the quiet direction, and a call the database could
 * not describe is not evidence that nothing was asked for.
 */
export const GREETING_ONLY_MAX_TURNS = 1;
export const GREETING_ONLY_MAX_SECONDS = 20;

export function isGreetingOnly(call: QueueCallSample): boolean {
  if (call.totalTurns !== null && call.totalTurns <= GREETING_ONLY_MAX_TURNS) return true;
  if (call.durationSeconds !== null && call.durationSeconds < GREETING_ONLY_MAX_SECONDS) return true;
  return false;
}

export interface TicketFilingSnapshot {
  /** Recent queue calls, NEWEST FIRST. */
  recentQueueCalls: QueueCallSample[];
  /** Outbox rows from the recent window that have not been sent. */
  outboxPending: number;
  outboxFailed: number;
  outboxDeadLetter: number;
  /**
   * When a ticket was last ACTUALLY filed, as recorded by the filing path
   * itself (ticketFilingPulse.ts) rather than inferred from call_logs. Null
   * when nothing has filed since this process started.
   */
  lastTicketFiledAtMs: number | null;
  nowMs: number;
}

export interface TicketFilingVerdict {
  stalled: boolean;
  /** One sentence, written to be read on a banner. */
  reason: string | null;
  /** Consecutive newest calls that filed nothing. */
  unfiledRun: number;
  lastFiledAtMs: number | null;
  minutesSinceLastFiled: number | null;
  /** Outbox rows waiting, failed or dead-lettered in the window. */
  outboxHeld: number;
  /** Greeting-only calls skipped while counting the run. */
  greetingOnlySkipped: number;
  /** True when a confirmed filing inside the run's span held the alarm back. */
  suppressedByConfirmedFiling: boolean;
}

/**
 * Twelve consecutive queue calls with no ticket. See the header for where the
 * number comes from; do not raise it without re-running that query.
 */
export const UNFILED_RUN_ALARM = 12;

/**
 * Outbox rows held. Three is not a tuning choice — the table held no non-sent
 * row at all between 2026-05-12 and 2026-09-01, so anything sitting in it is
 * already abnormal. Three rather than one only so a single transient retry in
 * flight does not raise a banner.
 */
export const OUTBOX_HELD_ALARM = 3;

/**
 * An hour with no queue call at all. This bounds the run plane twice over:
 *
 *   - the newest queue call must be this fresh for the plane to speak, and
 *   - the run stops at any gap this long between two consecutive calls.
 *
 * The run says "calls are arriving and leaving without a ticket". With no
 * calls arriving it is a statement about the past, and a frozen run from the
 * previous evening is exactly what fired at 12:30 on 2026-09-02 with nothing
 * wrong.
 *
 * The gap half is the second half of that same morning, and it needed both.
 * Recency alone fixed WHEN the plane speaks and not WHAT it counts: at 15:04
 * the lines reopened, three ordinary calls came in — only about half of healthy
 * queue calls file anything — and the run walked back through the closure,
 * picked up last night's 17, reached 20 and fired on an outage fifteen hours
 * dead. Two calls with a shut office between them are not consecutive in any
 * sense the threshold was measured over; that distribution (185, then 8, 7, 7,
 * 6…) is business-hours calls minutes apart.
 *
 * An hour, for two reasons. Queue volume in business hours is roughly one call
 * every three minutes across the four lines, so sixty minutes of nothing is
 * already outside anything normal — and the 08-31 outage, the event this alarm
 * exists for, had calls arriving throughout: 185 calls in three hours and
 * thirty-nine minutes, one every seventy-one seconds, newest always seconds
 * old. Neither half of this bound could have hidden it. Nothing shorter buys
 * anything; anything longer starts to re-admit the overnight tail.
 *
 * This bounds ONLY the run plane. The outbox planes below are about requests
 * we are holding, which is equally true at 3am, and they still fire.
 */
export const TRAFFIC_RECENCY_MS = 60 * 60 * 1000;

/** Pure: no clock, no database, so the outage can be replayed against it. */
export function assessTicketFiling(snapshot: TicketFilingSnapshot): TicketFilingVerdict {
  // Walk back from the newest call. A ticket ends the run, and so does an
  // hour with no call between two links of it — see TRAFFIC_RECENCY_MS. Only
  // the run stops there; the older calls stay in the snapshot and the outbox
  // planes below still see everything.
  let unfiledRun = 0;
  let greetingOnlySkipped = 0;
  let previousCallAtMs: number | null = null;
  /** The oldest call the run reaches — the span a confirmed filing is judged against. */
  let runStartedAtMs: number | null = null;
  for (const call of snapshot.recentQueueCalls) {
    if (call.hasTicket) break;
    if (previousCallAtMs !== null && previousCallAtMs - call.createdAtMs > TRAFFIC_RECENCY_MS) break;
    // A greeting-only hangup is still TRAFFIC — it keeps the gap rule fed, so
    // the run cannot walk back through a closure — but it is not EVIDENCE,
    // because there was no request in it to file. See isGreetingOnly.
    previousCallAtMs = call.createdAtMs;
    runStartedAtMs = call.createdAtMs;
    if (isGreetingOnly(call)) {
      greetingOnlySkipped++;
      continue;
    }
    unfiledRun++;
  }

  const filed = snapshot.recentQueueCalls.find((c) => c.hasTicket);
  const lastFiledAtMs = filed?.createdAtMs ?? null;
  const minutesSinceLastFiled =
    lastFiledAtMs === null ? null : Math.round((snapshot.nowMs - lastFiledAtMs) / 60_000);

  const outboxHeld = snapshot.outboxPending + snapshot.outboxFailed + snapshot.outboxDeadLetter;

  // Plane B first: it is the earlier signal, and it names our own POSTs rather
  // than an inference from what did not happen.
  if (snapshot.outboxDeadLetter > 0) {
    return {
      stalled: true,
      reason:
        `${snapshot.outboxDeadLetter} request(s) gave up after every retry and are sitting in the ` +
        'outbox unfiled. The payloads are intact and replayable — nothing is lost yet.',
      unfiledRun,
      lastFiledAtMs,
      minutesSinceLastFiled,
      outboxHeld,
      greetingOnlySkipped,
      suppressedByConfirmedFiling: false,
    };
  }
  if (outboxHeld >= OUTBOX_HELD_ALARM) {
    return {
      stalled: true,
      reason:
        `The ticketing API is refusing POSTs — ${outboxHeld} request(s) are held in the outbox ` +
        'and being retried. Callers were told their request was recorded.',
      unfiledRun,
      lastFiledAtMs,
      minutesSinceLastFiled,
      outboxHeld,
      greetingOnlySkipped,
      suppressedByConfirmedFiling: false,
    };
  }

  // The run plane needs live traffic — see TRAFFIC_RECENCY_MS. `unfiledRun` is
  // still reported either way: the count is true and staff may want it.
  const newestCallAtMs = snapshot.recentQueueCalls[0]?.createdAtMs ?? null;
  const trafficIsLive =
    newestCallAtMs !== null && snapshot.nowMs - newestCallAtMs <= TRAFFIC_RECENCY_MS;

  /**
   * THE DISCONFIRMING CHECK — a positive fact beats an inference.
   *
   * The run says "filing has stopped" by observing that it did not happen.
   * `ticketFilingPulse` says when it DID happen, recorded by the filing path
   * at the moment the API answered. If a ticket was confirmed filed at any
   * point inside the run's own span, filing plainly has not stopped, and the
   * run is measuring a filing RATE — a different thing, and not an emergency.
   *
   * This is what would have held the 2026-09-03 18:24:56 email: VA-57240's
   * create-ticket returned 200 at 18:24:15, inside a run reaching back to
   * 18:13:37, and the alarm announced a stall forty-one seconds later.
   *
   * Deliberately the run's SPAN and not a fixed window, so there is no second
   * constant to tune and no way for the check to outlive the evidence. A real
   * outage has no confirmed filing anywhere in its span — 2026-08-31 had none
   * for three hours and thirty-nine minutes — so this cannot silence one.
   */
  const filedInsideRun =
    snapshot.lastTicketFiledAtMs !== null &&
    runStartedAtMs !== null &&
    snapshot.lastTicketFiledAtMs >= runStartedAtMs;

  if (trafficIsLive && unfiledRun >= UNFILED_RUN_ALARM && !filedInsideRun) {
    return {
      stalled: true,
      reason:
        `${unfiledRun} queue calls in a row have filed no ticket` +
        (minutesSinceLastFiled === null
          ? ' and none is on record at all.'
          : ` — the last one was ${minutesSinceLastFiled} minutes ago.`) +
        ' On a normal day the worst run in a fortnight was eight.',
      unfiledRun,
      lastFiledAtMs,
      minutesSinceLastFiled,
      outboxHeld,
      greetingOnlySkipped,
      suppressedByConfirmedFiling: false,
    };
  }

  return {
    stalled: false,
    reason: null,
    suppressedByConfirmedFiling: trafficIsLive && unfiledRun >= UNFILED_RUN_ALARM && filedInsideRun,
    greetingOnlySkipped,
    unfiledRun,
    lastFiledAtMs,
    minutesSinceLastFiled,
    outboxHeld,
  };
}

/**
 * The four queue lines, and only those.
 *
 * The run-length distribution in the header was measured on these. The
 * answering service and no-IVR file through a different path with a different
 * base rate, so applying a threshold derived here to them would be a number
 * quoted about a population it was not measured on — the trap
 * `.agents/memory/measurement-traps.md` exists for. Extend it by measuring it.
 */
export const ALARMED_QUEUE_AGENTS = ['optical', 'surgery', 'tech', 'records'] as const;

/** How many recent calls to look back over. Comfortably past the run alarm. */
const LOOKBACK_CALLS = 40;

/** Reads both planes. Never throws — a broken alarm must not break the server. */
export async function readTicketFilingSnapshot(): Promise<TicketFilingSnapshot | null> {
  try {
    // Imported here rather than at the top so the pure assessment above can be
    // tested, and replayed against production rows, without a database.
    const { db } = await import('../db');
    const { sql } = await import('drizzle-orm');

    /**
     * A CALL STILL ON THE LINE HAS NOT "ARRIVED AND LEFT" — found by Codex on
     * PR #244, and it would have fired on the first busy morning.
     *
     * `voiceAgentRoutes.ts:2571` creates the row at call START with
     * `status: 'in_progress'`, and it becomes 'completed' at the end. This
     * query takes the newest 40 rows, so during business hours every call
     * currently on the line is in that sample — and none of them can have a
     * ticket yet, because their filing tool has not run. Five concurrent calls
     * on top of the worst NORMAL run of eight completed non-filing calls is
     * thirteen, past the threshold of twelve, and the alarm cries outage while
     * nothing whatsoever is wrong.
     *
     * 'completed' specifically, not "not in-flight": the run-length
     * distribution the threshold was derived from (185 once, then 8, 7, 7, 6…)
     * was measured over a population that is 100% 'completed' — there is not a
     * single row of any other status in fourteen days. Widening to 'failed',
     * 'no_answer' or 'busy' would apply a threshold to a population it was
     * never measured on, which is the trap `.agents/memory/measurement-traps.md`
     * exists for. Narrowing to what was measured keeps the number honest.
     */
    const calls = await db.execute(sql`
      SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ms,
             (ticket_number IS NOT NULL) AS has_ticket,
             total_turns,
             duration
      FROM call_logs
      WHERE agent_used IN ('optical', 'surgery', 'tech', 'records')
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT ${LOOKBACK_CALLS}
    `);

    /**
     * A DEAD LETTER DOES NOT AGE OUT — found by Codex on PR #244.
     *
     * The six-hour window was applied to every unsent status, so an overnight
     * outage's dead letters dropped out of the alarm and both this check and
     * the Observatory returned to green while the requests sat there unfiled,
     * their payloads still needing a manual replay. Healthy-because-old is the
     * same lie as a zero that means "nothing recorded".
     *
     * The window stays for the transient states — a pending or failed row is
     * mid-retry, and an old one is either about to send or about to become a
     * dead letter, which is the state this now counts for ever.
     */
    const outbox = await db.execute(sql`
      SELECT status::text AS status, COUNT(*)::int AS n
      FROM ticket_outbox
      WHERE status = 'dead_letter'
         OR (status NOT IN ('sent', 'dead_letter') AND created_at > NOW() - INTERVAL '6 hours')
      GROUP BY status
    `);

    const held = { pending: 0, sending: 0, failed: 0, dead_letter: 0 } as Record<string, number>;
    for (const row of outbox.rows as Array<{ status: string; n: number }>) {
      held[row.status] = Number(row.n) || 0;
    }

    const { lastTicketFiledAtMs } = await import('./ticketFilingPulse');

    return {
      recentQueueCalls: (
        calls.rows as Array<{
          created_ms: string | number;
          has_ticket: boolean;
          total_turns: number | null;
          duration: number | null;
        }>
      ).map((r) => ({
        createdAtMs: Number(r.created_ms),
        hasTicket: Boolean(r.has_ticket),
        // Null stays null — isGreetingOnly treats an undescribed call as
        // substantive, and coalescing here would quietly make it a skip.
        totalTurns: r.total_turns === null ? null : Number(r.total_turns),
        durationSeconds: r.duration === null ? null : Number(r.duration),
      })),
      lastTicketFiledAtMs: lastTicketFiledAtMs(),
      // `sending` counts as held: a lease that never completes is a request
      // nobody is holding on to.
      outboxPending: (held.pending ?? 0) + (held.sending ?? 0),
      outboxFailed: held.failed ?? 0,
      outboxDeadLetter: held.dead_letter ?? 0,
      nowMs: Date.now(),
    };
  } catch (err) {
    console.error('[TICKET FILING HEALTH] Could not read the filing state:', err);
    return null;
  }
}
