/**
 * Stale-call sweeper — closes call_logs rows stuck in a live status long
 * after any real call could still be running, using Twilio's real status as
 * ground truth. Bookkeeping only: it never hangs up a call and never deletes
 * a row. Decision rules and the measured 30-minute ceiling live in
 * staleCallSweep.logic.ts (pure, tested); this file is the DB/Twilio shell.
 *
 * Runs in the DASHBOARD process (server/index.ts) on boot and every 5
 * minutes — deliberately NOT only in the voice process, because on
 * 2026-08-24 the voice process was exactly the thing that was sick (its DB
 * layer wedged after a Supabase restart) and every existing cleanup
 * mechanism lived inside it.
 *
 * The Live Calls "Cleanup Stale" button runs the same sweep on demand
 * (server/staleCallCleanup.ts, 2026-11-26), with its own age line and
 * `closeUnverified: false`, so there is one set of rules and no second copy
 * of them. Nothing here can hang up a call: the Twilio client this file is
 * typed against has no write method.
 */
import { inArray, and, eq, asc, sql } from 'drizzle-orm';
import { db } from '../db';
import { callLogs } from '../../shared/schema';
import {
  decideSweep,
  isTerminalTwilioStatus,
  summarizeSweepLine,
  STALE_CALL_CEILING_MS,
  STALE_SWEEPER_MARKER,
  type SweepAction,
  type TwilioLookup,
  type SweepSummary,
} from './staleCallSweep.logic';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 200;
/**
 * Pages per run. Rows are read oldest first, page after page, so rows the
 * sweep must leave (live at Twilio, unverifiable on a manual run) cannot hide
 * the rows behind them (Codex on #529). 5 pages bounds one run at 1,000 Twilio
 * lookups; 0 rows were open on 2026-11-26 and 0 were reaped in the 90 days before.
 */
const SWEEP_MAX_PAGES = 5;

/** The statuses a row can be stuck in. A close lands only while the row still reads one of them. */
export const LIVE_CALL_STATUSES = ['in_progress', 'ringing', 'initiated'] as const;

let sweeperInterval: NodeJS.Timeout | null = null;

/** Read-only view of the Twilio client: the sweeper can fetch a call and do nothing else to it. */
export interface TwilioCallReader {
  calls(callSid: string): { fetch(): Promise<any> };
}

export interface StaleDbRow {
  id: string;
  callSid: string | null;
  status: string | null;
  createdAt: Date | null;
  /**
   * created_at exactly as Postgres holds it (microseconds), for the page
   * cursor. A JavaScript Date keeps milliseconds only, and a cursor built
   * from one re-reads the row it ended on (Codex on #529, round 2).
   */
  createdAtKey: string | null;
}

export type ClosePatch = Extract<SweepAction, { type: 'close' }>['patch'];

/** Where the next page starts: after this row, in (created_at, id) order. */
export interface StaleCursor {
  createdAtKey: string;
  id: string;
}

export interface SweepDeps {
  /**
   * Rows in a live status whose call began before `cutoff` (its start time,
   * or its creation time when it has none, as the Live Calls board reads it),
   * oldest first by (created_at, id), after `after` when given.
   */
  findStaleRows(cutoff: Date, limit: number, after: StaleCursor | null): Promise<StaleDbRow[]>;
  /** Close one row; true only when the row was still in a live status. */
  closeRow(id: string, patch: ClosePatch): Promise<boolean>;
  /** null when Twilio credentials are not available. */
  twilioClient(): Promise<TwilioCallReader | null>;
  now(): Date;
}

export interface SweepOptions {
  /** How old a live row must be. Default STALE_CALL_CEILING_MS (the automatic sweep). */
  minAgeMs?: number;
  /** See DecideOptions. Default true (the automatic sweep). */
  closeUnverified?: boolean;
  /** Rows per page. Default 200. */
  limit?: number;
  /** Pages per run. Default 5. */
  maxPages?: number;
}

