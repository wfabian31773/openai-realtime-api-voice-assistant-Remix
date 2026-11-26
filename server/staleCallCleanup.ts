/**
 * The Live Calls "Cleanup Stale" button (2026-11-26, the screen accuracy
 * audit of voice #525).
 *
 * Before: any signed-in user could press it; it took rows in a live status
 * older than 5 minutes, and when Twilio still reported the call live after 10
 * minutes it HUNG IT UP. A runtime call may run to its 10-minute ceiling, a
 * PCP call handed to the call centre's queue stays live at Twilio for a median
 * 871 s after our side lets go (up to 3,447 s, 30 days to 2026-11-26), and the
 * operator line allows 60 minutes, so the button could end a call a patient
 * was still on whenever that call's row had not been closed.
 *
 * Now: admin only; rows older than MANUAL_CLEANUP_MIN_AGE_MS (15 minutes,
 * above the runtime's ceiling); the same Twilio-checked rules as the automatic
 * sweeper, which never hangs up. A row is closed only when Twilio says its
 * call has ended. A call Twilio reports live is never touched, and a row
 * Twilio cannot account for is left to the automatic sweep at 30 minutes.
 */
import type { Express, RequestHandler } from 'express';
import { sweepStaleCalls, type SweepOptions } from './services/staleCallSweeper';
import {
  MANUAL_CLEANUP_MIN_AGE_MS,
  STALE_CALL_CEILING_MS,
  summarizeSweepLine,
  type SweepSummary,
} from './services/staleCallSweep.logic';

export const STALE_CLEANUP_PATH = '/api/call-logs/cleanup-stale';

/** What the button sweeps with. Exported so a test can hold it to its rules. */
export const MANUAL_CLEANUP_OPTIONS: Required<Pick<SweepOptions, 'minAgeMs' | 'closeUnverified'>> = {
  minAgeMs: MANUAL_CLEANUP_MIN_AGE_MS,
  closeUnverified: false,
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The sentence the button shows. Plain words; every number the sweep produced. */
export function cleanupMessage(s: SweepSummary): string {
  const minutes = Math.round(MANUAL_CLEANUP_MIN_AGE_MS / 60000);
  const sweepMinutes = Math.round(STALE_CALL_CEILING_MS / 60000);
  if (s.examined === 0) return `No call rows have been open longer than ${minutes} minutes.`;
  const parts = [
    `Closed ${plural(s.closedFromTwilioTruth, 'row', 'rows')} whose call Twilio says has ended.`,
  ];
  if (s.stillLiveAtTwilio) {
    parts.push(`${plural(s.stillLiveAtTwilio, 'call is', 'calls are')} still live at Twilio and ${s.stillLiveAtTwilio === 1 ? 'was' : 'were'} not touched.`);
  }
  if (s.leftUnverified) {
    parts.push(
      `${plural(s.leftUnverified, 'row', 'rows')} Twilio could not confirm ${s.leftUnverified === 1 ? 'was' : 'were'} left open for the automatic sweep at ${sweepMinutes} minutes.`,
    );
  }
  if (s.alreadyClosed) parts.push(`${plural(s.alreadyClosed, 'row was', 'rows were')} already closed.`);
  if (s.errors) parts.push(`${plural(s.errors, 'Twilio lookup', 'Twilio lookups')} failed; nothing was changed for ${s.errors === 1 ? 'it' : 'them'}.`);
  return parts.join(' ');
}

export function mountStaleCallCleanup(app: Express, deps: {
  authenticate: RequestHandler;
  admin: RequestHandler;
  sweep?: (options: SweepOptions) => Promise<SweepSummary>;
}) {
  const sweep = deps.sweep ?? ((options: SweepOptions) => sweepStaleCalls(options));
  app.post(STALE_CLEANUP_PATH, deps.authenticate, deps.admin, async (req, res) => {
    try {
      const summary = await sweep({ ...MANUAL_CLEANUP_OPTIONS });
      const who = req.session?.userId ?? (req.user as any)?.claims?.sub ?? 'unknown';
      console.info(`[CLEANUP] stale-call cleanup run by ${who}: ${summarizeSweepLine(summary)}`);
      res.json({
        message: cleanupMessage(summary),
        cleaned: summary.closedFromTwilioTruth,
        examined: summary.examined,
        stillLiveAtTwilio: summary.stillLiveAtTwilio,
        leftUnverified: summary.leftUnverified ?? 0,
        alreadyClosed: summary.alreadyClosed ?? 0,
        errors: summary.errors,
        olderThanMinutes: Math.round(MANUAL_CLEANUP_MIN_AGE_MS / 60000),
      });
    } catch (error) {
      console.error('Error cleaning up stale calls:', error instanceof Error ? error.message : error);
      res.status(500).json({ message: 'Failed to clean up stale calls' });
    }
  });
}
