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
 */
import { inArray, lt, and, eq } from 'drizzle-orm';
import { db } from '../db';
import { callLogs } from '../../shared/schema';
import {
  decideSweep,
  isTerminalTwilioStatus,
  summarizeSweepLine,
  STALE_CALL_CEILING_MS,
  STALE_SWEEPER_MARKER,
  type TwilioLookup,
  type SweepSummary,
} from './staleCallSweep.logic';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 200;

let sweeperInterval: NodeJS.Timeout | null = null;

async function lookupTwilio(
  client: any | null,
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
    // queued / ringing / in-progress — genuinely live at Twilio
    return { kind: 'live', twilioStatus };
  } catch (err: any) {
    if (err?.code === 20404 || err?.status === 404) return { kind: 'not_found' };
    return { kind: 'error', message: err?.message ?? String(err) };
  }
}

export async function sweepStaleCalls(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    examined: 0,
    closedFromTwilioTruth: 0,
    closedUnresolvable: 0,
    stillLiveAtTwilio: 0,
    errors: 0,
  };

  const ceiling = new Date(Date.now() - STALE_CALL_CEILING_MS);
  const staleRows = await db
    .select({
      id: callLogs.id,
      callSid: callLogs.callSid,
      status: callLogs.status,
      createdAt: callLogs.createdAt,
    })
    .from(callLogs)
    .where(
      and(
        inArray(callLogs.status, ['in_progress', 'ringing', 'initiated']),
        lt(callLogs.createdAt, ceiling),
      ),
    )
    .limit(SWEEP_BATCH_LIMIT);

  summary.examined = staleRows.length;
  if (staleRows.length === 0) return summary;

  let twilioClient: any | null = null;
  try {
    const { getTwilioClient } = await import('../../src/lib/twilioClient');
    twilioClient = await getTwilioClient();
  } catch (err: any) {
    console.warn(
      `[StaleCallSweeper] Twilio client unavailable (${err?.message ?? err}) — ` +
        `stale rows will close as failed with no invented duration`,
    );
  }

  for (const row of staleRows) {
    const lookup = await lookupTwilio(twilioClient, row.callSid);
    const action = decideSweep({ id: row.id, callSid: row.callSid, status: row.status ?? '' }, lookup);

    if (action.type === 'close') {
      await db
        .update(callLogs)
        .set({
          status: action.patch.status,
          duration: action.patch.duration ?? undefined,
          endTime: action.patch.endTime,
          twilioStatus: action.patch.twilioStatus ?? undefined,
          callDisposition: action.patch.callDisposition,
        })
        .where(eq(callLogs.id, row.id));
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
          `${Math.round(STALE_CALL_CEILING_MS / 60000)}+ minutes — NOT touched. This is billing in real ` +
          `time and needs a human decision.`,
      );
    } else {
      summary.errors++;
      console.warn(`[StaleCallSweeper] lookup failed for ${row.id}: ${action.message} — will retry next sweep`);
    }
  }

  console.info(summarizeSweepLine(summary));
  return summary;
}

/** Boot + interval. Never throws — a sweep failure logs and waits for the next tick. */
export function startStaleCallSweeper(): void {
  if (sweeperInterval) return;
  console.info(STALE_SWEEPER_MARKER);
  const run = () =>
    sweepStaleCalls().catch((err) =>
      console.error('[StaleCallSweeper] sweep failed:', err instanceof Error ? err.message : err),
    );
  run(); // boot sweep — clears anything left behind by an outage while we were down
  sweeperInterval = setInterval(run, SWEEP_INTERVAL_MS);
}

export function stopStaleCallSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
