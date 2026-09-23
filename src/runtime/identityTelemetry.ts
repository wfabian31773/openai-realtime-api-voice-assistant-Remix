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
 *   entryCertain AND NOT identityHeld an INVARIANT BREACH, not a diagnosis —
 *                                   unreachable today, see below
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
 *            -- Only lookups the probe could have SEEN. See below.
 *            AND (t->>'at')::timestamptz <= (e.data->>'probedAt')::timestamptz
 *          ORDER BY t->>'at' DESC LIMIT 1) = 'true';
 *
 * **IT READS THE CALL'S LAST LOOKUP, NOT ANY LOOKUP** (Codex P2, #322). An
 * `EXISTS` over every event counts a call that matched certainly and THEN came
 * back ambiguous on the same name — where `forgetIfSameName` deliberately
 * deletes the entry, so `no_entry` is the CORRECT answer and not a mismatch at
 * all. Taking the final outcome excludes exactly that downgrade.
 *
 * **AND ONLY THE LOOKUPS THE PROBE COULD HAVE SEEN** (Codex P2, #322 round 5).
 * `teardown` starts the persist without awaiting a `lookup_patient` still in
 * flight, so that dispatch can settle AFTER the store was read and write its
 * certain result to `tool_timeline` regardless. The probe then honestly reports
 * `no_entry` while the timeline's final lookup reads certain — and unbounded,
 * this JOIN files that call as the write and the read disagreeing about the
 * SID, which is the single hypothesis it exists to test. `probedAt` is the
 * instant `identityStoreProbe` read the map, and the clause above keeps the
 * join to evidence that existed by then.
 *
 * It is a small population and it is the wrong one to be wrong about: over the
 * seven days to 2026-09-17, 3 of 1,553 runtime calls had ANY lookup event after
 * `end_time`, 1 of them CERTAIN (recorded on task #57, where the behaviour
 * itself was declined as sub-1%). A handful of false mismatches would be
 * pointing the eighth-cause hunt at a door that is not open.
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
 * WARN names the shapes that are defects rather than absences: an identity the
 * process HELD whose row write then failed or could not be confirmed, and the
 * invariant breach below.
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
  /**
   * WHAT THE PRE-CONTEXT WRITE DID, when there was one: `stored` | `merged` |
   * `refused_sid` | `refused_name`, and absent when pre-context vouched for
   * nobody so no write was attempted.
   *
   * This is the other half of the fork `storeSize: 0` cannot split. All three
   * of `rememberVerifiedIdentity`'s early returns leave the map empty, so an
   * empty store beside an ABSENT verdict says the write was never reached and
   * beside a refusal says which guard turned it away. The lookup tool reports
   * its own write on `tool_timeline.identity_write`; this is the runtime's.
   * See docs/observatory/SPEC-20260923.md.
   */
  precontextWrite?: string,
): IdentityEvent {
  const identityHeld = identity.patientFound === true;
  const reachedRow = identityHeld && persisted === true;
  const writeLost = identityHeld && persisted === false;
  const writeUnconfirmed = identityHeld && persisted === null;
  /**
   * AN INVARIANT TRIPWIRE, AND UNREACHABLE BY CONSTRUCTION TODAY — Codex P2,
   * #322 round 3, and it is recorded rather than dressed up as a diagnosis.
   *
   * `identityForRow` calls `verifiedIdentityFor` and sets `patientFound: true`
   * for ANY value it returns, and that accessor answers only for a live CERTAIN
   * entry; `identityStoreProbe` then re-reads the same map on the next
   * synchronous line, with no await between them and a 30-minute TTL. So
   * `entryCertain` implies `identityHeld`, and this arm cannot fire in
   * production. It is NOT evidence of a read-to-hand-over failure, and the
   * earlier doc claiming it was is corrected above.
   *
   * It stays because it costs nothing and it is the one thing that would notice
   * the coupling being broken later — `identityForRow` made async, a condition
   * added between the two reads, the accessor loosened. A non-zero count means
   * THAT, and the verdict is named so nobody reads it as v51 dropping a record.
   */
  const certainLost = probe.entryCertain && !identityHeld;
  return {
    level: certainLost || writeLost || writeUnconfirmed ? "warn" : "info",
    data: {
      ...(precontextWrite ? { precontextWrite } : {}),
      storeSize: probe.size,
      certainEntries: probe.certainEntries,
      sidCanonical: probe.sidCanonical,
      hasEntry: probe.hasEntry,
      entryCertain: probe.entryCertain,
      entryHasDob: probe.entryHasDob,
      /**
       * WHEN the store was read, so the mismatch JOIN above can exclude a
       * `lookup_patient` that settled after it. ISO rather than epoch ms
       * because the value it is compared against — `tool_timeline`'s `at` — is
       * ISO, and a join that has to convert one side invites getting the
       * conversion wrong in a query nobody runs twice.
       */
      probedAt: new Date(probe.at).toISOString(),
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
              ? "certain_but_not_held"
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
  opts: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** Forwarded to `identityEvent` — see its own parameter. */
    precontextWrite?: string;
    /**
     * The other `call_events` writer for this call, awaited BEFORE flushing so
     * the two never release the same buffer concurrently — see the call site.
     */
    after?: Promise<unknown>;
  } = {},
): Promise<boolean> {
  const ev = identityEvent(identity, probe, persisted, opts.precontextWrite);
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import(
    "../services/callEventLog"
  );
  /**
   * EMITTED BEFORE ANYTHING IS AWAITED (Codex P1, #322 round 3).
   *
   * `flushCallEvents` is UNBOUNDED — it awaits `db.execute` with no timeout —
   * so a wedged pool leaves the predecessor's flush pending forever. Emitting
   * after that wait would mean the row is never buffered at all, and the 2h
   * reaper cannot recover what was never emitted: the same wedged pool that
   * produces `row_write_unconfirmed` would silently suppress the diagnostic
   * row explaining it. That is the serialisation of round 2 turning into a
   * worse defect than the race it fixed.
   *
   * Emitting first makes the row reachable whatever happens next: the stuck
   * predecessor claimed only its own slice, so a later flush — this writer's
   * own, or the reaper's — picks this event up.
   *
   * **THAT REASONING ONLY EVER COVERED A PREDECESSOR THAT FAILS** (Codex P1,
   * #322 round 4). A predecessor that SUCCEEDS released the buffer, and
   * `releaseCallEvents` deleted it whole — this row included, before any flush
   * or reaper could see it, while `flushCallEvents` answered TRUE below for a
   * call it could no longer find. That is the common case, not an edge: every
   * runtime call that owed a follow-up. The root fix is in
   * `releaseCallEvents`, which now keeps a buffer holding events nobody has
   * written; `src/runtime/bothTeardownRowsLand.test.ts` drives both writers
   * over the real module and goes red without it.
   */
  emitCallEvent(record.callSid, ev.level, "tool", IDENTITY_EVENT, ev.data, {
    callSid: record.callSid,
    callLogId: ids.callLogId,
    agentSlug: record.slug,
  });
  /**
   * DELIBERATELY UNBOUNDED, and that is safe only because of the emit above.
   * Bounding it would let this flush release a buffer whose slice the
   * predecessor has already claimed but not yet written — recreating the round
   * 2 loss in the one case that matters.
   *
   * Since round 4 this ordering is defence in depth rather than the only thing
   * standing between the row and a delete: `releaseCallEvents` no longer drops
   * unwritten events, so the two writers are safe in either order. It is kept
   * because serialised they usually cost one INSERT rather than two.
   */
  if (opts.after) await opts.after.catch(() => undefined);
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
