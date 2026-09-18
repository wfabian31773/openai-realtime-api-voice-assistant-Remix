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
 *   hasEntry AND NOT entryCertain   the entry survives, its certainty does not
 *   entryCertain AND NOT identityHeld the read answered and the hand-over lost it
 *   rowWrite failed / unconfirmed   the identity was held and the UPSERT did
 *                                   not (or may not have) landed it
 *
 * **`storeSize` DOES NOT SAY THIS CALL'S WRITE USED THE WRONG SID, AND THE
 * FIRST VERSION OF THIS FILE CLAIMED IT DID** (Codex P1, #322). `verified` is
 * process-wide with a 30-minute TTL and nothing deletes an entry at teardown,
 * so on a busy lane there are always OTHER calls' entries in it: `size > 0 &&
 * !hasEntry` would be true for essentially every call that legitimately has
 * no identity, and the warn bucket would fill with them. The counts stay
 * because they say whether the store is working AT ALL — `size` flat at 0
 * across a whole busy day is itself a finding — but no per-call verdict and
 * no warning is built on them.
 *
 * **The SID-disagreement question is answered by a JOIN instead**, and better,
 * because `tool_timeline` is written through a different path than the store's
 * key: a call whose `lookup_patient` reported `identity_is_certain: true` and
 * whose `identity_summary` reads `no_entry` is the mismatch.
 *
 *   SELECT count(*) FROM call_logs c
 *   JOIN call_events e ON e.call_sid = c.call_sid
 *    AND e.category = 'tool' AND e.message = 'identity_summary'
 *   WHERE e.data->>'verdict' = 'no_entry'
 *     AND (SELECT t->'outcome'->>'identity_is_certain'
 *          FROM jsonb_array_elements(c.tool_timeline->'events') t
 *          WHERE t->>'tool' = 'lookup_patient'
 *          ORDER BY t->>'at' DESC LIMIT 1) = 'true';
 *
 * **IT READS THE CALL'S LAST LOOKUP, NOT ANY LOOKUP** (Codex P2, #322). An
 * `EXISTS` over every event counts a call that matched certainly and THEN came
 * back ambiguous on the same name — where `forgetIfSameName` deliberately
 * deletes the entry, so `no_entry` is the CORRECT answer and not a mismatch at
 * all. Taking the final outcome excludes exactly that downgrade.
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
 * WARN names the shapes that are defects rather than absences: a certain entry
 * that did not reach the row (v51 failing outright), and an identity the
 * process HELD whose row write then failed or could not be confirmed.
 * Everything else — including an empty store on a call whose lookup found
 * nobody — is the honest absence this row exists to count.
 *
 * There is deliberately no `key_mismatch` verdict; see the note above. A store
 * holding other calls' entries is the NORMAL state of a process-wide map, not
 * evidence about this call.
 *
 * **`reached_row` IS EARNED BY THE WRITE, NOT BY THE READ** (Codex P1, #322).
 * The first version derived it from `identity.patientFound` alone, so when
 * `persistRuntimeCall` exhausted its retries — or `withinOrNull` timed out —
 * the verdict said the identity was written while `call_logs.patient_found`
 * stayed unset. That is the write-stage failure this telemetry exists to
 * isolate, hidden by the telemetry. `persisted` now carries the upsert's own
 * answer, and the three cases are kept apart rather than flattened:
 *
 *   true   the upsert reported success
 *   false  it failed after its retries — the row has no name
 *   null   the deadline won; the write is still running and MAY land, so this
 *          is unconfirmed and never reported as either outcome
 */
export function identityEvent(
  identity: RuntimeCallIdentity,
  probe: IdentityStoreProbe,
  persisted: boolean | null,
): IdentityEvent {
  const identityHeld = identity.patientFound === true;
  const reachedRow = identityHeld && persisted === true;
  const writeLost = identityHeld && persisted === false;
  const writeUnconfirmed = identityHeld && persisted === null;
  const certainLost = probe.entryCertain && !identityHeld;
  return {
    level: certainLost || writeLost || writeUnconfirmed ? "warn" : "info",
    data: {
      storeSize: probe.size,
      certainEntries: probe.certainEntries,
      sidCanonical: probe.sidCanonical,
      hasEntry: probe.hasEntry,
      entryCertain: probe.entryCertain,
      entryHasDob: probe.entryHasDob,
      reachedRow,
      /** The identity the read produced, whatever the write then did with it. */
      identityHeld,
      /** The upsert's own answer: ok / failed / unconfirmed (the deadline won). */
      rowWrite: persisted === true ? "ok" : persisted === false ? "failed" : "unconfirmed",
      // Which one the row is an instance of, so the common case is one GROUP BY
      // rather than several booleans a reader has to combine correctly.
      verdict: reachedRow
        ? "reached_row"
        : writeLost
          ? "row_write_failed"
          : writeUnconfirmed
            ? "row_write_unconfirmed"
            : certainLost
              ? "certain_but_dropped"
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
  /** What `persistRuntimeCall` answered — see identityEvent. */
  persisted: boolean | null,
  ids: { callLogId?: string } = {},
  opts: { backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const ev = identityEvent(identity, probe, persisted);
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
