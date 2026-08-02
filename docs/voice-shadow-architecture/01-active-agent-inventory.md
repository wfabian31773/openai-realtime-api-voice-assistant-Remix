# 01 — Active Voice-Agent Inventory (Checkpoint 1)

> Evidence: parallel read-only inspection of all four repositories, 2026-08-02.
> Facts are **[VERIFIED]** with file:line citations unless tagged **[ASSUMPTION]**.
> No functional code was modified before this inventory was completed.

## 1. System topology (verified)

```
                    ┌────────────────────────────────────────────────────────┐
 Caller (PSTN) ──► Twilio ──► openai-realtime-api-voice-assistant-Remix      │
                    │  server/index.ts (API :5000) ⇄ src/server.ts (voice :8000)
                    │  TwiML conference → OpenAI SIP participant →           │
                    │  realtime.call.incoming → observeCall() → agent factory │
                    └───────┬───────────────────────┬────────────────────────┘
                            │ tickets (HTTP)        │ sage_* tools (HTTP, Bearer)
                            ▼                       ▼
              n8n "VA Gateway" webhooks     eyecare-scheduling-agent (Vercel)
              (azulvision.app.n8n.cloud)    NextGen Enterprise API + Supabase si_*
                            │                       ▲ governance UI / control plane
                            ▼                       │
              ticketing-app (Replit, Next.js)   eyecare-patient-console
```

- **Voice agents are hosted only in `openai-realtime-api-voice-assistant-Remix`.**
- `eyecare-scheduling-agent` = tool/decision backend ("Sage asks, Eye Care decides",
  `lib/scheduling-intel/sage-tools.ts:7`). Hosts a **deprecated** browser WebRTC demo
  (`public/voice.html` + `api/realtime-session.ts`) frozen since 2026-07-16 that
  bypasses production safety headers — classified archived/prototype, do not touch.
- `ticketing-app` = ticket backend consumed via the n8n VA Gateway (doc 13). Hosts no agent.
- `eyecare-patient-console` = staff console + scheduling-intelligence governance UI
  (si_* rules tables). Hosts no agent; owns the PHI conventions in doc/§ security.

## 2. Registry and routing (Remix repo)

- Single registry: `src/config/agents.ts:26-196` — 9 registrations, all `enabled: true`.
- **Enabled ≠ routable.** Reachability is gated by hardcoded allowlists:
  - inbound: `validInboundAgents = ['no-ivr','after-hours','answering-service','azul-scheduling']` (`src/voiceAgentRoutes.ts:3400`)
  - outbound: `validOutboundAgents = ['drs-scheduler','appointment-confirmation','fantasy-football']` (`:3401`)
  - observeCall: `validAgentSlugs` (8 slugs, `:1384`); anything else coerced to `after-hours` (`:1396-1399`, `:3504-3507`).
- Routing precedence (`:3393-3509`): ① `X-agentSlug` SIP header → ② in-memory
  `callMetadata` → ③ DB phone lookup (500 ms race, `server/storage.ts:172-177`) →
  ④ default `after-hours`.
- Entry points: Twilio webhooks under `/api/voice/*` (no WebRTC, no browser voice,
  no client WebSocket). OpenAI dispatch webhook: `POST /api/voice/realtime` (`:3122`).

## 3. Active-agent inventory table

