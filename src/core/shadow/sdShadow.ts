/**
 * GATE C for the SD line — the new scheduling line run silently beside the
 * old one, on real calls, writing nothing.
 *
 * Why this exists: replay cannot answer whether the new line BOOKS as well as
 * the old one. The Gate B harness can only serve an availability offer that
 * the original call happened to record, and only confirm a booking the
 * original recorded — so "new booked 7, old called sage_book 30 times" is the
 * harness's ceiling, not a comparison. The only honest measurement is a live
 * one (docs/rebuild/monday-review.md §5).
 *
 * TWO PROPERTIES THIS FILE MUST HAVE, and both are structural, not careful:
 *
 *  1. It cannot touch the call. It is a SUBSCRIBER to shadowTap, the existing
 *     fire-and-forget observation surface — it adds no line to
 *     voiceAgentRoutes.ts and the live path never awaits it. Every entry point
 *     is wrapped; a throw in here dies in here.
 *
 *  2. It cannot write anything, anywhere. `book`, `transfer` and `fileCallback`
 *     are NEVER wired to the real services — they are recorders that return a
 *     neutral result. The only real service it calls is availability, which is
 *     a read. There is no code path from this file to a booking, a transfer,
 *     a ticket, or NextGen, because the functions that could do those things
 *     are not passed in.
 *
 * Off unless SD_SHADOW=1 *and* the shadow tap itself is enabled for
 * azul-scheduling:
 *
 *   SD_SHADOW=1
 *   SHADOW_MODE_ENABLED=1
 *   SHADOW_AGENT_ALLOWLIST=azul-scheduling
 *   SHADOW_CAPTURE_PCT=100
 *
 * Read the results with sdShadowReport().
 */
import { createSchedulingLine, type SchedulingLineServices, type AvailabilityOffer } from '../schedulingLine';
import type { CoreAction, LineModule } from '../types';
import { seedLedger, releaseLedger } from '../../services/callFactsLedger';
// The tap is the observation surface itself: config + contracts only, no
// writers. Static so the subscription is deterministic rather than a runtime
// require() that silently no-ops under ESM.
import { shadowTap } from '../../shadow/tap';

const SLUG = 'azul-scheduling';

/** What the shadow learned about one call. No transcript is kept. */
export interface SdShadowRun {
  callId: string;
  startedAt: string;
  turns: number;
  /** The line asked the live service for openings this many times. */
  availabilityCalls: number;
  /** …and got a real offer back this many times. */
  liveOffers: number;
  /** It reached the point of booking — the evidence Gate B cannot produce. */
  wouldBook: boolean;
  wouldBookOption: number | null;
  /** It would have handed to a human, with the reason. */
  wouldTransfer: string | null;
  /** It would have filed a callback (transfer path only). */
  wouldFileCallback: boolean;
  /** Final state of the machine when the call ended. */
  endState: string | null;
  error?: string;
}

const runs = new Map<string, { run: SdShadowRun; line: LineModule; queue: Promise<void> }>();
const finished: SdShadowRun[] = [];
const MAX_KEPT = 500;

export function sdShadowEnabled(): boolean {
  return process.env.SD_SHADOW === '1' || process.env.SD_SHADOW === 'true';
}

/**
 * Services for a shadow run. Note what is and is not here: availability is
 * real (a read); book, transfer and fileCallback are recorders. The line
 * cannot reach a write because nothing that writes was passed to it.
 */
function shadowServices(run: SdShadowRun): SchedulingLineServices {
  return {
    async verifyIdentity(_callId, first, last, dob) {
      try {
        const { scheduleLookupService } = await import('../../services/scheduleLookupService');
        const r = await scheduleLookupService.lookupByNameAndDOB(first, last, dob);
        return Boolean((r as { patientFound?: boolean })?.patientFound);
      } catch {
        return false;
      }
    },
    async availability(_callId, pref): Promise<AvailabilityOffer> {
      run.availabilityCalls += 1;
      try {
        const { callEyecareTool } = await import('../../agents/azulSchedulingAgent');
        const raw = await callEyecareTool('sage_availability', { ...pref });
        const r = JSON.parse(raw) as { say?: string; options?: Array<{ time?: string; start?: string }> };
        const say = String(r.say ?? '');
        const optionTimes = (r.options ?? [])
          .map((o) => String(o.time ?? o.start ?? ''))
          .map((x) => (x.match(/\d{2}:\d{2}/) ?? [''])[0])
          .filter(Boolean);
        if (say) run.liveOffers += 1;
        return { say: say || "I don't have anything matching that right now.", optionTimes, empty: optionTimes.length === 0 };
      } catch {
        return { say: "I don't have anything matching that right now.", optionTimes: [], empty: true };
      }
    },
    /** RECORDER. Nothing is booked. This is the whole point of Gate C. */
    async book(_callId, input) {
      run.wouldBook = true;
      run.wouldBookOption = input.optionNumber;
      return { status: 'unknown' };
    },
    /** RECORDER. Nobody is dialled. */
    async transfer(_callId, reason) {
      run.wouldTransfer = reason;
      return { ok: false }; // false so the callback path is exercised too
    },
    /** RECORDER. No ticket is filed. */
    async fileCallback() {
      run.wouldFileCallback = true;
      return { ok: true };
    },
  };
}

