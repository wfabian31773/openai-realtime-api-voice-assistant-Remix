/**
 * src/runtime/readiness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Live-readiness for the voice runtime. "Live-ready" means this process
 * could take a REAL phone call end to end: authenticate Twilio's webhook,
 * open a Grok realtime session, and reach the database its agents' tools
 * and its own call record need.
 *
 * Missing config NEVER prevents the server from starting. It starts, serves
 * `GET /voice/health`, prints exactly which env var NAMES are missing (names
 * only — a readiness endpoint that leaks a value is a credential leak), and
 * the webhook fails CLOSED: a controlled unavailable response, never an
 * unauthenticated accept and never dead air.
 *
 * THE DEPLOY MARKER IS THE POINT OF THIS FILE.
 *
 * Wayne pulls and republishes on Replit, and a failed pull looks exactly
 * like a failed fix — on 2026-08-11 a GitHub rate limit made his pull fail
 * and the next round was spent analysing stale code. Every build prints the
 * marker below at boot and serves it from /voice/health. If the marker is
 * absent or old, the code is not live and the call proves nothing. Bump it
 * on every ship whose effect is hard to see.
 *
 * THE MARKER CARRIES A DATE BECAUSE THE DISCIPLINE ALONE FAILED.
 *
 * It read `voice-runtime-v2-transfer-guardrails-tools` from 2026-08-29 to
 * 2026-09-05, unchanged across every commit in between — including the one
 * that added the `[runtime] pre-context` diagnostic on 08-31. On 2026-09-05
 * the operator searched a live deployment for that line, found nothing, and
 * the marker could not say whether the build contained it: THE SAME STRING
 * is served by a build from before the line existed and by one from after.
 * An instrument that cannot separate those two is not an instrument, and
 * being one is this file's entire purpose.
 *
 * THE BUILD TURNED OUT TO BE CURRENT, WHICH IS THE STRONGER VERSION OF THE
 * POINT. It was established from `call_logs` instead: 405 grok rows carry an
 * `agent_id` the live process stamped itself (outside the 259-row backfill
 * snapshot), and that code merged 2026-09-04 — comfortably after 08-31. The
 * line was absent because the runtime had served NO CALLS that day, not
 * because it was missing. So the marker was useless in both directions: it
 * could not confirm the build and it could not exonerate it, and a database
 * query had to do the job this constant exists to do.
 *
 * So the marker ENDS IN THE YYYYMMDD IT WAS SET, and `markerSetOn` parses it
 * back out. "Is the deployed build newer than <date>?" is then answerable
 * from the marker alone, by anyone, without our commit history — which is
 * exactly the question that could not be answered above. The boot log and
 * `/voice/health` both carry it, so either one gives the same answer.
 *
 * THE DATE IS A DAY, NOT A BUILD, SO THE NAME STILL HAS TO MOVE. v5 and v6
 * are both 20260911: v5 bumped for the date-of-birth backstop and v6, hours
 * later, for the West Covina misroute that PR #286 introduced and Codex
 * caught after it merged. Anyone republishing between the two would serve a
 * marker whose DATE says current and whose build routes a West Covina caller
 * to our Covina office. Bump the name on every ship whose effect is hard to
 * see, even the second one in a day; the date answers "how old", the name
 * answers "which".
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { callEnvironment } from "./callRecord";

/**
 * 2026-09-11: BUMPED BECAUSE THE MARKER FAILED AT ITS ONE JOB AGAIN, AND THIS
 * TIME IT COST A MORNING.
 *
 * #280 and #281 landed the date-of-birth backstop on 2026-09-10 — `spokenDob`
 * reads the caller's answer off the transcript when the model omits the field,
 * which it does on every single refusal. Neither PR bumped this constant, and
 * nothing else in the health payload has changed since 09-08 (`readiness.ts`
 * had not been touched since `5efa94f`). So every build from 09-08 onward
 * serves a BYTE-IDENTICAL `/voice/health`, and the operator asking "did my
 * publish take?" got the same answer whether it had or not.
 *
 * The cost was concrete. Measured against the 63 calls that hit the
 * date-of-birth gate on 2026-09-10, the shipped parser resolves a date on 51
 * of them; production filed 24. Whether the gap is "not deployed" or
 * "deployed and not firing" decides which of two entirely different jobs comes
 * next, and the marker — the instrument that exists to answer exactly that —
 * could not.
 *
 * `markerSetOn()` reads the suffix, so from here a deployment can be dated
 * without our commit history. The structural question this does NOT answer is
 * what makes a bump non-optional when behaviour changes; a test cannot know
 * that a change was behavioural. That is open, and it is the reason this
 * comment names the two PRs that skipped it.
 *
 * v7, 2026-09-11: THE THIRD BUILD TO SHARE THIS DATE, AND THE REASON THE NAME
 * CARRIES THE MEANING RATHER THAN THE DATE.
 *
 * #288 made `file_optical_ticket` send `routingAskExhausted`, which is what
 * lets the ticketing app take an optical request whose office never resolved
 * instead of refusing it with HTTP 400. Its effect is invisible from outside:
 * it shows up only on a call where the office does not resolve, and the
 * before-state is 48 such calls in 30 days filing nothing at all. So "did the
 * publish take?" is exactly the question the operator will have, and exactly
 * the one a stale marker cannot answer — the failure this constant's own
 * history records twice.
 *
 * It was ALMOST skipped a third time. #288 merged without touching this file;
 * the bump is a follow-up, which is the weakness the comment above already
 * names — nothing makes it non-optional. Bumping this and not the table in
 * CLAUDE.md leaves the trap armed the other way round, so they move together.
 */
