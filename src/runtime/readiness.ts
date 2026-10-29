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
 * main then carries, exactly as CLAUDE.md already requires of it. IT DID, TWICE
 * — v13 to v59 to v70, merged 2026-09-24 — so v13 is RETIRED and no build ever
 * served it.
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
 *
 * v67: the callback number says where it came from. Traced from a referral
 * coordinator's emailed complaint that her requests file and nobody calls
 * back. `asked_callback` is FALSE on every one of her office's calls —
 * pcpAgent seeds callbackNumber from caller ID and the intake then skips a
 * field that already reads answered, so a staffer rang her ANI and closed
 * the ticket "line is unavailable". The state now records whether the
 * number is caller ID only, record_pcp_intake clears that the moment the
 * caller states one, and the ticket tells the staffer which it is holding.
 * No question is added: v37 measured 18 of 25 PCP calls ending ON a
 * pre-filing question with 10 leaving no ticket at all.
 */
/**
 * v62 — WHY NO DIAL WENT OUT IS ON THE TICKET, so an ordinary task on a
 * handoff-default purpose stops being an HTTP 500 the model retries. Measured
 * 2026-09-19 in `voice_agent_api_logs`: 7 calls, 41 refused POSTs, worst storm
 * 8 on one call, 2026-09-15..18 — and 4 of the 7 never attempted a handoff at
 * all. `handoffNotAttemptedReason` is read from the policy table and two
 * server-owned director latches, never from a model argument.
 *
 * v57 IS RETIRED (the withdrawn surgeon claim), v58 was claimed by #322 and v59
 * by #293 — both OPEN branches when this was written, so this is a SIBLING of
 * both and contains neither. v62 > v59 numerically and says nothing about
 * containment. SETTLED SINCE: #322 shipped as v58 and #293 shipped as v70, so
 * v59 is retired and was never served by any build.
 *
 * v68: THE SILENCE LADDER. Nothing in the runtime ever spoke to a caller it
 * could not hear. `handleResponseDone` clears the dead-air watchdog when the
 * greeting completes and nothing re-arms it until the caller speaks, so a
 * caller who never speaks is never detected: 278 zero-caller-line runtime
 * calls over 09-17..23 ended `caller_hangup` at 74s average, and four sat
 * open to the 602-second ceiling. The agent now says "I'm sorry, I cannot
 * hear you. Are you still there?" after 12s of silence and ends the call on
 * the third strike — the operator's own wording and his own bound.
 *
 * v64: the caller's audio is COUNTED. `handleTwilioFrame`'s media case was
 * `session.appendAudio(payload)` and nothing else, so nothing anywhere could
 * say whether a caller's audio ever reached us — which is why optical's
 * barely-heard rate survived three attempts. An instrument, not a fix: two
 * integers per inbound frame and one PHI-free `call_events` row per call, no
 * gate, no tool, no spoken line. See `callerAudioEnergy.ts`.
 *
 * v69 — THE PCP LOST-REQUEST FLOOR IS WIRED INTO THIS RUNTIME'S TEARDOWN.
 * `sweepPcpUnfiledCall` had three ships of work behind it (v18, v30, v31) and
 * had never once run: its only caller was the OLD CORE's SIP teardown, and PCP
 * moved to this runtime on 2026-09-04. The generic sweep declines the lane by
 * table, so PCP had no teardown filer at all on the pipeline serving it. Read
 * from production rather than inferred: across ALL of `voice_agent_api_logs`,
 * 0 POSTs have ever carried `caller_hung_up_before_completion` or
 * `call_not_classified`, the two literals only that function writes.
 *
 * WHY 69, AND WHY IT HAS MOVED THREE TIMES AND NOW STAYS PUT. This branch held
 * v61 below the v58 `main`, took v66 when `main` reached v62, KEPT v66 when
 * #327 moved `main` to v64 — a marker only reads as a failed pull when it is
 * BELOW `main`, and 66 > 64 — took v69 when #326 moved `main` to v67 and 66
 * fell below it, and KEEPS v69 now that #328 has merged and `main` reads v68,
 * because 69 > 68. It is the last of the four siblings off the v62 `main`, so
 * `main` now CONTAINS the other three: v64 (#327), v67 (#326) and v68 (#328).
 * v65 and v66 are RETIRED rather than reused, along with v57, v60 and v63, and
 * a build must never read any of the five. **AND v59 HAS SINCE JOINED THEM:**
 * it was #293's number, that branch merged this v69 `main` and re-bumped to
 * v70, so `main` now carries v70 and contains this ship. A higher number says
 * nothing about containment — this one contains v68 because `main` was merged
 * into it, not because 69 > 68.
 */
