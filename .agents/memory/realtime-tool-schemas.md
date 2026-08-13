# Realtime tool schemas — strict mode requires EVERY property

**This cost most of 2026-08-12.** A tool that worked perfectly in the library,
in tests, and over HTTP could not be called by an agent at all. Read this before
debugging any "the agent won't file a ticket" report.

## The bug

`src/tools/realtimeAdapter.ts` converted the tool library's JSON Schema into Zod
for the OpenAI Agents SDK. Its `toZod` made every property `.nullable()` — and
never `.optional()`.

In Zod, `.nullable()` and `.optional()` are different things. A nullable field is
still **required**; it just may hold `null`. So all 15 properties of
`file_surgery_ticket` landed in the schema's `required` array, and the tool was
registered with `strict: true`.

The model, behaving correctly, called the tool with the 13 keys it had. Strict
mode rejected the call **before `execute` ever ran**. No HTTP request. No error
in our logs. No timeline event. From the outside it looked exactly like a model
that had decided not to call the tool.

```ts
// The fix — use the registry's own schema, which is already correct.
parameters: { ...def.input_schema, additionalProperties: false },
strict: false,
```

## Why it took so long to find

**The failure is silent and it is upstream of everything we instrument.** Every
diagnostic we have starts at `execute`. I stated three wrong root causes out loud
before this one — each was a real bug, none was *the* bug:

1. "There's no `create-ticket` POST in the logs, so it was never sent." I
   withdrew this as a log-filtering artefact. **It was the real signal** and I
   talked myself out of it.
2. An unbounded health probe.
3. A tool-server 404.

**What actually found it was a control, and Wayne asked for it:** *"I don't
understand — if the optical agent can call a tool and create a ticket, why can't
the surgery agent? I thought once a tool is designed and working in the library,
any agent can call it."* Optical worked ("optical works like a charm"). Same
library, same adapter, same process. The only difference was the number of
fields — Optical's tool had few enough that the model always sent them all.

**The lesson is the method, not the fact.** Two tools, one working, one not,
through the same code path — diff them instead of theorising. I theorised three
times.

## Rules

- **Never set `strict: true` on a generated schema.** Strict mode only holds if
  `required` is exactly right, and any schema translation is a chance to get it
  wrong.
- **`.nullable()` is not `.optional()`.** If you must generate Zod, an optional
  field needs `.optional()`, and under strict mode it must also be absent from
  `required` — which is why generating it at all is the hazard.
- **A tool that never reaches `execute` leaves no trace.** `realtimeAdapter` now
  logs `[TOOLS] →` on entry and `[TOOLS] ←` on return, and wraps every call in
  `wrapWithTelemetry` + `flushTimelineSafely`, precisely so the next silent
  rejection is visible. Do not remove that logging to reduce noise.
- **`invoke(runContext, argumentsJson)` takes a JSON _string_, not an object**,
  and it swallows thrown errors into the caller-facing text "An error occurred".
  Any real diagnosis has to come from our own logging, not from what the agent
  says.

## How to test this properly

A source-scanning test — "the file contains `strict: false`" — proves a line
exists, not that a schema behaves. That gave false confidence twice in one day.
Build the tool through the adapter and assert on the produced `parameters` and
`required`, or call `invoke` with a realistic partial payload and assert it
reaches `execute`.

Verified live: **VA-51121**, filed by the Surgery agent after the fix.
