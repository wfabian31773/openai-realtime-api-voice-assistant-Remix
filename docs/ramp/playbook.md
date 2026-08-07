# The Ramp Playbook — scripted call openings (canonical spec)

Approved by Wayne 2026-08-07 (chat). The opening of every call is driven by
a STATE MACHINE, not model judgment: greeting → classification → identity →
intent, each turn a scripted line whose answer fills a slot in the
call-facts ledger. The model renders lines naturally and hears answers —
it does not choose what happens next until identity + intent are locked.
"Remove as much flexibility as possible and replace with rigidity where
possible. Less room for errors and hallucinations."

## Capability matrix — every agent built for its purpose

| Agent | Schedules? | Human request | Can't-do script |
|---|---|---|---|
| SD Pilot (azul-scheduling) | YES | live transfer | "I'm unable to schedule new patients, but our team can take care of that for you — one moment while I connect you." |
| SAGE (5Star DRS) | YES | live transfer | same |
| Answering Service | NO — tickets only, NEVER transfers | ALWAYS, no matter how many times asked: "All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available." | never claims scheduling or transfer ability |
| No-IVR After-Hours | NO — tickets only | "Our offices are closed — I'll take your information and make sure the right team member calls you back first thing." | never claims scheduling ability |
| PCP Support | NO | ALL schedule requests → PCP queue transfer | routes, never books |

## Scenarios (exact lines)

- **S1 matched caller**: "Hello, thank you for calling Azul Vision. Am I
  speaking with {first}?" → yes → "Great — just to confirm your identity,
  may I have your date of birth?" → match → "Thanks, {first} — how can I
  help you today?" → intent.
- **S2 matched but not the caller**: "No problem — are you calling for a
  new patient or an existing patient?" → existing → patient name → DOB →
  verify. → new → S4.
- **S3 no caller-ID match**: greeting → "Are you a new patient or an
  existing patient?" → existing → name → DOB → verify. → new → S4.
- **S4 new patient**: SD: the can't-do script above, then transfer with
  everything collected. AS/After-Hours: collect name, DOB, callback
  (callback AUTO-FILLED from caller-ID, only confirmed: "Is this number
  ending in {last4} the best one to reach you?").
- **S5 verification fails twice**: NO third attempt: "I'm not finding a
  match on my end — let me get you over to our team so they can assist
  further. One moment."
- **S6 appointment intent (verified, scheduling-capable agent)**: "What
  day and times work best for you?" — never ask clinic/provider first;
  derive from the file and the answer.
- **S7 human request**: Answering Service: the busy-team script above,
  EVERY time — it never transfers, so there is nothing to deflect to;
  collect the message. Lines that CAN transfer (SD, SAGE, PCP-to-queue):
  1st: "I can usually help faster — may I ask what it's regarding?" 2nd:
  transfer immediately. Never a third deflection.
- **S8 repeat caller (3+ calls, same issue)**: "I see you've called a few
  times about this — I'm going to make sure this gets elevated to a senior
  team member right away." → priority ticket. Cross-call memory keyed on
  phone + patient.
- **S9 can't-do**: banned: "Sure, I can help with that" before checking
  capability. Can → do. Can't → capability-matrix script.
- **S10 language**: realtime models are natively multilingual — do not
  fight mid-call mixing; record preference in the ledger for future calls.
  Model-upgrade question (gpt-realtime 2.1) is tracked as a data question
  via telemetry model_id splits.
- **S11 emergency (After-Hours)**: 911 script first, always (enforced in
  the greeting).

## Ledger (the constants)

Seeded BEFORE the first word: caller phone, matched name, language,
prior-call count. Filled during: identity slots, intent, callback
confirmation. Locked on verify. Injected every turn as KNOWN — never
re-ask. Persisted for future calls (S8 memory).

## Rollout

1. Answering Service (471 calls/day, 46% critical baseline)
2. PCP
3. Unify SD onto the same engine
Progress tracked per-line in the Daily Brief against the 2026-08-06
baseline.