/**
 * v70, 2026-09-24: A CALLER WHO SAYS "NEW" IS NOT LOOKED UP — and the number
 * has moved twice, which is the part to read before calling the gaps a defect.
 *
 * WHY IT NEEDS A MARKER AT ALL: the change is invisible from outside except on
 * a call where somebody says they are new, and its whole effect is that one
 * tool stops running. A build without it looks identical until you read a
 * transcript.
 *
 * WHY 70. This branch (#293) has held three numbers. It took v13 on 2026-09-12
 * off a v10 `main`; v13 was withdrawn and is RETIRED when the PCP queue choice
 * needed v14 and a collision would have made two builds read alike. It merged
 * `main` at v56 and took v59, skipping v57 (the WITHDRAWN surgeon claim, which
 * a build must never report) and v58 (then an open branch, the identity probe,
 * which has since shipped). It then merged `main` at v69 — four siblings had
 * landed in between, v64, v67, v68 and v69 — and v59 had fallen BELOW what
 * `main` carries, which reads as a failed pull rather than as a new build, so
 * it takes v70. A marker re-bumps only when it falls below `main`; it does not
 * re-bump merely because a number ahead of it was used.
 *
 * SO v13 AND v59 ARE BOTH RETIRED and no build ever served either. This ship
 * CONTAINS v64, v67, v68 and v69 because `main` was merged into it, not because
 * 70 is the largest number — that distinction is the hazard the CLAUDE.md
 * marker table documents for v19-v24, and it is why every re-bump above is
 * justified by what the branch had merged rather than by arithmetic.
 *
 * WHY 71. The identity store is now imported ONE way everywhere: the ten
 * `await import('./verifiedIdentity')` sites in the tools and the runtime's
 * pre-context write are static imports, like the readers always were. It
 * stacks on v70 (`main` at `c247479`), so this build contains it and every
 * marker below it.
 *
 * AND WHAT v71 IS NOT, because the claim that motivated it does not survive
 * its own reproduction. I published that the two import styles were two module
 * instances and that this explained `precontextWrite = 'stored'` on 325 of 625
 * `identity_summary` rows against `storeSize` 0 on all 625. A probe inside this
 * package, run the way `npm start` runs it, gets ONE instance both ways — so
 * the split was not the cause and that finding is still open. This ship removes
 * a drift hazard and changes no gate, no tool answer and nothing a caller
 * hears; the marker moves so a deploy can still be told apart, not because a
 * number should move with it. See identityStoreHasOneImportStyle.test.ts.
 *
 * v74, 2026-09-27: AN EMAIL PREFERENCE WITHOUT AN ADDRESS IS A QUESTION, NOT A
 * FAILURE. `CA42f5b35d3924b8a1e5e66c00ee927742` (no-ivr, 20:48 UTC, 217 s): the
 * caller asked to be reached by email, the model called `create_ticket` with
 * no `email` argument, the ticketing app refused HTTP 400 for `patientEmail`,
 * and the refusal reached the handler in the app's own spelling ("Missing
 * required fields") which nothing matched — so it fell to the generic branch
 * and the agent spoke the technical-issue apology, claiming to have the
 * caller's information, over a request that was never filed. The no-ivr
 * handler now asks for the address ONCE (keyed on the CallSid, the
 * date-of-birth escape's own budget) and on the next attempt files for a
 * phone callback with a note for the staffer; one parser
 * (`missingFieldsRefusal.ts`) reads both spellings for the sink and for the
 * handler, so a field refusal on any lane through `submitSimplifiedTicket`
 * comes back as a question naming the field. no-ivr is on the OLD CORE, so
 * this marker dates the build the way v18, v41, v47 and v53 do. It stacks on
 * v73 (`main` at `0039a9d`) and contains every marker below it.
 *
 * v75, 2026-09-28: THE TRANSCRIBER DETECTS THE LANGUAGE. Operator: *"xai
 * specifically states that large prompts are unnecessary, they also have
 * their recommendations for handling spanish calls, we need to ensure the
 * runtime follows those docs to the letter."* Read against docs.x.ai
 * (Speech to Speech, Prompting Guide) — the audit is
 * docs/observatory/XAI-DOCS-CONFORMANCE-20260928.md — the runtime departed in
 * one place on Spanish: it seeded `audio.input.transcription.language_hint:
 * "en"` on EVERY call, from a registry default copied off the old core, where
 * the docs say the model *"automatically detects the input language ... no
 * configuration required"* and the hint exists to *"bias ASR transcription
 * toward a specific language"*. A defaulted English now seeds nothing; an
 * env-set language or a non-English lane still seeds its regional hint;
 * `set_spoken_language` still retargets mid-call (es-MX, as the docs require
 * for Spanish). Beside it: the after-hours lane gains `set_spoken_language`
 * (it built its tools by hand and never had it, so on the runtime its hint
 * could never follow a Spanish caller), its language block is restated in
 * the guide's language-lock shape, and the tag a switch went TO reaches
 * `tool_timeline` so the 76 non-Spanish switches of the last fortnight stop
 * being uncountable. Revert lever for the seed: `XAI_VOICE_LANGUAGE=en`. It
 * stacks on v74 (`main` at `f998a0b`) and contains every marker below it. *
 * v76, 2026-09-28: THE AFTER-HOURS PROMPT IN THE SHAPE xAI PRESCRIBES. Ships
 * with v75 in one PR; only v76 reaches a deployment, a build reading v75 does
 * not exist (the v34/v35 shape). The docs' migration text — *"your prompt
 * should be much shorter … Remove workaround prompting"* — and the Prompting
 * Guide's five `##` sections describe the after-hours prompt's departure
 * exactly: it was the OpenAI-era body, never rewritten for Grok (28,478 own
 * chars, a six-phase playbook, six CRITICAL banners). The Grok-shaped body
 * (src/agents/noIvrPromptForGrok.ts) carries the same rulings in the docs'
 * shape at under half the size — 14,082 built chars against 28,801 — and
 * noIvrPromptShapeForGrok.test.ts holds BOTH bodies to one rulings map. THE
 * GROK PIPELINE GETS IT AND ONLY THE GROK PIPELINE: voiceRuntime marks its
 * calls `pipeline: 'runtime'`, the old core never does, so deploying this
 * changes nothing on the live after-hours line until the repoint; revert
 * lever `NO_IVR_PROMPT_SHAPE=legacy`. One deliberate rule change, named for
 * the operator: the pre-context block asks for the last name and then the
 * date of birth, one field per question (RULE ZERO 2b), instead of both in
 * one breath. It stacks on v75 and contains every marker below it.
 *
 * v77, 2026-09-28: THE LANGUAGE MECHANISM IS THE RUNTIME'S, AND SO IS THE SHAPE
 * GUARD. Operator, of v75/v76: *"Shouldn't this be for the runtime in
 * general?"* Yes — and the 2026-09-15 ruling already said where: *"the things
 * that are applicable to any conversation should be in the runtime; things
 * applicable to that agent itself should be in the prompt."* Following the
 * caller's language is applicable to any conversation, and it was written into
 * five prompts and listed by five tool lists (pcp had neither). Now
 * `laneRegistry` binds `set_spoken_language` to EVERY lane
 * (RUNTIME_OWNED_TOOLS) and `agentBinding` appends ONE copy of the mechanism
 * into the guide's own place for it — the end of `## Voice & Communication
 * Style` — rendering each lane's language POLICY from `spokenLanguages` on
 * its registration (the after-hours line: English and Spanish; every queue
 * lane: follow the caller). The knowledge pack moves from a preamble to
 * `## Business Facts` after Role & Persona, the docs' order, on any
 * five-section prompt (voice is billed by the minute, so the token-cache
 * prefix the old order bought was worth nothing). PCP's prompt is
 * re-sectioned into the five headings with its sentences unchanged. And
 * `promptShapeIsTheDocs.test.ts` holds every lane the runtime serves — the
 * BOUND prompt, through the real registry — to the five sections in order,
 * Business Facts once, no H1, CRITICAL at most once, only tools that exist,
 * the language tool bound and the mechanism present exactly once. It stacks
 * on v76 and contains every marker below it.
 */