/**
 * v14, 2026-09-13: THE PCP QUEUE BECOMES A CHOICE — and it SKIPS v13 on
 * purpose, which is the part to read before assuming a build is missing.
 *
 * #293 (RULE ZERO 2a, the new-or-existing ask) has claimed
 * `voice-runtime-v13-new-or-existing-20260912` on its own branch since before
 * this one existed. Two open branches carrying the same version would make two
 * different builds indistinguishable at `/voice/health`, which is the single
 * thing this constant exists to prevent — so this takes the next free number
 * rather than the next sequential one. A gap in the sequence is readable; a
 * collision is not. #293 still has to merge main and re-bump above whatever
 * main then carries, exactly as CLAUDE.md already requires of it.
 *
 * WHY IT NEEDS A MARKER AT ALL: the change is invisible from outside except on
 * a PCP call where somebody asks for a person, and its whole effect is that
 * ONE outcome stops writing a ticket. A build without it files on every
 * transfer; a build with it files on none of the accepted ones. "Did the
 * publish take?" is therefore answerable only from here — reading the ticket
 * table cannot distinguish "not deployed" from "every caller declined".
 */
/**
 * v15, 2026-09-13: PCP RECORDS REACH MEDICAL RECORDS.
 *
 * The effect is invisible from outside except in which DEPARTMENT a ticket
 * lands in, and the before-state is stark: 54 PCP records tickets in
 * department 18 against 2 in department 16, both of those predating the
 * 2026-08-14 route that was supposed to fix it. So "did the publish take?" is
 * answerable only from here — a run of department-18 records tickets looks
 * identical whether the build is old or the classifier simply did not fire.
 *
 * Stacked on v14 (the queue choice), which is stacked on v12. v13 stays
 * skipped: #293 holds it on its own branch.
 */
