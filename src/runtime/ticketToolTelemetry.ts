/**
 * THE TICKET-TOOL SUMMARY ROW AT TEARDOWN — v166. See
 * `src/tools/ticketToolOutcomes.ts` for what is recorded and why.
 *
 * The identity writer's discipline (#322 rounds 3 and 4): emit first, wait for
 * the predecessor only before FLUSHING, release only on a flush that landed,
 * never awaited by teardown. A call that ran no ticket tool writes nothing —
 * there is no question to answer on it.
 *
 * STATIC import of the outcome store: `runTool` writes it through a static
 * import, and on Node 20 a dynamic import of a module already loaded
 * statically evaluates it a second time (the v78/v90/v141 class).
 */
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";
import { takeTicketToolOutcomes, ticketToolEvent, TICKET_TOOL_EVENT } from "../tools/ticketToolOutcomes";

export async function logTicketToolOutcomes(
  call: { callSid: string; slug: string },
  ids: { callLogId?: string } = {},
  opts: {
    after?: Promise<unknown>;
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const list = takeTicketToolOutcomes(call.callSid);
  if (list.length === 0) return true;
  const ev = ticketToolEvent(list);
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(call.callSid, ev.level, "tool", TICKET_TOOL_EVENT, ev.data, {
    callSid: call.callSid,
    callLogId: ids.callLogId,
    agentSlug: call.slug,
  });
  if (opts.after) await opts.after.catch(() => undefined);
  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCallEvents(call.callSid)) {
      releaseCallEvents(call.callSid);
      return true;
    }
    if (attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  console.warn(`[CALL-EVENTS] ${TICKET_TOOL_EVENT} for ${call.callSid} not durable — left for the reaper`);
  return false;
}
