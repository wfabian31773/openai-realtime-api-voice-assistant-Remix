# 08 — Testing and Validation Plan (Checkpoints 18 & 19)

Suite: `src/shadow/*.test.ts` — **98 tests**, plus the full repo suite
(270 tests total). Run: `npx vitest run src/shadow` (or `npm test`).
Typecheck: `npx tsc --noEmit`. Deterministic mocks throughout; no snapshot
tests; exact state-transition assertions; contract tests on all schemas.

## 1. Required-scenario coverage map

| Required scenario | Test |
|---|---|
| Clear single-intent request | reasoning.test "classifies a clear single-intent" |
| Ambiguous request | reasoning.test "flags ambiguity" |
| Missing required field | workflowEngine.test "blocks a mutating tool while required fields are missing" |
| Caller changes an answer / corrections | fx-multi-intent replay ("Actually wait, I meant reschedule") |
| Caller interrupts mid-question | covered structurally: pendingQuestion + no-repeat rules (engine test "never re-asks") |
| Caller temporarily changes topics | fx-side-question replay |
| Production tool succeeds / no results / retryable / non-retryable | fx-ticket-happy, fx-tool-failure (503 + repeat), pipeline "missing tool-result events" |
| Repeated tool failure | fx-tool-failure → `repeated_tool_failure` |
| Duplicate mutation recommendation prevention | engine + simulator "duplicate_completed_mutation" |
| Loop detection | comparison.test loop suite + fx-loop-name |
| Escalation / urgent language | reasoning.test urgent/emergency + fx-urgent |
| Workflow completion / action after completion | engine tests "premature completion", "completed workflow never continues" |
| Multiple intents in one utterance | reasoning.test multi-intent |
| Model-tier fallback / invalid model JSON / model timeout | reasoning.test llm-failure fallback; pipeline "invalid model JSON" |
| State persistence across turns | fx-ticket-happy (fields carried to tool args) |
| Out-of-order events | pipeline "out-of-order events do not create multiple sessions" |
| Duplicate events | pipeline "duplicate events are idempotent" |
| Missing tool-result events | pipeline test |
| Shadow processor crash | pipeline "crashing reasoning dependency isolates" |
| Shadow backlog / backpressure | tap.test "drops oldest on overflow" |
| **Production unaffected by shadow failure** | productionIsolation.test (default-env no-op; sabotage fuzz; initShadow no-op) + tap.test sabotage |
| **Shadow cannot access a mutating execution path** | productionIsolation.test module-graph guard + no-direct-fetch guard + literal-type proof |
| Sensitive-data redaction | productionIsolation.test redaction suite |
| Session correlation across events | pipeline alias test (twilio SID → primary session) |
| Multiple agents sharing components | workflowEngine.test "definition for every active agent" + per-agent fixtures |
| Side-question recovery / cancellation / restart | fx-side-question, fx-cancellation-flow, reasoning.test restart |
| Bundled-question detection | loop detector + fx-loop-name |
| Repeated-question detection | loop detector + fx-loop-name |
| Tool argument validation | comparison.test simulator suite |
| Production-result replay | simulator replay-metadata test + n8nSimulator replayAvailable test |
| Comparison-report generation | fx replays assert summaries + limitation text |
| n8n request/result replay | pipeline alias test + n8nSimulator tests |
| n8n duplicate prevention | budget duplicate-idempotency test; sender "one execution per completed session" |
| n8n budget exhaustion (daily & monthly stop; production continues) | n8nBudget tests + sender fail-closed test |
| n8n retry limits / retries counted | budget retry test; sender bounded-retry test |
| n8n failure isolation | sender transport-failure test (bounded, dropped, no propagation) |
| Calls cannot exceed per-call n8n limit | budget per-call cap test |
| Batch grouping / session-level batching = one execution | sender batching tests |
| Incomplete sessions replayable | pipeline sweep test (`failed:timeout`, spool retains) |
| Child workflows cannot bypass budget | structural: no sub-workflows exist (doc 13 §CP2 check); bundle workflow has none by design; enforcement is app-side before any send |
| Error workflows cannot create retry loops | structural: no error workflows; retries only app-side, capped, tested |
| Test workflows reject production credentials/vocabulary | bundle receiver Code-node guard (doc 15 §3) + sender production-host blocklist test |
| Shadow workflows cannot write production data | blocklist test + module graph + bundle receiver writes only its own data table |
| Execution metrics reconcile | budget snapshot test (today/month/retries/duplicates) |
| Projected monthly usage below planned threshold | budget threshold-ladder + snapshot tests; doc 14 model |
| Disabling/breaking entire shadow ⇒ production output unchanged | productionIsolation.test |
| Shadow mode cannot execute production mutations | productionIsolation.test + n8nSimulator host-guard test |

## 2. Live-path non-blocking argument (beyond unit tests)

The four production tap sites call `shadowTap.emit`, which (a) returns after one
boolean check when disabled, (b) contains an outer catch that converts ANY
internal failure into a counter increment, (c) does no I/O and no awaiting —
queue drain happens on `setImmediate`. Tests sabotage the queue and consumers
and fuzz malformed/circular payloads; emit never throws. Therefore production
calls cannot wait on, or fail because of, any shadow component — including
shadow n8n processing, which happens after `session_completed`.

## 3. Historical replay (Checkpoint 19)

- Harness: `src/shadow/replayHarness.ts` (`npx tsx src/shadow/replayHarness.ts <file>`)
  accepts authored fixtures (JSON) and spool records (JSONL).
- Evaluation set: `src/shadow/fixtures/replay-set.json` — 8 de-identified
  synthetic sessions (successful, looping, urgent, tool-error incl. n8n 503,
  multi-intent + correction, premature tool, side question, cancellation).
  All names/phones are synthetic (Jane Doe / 555-xxxx). **No PHI is committed.**
- Real-call replay: production `call_logs` transcripts + `tool_timeline` can be
  converted to the fixture format; do this only in an approved environment and
  never commit the outputs (spool dir is gitignored). Prefer calls after
  2026-08-01 (fleet-wide tool timeline, doc 02 §2.4).
- Determinism: replays are seed-free and time-frozen; the suite asserts
  identical flags across repeated runs.

## 4. Known environmental limitation

`src/services/p0Hardening.test.ts` (pre-existing) requires `DATABASE_URL` and
fails identically on `origin/main` in an env-less container — reproduced and
documented 2026-08-02; not caused by and not fixable from this work (it needs a
database). All other 16 test files pass: 270/270 executed tests green.