/**
 * v17, 2026-09-14: PCP SCHEDULING STOPS DIALLING AND REACHES THE HUB.
 *
 * Two changes that only a marker can separate from a quiet day.
 *
 * The DISPOSITION change is invisible except as an absence: the three
 * scheduling slugs and `grievance_follow_up` no longer default to HAND_OFF, so
 * the director stops granting a transfer to a caller who never asked for one.
 * A build without it dials; a build with it files. 56 of the 75 measured
 * scheduling tickets attempted a transfer, so a fall in PCP transfer attempts
 * is the SIGNAL here, not a fault — and it is indistinguishable from a quiet
 * week without this string.
 *
 * The ROUTING change shows up only in which department a ticket lands in, and
 * the before-state is absolute: **0 of 75 PCP scheduling tickets had ever
 * reached department 9.** A run of department-18 scheduling tickets looks
 * identical whether the publish failed or no scheduling calls came in.
 *
 * THIS BUILD IS THE VERIFIED MERGE OF ALL SIX 2026-09-15 PCP FIXES at
 * sibling-HEAD quality, including the four Codex follow-ups Wayne named:
 * v19 the lost-request floor (#300, withheld-ANI ask), v20 blind-transfer
 * truth (#302), v21 ask detection (#301, negation / required-for / connected),
 * v22 the question format (#303, DOB ends in ?), v23 the recording
 * disclosure (#304, DB greeting cannot drop it) and v24 the answerable
 * queue choice (#306). They were SIBLINGS off v18, not a chain. Distinct
 * numbers were assigned up front so two open branches can never make two
 * different builds read alike at /voice/health; this branch takes the
 * highest, v24, because it is the one place the number and the
 * containment agree.
 *
 * Stacked under v18: v16 → v15 → v14 → v12. v13 stays skipped: #293 holds it
 * on its own branch and must re-bump above THIS.
 */
/**
 * v26, 2026-09-15: CHART DATE-OF-BIRTH INHERIT.
 *
 * Stop-erase: empty must not overwrite a full DOB already in
 * `verifiedIdentity` for the same person. Inherit-on-file: when the
 * ticket first+last matches the stored name, filing tools put the chart
 * birth year/month/day on the create payload even if the model omitted
 * `date_of_birth`. Name guard uses `nameKey` (hyphen / accent /
 * apostrophe) — not nicknames. The v25 `carry` enum rides along.
 * Diagnosis is PR #307. Stacks on v25; not a v19–v24 sibling.
 */
/**
 * v27, 2026-09-15: THE RECOGNISED-CALLER BLOCK IS THE RUNTIME'S, NOT FOUR
 * AGENTS'.
 *
 * One copy in `src/runtime/recognisedCallerBlock.ts`, imported by optical,
 * surgery, tech and records — operator, same day: "the things that are
 * applicable to any conversation should be in the runtime; things applicable
 * to that agent itself should be in the prompt." Two of the four copies had
 * drifted into telling the model to ASK a question the greeting had already
 * asked, and it was asked twice on 7 of 76 optical and 3 of 85 surgery calls
 * against 0 of 142 on tech, which carried the correct wording.
 *
 * It also carries the operator-approved rule change: an affirmed greeting
 * ends the identity step, so a recognised caller is not asked for a surname
 * the name guard would then reject. `recognisedCallerBlock.test.ts` is the
 * drift guard. Stacks on v26.
 */
