# 10 — Risks, Assumptions, and Open Questions

## 1. Assumptions (each tagged with impact if wrong)

| # | Assumption | Basis | Impact if wrong |
|---|---|---|---|
| A1 | July's 6,697 n8n executions ≈ steady-state monthly production usage | full-month measured count | Budget model conservative either way; enforcer uses live ledger + baseline env var, adjustable without code |
| A2 | 6,665 submit-ticket executions include outbox retries / non-call traffic (not 6,665 distinct calls) | volume vs plausible call counts; `r1_no_key` flags | None for budget (measured total used); per-call attribution in reports would need production callSid join |
| A3 | `callData.agentUsed` is present on ticket payloads (used for n8n-tap agent attribution) | n8n validator R10 checks it; client sends it | Missing values → events attributed 'unknown' → sampled out (counted, not lost silently) |
| A4 | OpenAI callId is the right primary session key; twilioCallSid arrives in `observeCall` metadata for aliasing | routes + coordinator evidence | Alias miss → n8n copies land in an orphan session; comparison degrades gracefully (missing-event tolerance) |
| A5 | Repo models (`gpt-4o-mini`/`gpt-4o`) remain the configured chat models | doc 01 §6 verified | Tier mapping is env-overridable |
| A6 | ~6 meaningful turns/call average | fixtures + call-audit narratives | Affects cost estimates only, not correctness |

## 2. Shadow-specific risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Sampling inconsistency across processes: transcript events hash the OpenAI callId, gateway copies hash the twilioCallSid — below 100% capture a session may be half-captured | Documented (doc 03 §4); run 100% capture per allowlisted agent (recommended), or accept missing-event tolerance |
| R2 | Two-process taps write separate spools; aggregation merges by sessionId | Merge is in the replay layer; health metrics are per-process |
| R3 | Deterministic reasoning is intentionally simpler than `gpt-realtime` — intent disagreements will partly reflect lexicon gaps | Verdict rules only claim confidence on hygiene dimensions; intent match is nullable; optional LLM refinement exists |
| R4 | Spool contains redacted-but-real operational metadata on production hosts | Deny-by-default redaction, transcripts off by default, 14-day purge, gitignored |
| R5 | `initShadow` subscribes to `callLifecycleCoordinator` only in the voice process; API-process sessions rely on timeout finalization | Acceptable: ticket copies carry their own completion via timeout sweep |
| R6 | In-memory budget ledger resets on process restart (day/month counters) | Counters are conservative caps, not billing; n8n's own execution list is ground truth (runbook 16 §1); restart mid-month under-counts shadow usage — monthly cap 300 leaves 1000+ margin below headroom |

## 3. Production defects observed (NOT fixed here — observation-only mandate)

Carried from doc 02 §3: DF-1 unkeyed ticket retry duplicate window (HIGH),
DF-2 taxonomy silently rewritten downstream (HIGH), DF-3 log-only n8n gate
positioned like enforcement, DF-4 sage guards fail open on store errors,
DF-5 DB prompt drift, DF-6 `no-ivr-v2` unroutable registration, DF-7 SIP-header
allowlist bypass, DF-12 ticket warm-up hard-depends on n8n health fast-2xx.
None met the stop-condition bar (all known/instrumented in-repo); all belong on
the production backlog. The shadow's comparison reports will quantify DF-1/DF-2
occurrence rates once observing.

## 4. Open questions for the operator

| # | Question | Why it matters |
|---|---|---|
| Q1 | Is `ticketing-n8n.onrender.com` (Render blueprint in ticketing-app docs) retired in favor of `azulvision.app.n8n.cloud` (live MCP instance)? | Doc accuracy; both are blocklisted for shadow either way |
| Q2 | May real (PHI-bearing) transcripts be processed by the shadow with `SHADOW_STORE_TRANSCRIPTS=true`? Current default keeps free text out of the spool entirely | Enables richer human review; needs the same BAA/eligibility diligence the console docs require (SCHEMA.md:467 precedent) |
| Q3 | Is reducing production submit-ticket n8n traffic (direct-app `TICKETING_ENRICHMENT_URL` bypass, already built) planned? | Restores planned-ceiling headroom: production alone sits at 84% of 8,000 |
| Q4 | Should the optional Postgres shadow tables be added (vs JSONL spool)? | Multi-process aggregation + dashboarding convenience; needs `db:push` approval |
| Q5 | Privacy flag: `replit-integration/INTEGRATION.md:129-131` (scheduling repo) contains a real patient name as a test fixture | Pre-existing; recommend redaction in that repo (out of scope here) |

## 5. Privacy review notes (Checkpoint 21)

- Follows the strictest applicable house rules: allowlist redaction
  (toolTimeline precedent), no candidate identifiers in comparisons
  (zero-identifier rule), transcripts not stored by default, spool retention 14
  days (console snapshot precedent), no external transmission of any shadow
  data by default (model calls disabled; n8n bundle disabled; bundle content is
  summary-only and vocabulary-screened when enabled).
- No new external vendor: optional model calls use the already-authorized
  OpenAI account and send structured state, not full transcripts, unless Q2 is
  approved.
- Unresolved-with-confidence items: none blocking; Q2/Q5 documented above.