/**
 * v78 — THE LANGUAGE TOOL IS REGISTERED ONCE. The outage fix. v77 bound the
 * runtime-owned `set_spoken_language` through `await import("../tools/languageTools")`
 * inside `resolveLane`; on Node 20 (Replit) that evaluated the module a second
 * time in a process that had already loaded it through `src/tools/server.ts`,
 * `registerTool` threw `[TOOLS] duplicate tool name: set_spoken_language`, and
 * every runtime lane failed at call setup from the 14:17 UTC republish of
 * 2026-09-28 until the rollback. The import is static now (one loader, one
 * cache, one evaluation), `pcpAgent`'s same-shaped import of
 * `medicalRecordsTools` is static too, and `toolModulesAreImportedOneWay.test.ts`
 * refuses the shape from now on. A build reading v77 is the outage build; v78
 * stacks on it and contains every marker below it.
 */
/**
 * v79 — THE RECORDS TOOL ASKS THE CHANNEL. The lane's first business day on
 * this runtime (2026-09-28): the prompt told the model to offer the signing
 * link and on real patient calls it did not — every create-ticket POST
 * answered `form: {requested:false}`, every patient case opened ON the
 * fifteen-day clock with no link, no funnel line in any transcript. Now
 * `file_records_ticket`'s FIRST refusal on a patient request with no
 * `form_channel` is the channel question itself (once, keyed on the call;
 * a second omission texts the callback number). Third parties and redirected
 * requests are never asked. Beside it on the ticketing app: a lock on the
 * idempotency key, because the same day's batched filings raced past the
 * key check and opened duplicate CAP cases, and a backfill that sends the
 * form to every patient the funnel missed.
 */
/**
 * v81 — THE SURGEON EXIT OPENS ON THE SECOND REFUSAL. Operator, 2026-09-30:
 * "lower the surgeon exit to the second refusal." From 2026-09-02 the
 * surgery filing tool sent `routingAskExhausted` only once TWO surgeon
 * refusals were noted on the call, so the exit needed a third attempt.
 * Measured 2026-09-29: seven surgery calls died holding exactly two refusals
 * and never made the third; four of them were spaced pairs a threshold of one
 * files on their last attempt, three were concurrent pairs no threshold
 * reaches. Three tickets that were routed on a later attempt now file
 * unassigned with the caller's spoken surgeon in the description. One line
 * changed, `surgeryTools.ts`; `surgeryUnassignedExit.test.ts` pins the new
 * threshold and records the concurrent pair as the residue it is.
 */
/**
 * v82 — CALLER MEMORY IS A CANDIDATE. The after-hours prompt's CALLER HISTORY
 * section wrote the previous call's full name and date of birth into the
 * prompt as `KNOWN PATIENT: <name> (DOB: …)` with "don't re-ask" underneath —
 * keyed on the calling number, so a candidate exactly like the schedule match
 * v47 redacts. On `CA32108e28bc5b21ca1514a126303d0671` (2026-09-30 13:31 UTC)
 * that handed the model the surname and the date it used to look the caller
 * up by itself and read an appointment before the caller had said either;
 * the full name was asked afterwards. The section now carries only what is
 * true of the NUMBER — call count, outcomes, open tickets, a contact
 * preference — and says not to skip the identity questions. One renderer,
 * `callerMemoryService.buildContextForPrompt`, so both pipelines get it;
 * `noIvrMemoryIsACandidate.test.ts` drives the real agent on each.
 */