| # | Slug | Name / purpose | Status | Entry point / routing | Prompt | Tools (mutating in **bold**) | Model | State | Transcripts | Confidence active | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `no-ivr` | Primary inbound after-hours reception; answers, triages, tickets | **ACTIVE PROD** | `POST /api/voice/no-ivr`; Twilio **+16263821543**; IVR bypass | `buildNoIvrSystemPrompt()` `noIvrAgent.ts:176` (v1.20.0, voice `sage`) | lookup_schedule, check_open_tickets, emit_decision, **create_ticket**, **escalate_to_human**, terminate_call | `gpt-realtime` + `gpt-4o-mini-transcribe` | shared maps + `active_call_sessions` | `callTranscripts` + `call_logs` | HIGH | `twilio-inventory.md:96-103`; `agents.ts:31-42`; routes `:3846` |
| 2 | `answering-service` | Overflow answering service (business hours) | **ACTIVE PROD** | `POST /api/voice/answering-service`; Twilio **+19094135645** (hardcoded `agents.ts:82`) | `buildSystemPrompt()` `answeringServiceAgent.ts:184` (v3.7.0) | lookup_schedule, check_open_tickets, classify_request (local), **create_ticket**, terminate_call | same | same | same | HIGH | `twilio-inventory.md:66-73`; routes `:4132` |
| 3 | `after-hours` | Urgent triage; IVR target and **universal fallback** for all coercions | **ACTIVE PROD** | `POST /api/voice/incoming-call` IVR (TwiML App AP057abeff…); default slug `:3404` | `buildSystemPrompt()` `afterHoursAgent.ts:55` | **create_after_hours_ticket**, **transfer_to_human**, terminate_call | same | same | same | HIGH | routes `:3705,:4559,:4723` |
| 4 | `azul-scheduling` | NextGen scheduling pilot (Encinitas + Oceanside, 2 of 105 locations) | **ACTIVE PILOT** | `POST /api/voice/azul-scheduling` (no Twilio number yet, `agents.ts:90-94`); SIP header | `STATIC_PROMPT` `azulSchedulingAgent.ts:765` + dynamic tail (v2.28.0) | 21 tools → Eye Care service RPC. Mutating: **sage_book, sage_reschedule, sage_confirm_appointment, cancel_appointment, sage_new_patient_intake, sage_handoff, transfer_to_office**, terminate_call; 13 read-only sage_*/lookup tools | same (+ `AZUL_AB_MODEL_B` A/B arm `:1977-1990`) | same + server-side `si_call_sessions` state machine (scheduling repo `call-session.ts`) | same + `tool_timeline` | HIGH | routes `:4244`; scheduling repo evidence §1b |
| 5 | `appointment-confirmation` | Outbound confirmation campaigns | **ACTIVE PROD** | `POST /api/voice/appointment-confirmation` + `/outbound-confirmation`; Twilio +19093108277, +16266056373 | `SYSTEM_PROMPT_TEMPLATE` `appointmentConfirmationAgent.ts:20` | get_appointment, **confirm_appointment**, **reschedule_request**, **cancel_appointment**, **mark_confirmed**, **mark_voicemail** (local Postgres via `CampaignAdapter`) | same | campaign tables | same | HIGH | `twilio-inventory.md`; routes `:4385,:5851` |
| 6 | `drs-scheduler` | Outbound DRS scheduling (Phreesia; Computer-Use currently inert — factory passes `computer=undefined` `:1741`) | **ACTIVE** (outbound, campaign-launched) | `campaignExecutor.ts:91,139,161` → `/api/voice/test/incoming` | `drsSchedulerAgent.ts:15` | lookup_patient, **mark_contact_completed**, **Phreesia scheduling/OTP tools** (Playwright) | same | campaign tables + `scheduling_workflows` | same | MEDIUM-HIGH | registry `:109-115`; executor evidence |
| 7 | `fantasy-football` | Non-medical outbound demo (Sleeper API) | **ACTIVE (no number)** — test/campaign only | `/api/voice/test/incoming?agentSlug=…` | `fantasyFootballAgent.ts:6` | 4 read-only Sleeper HTTP tools | same | — | same | MEDIUM (routable; no production number) | registry `:125-131` |
| 8 | `dev-no-ivr` | V2 workflow-engine prototype of no-ivr | **DEV/STAGING ONLY** | `POST /api/voice/dev-no-ivr` + SIP header; no Twilio number | `workflowPromptBuilder.ts:30` (noIvrAgentV2, v2.0.0) | as no-ivr (V2 wiring), **create_ticket** | same | same | same | HIGH (dev) | routes `:4021,:4117` |

**Shadow scope decision:** agents 1–7 get shadow workflow definitions; `dev-no-ivr`
shares the no-ivr definition (same domain). `fantasy-football` is included for
completeness (read-only tools, useful as a low-risk canary agent).

## 4. Archived / dead / prototype (DO NOT MODIFY)

