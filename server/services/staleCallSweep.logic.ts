/**
 * Pure decision logic for the stale-call sweeper. Import-free so it is
 * testable without DATABASE_URL (the azulSchedulingPrompt extraction
 * pattern — see .agents/memory/measurement-traps.md).
 *
 * Why this exists (2026-08-24 incident): four calls were mid-flight when
 * Supabase restarted Postgres at 20:19:49 UTC. Their terminal updates were
 * lost because the voice process's DB layer wedged, and every mechanism
 * that could have closed the rows lived in that same wedged process (the
 * 60s DB reconciler, the lifecycle coordinator). The dashboard process —
 * whose DB layer recovered — only swept stale rows once, at boot, and had
 * not rebooted. Result: 4 rows shown as "Live now" for 52 hours. This
 * sweeper runs in the dashboard process on boot AND on an interval, so a
 * sick voice process can no longer leave zombies on the board.
 *
 * Honesty rules (operator requirement, 2026-08-26):
 *  - Twilio's real status is recorded when it can be fetched — including its
 *    real duration and end time. That is ground truth, not fakery.
 *  - When Twilio cannot answer (no CallSid, call not found, no credentials)
 *    the row closes as 'failed' with NO invented duration.
 *  - Every row this sweeper touches carries call_disposition='stale_reaped'
 *    so swept bookkeeping is forever distinguishable from a normally
 *    concluded call.
 *  - A call Twilio says is genuinely still in progress is NEVER touched and
 *    NEVER hung up from here — it is reported loudly for a human decision.
 *    (Force-termination is the voice-process coordinator's job; this
 *    sweeper is bookkeeping only.)
 */

export const STALE_SWEEP_DISPOSITION = 'stale_reaped';

/**
 * How old a row still in a live status must be before it is presumed stale.
 *
 * Derived from measured data, not picked (2026-08-27, 60 days of call_logs,
 * 24,671 completed calls): p99 duration = 875s (~15 min), p99.9 = 1,537s
 * (~26 min). The lifecycle coordinator force-terminates every call at 25
 * minutes (max per-agent cap 20 min + 5 min grace — see
 * ABSOLUTE_MAX_CALL_DURATION_MS in src/services/callLifecycleCoordinator.ts,
 * not imported here because that module starts timers on import). 30 minutes
 * exceeds all of them: no legitimate call is still in flight at 30 minutes.
 *
 * RE-MEASURED 2026-11-26, and the last sentence above is no longer true at
 * Twilio. Of the 30 days' runtime calls, 403 PCP blind transfers to the call
 * centre's queue ran a median 871 s at Twilio (up to 3,447 s, 12 past 30
 * minutes) while our side held them a median 57 s; the operator line allows
 * up to 60 minutes. Those calls are safe here only because their row closes
 * when our side lets go of the stream, and because a row is never closed
 * while Twilio says the call is live. The Twilio check is the protection;
 * this age is a backstop.
 */
export const STALE_CALL_CEILING_MS = 30 * 60 * 1000;

/**
 * The Live Calls "Cleanup Stale" button's age line (2026-11-26, the screen
 * accuracy audit of voice #525). The button used 5 minutes and hung up any
 * call Twilio still reported live after 10; a runtime call may run to its
 * 10-minute ceiling (DEFAULT_MAX_CALL_MS, src/runtime/mediaStreamBridge.ts),
 * so 5 minutes caught live calls. 15 minutes is that ceiling plus 5 minutes
 * for the teardown write and its retries. A test holds it above the ceiling.
 *
 * The button runs this sweeper with `closeUnverified: false`: it closes only
 * rows Twilio says have ended, never hangs anything up, and leaves a row
 * Twilio cannot account for to the automatic sweep at STALE_CALL_CEILING_MS.
 */
export const MANUAL_CLEANUP_MIN_AGE_MS = 15 * 60 * 1000;

/** Deploy marker — grep the deployment logs for this exact string to confirm
 * the sweeper build is live. */
export const STALE_SWEEPER_MARKER =
  '[StaleCallSweeper] armed (build 2026-08-27): boot + every 5 min, ceiling 30 min, disposition=stale_reaped';

export interface StaleRow {
  id: string;
  callSid: string | null;
  status: string;
}

