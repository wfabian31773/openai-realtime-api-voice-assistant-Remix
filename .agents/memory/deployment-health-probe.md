---
name: Deployment health probe behavior
description: Replit deployments have no configurable health-check path; how this app signals readiness/failure.
---
Replit's deployment probe path is NOT configurable in `.replit` (confirmed via official docs, Aug 2026) — the platform just HTTP-probes the app.

**Why:** A code review asked to "point the deployment health check at /readyz"; that option doesn't exist on Replit.

**How to apply:** To make a broken deployment fail health checks, the endpoints the platform hits must themselves return non-2xx. This app's pattern: `/healthz` is instant 200 during startup but flips to 503 if init fails; `/readyz` is 200 only after full init; a failure gate before all middleware refuses traffic on failed init (voice webhook paths still get HTTP 200 TwiML — Twilio treats any 5xx as call failure).
