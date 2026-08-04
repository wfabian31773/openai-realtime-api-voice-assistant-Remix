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

Two things that matter if you change it:

- **Only transcript- and tool-shaped events count as activity.** A stalled
  session keeps streaming `response.output_audio.delta` and keepalives; counting
  those makes the watchdog never fire. See `isActivityEvent`.
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
