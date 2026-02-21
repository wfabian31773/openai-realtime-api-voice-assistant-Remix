# Azul Vision AI Operations Hub

## Overview
The Azul Vision AI Operations Hub aims to transform ophthalmology practice operations through AI-powered voice agents. The system automates patient interactions, scheduling, and information management, significantly enhancing efficiency and patient care. The project focuses on delivering an Operations Hub MVP, a production-ready After-Hours Triage Agent, and integrating these solutions into broader medical practice workflows.

## User Preferences
- **Logging:** Color-coded transcripts (bright green for caller/agent speech)
- **Turn Detection:** Semantic VAD for natural conversation flow
- **Safety:** Medical guardrails must be strictly enforced
- **Handoffs:** Seamless transfer to human agents for STAT conditions

## System Architecture
The system employs a three-server architecture consisting of an API Server, a Voice Agent Server, and dedicated Twilio SIP infrastructure.

**Core Architectural Decisions and Features:**
-   **Core Technologies:** Leverages OpenAI Agents SDK for real-time voice interactions and Drizzle ORM with PostgreSQL for data persistence.
-   **Voice Agent Framework:** Supports dynamic agent selection, real-time integration with OpenAI, and includes medical safety guardrails with human handoff capabilities.
-   **Database Schema:** Designed to manage users, agents, calls, callbacks, and scheduling information comprehensively.
-   **Registered Voice Agents:** Includes specialized agents for inbound calls (`no-ivr`), after-hours triage, answering service overflow, outbound scheduling (Phreesia integration), and appointment confirmations.
-   **Answering Service Agent:** Features intelligent request classification, caller memory, open ticket awareness, PHI-safe logging, and department-specific routing.
-   **Patient Context Management:** Services facilitate patient information exchange and scheduling lookups.
-   **Knowledge Base:** Centralized configuration for practice-specific information.
-   **Ticketing Integration:** Agents create tickets via an external API, with server-side processing handling conversational data.
-   **Computer Use for Form Automation:** Utilizes Playwright for browser automation, specifically for Phreesia integration in outbound scheduling.
-   **Live Call Monitoring:** A dashboard provides real-time visibility and management of active calls.
-   **Agent Routing:** Inbound calls are routed based on Twilio number and SIP headers, with a fallback to the after-hours agent.
-   **Cost Attribution & Analytics:** Tracks per-call costs for OpenAI and Twilio, including AI vs. Staff savings analysis using token-based OpenAI cost calculation.
-   **Call Lifecycle Coordinator:** Manages call states, ensures reliable termination, and persists incremental transcripts.
-   **Greeting-First Audio:** Ensures scripted greetings play before agent responses.
-   **Provider Call Enforcement:** Prevents ticket creation for healthcare provider calls, enforcing human escalation.
-   **AI Call Review:** GPT-4o analyzes call quality and suggests prompt improvements.
-   **User Management & RBAC:** Comprehensive user management with role-based access control.
-   **Duplicate Ticket Prevention:** Uses an atomic lock mechanism to prevent race conditions during ticket creation.
-   **Enhanced Data Quality:** Focuses on improving phone number/name confirmation, third-party caller detection, DOB standardization, request type accuracy, urgency detection, and conversation recovery.
-   **Call Start Latency Optimization:** Achieved through parallel context lookups with timeout handling.
-   **PHI/PII Log Redaction:** All logs automatically redact sensitive patient information.
-   **No-IVR Agent Features:** Includes caller memory, preferred contact method collection, voicemail reassurance, mandatory ticket creation, interruption recovery, direct appointment answers, ghost call filtering, improved language detection, open ticket awareness, and appointment confirmation handling.
-   **Tool-Based Business Logic Architecture:** Separates conversational agents from business logic using tools like `Schedule Lookup`, `check_open_tickets`, and `create_ticket`.
-   **Caller Memory Service:** Injects historical context by looking up previous calls based on phone numbers.
-   **Production Reliability:** Incorporates global error handlers, TwiML fallback, VM deployment, and a `/healthz` endpoint for monitoring.
-   **Call Diagnostics System:** Provides comprehensive call journey tracking with stage-based tracing.
-   **System Alert Service:** Sends SMS notifications for critical system events via Twilio, with rate limiting.
-   **Durable Call Session State:** Uses a PostgreSQL-backed `active_call_sessions` table with a hybrid cache for persistent call state.
-   **Resilience Utilities:** Shared retry/circuit-breaker infrastructure for critical Twilio paths.
-   **Structured Logging:** Standardized JSON-formatted, timestamped logs with component-scoped loggers.
-   **Distributed Locks:** PostgreSQL-backed locking for multi-instance coordination, particularly for the outbound scheduler.
-   **Modular Voice Agent Architecture:** Designed for decomposing voice agent logic into manageable services.
-   **Outbound Appointment Confirmation Campaigns:** System for proactive patient outreach, including flexible campaign building, timezone-enforced scheduling, voicemail detection, and inbound callback reconciliation.
-   **Phone Endpoints Management:** `PhoneEndpoints` table manages Twilio phone number configuration, synced with the Twilio API and manageable via an Admin UI.
-   **Workflow Engine Architecture:** A deterministic state machine defines agent behavior using `workflowTypes.ts`, `workflowDefinitions.ts`, `workflowEngine.ts`, and `workflowPromptBuilder.ts`.
-   **Production Security Middleware:** Three layers protect webhook endpoints: rate limiting, Twilio signature verification, and cache control.
-   **Endpoint Protection:** Twilio callbacks validate signatures; OpenAI Realtime uses its own authentication.
-   **SIP Connection Management:** Implements max-duration safety timers and explicit termination of orphaned SIP calls.
-   **Cost Reconciliation System:** Uses a model-specific pricing registry for OpenAI costs and a dual-ledger system (org billing vs. per-call estimates) to reconcile and visualize discrepancies.
-   **Simplified Outbound Campaigns:** AI agent handles conversational voicemail detection, removing the need for Twilio AMD.
-   **Database Reliability:** Implemented statement timeouts and retry wrappers on hot database paths.
-   **Schedule Table Schema Overhaul:** Simplified and normalized schema, pulling clean data from an on-prem database view.
-   **Tool-Based Business Rule Validation:** `createTicketTool.ts` validates required fields based on ticket type, moving business logic validation to tool code.
-   **Webhook Hardening (OpenAI Best Practices):** Includes immediate 2xx response for webhooks, webhook-id idempotency tracking, strict raw body validation, and analytics model label updates.
-   **Session End Resolvers:** Direct cleanup path from conference events to session keepalive promise to prevent timeouts.
-   **Durable Ticket Outbox:** `ticket_outbox` table with a write-first pattern ensures zero ticket data loss, with idempotency, lease-based worker claiming, exponential backoff retries, and a dead letter queue.
-   **Eval Flywheel Phase 1 - Telemetry & Graders:** Per-call telemetry on `call_logs` (token counts, turns, interruptions, latency) and 12 deterministic graders (e.g., `handoff_expected_vs_actual`, `medical_advice_guardrail`, `tail_safety`).
-   **P0 Hardening - Handoff State Machine:** Extended `handoff_state` enum with validated transitions and idempotent handoff-status webhooks.
-   **P0 Hardening - Duration Mismatch Detection:** `call_logs` tracks `local_duration_seconds`, `transcript_window_seconds`, and flags discrepancies.
-   **P0 Hardening - Hybrid Resolver Durability:** Memory-first resolver lookup with DB fallback for process restarts.
-   **P0 Hardening - Ops Diagnostics API:** `/api/voice/diagnostics/grader-stats` endpoint aggregates 24h grader results.
-   **P0 Hardening - Release Gate:** `/api/voice/release-gate` endpoint blocks prompt activation based on critical failure rates from graders.
-   **P0 Hardening - PHI-Safe Grader Evidence:** `phiSanitizer.ts` redacts sensitive information from grader reasons/metadata.
-   **P0 Hardening - Regression Tests:** 33 vitest tests covering graders, PHI sanitizer, and handoff state transitions.
-   **Webhook Durable Inbox:** `webhook_events` table replaces in-memory idempotency map for persistent webhook event recording and retry.
-   **DB State Machine Constraints:** PostgreSQL trigger `validate_handoff_transition` and unique indexes enforce state transitions and prevent conflicting terminal states.
-   **Replay/Backfill Idempotency:** `processed_version` columns on reconciliation and usage tables prevent re-processing.
-   **Push Alerting:** `systemAlertService` sends SMS alerts for critical grader failures and anomalies.
-   **PHI Exports + Retention:** `phiExportSanitizer.ts` for redacting exports and `retentionPolicyService.ts` for configurable data retention and purging.
-   **Prompt/Version Governance:** `prompt_versions` table tracks prompt version metadata with create/promote/rollback functionalities.
-   **Data Quality SLOs:** `dataQualitySloService.ts` tracks transcript coverage, reconciliation lag, and webhook processing latency against configurable thresholds.
-   **SLO Burn-Rate Views:** 1h and 6h sliding window burn-rate calculations at `/api/voice/slo/burn-rate`. Fast-burn (>14.4x) triggers page, slow-burn (>6x) triggers ticket.
-   **Go-Live Checklist API:** `/api/voice/go-live/checklist` aggregates pass/fail status with real-time DB queries. `/api/voice/go-live/traffic-ramp` documents 4-stage rollout (5%->25%->50%->100%) with rollback triggers.
-   **Synthetic Alert Validation:** `/api/voice/diagnostics/synthetic-alert-test` (admin-only) fires all 5 alert types through real channels in non-dry-run mode.
-   **Webhook Durability Diagnostics:** `/api/voice/diagnostics/webhook-health` exposes event status counts, dead-letter counts, and pending retries.
-   **Prompt Governance RBAC:** Promote/rollback endpoints require admin role. Create versions requires admin or manager. Retention purge requires admin.
-   **Startup Secret Validation:** Server logs PASS/FAIL for required secrets at boot. Errors logged as CRITICAL in production.
-   **Secret Management:** All secrets stored exclusively in Replit Account Secrets (encrypted vault). No `.env` file in project. Environment.ts reads from `process.env` for both dev and production. Non-sensitive config (HUMAN_AGENT_NUMBER, DISABLE_PHI_LOGGING) stored as Replit env vars.