/**
 * v28, 2026-09-15: THE ASK SCRIPT AGREES WITH THE BLOCK ABOVE IT.
 *
 * v27 made the recognised-caller block say "do not ask for their last name and
 * do not ask for their date of birth" and left the identity ask script, eleven
 * lines below it in the same prompt, saying to ask for exactly those — "say the
 * order EVERY TIME". Two contradicting instructions on one page, for exactly
 * the population v27 was written for. Codex P1 on #307, caught after merge.
 *
 * `identityAskScript` now takes the same pre-context as the block. A
 * recognised caller keeps the QUESTIONS (the block self-destructs on a denial,
 * and records may be collecting for somebody who is not the caller) and loses
 * the instruction to use them. The unrecognised arm is byte-identical to what
 * all four lanes carried before.
 *
 * Same ship, one heading down: `### How a call runs` still said
 * `identity_is_certain` false means "more than one person" and told the
 * model to collect last name and date of birth. After #292 that flag is
 * also a unique patients_master phone hit. `identityCertainMeaning(pc)`
 * lives beside the script. Marker stays v28 — this is the leftover that
 * made v28 not pull-safe, not a new ship. Stacks on v27.
 *
 * v41: the after-hours line's `create_ticket` asks for a date of birth ONCE
 * and then files with the date marked unavailable/unmatched — the queue
 * lanes' 2026-09-04 escape reaching the one lane that built its own tool and
 * so never had it (the fifteen-ask call of 2026-09-16). no-ivr is on the old
 * core, so this marker dates the BUILD rather than a runtime lane, the same
 * way v18 did for that lane's prompt trim. Stacks on v40.
 *
 * v42: a filed ticket is never spoken as a failure. A duplicate create_ticket
 * waits for the in-flight attempt's ticket number (poll, not one 3s recheck),
 * a contention refusal that survives the wait says so instead of apologising,
 * and a client timeout is retried once against the app's idempotency key.
 * Stacks on v41.
 *
 * v43: a classify tool's instruction to the model moves out of the channel
 * the model speaks (`message` -> `fix`), so the surgery agent stops reading
 * "these are the words we treat as a surgical emergency" to callers. v42 and
 * v43 ship in one PR; only v43 reaches a deployment. Stacks on v42.
 *
 * v44: the Observatory sees a runtime call the way xAI's console shows one.
 * Measured 2026-09-17: recording_url NULL and call_turns empty on all 4,564
 * runtime calls since the cutover. The bridge now keeps the moment each
 * transcript line was written and hands timed turns to call_turns after the
 * sweep; a Twilio REST recording (dual channel) is started when the stream's
 * start frame arrives and posts back to the old core's recording-status
 * handler, which now accepts a CallSid-keyed callback; and the call page
 * places each tool call at its START between the lines it ran between.
 * Telemetry only — nothing on a caller's path. Stacks on v43.
 *
 * v45: the Grok day table. The reconciler writes one daily_grok_costs row
 * per day on EVERY outcome — xAI's reported voice total, the lines it summed
 * and ignored, what the call rows were booked at, and a refusal's reason —
 * where before a refusal lived in a console line and nowhere else. Served at
 * /api/analytics/grok-usage, shown on the cost dashboard, and the call page
 * says whether a cost is reconciled or estimated. v44 and v45 ship in one
 * PR; only v45 reaches a deployment. Stacks on v44.
 *
 * v46: a success loop is a loop. The tool ceiling counted only FAILURES,
 * and the census of every substantive runtime call since 09-10 found 17
 * calls where one tool returned the SAME successful answer 11–35 times
 * (lookup_patient, check_open_tickets, resolve_location), 16 of them with
 * no ticket, while no call that filed ever passed 9. The eleventh identical
 * call now gets the tenth's answer back with `fix` instead of a dispatch;
 * twenty successes of one tool with any arguments refuse with the
 * instruction alone; and the argument key ignores case and spacing.
 * Stacks on v45.
 *
 * v47: a phone match is a candidate — the after-hours line stops reading a
 * phone-matched patient's appointment to whoever is calling. Measured over
 * nine days: 44 of 365 substantive no-ivr calls had the date, time, office
 * and doctor read out BEFORE any identity question. The appointment is now
 * withheld from the prompt on a phone match (first name only, and the way
 * back: name, date of birth, then lookup_schedule), and the tool's phone-only
 * path returns a candidate with no details. no-ivr is on the old core, so
 * this marker dates the BUILD, the way v18 and v41 did. Stacks on v46.
 *
 * v48: the ambiguous lookup is countable. `tool_timeline` kept `matched_by`
 * and `identity_is_certain` and dropped `found` and `candidate_count`, so
 * the three shapes of a false flag (found nobody / one unconfirmed person /
 * several) were byte-identical in SQL and the W1 date-of-birth fix of
 * 2026-09-16 was reverted for want of a number. Two PHI-free keys join the
 * outcome allow-list. An instrument, not a fix. Stacks on v47.
 *
 * v49: the fleet is graded at teardown. The old core has always called the
 * grader when a call ends; nothing under src/runtime/ imported it, so every
 * runtime call waited on the five-minute backfill — five rows per cycle,
 * newest first, 60 an hour against 90–98 substantive calls an hour at peak.
 * On 2026-09-16 hangup-to-grade averaged 3.5 minutes at 15:00 UTC and
 * 161–203 minutes from 16:00 to 18:00, and the hourly fleet watch, which
 * reads agent_outcome, alarmed on a third of the fleet reading NULL. Three
 * changes: the runtime grades at teardown after the row and the sweep, never
 * awaited (runtimeGrading.ts); the backfill cannot be starved by its own head
 * (an empty-transcript row is stamped and leaves, a row in backoff costs no
 * slot, the budget is spent on attempts over a wider window); and a dead_air
 * ending after a real conversation is `completed`, not `failed`, so the 58
 * such calls of 09-14 are graded and synced like any other. Stacks on v48.
 *
 * v50: the second miss ends the identity ask. On 2026-09-16 the runtime
 * lanes asked for a date of birth 2+ times on 35 substantive calls, 3+ on
 * 13, and on tech 15 of 16 were COLD callers the recognised-caller fixes
 * never reach. The loop runs through lookup_patient — called 2.5–6.5 times
 * per such call, its own miss message sending the model back to ask, with
 * no count. A miss now counts only when the lookup carried a name or a date
 * of birth; the first coaches the one re-ask in the funnel's shape, the
 * second (LOOKUP_MISS_LIMIT) says stop and file. `lookup_misses` reaches the
 * timeline so the after-number is SQL. Stacks on v49.
 *
 * v51: the record reaches the call row. Over the seven days to 2026-09-17
 * patient_found / patient_name / patient_dob were NULL on all 2,471 runtime
 * calls: persistRuntimeCall took an identity argument nobody supplied, and
 * the conflict update excluded identity anyway. A CERTAIN identity the tools
 * established (verifiedIdentityFor — the sweep's own reader, which refuses a
 * phone candidate) now rides with the record at teardown, on the insert and
 * the update path alike, never nulled. Stacks on v50.
 *
 * v52: the cost write parses. From 8a226a6 (2026-09-04) the per-call cost
 * UPDATE rendered `$n + $m` for its unreconciled total and Postgres refused it
 * at PARSE ("operator is not unique: unknown + unknown") — 3,749 times in the
 * 24h to 2026-09-17 05:40, twilio_cost_cents written on 5–25% of completed
 * calls against 100% before. The bound values now carry the column's type.
 * Server-side, no spoken line; the marker dates the build the after-number
 * (completed calls per day with twilio_cost_cents set) is read against.
 *
 * v53: the record reaches the after-hours call row. no-ivr's identity writer
 * read `metadata.callLogId` once at factory time — a getter the transport
 * backfills after session.connect() — so it fired on 0 of 297 substantive
 * calls in seven days, and it would have written the PHONE match, a candidate.
 * create_ticket now writes a CERTAIN identity (name + date of birth matched)
 * at write time. Old core, so the marker dates the build the way v18/v41/v47 do.
 *
 * v54: the affirmed name picks the person. All 26 recognised-caller date-of-
 * birth refusals on 2026-09-16 read carry=no_entry: the phone rung had found
 * several people on the number and remembered nobody, and the greeting's
 * affirmed first name never reached lookup_patient. It now narrows the
 * candidates by that name, re-resolves the one hit and carries it as certain.
 *
 * v55: the follow-up does not wait for a done that already passed. 9–42
 * runtime calls a day since 2026-09-10 ended in dead air with a filing
 * refusal as the last tool event and the pre-tool filler as the last
 * audible line: the bridge assumed a function-call event always arrives
 * inside an open response and waited for that response's done before
 * requesting the follow-up. It now asks the wire whether the response is
 * still open, and writes a per-call follow-up summary to call_events.
 *
 * v56: an unvoiced tool answer cannot end the call. 38 of the 61 PCP calls
 * the agent ended by tool on 2026-09-16 ended with the agent's own question
 * as its last words — on nine the appointment lookup the clinic rang for
 * succeeded and its answer was never spoken. The bridge now holds an
 * end-call tool while the model has a tool result it has not put into
 * words (bounded at HANGUP_HOLD_LIMIT), and record_automated_resolution
 * tells the model to say what the lookup found.
 */