/**
 * v88 — THE ON-CALL TEXT BEFORE THE RING. The old core texts
 * URGENT_NOTIFICATION_NUMBER who is calling and why before a clinical transfer
 * rings the on-call phone, and files an urgent After Hours ticket when nobody
 * takes it. The runtime did neither, and the after-hours line moved here at
 * ~00:23 UTC on 2026-10-01: `CA3a8fd9cc0f2f79eae30f5785ceba6d22` (2026-10-02
 * 00:15 UTC) rang the on-call phone 40 seconds with no text and left no
 * ticket. Both now run in `runtimeTransfer.ts` from one shared copy of the
 * words (`services/urgentTransferAlert.ts`); `urgentTransferAlerts.test.ts`
 * pins the order (text, then dial) and the ticket on a dial that rang out.
 */
/**
 * v89 — THE AFTER-HOURS LINE ROUTES WHAT THE OPERATOR RULED (2026-10-02). A
 * post-op prescription problem with no new symptom files URGENT to After Hours
 * and the escalation gate refuses to ring for it ("1, no, it should record an
 * urgent ticket in after hours"); a same-day request files to After Hours
 * ("same day tickets are worked in the after hours department"); and the
 * urgent ring-out ticket now reaches After Hours (department 8) — it was going
 * to Technicians Support (3) with a retinal-surgery request type, 14 of 17 such
 * tickets since May. `services/afterHoursRouting.ts` decides;
 * `noIvrAfterHoursRouting.test.ts` drives the real agent.
 */
/**
 * v90 — THE PCP FLOOR READS THE FACTORY'S OWN MODULE (2026-10-03). v69 wired
 * `sweepPcpUnfiledCall` into this runtime's teardown and it has never filed:
 * 0 POSTs ever carried its literals, and on 2026-10-02 the deployment log shows
 * 13 "has intake but no metadata — cannot build a payload" lines, 12 on
 * substantive PCP calls with a purpose on record and no ticket of any
 * provenance. `pcpFloor.ts` loaded the sweep with its own
 * `import("../agents/pcpAgent")`; on Node 20 (Replit) that evaluated pcpAgent
 * a second time, with an empty `pcpCallMetadata` map, while the factory that
 * built the call came from `src/config/agents.ts`'s static import. The v77
 * outage's mechanism in a second module, silent this time. The sweep now
 * travels with the factory: `teardownSweep` on the pcp registration, from the
 * same import statement as `createPcpAgent`, read off the same lane source the
 * runtime resolved the call from. Reproduced on Node 20 and proven fixed there;
 * `toolModulesAreImportedOneWay.test.ts` now also refuses any runtime
 * `import()` of an agent module.
 */
/**
 * v91 — THE SESSION STALL RECONNECTS (2026-10-06). xAI accepts the WebSocket
 * (HTTP 101) and sometimes never sends `session.created`. The runtime used to
 * wait the 15 s setup deadline, then tear the call down: the caller heard
 * nothing and no ticket filed. ~1 in 18 connections (worst ~1 in 7,
 * 2026-10-05/06). `connectWithFirstEventRetry` now waits 2500 ms for the
 * FIRST event (env `RUNTIME_FIRST_EVENT_TIMEOUT_MS`, clamp 1000–10000),
 * detaches the stalled socket so its later close cannot end the call, and
 * opens a new one. Two retries after the first attempt (three attempts;
 * `RUNTIME_CONNECT_RETRIES`, clamp 0–4). A handshake that never upgrades is
 * bounded at 5000 ms (`RUNTIME_WS_HANDSHAKE_TIMEOUT_MS`, clamp 2000–15000).
 * Inbound frames buffer until `commitBuffered` after the session binds
 * `onMessage`, so a late-commit first event is not dropped. Upgrade headers
 * (`x-trace-id`, `CF-RAY`) and `[SESSION] created session=… conversation=…`
 * are logged PHI-free. When every retry stalls, `runSetupFailureFloor` files
 * one ticket in the lane's department (optical Other 66/536, Unnamed/Caller,
 * `call-<sid>-setup-failure`) and the TwiML speaks the technical-trouble
 * apology. Defaults work; no new secret is required.
 */
/**
 * v92 — THE TEARDOWN FILERS TAKE THE UNASSIGNED EXIT (2026-10-09). The request
 * sweep and the setup-failure floor file after the caller has gone, and on
 * optical (1) and surgery (2) create-ticket refused them for an office or a
 * surgeon nobody was left to give: 36 optical and 51 surgery swept requests
 * refused HTTP 400, 2026-09-28..10-08, against 5 accepted. Both now send
 * `routingAskExhausted` on those two departments only, from one shared set
 * (`TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS`); the app still derives the field
 * from the patient's record first, so no ticket loses a routing it would have
 * had. Beside it the setup floor stops filing for a caller who HUNG UP inside
 * the configured first-event wait — 3 of its first 4 tickets were 1–2 s
 * hangups. Keyed on the moment the caller's socket closed, not on the call's
 * length, so a setup we fail fast still files.
 * `teardownTakesTheUnassignedExit.test.ts` reads the payload that leaves.
 */