export async function lookupTwilio(
  client: TwilioCallReader | null,
  callSid: string | null,
): Promise<TwilioLookup> {
  if (!client || !callSid) return { kind: 'unavailable' };
  try {
    const call = await client.calls(callSid).fetch();
    const twilioStatus = String(call.status ?? '');
    if (isTerminalTwilioStatus(twilioStatus)) {
      const parsed = call.duration != null ? parseInt(String(call.duration), 10) : NaN;
      return {
        kind: 'terminal',
        twilioStatus,
        durationSeconds: Number.isFinite(parsed) ? parsed : null,
        endTime: call.endTime ? new Date(call.endTime) : null,
      };
    }
    // queued / initiated / ringing / in-progress, or a status we do not know:
    // treated as live, so it is never closed on a guess.
    return { kind: 'live', twilioStatus };
  } catch (err: any) {
    if (err?.code === 20404 || err?.status === 404) return { kind: 'not_found' };
    return { kind: 'error', message: err?.message ?? String(err) };
  }
}

export const productionSweepDeps: SweepDeps = {
  async findStaleRows(cutoff, limit, after) {
    return db
      .select({
        id: callLogs.id,
        callSid: callLogs.callSid,
        status: callLogs.status,
        createdAt: callLogs.createdAt,
        createdAtKey: sql<string | null>`${callLogs.createdAt}::text`,
      })
      .from(callLogs)
      .where(
        and(
          // The status filter is the predicate of the partial index
          // idx_call_logs_open_status_created, which holds only open rows.
          inArray(callLogs.status, [...LIVE_CALL_STATUSES]),
          // Age as the Live Calls board reads it: the start time, else the
          // creation time (Codex on #529, rounds 1 and 2). The cutoff is sent
          // as UTC text and cast, as the column's own encoder would send it:
          // a bare Date goes out in the process's local time with an offset,
          // which Postgres drops when it compares to a timestamp column, so a
          // process not on UTC would read rows hours off (Codex, round 4).
          sql`coalesce(${callLogs.startTime}, ${callLogs.createdAt}) < ${cutoff.toISOString()}::timestamp`,
          after
            ? sql`(${callLogs.createdAt}, ${callLogs.id}) > (${after.createdAtKey}::timestamp, ${after.id}::varchar)`
            : undefined,
        ),
      )
      .orderBy(asc(callLogs.createdAt), asc(callLogs.id))
      .limit(limit);
  },
  async closeRow(id, patch) {
    // Guarded on the status the row was read with: if the call's own
    // teardown (or a concurrent sweep) closed it after the read, that
    // record stands and this write changes nothing.
    const closed = await db
      .update(callLogs)
      .set({
        status: patch.status,
        duration: patch.duration ?? undefined,
        endTime: patch.endTime,
        twilioStatus: patch.twilioStatus ?? undefined,
        callDisposition: patch.callDisposition,
      })
      .where(and(eq(callLogs.id, id), inArray(callLogs.status, [...LIVE_CALL_STATUSES])))
      .returning({ id: callLogs.id });
    return closed.length > 0;
  },
  async twilioClient() {
    try {
      const { getTwilioClient } = await import('../../src/lib/twilioClient');
      return (await getTwilioClient()) as unknown as TwilioCallReader;
    } catch (err: any) {
      console.warn(
        `[StaleCallSweeper] Twilio client unavailable (${err?.message ?? err}) — ` +
          `stale rows cannot be checked against Twilio`,
      );
      return null;
    }
  },
  now: () => new Date(),
};

export async function sweepStaleCalls(
  options: SweepOptions = {},
  deps: SweepDeps = productionSweepDeps,
): Promise<SweepSummary> {
  const minAgeMs = options.minAgeMs ?? STALE_CALL_CEILING_MS;
  const closeUnverified = options.closeUnverified ?? true;
  const summary: SweepSummary = {
    examined: 0,
    closedFromTwilioTruth: 0,
    closedUnresolvable: 0,
    stillLiveAtTwilio: 0,
    errors: 0,
    leftUnverified: 0,
    alreadyClosed: 0,
  };

  const now = deps.now();
  const cutoff = new Date(now.getTime() - minAgeMs);
  const limit = options.limit ?? SWEEP_BATCH_LIMIT;
  const maxPages = options.maxPages ?? SWEEP_MAX_PAGES;

  let twilioClient: TwilioCallReader | null | undefined;
  let after: StaleCursor | null = null;
  for (let page = 0; page < maxPages; page++) {
    const staleRows = await deps.findStaleRows(cutoff, limit, after);
    summary.examined += staleRows.length;
    if (staleRows.length === 0) break;
    if (twilioClient === undefined) twilioClient = await deps.twilioClient();
    await sweepPage(staleRows, twilioClient, now, minAgeMs, closeUnverified, deps, summary);
    const last = staleRows[staleRows.length - 1];
    if (staleRows.length < limit || !last.createdAtKey) break;
    after = { createdAtKey: last.createdAtKey, id: last.id };
  }

  if (summary.examined > 0) console.info(summarizeSweepLine(summary));
  return summary;
}

