/**
 * Why the xAI connection ended, on every call that ended as `provider_failure`
 * (v259). One PHI-free `call_events` row per such call, `category = 'session'`,
 * `message = 'provider_close_summary'`.
 *
 * WHY: on 2026-11-21 runtime calls dropped in groups, every open socket
 * closing 1006 with no reason inside a second of the others, on a ~100 s grid
 * whose phase drifted slowly. Our code has no 100 s timer and no heartbeat,
 * and xAI sends no pings. A test socket held open from outside Replit stayed
 * up through three of those drops, so the suspect is our side: the network
 * path out of the deployment, or a stall in this process. Nothing recorded
 * could tell those apart, because `ws` 8 reports a reset and an orderly close
 * the same way (ProviderCloseDiagnostics, grokSession.ts). This row carries
 * the raw socket's signal, the timings, the trace and Cloudflare ids, how many
 * sockets were open, and how late the event loop was running.
 *
 * Reading it:
 *   - socketErrorCode ECONNRESET, loop quiet: something on the path reset the
 *     connections. The network, not us.
 *   - socketEndReceived true, no close frame: something closed them in order
 *     (a proxy or load balancer timing out).
 *   - eventLoopMaxMs or msSinceLoopTick in the seconds: this process stopped
 *     reading and writing, and the peer gave up on it.
 *
 * An instrument, never a gate: it changes nothing a caller hears. No audio, no
 * transcript, no provider error message (it can echo the caller).
 */
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";
import type { ProviderCloseDiagnostics } from "./grokSession";

export const PROVIDER_CLOSE_EVENT = "provider_close_summary";

export interface ProviderCloseEvent {
  level: "warn";
  data: Record<string, unknown>;
}

/**
 * The row for a call, or null when the call did not end on the provider.
 * A caller's hangup, a transfer or the agent ending the call is not a drop,
 * and the socket closing after it says nothing about the drops.
 */
export function providerCloseEvent(
  outcome: string,
  diagnostics: ProviderCloseDiagnostics | undefined,
  proc: { uptimeSec: number } = { uptimeSec: Math.round(process.uptime()) },
  /**
   * `call`: the socket ended on a call that had started. `setup`: the
   * provider never answered well enough to start one (a refused handshake,
   * every first-event retry stalled).
   */
  stage: "call" | "setup" = "call",
): ProviderCloseEvent | null {
  if (outcome !== "provider_failure") return null;
  return {
    level: "warn",
    data: {
      outcome,
      stage,
      // A transport that keeps no diagnostics (a test fake, or a build that
      // lost them) says so rather than reading as a clean close.
      diagnostics: diagnostics ? "present" : "absent",
      ...(diagnostics ?? {}),
      uptimeSec: proc.uptimeSec,
    },
  };
}

export async function logProviderClose(
  call: { callSid: string; outcome: string; stage?: "call" | "setup" },
  diagnostics: ProviderCloseDiagnostics | undefined,
  ids: { callLogId?: string } = {},
  opts: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /**
     * A predecessor writing to the SAME per-SID buffer. Emit first and wait
     * only before flushing, the other teardown writers' discipline (#322
     * rounds 3 and 4).
     */
    after?: Promise<unknown>;
  } = {},
): Promise<boolean> {
  const ev = providerCloseEvent(call.outcome, diagnostics, undefined, call.stage ?? "call");
  if (!ev) return false;
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(call.callSid, ev.level, "session", PROVIDER_CLOSE_EVENT, ev.data, {
    callSid: call.callSid,
    callLogId: ids.callLogId,
  });
  if (opts.after) await opts.after.catch(() => undefined);

  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Release only on a flush that LANDED; an unflushed buffer is the reaper's.
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCallEvents(call.callSid)) {
      releaseCallEvents(call.callSid);
      return true;
    }
    if (attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  console.warn(
    `[PROVIDER CLOSE] the ${PROVIDER_CLOSE_EVENT} row did not land for ${call.callSid} — left for the reaper`,
  );
  return false;
}