/**
 * v93 — THE URGENT TRANSFER RECORD FILES, IN AFTER HOURS (2026-10-09). On a
 * connected after-hours transfer the record ticket fell back to the name
 * "Unknown Caller", which /submit-ticket refuses (both words are on its
 * placeholder list): 22 connected transfers in 60 days left no ticket at all.
 * And it named no department, so 9 more were classified as Surgery and
 * refused for a surgeon, and of 54 that filed only 32 reached After Hours.
 * It now files under the fleet's one stand-in ("Unnamed Caller",
 * `standInName.ts`, with a note saying so) and names department 8, which wins
 * over the app's derivation. The refused-escalation filing takes the stand-in
 * too. `noIvrTransferRecordFiles.test.ts` drives the real agent.
 */
/**
 * v94 — THE QUEUE SEES THE CALLER'S NUMBER (2026-10-10). The PCP blind
 * transfer's `<Dial>` carried `callerId` = our Twilio number, so all 392 queue
 * transfers of the fourteen days to 2026-10-10 rang the call centre showing
 * the AI line instead of the office that called. `queueCallerIdFor` now passes
 * the caller's own inbound `From` (Twilio permits it on a dial from that
 * inbound leg), and our number when caller ID is withheld or not a plain
 * E.164 number, because a refused callerId would fail the dial. The warm path
 * is untouched. `RUNTIME_QUEUE_CALLER_ID=ours` reverts without a deploy.
 * `pcpBlindTransferWiring.test.ts` drives the real transfer.
 */
/**
 * v95 — THE RING-OUT RECORD FILES BESIDE THE REQUEST (2026-10-11). When an
 * after-hours caller's request was filed BEFORE their urgent transfer rang
 * out, the runtime's urgent fallback went through `createTicket`, whose
 * per-call claim handed back the request ticket and posted nothing — so the
 * call's only ticket was a medium one in the HVA Hub and no urgent record of
 * the failed transfer existed. 2 of the 8 failed after-hours transfers from
 * 2026-10-10 to 2026-10-11 17:20 UTC (VA-70426, VA-70441). The fallback now
 * reads whether the call already holds a ticket and, when it does, files the
 * urgent After Hours record beside it with `secondTicketOnThisCall` — the v93
 * mechanism, on the arm where nobody is on the phone with the patient.
 * `ringOutFilesBesideTheRequest.test.ts` runs the production defaults.
 */
/**
 * v96 — THE PCP LOOKUP NEEDS NAME AND DATE OF BIRTH (2026-10-15). When the
 * name and date of birth matched nobody, `lookupPatient` fell through to the
 * appointment book's name-only rung and `lookup_patient_appointments` read that
 * person's schedule to the outside office on the line. CA23f7d0724863d9566e5d638041246160:
 * a name shared by 126 people, no date of birth from the caller, five upcoming
 * appointments read out. 18 of 48 PCP calls whose lookup found someone over
 * 10-08..10-14 had no date-like word from the caller. Appointments are now
 * handed over only on a single-person name-and-date-of-birth match; anything
 * else is withheld (`suppressed: 'not_name_and_dob'`) and the model is sent
 * back for the date of birth. `src/pcp/lookupNeedsNameAndDob.test.ts`.
 */
/**
 * v97 — THE FILING LINE IS NOT A STAGE DIRECTION, AND HEALTH NAMES THE MODEL
 * (2026-10-16). All four queue prompts said "…one moment." and then "file
 * quietly"; grok-voice-3.0, run offline against the bound prompts and tools,
 * said "Quietly filing." aloud on 15 of 62 simulated calls (0 on 2.0). The
 * line now says to call the filing tool straight away and say nothing else
 * until it answers — 0 on 3.0 in the same harness, unchanged on 2.0.
 * `/voice/health` reports each lane's `voiceModel`, so a 3.0 canary set by
 * `XAI_VOICE_MODEL_<SLUG>` is confirmed the moment the republish takes.
 * `src/agents/theFilingLineIsNotAStageDirection.test.ts`,
 * `src/runtime/laneRoster.test.ts`.
 */
/**
 * v99 — THE CALLER SAYS THEY ARE A PROVIDER, OR THE AFTER-HOURS LINE DOES NOT
 * RING FOR ONE (2026-10-19). Operator: "no escalation unless the caller
 * themselves said they are a provider." The gate's provider case took the
 * agent's word for it, so a caller who said only "Operator." connected to the
 * on-call phone (CA4079341a0d7e7cbbc9daf36da56bb7c0) and patients asking for
 * their own doctor by name rang through as "clinician calls". The provider
 * case now needs the caller's own self-identification, and the runtime now
 * FEEDS the caller's words to the gate: only the old core did, so from
 * 2026-10-01 the symptom check that refuses invented symptoms was inert too.
 * `src/services/providerMustSayItThemselves.test.ts`,
 * `src/agents/noIvrProviderMustSayIt.test.ts`.
 */
/**
 * v100 — A PCP CALLER WHO LEAVES GETS NO TICKET (2026-10-19). Operator: "any
 * caller that hangs up will not get their ticket submitted, plain and simple"
 * — and a caller transferred to the queue leaves none that names no patient.
 * The teardown floor files nothing on a hang-up or a transfer (it still files
 * when the call ended on our side); on a hang-up, and when the queue answers
 * or the caller leaves it while it rings, the ticketing app is asked to
 * withdraw the call's PCP Support tickets that name no patient and nobody has
 * touched (`/api/voice-agent/pcp-ticket/withdraw`, ticketing-app). 2026-10-12..16:
 * 110 of 147 agent tickets on hung-up PCP calls named no patient.
 * `src/pcp/aCallerWhoLeavesGetsNoTicket.test.ts`, `src/pcp/queueIsAChoice.test.ts`.
 */