export const VOICE_RUNTIME_DEPLOY_MARKER =
  "voice-runtime-v58-why-the-record-did-not-reach-the-row-20260918";

/**
 * The date the marker was set, parsed out of the marker itself so anyone can
 * compare a deployment against a date without our commit history. Returns
 * null if a future bump drops the suffix — `readiness.test.ts` fails on that,
 * so it cannot happen silently.
 *
 * IT ROUND-TRIPS THE COMPONENTS INSTEAD OF TRUSTING `Date.parse`, because
 * `Date.parse` NORMALISES an overflow rather than rejecting it: `2026-02-30`
 * parses happily as March 2. The first version of this validated with
 * `Date.parse` and the test that claimed to prove "a real calendar date, not
 * eight digits that merely look like one" would have passed a mistyped
 * `-20260230` (Codex, PR #272 round 3). A marker that reports a date the
 * calendar does not have is worse than one with no date, because it will be
 * believed. Constructing the UTC date and checking all three fields come
 * back unchanged is the only form that actually rejects.
 */
export function markerSetOn(marker: string = VOICE_RUNTIME_DEPLOY_MARKER): string | null {
  const m = /-(\d{4})(\d{2})(\d{2})$/.exec(marker);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  // Month 0, day 0, month 13, 31 September, 29 February in a common year:
  // every one of them survives Date.UTC by rolling into another month, and
  // every one of them fails here.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export interface RuntimeReadiness {
  liveReady: boolean;
  /** Env var NAMES (never values) that are missing. */
  missing: string[];
  /** Which DB env var this environment requires (mirrors config/environment.ts). */
  requiredDbEnvVar: "PRODUCTION_DATABASE_URL (or DATABASE_URL)" | "DATABASE_URL";
}