async function sweepPage(
  staleRows: StaleDbRow[],
  twilioClient: TwilioCallReader | null,
  now: Date,
  minAgeMs: number,
  closeUnverified: boolean,
  deps: SweepDeps,
  summary: SweepSummary,
): Promise<void> {
  for (const row of staleRows) {
    const lookup = await lookupTwilio(twilioClient, row.callSid);
    const action = decideSweep(
      { id: row.id, callSid: row.callSid, status: row.status ?? '' },
      lookup,
      now,
      { closeUnverified },
    );

    if (action.type === 'close') {
      const closed = await deps.closeRow(row.id, action.patch);
      if (!closed) {
        summary.alreadyClosed = (summary.alreadyClosed ?? 0) + 1;
        continue;
      }
      if (lookup.kind === 'terminal') summary.closedFromTwilioTruth++;
      else summary.closedUnresolvable++;
      console.info(
        `[StaleCallSweeper] closed ${row.id} (CallSid ${row.callSid ?? 'none'}, was ${row.status}, ` +
          `created ${row.createdAt?.toISOString?.() ?? row.createdAt}) → ${action.patch.status}` +
          `${action.patch.duration != null ? ` (${action.patch.duration}s per Twilio)` : ' (duration unknown)'}`,
      );
    } else if (action.type === 'leave_live') {
      summary.stillLiveAtTwilio++;
      console.error(
        `[StaleCallSweeper] ⚠ CallSid ${row.callSid} is STILL ${action.twilioStatus} at Twilio after ` +
          `${Math.round(minAgeMs / 60000)}+ minutes — NOT touched. A transferred call or a long ` +
          `operator call can be live here; a stuck one needs a human decision.`,
      );
    } else if (action.type === 'leave_unverified') {
      summary.leftUnverified = (summary.leftUnverified ?? 0) + 1;
      console.info(
        `[StaleCallSweeper] left ${row.id} open (CallSid ${row.callSid ?? 'none'}): Twilio ` +
          `${action.reason === 'not_found' ? 'has no such call' : 'could not be asked'}, so nothing says it ended`,
      );
    } else {
      summary.errors++;
      console.warn(`[StaleCallSweeper] lookup failed for ${row.id}: ${action.message} — will retry next sweep`);
    }
  }
}

/**
 * One automatic sweep at a time. Five pages are up to 1,000 Twilio lookups,
 * which at a few hundred milliseconds each can outlast the five-minute
 * interval, and a second sweep started beside the first would look up the
 * same rows again (Codex on #529, round 3). A tick that finds a sweep still
 * running is skipped and logged; the next tick runs. Never throws.
 */
export function oneSweepAtATime(sweep: () => Promise<unknown>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      console.info('[StaleCallSweeper] the previous sweep is still running — this tick skipped');
      return;
    }
    inFlight = true;
    try {
      await sweep();
    } catch (err) {
      console.error('[StaleCallSweeper] sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      inFlight = false;
    }
  };
}

/** Boot + interval. Never throws — a sweep failure logs and waits for the next tick. */
export function startStaleCallSweeper(): void {
  if (sweeperInterval) return;
  console.info(STALE_SWEEPER_MARKER);
  const run = oneSweepAtATime(() => sweepStaleCalls());
  void run(); // boot sweep — clears anything left behind by an outage while we were down
  sweeperInterval = setInterval(() => void run(), SWEEP_INTERVAL_MS);
}

export function stopStaleCallSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
