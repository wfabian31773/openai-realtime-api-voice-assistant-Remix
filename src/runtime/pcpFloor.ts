/**
 * THE PCP LOST-REQUEST FLOOR, ON THIS RUNTIME.
 *
 * `sweepPcpUnfiledCall` (pcpAgent.ts) is the teardown filer for the PCP lane:
 * when a call ends with no durable disposition it files what the intake
 * gathered, annotated so nobody mistakes a gap for something the caller said.
 * Three ships of work went into its admissions — v18 (the caller who asked for
 * a person and was refused), v30/v31 (the call nobody classified, and the
 * narrative clamp).
 *
 * IT HAD NEVER RUN. Its only caller was `voiceAgentRoutes.ts:4713`, inside the
 * OLD CORE's OpenAI SIP session teardown, and PCP moved to this runtime on
 * 2026-09-04. The runtime's own teardown sweep declines the lane by table —
 * `DEPARTMENT_BY_SLUG` in requestSweep.ts holds optical/surgery/tech/records,
 * so `decideSweep` returns `not-a-queue-lane` for pcp before any other test.
 * So PCP had no teardown filer at all on the pipeline that serves it.
 *
 * Confirmed from production rather than inferred: across ALL of
 * `voice_agent_api_logs`, 0 POSTs have ever carried `failureInformation` =
 * `caller_hung_up_before_completion` or `call_not_classified`, the two literals
 * only that function writes. Full corpus and the measured before-arm:
 * `docs/observatory/W2-CORPUS-20260922.md`.
 *
 * WHY BOTH SWEEPS ARE CALLED AND CANNOT DOUBLE-FILE. The generic sweep runs
 * first and declines pcp at its first line; this one runs only for pcp. Adding
 * `pcp` to `DEPARTMENT_BY_SLUG` instead would have been the smaller diff and
 * the wrong one: that path builds a queue-lane payload against a department id
 * and would file the wrong shape to the wrong place, where this lane has its
 * own endpoint (`/api/voice-agent/pcp-ticket`), its own payload and its own
 * disposition rules.
 *
 * WHAT IS STILL INERT HERE, stated rather than left to be discovered. The
 * runtime supplies no `getTranscript` in its lane context — only the old core
 * does — so inside the sweep `transcript` is `''`,
 * `saidMoreThanTheirOwnIdentity` is false, and the `unclassified` admission
 * (which needs it) CANNOT fire on this pipeline. That costs nothing on the
 * population measured for this change: all 38 calls of 2026-09-22 carried a
 * `callPurpose` at teardown, and `unclassified` requires the purpose to be
 * ABSENT. It also means a floor-filed ticket carries no `transcript` field on
 * its POST — `ticketingSyncService.syncCall` puts the transcript on the ticket
 * after the call regardless, so a staffer still gets the caller's words, just
 * not in the same request. Supplying the getter is a separate change with its
 * own arm; it is not smuggled in behind this one.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";

/** Only this lane has a PCP director, PCP metadata and a PCP endpoint. */
export const PCP_FLOOR_LANE = "pcp";

/**
 * The same bound the old core has always used on this call
 * (`voiceAgentRoutes.ts` races it against 25s).
 *
 * BOUNDED FOR THE REASON THE PERSIST ABOVE IT IS. `submitPcpTicket` is an HTTP
 * POST with its own retries, and a wedged ticketing app makes it settle late or
 * never; teardown must not be held open behind it. The sweep's own `finally`
 * still runs when it eventually settles, so losing the race costs the ticket,
 * never the cleanup.
 */
export const PCP_FLOOR_BUDGET_MS = 25_000;

/** The floor's one dependency: the lane's own teardown filer. */
type PcpSweep = (callId: string) => Promise<void>;

interface PcpFloorOptions {
  /** Injected for tests. Defaults to the real sweep, lazily imported. */
  sweep?: PcpSweep;
  budgetMs?: number;
}

/**
 * Run the PCP floor for a finished call. A no-op on every other lane.
 *
 * NEVER THROWS and never rejects: the call is already over, and a failed sweep
 * must not surface anywhere near the caller. `sweepPcpUnfiledCall` has its own
 * try/catch, so the guard here is for the dynamic import and for an injected
 * seam that misbehaves.
 *
 * KEYED ON THE CallSid, which is what makes this work at all: the runtime
 * builds the lane agent with `callId: entry.callSid` (voiceRuntime.ts), so the
 * director state and the metadata the sweep reads are stored under exactly this
 * string. A different key would read an empty state and file nothing, silently.
 */
export async function runPcpFloor(
  record: VoiceCallRecord,
  options: PcpFloorOptions = {},
): Promise<void> {
  if (record.slug !== PCP_FLOOR_LANE) return;
  const budgetMs = options.budgetMs ?? PCP_FLOOR_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sweep: PcpSweep =
      options.sweep ?? (await import("../agents/pcpAgent")).sweepPcpUnfiledCall;
    await Promise.race([
      sweep(record.callSid),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (e) {
    console.error(`[PCP FLOOR] sweep failed for ${record.callSid} (call already ended):`, e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
