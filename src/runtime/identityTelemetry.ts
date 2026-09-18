/**
 * WHY THE RECORD DID OR DID NOT REACH THE CALL ROW — task #148.
 *
 * v51 reads `verifiedIdentityFor` at teardown and writes a CERTAIN match onto
 * `patient_found` / `patient_name` / `patient_dob`. MEASURED 2026-09-17, the
 * first full day on the v56 build: `patient_found = true` on **0 of 633** grok
 * calls, while **209 of those calls ran a `lookup_patient` that reported
 * `identity_is_certain: true`** (187 by phone, 22 by name and date of birth).
 *
 * SEVEN CANDIDATE CAUSES WERE RULED OUT FROM OUTSIDE AND THE EIGHTH COULD NOT
 * BE REACHED: not deployed (v52 sits above v51 in the same chain and IS live —
 * `twilio_cost_cents` went 6.5-24% to 100%), two module instances (probed under
 * `npx tsx`, the production entry point — one instance), the column mapping,
 * the model overwriting `call_sid` (`realtimeAdapter` spreads injected last),
 * the lane agent being cached with a frozen SID (`resolveLane` builds fresh per
 * call), the chain itself (real `lookup_patient` through `runTool` then
 * `identityForRow` returns the name for both match shapes), and
 * `forgetIfSameName` clearing the entry (192 of the 209 never went ambiguous at
 * all, and 208 of 209 ENDED on a certain lookup).
 *
 * THE REASON SEVEN CONTROLS COULD NOT REACH IT: `identityForRow` returning `{}`
 * is invisible. No console line, no column, no timeline key — and the
 * `undefined` behind it is four different facts at once. This makes the split
 * readable, on the next live call, from SQL:
 *
 *   SELECT data->>'storeSize', data->>'hasEntry', data->>'entryCertain',
 *          data->>'reachedRow', count(*)
 *   FROM call_events
 *   WHERE category = 'tool' AND message = 'identity_summary'
 *   GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;
 *
 *   storeSize 0                     nothing in the store at teardown at all
 *   storeSize > 0 AND NOT hasEntry  entries under OTHER keys — the write and
 *                                   the read disagree about this call's SID
 *   hasEntry AND NOT entryCertain   the entry survives, its certainty does not
 *   entryCertain AND NOT reachedRow the read answered and the write dropped it
 *
 * AN INSTRUMENT, NOT A FIX. It changes nothing a caller hears and nothing that
 * reaches a ticket. It is deliberately the v47/v48 move — make it countable
 * before touching identity, which is the one field where a wrong answer puts
 * one patient's name on another patient's request.
 *
 * EVERY CALL WRITES ONE ROW, unlike v55's summary which skips a call that owed
 * no follow-up. Here "there was nothing in the store" IS the finding, so a
 * skip would hide exactly the population being measured and would leave the
 * denominator as unknowable as it is today. ~650 rows a day.
 *
 * PHI-FREE, and stricter than it looks: counts and booleans only. No name, no
 * date of birth, no office, no phone — and never a map key, because a key here
 * is one call's identifier sitting beside another call's in a table. The row's
 * own `call_sid` column is the call's own SID and is what every other
 * `call_events` row already carries.
 *
 * Telemetry: after the row, after the sweep, never awaited by teardown, and a
 * failure is one console line with the buffer kept for the reaper — the rule
 * Codex round 9 of #321 established on the follow-up writer, for the same
 * reason: a database blip must not delete the only copy of the measurement it
 * just made necessary.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";
import type { RuntimeCallIdentity } from "./callRecord";
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";
import type { IdentityStoreProbe } from "../tools/verifiedIdentity";

export const IDENTITY_EVENT = "identity_summary";

export interface IdentityEvent {
  level: "info" | "warn";
  data: Record<string, unknown>;
}

/**
 * WARN names the two shapes that are defects rather than absences.
 *
 * A certain entry that did not reach the row is v51 failing outright. Entries
 * present under other keys while this call has none is the write and the read
 * disagreeing about the SID — the hypothesis the 2026-09-17 measurement could
 * not test. Everything else, including an empty store on a call whose lookup
 * found nobody, is the honest absence this row exists to count.
 */
export function identityEvent(
  identity: RuntimeCallIdentity,
  probe: IdentityStoreProbe,
): IdentityEvent {
  const reachedRow = identity.patientFound === true;
  const keyMismatch = probe.size > 0 && !probe.hasEntry && probe.sidCanonical;
  const certainLost = probe.entryCertain && !reachedRow;
  return {
    level: certainLost || keyMismatch ? "warn" : "info",
    data: {
      storeSize: probe.size,
      certainEntries: probe.certainEntries,
      sidCanonical: probe.sidCanonical,
      hasEntry: probe.hasEntry,
      entryCertain: probe.entryCertain,
      entryHasDob: probe.entryHasDob,
      reachedRow,
      // Which of the four the row is an instance of, so the common case is one
      // GROUP BY rather than four booleans a reader has to combine correctly.
      verdict: reachedRow
        ? "reached_row"
        : certainLost
          ? "certain_but_dropped"
          : keyMismatch
            ? "key_mismatch"
            : probe.hasEntry
              ? "entry_not_certain"
              : !probe.sidCanonical
                ? "sid_not_canonical"
                : "no_entry",
    },
  };
}

export async function logRuntimeIdentity(
  record: VoiceCallRecord,
  identity: RuntimeCallIdentity,
  probe: IdentityStoreProbe,
  ids: { callLogId?: string } = {},
  opts: { backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const ev = identityEvent(identity, probe);
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import(
    "../services/callEventLog"
  );
  emitCallEvent(record.callSid, ev.level, "tool", IDENTITY_EVENT, ev.data, {
    callSid: record.callSid,
    callLogId: ids.callLogId,
    agentSlug: record.slug,
  });
  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let durable = false;
  for (let attempt = 0; ; attempt++) {
    durable = await flushCallEvents(record.callSid);
    if (durable || attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  if (durable) releaseCallEvents(record.callSid);
  else
    console.error(
      `[CALL-EVENTS] identity_summary for ${record.callSid} not durable after ${backoff.length + 1} attempt(s) — buffer left for the reaper`,
    );
  return durable;
}