## Recent Changes
-   **2026-02-21:** Root cause analysis and fix for Feb 19 outage. Production DB analysis confirmed: system was 100% healthy Feb 1-19 (96%+ transcript rate on ~400 calls/day). Exact failure point: Feb 19 at 21:21 UTC — OpenAI auto-revoked the API key. Subsequent fix attempts on Feb 20 changed config format, introducing a second bug (silent agent — hears speech but never responds). Root cause of silent agent: SDK 0.3.7's `toNewSessionConfig()` expects camelCase fields (`turnDetection`, `inputAudioTranscription`); snake_case fields (`turn_detection`, `input_audio_transcription`) are silently dropped, leaving the model without turn detection. Additionally, the no-IVR path set `agentGreeting=""` and skipped `response.create`, so the agent never activated after TwiML greeting. Fix: (1) converted all session config to camelCase, (2) removed conflicting `create_response:false` default, (3) always send `response.create` after `session.connect()` even when TwiML delivered the greeting.
-   **SDK Config Convention:** SDK 0.3.7's `toNewSessionConfig()` checks for camelCase field names (`turnDetection`, `inputAudioTranscription`, `inputAudioFormat`). If snake_case is used, the function takes the "new config" code path and looks for nested `config.audio.input.turnDetection` — which doesn't exist with flat config. Result: turn detection silently dropped. ALWAYS use camelCase for session config fields.
-   **2026-02-21:** Migrated all secrets from `.env` file to Replit Account Secrets after OpenAI auto-revoked exposed API key (Feb 19 outage root cause). Deleted `.env` file. Updated environment.ts to read exclusively from process.env.
-   **SDK Version Policy:** SDK pinned to `@openai/agents@0.3.7` and `@openai/agents-realtime@0.3.7` with `openai@5.23.2`. This exact combination ran successfully in production Feb 1-19 (~400 calls/day, 96%+ transcript rate). Do NOT change these versions without staging tests — different SDK/openai version combinations produce silent config failures.

## External Dependencies
-   **OpenAI API:** For AI voice agents and real-time API interactions.
-   **Twilio Programmable SIP Trunking:** Provides telephony services.
-   **PostgreSQL:** Used for database persistence.
-   **Supabase:** Utilized for production database infrastructure.
-   **Phreesia:** Integrated for patient scheduling and information management.
-   **External Ticketing System:** Used for automated ticket creation and management.