/**
 * v101 — EVERY LANE ON grok-voice-3.0, AND THE CONNECT ALERT SAYS WHAT FAILED
 * (2026-10-19). Operator: "switch the entire runtime to 3.0". The default
 * model moves off the deprecated 2.0 on the tech canary's numbers (3.0 filed
 * 86.8% of 257 substantive calls against 84.5% of 1,267 on 2.0; dead air 1
 * against 23); `XAI_VOICE_MODEL_<SLUG>` is still the no-deploy revert. And the
 * alert that read "STALL RATE 11/30 — reconnecting is not absorbing it" during
 * xAI's 18:34–18:49 UTC outage — ten HTTP 503s and a handshake timeout, no
 * stalls, seven of eight calls reconnected — now names each failure kind and
 * counts the calls that reconnected, dropped after every retry, or were still
 * connecting. It fires on the same attempt it always did.
 * `src/runtime/providerConnect.test.ts`, `src/runtime/laneRoster.test.ts`.
 */
/**
 * v102 — A PCP CALLER TOLD THEIR REQUEST IS RECORDED KEEPS IT WHEN THEY HANG
 * UP (2026-10-19). Operator: "yes, build the readback exemption for the
 * hang-up withdrawal." v100's withdrawal removed six PCP tickets on its first
 * afternoon, four from callers who had heard a ticket number or "I've taken
 * this down". The hang-up sweep now reads the agent's lines and does not ask
 * the app to withdraw when the call filed a number the agent read out — in any
 * rendering, since grok-voice-3.0 spells numbers — or when the refused
 * transfer's claim was spoken. `src/pcp/toldItWasRecorded.test.ts`.
 */
/**
 * v104 — A MOVED APPOINTMENT IS NOT AN APPOINTMENT (2026-10-20). The NextGen
 * Bible's §2 rule: kept > rescheduled > cancelled, then a past date never
 * kept is a no-show. NextGen hides the appointment it moves, and the Console
 * row mapping read it as live — so 12 of the 81 recognised callers with an
 * upcoming appointment on 2026-10-20 carried one they did not have, and for
 * 26 of 111 the "last visit" was a moved appointment. `statusOf` hides it; the
 * readers count a past row only when it was kept (or unknown).
 * `src/services/theMovedAppointmentIsNotUpcoming.test.ts`.
 */
/**
 * v106 — THE PERSON WE CALLED CAN CALL US BACK (2026-10-21). Operator: "There
 * is no redirect. If a patient calls back, like we expect them to, the voice
 * agent has to handle that call as well and know exactly who is on the line
 * and why they are calling." v105 refused every inbound call on an outbound
 * lane. The same lane now answers it: the calling number is matched to the
 * campaign's list (one person, several — never picked — or none), the
 * greeting confirms rather than assumes, `identify_callback_caller` settles
 * who it is, and nothing about why we called is said before that. And the
 * dialler rings nobody until the caller-ID number's Voice URL points back at
 * that lane on this deployment. `src/runtime/outbound/callback.ts`.
 */
/**
 * v107 — THE MOVABLE LIST, LIVE FROM THE CONSOLE (2026-10-21). Operator:
 * "create a direct connection to the eye care patient console where the
 * movable list is located so it is always fresh." A campaign can now be fed
 * from a live source instead of an import: the queue is refreshed from the
 * Console's movable list every fifteen minutes (only what changed is
 * written), and each person is re-checked against the Console at the moment
 * of the dial — still booked, still movable, today's phone — failing closed.
 * `src/runtime/outbound/consoleMovable.ts`.
 */
/**
 * v108 — A LAB THAT NAMES ITSELF IS A PROVIDER (2026-10-21). Operator: "add
 * lab and laboratory to the provider list." A reference lab calling stat
 * results named itself and was taken as a message because "lab" was not a
 * facility word (CA02cebe2231c3f8208c099c8736ea5c7a). "optical lab" does not
 * count (a supplier chasing a frame), nor do "lab results" / "lab work" (a
 * patient's own care). `src/services/symptomCorroboration.ts`.
 */
/**
 * v109 — THE FIELD DESCRIPTIONS REACH THE MODEL (2026-10-21). The SDK's
 * `tool()` drops every zod `.describe()` from a schema with an optional
 * field, so on no-ivr and pcp — the two live lanes that build tools by hand —
 * 1 of 31 and 1 of 2 field descriptions reached Grok. Among the lost:
 * `escalate_to_human.caller_type`'s "ONLY when the caller has said so in
 * their own words" (v99). They are now copied back onto the SDK's own schema;
 * no type, enum or required list moves, and validation is still the zod
 * parse. On top of v108 (#359), which it contains.
 * `src/services/toolFieldDescriptions.ts`.
 */