| Item | Where | Why excluded |
|---|---|---|
| `no-ivr-v2` slug | `agents.ts:56-64` | Registered but absent from **both** allowlists → unreachable; coerced to `after-hours`. Code runs only as `dev-no-ivr`. |
| `databaseAgent` | `src/agents/databaseAgent.ts` | Only call site is an unreachable `else` branch (`voiceAgentRoutes.ts:1933-1953`). |
| Module-level agent singletons | `drsSchedulerAgent.ts:210` etc. | Instantiated at import with stub callbacks; no importers. |
| `greeter`, `non-urgent-ticketing` | deleted; coercion entries remain (`:3402,:1385`) | Removed agents; orphan prompt builders unreferenced. |
| `documentTicketTool`, `createTicketTool` | `src/agents/tools/` | Orphans; agents define inline tools. |
| `server/productionServer.ts` | — | Zero references. |
| `voiceAgentState` | `src/voiceAgent/services/stateManager.ts` | No consumers. |
| Browser voice demo | scheduling repo `public/voice.html` + `api/realtime-session.ts` | Frozen 2026-07-16; bypasses pilot fence/zero-id/read-back headers; prompt drifted from tool surface. |
| Replit integration shim | scheduling repo `replit-integration/` | Superseded; contains stale claims and a real patient name as fixture (privacy flag → doc 10). |

## 5. Shared components in the live path (shadow tap candidates)

| Component | File | Role |
|---|---|---|
| Transcript capture | `voiceAgentRoutes.ts:2079-2200` | `session.transport.on('*')`: caller + agent transcript lines → memory + DB |
| `toolTimeline` | `src/services/toolTimeline.ts` | wraps **every** tool call fleet-wide (`recordingExecute` :178), PHI arg allowlist, flush to `call_logs.tool_timeline` |
| `conversationLoopGuard` | `src/services/conversationLoopGuard.ts` | production re-ask cap (3) with topic ledger; injects SYSTEM directive |
| `callLifecycleCoordinator` | `src/services/callLifecycleCoordinator.ts:98` | EventEmitter: `'call-ended'`, `'stale-call'`; transcript persistence; duration caps |
| `callSessionService` | `src/services/callSessionService.ts` | L1 memory + Postgres `active_call_sessions` |
| `ticketingApiClient` | `server/services/ticketingApiClient.ts` | HTTP client for the n8n VA Gateway + direct-app bypass (`TICKETING_ENRICHMENT_URL`) |
| `callGradingService` / `azulRubric` | `src/services/` | post-call LLM grading (`gpt-4o`/`gpt-4o-mini`), PHI-redacted |
| `qvoEmitterService` | `src/services/qvoEmitterService.ts` | existing **fire-and-forget external emitter with circuit breaker** — precedent for non-blocking taps |
| `structuredLogger` | `src/services/structuredLogger.ts` | JSON logs with call correlation |

## 6. Model configuration (verified identifiers)

- Voice: `gpt-realtime` (`voiceAgentRoutes.ts:534`); transcription `gpt-4o-mini-transcribe` (`:539`).
- Post-call grading/summaries: `gpt-4o`, `gpt-4o-mini` (`callGradingService.ts` multiple sites).
- TTS pricing entries also present (`gpt-4o-tts`, `gpt-4o-mini-tts`).
- No Anthropic models configured anywhere in the four repos.

## 7. Deployment targets

- Remix repo: **Replit VM**, two processes (`.replit:9`), prod domain
  `openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app`. No CI in repo.
- Scheduling agent: Vercel (crons in `vercel.json`), build = `tsc --noEmit && vitest run`.
- Ticketing app: Replit; `render.yaml` deploys **n8n only** (`ticketing-n8n` service).
- n8n live instance: `azulvision.app.n8n.cloud` (webhook URLs verified in doc 13).
  **[OPEN QUESTION → doc 10]** ticketing docs reference `ticketing-n8n.onrender.com`
  (MASTER.md:238) while live workflows resolve to n8n Cloud; treat Render blueprint
  as historical/secondary until the operator confirms.

## 8. Internal consistency check (certification)

- Every slug in both allowlists maps to a registry entry and a factory case. ✔
- Every Twilio number in `twilio-inventory.md` maps to a route above. ✔
- Agent vocabulary in the n8n validators (`no-ivr`, `answering-service`,
  `urgent-triage`, `after-hours`) matches active slugs (`urgent-triage` is the
  after-hours agent's ticket `agentUsed` label). ✔
- No repository hosts a voice agent outside the Remix repo. ✔ (three independent
  explorer sweeps + n8n webhook targets)
