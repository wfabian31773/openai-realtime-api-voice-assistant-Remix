---
name: VM publish port mappings
description: Stale [[ports]] entries in .replit make VM publishes time out at "waiting for deployment to be ready".
---

**Rule:** Before a VM republish, check `.replit` `[[ports]]` — it must list only ports the production run command actually opens (here: 5000 dashboard, 8000 voice agent). Remove any auto-added stray mappings.

**Why:** On 2026-08-04 two publishes failed after a successful build with no runtime error anywhere. Workspace port auto-detection had added mappings for 5001 and 5091 (opened by ad-hoc dev/test processes); the VM promote step waits for every declared port, so readiness timed out after ~10 minutes.

**How to apply:** Symptom signature = build succeeds → "Waiting for deployment to be ready" → failure, `fetchDeploymentLogs` returns nothing, and the app boots cleanly in a local prod simulation (`REPLIT_DEPLOYMENT=1 APP_ENV=production DOMAIN=<prod domain> npx tsx <entry>`). Fix by writing a cleaned `.replit` to a temp file and calling `verifyAndReplaceDotReplit` (direct edits are blocked). Also note: any local test process that binds a new port can silently re-add a mapping.