/**
 * v110 — THE NPX OUTREACH CALL (2026-10-22), DARK. Operator, 2026-10-20: call
 * patients whose routine exam is weeks away and offer a sooner one at an NPX
 * partner that takes their medical group; on a yes, book it in NPX and cancel
 * the Azul appointment. The first real campaign on the outbound layer: the
 * movable list as its source, the person confirmed by date of birth before
 * anything about an appointment is said, NPX's offer and booking (EPC #281),
 * the Azul cancel only if the appointment is still this person's on the date
 * offered, and the result reported to NPX. Dials nobody until its own switch,
 * caller ID and NPX key are set. On top of v109 (#360), which it contains.
 * `src/agents/npxOutreachAgent.ts`,
 * `src/tools/npxOutreachTools.ts`.
 *
 * v111 — THE CALL ROW NAMES ITS BUILD (2026-10-22), Stage C step 1. Every
 * call row carries runtime_marker, build_sha and voice_model, written by one
 * fill-only statement once the A6 migration's columns exist; the deployment
 * build writes build-info.json from git instead of serving a committed copy
 * frozen at 3f4ec74. `src/runtime/buildIdentity.ts`. On top of v110 (#361).
 */
/**
 * v112 — THE MEDICATION NAME IS ASKED ONCE (2026-10-22). The after-hours
 * line's refill gate refused `create_ticket` on every attempt for the life of
 * the call; it now refuses once, files on the next attempt, never asks about
 * a contact lens, and the refusal reaches `tool_timeline`. On top of v111
 * (#364), which it contains. `src/services/toolDirection.ts`.
 */
/**
 * v113 — THE NPX DEMO LINE (2026-10-22). Operator: "No way we are going to do
 * this without testing the line first", then "switching over to production
 * should be a env switch". ONE lane, `npx-outreach`, and NPX_OUTREACH_MODE:
 * unset (or anything but `live`) calls the synthetic patients on
 * NPX_OUTREACH_DEMO_PHONES and books in the demo NPX, with the Azul cancel and
 * the staff ticket simulated; `live` calls the Console's movable list and
 * books for real. Same caller ID, Voice URL, agent, prompt, tools and voice
 * (`eve`) in both. `/voice/health` names each lane's voice and the NPX lane's
 * mode. On top of v112, which it contains.
 * `src/agents/npxOutreachAgent.ts`, `src/agents/npxOutreachDemo.ts`,
 * `src/tools/npxOutreachTools.ts`.
 */
/**
 * v114 — THE SI ASSISTANT PLUGIN API (2026-10-22), DARK. The Support Center
 * bot prepares a call, text or email; a human approves it on Pending bot
 * actions; commit_contact then sends, using a 5-minute single-use token.
 * Calls enqueue into the existing outbound dialer from +1 909-255-3213.
 * Email is Graph app-only via SI_MAIL_TENANT_ID / SI_MAIL_CLIENT_ID /
 * SI_MAIL_CLIENT_SECRET from SI_ASSISTANT_EMAIL. PLUGIN_WRITES_ENABLED
 * defaults off. The migration is written, not applied. On top of v113
 * (#363), which it contains. `src/plugin/`, `src/agents/siAssistantAgent.ts`.
 */
/**
 * v116 — THE RECORD'S OFFICE NAME TRAVELS (2026-10-23). When an optical caller
 * names no office, `file_optical_ticket` sends the office on the patient's
 * record as `locationOfLastVisit` even when our `/lookup` did not resolve it
 * to a `locationId` (no-match or outage); ticketing-app #381 resolves names
 * itself under a unique-match rule. Withheld on a date-of-birth conflict,
 * never logged (the ticketing client's lookup line no longer prints the
 * location name either). A payload change on the ticket path of the queue that routes
 * BY office, so it gets its own marker. On top of v115 (#367), which it
 * contains. `src/tools/opticalTools.ts`, `opticalOfficeFromRecord.test.ts`.
 */
/**
 * v117 — CONTACT CAPTURE (#14, 2026-10-27). Surnames are spelled when needed;
 * new email addresses are read back and confirmed in full. Provider names use
 * an exact or uniquely fuzzy Console match on both ticket submission paths,
 * with the five-point margin checked against the entire roster. Contact field
 * descriptions survive the SDK conversion on answering-service and no-ivr-v2.
 * On top of v131 (main); renumbered from v123. No migration; production impact remains unmeasured.
 */
/**
 * v126 — NO-IVR PROMPT TRIM (2026-10-28). Remove repeated explanations from
 * the Grok prompt while keeping its rules; the length ratchet checks pinned
 * daytime and overnight clocks. On top of v117; v122–v125 are on open
 * branches. `src/agents/noIvrPromptForGrok.ts`.
 */
/**
 * v128 — PCP SCHEDULING AND UNASSIGNED EXIT (2026-10-28; renumbered from v122). Patient scheduling
 * reaches the HVA Hub, including a captured scheduling purpose alongside the
 * patient latch. A terminal Optical/Surgery office or surgeon refusal retries
 * once with routingAskExhausted instead of sending PCP back through re-asks.
 * On top of v126 (#394); v127 is #376 on its open branch. No migration; production impact remains unmeasured.
 */
/**
 * v129 — AFTER-HOURS TEARDOWN FLOOR (2026-10-28). The no-ivr and no-ivr-v2
 * agents reuse PCP's v90 registered sweep machinery on both voice pipelines.
 * A transcribed request with no ticket files through the usual After Hours
 * submission path; silent calls, identity-only calls and existing tickets
 * are skipped. The normal per-call lock and idempotency key prevent duplicates.
 * On top of v128 (#389); renumbered from v119; v127 is #376 on its open branch. No migration; production impact remains unmeasured.
 */
