# Zombie calls — three mechanisms, and the gap between them

A connected session that stops conversing used to run to the per-agent cap.
Between 2026-07-01 and 08-04 that was **1,138 calls and ~143 hours** of billed
silence (answering-service 865, no-ivr 187, azul 86; worst single call 4 hours —
Twilio's own ceiling, not ours).

Three things look like they should prevent this. Know which covers what:

| Mechanism | Covers | Does NOT cover |
|---|---|---|
| SIP watchdog `maxDurationTimer` (`getMaxDurationMs`) | Orphaned SIP calls that never connected | Anything connected — `cancelSIPWatchdog` **clears this timer** when the OpenAI webhook arrives |
| DB reconciler (`callLifecycleCoordinator`, 60s) | Rows stuck in `in_progress` / `ringing` / `initiated` | A call whose status is `completed` and which Twilio agrees is done |
| Dead-air watchdog (`services/deadAirWatchdog.ts`) | A connected session with no conversational activity | Calls that are talking normally |

The canonical case is **438e06f8** (2026-08-04 09:41): one agent line, then 20
minutes of nothing. `total_turns=1`, `tool_timeline` null, `duration` 1201s —
which is the azul 20-minute cap to the second, so the cap *did* fire. The cap is
the ceiling, not a safety net. Meanwhile the caller redialled a minute later from
the same number and started a second call, so the practice paid for both.

The prompt does ask the agent to handle silence (wait 5s, re-greet, wait 6s,
prompt again, then `terminate_call` with `ghost_call`). On this call the model
simply stopped. A prompt cannot enforce its own execution — same lesson as
[director-enforcement.md](director-enforcement.md).

## The watchdog

`deadAirWatchdog.arm(callId, onDeadAir)` at session creation, `.touch(callId)`
from the `session.transport.on('*')` handler, `.release(callId)` in cleanup.

**HANGING UP IS A REST CALL, NOT A TRANSPORT CLOSE.** The first live version
called `session.transport.close()` and a dead-air call still ran **459s**
(2026-08-04 14:25, after deploy). Closing the transport tears down *our* end of
the OpenAI session; it does not end the **call**, so the caller stays connected
to a line with no agent on it until the per-agent cap. The real hangup is the
same endpoint `terminate_call` uses:

```
POST https://api.openai.com/v1/realtime/calls/{callId}/hangup
```

Close the transport *after* that, as cleanup only.

Three things that matter if you change it:

- **Only WORDS or WORK count as activity** — a caller transcript, an agent
  transcript, or tool traffic. Nothing else. `conversation.item.created`,
  `conversation.item.truncated` and `response.done` were in the first list and
  had to come out (2026-08-05, call 822f7347 — 1201s on four turns): a line with
  nobody on it keeps opening items on ambient noise, and `response.done` fires
  for empty and cancelled responses. See `isActivityEvent`.
- **`total_turns <= 2` is too narrow a detector.** 822f7347 had four turns and
  300 seconds of silence per turn. Measure `duration / total_turns` instead.
- **120s default, and the binding constraint is the warm transfer, not the
  prompt's ~30s silence ladder.** `transfer_to_office` averages 28s and has been
  observed at **71.5s** producing no transcript at all. Anything under ~90s will
  cut live transfers. Tune with `DEAD_AIR_TIMEOUT_MS`; `0` disables.

## Finding them

```sql
select agent_used, count(*), round(sum(duration)/60.0,1) as wasted_minutes
from public.call_logs
where duration >= 300 and coalesce(total_turns,0) <= 2
  and created_at >= now() - interval '7 days'
group by 1 order by 2 desc;
```

`duration` high with `total_turns` at 0–2 is the signature. Note `total_turns` is
null on many older rows, so `coalesce` it rather than filtering on it.

## The fourth gap: every mechanism above lives in ONE process (2026-08-24)

All three mechanisms — SIP watchdog, DB reconciler, dead-air watchdog — run in
the voice-agent process. When Supabase restarted Postgres (2026-08-24
20:19:49 UTC) that process's pool wedged and NEVER recovered: no call_logs
writes, no reconciler, no cost estimation for 2+ days, while calls kept being
served (Twilio↔OpenAI audio never touches us; OpenAI billed a normal $174 day
against our $0 estimate). Four in-flight rows sat in `in_progress` for 52
hours and surfaced as "Live now" on the Observatory. The dashboard process's
old `cleanupStaleCallsOnStartup` would have fixed them — but it ran at boot
only, and the dashboard had not rebooted.

Two additions close the gap:

- **DB self-heal** — `databaseKeepAlive` escalates after 3 consecutive failed
  pings to `recyclePool()` (`server/db.ts`), which rebuilds the pool with the
  same live-rebinding pattern the pooler failover always used. Runs in BOTH
  processes. Decision logic pure + tested: `server/services/dbSelfHeal.logic.ts`.
- **Stale-call sweeper** — dashboard process, boot + every 5 min
  (`server/services/staleCallSweeper.ts`). Rows in a live status past 30 min
  (measured: p99 = 875s, p99.9 = 1,537s, coordinator absolute kill 25 min) are
  closed from Twilio's REAL status, marked `call_disposition='stale_reaped'`,
  durations never invented, and a call Twilio says is genuinely live is never
  touched — it is reported loudly instead. The old startup cleanup that
  defaulted unknowns to `completed` with an estimated duration is gone.

Markers: `[DB KEEP-ALIVE] self-heal armed (build 2026-08-27)`,
`[StaleCallSweeper] armed (build 2026-08-27)`. If either is absent after a
republish, the fix is not live.
