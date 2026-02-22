# Azul Vision AI Operations Hub

## Overview
The Azul Vision AI Operations Hub aims to revolutionize ophthalmology practice operations by deploying AI-powered voice agents. This system automates patient interactions, scheduling, and information management, significantly boosting efficiency and enhancing patient care. The project focuses on delivering a production-ready Operations Hub MVP and an After-Hours Triage Agent, seamlessly integrating these into existing medical practice workflows to improve operational efficiency and patient experience.

## User Preferences
- **Logging:** Color-coded transcripts (bright green for caller/agent speech)
- **Turn Detection:** Semantic VAD for natural conversation flow
- **Safety:** Medical guardrails must be strictly enforced
- **Handoffs:** Seamless transfer to human agents for STAT conditions

## System Architecture
The system utilizes a three-server architecture comprising an API Server, a Voice Agent Server, and dedicated Twilio SIP infrastructure.

**Core Architectural Decisions and Features:**
-   **Core Technologies:** Leverages OpenAI Agents SDK for real-time voice interactions and Drizzle ORM with PostgreSQL for data persistence.
-   **Voice Agent Framework:** Supports dynamic agent selection, real-time OpenAI integration, medical safety guardrails, and human handoff capabilities.
-   **Database Schema:** Comprehensive management of users, agents, calls, callbacks, and scheduling information.
-   **Registered Voice Agents:** Specialized agents for inbound calls (`no-ivr`), after-hours triage, answering service overflow, outbound scheduling, and appointment confirmations.
-   **Answering Service Agent:** Features intelligent request classification, caller memory, open ticket awareness, PHI-safe logging, and department-specific routing.
-   **Patient Context Management:** Services facilitate patient information exchange and scheduling lookups.
-   **Knowledge Base:** Centralized configuration for practice-specific information.
-   **Ticketing Integration:** Agents create tickets via an external API.
-   **Computer Use for Form Automation:** Utilizes Playwright for browser automation, specifically for outbound scheduling.
-   **Live Call Monitoring:** Dashboard for real-time visibility and management of active calls.
-   **Agent Routing:** Inbound calls routed based on Twilio number and SIP headers, with fallback to after-hours agent.
-   **Cost Attribution & Analytics:** Tracks per-call costs for OpenAI and Twilio, including AI vs. Staff savings analysis.
-   **Call Lifecycle Coordinator:** Manages call states, ensures reliable termination, and persists incremental transcripts.
-   **Greeting-First Audio:** Ensures scripted greetings play before agent responses.
-   **Provider Call Enforcement:** Prevents ticket creation for healthcare provider calls, enforcing human escalation.
-   **AI Call Review:** GPT-4o analyzes call quality and suggests prompt improvements.
-   **User Management & RBAC:** Comprehensive user management with role-based access control.
-   **Duplicate Ticket Prevention:** Uses an atomic lock mechanism.
-   **Enhanced Data Quality:** Focuses on improving phone number/name confirmation, third-party caller detection, DOB standardization, request type accuracy, urgency detection, and conversation recovery.
-   **Call Start Latency Optimization:** Achieved through parallel context lookups with timeout handling.
-   **PHI/PII Log Redaction:** All logs automatically redact sensitive patient information.
-   **No-IVR Agent Features:** Includes caller memory, preferred contact method collection, voicemail reassurance, mandatory ticket creation, interruption recovery, direct appointment answers, ghost call filtering, improved language detection, open ticket awareness, and appointment confirmation handling.
-   **Tool-Based Business Logic Architecture:** Separates conversational agents from business logic using tools.
-   **Caller Memory Service:** Injects historical context by looking up previous calls.
-   **Production Reliability:** Incorporates global error handlers, TwiML fallback, VM deployment, and a `/healthz` endpoint.
-   **Call Diagnostics System:** Provides comprehensive call journey tracking with stage-based tracing.
-   **System Alert Service:** Sends SMS notifications for critical system events via Twilio, with rate limiting.
-   **Durable Call Session State:** Uses a PostgreSQL-backed `active_call_sessions` table with a hybrid cache.
-   **Resilience Utilities:** Shared retry/circuit-breaker infrastructure for critical Twilio paths.
-   **Structured Logging:** Standardized JSON-formatted, timestamped logs with component-scoped loggers.
-   **Distributed Locks:** PostgreSQL-backed locking for multi-instance coordination.
-   **Modular Voice Agent Architecture:** Designed for decomposing voice agent logic into manageable services.
-   **Outbound Appointment Confirmation Campaigns:** System for proactive patient outreach, including flexible campaign building, timezone-enforced scheduling, voicemail detection, and inbound callback reconciliation.
-   **Phone Endpoints Management:** `PhoneEndpoints` table manages Twilio phone number configuration, synced with the Twilio API and manageable via an Admin UI.
-   **Workflow Engine Architecture:** A deterministic state machine defines agent behavior.
-   **Production Security Middleware:** Three layers protect webhook endpoints: rate limiting, Twilio signature verification, and cache control.
-   **Endpoint Protection:** Twilio callbacks validate signatures; OpenAI Realtime uses its own authentication.
-   **SIP Connection Management:** Implements max-duration safety timers and explicit termination of orphaned SIP calls.
-   **Cost Reconciliation System:** Uses a model-specific pricing registry for OpenAI costs and a dual-ledger system.
-   **Simplified Outbound Campaigns:** AI agent handles conversational voicemail detection.
-   **Database Reliability:** Implemented statement timeouts and retry wrappers on hot database paths.
-   **Schedule Table Schema Overhaul:** Simplified and normalized schema, pulling clean data from an on-prem database view.
-   **Tool-Based Business Rule Validation:** Validates required fields based on ticket type, moving business logic validation to tool code.
-   **Webhook Hardening (OpenAI Best Practices):** Includes immediate 2xx response for webhooks, webhook-id idempotency tracking, strict raw body validation, and analytics model label updates.
-   **Session End Resolvers:** Direct cleanup path from conference events to session keepalive promise.
-   **Durable Ticket Outbox:** `ticket_outbox` table with a write-first pattern ensures zero ticket data loss, with idempotency, lease-based worker claiming, exponential backoff retries, and a dead letter queue.
-   **Eval Flywheel Phase 1 - Telemetry & Graders:** Per-call telemetry on `call_logs` and 12 deterministic graders.
-   **P0 Hardening - Handoff State Machine:** Extended `handoff_state` enum with validated transitions and idempotent handoff-status webhooks.
-   **P0 Hardening - Duration Mismatch Detection:** `call_logs` tracks `local_duration_seconds`, `transcript_window_seconds`, and flags discrepancies.
-   **P0 Hardening - Hybrid Resolver Durability:** Memory-first resolver lookup with DB fallback.
-   **P0 Hardening - Ops Diagnostics API:** Aggregates 24h grader results.
-   **P0 Hardening - Release Gate:** Blocks prompt activation based on critical failure rates from graders.
-   **P0 Hardening - PHI-Safe Grader Evidence:** Redacts sensitive information from grader reasons/metadata.
-   **P0 Hardening - Regression Tests:** 33 vitest tests covering graders, PHI sanitizer, and handoff state transitions.
-   **Webhook Durable Inbox:** `webhook_events` table replaces in-memory idempotency map for persistent webhook event recording and retry.
-   **DB State Machine Constraints:** PostgreSQL trigger and unique indexes enforce state transitions.
-   **Replay/Backfill Idempotency:** `processed_version` columns prevent re-processing.
-   **Push Alerting:** `systemAlertService` sends SMS alerts for critical grader failures and anomalies.
-   **PHI Exports + Retention:** `phiExportSanitizer.ts` for redacting exports and `retentionPolicyService.ts` for configurable data retention and purging.
-   **Prompt/Version Governance:** `prompt_versions` table tracks prompt version metadata with create/promote/rollback functionalities.
-   **Data Quality SLOs:** Tracks transcript coverage, reconciliation lag, and webhook processing latency against configurable thresholds.
-   **SLO Burn-Rate Views:** 1h and 6h sliding window burn-rate calculations.
-   **Go-Live Checklist API:** Aggregates pass/fail status with real-time DB queries. Documents 4-stage rollout with rollback triggers.
-   **Synthetic Alert Validation:** Fires all 5 alert types through real channels in non-dry-run mode.
-   **Webhook Durability Diagnostics:** Exposes event status counts, dead-letter counts, and pending retries.
-   **Prompt Governance RBAC:** Promote/rollback endpoints require admin role.
-   **Startup Secret Validation:** Server logs PASS/FAIL for required secrets at boot.
-   **Secret Management:** All secrets stored exclusively in Replit Account Secrets.