export function computeRuntimeReadiness(
  env: Record<string, string | undefined> = process.env,
): RuntimeReadiness {
  // The SAME non-throwing production detection the call record uses —
  // APP_ENV, NODE_ENV, REPLIT_DEPLOYMENT, published .replit.app domain.
  // Testing only NODE_ENV/REPLIT_DEPLOYMENT here classified a published
  // deployment (which the shared resolver treats as production, selecting
  // PRODUCTION_DATABASE_URL) as development and reported DATABASE_URL
  // missing — so the webhook served the unavailable TwiML for every call
  // of a completely configured deployment (Codex, PR #227 round 21).
  const isProduction = callEnvironment(env) === "production";
  // Mirrors getEnvironmentConfig() exactly, including its fallback: in
  // production PRODUCTION_DATABASE_URL is preferred and DATABASE_URL is
  // accepted with a warning. Readiness must agree with the code that
  // actually opens the connection, or it reports on a different program.
  const requiredDbEnvVar = isProduction
    ? ("PRODUCTION_DATABASE_URL (or DATABASE_URL)" as const)
    : ("DATABASE_URL" as const);

  const missing: string[] = [];
  // The voice itself. Without it there is no session to connect.
  if (!env.XAI_API_KEY) missing.push("XAI_API_KEY");
  // Webhook authentication. Without it every request is unauthenticated,
  // so the webhook refuses to serve a stream at all — see voiceWebhook.ts.
  if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  // The agents' tools read and write the practice's data, and the call
  // record is written at teardown. A process that can talk but cannot file
  // anything would take a real call and lose it: a controlled unavailable
  // message is the better outcome, and the caller is routed elsewhere.
  const hasDb = isProduction
    ? Boolean(env.PRODUCTION_DATABASE_URL || env.DATABASE_URL)
    : Boolean(env.DATABASE_URL);
  if (!hasDb) missing.push(requiredDbEnvVar);

  return { liveReady: missing.length === 0, missing, requiredDbEnvVar };
}

/** The two startup lines the runbook greps for. A function so the boot
 * test can assert the exact text without spawning a process. */
export function formatReadinessLines(readiness: RuntimeReadiness): string[] {
  const readyLine = readiness.liveReady
    ? "live-ready"
    : `NOT live-ready (missing: ${readiness.missing.join(", ")})`;
  return [`[voice-runtime] ${VOICE_RUNTIME_DEPLOY_MARKER}`, `[voice-runtime] ${readyLine}`];
}