/**
 * v130 — A PCP CALLER TOLD THEIR REQUEST IS RECORDED KEEPS IT WHEN THE QUEUE
 * ANSWERS (2026-10-28). Both blind-transfer settlement paths apply v102's
 * read-back / "I've taken this down" exemption, captured before redirecting
 * while the transcript is available. A caller who heard neither still has
 * the ticket withdrawn; hang-up behavior is unchanged. On top of v129 (#386); renumbered from v120; v127 is #376 on its open branch.
 * No migration. `src/pcp/queueIsAChoice.test.ts`.
 */
/**
 * v131 — HEARD CALLERS BYPASS THE SILENCE LADDER (2026-10-28). Once any
 * non-empty caller transcript arrives, the ladder stands down before speaking
 * and cannot end the call. Ghost-call prompts forbid use after a request;
 * terminate_call refuses ghost_call after a caller transcript on SIP and runtime.
 * On top of v130 (#387); renumbered from v121; v127 is #376 on its open branch. No migration; production impact remains unmeasured.
 */
/**
 * v132 — CALLBACK EXTENSIONS (2026-10-28). Queue ticket tools validate and
 * normalize the base callback number and preserve a marked extension in
 * staff-only call notes. On top of v131 (main); renumbered from v123. Production impact is unmeasured.
 * `src/utils/phone.ts`, `src/tools/`.
 */
/**
 * v134 — GOODBYE GRACE HANGUP (2026-10-28). After a completed goodbye exchange
 * (conservative English/Spanish matcher), the bridge waits GOODBYE_GRACE_MS
 * (6s) after playback and then ends the call deliberately ("goodbye_grace").
 * Caller speech, a new response or a tool call cancels it. Silence ladder and
 * ghost-call wording unchanged; no prompt or tool text added.
 * On top of v132 (#390, main); v127 is #376 and v133 is #391 on their open branches. No migration.
 */
/**
 * v135 (renumbered from v125) — AFTER-HOURS DOB CONFIRMS THE PHONE CANDIDATE (2026-10-28).
 * lookup_schedule uses the recognised caller's canonical name when the caller
 * supplies a DOB matching pre-context, so a corrected spoken spelling does not
 * lose the record. A mismatching DOB keeps the spoken-name lookup; candidate
 * details stay withheld before confirmation. `noIvrPhoneMatchIsACandidate.test.ts`
 * drives the live factory's tool on both pipelines. On top of v134 (#396). Merged to main as #392 (6ae60e33).
 * No migration; production impact remains unmeasured.
 */
/**
 * v136 (renumbered from v126) — PCP UNCLASSIFIED IS FLOOR ONLY (2026-10-28). The PCP agent cannot
 * choose unclassified_call in its intake tool; the after-hangup floor still
 * files unclassified calls for a person to route. On top of v135 (#392, main, 6ae60e33); v127 is #376 and v133 is #391 on their open branches. No migration; production impact remains unmeasured.
 */
/**
 * v142 — A GIVEN NAME REACHES THE SWEEP (2026-10-29). The teardown sweep files
 * a request under the first and last name the caller gave, as a name-taking
 * tool received it, when no certain lookup match exists (statedName.ts,
 * operator ruling 2026-10-29). On top of v141 (#398, main, 2316c60). Merged to
 * main as #399 (adf8dad). No migration; production impact remains unmeasured.
 */
/**
 * v143 — SORRY, ONLY A MESSAGE (2026-10-29). On the four queue lanes a caller
 * who asks for a person hears an apology, that the agent can only take a
 * message, and who will follow up (operator ruling 2026-10-29). On top of
 * v142 (#399, main, adf8dad); v137 is #391, v138 is #376 and v139 is #384 on
 * their open branches. No migration; production impact remains unmeasured.
 */
/** v144: open Grok Bot operator conversations, owner recognition, background
 * request handoff, and outbound provenance, above main's v143.
 * Apply add_operator_line_inbound.sql separately. Merged to main as #402
 * (6cac333). */
/** v145: owner SMS exempt + notifier idempotency. Signed stable event IDs,
 * durable notification claims and token-scoped SMS idempotency keys.
 * Apply add_operator_notification_claims.sql separately; not applied here.
 * Merged to main as #405 (7ad4fb8). */
/** v146: dedicated operator SMS send, with no hours/caps, owner exemption,
 * opt-outs, durable idempotency and operator-origin commits. No new migration.
 * Merged to main as #407 (04e1e80). */
/**
 * v148 — THE TEST CALL'S OFFICE AND NAME (2026-10-29). Three defects from the
 * operator's pack-01 A1 test call: no queue prompt quotes a sample office any
 * more (the optical agent offered one when no record was found), an office
 * `resolve_location` verified on the call reaches `file_optical_ticket` when
 * the model leaves `location` out (verifiedOffice.ts), and the ask script asks
 * for the first and last name, RULE ZERO 2b's own wording. On top of v146
 * (#407, main, 04e1e80), which contains v145 (#405) and v144 (#402). No migration;
 * production impact remains unmeasured.
 */
/**
 * v149 — A LATER FILING ADDS TO THE TICKET (2026-10-29). Stacked on v148 in
 * one PR; only v149 reaches a deployment. A filing on a call that has already
 * filed used to be answered from the call's outbox row and sent nowhere; it is
 * now sent on with the call's own key so the ticketing app adds its details
 * to the ticket (ticketing-app #414), and the tool tells the model what
 * happened instead of "read the ticket number back" a second time. No
 * migration; production impact remains unmeasured.
 */
export const VOICE_RUNTIME_DEPLOY_MARKER =
  "voice-runtime-v149-a-later-filing-adds-to-the-ticket-20261029";

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