## Critical: SIP Audio Format Rules (DO NOT CHANGE)
**Problem solved (Feb 22, 2026):** Two days of "dead air" / screeching audio on calls caused by codec mismatch between Twilio SIP and OpenAI Realtime API.

**Root cause:** The OpenAI Agents SDK (`@openai/agents-realtime`) always fills in `audio.input.format` and `audio.output.format` with PCM16 defaults in `session.update` events. In SIP mode, the audio codec (G.711 μ-law) is negotiated at the SIP/SDP transport layer between Twilio and OpenAI. When the SDK sends PCM16 format in `session.update`, it overrides the SIP-negotiated codec, causing screeching audio and response failures.

**The fix (in `src/voiceAgentRoutes.ts`):**
1. **Transport monkey-patch:** After creating the RealtimeSession but before `session.connect()`, we monkey-patch `transport.sendEvent()` to intercept `session.update` events and delete `audio.input.format` and `audio.output.format` fields before they're sent to OpenAI.
2. **Accept payload stripping:** After `buildInitialConfig()` produces the accept payload, we delete audio format fields before the REST API call. The SIP/SDP negotiation handles codec selection.
3. Config still has `format: 'g711_ulaw'` to prevent the SDK from defaulting to PCM16, but the monkey-patch strips it before it reaches the wire.

**Rules:**
- NEVER remove the transport monkey-patch in `observeCall()` — it prevents codec mismatch
- NEVER remove the accept payload format stripping — it lets SIP negotiate codecs
- NEVER set audio format directly via the REST API for SIP calls
- The `session.updated` response from OpenAI will show `audio/pcm` internally — this is normal, the SIP transport layer handles the actual G.711 encoding
- Look for `[SIP-FIX]` log lines to confirm stripping is active in production

## After-Hours Greeting (Standard)
The no-ivr agent greeting must always be:
> "Thank you for calling Azul Vision, all of our offices are currently closed, you have reached the after hours call service. If this is a medical emergency, please dial 911. All calls are being recorded for quality assurance purposes, how can I help you?"

This greeting is delivered by the OpenAI voice agent via `response.create` — not TwiML. It is defined in `src/agents/afterHoursAgent.ts` in the `getUrgentTriageGreeting()` function.

## External Dependencies
-   **OpenAI API:** For AI voice agents and real-time API interactions.
-   **Twilio Programmable SIP Trunking:** Provides telephony services.
-   **PostgreSQL:** Used for database persistence.
-   **Supabase:** Utilized for production database infrastructure.
-   **Phreesia:** Integrated for patient scheduling and information management.
-   **External Ticketing System:** Used for automated ticket creation and management.