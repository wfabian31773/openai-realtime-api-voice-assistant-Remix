---
name: Supabase pooler URL + failover
description: Correct pooler URL format and the DB failover safety net that prevents a bad pooler secret from taking prod down
---
- Supabase transaction pooler URI format: `postgresql://postgres.<project-ref>:<db-password>@aws-0-us-west-2.pooler.supabase.com:6543/postgres` — password is the SAME as the direct connection's. A wrong password triggers 28P01 then Supabase's circuit breaker (ECIRCUITBREAKER), blocking ALL connections (incl. login) for minutes.
- **Why:** a mistyped `SUPABASE_POOLER_URL` secret once broke production login entirely.
- **How to apply:** `server/db.ts` validates the pooler at startup and fails over to the direct URL, exposing `dbReady`; `server/index.ts` awaits `dbReady` before any DB work. Keep that gating if refactoring startup.
- Deployment healthcheck: the API server binds its port early (before heavy dynamic imports) so healthchecks pass; `/healthz` is liveness-only. A separate readiness signal is still a known gap.