export type TwilioLookup =
  | { kind: 'terminal'; twilioStatus: string; durationSeconds: number | null; endTime: Date | null }
  | { kind: 'live'; twilioStatus: string }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' }; // no CallSid on the row, or no Twilio credentials

export type SweepAction =
  | {
      type: 'close';
      patch: {
        status: 'completed' | 'busy' | 'no_answer' | 'failed';
        duration: number | null;
        endTime: Date;
        twilioStatus: string | null;
        callDisposition: string;
      };
    }
  | { type: 'leave_live'; twilioStatus: string }
  // closeUnverified: false only: Twilio did not say the call ended (no
  // CallSid, not found, no credentials), so the row is left as it is.
  | { type: 'leave_unverified'; reason: 'not_found' | 'unavailable' }
  | { type: 'skip_error'; message: string };

export interface DecideOptions {
  /**
   * true (the automatic sweeper, the 2026-08-26 honesty rule): a row Twilio
   * cannot account for closes as 'failed' with no invented duration.
   * false (the manual button): only a row Twilio says has ended is closed.
   */
  closeUnverified?: boolean;
}

const TERMINAL_STATUS_MAP: Record<string, 'completed' | 'busy' | 'no_answer' | 'failed'> = {
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'failed',
};

export function isTerminalTwilioStatus(status: string): boolean {
  return status in TERMINAL_STATUS_MAP;
}

export function decideSweep(
  row: StaleRow,
  lookup: TwilioLookup,
  now: Date = new Date(),
  options: DecideOptions = {},
): SweepAction {
  const closeUnverified = options.closeUnverified ?? true;
  switch (lookup.kind) {
    case 'terminal': {
      const mapped = TERMINAL_STATUS_MAP[lookup.twilioStatus] ?? 'failed';
      return {
        type: 'close',
        patch: {
          status: mapped,
          // Twilio's measured duration or nothing — never an estimate.
          duration: lookup.durationSeconds,
          endTime: lookup.endTime ?? now,
          twilioStatus: lookup.twilioStatus,
          callDisposition: STALE_SWEEP_DISPOSITION,
        },
      };
    }
    case 'live':
      // Genuinely still in progress at Twilio — bookkeeping must not kill it.
      return { type: 'leave_live', twilioStatus: lookup.twilioStatus };
    case 'not_found':
      if (!closeUnverified) return { type: 'leave_unverified', reason: 'not_found' };
      return {
        type: 'close',
        patch: {
          status: 'failed',
          duration: null, // unknown — never invented
          endTime: now,
          twilioStatus: null,
          callDisposition: STALE_SWEEP_DISPOSITION,
        },
      };
    case 'unavailable':
      if (!closeUnverified) return { type: 'leave_unverified', reason: 'unavailable' };
      return {
        type: 'close',
        patch: {
          status: 'failed',
          duration: null, // unknown — never invented
          endTime: now,
          twilioStatus: null,
          callDisposition: STALE_SWEEP_DISPOSITION,
        },
      };
    case 'error':
      // Transient Twilio API problem — leave the row for the next sweep.
      return { type: 'skip_error', message: lookup.message };
  }
}

export interface SweepSummary {
  examined: number;
  closedFromTwilioTruth: number;
  closedUnresolvable: number;
  stillLiveAtTwilio: number;
  errors: number;
  /** Manual runs only: rows Twilio did not say had ended, left as they were. */
  leftUnverified?: number;
  /** Rows another writer closed between the read and the close (the teardown, or a concurrent sweep). */
  alreadyClosed?: number;
}

export function summarizeSweepLine(s: SweepSummary): string {
  return (
    `[StaleCallSweeper] swept ${s.closedFromTwilioTruth + s.closedUnresolvable} of ${s.examined} stale call(s): ` +
    `${s.closedFromTwilioTruth} closed from Twilio truth, ${s.closedUnresolvable} unresolvable → failed, ` +
    `${s.stillLiveAtTwilio} still live at Twilio (NOT touched — needs manual attention), ${s.errors} lookup error(s)` +
    (s.leftUnverified ? `, ${s.leftUnverified} Twilio could not confirm ended (left open)` : '') +
    (s.alreadyClosed ? `, ${s.alreadyClosed} already closed by another writer` : '')
  );
}