function start(callId: string, callerPhone?: string): void {
  const run: SdShadowRun = {
    callId,
    startedAt: new Date().toISOString(),
    turns: 0,
    availabilityCalls: 0,
    liveOffers: 0,
    wouldBook: false,
    wouldBookOption: null,
    wouldTransfer: null,
    wouldFileCallback: false,
    endState: null,
  };
  const line = createSchedulingLine(shadowServices(run));
  // The shadow keeps its OWN ledger key so it can never collide with the
  // live call's facts.
  seedLedger(shadowKey(callId), { callerPhone });
  line.start(shadowKey(callId));
  runs.set(callId, { run, line, queue: Promise.resolve() });
}

/** A distinct ledger identity, so shadow facts and live facts never mix. */
function shadowKey(callId: string): string {
  return `sd-shadow:${callId}`;
}

/**
 * Turns are SERIALISED per call. A state machine fed two turns at once
 * answers the second against the state the first has not finished setting —
 * the shadow's first live test showed exactly that, landing back in
 * ASK_PREFERENCE after an offer it had already made. Real calls have gaps,
 * but a fast caller (or a slow availability lookup) closes them.
 */
function onCallerTurn(callId: string, text: string): void {
  const entry = runs.get(callId);
  if (!entry) return;
  // The entry is captured, not looked up again at execution time: a turn that
  // is already queued must finish even if the call has ended underneath it.
  // Looking it up again silently dropped the LAST turn of every call — which
  // is the turn that accepts an appointment.
  entry.queue = entry.queue.then(() => runTurn(entry, callId, text)).catch((err) => {
    entry.run.error = String(err);
  });
}

async function runTurn(
  entry: { run: SdShadowRun; line: LineModule },
  callId: string,
  text: string,
): Promise<void> {
  entry.run.turns += 1;
  let action: CoreAction | null = await entry.line.onUtterance(shadowKey(callId), text);
  // Walk the follow-up chain so the service calls actually happen — that is
  // where availability/book/transfer live.
  let guard = 0;
  while (action && guard++ < 12) {
    action = action.followUp ? await action.followUp() : null;
  }
  entry.run.endState = entry.line.stateOf(shadowKey(callId));
}

function end(callId: string): void {
  const entry = runs.get(callId);
  if (!entry) return;
  // Drain first: the last turn may still be waiting on a live availability
  // lookup, and that turn is often the one that reaches booking.
  void entry.queue.then(() => finish(callId, entry));
  runs.delete(callId);
}

function finish(callId: string, entry: { run: SdShadowRun; line: LineModule }): void {
  entry.run.endState = entry.line.stateOf(shadowKey(callId)) ?? entry.run.endState;
  try {
    entry.line.release(shadowKey(callId));
    releaseLedger(shadowKey(callId));
  } catch {
    /* teardown is best effort */
  }
  finished.push(entry.run);
  while (finished.length > MAX_KEPT) finished.shift();
  console.info(
    `[SD-SHADOW] ${callId} turns=${entry.run.turns} availability=${entry.run.availabilityCalls}` +
      ` liveOffers=${entry.run.liveOffers} wouldBook=${entry.run.wouldBook}` +
      ` wouldTransfer=${entry.run.wouldTransfer ?? '-'} end=${entry.run.endState}`,
  );
}

/** What the shadow has seen so far. Counts only — no transcripts. */
export function sdShadowReport(): {
  live: number;
  completed: number;
  reachedBooking: number;
  gotLiveOffer: number;
  transferred: number;
  runs: SdShadowRun[];
} {
  return {
    live: runs.size,
    completed: finished.length,
    reachedBooking: finished.filter((r) => r.wouldBook).length,
    gotLiveOffer: finished.filter((r) => r.liveOffers > 0).length,
    transferred: finished.filter((r) => r.wouldTransfer).length,
    runs: [...finished],
  };
}

/** Test seam. */
export function _resetSdShadow(): void {
  runs.clear();
  finished.length = 0;
}

/**
 * Subscribe to the tap. Everything is wrapped: this function, the handler,
 * and each async turn. A shadow failure can only ever cost us the shadow.
 */
export function initSdShadow(): { enabled: boolean } {
  if (!sdShadowEnabled()) return { enabled: false };
  try {
    shadowTap.subscribe((events) => {
      for (const e of events) {
        if (e.agentId !== SLUG) continue;
        try {
          if (e.type === 'session_started') {
            start(e.sessionId, undefined);
          } else if (e.type === 'user_transcript') {
            const text = String((e.payload as { text?: unknown }).text ?? '').trim();
            if (text) onCallerTurn(e.sessionId, text);
          } else if (e.type === 'session_completed' || e.type === 'session_failed') {
            end(e.sessionId);
          }
        } catch (err) {
          console.warn('[SD-SHADOW] event handling failed (call unaffected):', err);
        }
      }
    });
    console.info('[SD-SHADOW] enabled — the scheduling line runs silently; nothing is booked, dialled or filed');
    return { enabled: true };
  } catch (err) {
    console.error('[SD-SHADOW] failed to start (call path unaffected):', err);
    return { enabled: false };
  }
}
