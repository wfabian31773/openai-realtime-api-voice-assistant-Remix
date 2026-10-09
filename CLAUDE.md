# RULE ZERO — THE RECORD AND THE FUNNEL

**Wayne, 2026-09-12. These two rules are BINDING. They SUPERSEDE everything
else in this file, every other document in this repo, and every prompt.
They are not guidance and they are not defaults. Do not design around them,
do not "improve" them, do not weigh them against something else. If anything
below contradicts them, the thing below is wrong and must be changed.**

> *"This has to be binding. Like, this is my fucking rule. You don't go
> against this rule. This must be done, like, ironclad. Like, do not break.
> Forbidden."*

---

## RULE 1 — IF WE HAVE A MATCH, THE JOINED RECORD IS THE RECORD

> *"We always always use — we always match on patient pre-context if we get a
> match, right, on patient master. We validate. We go to join. That's our
> record. That's the entire record. That solves every fucking problem that
> we've had, every single one that we've been having. Wrong date of birth,
> wrong this, wrong that. No location, no surgeon, no this, no that. That
> solves every single thing. You have a complete record of the patient."*

The order is fixed and there is no branch in it:

1. **MATCH** on caller-ID pre-context against **`patients_master`**. Always.
   Every call, every lane, before anything else.
2. **VALIDATE** the match. A phone number is a candidate to CONFIRM, never an
   identity (standing instruction 6) — several people share a number, and we
   never pick between them. Validation is what turns a candidate into a match;
   an unvalidated candidate is not a match and Rule 1 does not fire on it.
3. **JOIN** to the schedule on **`PersonID`** the instant a match is
   established.
4. **THAT JOINED RECORD IS THE RECORD.** The whole thing. Date of birth,
   office, provider, surgeon, visit history, contact details.
5. **CARRY IT FORWARD AUTOMATICALLY**, for the rest of the call, into every
   tool and onto the ticket. Nothing re-asks for a field the record already
   holds, and nothing overwrites a field the record already holds.

**It is the SOURCE OF TRUTH for that call.** When the record and anything else
disagree — a model argument, a transcript guess, a CNAM lookup, a parser — the
record wins.

**WHAT THIS FORBIDS.** Once the record is in hand:

- Asking the caller for their date of birth. **We have it.**
- Refusing to file for a missing `date_of_birth`, `location`, `surgeon` or
  office. **We have them.** A gate that refuses on a field the record holds is
  a bug in the gate, not a missing answer from the caller.
- Looking a caller up by name or phone STRINGS when we already hold their
  `person_id`.
- Treating the appointment book as the person base. `patients_master` says who
  somebody is; `Schedule` says what happened to them. Two tables, one key.

Every named gate loss in this file — the 75 date-of-birth refusals, the 21
optical `location` refusals, the 14 surgery `surgeon` refusals — is a call
where this rule was not applied. Wayne's claim is that the rule dissolves them
rather than fixing them one at a time, and the evidence so far agrees: of 64
callers the appointment book reported no record of, **52 (81%) have a full
record on the join**, 51 of them with an office and 19 with an appointment
already booked.

---

## RULE 2 — WHEN WE CANNOT FIND THEM, FUNNEL THE CALLER INTO THE ANSWER

> *"To solve the edge cases is not so much about the coding. You can't solve
> for every single edge case, because you can't anticipate what the caller is
> gonna say — unless you guide the caller into what to say."*

**Stop trying to parse whatever arrives. Ask the question that produces the
shape you need.** This is the standing answer to every "the model sent nothing
/ the parser refused it" defect, and it is cheaper and more reliable than any
amount of extraction logic.

### 2a. Ask new-or-existing FIRST, and let the answer close the branch

> *"Are you a new patient or an existing patient? I'm a new patient — now I
> know I don't need to look for you anymore. Now I know you're not gonna be
> there. I'm not gonna need to find appointments. I'm an existing patient —
> now I know I need to find you."*

| answer | what it settles |
|---|---|
| **new** | **Stop looking.** No lookup, no appointment search, no "we have no record of you". A miss is now EXPECTED and is not a failure to report, retry or gate on. |
| **existing** | **Find them, and keep going until you do.** A miss here is a real problem and Rule 2b is how you solve it. |

**Do NOT ask it when Rule 1 already answered it.** A caller recognised from
their phone number is an existing patient by definition — asking anyway tells
them we do not know who they are while we are looking at their chart.
`callFactsLedger.ts:138` already states this and it stays true.

### 2b. One field per question, in the format we need it

> *"If I need date of birth, I'm not gonna say 'name, date of birth'. No. I'm
> gonna say: what's your first and last name? … Now your date of birth,
> starting with the month, the day, and then the year."*

Never bundle two fields into one breath. Ask for one thing, in the order that
produces a clean answer, and **name the format inside the question**:

```
"What's your first and last name?"
        <- one field, their own words
"And your date of birth, starting with the month, then the day,
 then the year."
        <- the format is IN the question, so the answer arrives in it
```

### 2c. The general form, which is the whole point

> *"Everything else that we need, we create a funnel towards — in the
> questioning — towards that answer in the way that we need it. And then we
> carry that forward. That's it. That's everything in a nutshell."*

**For every field we need: shape the QUESTION so the answer arrives in the
format the field requires, then carry the answer forward so it is never asked
again.** Not a regex over whatever came back. Not a fallback chain. The
question.

---

## COMPLIANCE — measured 2026-09-12, do not assume any of it

**A rule written here is not a rule the code follows.** This table is the
honest state; update it when it changes, and never quote the rule as if it
were the behaviour.

| | state |
|---|---|
| Rule 1 · match `patients_master` by phone | **FIRST RUNG, LIVE SINCE v85 (2026-10-01 17:21:57 UTC) — AND v85 SHIPPED EVERY PHONE MATCH AS UNCONFIRMED, which v86 corrects.** `findByPhone` was wired into `lookupPatient`'s LAST rung only (PR #292) until v85 made the person base the FIRST rung whenever the Console is configured, with the book's string rungs as the fallback (#342). The v10 rung carried a phone match as `identityUnconfirmed`, harmless while it ran last; first, it made every recognised caller's lookup `identity_is_certain: false` and the prompts asked for name and date of birth again (3 of the first 3 phone matches). v86 carries a phone match the person base resolved to ONE person as certain, the Schedule rung's own rule; several stays ambiguous. Runtime caller-ID pre-context goes through `sage_precontext` over HTTP and **which table it reads is still UNSETTLED** — see instruction 14. Nobody was greeted by name on either pipeline on 2026-09-03; **by 2026-09-16 the greeting addressed 57–75% of substantive optical, surgery and tech callers by name on each of 09-14/15/16, and PCP went 0% → 65% on 09-16** (task #88, closed) — so the match reaches the greeting on about two thirds of queue calls; what it reads is still the open question. |
| Rule 1 · validate before trusting | **YES.** `verifyPatient` / `findByPhone` refuse to choose between two people and report a candidate count. |
| Rule 1 · join on `PersonID` | **LIVE since v10 against the Hub's `Schedule` copy. v84 (not deployed) points it at the Console's `si_appointment_facts`** — `ScheduleLookupService.lookupByPersonId`, PR #292, then the v84 PR. The Hub index `idx_schedule_personid_apptdate` stays live for the fallback. |
| Rule 1 · carry it forward into every tool and ticket | **PARTIAL.** Date of birth inherit on name match + person-base wipe stopped (v26). A caller who AFFIRMS the greeting's *"Am I speaking with <name>?"* is no longer asked for a surname or a date of birth we already hold (v27) — on 2026-09-14, 19 of the 24 recognised callers behind a date-of-birth refusal had been asked for their last name anyway. **v28 (draft #310) closed the leftover that undid that:** `### How a call runs` still said `identity_is_certain` false means "more than one person" and told the model to collect last name and date of birth. After #292 that flag is also a unique `patients_master` phone hit. Not deployed — live Replit is still v24. The gates still refuse on `location` and `surgeon` for callers whose record holds them. |
| Rule 2a · ask new-or-existing | **BUILT AND NOW GATING, NOT DEPLOYED** — `src/runtime/newOrExistingAsk.ts` appends the question at the session seam on optical/surgery/tech/records and stands down when pre-context recognised the caller. It was MISSING FROM EVERY QUEUE LANE until #293: zero hits in `opticalAgent`, `surgeryAgent`, `techAgent`, `recordsAgent`, surviving only as `rampEngine.ts:60` (`classify`) which **one** file imports — `voiceAgentRoutes.ts`, the OLD CORE — so the lanes taking the volume did not ask it. **The answer now closes the branch in code** (operator ruling, 2026-09-19, *"new should hard suppress lookup patient"*): a spoken "new" makes `lookup_patient` refuse to dispatch. `spokenPatientStatus.ts` reads the answer out of the transcript, window-scoped; `sharedPatientTools.ts` is the gate. Draft #293, v59. |
| Rule 2b · DOB asked in month/day/year parts | **YES, all four lanes** — one copy in `recognisedCallerBlock.ts:162` (`identityAskScript`), composed by optical, surgery, tech and records, plus no-ivr and answering-service. |
| Rule 2b · never two fields in one breath | **NO.** Records was observed asking for first and last name in one breath on 2026-09-03. |

Full working notes: **`.agents/memory/the-record-and-the-funnel.md`**.

---

# RULE THREE — THE CORPUS IS THE TEST, AND WE WORK UNTIL IT PASSES

**Wayne, 2026-09-15. BINDING, and it sits beside RULE ZERO because it is how
every rule in this file gets proven.**

> *"That's the whole point of grabbing those calls and putting them on disk. So
> that we can identify every single issue on every single call, build a tester,
> run it through the test, and see if it would fail again. That's the whole
> idea. That was the whole purpose. We can't get away from that. We have a hard
> set of transcripts that we get. And we run all those failures and we work
> until those failures are passing."*

**THIS IS THE METHOD. It is not optional and it is not a nice-to-have.**

1. **A real failure day gets its calls pulled to disk.** Every call, by its real
   `call_sid`, with its transcript. On disk, not in a summary.
2. **Every call is read** and its failure named — the specific one, not the
   category. "The name guard refused" is a category; "the record says
   Espinosa and the caller said Espinoza" is the failure.
3. **The corpus becomes a test**, indexed by the real SIDs, that reproduces
   each named failure.
4. **We work until the corpus passes.** Not until a reviewer is happy, not
   until the tests we already had go green — until *those* calls pass.
5. **A fix that claims to address a failure class runs the corpus first.** If
   you cannot say how many of the corpus it rescues and how many it does not,
   you have not measured it and must not claim it.

**WHAT THIS FORBIDS.**

- Saying a share is "unmeasured" when the calls are on disk. **They are the
  measurement.** If you find yourself writing "we won't know until a day of
  traffic", check the corpus first — the answer is usually already sitting
  there. *(This rule exists because I did exactly that on 2026-09-15 and Wayne
  had to point out I was holding the evidence.)*
- Shipping a fix for a class of failure without running it against the calls
  in that class.
- Letting the corpus rot. When a fix lands, the corpus is re-run and the row
  for each call says rescued / still fails / correctly refused.

**PHI: the transcripts live on disk and in `call_logs`, never in git.** What
goes in the repo is the real `call_sid` list, the failure SHAPE, and synthetic
stand-ins that reproduce it — the pattern `src/pcp/replay20260914.test.ts`
already established.

**THE CORPORA THAT EXIST TODAY:**

| corpus | what it is | the test |
|---|---|---|
| PCP, 2026-09-14 | the 17 calls that left no ticket of any provenance | `src/pcp/replay20260914.test.ts` |
| queue lanes, 2026-09-14 | the 30 certain-phone date-of-birth refusals | `src/tools/dobNameMismatch.test.ts` |

---

# READ THIS BEFORE YOU DO ANYTHING

You are working with **Wayne** on the Azul Vision voice agents. Southern
California eye-care practice. Real patients call these numbers.

This file exists because of a specific, repeated failure: **losing the context
of what was already decided and already built, and then re-proposing it.**
Two examples from 2026-08-10 alone —

- I told Wayne to take the PCP line offline (my own plan, step 1). An hour
  later I asked him why PCP was offline.
- I built `src/core/replayRealCalls.test.ts` at 21:45. At 01:00 I proposed
  building a replay harness, as if it did not exist.

That is the thing that is driving him crazy. It is not a code problem.
**Read this file and `docs/observatory/STATE-OF-PLAY.md` at the start of every
session, and re-read before proposing any plan.** If you are about to say "I
don't know why X" or "we should build Y" — check here first. It is probably
written down.

## Before touching the ticket path, read `docs/BACKEND_HANDOFF.md`

Written 2026-08-20 after a week that made surgery routing WORSE — provider fill
on department 2 went from ~98% to 49% across three merged PRs that all passed
their tests. That document holds the traced architecture, the real API contract
(which is wider than our TypeScript interfaces — three things were requested
from another team that already existed), the measured state of each queue, the
operator's standing rulings, and a list of changes that were tried and made
things worse.

The single rule it exists to enforce: **do not merge a change to the ticket path
without measuring the production number it is meant to move, before and after.**
Green tests did not prevent any of the regressions listed there.

---

## Wayne's standing instructions — these do not expire

1. **"If you don't know something, don't fill in the gaps. Ask me. And if I
   don't know, then I'll take your recommendation. But other than that, if
   it's procedural stuff, you need to ask me."**
   Procedural/domain questions go to him. Do not invent business rules.

2. **"Same exact agent, different voice pipeline. Nothing in the agent changes
   but the voice pipeline."**
   The ask has always been to swap the *pipeline* under the existing
   answering-service agent. It is NOT to write a new agent. I did that anyway
   and burned days on it. Do not do it again.

3. **"Why are you trying to determine what a first name is? You'll never ever
   get it to work like that."**
   Extraction is the LLM's job, not a regex's. This was proven correct: the
   model pulls `first_name: "Wayne", last_name: "Fabian",
   date_of_birth: "03/17/1973"` out of ordinary speech with no parser.

4. **"I don't want you to use Vapi, I want to create my own without using
   their platform."**

5. **"On the side without touching the real agents."**
   `answeringServiceAgent.ts` and the other production agents are off-limits
   unless he says otherwise. Pipeline changes go in `src/standalone/`.

6. **Verify against the mirror.** Patients verify against `patients_master`
   (the Eye Care Patient Console), not the appointment book. Carry the match
   forward as context and associate it on the ticket for staff.

7. **Capability boundary.** The answering service cannot transfer calls or
   schedule appointments. It must say so plainly and file a ticket.

8. **Stop making him the test harness.** A failing call goes into
   `replayRealCalls.test.ts` *before* any code changes. Show red-then-green
   offline. Do not ask him to dial to find out whether a guess was right.
   *(2026-09-01: `src/core/replayRealCalls.test.ts` was deleted along with the
   `src/core/` pipeline it replayed. The instrument this instruction names no
   longer exists and no replacement has been built — that is outstanding.)*

9. **"There is no handoff for any of the answering service agents, only for
   PCP, Scheduling SD. All other agents politely state they are unable to
   handoff and can only create a request for a callback."** (2026-08-12)
   Those agents get **no transfer tool at all** — not a disabled one. A tool the
   agent cannot see is a promise it cannot make.

10. **Nobody is told to call back.** (2026-08-13) *"We can't just tell the
    patient call back, call the wrong extension."* Queues are forwarded; a
    caller who pressed the wrong option gets their request taken and routed.
    Schedule-related goes to the **HVA Hub from every queue — except a surgery
    date**: *"surgery is an exception to that hva hub rule."*

11. **Route by queue.** Each queue gets its own number, webhook and slug. Do not
    multiplex queues onto one agent behind a mode flag.

12. **Confirm the callback number BEFORE filing, not after.** Correcting it
    afterwards means a second ticket and a patient who was told the wrong thing.

13. **After hours, everything goes to the after-hours agent** via Nextiva
    enterprise routing, and it escalates to Wayne directly. *"It's impossible to
    reach that line after hours."* Do not build after-hours behaviour into a
    queue agent. **All overnight volume is on the no-IVR agent**, which Wayne
    uses as the after-hours agent (2026-08-13).

14. **One source of truth: the Eye Care Patient Console.** (2026-08-31)
    *"Any scheduling or pre-context or anything of that nature, verification,
    should run to the Eye Care Patient Console's patient summary or patients
    table, and there's a mirror also in there that holds the schedule as well.
    So we should use those two tables. Same thing for providers or anything
    like that of that nature. All of that information is in the console.
    That's where we should — one source of truth."*

    Applies to **the runtime agents and 5Star**. Read the Console project
    `kbbmywvasbsxnbblrhot`, not the Operations Hub's own copies:

    | what you need | table | rows |
    |---|---|---|
    | who a person is | `patients_master` | 915,843 |
    | the schedule mirror | `si_appointment_facts` | 908,995 |
    | providers | `si_providers` | 77 |
    | locations | `si_locations` | 105 |
    | phone → patient (whether IT or `patients_master` powers `sage_precontext` is UNSETTLED — see below) | `si_persons` | 3,731 |

    **What violates this today — do not assume it is already done:**

    - `lookup_patient`, the FIRST tool optical, surgery, tech and records call,
      goes to `scheduleLookupService`, which imports `{ schedule }` from the
      Operations Hub — the appointment book. A real patient with no
      appointment inside the schedule window cannot verify, and the failure
      looks random from outside.
    - `src/services/patientVerification.ts` already reads `patients_master`
      correctly and was written for exactly this bug. Its only two wirings
      were `src/core/router.ts` and the standalone demo line, and both trees
      were deleted on 2026-09-01 — so today it is wired into **nothing**, and
      still never into the shared queue tool.

      **DO NOT DELETE IT AS DEAD CODE.** It is the correct implementation of
      this instruction and the only one in the repo; it has no importers
      because the two callers it had were dead pipelines, not because it is
      wrong. Where mirror verification should be wired on the live path is
      an open question for Wayne.
    - Caller-ID pre-context on the runtime goes through
      `fetchAzulPrecontext` → the `sage_precontext` HTTP tool. It is Console
      data over the network, bounded at 1.5s, and every failure is normalized
      to `null`, so the agent asks cold for several different reasons.
      **WHICH Console table it reads is UNSETTLED:** `voiceRuntime.ts:715`
      says `si_persons`, `voiceAgentRoutes.ts:2481` says `patients_master` and
      cites the service's `sage-tools.ts`, and the Console's only phone→person
      RPCs all read `patients_master`. Do not quote either as fact — see the
      pre-context entry under the 2026-09-03 measurements. The RETURN VALUE is indistinguishable; the logs are
      not — `callEyecareTool` writes `[AZUL-SCHED]` lines naming an unset key,
      an HTTP status, or a fetch/abort, and 401/403 go through
      `noteAuthFailure`. The one genuinely silent mode is a lookup that
      succeeds after the 1.5s deadline: nothing logs that, the call just
      proceeds without pre-context.

    `lookup_patient` is not only verification — it also returns the offices
    and providers a patient was actually seen at, which is how optical
    resolves which office they mean. So the shape is mirror-first for
    identity, then the schedule for history. Not one replacing the other.

15. **ADVISE, DO NOT WAIT.** (2026-09-16) *"Don't just sit there and wait for
    me for everything. Make your suggestions, recommendations. I'm trusting you
    and allowing you to guide this operation in the best practice the way it
    should be... if I tell you do something and you know that there's a much
    better way to do it, or much more efficient or more modern way to do
    something, then it's your obligation to bring that to my attention. Don't
    just take what I give you and act on what I give you. Take what I give you
    as what I'm trying to accomplish and then you suggest the best way to
    accomplish that. That's the way we need to operate."*

    **A request is a GOAL, not a specification.** Read what he is trying to
    accomplish, then propose the best way to accomplish it — with a
    RECOMMENDATION, not a menu. Bringing a better approach to his attention is
    an obligation, not an option, and that includes saying so when the thing he
    asked for is not the best way to get what he wants.

    **THIS DOES NOT REPEAL INSTRUCTION 1, IT BOUNDS IT.** Instruction 1 is
    about not INVENTING business rules — who may receive records, which
    department a request belongs to, what the practice's policy is. Those still
    go to him. Instruction 15 is about not WITHHOLDING engineering judgement.
    The test: *would getting this wrong be a wrong policy, or a worse
    implementation?* Policy asks. Implementation recommends and proceeds, with
    the reasoning and the trade-off stated so he can overrule it.

    **A blocking question is a last resort**, reserved for a decision where
    proceeding either way would be unsafe or would waste the work. Everything
    that does not depend on the answer gets built while the question is open.

---

## Line status — check this before saying anything about what is on or off

**2026-09-03 was the runtime cutover.** Three queue lanes moved off the OpenAI
SIP core onto the Grok Media Streams runtime, each at its own moment, and each
one is a same-day A/B you can still measure. `voice_provider = 'grok'` is the
discriminator; a NULL there is the old core.

| Line | Pipeline | Cutover (UTC) | Calls 09-03 | Filed (substantive) | Notes |
|---|---|---|---|---|---|
| **optical** | **Grok runtime** | 15:24:58 | 84 | 28/56 = **50.0%** | First lane over. Only 2 old-core calls that day, so it has NO same-day before-arm. |
| **surgery** | **Grok runtime** | 19:43:57 | 55 | 18/32 = **56.3%** | Before: 22/44 = 50.0% on the old core, same day. |
| **tech** | **Grok runtime** | 19:51:10 | 100 | 46/66 = **69.7%** | Before: 49/73 = 67.1% on the old core, same day. Busiest lane. |
| **records** | **Grok runtime — repointed by the operator 2026-09-27, first runtime call 19:19:03 UTC** | 2026-09-27 ≤ 19:19:03 | 38 (old core, 09-03) | 14/29 = 48.3% | The same-day CONTROL, and the reason the comparison is trustworthy. It also means records is missing every ruling shipped to the runtime lanes — on 2026-09-03 23:54 it said "all of our agents are currently busy… as soon as they become available", which #265 forbids, and asked for first and last name in one breath. **2026-09-27: the records-line review (`docs/observatory/RECORDS-LINE-REVIEW-20260927.md`) measured 43% of this lane's calls never becoming a ticket over fourteen business days, 66 of them real conversations the agent dropped, on the one department under a Corrective Action Plan.** The operator approved moving it to the runtime; the repoint is his (standing instruction 11) and the exact URL is in the review's § 5. v73 is the build it should land on. **Both halves merged 2026-09-27 16:49 UTC — ticketing-app #320 and voice #333 (v73) — and the app was republished at 16:52 UTC; the voice republish and the Twilio repoint are his, in that order, and `/voice/health` still read v72 at 16:55 UTC.** **BOTH HAPPENED THE SAME AFTERNOON:** `/voice/health` read v73 at 17:10 UTC, and the first records call on the runtime is `CA37cbc1242fe878ae6b355383cf100826` at 19:19:03 UTC — the operator's own test, 116 s, `voice_provider = 'grok'`, filed a ticket and sent the signing form by text (the funnel v73 carries). **BUT THAT CALL WAS DIALLED TO A NUMBER THAT HAS CARRIED ONE CALL IN FOURTEEN DAYS — the test itself (Twilio number ending 3027) — AND THE RECORDS LINE IS STILL ON THE OLD CORE.** Found by the 23:20 UTC fleet watch the same Sunday: at 22:26 UTC a real caller reached the number ending **5645** — which carried **364 of the 365 records calls of 2026-09-13..27** — and the OLD CORE answered it: `CA76358a5f79fe7b9d0028a924d8db1ab4`, 158 s, 20 caller lines, one tool (`set_spoken_language`), **no ticket of any provenance**, the post-call sync answered 404 six times. So the repoint moved a number that carries no traffic, `dialed_number` on the two rows is what proved it, and until the number ending 5645 points at the review's § 5 URL the lane's first business day on the runtime has not happened — the 09-28 watch will find nothing. The 38 and 48.3% in this row are the old-core before-arm and stay as written. |
| **no-ivr** | old core — **review for the runtime move written 2026-09-27: `docs/observatory/NO-IVR-LINE-REVIEW-20260927.md`.** The runtime already registers the lane servable with its warm transfer armed and NOTHING has been pointed at it; what stands between it and the move is the operator's three test calls on `/voice/no-ivr` (the warm transfer has never run live on this pipeline) and a weekday repoint between 09:00 and 15:00 Pacific. Before-arm, 14 days: 1,010 calls · 617 substantive · **346 filed (56.1%)** · 271 with no ticket of any provenance — 99 never heard, 81 hung up before any tool ran, 60 ran tools and filed nothing. The move fixes none of those; it brings the transport-played greeting, the silence ladder, a recording, the tool ceiling, the telemetry, and about half the cost per minute on last week's reconciled rate. **v75 (2026-09-28) gives this lane `set_spoken_language` — it was the one lane without it, so on the runtime its transcription hint could never follow a Spanish caller — and restates its language block in xAI's language-lock shape. The docs audit (`docs/observatory/XAI-DOCS-CONFORMANCE-20260928.md`) finds the prompt itself was never rewritten for Grok: 28,478 own chars against 6,374–7,421 on the lanes that were, none of the five sections, six CRITICAL banners. **v76 (same PR) IS that rewrite:** `src/agents/noIvrPromptForGrok.ts`, the same rulings in the guide's five sections at 49% of the size, built ONLY when the call's metadata says `pipeline: 'runtime'` — so it deploys inert on the old core and is live from the first runtime call; `noIvrPromptShapeForGrok.test.ts` holds both bodies to one rulings map. One deliberate change for the operator to overrule: last name, then date of birth, one field per question. v77 (same PR) moves the language tool and its words into the RUNTIME for every lane — this lane's English-and-Spanish policy becomes `spokenLanguages` on its registration — and guards the docs' shape on all six served lanes (`promptShapeIsTheDocs.test.ts`).** | — | — | — | After-hours agent. All overnight and weekend volume (standing instruction 13). **ITS WINDOW IS 00:00–14:59 UTC — it STOPS at 8am Pacific** (operator, 2026-09-14), which is 15:00 UTC in PDT and 16:00 UTC in PST, and is exactly when the queue lanes open. Measured over four business days 09-08..09-11: hours 0–14 carry calls, **hours 15–23 carry ZERO on every one of them**, and the two PEAK hours are the two either side of a handover — hour 0 (100 calls, just after the queues close at 5pm Pacific) and hour 14 (100 calls, the last hour before they open). **So no-ivr going silent at 15:00 UTC is the daily handover, not an outage** — any "lane went quiet during business hours" check must exclude this lane or it cries wolf once a day, every day. |
| **pcp** | **Grok runtime — BACK ON 2026-09-04 ~16:00 UTC** | 2026-09-04 ~16:00 | 3 test calls | — | Wayne switched it over himself and made three test calls. It had been OFF since Aug 10 (his decision — do not ask why it *was* off). **TWO-DAY PEAK, not a steady-state rate:** it ran 08-06 and 08-07 at **216 and 203 calls**, then was switched off — so no average exists for it. Like-for-like on BUSIEST DAY: pcp 216 · tech 214 · surgery 161 · optical 119. An earlier version compared that peak against the other lanes' 15-16 day AVERAGES (165/107/79) and concluded pcp beat surgery+optical combined; that mixed two different windows and is withdrawn (Codex, PR #272). Peak-for-peak it is the busiest lane by a nose, on two days of evidence — its typical full-volume traffic is UNMEASURED. **A live defect is open on it: see below.** |
| **azul-scheduling** (San Diego) | **OFF** | — | — | — | Gate B replay books 8 of 21. Not ready. Do not ask why. |
| **answering-service** | old core | — | — | — | — |

### PCP TRANSFER — the outage that made this a LIVE defect is CLOSED (2026-09-08)

Found in Wayne's own test calls, 2026-09-04 16:11 (`CAa37f1a422d120c200d2038c1314a32aa`).
A caller from a surgery center asked for a representative. The agent said:

> "Give me one moment while I connect you with our PCP team — I'll stay right
> here with you."

Then `transferred_to_human = false`, `transfer_outcome` NULL,
`runtime_outcome = agent_ended`.

**DO NOT REPEAT THE READING THAT PRODUCED THOSE TWO FACTS.** I concluded "no
transfer was attempted" from `transferred_to_human` and `transfer_outcome`, and
on the RUNTIME those columns cannot say that: `recordTransferOutcome` lives in
`voiceAgentRoutes.ts` and keys on `officeLegDials`, a map only the OLD CORE's
dial path populates, so **every runtime transfer read as "none attempted"**.
The 2026-09-08 calls proved it — the ticket carried destination, timing and
`NO_ANSWER` while `call_logs` carried nothing. An absent measurement reads as a
negative finding, which is the `agent_id` blindness of 2026-09-04 in a second
column. Fixed on `claude/determined-brown-o5qsft`; **until that is deployed,
measure PCP transfers from `tickets.pcp_handoff_*`, never from `call_logs`.**
The conclusion about this particular call still held, for other reasons. It filed PCP-57486 ("Service inquiry", noting
the intake was incomplete) and ended the call. **No transfer was attempted.**

**WHAT THIS DOES AND DOES NOT ESTABLISH.** The defect is the BROKEN PROMISE,
and that stands whichever way the open question below is settled: the agent
said it would connect the caller and then did not, and it did not say
otherwise either. Nothing here establishes that this call was *required* to
transfer — an earlier version of this section said it "MUST transfer", which
silently resolved the operator's still-open question (entity + asks + the
matter is ticketable) in one direction, inside the same section that marks it
open. It was in fact recorded as a service inquiry and it DID file a ticket,
which is what the "ticketable → ticket it" half of the rule asks for. The
wrong part is the sentence spoken to the caller, not necessarily the routing.
(Codex, PR #272.)

**Scope: one observed call.** It proves the failure mode exists on this lane;
it does not establish how often it happens. The runtime has three test calls
in total. An earlier version said "at 200+ calls/day … every entity that asks
for a person gets a promise and a dial tone" — both halves were unearned: the
volume was extrapolated from two peak days, and "every" from a single call.

**There IS a measured history for the shape, on the OLD core.** Over PCP's two
full days (2026-08-06/07), of 67 substantive calls whose `agent_outcome` was
`escalated`: **8 reached a human, 20 filed a ticket, and 47 produced NEITHER.**
So "the agent decides it cannot handle the call, then does nothing" is a
long-standing and concentrated loss on this lane, not something the pipeline
change introduced. That is evidence the shape recurs; it is NOT evidence that
those 47 should have been transferred — under the rule below most of them
should have been TICKETED.

**THESE ARE TWO DIFFERENT DEFECTS. Do not merge them.** An earlier version of
this paragraph ended "what is wrong in both is ending with neither", which is
false of the live call: **it DID file PCP-57486.** Its ticket path worked.

| | what failed |
|---|---|
| the live 2026-09-04 call | **the spoken promise** — said it would connect, then did not, and did not say otherwise. Filed a ticket. |
| the 47 historical calls | **neither a transfer NOR a ticket** — the request left no trace at all. |

They may share a cause and they may not. Sending follow-up work toward
missing-ticket handling on the basis of the live call would be chasing the
wrong defect, since that call's ticket filed. (Codex, PR #272.)

**ROOT-CAUSED AND CLOSED 2026-09-08 — it was neither the mechanism nor the
lane wiring. The ticket API was rejecting the field that sanctions the
transfer.**

`handoff_to_pcp` files its HAND_OFF ticket BEFORE it dials, and attaches
`dispositionGrantedByExplicitAsk` — the flag set only when a caller explicitly
asks for a person. The ticketing app's schema was `.strict()` and did not
declare that field, so every payload carrying it was refused, the gate ahead of
the dial never opened, and the agent filed a CREATE_TASK instead. Measured:
**19 of 19 POSTs carrying the flag rejected since 2026-08-27; 10 of 10 without
it accepted.** The field that marks a transfer as sanctioned was the field that
killed it.

Fixed on the ticketing app (Replit), and **proven in production the same day**:
on `CAa2a3a1c1e63db974a5063b065b2622a3`, 2026-09-08 12:28, three HAND_OFF POSTs
returned 200, PCP-57920 recorded `pcp_handoff_attempted = true`, destination
`+17149564300`, and the dial went out at 12:30:08.

**It rang out — `NO_ANSWER` / `office_no_answer`.** That is a capacity and
answering question, not a code defect, and it is the open one: see the queue
sizing note under standing instruction 11.

**WHAT WAS STILL WRONG, and is now fixed on `claude/determined-brown-o5qsft`:**
the agent said nothing about the failed dial and went back to the intake script
("What is the patient's first name?") while the caller asked "Did you try to
connect?" — because the tool answered a failed dial with a bare
`{success:false}` and no copy. It also took **three** asks to reach the dial;
his opening line "can I speak to the team please?" did not match
`askedForAPerson` at all, because two regexes had drifted apart on their nouns.

### CAbf717457, 2026-09-08 14:47 — LOST TO A SURGEON GATE ON A PCP CALL

The operator rang the PCP line, asked for a representative in his first
sentence, and hung up 82 seconds later with **no ticket and no transfer**. The
transfer machinery was not at fault — it had been proven working on the same
line two hours earlier (PCP-57920, above). The cause is a chain, and every link
is in `voice_agent_api_logs`:

> CALLER: I am calling from **Loma Linda Surgery Center** and I need to speak to
> a representative.
> AGENT: May I have your full name? … **Who is the surgeon for this case?**
> CALLER: You transfer me to the office?
> AGENT: I'm not able to put you through from this line…

1. The model classified an ENTITY caller as `patient_caller` — it asked "May I
   have your full name?", which is the patient branch's question, and never
   asked for a role or an organisation.
2. That branch files through the shared cross-queue router, and
   `detectCrossQueue` matched **`surgery center`** in `SURGERY_CUES`. The
   caller's EMPLOYER was read as the subject of the request, so the ticket went
   to **department 2**.
3. Department 2 demands a surgeon. `create-ticket` answered HTTP 400 *"Missing
   required information: surgeon"* — **six times, 14:48:06 to 14:48:24** —
   because `create_pcp_task`'s patient path answered every failure with
   `retryable: true` and the model obliged. That is the 2026-09-01 storm (602
   POSTs across 181 surgery calls) in a second place;
   `CreateTicketResponse.statusCode` was added for exactly this and this call
   site never read it.
4. `handoff_to_pcp` was never called at all. `isPatient` makes
   `handoffEligible` false permanently, and the prompt's patient-only refusal
   ("I'm not able to put you through from this line") is what the agent spoke
   to a surgery centre.

**Fixed on `claude/determined-brown-o5qsft`:** link 3, so a 4xx comes back as a
question with the server's own words instead of a retry flag.

**NOT fixed, and both are open:** link 1 — a `patient_caller` misclassification
is sticky and silently forfeits the transfer for the rest of the call; and link
2 — `'surgery center'` as a subject cue fires on a caller's employer. Link 2 is
a ticket-path routing change affecting every lane that uses `detectCrossQueue`,
so `docs/BACKEND_HANDOFF.md` applies: measure department-2 misroutes before and
after, do not just delete the cue.

### THE PCP TRANSFER IS NOW BLIND — Rosa's design, approved 2026-09-08

> *"we should just dump the call into the queue… scrap the warm transfer and
> provide a verbal warning that they will be transferred to the live queue where
> there is no guarantee of wait time… a ticket should be created even when they
> are transferred and it should be searchable by phone number. The auto
> attendant routes to us and we transfer back to the PCP call center queue, so
> we grab it early before it actually hits the queue."*

The warm transfer's safety property — never move the caller until a human
presses a key — is right when the destination is a PERSON. `PCP_HUMAN_AGENT_NUMBER`
is not: asked directly, *"No, it's a call center."* Measured ring-to-accept on
that number is 17–41s (avg 32) and **the runtime says nothing while it rings**
— `HOLD_LADDER` exists only in `azulSchedulingAgent`. So the keypress was being
bought with the caller's patience against a destination where an ACD answering
is the normal case.

- **PCP only.** Every other transfer-capable lane keeps the warm path.
  `RUNTIME_TRANSFER_MODE=warm|blind` overrides per deployment; unset is the
  per-lane default. That is the revert lever — no code change needed.
- **The ticket still files BEFORE the redirect.** Unchanged — **except for a
  caller who chose the queue, where it files nothing since 2026-10-01 (operator
  ruling; see the v86 marker row).**
- **The warning is spoken by the TwiML, not the agent** (`blindTransfer.ts`):
  the redirect ends the media stream, so anything the agent is still saying is
  cut mid-word. The prompt now says to say NOTHING before `handoff_to_pcp`.
- **What was traded away: proof that a human answered.** Nothing on this path
  may record as `accepted` — that word stays reserved for the keypress. The
  vocabulary is `handed_to_queue` (redirected, nothing known) then, from
  Twilio's `<Dial action>` callback, `queue_answered` + `talkSeconds` or
  `no_answer`. **`queue_answered` means the ACD picked up, NOT that a person
  spoke** — a two-second `talkSeconds` is a caller who gave up in hold music.
- **The ticket says `DIALING`, never `CONNECTED`,** with
  `humanAnswerStatus = 'TRANSFERRED_TO_QUEUE'` and no `connectedAt`. A staffer
  reading CONNECTED assumes the conversation happened and skips the callback,
  which is the one thing Rosa's ticket exists to prevent. Both values are
  already in the ticketing app's `PCP_HANDOFF_STATUSES`, so this needs nothing
  from that team — and that schema is `.strict()`, which is what killed the
  transfer on 2026-08-27.

**Two of Rosa's three asks were already true, measured 2026-09-08** over all 213
PCP tickets: 211 carry a callback number, 213 carry `caller_phone`, 68 were
transferred, and **0 were transferred without a number**.

**Not yet answered:** whether a caller in the ACD's hold queue can still be
reached if they hang up (they cannot — we let go of the leg), and whether the
`DIALING` status should become a `TRANSFERRED_TO_QUEUE` enum value on the
ticketing app rather than free text in `humanAnswerStatus`.

**WAYNE'S PCP TRANSFER RULE (2026-09-04), replacing "anyone who asks goes through":**

- Default is to take the request and file the ticket. **Never auto-transfer.**
- Transfer only when BOTH: the caller **asks** for a representative, AND the
  caller is an **entity** — doctor's office, medical group, surgery center,
  insurance — **not a patient**.
- Ticketable → ticket it. Not ticketable → let it through on request.
- **OPEN:** an entity asks for a rep about something that IS ticketable — does
  the ask win or the ticket win? Not yet answered. Do not assume.
- The entity test is the model's read of what the caller SAYS. There is no
  verification behind it.

**Also observed on those calls, not yet fixed:** the agent asks "What is your
role?" and then "What is your professional relationship to this patient?" and
gets the same answer twice; it asked seven questions before reaching the
patient even when the caller opened with name and purpose; no callback number
was captured on either ticket (standing instruction 12); and no recording
disclosure was spoken. Wayne also wants the voice changed — which voice is his
call, unanswered.

**THE HEADLINE OF THE CUTOVER: filing rate is FLAT.** tech +2.6 points, surgery
+6.3 — neither is significant at these n. The runtime matches the old core. It
is not better and it is not worse, and anyone claiming either without a control
is reading noise.

**What DID change, measured on the same calls:**

- **Turn detection is better.** tech callers said MORE (353 vs 333 characters)
  in FEWER transcript lines (6.0 vs 7.7) at the SAME duration (128s). Less
  fragmentation, no lost speech. `call_logs.total_turns` fell 16.1 → 9.7 and
  is counting something else — do not quote it.
- **The agent speaks in about twice as many short lines** (tech 7.4 → 9.3,
  surgery 4.8 → 8.2). Not yet judged good or bad.

## What already exists — do NOT rebuild these

| Thing | Where | What it does |
|---|---|---|
| Mirror verification | `src/services/patientVerification.ts` | Verifies against `patients_master`; refuses to guess between two people. |
| Appointment answers | `src/services/appointmentAnswers.ts` | `Schedule.PersonID` join; excludes `Removed`. Also **exports `byPerson()`** — the one `::uuid` comparison in the repo. |
| Mirror → schedule join | `ScheduleLookupService.lookupByPersonId` + `consoleScheduleFacts.ts` | Identity from `patients_master`, then the WHOLE record on `PersonID` through the same `buildContext` as every other rung — read from the Console's `si_appointment_facts` when `OBS_CONSOLE_DATABASE_URL` is set (v84), the Hub copy otherwise. Bypasses `splitByPerson` (a primary key cannot mean two people); a failed join leaves the identity standing. |
| Replay tables | Operations Hub | `new_core_replay_summary`, `new_core_replay_index`, `ticket_agent_config` |
| Date-of-birth parsing | `src/tools/dobParts.ts` | Reads a date out of a whole spoken sentence, English + Spanish months, two-digit centuries. **Turkish is a known, evidenced gap.** Also exports `dobShape` — the PHI-free shape of what arrived, which is the only way to tell "the model sent nothing" from "the parser refused it". |
| Spoken DOB from the transcript | `src/tools/spokenDob.ts` | Third filing source after the model's argument and `verifiedDobFor`. A date counts only in the turn that answered a DOB *ask* — not a mere mention. Acknowledgements ("I have your date of birth, thank you. Anything else?") do not open a window. Re-asks that do not use "may I" ("need your date of birth", "except your date of birth", "mis-heard" / "once more") still do. A later attempted-but-refused date clears the cache; a confirmation does not. Same-turn "sorry I meant" replaces the first date in the window. |
| The teardown request sweep | `src/runtime/requestSweep.ts` (decides) + `sweepRunner.ts` (files) | If the caller made a request and no filing tool succeeded, files it from the transcript at teardown. Wired in `voiceRuntime.ts` AFTER the call_logs write. Recovers only 6 of 53 today — see the open question about "no name, no ticket". |
| Mid-call language switching | `src/tools/languageTools.ts` + the bridge's transport step | `set_spoken_language`; result to the model BEFORE the wire changes. Proven live 2026-09-03 on a Turkish caller. **Bound to EVERY runtime lane by `laneRegistry` since v77 (`RUNTIME_OWNED_TOOLS`), with the one copy of its words appended by `agentBinding` from `src/runtime/languageMechanism.ts` and each lane's language POLICY read from `spokenLanguages` on its registration** — no lane lists the tool or writes the mechanism any more. The handshake seeds NO `language_hint` for a defaulted-English lane since v75 (the docs: the model detects; the hint biases). |
| The tool ceiling | `src/runtime/toolCeiling.ts` | Stops a tool loop — a failure run (3 identical / 6 per tool) AND, since v46, a SUCCESS run (10 identical, answered with the tool's last answer / 20 per tool), under a 40-dispatch backstop. Keys on arguments with case and spacing ignored. Its stops are INVISIBLE in `tool_timeline` (it short-circuits before dispatch, so `wrapWithTelemetry` never runs); console-only, uncountable from SQL — the LOOP itself is countable (one tool succeeding 11+ times on a call) and must read 0. |
| Grok cost from the bill | `src/services/grokCostAllocation.ts` + `xaiBilling.ts` + `grokCostReconciler.ts` | Splits xAI's authoritative daily total across the day's calls by seconds. **Dormant without `XAI_MANAGEMENT_KEY` / `XAI_TEAM_ID`.** |
| The runtime's agents-table id | `src/runtime/agentIdentity.ts` | slug → `agents.id`, cached per lane. Without it every runtime call is absent from five per-agent reports. |
| Pipeline label on a card | `client/src/lib/pipelineSplit.ts` | Says which stack served a lane's calls, and warns on a mid-day cutover. |
| PCP blind transfer | `src/runtime/blindTransfer.ts` + `blindTransferDialResult.ts` | Warns the caller, hands them into the PCP call-centre queue, and reads Twilio's `<Dial action>` back so the outcome is still measurable. PCP only; `RUNTIME_TRANSFER_MODE` overrides. |
| "Greeting already played" | `src/runtime/greetingAlreadyPlayed.ts` | Appended by the RUNTIME, not the prompts — the transport is what plays the greeting, and tech has 16 tokens of ceiling headroom. |
| The bounded office ask | `src/tools/sharedPatientTools.ts` (`resolve_location`) | Refuses when the office is the wrong KIND for the queue instead of returning `success: true` with a message, and bounds the ask at two per call (`RESOLVE_ASK_LIMIT`) so a refusal cannot become a 35-call well. Merged as #282; **the after-number has not been taken** — see the ceiling section. |

---

## Architecture facts that cost hours to learn

- **The old core's ear, brain and mouth are ONE OpenAI SIP session.**
  Twilio → conference → SIP → `sip.api.openai.com`. Audio never touches our
  servers. This is why STT cannot be swapped without changing the transport —
  that fact is the whole reason the standalone line exists.
- **Caller-ID pre-context is why the old core "knows who is calling."** It
  looks the number up *before answering*, so the agent says "Am I speaking
  with…?" — confirm, not ask. Wayne's number resolves to **eight** records in
  the mirror, so a phone match is a **candidate to confirm, never an identity**.
- Twilio `<Connect><Stream>` **replaces** the call (socket close = hangup);
  `<Start><Stream>` forks audio and the call continues.
- Twilio `mark` events are the **only** ground truth that audio actually played
  to a caller. `clear` discards Twilio's buffered audio.
- Deepgram: `is_final` (settled words) ≠ `speech_final` (caller stopped) ≠
  `UtteranceEnd`. Accumulate until `speech_final`/`UtteranceEnd` or every
  question gets asked twice.
- Anthropic: **every `tool_use` must be answered by a `tool_result` in the very
  next message.** If not, the API rejects the *whole history*, so one malformed
  turn kills every later turn of the call.
- Supabase projects:
  - **Operations Hub** `pslzngjciiifowemrzza` — `call_logs`, `Schedule`, `ticket_agent_config`
  - **Patient-Console** `kbbmywvasbsxnbblrhot` — the source of truth
    (standing instruction 14). `patients_master` (915,843 persons),
    `si_appointment_facts` (908,995 — the schedule mirror), `si_providers`,
    `si_locations`, `si_persons` (phone→patient; whether it or
    `patients_master` powers `sage_precontext` is UNSETTLED),
    plus the scheduling-intelligence tables (`si_slot_rules`,
    `si_eligibility_matrix`, `open_slots_snapshot`).
  - The Hub keeps its OWN `Schedule` copy and several services still read it.
    That is the appointment book, not the person base, and it is the reason
    verification has been the hardest part of every line — see instruction 14.
  - `Schedule.PersonID` (uuid) ↔ `patients_master.person_id`; `uuid = text`
    needs an explicit `::uuid` cast.

### THE JOIN IS THE WHOLE THING, AND IT HAD NO INDEX — 2026-09-12

**The operator has said this from the start and it took him saying it again to
land: there is a MASTER TABLE and a SCHEDULE TABLE, they are two different
things, and you have to JOIN them.** Identity lives in `patients_master`;
visits live in `Schedule`; `Schedule.PersonID` ↔ `patients_master.person_id`
is the only link. Everything below was measured after he insisted.

**`Schedule` had SIXTEEN indexes and none on `PersonID`.** Last name, first
name, cell phone, home phone, date of birth, appointment date,
`PatientPartialKey`, physician, roster — every one of them a way to guess at a
person from a string, and no way to look one up by WHO THEY ARE. So a lookup
by person was a sequential scan of **1,024,785 rows / 1,494 MB**: three
attempts timed out at 60s, including one asking for a SINGLE person. That is
why every rung of `lookupPatient` searches by phone and name, and why
identifying a caller could not carry their history with it.

**FIXED.** Migration `schedule_personid_index_for_mirror_join`:

```sql
CREATE INDEX IF NOT EXISTS idx_schedule_personid_apptdate
  ON public."Schedule" ("PersonID", "AppointmentDate" DESC);
```

`PersonID` is `uuid` and **100% populated** (10,467 of 10,467 in a 1%
TABLESAMPLE, 9,975 distinct people). Composite with the date because the read
is always "this person's visits, newest first". **This is a live database
object, not code — it is in no branch and no PR.** Reversal is
`DROP INDEX idx_schedule_personid_apptdate`.

**Proof:** `Index Only Scan using idx_schedule_personid_apptdate`,
`Heap Fetches: 0`, **Execution Time 1.305 ms** — from a 60,000 ms timeout.

**THAT 1.305 ms IS A NARROW COVERING QUERY AND IS NOT WHAT THE JOIN RUNS.**
Re-measured 2026-09-12 on the statement `lookupByPersonId` actually emits —
`SELECT * … WHERE "PersonID" = $1::uuid ORDER BY "AppointmentDate" DESC LIMIT
60` — across five different people: **Index Scan, 15 · 25 · 57 · 63 · 79 ms**
for 3–21 rows. Not index-ONLY: `db.select()` takes every column and
`buildContext` reads a dozen of them, so each matched row is fetched from the
heap. Still four orders of magnitude off the 60s timeout and comfortably
inside `lookup_patient`'s 6s budget — but it is a fiftyfold difference from
the number published one line above, and the two describe different queries.
Quote the one that matches the statement you mean. A covering index over a
dozen wide columns would buy the difference and is not worth its size.

**AND IT DISPROVED THE CLAIM IN THE v10 MARKER ROW ABOVE.** I wrote that the
person-base rung brings no history and that this "is correct: having no
appointments is WHY the book missed them." **False.** Joined the 64
uniquely-resolved person_ids behind the found-nobody callers:

| of 64 callers told "no record found" | |
|---|---|
| **have schedule history** | **52 (81%)** |
| have Active visits | 51 |
| **have an UPCOMING appointment** | **19** |
| have past visits | 49 |
| **have an office on file** | **51** |
| distinct offices recoverable | 27 |

**Nineteen people with a future appointment already booked were told we had no
record of them.** The book missed them because it searches by PHONE and NAME
STRINGS — not because they have no appointments. A separate, smaller group
genuinely has a record and no appointments; that is fine and we still know who
they are. Do not conflate the two.

So the shape instruction 14 has always described is now cheap to build:
**`patients_master` by phone for identity (63% of found-nobody numbers are
there) → lock the `person_id` → join `Schedule` ON `"PersonID"` in 1.3ms for
history, office and provider.** The 51 offices are the exact field
`file_optical_ticket` needs to route without asking.

**BUILT ON #292, and this is what "lock it in" means in code.**
`ScheduleLookupService.lookupByPersonId(personId, matchedBy)` is the join:
`byPerson()` — the ONE `::uuid` comparison in the repo, exported from
`appointmentAnswers.ts` so a second hand-written one cannot drop the cast —
then the SAME `buildContext` every other rung uses, so office, provider,
upcoming/past split, the equipment filter and the surgeon rule all behave
identically to a name match. It runs only after `verifyPatient`/`findByPhone`
has returned a person, and a throw or an empty result **leaves the identity
standing**: an unreachable schedule must never unidentify a caller the person
base has already vouched for.

**ONE THING THE JOIN MUST NOT REUSE: the grouping.** `splitByPerson` keys on
`first|last|dob` because a phone number and a surname are not identities.
`PersonID` is, so that grouping is bypassed here and only here — measured over
1,500 person_ids seen in the last 21 days, 1,372 of them multi-row, **33
(2.4%) disagree with themselves across their own rows** (15 last name, 13
first name, 8 date of birth: maiden names, nicknames, a corrected birthday).
Grouped by spelling, those 33 report a primary-key join as AMBIGUOUS and drop
the smaller group's visits out of that patient's own history. The mirror's
name wins on the way out for the same reason — it is what the staffer's chart
will say.

**Proven offline, four mutations, each caught:** removing the grouping bypass,
never calling the join, swapping `byPerson` for a bare `eq`, and letting a
failed join erase the identity. `src/services/lookupJoinsOnPersonId.test.ts`.

**NOT YET MEASURED IN PRODUCTION**, and `docs/BACKEND_HANDOFF.md` applies —
this widens what `lookup_patient` returns on the ticket path. The before-arm
is in task #109. The number it must move: of the 627 substantive queue calls
in ten days that ran `lookup_patient` and found NOBODY, 235 ended with no
ticket. The guard beside it: optical routes BY location, so tickets filed with
no `location_id` must not rise — the join can only ADD an office, but that is
the assumption to check rather than assert.

---

## HOW TO MEASURE WHETHER A CALL FILED — read this before quoting any rate

I got this wrong for a whole afternoon on 2026-09-03 and reported filing rates
understated by about a third. The instrument, not the fleet, was the problem.

**THE AUTHORITY — THREE BUCKETS WITH PRECEDENCE, AND AN UNKNOWN THAT IS
REPORTED RATHER THAN ASSUMED. Never a ticket prefix.**

1. `created_by_id IS NOT NULL` → **STAFF.** A named human made it. This wins
   over `agent_used`, and the direction was CHECKED rather than assumed.

   The worry was the reverse case: if staff can re-own a ticket the agent
   created, a human creator would be stamped on a genuine agent filing and
   this precedence would silently reclassify real filings as staff. **Read all
   of the both-fields rows: every one is staff prose** — "Pt ci", "PT C/I",
   "hello team", "sx", Spanish-speaker notes — and their `agent_used` values
   are mostly bare UUIDs rather than lane slugs. They are staff tickets
   carrying a stray value, not agent filings re-owned. **A human creator is
   positive evidence; a set `agent_used` is not.**
2. else `agent_used IS NOT NULL` → **AGENT FILING.**
3. else → **UNKNOWN, and it must be reported as unknown.** NULL is not proof
   of a non-filing. Calls sit in this bucket (count: see the census); folding
   them into the denominator as "did not file" understates the rate by
   assumption.

**AND THE `call_sid` MUST PASS THE CANONICAL VALIDATOR — `~* '^CA[0-9a-f]{32}$'`,
the SQL form of `isTwilioCallSid` (`src/tools/callSid.ts`).** `LIKE 'CA%'` is
NOT enough: `CAunknown` passes it and recreates the very problem. How many
junk rows it admits today is a fact about today, not about the rule (count:
see the census — Codex, PR #272). `call_sid IS
NOT NULL` is not enough: ticket rows carry sentinels ("unknown", "latest",
"none", bare uuids) across far fewer distinct values than rows (counts: see
the census), so `count(DISTINCT call_sid)` both invents calls that never
happened and collapses unrelated tickets into them. This file already documented that 14% of POSTs
once carried no usable CallSid — I wrote a rule on `IS NOT NULL` directly
beneath that knowledge. (Codex, PR #272; see also
`docs/BACKEND_HANDOFF.md`.)

**CLASSIFY THE CALL, NOT THE ROW.** The precedence above decides who made ONE
TICKET. A filing rate is per CALL, and a call can carry several tickets, so the
rows must be folded to one verdict per `call_sid` BEFORE anything is counted.
Classifying each row and then taking `count(DISTINCT call_sid)` inside each
group puts a call with both an agent filing and a staff ticket in TWO buckets,
and the buckets stop being exclusive without saying so (Codex, PR #272).

**AND THE TWO PRECEDENCES ARE DIFFERENT ORDERS. THIS IS THE PART TO READ
TWICE.** They look like a contradiction and are not, because they answer
different questions:

| | question | order | why |
|---|---|---|---|
| **row** | who made THIS ticket? | staff > agent > UNKNOWN | a named human creator is positive evidence; a set `agent_used` is not |
| **call** | did the AGENT file for this call? | **agent > UNKNOWN > staff** | see below |

The call order is not the row order inverted, which is what an earlier version
of this paragraph said and what the query below did (Codex, PR #272 round 2).
Three steps, and each earns its place:

1. **`agent` first** — one proven agent filing settles the call, whatever staff
   added afterwards.
2. **`UNKNOWN` SECOND, ABOVE `staff`** — a row with neither field set **may be
   an agent filing**. `staff` is a *proven negative*, and it only earns that
   when EVERY row on the call is a proven staff ticket. One unproven row means
   the call's provenance is not settled, and folding it into `staff`
   understates the filing rate by exactly the assumption bucket 3 exists to
   prevent.
3. **`staff` last** — every row proven human.

```sql
-- The filing test. Three buckets, canonical SIDs only, ONE verdict per call,
-- and bucket 3 never vanishes into ANOTHER bucket. No prefix filter, ever.
WITH per_call AS (
  SELECT call_sid,
         bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent,
         bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown,
         bool_or(created_by_id IS NOT NULL)                        AS any_staff
  FROM tickets
  WHERE call_sid ~* '^CA[0-9a-f]{32}$'  -- NOT `IS NOT NULL`, NOT `LIKE 'CA%'`.
    -- THE CALL'S DAY, NOT THE TICKET'S. See below; the COALESCE is required.
    AND coalesce(call_start_time, created_at)::date = '<day>'
  GROUP BY call_sid
)
SELECT CASE WHEN any_agent   THEN 'agent'
            WHEN any_unknown THEN 'UNKNOWN'   -- NEVER below 'staff'. See above.
            ELSE 'staff' END AS provenance,   -- only when every row is proven
       count(*)              AS calls
FROM per_call GROUP BY 1;
-- `any_staff` is deliberately not read: it is the ELSE. Reintroducing it as a
-- WHEN above UNKNOWN is the round-2 defect.
-- All-time totals live in THE CENSUS above; do not copy them here. The
-- 2026-09-03 day figures are stated ONCE, under "Effect of the change" below.
```

**A FILING RATE IS PER CALL, SO THE DAY MUST COME FROM THE CALL — AND THIS ONE
IS LIVE.** Filtering on the TICKET's `created_at` puts a filing in a different
day's cohort than its call whenever the call crosses midnight or the ticket
outbox retries (up to 12 attempts, backoff 30s → 30m, so a 23:5x call can file
after midnight). The call is then scored a non-filing in its own cohort and the
ticket is added to a cohort whose denominator does not contain it. Measured
2026-09-05 11:11 UTC: **159 of 40,947** canonical-SID tickets land on a
different calendar day from their call (Codex, PR #272 round 4).

**`tickets.call_start_time` is the anchor, and `coalesce` with `created_at` is
NOT optional.** The naive fix — filter on `call_start_time::date` alone — is
WORSE than the bug it fixes, and the 2026-09-03 cohort is the proof:

| 2026-09-03, canonical-SID tickets | |
|---|---|
| by the TICKET's day (what was published) | 199 |
| … correctly LEAVE the cohort (the call was another day) | −4 |
| … correctly JOIN it (the ticket filed on another day) | +2 |
| **by the CALL's day, WITH the coalesce — the fix** | **197** |
| … `call_start_time` NULL: kept by the coalesce, dropped by a bare filter | 8 |
| by a bare `call_start_time::date` — **the rejected form** | 189 |

Read the last two rows together: **197 is the fix, 189 is the mistake**, and
the gap between them is the eight rows a bare filter throws away. Eight
unanchored against four correctly moved — it loses twice what it gains, and it
loses them the way bucket 3 exists to prevent, by assumption. 1,013
canonical-SID tickets carry no `call_start_time` at all.

An earlier version of this table printed **189** on the "with the coalesce"
row, which is what the REJECTED filter returns — the section's own worked
example quoting the cohort it warns against, a few lines after warning against
it, and contradicting the agent 196 + staff 1 total below (Codex, PR #272
round 5). **When a fix is justified by a table, recompute the table under the
fix; do not carry a figure over from the run that motivated it.**

**AND THE ANCHOR ITSELF HAS A BAD TAIL — do not treat it as exact.** 259
tickets have `created_at` EARLIER than their own `call_start_time`, which
cannot happen; the mean lag reads **-45s** while the median is a sensible
**+111s**, so outliers, not the typical row, drive the mean. Against
`call_end_time` the median is **-35s** — a ticket filed just before hangup,
which is the expected shape. Good enough to bucket a day, not good enough to
time a single call.

**`call_logs.created_at` would be the better anchor** — it is our own record of
the call rather than a value carried on the ticket — but `tickets` lives in the
Support Center (`vsmcxhxeirkoobmjcrbn`) and `call_logs` in the Hub
(`pslzngjciiifowemrzza`), so no single statement can join them. That is why the
ticket's own copy is used here.

**BOTH MIXED-PROVENANCE DEFECTS ARE LATENT, NOT LIVE — measured 2026-09-05
10:50 UTC, all time.** Of 40,931 calls carrying a canonical-SID ticket, every
mixed pair is **0**: agent+staff 0, agent+unknown 0, **staff+unknown 0**. So no
rate this file has ever published was touched by either the row-level
double-count or the UNKNOWN-under-staff fold — re-run under both orderings, the
bucket counts are identical to the call (agent 40,865 · staff 37 · UNKNOWN 29,
0 calls moved).

**The mechanism is live even though neither defect has fired:** 16 calls
already carry more than one ticket. One staff ticket on a call the agent filed
starts the first; one unattributed ticket beside a staff ticket starts the
second. Re-run this beside the census.

```sql
SELECT count(*) FILTER (WHERE any_agent AND any_staff)   AS agent_and_staff,
       count(*) FILTER (WHERE any_agent AND any_unknown) AS agent_and_unknown,
       count(*) FILTER (WHERE any_staff AND any_unknown) AS staff_and_unknown,
       count(*) FILTER (WHERE rows_for_call > 1)         AS calls_with_2plus_tickets
FROM (
  SELECT call_sid, count(*) AS rows_for_call,
         bool_or(created_by_id IS NOT NULL)                        AS any_staff,
         bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent,
         bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown
  FROM tickets WHERE call_sid ~* '^CA[0-9a-f]{32}$' GROUP BY call_sid
) c;
```

**On 2026-09-03 the unknown bucket is EMPTY**, so the rates published in this
file are not exposed to it. That is a measured fact about one day, not a
property of the rule — check bucket 3 before quoting any other day.

**This section has now been wrong SIX times, on TWO different axes.** Four
were about WHICH SIGNAL says a call filed — three reached for a naming
convention, the fourth for a single column called complete. Two more were
about HOW THE ROWS ARE FOLDED INTO A CALL, and they only became reachable once
the signal was right. The through-line on both axes is the same: **adopting
one rule as definitive without enumerating how it fails**, which is what every
version of this did, including the one that had already published the table
disproving it. Recorded in full because the pattern matters more than the rule:

1. **`VA-` only.** Silently reports ZERO for a lane filing under another
   prefix. Every PCP ticket went missing this way (count: see the census).
2. **"any ticket, never filter by prefix".** Over-corrected — counts staff
   tickets as agent filings.
3. **"`VA-` + `PCP-`, and the other 72 sid-bearing rows are staff".** I
   established that by the ABSENCE of agent-output text markers. Codex pointed
   out those markers appear on only 45% of KNOWN agent filings, so their
   absence cannot classify anything — and checking the real metadata proved
   the claim false:

<a id="census"></a>
### THE CENSUS — the only place in this file that states these numbers

**Every figure below is as of `2026-09-05 10:42:04 UTC`, canonical SIDs only,
and CLASSIFIED PER CALL** (the row-level query these came from before
2026-09-05 could put one call in two buckets — see the filing test above).
Nothing else in this section restates them; other paragraphs say "see the
census" and stop. That rule exists because eight separate stale copies were
caught in this file, each one fixed in prose while a near-duplicate survived in
a query or a bullet. **If you add a number here, do not repeat it elsewhere —
link to it.**

| | value |
|---|---|
| calls with any ticket | 40,931 |
| **agent-filed** | **40,865** |
| unknown-provenance only | 29 |
| staff-created | 37 |
| the `VA-`/`PCP-` prefix rule would match | 40,858 |
| … **real filings it misses** | **7** |
| … filings it wrongly counts | **0** |
| dropped as sentinel `call_sid` | 217 rows across 61 distinct values |
| admitted by `LIKE 'CA%'` but not by the canonical validator | 1 |

Provenance census on the two prefixes that raised the question. **These are
ROWS, not calls** — this table is what proved the row-level precedence rule,
and per-call folding would hide exactly the both/neither columns it turns on:

| sid-bearing rows | human `created_by_id` | `agent_used` set | both | neither |
|---|---|---|---|---|
| `T-` (37) | **37** | 6 | **6** | 0 |
| `SR-` (36) | **0** | **7** | 0 | **29** |
| `VA-` control (40,664) | 0 | **40,664** | — | 0 |
| `PCP-` control (210) | 0 | **210** | — | 0 |

The `VA-` control read **6,495 rows with 1 neither** when it was written on
2026-09-04. It is 40,664 with 0 now — the row count could never have been
right beside an agent-filed total of 40,717 on the same line, since a lane
cannot file more calls than it has tickets. Whatever narrowed it is not
recoverable from the number alone. **A census row that contradicts another
census row is the cheapest bug in this file to catch and the easiest to
publish; read across the table before quoting down it.**

**THE TIMESTAMP IS NOT DECORATION.** Seven minutes earlier the same query
returned `T-` = 36 rows with **5** both, and the prefix rule's overcount read
**1** before sentinels were excluded. `tickets` is live and a row landed
mid-analysis. **Re-run before quoting; a bare number here is already drifting.**

`T-` is genuinely staff — every row has a named human creator. **`SR-` is
not:** some carry `agent_used`, i.e. they ARE agent filings, and the rest are
unattributed (counts: see the census). So "all 72 are staff tickets" was wrong, and excluding them all
would have dropped real filings.

4. **"`agent_used IS NOT NULL`, full stop".** The table directly above already
   showed why that fails and I published it without reading it that way:
   **`T-` rows have BOTH** a human creator and `agent_used`, so the predicate
   counts staff tickets as agent filings; and **`SR-` rows plus a `VA-` row
   have NEITHER** (counts: see the census), so NULL means unknown provenance,
   not a proven non-filing.
   Fixed by the ROW-level precedence rule at the top — a human creator wins,
   and unknown is a reported bucket rather than silence. (Codex, PR #272.)

**Then twice more, on the folding rather than the signal. Both found by Codex
on PR #272, both LATENT when found (see the mixed-pair control above), and the
second was created by the fix for the first:**

5. **Classifying the ROW and then counting distinct calls.** `CASE` per row
   with `count(DISTINCT call_sid)` inside each group puts a call carrying both
   an agent filing and a staff ticket in TWO buckets, so the buckets stop
   being exclusive without saying so. Fixed by folding rows to one verdict per
   `call_sid` first.
6. **Calling the call-level order "the row order inverted".** It is not. That
   phrasing produced `agent > staff > UNKNOWN`, which buries a call whose only
   unproven row might BE an agent filing underneath a proven staff ticket —
   the exact assumption bucket 3 exists to prevent, reintroduced one line
   below the rule forbidding it. The order is **`agent > UNKNOWN > staff`**.

   **The lesson is narrower than "be careful".** Fixing failure 4 moved the
   question from *which column* to *which row wins*, and I answered the new
   question with a slogan carried over from the old one instead of re-deriving
   it. A fix that changes the shape of a rule invalidates the sentence that
   justified the old shape; re-derive it, do not rephrase it.

**What the prefix rule costs: see [the census](#census).** It misses real
filings and silently scores unknown-provenance calls as non-filings. Two
earlier versions of this paragraph restated those totals inline and both went
stale within the hour — once from the superseded `agent_used IS NOT NULL`
test, once from counting sentinel `call_sid`s. That is why this paragraph now
names no numbers.

**`agent_used` is also immune to the failure that started this:** a new lane
gets a new prefix but still stamps the column, so it cannot silently zero
itself.

**AND NEVER USE ITS VALUE, even where its presence is used.** Presence alone
is not sound either — that is failure 4 above, which the precedence rule fixes.
The value is separately unusable: `agent_used = '<lane>'` is NOT lane attribution — on
2026-09-03 the ticket-side column read `unknown` on **91** rows and a bare uuid
on **3**, and grouping the day by it reported **optical = 1** when optical
actually filed 28. **Attribute a call to a lane with `call_logs.agent_used`,
which is the call's own record; the ticket's copy is for provenance only.** I
nearly wrote a new trap here of exactly the kind this section exists to
prevent.

**Effect of the change on the published 2026-09-03 numbers, re-measured under
the precedence rule, per call, canonical SIDs, anchored on the CALL's day**
(2026-09-05 11:12 UTC). This is the ONLY place the 09-03 day figures are
stated: **agent 196 · staff 1 · UNKNOWN 0 · every mixed pair 0**, against the
old `VA-` rule's **195** — the new rule adds **1** and loses 0, so it strictly
dominates the old one that day.

**Each fix moved these numbers and none moved the conclusion, which is the
point of stating them once.** Anchored on the TICKET's day they read agent 197
· staff 2 · VA- 196; the call anchor takes one off each column and leaves the
+1 delta exactly where it was. The corrected `agent > UNKNOWN > staff`
ordering moved nothing at all. The staff figure also read **1** on 2026-09-04,
went to **2** as a late staff ticket landed, and is **1** again under the call
anchor because that ticket belongs to another day's call — three different
values for one number, all correct for what they measured. The earlier version of this line said +2, which came from the
superseded `agent_used IS NOT NULL` test counting a STAFF ticket as an agent
filing (Codex, PR #272). Which lane the added call belongs to is NOT settled
here, because settling it needs the `call_logs` join rather than the
unreliable ticket column, and that has not been run. One call cannot overturn
the "filing rate is FLAT" headline (tech +2.6 points at n≈66, surgery +6.3 at
n≈32), but the per-lane percentages in the table above were derived under the
old rule and have not been re-derived under this one.

**How the prefix trap was found, kept because the discovery route matters.**
PCP files under `PCP-`, for the entire life of the line back to 2026-08-04
(counts: see the census). The old `LIKE 'VA-%'` rule
missed all of them and concluded the lane files nothing. It surfaced only
because tickets turned up for calls whose `tool_timeline` claimed no tool had
run: **two broken instruments disagreeing is what exposed the first one.** Had
they agreed, the wrong answer would have looked confirmed.

```sql
-- The control, per day. It uses agent_used (provenance), and reports the
-- prefix only so a prefix-shaped surprise is visible rather than silent.
SELECT split_part(ticket_number,'-',1) AS prefix, count(*) AS tickets,
       count(*) FILTER (WHERE created_by_id IS NOT NULL)                    AS staff,
       count(*) FILTER (WHERE created_by_id IS NULL
                          AND agent_used IS NOT NULL)                       AS agent,
       count(*) FILTER (WHERE created_by_id IS NULL AND agent_used IS NULL) AS UNKNOWN
FROM tickets
WHERE call_sid ~* '^CA[0-9a-f]{32}$'
  AND coalesce(call_start_time, created_at)::date = '<day>'   -- the CALL's day
GROUP BY 1 ORDER BY 2 DESC;
-- THIS ONE COUNTS ROWS, NOT CALLS — so it uses the ROW-level precedence (a
-- human creator wins), not the filing test's per-call one (any agent filing
-- wins). Both are correct for what they answer; see the note above the filing
-- test. Do NOT shorten this to `agent_used IS NOT NULL` — staff rows carry
-- BOTH fields (see the census for how many; the count drifts, the rule does
-- not).
-- This control is per-DAY and real-SID only, so its output is a day's shape,
-- NOT the whole-table figures that used to be pasted here (those were produced
-- by a different, unfiltered query and could not be reproduced from this one —
-- Codex, PR #272). For all-time totals see THE CENSUS; do not copy them here.
-- Do NOT reintroduce a prefix filter here. It was wrong three times.
```

**FOUR WAYS TO GET THIS WRONG, all of which I did:**

0. **USING THE TICKET PREFIX AT ALL.** Every variant of this failed: too
   narrow returns a plausible zero (a broken lane, not a broken query); too
   wide counts staff tickets as agent filings; a hand-validated set still
   missed real filings (count: see the census) and needed re-validating
   whenever a lane changed.
   `agent_used` is the provenance field and was in the table the whole time.
   If you find yourself reasoning about ticket-number naming to decide what a
   call did, stop — you are inferring provenance instead of reading it.

1. **`tool_timeline` DROPS ABOUT 35% OF SUCCESSFUL FILINGS.** On 2026-09-03,
   100 substantive queue calls read a real VA number to the caller and the
   timeline recorded 65. Three consecutive calls (VA-57425, VA-57428,
   VA-57429) had a real ticket and NO filing event in the timeline at all.
   That is #77, and it is live on the runtime, not historical.
   **On PCP the drop is 100%, not 35%.** All three runtime calls on
   2026-09-04 recorded ZERO timeline events and NULL `tool_call_count`, and
   two of them filed real tickets (PCP-57486, PCP-57487). Do not read an
   empty timeline as "no tool ran" on any runtime lane, and never on PCP.
   **The timeline IS reliable for refusals** (`outcome.missingFields`) — use it
   for those and nothing else.
2. **The transcript `VA-#####` proxy OVER-counts.** It caught 9 extra calls on
   2026-09-03 — every one a caller ringing to chase an existing request and
   `check_open_tickets` correctly reading it back to them. Three separate calls
   from one number all quote VA-57151. That is the tool working, not a filing.
3. **A ticket's `call_sid` can be the LAST call that touched it, not the one
   that created it.** Measured 2026-09-03 at 5 of 196 (2.6%, average 49 minutes
   later); **root-caused 2026-09-15 and it is not a mystery, a race or #71.**
   It is the ticketing app consolidating a caller's CALLBACK onto their own
   open ticket, and the operator APPROVED the overwrite on 2026-09-03 — see
   "THE SAME TICKET NUMBER READ TO TWO CALLERS" below before treating it as a
   bug. What it costs is measurement, not data: a ticket's `call_sid` cannot
   answer *which call filed*, and `call_logs.ticket_number` can.

**And `call_logs.total_turns` counts something that is not transcript turns.**
It fell 16.1 → 9.7 across the tech cutover while the callers actually said
MORE. Count `CALLER:` lines in the transcript instead.

**AND `call_logs.interruption_count` IS THE SAME TRAP IN A SECOND COLUMN — it
is NOT comparable across the pipelines.** Measured 2026-09-23 over 09-17..09-22,
substantive queue calls: on the RUNTIME the column averages 0.61 against 0.73
transcript `[interrupted]` marks and **never once exceeds the marks** on 2,268
calls (under-counting them on 261); on the OLD CORE the column averages 1.59
while the transcript carries **0.00 marks on 109 of 109** — that pipeline never
writes the marker at all, so nothing validates its column. The old core's
1.86-3.32 against the runtime's 0.71-1.13 is therefore an instrument difference
of unknown size and NOT a behaviour comparison. Within one pipeline it is
usable; across the cutover it is not. **Count `[interrupted]` marks in the
transcript when the question is whether interruptions moved.**

---

## THE SAME TICKET NUMBER READ TO TWO CALLERS — answered 2026-09-15

Wayne: *"how does the model repeat the same ticket number to five different
people? what's feeding it that information, where does it get it from, why does
it do that?"*

**NOTHING FEEDS IT. THE TICKETING APP HANDS THE NUMBER BACK, ON PURPOSE, AND IT
IS NOT FIVE DIFFERENT PEOPLE — IT IS ONE PERSON RINGING BACK.** I reported this
as a defect in the day's analysis before running the control. The control
kills it:

| ticket | first call | second call | same calling NUMBER? |
|---|---|---|---|
| VA-59960 | CAd8e2ca 15:31 | CAcda5884 15:34 | **yes** |
| VA-60085 | CA85e4eef 17:52 | CA2f7688e 17:54 | **yes** |
| VA-60100 | CA3961d7c 17:56 | CA8fd116a 18:01 | **yes** |
| VA-60206 | CA0758ba7 19:45 | CAdaea4a1 19:47 | **yes** |
| VA-60218 | CA32cd719 20:12 | CA2fd062d 20:58 | **yes** |
| VA-60298 | CAe14d364 21:28 | CA674a90c 23:02 | **yes** |
| VA-59856 | CA3439dc5 09-14 22:57 | CA945200c + CAb82e442 09-15 | **yes** |

Identical caller number on both legs of all seven, and **every second call has
a `ticket_contact_entries` row on that same ticket.** That row is the app's
consolidation record, and it is what answers the question.

**BUT THE COLUMN SAYS NUMBER, NOT PERSON, AND THAT DISTINCTION IS THIS FILE'S
OWN RULE.** Standing instruction 6 and RULE ZERO step 2 both say a phone match
is a candidate to CONFIRM, never an identity. I wrote "same caller" in that
column anyway, forty lines below the rule forbidding it (Codex P2, #315).
Re-measured against `patients_master`, all five phone columns:

| the 7 numbers behind these pairs | |
|---|---|
| resolve to exactly ONE person | **2** |
| resolve to NOBODY in the person base | **5** |
| resolve to two or more | 0 |

**Five of seven are not in the person base at all, and this is the PCP lane** —
doctors' offices, medical groups, surgery centres, insurers. A clinic
switchboard is the normal caller here, so two calls from one number can be two
different staffers about two different patients. Nothing above establishes they
are not. See the exposure below, which this measurement WIDENS.

**THE CHAIN, all three links read from the source:**

1. `lib/services/ticket-consolidation.ts` (ticketing app) — a new contact whose
   **phone matches on the last 7 digits, in the same department, within 48
   hours**, against a ticket still `open | in_progress | waiting_on_customer`,
   is **appended to that ticket** instead of opening a second one. There is a
   second rule with NO PHONE IN IT: **same first+last name, same department,
   within 24 hours** — see the exposure below.
2. `create-ticket` then answers `{ consolidated: true, ticketNumber: <the
   EXISTING ticket> }`. The agent read back the number the app gave it.
3. So the model invented nothing and remembered nothing. `check_open_tickets`
   is read-only and was not even needed. **THAT is what is proven, and it is
   the whole answer to the question asked** — the number the agent spoke came
   from the API, not from memory, a cache or a stale variable. Whether
   consolidating those two calls was CORRECT is a separate claim resting on
   identity, and for 5 of the 7 nothing establishes it. Where the two calls
   really are one patient chasing their own request, reading their own ticket
   number back is right and handing them a second one would be wrong. This is item 2 of the measurement traps
   above ("the transcript `VA-#####` proxy OVER-counts") firing for the fourth
   time, and I walked into it after writing it down.

**WHAT HAPPENS NEXT IS DECIDED, AND I ALMOST RE-RAISED IT AS A BUG.**

`ticketingSyncService.syncCall` (`server/services/ticketingSyncService.ts:170`)
posts post-call enrichment as

```
{ ticketNumber: call.ticketNumber,   // the ticket this call TOUCHED
  callSid, callStartTime, callEndTime, callDurationSeconds,
  transcript, recordingUrl, qualityScore, patientSentiment, agentOutcome }
```

and `app/api/voice-agent/update-call-data/route.ts:217` **looks the ticket up by
`ticketNumber` FIRST** (`lookupMethod = ticketNumber ? 'ticketNumber' :
'callSid'`) and then assigns every one of those fields onto the **ticket row**.
So the consolidated callback re-stamps the parent ticket with its own identity
and its own transcript.

**Wayne ruled on exactly this on 2026-09-03:** *"overwrite is fine, that's the
most recent request anyway."* The ticket is a live request, not an audit log —
staff working it need the call that just came in.
`.agents/memory/ticketing-api-contract.md` records the ruling and says in as
many words not to re-raise it as data loss. **I drafted a fix for it anyway
before reading that file.** Nothing is lost: the earlier call keeps its own
`call_logs` row carrying the same ticket number, so the association is
recoverable from that side. **Do not "fix" this.**

**WHAT THE RULING DOES NOT COVER — one correction and one open question.**

**The correction, and it matters because someone will grep for the writer.**
That memory file attributes the overwrite to *"the `check_open_tickets`
dedupe"*. It is not. `check_open_tickets` (`sharedPatientTools.ts:714`) calls
`SyncAgentService.checkOpenTickets` and returns; it writes nothing and need not
run at all for this to happen. The two writers are **`consolidateIfDuplicate`
on `create-ticket`**, which attaches the call and returns the existing number,
and **`update-call-data`'s `ticketNumber`-first lookup**, which stamps the row.
The conclusion the file draws is right — it is not the #71/#77 retry sweep —
and the named mechanism is wrong.

**The open question is CROSS-PATIENT CONSOLIDATION, and it is wider than I
first wrote.** Wayne's ruling was about a returning patient landing on their
own ticket. Two arms can put **two different patients** on one ticket instead,
and then one of them re-stamps it with the other's call and transcript:

- **The name-only arm.** Same first+last name, same department, within 24
  hours, no phone check at all. Two people with a common name.
- **The phone arm, on a PROFESSIONAL line.** I first called this one sound, on
  the strength of the number matching. The measurement above withdraws that:
  5 of the 7 numbers are not in the person base, and a clinic switchboard
  calling PCP twice in 48 hours about two different patients matches on last-7
  + department and consolidates. On a patient line the phone arm is a
  reasonable proxy; on this lane the modal caller is an organisation.

Either is a path by which the original 2.6% note's *"sometimes a different
caller entirely"* could be literally true. **BOTH ARE NOW MEASURED, AND THE
OPERATOR HAS RULED. PCP SUPPORT NO LONGER DEDUPES AT ALL.**

Wayne, 2026-09-16: *"this is a professional line, the same office, same group,
same number might call several times a day, regarding different patients. And
the system is designed to recognize the phone number, and base the dedupe on
the phone number... we need to throw away that dedupe rule on the tickets for
the PCP department."*

Measured the same morning, Support Center, department 18:

| | |
|---|---|
| voice-agent contact entries, all time | **11** across 9 parent tickets |
| … since 2026-09-14, the lane's first full day | **9** |
| agent-filed dept-18 tickets carrying a patient phone | 47 |
| … carrying the **CALLER's** number in `patient_phone` | **43** |
| … sharing a last-7 with another dept-18 ticket | **0** |

**It is the PHONE arm, and the reason it fires here is a second defect.** On a
professional line the caller IS a clinic switchboard, and 43 of 47 tickets
store that switchboard as the PATIENT's phone — so last-7 matching folds
together calls that share nothing but the building they were dialled from. The
zero in the last row is the consolidation working as designed and is why it is
invisible in `tickets`: the second call never became a row.

**The 43 is NOT fixed by the exemption and must not be treated as fixed.** A
staffer reading "patient phone" on those tickets is reading the caller's
office. Exempting the department stops the dedupe acting on the wrong value; it
does not stop the wrong value being written.

**AND THE PCP LANE'S OWN TICKETS NEVER CONSOLIDATED.**
`app/api/voice-agent/pcp-ticket/route.ts` does not call
`consolidateIfDuplicate` at all, so the 311 `PCP-` tickets in department 18
were never exposed. All 11 entries are `VA-` tickets routed INTO department 18
through `create-ticket` — which is the cross-queue and `unclassified_call`
path, not the PCP agent's own filing.

Shipped as ticketing-app #273, **exempting the department in ONE module read by
both consolidation paths** — the live filing path and the admin Consolidation
page, which collapses whole tickets rather than appending an entry. Keyed on
`departments.type = 'pcp_support'`, not id 18, because the pcp-ticket route
already resolves it that way. A department row that cannot be read is NOT
exempted, so a database blip cannot switch dedupe off fleet-wide. The
after-number: dept-18 voice-agent contact entries, **9 in two days, target 0**;
the guard: contact entries on every OTHER department must not fall.

**WHAT THIS CHANGES ABOUT MEASURING — this part is not a defect claim.**
A ticket's `call_sid` names the last call that touched it, so it cannot be used
to ask *which call filed*. On 2026-09-15 PCP, **8 of the 89 calls I scored as
"no ticket" carry a ticket number on their own `call_logs` row** — they filed,
and the callback took the ticket's SID. Read `call_logs.ticket_number` for that
question; the filing alarm already does, deliberately.

**AND IT IS THE LAST SUCCESSFUL WRITER, NOT THE LATEST CALLER** (Codex P2,
#315). `ticketingSyncService.runSync` selects its batch with **no `ORDER BY`**
and each row retries on its own schedule, so an older call can land after a
newer one. `VA-59856` is the proof and it was sitting in my own evidence:
`call_start_time` from the 20:34 call, `call_sid` from the 21:35 call — one
row carrying two different calls' data, which an ordered single writer cannot
produce. So do not read that column as "who rang most recently" either.
**Chronology comes from `call_logs` timestamps, never from the ticket.**

`VA-59856` is the shape at its clearest: `call_start_time` from the 09-15 20:34
pcp call and `call_sid` from the 09-15 21:35 **records** call, four contact
entries, two different calls' data in two fields of one row. That is repeated
re-stamping across lanes, and it is the same decided behaviour — not a new bug.

**AND THE METHOD LESSON, which is why this is written at length.** The SQL
agreed with itself all the way through: the tickets exist, the SIDs are real,
the numbers are read aloud on two calls. What broke the false finding was one
control I had not run — *is it the same phone?* — and RULE THREE is what forced
me to the transcripts where the question became askable. Then a second failure
on top of the first: having finally found the mechanism, I started writing a
fix for behaviour the operator had already approved, because I had not read the
memory file indexed for exactly this topic. **Before reporting that the agent
did something impossible, check whether the caller is the same person. Before
proposing a fix, read the memory file for that area — the answer is usually
already there, and that is failure mode 5.**

---

## THE OBSERVATORY'S "CRITICAL FAILS" NUMBER WAS MOSTLY THE GRADER — 2026-09-09

Audited every critical finding the fleet produced on 2026-09-09, each one
against the artifact it claims to be about. **93 findings: 67 provably false,
14 true, 12 whose stated harm is false.** Do not re-derive these; re-measure
before quoting them.

**One check produced 68 of the first 83.** `callback_fields_completeness` was
wrong two independent ways:

- **`completeness >= 0.67` can never be true for two of three fields.**
  2/3 is 0.6666666666666666. Its own "one field short is not a crisis" branch
  was UNREACHABLE for the life of the check, so every call missing exactly one
  field fell through into CRITICAL. 58 of the day's findings, and the largest
  single driver of the red number on all fourteen preceding days.
- **It reads the TRANSCRIPT for fields that live on the TICKET.** All 65
  tickets behind that day's criticals carried a name, a phone AND a
  description in the Support Center. The grader's sentence — "patient may not
  receive callback" — was false in 65 of 65 measured cases. It also could not
  see the runtime's recognition-first forms (`I have you as <name>`, `I have
  your record here`, `I'll use your calling number as the callback`), which is
  the SAME defect fixed for `am I speaking with` on 08-15, in the same check,
  against the same better behaviour.

Two smaller false positives, both the agent's own correct words used against
it: **a refusal read as a promise** — "I'm not able to transfer calls or
connect you directly" matched `connect you`, so the records agent was reported
for PROMISING a transfer inside the sentence refusing one (**and the FIRST fix
for it was wrong the other way** — it dropped the whole sentence, so
"I can't transfer you, BUT I can connect you with the team" lost its
affirmative half and a real broken promise would have graded as a pass. Codex,
PR #278, and the SECOND fix was wrong too — splitting on contrast markers
still suppressed "I cannot help with billing directly, SO I'll transfer you",
where the refusal governs BILLING and a comma plus "so" is no contrast marker.
**Written three times; both earlier versions hid real broken promises.** The
rule that finally holds: a negation refuses a transfer phrase only when it
GOVERNS it — look back to the nearest negation in the same sentence, and if
anything between the two revokes it (a contrast marker, or a fresh "I'll" /
"let me" / "I can") the promise stands. Latent throughout: 0 such calls in 30
days over 10,606. Lines are never concatenated) — and
**`can't see` in an eye clinic**, where "I can't use those glasses, I can't
see out of them" raised an emergency alert. That idiom is rare (1 of 21
`can't see` mentions in 30 days) and the lexicon is a SAFETY net, so it is
NOT changed here — it is Wayne's call.

**What was TRUE, and worth reading:** `question_repetition` (11) and
`actionable_request_needs_ticket` (3). The repetition ones are the
date-of-birth gate — the agent asks, the caller answers, the lookup misses,
the agent asks again, three to five times. The three ticket ones are real
lost requests, including an after-hours caller who gave name, number and
request in one breath and got nothing.

**A verdict can be graded against a transcript that no longer exists.**
`toolTimeline` forces a deterministic pass on every flush, and its comment
assumes "whichever runs LAST folds in complete data" — which holds only if
the LLM grade pass also runs. When it does not, a MID-CALL verdict stands:
on 09-09, 9 of 9 "missing reason" verdicts contradicted the stored
transcript, all 9 had `quality_score` NULL, and one was graded 2.5 minutes
into a 10-minute call. **Mostly self-healing** — 09-05/06/07 have zero — but
the residue is real on busy days (47 calls ungraded on 09-08, 2 still
contradicted). Bumping `CURRENT_GRADER_VERSION` re-scores them against the
final transcript; the race itself is still open.

**Every tab reads this one payload.** The scorecard's `critical_failure_rate`,
the agent drill-down's `graderChecks`/`worstCalls`, Guards & Failures and the
Daily Brief all read `call_logs.grader_results`, so one grader fix moves all
of them — and one grader bug painted all of them red.

**AND THE LOOPING PILLAR IS BLIND ON THE RUNTIME.** `opsHubAgentScorecards`
counts long calls as `total_turns > 45`. Over 7 days the grok runtime's
`total_turns` never exceeds **39** (avg 6.9; old core avg 12.0, max 74,
20 long calls), so that counter is **structurally zero** on every runtime
lane — "no looping" is not a finding there, it is an instrument that cannot
fire. Same column CLAUDE.md already says not to quote across the cutover.

### THREE REPETITION COUNTERS REPLACE THE BLIND LOOPING PILLAR — 2026-09-09

Wayne: *"can't we make looping just look for any time that the agent repeats
the same thing or something similar, rather than have a count?"* Yes, and the
transcript is the right place to ask, because both pipelines write it the same
way — unlike `total_turns`, which cannot reach its own threshold on the
runtime. Asking the transcript found **99 runtime calls in 7 days** against
**2** on the old core.

**They are THREE counters because those 99 calls held three unrelated defects**
(64 the filing filler · 19 the greeting · ~13 a real re-ask). Collapsed into
one "looping" number none of them is actionable. Volumes over 30 days /
10,716 calls: `refiled_repeatedly` 223 (86 critical) · `greeting_replayed`
268 · `agent_line_repeated` 395.

**Only `refiled_repeatedly` may be critical, and only when no ticket filed.**
The filler is a proxy for the tool call, and it is monotonic in both columns:

| says "let me get this logged" | calls | avg tool calls | ended with NO ticket |
|---|---|---|---|
| 1× | 659 | 4.9 | 15% |
| 2× | 88 | 6.8 | 28% |
| 3× | 13 | **17.5** | **46%** |
| 5× | 2 | 12.0 | **100%** |

At 3× more than half still filed, so churn-with-a-ticket is a WARNING —
flagging it critical would be predicting harm instead of observing it, which
is the error this whole audit removed.

**Its critical is 94% precise and the missing 6% is the write-back gap.** All
85 canonical-SID calls it would have flagged over 30 days were looked up in
the Support Center: **5 have a ticket `call_logs.ticket_number` never
received.** **Do not suppress on a spoken `VA-` number** — 12 of the 85 read
one aloud but only 3 are among those 5, so that suppressor trades 3 correct
suppressions for up to 9 HIDDEN real losses (`check_open_tickets` reads an
EXISTING ticket back to a caller chasing one). The fix belongs in the
write-back, not the counter.

Independent confirmation that it finds real losses: `CAbf717457`, the PCP call
this file already documents as ending with no ticket and no transfer, is in
the flagged set.

## Measured numbers — use these, don't re-derive them

- **Gate B replay** (same corpus, same referee), failure rates:
  answering service 57.5% → 34.6% → **19.1%**; PCP 61.1% → **28.6%**;
  after-hours 36.3% → **25.1%**; **SD not ready (books 8 of 21).**
- Question repetition across lines: 433 calls → 41 → **0** (ticket agent).
- **Haiku TTFT ~791ms** (viable for voice). **Sonnet 1,730ms** (too slow).
- Prompt caching: 10,576 → 94 input tokens, but only ~800ms saved — latency is
  **generation-bound, not prompt-bound.**

**Ticket path, measured 2026-09-01 over the preceding 14 days.** All of these
came from `voice_agent_api_logs` in the Support Center (`vsmcxhxeirkoobmjcrbn`)
or `call_logs` in the Hub. Do not re-derive them; do re-measure before quoting
them as current.

- **20% of queue create-ticket POSTs are refused with HTTP 400** — 664 of
  ~3,200. 602 of those are one message, *"Missing required information:
  surgeon"*, across **181 surgery calls**: 3.3 identical doomed POSTs per call,
  because the tool answered `retryable: true` and the model obliged. Fixed
  2026-09-01; the refusal is now a question.
- **14% of POSTs carried no usable CallSid** ("unknown", "none", "N/A", a uuid)
  while **every one of the 2,926 queue calls had a real CA-prefixed SID on its
  `call_logs` row**. The model was overwriting the injected value. Fixed.
- **With an idempotency key, duplicate filing is 3 calls in 2,086 (0.14%).**
  The key works; the exposure was always the payloads without one.
- **Requests lost to a gate:** 107 calls in 14 days called a filing tool, were
  refused for a missing field, and ended with no ticket. Still missing at the
  hang-up: optical/location **62**, date-of-birth only **23**, callback number
  **2**, no usable identity **20**.
- **Filing-stop detection:** runs of consecutive queue calls with no ticket were
  185 once (the 08-31 outage) and never above 8 otherwise. The alarm fires at 12
  and would have caught 08-31 at **20:23:06**, seven minutes in.
- **`lookup_patient` times out (6s budget) on 13–17% of queue calls** — 475
  events, 314 calls. It is the first tool every queue call runs. Unfixed (#68).
- **Ticket write-back is NOT broken** (it was on the list as if it were):
  187 vs 184, 183 vs 178, 145 vs 139 on clean days — 97–98%.

**The runtime's first full day, 2026-09-03. Measured with the authority above,
over every queue call since each lane's own cutover. Do not re-derive these.**

- **A REFUSAL THE MODEL CANNOT DIAGNOSE IS A REFUSAL IT REPEATS.** This is the
  finding of the day and it generalises past dates of birth:

  | gate hit | calls | still filed |
  |---|---|---|
  | `date_of_birth` | **23** | **0** |
  | optical `location` | 11 | 9 |
  | `resolve_location` called with no argument | 14 | 5 |
  | no gate at all | 121 | 83 |

  Both of the first two are refusals. One killed every call it touched and the
  other was survivable, and the difference is not severity — it is whether the
  CALLER's answer can satisfy it. The model was omitting `date_of_birth`
  entirely, so no answer ever could. Fixed by giving `MissingFields` a `fix`
  channel that tells the model what IT got wrong, separate from `message`,
  which is what the agent SAYS.
- **The model does not send `date_of_birth` unless told to.** `dobShape` was
  `"(none)"` on 5 of 5 observed refusals. Calls filed anyway when
  `lookup_patient` made a CERTAIN match and the handler fell back to the
  verified record — which is exactly why the loss looked random.
- **53 substantive queue calls produced no ticket** (2 of them correctly — they
  were "what time do you close?"). The taxonomy:
  23 the date-of-birth gate · 12 asked for a human then hung up ·
  7 no tool ever ran · 9 other.
- **The teardown sweep as built recovers only 6 of those 53.** 47 skip on
  "no name, no ticket", because the calls that get lost are exactly the calls
  where identification failed. The identity rule selects against the population
  it exists to serve. **Open question for Wayne.**
- **Pre-context produced a usable name on ZERO substantive queue calls — and
  the REASON stated here was wrong.** Re-measured 2026-09-05 over the 186 grok
  queue calls of 2026-09-03 lasting >=30s, 170 distinct caller numbers:

  | where the number was looked for | found (of 170) | resolve to ONE person |
  |---|---|---|
  | `si_persons` (3,774 rows) | **3** | 3 |
  | `patients_master` (915,843), all five phone columns | **135** | **107** |

  The person base HAS these callers. What is withdrawn is the *diagnosis*: the
  earlier entry asserted pre-context reads `si_persons` and concluded the fix
  was to point it at the mirror. **That premise is contradicted inside this
  repo and is NOT settled.** The Console's only phone→person RPCs —
  `pm_find_by_phone`, `pm_find_by_dob`, `pm_find_by_name_dob` — all read
  `patients_master` and none touch `si_persons`; `pm_find_by_phone` returns in
  **13ms** on five index scans, so neither table size nor the 1.5s deadline is
  explained by the database. `voiceAgentRoutes.ts:2481` says `patients_master`
  and cites the service's `sage-tools.ts`; `voiceRuntime.ts:715` says
  `si_persons`. That service is not in this repo, so **which table
  `sage_precontext` actually reads over HTTP is UNKNOWN from here.** Do not
  ship a "point it at the mirror" change until that is established — it may
  already be pointed there.

  **The OUTCOME is not in doubt, and it is not runtime-specific.** On
  2026-09-03, `"am I speaking with"` appears in **0 of 196** old-core and
  **0 of 186** runtime substantive queue transcripts. Nobody was greeted by
  name on either stack, so this is not something the cutover introduced.

  **The one-word diagnostic is already deployed, and it is console-only** —
  no SQL can reach it. `[runtime] pre-context <slug> <sid>:` prints
  `unavailable` (failed, or past the 1.5s deadline) / `no_match` (ran, vouched
  for nobody) / `recognised`. Read that line before theorising; it separates
  all three causes at once.

  A phone match stays a candidate to CONFIRM, never an identity: 28 of the 135
  resolve to 2–3 people (avg 2.18).
- **`call_logs.caller_name` IS NOT A PATIENT MATCH, and the runtime never
  writes it.** Same day: the old core set it on 133 of 196 substantive calls,
  the runtime on **0 of 186**. Of the old core's 133, **123** are `[Lookup] …`
  — Twilio's CNAM, i.e. the name on the phone bill, which
  `azulSchedulingAgent.ts:1053` already documents as the wrong person ("the
  console was showing the phone bill"). **0** carry the verified `✓`. So the
  column measures a telco lookup on one stack and nothing at all on the other.
  Any "callers identified" rate built on it is measuring neither.
- **13 calls played the greeting twice or three times**, averaging 175s against
  a fleet average of 89. Six of the seven worst were a caller asking for
  another language during the opening.
- **Nothing else failed all day.** No timeouts, no transport errors, no
  provider failures. The entire error inventory is the table above.
- **THE VAD THRESHOLD WAS TOO HIGH, and this is the one number that changed
  overnight.** xAI's `threshold` takes 0.1–0.9 and defaults to 0.85; we were
  running the default. "Barely heard" — a call of 30s+ where the caller was
  transcribed at most ONCE — on the two lanes that ran both pipelines:

  | lane | old core | runtime at 0.85 |
  |---|---|---|
  | surgery | 6/46 = 13.0% | 13/40 = **32.5%** |
  | tech | 7/75 = 9.3% | 18/76 = **23.7%** |

  Bimodal, which is what names the cause: when the VAD DOES fire the runtime
  captures MORE than the old core (tech 348 chars vs 324, in fewer longer
  segments). Segments are failing to start, not to finish.
  **Now 0.6, env-tunable via `RUNTIME_VAD_THRESHOLD`, clamped to 0.1–0.9.**
  0.6 is a judgement; "too high" is the measurement. Re-measure both numbers
  together — barely-heard must fall AND interruptions per call must not climb,
  because the opposite failure is the agent stopping for a cough.
- **Grok reports NO token usage.** 0 of 18 calls after the telemetry landed
  carried any, and xAI's Voice Agent docs do not document a `usage` object on
  `response.done`. The old core reports it on 172 of 184 (avg 20,859 cached
  input tokens against 2,545 uncached — the cache does almost all the work).
  So cost-per-call is not comparable between pipelines today, and
  `total_cost_cents` on a grok row is not built from token counts.
  **The route is the bill, not the wire** — see the cost section below.

---

## WHY QUEUE CALLS DO NOT FILE — the 2026-09-08 taxonomy

**One full business day, queue lanes only (optical, surgery, tech, records,
pcp), `duration >= 30`. Measured 2026-09-09.** Everything in this section is a
count, not a judgement; where a cause is not established it says so.

**446 substantive calls · 255 filed · 191 produced no ticket.**

**MIND THE TWO BASES — they are not the same test and the counts below use
both.** The 255/191 split asks *does any canonical-SID ticket exist for this
call*, over tickets anchored to 09-07..09-09 by the call's own day. The
date-of-birth figures further down use the STRICTER agent-provenance test
(`created_by_id IS NULL AND agent_used IS NOT NULL`) over all time. The
stricter test cannot inflate a filing rate, so 53-of-75 is a floor. Do not
add a number from one basis to a number from the other — an earlier draft of
this section put a staff figure from a third, all-lane query into this
446-call breakdown and the column stopped summing.

| what happened | calls | avg secs | avg CALLER: lines |
|---|---|---|---|
| **a filing tool refused it** (`outcome.missingFields`) | **62** | 158 | 7.1 |
| caller transcribed exactly once | 44 | 58 | 1.0 |
| caller never transcribed | 33 | 78 | 0.0 |
| tools ran, a filing tool was never called | 26 | 120 | 5.8 |
| no tool events at all | 14 | 84 | 3.2 |
| filing tool returned a `ticket_number`, no ticket carries the SID | 12 | 169 | 6.5 |

The last row is **not established as a lost request** — it may be the known
call-attribution defect (#77, and the 2.6% of tickets carrying a later call's
SID). Whether those 12 tickets exist under another SID has NOT been checked.

**The refusals are dominated by ONE field.** Refusal events by lane and field,
same day:

| lane | field | calls |
|---|---|---|
| surgery | `date_of_birth` | 34 |
| tech | `date_of_birth` | 29 |
| optical | `location` | 21 |
| surgery | `surgeon` | 14 |
| optical | `date_of_birth` | 12 |

### The date-of-birth chain — every link measured, none inferred

**75 calls hit a `date_of_birth` refusal. 53 of them ended with no agent
ticket; 22 filed anyway** (the `verifiedDobFor` fallback, which needs a certain
`lookup_patient` match).

1. **The model sent no `date_of_birth` argument. 75 of 75.** `dobShape` reads
   `(none)` on every refusal event across all three lanes — no other shape
   appears. The parser was never given anything to read.
2. **In 51 of the 75 the caller had already given a date** — their own
   `CALLER:` lines contain a 19xx year or an English/Spanish month name
   (surgery 25, tech 16, optical 10). This is a lower bound: it counts only
   those two signals.
3. **In 42 of the 75 the refusal is the LAST tool event of the call**
   (surgery 18, tech 19, optical 5). The model does not call the filing tool
   again.
4. Therefore **`decideDobEscape`'s "ask once, then file anyway" cannot fire on
   those 42** — it returns `askAgain: true` on the first refusal and only
   escapes on a second attempt that never comes. The escape was built
   2026-09-04 for a retry loop; the runtime's failure is the opposite shape.

**WHY the model omits the field is NOT established.** What IS established:
`date_of_birth` is declared in the tool schema with a description telling the
model to send it, is deliberately absent from `required`, and
`realtimeAdapter` passes the registry schema through unchanged with
`strict: false`. **The `fix` channel DOES reach the model** —
`agentBinding.dispatch` JSON-stringifies the whole tool result — so a theory
that the coaching text is being dropped is wrong; that was checked.

### The gate is worse on the runtime than on the old core

Share of substantive calls (optical + surgery + tech) hitting a
`date_of_birth` refusal:

| day | pipeline | rate |
|---|---|---|
| 2026-08-28 | old core | 19/271 = 7.0% |
| 2026-08-31 | old core | 21/341 = 6.2% |
| 2026-09-01 | old core | 31/356 = 8.7% |
| 2026-09-02 | old core | 10/314 = 3.2% |
| **2026-09-03** | **old core** | **2/123 = 1.6%** |
| **2026-09-03** | **grok** | **23/186 = 12.4%** |
| 2026-09-04 | grok | 48/324 = 14.8% |
| 2026-09-08 | grok | 75/410 = 18.3% |

The two 09-03 rows are the same lanes on the same day either side of the
cutover. **This is the before-number for `docs/BACKEND_HANDOFF.md`.** The
`dobShape` instrument only went live 2026-09-03 23:18, so no comparable
`(none)`-vs-parser split exists for the old core.

### A SECOND, INDEPENDENT DEFECT: the parser refused shapes real callers used

Probed directly against `normalizeDobParts` on the deployed logic:

```
"0 1 0 4 58"                        REFUSED   CA4475d6f1b265c4c6824ff0f241d159f9,
                                              surgery 2026-09-08, said twice, 329s,
                                              no ticket
"Cero tres veintidos del cincuenta" REFUSED   CAdc9f9667694dd95382985ad5f86f57b4,
                                              surgery 2026-09-08, Spanish caller
"01 04 58" · "January 4th, 1958"    parse
"Marzo 22 de 1950"                  parses
```

Five numeric groups is neither three nor four, so the shape rule refused a
birthday with the rule that refuses phone numbers. **Fixed** by
`readDigitStringDate`, which runs only after the existing reader has refused
and so cannot change any answer it gives; `0 1 0 4 58` now reads, while
`9 0 9 6 0 8 1 8 3 2` and `my number is 0 1 0 4 58` are still refused.
**Spelled-out digits in either language are STILL refused** and are not fixed.

**Both defects were live on the same call.** Even had the model sent the
field, that patient's answer would have been refused.

### The other large bucket: the caller is never heard

77 of the 191 (0 or 1 `CALLER:` lines). Some are hangups and wrong numbers.
**THE SPLIT IS NOW MEASURED, WITH A FLOOR — see the ring-back control below.**
Barely-heard rate (`duration >= 30`, <= 1 caller line), by lane:

| lane | 09-02 old core | 09-03 old core | 09-03 grok | 09-04 grok | 09-08 grok |
|---|---|---|---|---|---|
| optical | 8.5% (59) | 0% (n=2) | 11.7% (60) | 16.4% (61) | **21.5% (93)** |
| surgery | 13.0% (92) | 13.0% (46) | 37.2% (43) | 27.5% (80) | 21.6% (134) |
| tech | 10.4% (163) | 9.3% (75) | 30.1% (83) | 19.7% (183) | 16.4% (183) |

**RE-MEASURED 2026-09-23 OVER THE WHOLE PERIOD — that is W3, and the full
working is `docs/observatory/W3-BARELY-HEARD-20260923.md`. Do not quote a day
from the table above as current.** The single-day columns are small-n; these
are the aggregates, and they are split into THREE arms because v39's recording
disclosure went live 2026-09-17 and lengthens the greeting the caller talks
over — an "after" window that runs to today folds the threshold and the
greeting together:

| lane | 0.85 (09-03) | 0.6, short greeting (09-04..16) | 0.6 + disclosure (09-17..22) |
|---|---|---|---|
| optical | 11.7% (60) | 16.7% (646) | **18.9% (349)** |
| surgery | **37.2% (43)** | **16.6% (844)** | **14.6% (424)** |
| tech | **30.1% (83)** | **16.4% (1,470)** | **13.8% (643)** |

**Dropping to 0.6 halved surgery and tech and did not fix optical.** Caller
lines per call rose with it (surgery 3.8 -> 5.8, tech 4.8 -> 6.1), so the
caller is heard more rather than merely counted more. **Optical rose on the
threshold change and rose again on the disclosure**, and against its own
old-core 8.5% it has more than doubled; it is the only lane where 0.6 did not
work, and WHY is not established — greeting length is ruled out, because
optical's is the SHORTEST of the three (190/251 median chars) and its rate is
the worst.

**AND THE SECOND ARM PASSED, which is the part that was feared:** interruptions
per call FELL when the threshold dropped (optical 1.42 -> 0.90, surgery 1.28 ->
1.01, tech 1.14 -> 0.89 transcript `[interrupted]` marks), so the more
sensitive VAD did not buy fewer missed callers with an agent that stops for a
cough. The disclosure then put some back (tech to 1.13/call, 0.51/min against
0.52 at 0.85). **Read those off the TRANSCRIPT, never the column** — see the
`interruption_count` trap above.

**The old-core control moved too, and it is the honest caveat:** `records` is
still on the old core so the threshold cannot touch it, and its rate ran 10.7%
-> 3.0% -> 19.1% -> 14.4% -> 11.9% across the same five windows. A lane the
dial cannot reach swings 16 points on n = 28-146. The threshold is still the
leading explanation for surgery and tech — the move is bigger than records'
whole range, on twenty times the sample — but it is NOT proven against that
control.

**DO NOT ALARM ON ONE HOUR OF THIS.** Surgery's hourly barely-heard rate on
2026-09-08 ran 16.7 · 14.3 · 42.9 · 31.6 · 36.4 · 5.9 · 31.6 · 7.7 · 0.0
percent across the nine business hours (n = 9–19 each). A single hour above
40% is inside the established spread, not a spike.

**AND IT IS NOT A RUNTIME-ONLY POPULATION.** `no-ivr` — the after-hours agent
on the OLD CORE, which takes all overnight and weekend volume — has its own
share of substantive calls with ZERO caller lines, every day:

| day | 09-02 | 09-03 | 09-04 | 09-05 | 09-06 | 09-07 | 09-08 | 09-09 |
|---|---|---|---|---|---|---|---|---|
| substantive | 40 | 38 | 39 | 74 | 15 | 175 | 34 | 32 |
| zero caller lines | 9 | 14 | 5 | 8 | 0 | 28 | 4 | 10 |
| | 22.5% | 36.8% | 12.8% | 10.8% | 0% | 16.0% | 11.8% | 31.3% |

On 2026-09-09 those 10 calls averaged 95s (33–246s) with 1.4 `AGENT:` lines
and `agent_outcome = 'inconclusive'` on all 10. **Whether these are dead air
(robocalls, wrong numbers, abandoned legs) or real callers we never heard is
NOT established for no-ivr in 2026-09-09's terms** — the shape is consistent
with both, and `RUNTIME_VAD_THRESHOLD` does not apply to this pipeline.

**THE CONTROL NAMED HERE HAS NOW BEEN RUN, 2026-09-23, AND IT DISCRIMINATES.**
Of each lane's barely-heard calls over 09-10..09-22, the share whose number
rang back within 24 hours and WAS heard on the later call — searched across
EVERY lane, so an overnight caller who tries again in business hours counts:

| lane | barely-heard | rang back and was heard | share |
|---|---|---|---|
| tech | 232 | 78 | **33.6%** |
| surgery | 127 | 40 | **31.5%** |
| optical | 131 | 35 | **26.7%** |
| **no-ivr** | 142 | 13 | **9.2%** |

**On the queue lanes at least one barely-heard call in four is a real person
who had to ring again; on the after-hours line it is one in eleven.** So
no-ivr's population really does look mostly like dead air, which is what this
paragraph suspected, and the queue lanes' does not. Restricting the ring-back
to the same lane barely moves no-ivr (7.7% against 9.2%), so the gap is not an
artefact of the widening.

**It is a FLOOR on real callers, not a share.** A caller who gave up entirely,
rang back after 24 hours, or rang from another number is invisible to it, and
that residue is unresolved in the worse direction. Beside it: **13 of 490**
queue-lane barely-heard calls filed a ticket, while **114 of the 140** whose
caller rang back onto the same lane and was heard DID file — so a barely-heard
call is a lost request or a patient made to ring twice, and only persistence
recovers it.

---

## WHAT A CALL COSTS — and why the Grok number was never a measurement

**Measured 2026-09-04, all 241 Grok rows on disk.** Every one carries
`cost_is_estimated = true` and `cost_reconciled_at` NULL. Those two columns
have existed since the schema was written and until now had never once been
used on any row, either pipeline.

| | |
|---|---|
| summed seconds | 25,259 (421 min) |
| exact at the published $0.08/min | **$33.68** |
| what is actually stored | **$34.86** |
| overstatement from `Math.ceil` alone | **$1.18 = 3.5%** |

Every row matched `Math.ceil(duration * 8/60)` exactly — 0 mismatches — so
the formula is applied consistently. It is the **per-call ceil** that
inflates, in the same direction on every single call. Do not quote a Grok
cost-per-call as a measurement, and do not compare it against the old core's
token-derived cost: one is a bill, the other is a constant times a duration.

**xAI's published rates for `grok-voice-think-fast-2.0`: `$0.08 / min audio`
AND, separately, `$0.004 / text input`.** We have only ever counted the
first. Whether the second is material is not a thing to reason about — it is
a thing the invoice answers.

**THE ROUTE IS xAI'S MANAGEMENT API, which is a different host and a
different credential from the one the runtime already uses.**

```
base     https://management-api.x.ai          (NOT api.x.ai)
auth     Authorization: Bearer <management key>
key      xAI Console -> Settings -> Management Keys   (NOT XAI_API_KEY —
         the inference key cannot read billing)
team     console.x.ai/team/default/settings/team

POST /v1/billing/teams/{team}/usage    -> spend per day (TIME_UNIT_DAY)
GET  /v1/billing/teams/{team}/postpaid/invoice/preview
     -> unitType, unitPrice, numUnits, amount
```

`invoice/preview` is the more interesting one: `unitPrice` is xAI's flat rate
stated by xAI rather than transcribed from a pricing page, and `numUnits` is
**how many units they counted**, which is the only way to learn whether they
bill the duration Twilio reports.

**The method, which is Wayne's:** IF a flat per-minute rate is what we are
charged, cost is proportional to duration and nothing else, so a day's
authoritative total splits across that day's calls by their seconds. Built in
`src/services/grokCostAllocation.ts` (largest remainder: no cent invented,
none lost, deterministic), `xaiBilling.ts` and `grokCostReconciler.ts`.

**READ THAT `IF`.** The DAY'S TOTAL is what xAI reported and the arithmetic
preserves it exactly — no cent invented, none lost. The PER-CALL SHARES are an
apportionment, and they are only each call's true cost if the bill really is
proportional to Twilio seconds. That proportionality is unproven and is the
open question of this whole section. An earlier version of this paragraph said
the split "is not an estimate", which was true of the day and false of the
call, and it sat here contradicting the caveat further down. (Codex, PR #269.)

**It is DORMANT until `XAI_MANAGEMENT_KEY` and `XAI_TEAM_ID` are set.** It
says so once at boot and does not schedule — a reconciler that writes a wrong
number is worse than one that writes nothing, because "estimated" is honest
and a reconciled number is believed.

```sql
-- Was 241 of 241. Now 2 (both 2026-08-31, older than the nightly runner's
-- yesterday-only window). Any number here is calls still priced from a constant.
SELECT count(*) FROM call_logs
 WHERE voice_provider = 'grok' AND cost_reconciled_at IS NULL;
```

## THE RECONCILER RAN: xAI REPORTED $53.55 OF VOICE SPEND, WE HAD BOOKED $34.66

**2026-09-04 09:39 UTC, the first reconciliation ever performed.** Wayne set
`XAI_MANAGEMENT_KEY` / `XAI_TEAM_ID` and republished; the nightly runner
settled 2026-09-03 and wrote 239 rows. `cost_reconciled_at` went from 0 of
86,516 to 239. **Do not re-derive these; re-measure before quoting them.**

| 2026-09-03, 239 runtime calls | |
|---|---|
| seconds WE recorded (the allocation's denominator) | 25,116 (418.6 min) |
| our estimate, `ceil(duration x 8/60)` per call | **$34.66** |
| **xAI-reported Voice spend** (`POST /usage`) | **$53.55** |
| gap | **+$18.89 = +54% on our estimate** |
| spend / OUR minutes | **12.79 c/min** — a RATIO, not xAI's unit price. See below. |

**AND IT IS SPEND, NOT AN INVOICE.** The reconciler calls
`POST /v1/billing/teams/{team}/usage` and nothing else. `invoice/preview` —
the endpoint that returns line items, `unitType`, `unitPrice` and `numUnits` —
**has never been called.** Every "xAI's actual invoice" in an earlier version
of this section, and in PR #269, was this usage total wearing a word it had
not earned: it says what they charged, not what they counted or how. (Codex,
PR #269.)

**THE 3.5% `Math.ceil` OVERSTATEMENT WAS TRUE AND IRRELEVANT.** It compared
our estimate against `duration x published rate`. Both sides of that
comparison were wrong about the bill. The rounding error was worth $1.18;
our estimate being wrong is worth $18.89 on one day. **Note which noun that
is** — the estimate, not the rate. Attributing the $18.89 to the rate is the
claim corrected two sub-sections down, and it crept back into this sentence
after being removed from that one.

### The cause is inside the VOICE LINE, not the text tokens

**I got this wrong first and the correction is the useful part.** From the
usage CSV alone — tokens up 364x on the cutover day, 4,570,953 of them — I
concluded the gap was the separately-billed `$0.004 / text input` component,
because 4.57M x $0.004/1k = $18.28 sits right on the $20.06 gap. **That fit
was a coincidence.** The operator's console screenshot, which splits spend by
API TYPE, killed it in one line:

| API type, Aug 29 – Sep 4 | spend |
|---|---|
| **Voice** | **$104.04** |
| **Text** | **$5.64** |
| Image & Video / Storage | $0.00 |

Text is $5.64 for the WHOLE WEEK. On 2026-09-03 it is $5.35 of $58.90 — about
a tenth. It cannot be a $20 gap.

**The token explosion is real and nearly free**, because prompt caching is
working. The console's own text breakdown, with the rate each line implies:

| | usage | spend | per 1k |
|---|---|---|---|
| prompt text tokens | 1.2M | $2.38 | $0.00198 |
| **cached** prompt text tokens | **3.1M** | $1.53 | **$0.00049** |
| reasoning text tokens | 272.5K | $1.63 | $0.00598 |
| completion text tokens | 15.7K | $0.09 | $0.00573 |

**72% of prompt tokens are served from cache at a quarter of the price**, which
is why the token explosion is real and nearly free: the text lines above come
to about $5 on the week, not $20. **No per-call figure belongs in that
sentence** — an earlier version said "3,275 requests for 239 calls, 13.7 per
call", which is the whole account's request count divided by the voice-call
count, and the section below explains why that division is invalid. It was
removed there and left standing here; see the note under the table.

**So the gap is inside the Voice line, and the careful statement of it is:
xAI-reported voice spend was about 60% above `$0.08 x the duration WE
recorded`.** Both nouns matter — reported spend, our duration. That is all the
arithmetic supports.

**IT IS NOT "WE ARE CHARGED 12.79 c/min".** An earlier version said exactly
that, and it is the same mistake as the token division one section down,
committed a third time: 12.79 is $53.55 divided by OUR 418.6 minutes, and
xAI's unit price is $53.55 divided by THEIR unit count, which we do not have.
The very next sentence already conceded that xAI may count a duration we do
not report — so if that is what happened, 12.79 is not a rate at all, it is
our own denominator wearing a rate's units. Asserting it assigned the whole
discrepancy to the rate card before anything had established that is where it
lives. (Codex, PR #269.)

The three live candidates, none of them ruled out: a stale published rate;
audio tokens billed on top of the minute; or a billed duration longer than
Twilio's — session wall-clock including setup, or a per-call minimum.

**`numUnits` is the number that separates them**, because it is how many units
xAI counted. `GET /v1/billing/teams/{team}/postpaid/invoice/preview` returns
it alongside `unitType` and `unitPrice`, and the console's Breakdown panel has
a `Voice` tab beside the `Text` one that gives the same split the text table
above came from. Either settles it; neither has been opened.

**What this cost me, recorded because it is the recurring failure:** I fitted
a hypothesis to two aggregate numbers, got a 3.4% match, and wrote it into
this file as settled. A per-component breakdown existed the whole time and I
had not asked for it. *Before quoting a rate, find the control that proves
the measure* — the same lesson as the `tool_timeline` filing rates, one
section up.

**AND THERE IS NO PER-CALL TOKEN FIGURE HERE, DELIBERATELY.** An earlier
version of this section divided the day's 3,275 requests and 4.57M tokens by
239 voice calls to get "13.7 requests per call" and a marginal prompt cost.
Both denominators are wrong: those totals are the WHOLE account, voice and
text, and contaminating them that way makes a modelled cost look *closer* to
the reported spend rather than further from it — which is how the original
3.4% "fit"
flattered itself twice over (Codex, PR #269).

What the console actually supports, and nothing beyond it:

- The week's text tokens (1.2M + 272.5K + 3.1M + 15.7K = 4,588,200) account
  for essentially all 4,606,021 tokens on the account. **Voice is billed by
  the minute and contributes no measurable tokens.** So the token column
  describes the text API, not the phone calls, and cannot be divided by a
  call count at all.
- Text is **$5.35 on the day, ~10% of it**, and prompt caching is doing most
  of the work.
- **Voice is $53.55 of reported spend against 418.6 minutes WE recorded, and
  that is the whole question.** Both nouns, every time: what they reported,
  what we measured. xAI's own billed duration is not known.

**So trim prompts for latency and for the ceilings — the reasons that were
always true and never needed a dollar figure.** Anyone wanting the billing
argument for a trim has to get per-call units out of the `Voice` breakdown or
`invoice/preview` first. **The voice line is where the $18.89 was on
2026-09-03** — one measured day, not a daily rate.

**What this changes, scoped to the one day that has been reconciled:** on
2026-09-03 our estimate understated xAI's reported spend by about a third. **That
percentage is NOT known to hold on any other day.** If the gap is a per-call
minimum or a setup component rather than a rate, its size moves with the day's
call-duration mix — a day of many short calls would carry a larger uplift than
a day of few long ones. One day is one day.

**AND NOT EVEN THE DIRECTION IS SAFE.** An earlier version of this paragraph
said the sign generalises even if the magnitude does not. It does not follow.
Our estimate is `ceil(duration x 8/60)` PER CALL, which overstates on every
call, and a per-call minimum on xAI's side also scales with call count — so on
a different mix of calls the two move together and could offset or invert.
Under-booking is established for 2026-09-03 and for no other day. (Codex,
PR #269.)

**On 2026-09-03, average Voice spend per call exceeded our average estimate.**
That is the scoped form, and it is as far as this goes: an earlier version said
"the runtime is materially more expensive per call", which is categorical, and
sat directly below the paragraph withdrawing even the direction. It also spoke
per CALL when the measurement is an aggregate average and the per-call shares
are an apportionment. Whether the runtime is more expensive per *resolved
request* is a different question again and has not been measured.

**WHAT THE ALLOCATION IS PROVEN TO DO, AND WHAT IT IS NOT.** Checked, not
assumed: the voice filter matches only the `grok-voice` series so non-voice
grok spend is excluded; 0 of 239 reconciled rows are still flagged estimated;
0 have a total disagreeing with their parts.

Every one of those checks is about the DAY TOTAL and its bookkeeping. **None
of them establishes that the 239 per-call shares are right.** The split is
proportional to Twilio seconds, which is correct only if the bill is
proportional to Twilio seconds — and that is precisely the open question. If
the gap turns out to be a per-call minimum or a setup component, those pieces
are NOT proportional to duration, so a long call is currently carrying some of
a short call's cost.

So: **the day's total is authoritative, the per-call figures are an
apportionment.** That distinction matters more than it looks, because
`cost_is_estimated = false` on those rows tells every reader they are settled
truth, and per-call and per-lane cost analytics read them as such.
Treat a single call's Grok cost as indicative until `numUnits` establishes what
xAI actually counts. (Codex, PR #269.)

**THE GUARD NOW MATTERS.** It has a live population to defend for the first
time — 239 rows carry a reconciled allocation of xAI-reported spend, which an
estimate must never overwrite. Not an invoiced cost: `invoice/preview` has
never been called.
Everything below this line was written when that number was zero.

---

**THE GUARD'S OWN STATEMENT WAS REJECTED AT PARSE FOR THIRTEEN DAYS — found 2026-09-17 05:35 UTC in the Hub's postgres logs, fixed as v52.** The SET clause below this line renders `$n + $m` whenever a caller supplies both the provider and the Twilio price, and Postgres cannot type two bare parameters, so from `8a226a6` (2026-09-04) the ordinary per-call cost write failed 3,749 times a day while the reconciler's one-sided writes went through. `twilio_cost_cents` went from 100% of completed calls to 5–25%; the cost views have shown provider-only totals on 78% of calls since. The v52 marker row has the numbers; do not re-derive the trio below on a day before v52 is deployed and read it as the guard working.

**THE COST-COLUMN GUARD HAD NEVER FIRED, AND THAT WAS THE POINT.** Measured
2026-09-04 while PR #268 was in review. Rounds 11–13 turned up six findings
and four of them were the same sentence — "an estimate overwrites the
reconciled bill" — so it was worth knowing whether that had ever actually
happened before claiming the fixes mattered:

| control | result |
|---|---|
| rows with `cost_reconciled_at` set, **all time, both pipelines** | **0 of 86,516** |
| Grok rows priced at the correct `ceil(duration * 8/60)` | **241 of 241** |
| Grok rows priced at OpenAI's `ceil(duration * 0.19)` | **0** |

So every one of those defects is **latent, not live**. The reconciler has
never run, so the guard's condition has never been true; and the admin
recalculate button has never been pressed on a Grok row, or the second row
would be under 241. This is the "before" number for
`docs/BACKEND_HANDOFF.md`'s rule — re-run all three after the reconciler is
switched on, and the first one going non-zero is the moment the guard starts
mattering.

```sql
-- Re-run this trio before quoting anything about cost preservation.
SELECT count(*) FILTER (WHERE cost_reconciled_at IS NOT NULL)             AS ever_reconciled,
       count(*) FILTER (WHERE voice_provider = 'grok'
                          AND openai_cost_cents = ceil(duration * 8.0/60)) AS at_grok_rate,
       count(*) FILTER (WHERE voice_provider = 'grok'
                          AND openai_cost_cents = ceil(duration * 0.19)
                          AND openai_cost_cents <> ceil(duration * 8.0/60)) AS at_openai_rate
FROM call_logs WHERE duration IS NOT NULL AND duration > 0;
```

---

## THE OBSERVATORY WAS BLIND TO EVERY RUNTIME CALL — fixed 2026-09-04

Measured over every call since 09-01: **100% of old-core rows carried
`agent_id`; 0 of 239 runtime rows did.** The runtime opened its `call_logs`
row with the lane slug and nothing else, and the slug is not what anything
reads. Five places join `agents` on the uuid — the Observatory scorecard and
today view, the cost analytics (`routes.ts:2281`), the quality and sentiment
analytics (`routes.ts:2463`), and `storage.ts:523`. So at 15:24:58 on 09-03,
the moment optical cut over, it stopped existing in all five. **Not wrong,
ABSENT — and an absent lane looks like a quiet lane.**

- Fixed at the source: `src/runtime/agentIdentity.ts` resolves slug →
  `agents.id`, once per lane per process. A miss is deliberately **not**
  cached, so a lane whose agents row is added later is picked up without a
  redeploy.
- **259 existing rows were backfilled** from the slug they already carried
  (every slug matched exactly one agent). Reversal snapshot kept in
  `call_logs_agent_id_backfill_20260904`. Yesterday's cutover is visible.
- The Observatory also had no concept of `voice_provider`, so the cutover
  itself was invisible on the one screen built to watch these agents. Each
  card now names its pipeline and says **"mixed pipelines — do not read these
  as one population"** on a lane that cut over mid-day.

Still not attributable, and left alone: 98 rows with a NULL `agent_used`
(Nov–Jan), 14 `greeter`, 5 `claude-as`. None are current lanes.

---

## How to tell whether a deploy actually took

Wayne pulls and republishes on Replit. **A failed pull looks exactly like a
failed fix.** On 2026-08-11 a GitHub rate limit at 00:34 UTC made his pull fail;
he called at 00:36 and I spent the next round analyzing stale code.

Before drawing any conclusion from a call, look for a log line that only exists
in the new build. Current marker:

```
[ScheduleLookup] 20 row(s) as of 2026-08-10 -> 3 past visit(s), 0 upcoming;
  last visit 2026-07-13; 17 not counted (cancelled, no-show, or cancelled-future)
```

**ON THE RUNTIME, ASK `/voice/health` — AND THE MARKER NOW CARRIES ITS DATE.**

**ASK THE PUBLISHED DEPLOYMENT, AND IT IS THIS HOST:**

```
https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/voice/health
```

**THIS FILE DID NOT RECORD THAT HOST UNTIL 2026-09-27, AND THE OMISSION COST A
FALSE OUTAGE REPORT THE SAME DAY.** Asked to verify a republish, I had no
published host to read, took one out of this repo's own docs, and got
`dcf9f10f-…-3uh0nmdcvfbs6.spock.replit.dev` — a **WORKSPACE** URL. It answered
HTTP 200 with a complete, coherent payload (`liveReady: true`, `missing: []`,
all eight lanes registered) reading `v70`, so I reported that the pull had not
taken and that four merges were not deployed. The published deployment was
serving `v72` the whole time. Every one of those claims was withdrawn.

**THE WORKSPACE HOST IS NOT THE DEPLOYMENT, AND IT ANSWERS ANYWAY.** That is
what makes the mistake reachable rather than obvious: a Replit workspace runs
its own process on a `*.replit.dev` domain, it serves a byte-identical
`/voice/health` shape, and it can sit on a marker generations behind the
published build — at the time of writing it was two markers behind. `200 OK`
plus a healthy payload is NOT evidence you are looking at production.

**THE THREE `*.replit.dev` URLs ELSEWHERE IN THIS REPO ARE WORKSPACE URLS AND
SOME ARE STALE.** They appear beside webhook paths (`/api/voice/no-ivr`,
`/api/sms/incoming`, `/api/voice/twiml`) and read like configuration; do not
resolve a production question with any of them. **Whether a live Twilio lane
still points at one is UNSETTLED and is not answerable from here** — both
processes write to the same database, so `call_logs` cannot tell you. It is one
look at the Twilio console and it is worth taking.

**REPLIT HAS TWO MORE `.replit.app` NAMES AND NEITHER IS THIS SERVICE:**
`ticketing-app--fabianwayne1.replit.app` is the ticketing app and
`sms-app--fabianwayne1.replit.app` is the SMS app. `azul.replit.app` and
`azul-voice.replit.app` appear only as TEST FIXTURES in `readiness.test.ts`,
`callRecord.test.ts` and `voiceRuntime.test.ts`; `azul-voice` answers *"This
app isn't live yet."*

```bash
# The check. Anything other than the current marker means the pull did not take
# — but confirm the HOST before concluding that, which is the whole point of
# this block.
curl -s https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app/voice/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["marker"])'
```


```
voice-runtime-v19-pcp-lost-request-floor-20260915
voice-runtime-v20-blind-transfer-is-not-a-human-20260915
voice-runtime-v21-pcp-ask-detection-20260915
voice-runtime-v22-pcp-questions-carry-format-20260915
voice-runtime-v23-pcp-recording-disclosure-20260915
voice-runtime-v24-pcp-queue-choice-answerable-20260915
voice-runtime-v25-dob-carry-instrument-20260915
voice-runtime-v26-chart-dob-inherit-20260915
voice-runtime-v27-recognition-block-is-runtime-owned-20260915
voice-runtime-v28-ask-script-agrees-with-the-block-20260915
voice-runtime-v29-ambiguity-is-stated-first-20260915
voice-runtime-v30-queue-transfer-files-a-ticket-20260915
voice-runtime-v31-unclassified-calls-still-file-20260915
voice-runtime-v32-settlement-and-narrative-survive-20260915
voice-runtime-v33-the-ask-budget-20260916
voice-runtime-v34-the-answering-service-interview-20260916
voice-runtime-v35-the-lightly-gated-line-20260916
voice-runtime-v36-the-first-ask-is-not-a-mishearing-20260916
voice-runtime-v37-the-credentials-come-after-the-ticket-20260916
voice-runtime-v38-recording-is-persisting-20260916
voice-runtime-v39-the-queue-lanes-disclose-20260917
voice-runtime-v40-no-invented-callback-number-20260917
voice-runtime-v41-the-after-hours-line-asks-once-20260917
voice-runtime-v42-a-filed-ticket-is-not-a-failure-20260917
voice-runtime-v43-the-tool-does-not-narrate-its-rule-20260917
voice-runtime-v44-timed-turns-and-a-recording-20260917
voice-runtime-v45-timed-turns-recording-and-the-day-table-20260917
voice-runtime-v46-a-success-loop-is-a-loop-20260917
voice-runtime-v47-a-phone-match-is-a-candidate-20260917
voice-runtime-v48-the-ambiguous-lookup-is-countable-20260917
voice-runtime-v49-the-fleet-is-graded-at-teardown-20260917
voice-runtime-v50-the-second-miss-ends-the-identity-ask-20260917
voice-runtime-v51-the-record-reaches-the-call-row-20260917
voice-runtime-v52-the-cost-write-parses-20260917
voice-runtime-v53-the-record-reaches-the-after-hours-row-20260917
voice-runtime-v54-the-affirmed-name-picks-the-person-20260917
voice-runtime-v55-the-follow-up-does-not-wait-for-a-done-that-passed-20260917
voice-runtime-v56-an-unvoiced-answer-cannot-end-the-call-20260917
voice-runtime-v58-why-the-record-did-not-reach-the-row-20260918
voice-runtime-v61-the-identity-write-says-why-20260923
voice-runtime-v62-the-ticket-says-why-nobody-was-dialled-20260923
voice-runtime-v64-the-callers-audio-is-counted-20260924
voice-runtime-v67-the-callback-says-where-it-came-from-20260924
voice-runtime-v68-the-silence-ladder-20260924
voice-runtime-v69-the-pcp-floor-is-wired-20260924
voice-runtime-v70-new-or-existing-gates-the-lookup-20260924
voice-runtime-v71-one-import-style-for-the-identity-store-20260925
voice-runtime-v72-a-heard-caller-is-not-cut-off-20260926
voice-runtime-v73-the-records-line-asks-once-then-files-20260927
voice-runtime-v74-an-email-preference-is-not-a-failure-20260927
voice-runtime-v75-the-transcriber-detects-the-language-20260928
voice-runtime-v76-the-after-hours-prompt-in-the-docs-shape-20260928
voice-runtime-v77-the-language-mechanism-is-the-runtimes-20260928
voice-runtime-v78-the-language-tool-is-registered-once-20260928
voice-runtime-v79-the-records-tool-asks-the-channel-20260928
voice-runtime-v80-a-refused-escalation-files-the-ticket-20260929
voice-runtime-v81-the-surgeon-exit-on-the-second-refusal-20260930
voice-runtime-v82-caller-memory-is-a-candidate-20260930
voice-runtime-v83-the-after-hours-line-states-the-hours-20261001
voice-runtime-v84-the-join-reads-the-console-20261001
voice-runtime-v85-the-person-base-answers-first-20261001
voice-runtime-v86-one-person-on-the-number-is-certain-20261001
voice-runtime-v87-one-call-one-ticket-20261001
voice-runtime-v88-the-on-call-text-before-the-ring-20261002
voice-runtime-v89-the-after-hours-line-routes-what-was-ruled-20261002
voice-runtime-v90-the-pcp-floor-reads-the-factorys-own-module-20261003
voice-runtime-v91-the-session-stall-reconnects-20261006
voice-runtime-v92-the-teardown-filers-take-the-unassigned-exit-20261009
voice-runtime-v93-the-urgent-transfer-record-files-in-after-hours-20261009
```

Also printed at boot as `[voice-runtime] <marker>`. Anything ending in an
EARLIER date, or with no date at all, is an older build and nothing measured
on it is evidence about current code.

**WHAT EACH DATE TELLS YOU, because "older" is not one thing:**

| the marker reads | what the build does NOT contain |
|---|---|
| earlier than **20260908** | the PCP blind transfer — a PCP call used the WARM path, so its silence while the queue rang is expected rather than a defect |
| earlier than **20260911** | the date-of-birth transcript backstop (#280, #281, merged 2026-09-10) |
| **v5**-…-20260911 | the West Covina fix: v5 routes a "West Covina" caller to our Covina office, v6 refuses and asks again (#287) |
| **v5** or **v6**-…-20260911 | the optical unassigned exit (#288, merged 2026-09-11). Without it `file_optical_ticket` never sends `routingAskExhausted`, so an optical request whose office did not resolve is answered HTTP 400 "Missing required information: office" and files NOTHING — 48 calls in the 30 days to 09-11. A build on v5/v6 is the BEFORE arm; do not read a filing rate from it as an after-number |
| earlier than **v10**-…-20260912 | the PERSON BASE rung on `lookup_patient`. Every rung before it reads the Operations Hub APPOINTMENT BOOK, so a real patient with no appointment inside its window cannot be found and the failure looks random from outside — standing instruction 14. Measured 2026-09-12 over ten days, `duration >= 30`: **627 of 2,511 substantive queue calls (25.0%) ran `lookup_patient` and found NOBODY** (tech 277/1173 · surgery 158/638 · optical 122/501 · records 70/199), **235 of those ended with no ticket**, and of the 330 distinct caller numbers behind them **208 (63%) ARE in `patients_master`**. Optical alone reads 76/100 and tech 132/230 — **63% is the fleet figure and 76% overstates it**; tech's sample visibly contains toll-free numbers, so some residue is genuinely not-a-patient. The rung runs ONLY where the method already returned `emptyContext()`, so it can ADD a match and can never change one the schedule made. **v10 also carries THE JOIN**: once the mirror identifies somebody, `lookupByPersonId` pulls their `Schedule` rows on `PersonID` and they come back through the same `buildContext` as every other rung, so history, office and provider arrive with the identity. An earlier draft of this row said v10 brought no history and called that correct; it was wrong, and the join section below has the 81% that disproved it |
| **v10** or earlier — NOT the date | the locked record. Pre-context's caller-ID match reached the greeting and the prompt and nothing else, so a filing tool could refuse for a date of birth the process was already holding — 61 refusals on 2026-09-11, **44 of them on calls the greeting had already addressed by name**. A build before this is the BEFORE arm for that number. **This row was keyed on `earlier than 20260912` until v10 merged on the same date and did not contain it** — which is this table's own warning firing against the table |
| **v11** or earlier — NOT the date | optical's office ladder. `file_optical_ticket` resolved ONLY the office the CALLER named, so a caller who named none filed UNASSIGNED on the one queue that assigns BY location. Surgery has walked the patient's record for its routing field since 2026-08-18; optical never had. 2026-09-11: 25 optical calls hit the location gate, 8 ended with no ticket at all. **This marker is v12.** It claimed v9 until #292 merged as v10 and #290 re-bumped to v11; a v9 here would have sent `/voice/health` BACKWARDS past two markers that are already live, which reads as a failed pull rather than as a new build. This row was keyed on `earlier than 20260912` for the same reason and had to be re-keyed onto the version: three builds now share that date. v12 also carries two Codex fixes from #291's review: an ambiguous `lookup_patient` now UNSETS an earlier certain match on the same name (it could not before — there was no `else`, so `usualOfficeFor` answered from a result the tool had stopped believing), and a directory outage on the record rung is reported as an outage rather than as an office we do not hold. **AND OPTICAL NO LONGER ASKS WHEN IT ALREADY KNOWS** — operator ruling 2026-09-12. The record is consulted BEFORE the location gate, so a caller who names no office is routed on the FIRST `file_optical_ticket` call instead of being asked. The first version of this sat below the gate and was inert for the calls it was for: the gate returns `missing(['location'])` first and the record was reached only on a SECOND invocation, which in 42 of 75 refusals never comes (Codex P1, #291). What it trades: a patient ringing about an office other than their usual one, who names none, is now routed to their usual one rather than landing unassigned for triage — weighed against 8 of 25 such calls ending with no ticket at all on 09-11. An office the CALLER names still always wins |
| **v12** or earlier, and **v13** whenever it lands — NOT the date | the PCP queue choice. A caller who asks for a representative is now asked whether they want the live queue or want us to take the request, before anything is filed or dialled — operator ruling 2026-09-13, which **overrides Rosa's 09-08 design** that said to file a ticket even on a transfer. His reason is on the record: the queue answers at 36% and nobody works the voicemails. On this build an explicit **yes files NOTHING**, is asked no further question, and is handed over — *"they asked for a person, get them to a person"* (operator, same day), which NARROWS the 09-08 "one round then transfer anyway" ruling to the paths where that round still buys something: nothing is filed and a blind redirect briefs nobody, and the warning has just told them what we gathered does not carry over. If the queue then fails to answer, the fallback ticket files and the model is told to collect what is missing THEN. An explicit **no** files through `create_pcp_task` and does not dial; anything else — vague, or the model not coming back with an answer — keeps the pre-ruling behaviour exactly, file then dial. **THE INSTRUMENT CHANGES WITH IT:** an accepted transfer leaves no row in `tickets`, so `tickets.pcp_handoff_*` — the only working PCP transfer measure today — stops seeing that arm. The before-arm is the 217 PCP tickets of 2026-09-13: 72 transfers attempted, 12 reached a human. Do not read a fall in transfer tickets on a v14 build as a fall in transfers. **THE FILING HALF OF THIS RULING WAS WITHDRAWN ON 2026-09-15 — see the v29 row — AND RESTORED ON 2026-10-01: see the v86 row.** An accepted transfer files again, at `DIALING`/`TRANSFERRED_TO_QUEUE`; what survives unchanged is the empty round and the sweep's exit. This row is kept as the history of v14, not as current policy |
| **v14** or earlier — NOT the date | PCP records reaching MEDICAL RECORDS. Operator, 2026-09-12: *"a medical records request should file a ticket with medical records, not pcp."* It did not. `handle_patient_medical_records_request` — the tool NAMED for records — filed a plain PCP ticket and set `callPurpose = 'patient_medical_records_request'` on entry, which overwrites the `patient_caller` value that `create_pcp_task`'s dept-16 route keys on, so picking the correctly-named tool DEFEATED the correct route. **Before-arm, measured 2026-09-13:** PCP tickets whose description mentions a medical record — **54 in department 18, 2 in department 16, and both of those 2 are dated 08-05 and 08-07, BEFORE the 2026-08-14 migration**. Nothing reached Medical Records from this lane in the month after the route was written. v15 extracts one shared `fileToMedicalRecords` used by both tools, states the requester type instead of re-deriving it from prose (`resolveRequesterType`, which can never take a request OFF the clock), and carries operator ruling 2026-09-13 — *"on the clock, personal rep stands in for the patient"*. **AND A PROFESSIONAL RELATIONSHIP IS NOT A PERSONAL ONE** (Codex P1, #296): `statedRelationship` is collected by the question *"What is your PROFESSIONAL relationship to this patient?"*, so the modal caller on this line — a medical assistant or coordinator at a doctor's office, 49% of it — answers it with "primary care provider", and the first version filed every one of them as the patient's personal representative on `roa_patient` with the statutory clock running. `resolveRequesterType` could not correct it downstream: its guard is one-directional by design, so a stated ON-clock value beats an off-clock `provider` read from the prose. Only the three off-clock professional types are now taken from the classifier, and only when the caller has NOT said they are the patient — a job title cannot switch off a patient's own clock. **The on-clock gate now has an opt-in exit** (`on_clock_ask_exhausted`): PCP has never collected a date range, so rather than add a question the case files with `Dates needed: NOT CAPTURED` written on it — the #288 unassigned-exit shape, chosen by the operator over asking. The records lane never sets it and its gate is untouched. **AND PCP'S FLOOR STILL OUTRANKS THE LIBRARY:** once the strike budget is spent a library refusal falls back to the PCP ticket rather than losing the request — **and a library refusal now SPENDS a strike, without which that floor was unreachable** (Codex P1, #296). `ticketBlocksUsed` was advanced only by PCP's own gates, so a call whose intake is complete and whose destination is captured spent nothing: `record_pcp_intake` accepts a 7-digit callback (`z.string().min(7)`) and `file_records_ticket` refuses under ten, and that disagreement returned the identical refusal on every retry with the budget stuck at zero. The request then filed NOWHERE, where before this route existed it left a PCP ticket — the exact number this change names as its own guard. The floor is read AFTER the strike is spent, or the budget runs out one invocation before anything notices and on this lane the next invocation is the one that never comes. The number to watch: department-16 records tickets from PCP should go from ~0/month to most of them, and PCP records tickets that file NOWHERE must not rise |
| **v15** or earlier — NOT the date | a PROFESSIONAL caller's records request reaching Medical Records. Operator ruling, 2026-09-14: *any* professional caller — provider, health plan, attorney — files off the clock, with one exclusion. v15 sent only the PATIENT there, because the department-16 route sits inside `create_pcp_task`'s `patient_caller \|\| callerIsThePatient` branch and a professional never enters it. **Before-arm, measured 2026-09-14** over live PCP records tickets (backfills excluded): **41 in department 18 — 16 from a provider organisation, 6 from a medical assistant or referral coordinator, 6 from a health plan, and 2 mentioning "peer-to-peer" at all.** That last figure is the reason the rule reads the CALLER and not the phrase: scoped to the `peer_to_peer` purpose slug it would have moved two tickets. **`callerFacilityType` is what it reads** — an enum the intake fills from a closed list, consulted BEFORE the prose classifier because there is nothing in it to drift; prose (`statedRelationship`, then role, then organisation) is the fallback. **THE EXCLUSION IS THE PHARMACEUTICAL REPRESENTATIVE**, who has no treatment relationship to the patient: their chart request stays in PCP Support for a person to look at. **AND AN UNIDENTIFIABLE PROFESSIONAL IS NOT ROUTED AT ALL** — the patient route has a sound default (a caller on that branch who named no relationship IS the patient, which is the on-clock answer that protects them) and the professional route has none, so declining costs the department-16 improvement on that call while guessing would put a stranger's request on the patient's own statutory clock. **THE TWO ROUTES ARE SPLIT AT THE CALL SITE** (`route: 'patient' \| 'professional'`) so the patient read cannot pick up a facility type; `resolveRequesterType`'s one-directional guard is the backstop behind it, and mutation-checking showed the guard alone catches that case — the split is the clearer defence, not the load-bearing one. **PCP NOW ASKS A PROFESSIONAL WHERE THE RECORDS GO**, bounded by the same strike budget: off the clock the library does NOT gate `deliver_to`, so without the ask an `mr_cases` row opens with nowhere to send — the 2026-08-13 hard gate's own failure arriving through a side door. Beside it, `file_records_ticket` now writes `Send to: NOT CAPTURED` on ANY records case missing a destination rather than only an on-clock one; the DATE RANGE line stays keyed to the clock, because a plan or a clinic usually wants one encounter and a chase line for a range nobody needs is noise. The number to watch: **department-18 records tickets from professional callers should fall toward zero and department 16 should gain them** — and, the guard, **PCP records tickets that file NOWHERE must not rise** |
| **v16** or earlier — NOT the date | PCP scheduling reaching the team that schedules, and not dialling on its own. Two operator rulings met on this lane and neither was followed. **Measured 2026-09-14, all 217 PCP tickets: 75 carry one of the three scheduling slugs, 56 attempted a transfer, 10 CONNECTED — 17.9% — and ZERO have ever reached department 9.** So the caller was neither connected to a scheduler nor filed with the schedulers. `schedule_appointment`, `reschedule_appointment`, `cancel_appointment` and `grievance_follow_up` defaulted to `HAND_OFF`, and `director.next`'s SECOND arm grants `handoffEligible` on a complete intake with **no ask from the caller at all** — an auto-transfer, which the operator withdrew on 2026-09-04 ("never auto-transfer; transfer only when the caller ASKS and is an entity"). v17 flips those four defaults to `CREATE_TASK` and **keeps `HAND_OFF` in `allowedDispositions`**, which is load-bearing three times over: `eligibleByAsk` still connects a professional who asks, handoffPolicy's `PCP_CALLER_TYPES` is DERIVED from that list, and `connectsToHuman` now reads it too. **THAT LAST ONE IS THE TRAP THIS ROW EXISTS FOR.** `connectsToHuman` asked `defaultDisposition === 'HAND_OFF'`, welding the LENGTH OF THE INTAKE to WHETHER WE DIAL — so flipping the default alone would have pushed `PATIENT_FIELDS` back onto a scheduling caller, whose first question is *"What is your professional relationship to this patient?"*: the bd89b226 interrogation, arriving as a side effect of a routing change. It now reads `allowedDispositions`, and `director.test.ts` fails if that is reverted. **THE DESTINATION ANSWERS THE OLD ARGUMENT RATHER THAN OVERTURNING IT** — "the PCP line CANNOT schedule, so it must reach a human" is true, and the human is the HVA Hub (standing instruction 10, *"anything that's schedule related that comes through any of these should go to the HVA hub"*). **IT ROUTES ON THE STATED SLUG, NOT THE PROSE**, and `detectCrossQueue` is deliberately NOT called on the professional path: 25 of the 75 contain no scheduling cue at all so prose alone leaves a third behind, and running the full classifier there would adopt #99 — `'surgery center'` firing on a caller's EMPLOYER, which sent a Loma Linda caller's ticket to department 2 on 2026-09-08 — for subjects nobody asked to reroute. The narrative is read for ONE thing, the surgery exception (*"surgery is an exception to that hva hub rule"*, 2026-08-13), enforced inside `schedulingRedirectForStatedIntent`; 4 of the 75 are that shape and stay put. **AND THAT ONE LINE WAS THE HOLE** — Codex P2, #298, caught this route doing the exact thing the sentence before it boasts it cannot: the guard read `SURGERY_CUES`, which contains the literal `'surgery center'`, so a referral coordinator AT a surgery centre booking an ordinary exam hit the exception on their EMPLOYER and stayed in department 18. It now reads `OPERATION_CUES` — `SURGERY_CUES` minus the facility words — and the operator's own wording is what settles which list is right: *"the exception is the OPERATION, not the word 'reschedule'."* **ROUND 2 FOUND THE SAME DEFECT ONE LEVEL DOWN, TWICE, AND IT SURVIVED THE ROUND-1 FIX.** `hit()` is a SUBSTRING test, so the bare cue `operation` is contained in `operations` — an *"operations coordinator"* or *"operations manager"* booking an ordinary eye exam matched the surgery exception on their ROLE NAME and stayed in department 18. And `specialistReferral` read `SPECIALIST_CUES` over the whole narrative, so *"coordinator at Example Retina Specialist"* graded a routine new appointment as reason 152. On this path the narrative is dominated by the caller's organisation and role BY CONSTRUCTION — that is what the PCP intake collects — so any substring read of it is reading the caller, not the request. Fixed as two different shapes because they are two different problems: the surgery guard gained a WORD-BOUNDARY matcher (`hitWord`, safe here only because `OPERATION_CUES` has no stems, and a test fires every cue alone to prove none was disarmed), while the specialist refinement was REMOVED rather than sharpened — there is no lexical way to tell that employer from a patient who needs a retina specialist, the two sentences contain the same string, and reason 152 has been used ONCE in 90 days. `detectCrossQueue` keeps both its substring matching and its specialist read: that is the PATIENT path, where the narrative is the caller's own words about their own care, and changing it is #99. **ROUND 3 ARRIVED IN A THIRD SHAPE — `lasik` inside "Coordinator at Example LASIK Clinic" — AND THAT IS WHERE THE CUE LIST STOPPED BEING THE PROBLEM.** No edit to the list closes it: there the employer token and the procedure token are THE SAME TOKEN, so neither a boundary nor a narrower list can separate them. MEASURED before deciding, all 217 PCP tickets: **7 organisations contain an operation cue and 2 of the 75 scheduling tickets are this shape** — and a false positive costs nothing against today, because the request stays in department 18 where all 75 sit now, while loosening the guard risks routing a real surgery date to the Hub against the operator's exception. So this was fixed at the source rather than patched a fourth time, taking Codex's own framing literally: **the caller's OWN organisation and role are removed from the text before the guard reads it** (`callerMetadata`, passed from `state.callerOrganization` / `state.callerRole`). Provenance separates them where spelling cannot. It only strips exact occurrences, so "Coordinator at Example LASIK Clinic — needs to move the surgery date" still withholds. **THE GUARD ON THE GUARD:** a metadata entry shorter than 3 characters is skipped, because `state.callerOrganization` is routinely empty and `t.split('').join(' ')` would separate every character and leave NO cue able to match — the surgery exception silently dead for every call, which is the failure direction that actually matters. Mutation testing caught that, and caught two tests that could not see their own fix: one whose end-to-end narrative did not contain the organisation it was supposedly stripping (so deleting the call-site argument was a no-op) and one with no empty-organisation case at all. `SURGERY_CUES` itself is UNCHANGED, because `detectCrossQueue` routes on it across every lane and narrowing it there is the open #99 work that needs a department-2 misroute measurement first. **THREE MORE FROM THE SAME REVIEW, all real:** the Hub ticket was hardcoded `priority: 'medium'`, so a `create_pcp_task` called with `high` or `urgent` reached the schedulers deprioritised where `buildPayload` would have carried it; the POST carried no idempotency key, and this tool's own refusal paths exist to send the model back, so a retry opened a second department-9 ticket; and a `success:false` carrying no `statusCode` is a TIMEOUT, not a proven refusal — the PR body claimed "a failed POST creates nothing, so falling through cannot duplicate", which is false for exactly that case. The floor does not move (a request must never file NOWHERE) so the PCP ticket still goes, but it now carries a line telling a staffer the Hub may hold one too. **THE P1 IS THE ONE WORTH READING.** The guard keeping a mid-transfer caller's ticket on the PCP endpoint read `create_pcp_task`'s `disposition` — a MODEL argument with `.default('CREATE_TASK')`. So the filing the model is TOLD to make by `durable_ticket_required_before_handoff` arrived indistinguishable from an ordinary one: it routed to department 9, `recordDisposition('CREATE_TASK')` satisfied `requestIsOnRecord`, and the retried dial rested on a scheduling ticket with no `pcp_handoff_*` columns and no `dispositionGrantedByExplicitAsk` — the field whose absence killed this transfer on 2026-08-27. The dial is not new; WHERE the durable record lives is. Fixed with a server-owned per-call latch the model cannot set or clear, cleared the moment the caller declines the queue. **WHAT IT COSTS:** a caller who would have been auto-transferred is now asked once for the patient's name, because `ticketReadiness` gates on it and the transfer used to skip that gate — bounded by the shared three-strike floor, and it is the one fact the Hub cannot book anybody without. **THE GRIEVANCE DESTINATION IS DELIBERATELY UNCHANGED**, department 18 as today: department 19 "Grievances" exists, holds ONE staff-created ticket all time, and whether it is worked is not a fact this repo has. Two PCP tickets read as grievances. OPEN FOR WAYNE. The numbers to watch: **department-9 scheduling tickets from PCP should go from 0 to most of the 75-shaped population, PCP transfer ATTEMPTS should fall (that is the signal, not a fault), and the guard — PCP requests that file NOWHERE must not rise** |
| **v17** or earlier — NOT the date | the no-IVR prompt trimmed for Grok, and a greeting block that contradicted itself on the runtime. **Measured 2026-09-14 through `realLanes.test.ts`**, own share = bound instructions minus the 9,317-char knowledge pack: surgery 1,299 tok · optical 1,425 · tech 1,583 · records 1,686 · pcp 2,348 · **no-ivr 9,118**. Only optical, surgery, tech and pcp have ever taken a live call on this runtime, so **pcp's 2,348 was the largest prompt it had ever served** and no-ivr would have been 3.9x that, on the lane carrying all overnight and weekend volume. The four queue lanes were trimmed for Grok on 2026-09-03; no-ivr never was. **The trim removed PACKAGING and RESTATEMENT, not capability:** 22 box-rule lines and 242 bordered body lines were 6,989 characters of border and padding carrying no instruction, and the provider-escalation rule, the "a patient asking for a human is not an emergency" rule, the B2B date-of-birth rule and the ghost/robot protocols were each written three or four times over. **36,475 -> 27,802 chars, -23.8%, with no rule changed.** It does NOT reach the operator's stated 1,600-token ceiling and is not claimed to: getting there means deleting capability, which is his call and a `docs/BACKEND_HANDOFF.md` change, not a trim. **THE GREETING FIX IS THE LOAD-BEARING HALF AND IT IS PIPELINE-SHAPED.** On the OLD CORE `armGreetingGuarantee` (`voiceAgentRoutes.ts`) injects a `response.create` whose instructions are *"Say this greeting to the caller word-for-word"* — the MODEL speaks it, on the transport's command, with a delivery check and a re-send. On the RUNTIME the bridge plays it as audio BEFORE the model's first turn and `withGreetingAlreadyPlayed` appends *"Your opening greeting has ALREADY been spoken … Never say it again."* The pre-context block said *"YOUR GREETING IS NOT OPTIONAL AND MUST NOT BE SHORTENED. Deliver it IN FULL"* — redundant on the old core and a flat contradiction on the runtime, in the prompt that carries the 911 instruction and the recording disclosure. It now states only what holds on BOTH: do not open with a name confirmation, do not speak over it, never shorten, paraphrase or repeat it. **Latent today** (the block is behind `pc?.matched && pc.firstName`, and pre-context matched nobody on the measured queue days) **and #88/#110 exist to make it fire on most callers**, so it was fixed before it started happening. **THE TRIM SURFACED THREE PLACES WHERE THE PROMPT CONTRADICTED ITSELF, all resolved toward the statement the rest of the prompt already agreed with, all reversible:** (1) a failed `create_ticket` told the model to `escalate_to_human` in two places, while Phase 6's own *"ESCALATION — EXACTLY THREE CASES, NOTHING ELSE"* excludes a tool failure and TICKET CONFIRMATION RULES says outright *"DO NOT escalate to human. This is a technical issue"* — two of three win, and on an after-hours line the loser wakes somebody at 1am; (2) the Phase 6 closing promised *"The doctor will receive a full recording"*, which COMMUNICATION STYLE forbids in as many words (*"do not promise recordings, that 'the doctor will receive' anything"*) and which task #54 already closed; (3) CONFUSION & TIMEOUT said *"DON'T force create_ticket if you're missing required fields"* against Phase 6's *"Filing a partial ticket IS the job"* and its own *"A REFUSAL is an answer … File the ticket with what you have"*. **A REAL NAME AND DATE OF BIRTH WERE REMOVED** from a worked `lookup_schedule` example in the same file (#106's shape, in a prompt rather than a fixture). `src/agents/noIvrPromptForGrok.test.ts` pins all of it — 21 assertions, **12 mutations, 12 caught**, including a deliberately weak first attempt: a bare `/911/` survived deleting the sentence that says what the greeting carries, because the block mentions 911 twice, so the assertion was narrowed to the specific sentence. **NOT MEASURED IN PRODUCTION** — no-ivr is still on the old core, so this ships to that pipeline first and `docs/BACKEND_HANDOFF.md` applies. The before-arm is task #115 (14 days, old core: filed 45.8%, ZERO caller lines 17.4%, 730 substantive calls); the guard is that neither moves on the OLD core from a prompt trim alone |
| **v18** or earlier — NOT the date | the PCP lost-request floor. On 2026-09-14, the line's first full day, **17 callers said "speak to a representative", were told *"I've taken this down and I'm making sure it reaches the right team"*, and no ticket of any provenance carries their call SID** — re-checked at 00:40 the next morning, well past the outbox's twelve retries. Three defects in a row, each masking the next, all read from production: (1) the director classifies a caller who names no organisation as a patient, so `askedForAPerson = callerRequestedHuman && !isPatient` is false and the transfer is refused — that rule is CORRECT and stays, a patient must never be dialled into a queue staffed to talk to clinics; (2) the documented CREATE_TASK fallback POSTed `callPurpose: patient_caller` and the ticketing app's slug list held 18 of the agent's 19, so **every one of those POSTs is in `voice_agent_api_logs` as HTTP 400 ["Validation failed"]** (ticketing-app #267, merged and deployed 2026-09-15 ~00:30 — that cause is closed); (3) `fallback.success` false selects the `handoff_not_eligible` refusal, **whose copy was its SIBLING's line** — the sibling being the one reached when the filing SUCCEEDS. The branch defined by the filing having failed spoke the sentence claiming it had worked. **That third link is what this marker fixes, and it matters beyond #267:** the next filing failure will have a different cause — a timeout, an outage, a schema that drifts again — and a caller told their request is filed does not call back while no staffer sees a ticket, so the loss is invisible. The copy now declines to claim the record and asks for the callback number (standing instruction 12). **BESIDE IT, THE FLOOR:** `sweepPcpUnfiledCall` skipped all 17 because `toldUsSomething` demands one of four identity fields and these callers refused to give a name — the "no name, no ticket" rule this file records as an open question (47 of 53 skipped), selecting against exactly the population it exists to serve. It now also admits a caller whose latched, explicit ask for a person went unhonoured, which is a request in its own right and the only one a caller can make while volunteering nothing about themselves; caller ID seeds the callback number at the top of `createPcpAgent`, so the ticket is workable rather than a stub. Deliberately narrow — filing on every unidentified call would recreate azul's 2026-07-28 sweep, where 9 of 12 spurious tickets were callbacks for patients already helped — and the CONNECTED and `callerChoseTheQueue` exits are both mutation-proven to still hold in front of it. Still gated on `callPurpose`, because `buildPayload` reads `state.callPurpose!` and the payload schema takes an enum, so admitting a purposeless call would send a POST refused before the wire and reinstate the silent loss one layer down; picking a stand-in slug would be choosing a department, which is a routing rule and the operator's to make. **AND THE NEW COPY PRESUPPOSED A NUMBER** (Codex P2, #300): *"Is this the best number to reach you on?"* is right for the common case — `pcpAgent.ts:510` seeds `callbackNumber` from caller ID whenever the ANI is E.164, and confirming beats asking — but a withheld or blocked caller ID arrives as a non-E.164 string, the seeding regex correctly rejects it, and the caller was then asked to confirm a number nobody held. A "yes" to that produces a request that cannot be called back, which is the one outcome this branch exists to prevent. A second key, `handoff_not_eligible_no_callback`, asks for the number instead, and the call site picks between them — the house pattern twice over, since `knowledgeBase.ts:283` already writes this exact fork and this refusal's own `_task_created` sibling is already chosen by a ternary there. `src/pcp/lostRequestFloor.test.ts` — 15 assertions, **11 mutations, 11 caught**, two of them only after the first attempt tested the sink instead of the source: an assertion over the HTTP mock could not see the `callPurpose` gate at all, because `submitPcpTicket` safeParses BEFORE the client and an admitted-but-unfilable call calls it zero times, identically to a correct skip. **NOT MEASURED IN PRODUCTION** and `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP substantive calls with a completion sentence and no ticket — **17 on 2026-09-14, target 0**; and the guard, PCP tickets filed per substantive call must not fall, because a floor that files more must not come with a gate that files less |
| **v19** or earlier — NOT the date | a blind transfer no longer records that the caller reached a human. **Measured 2026-09-14 over that day's PCP tickets: 20 read `pcp_handoff_status = DIALING` with `human_answer_status = TRANSFERRED_TO_QUEUE` and `human_handoff_occurred = TRUE`, plus 2 at `NOT_REQUESTED` and 1 with no handoff fields at all — 23 tickets claiming a person was reached.** Nothing on the blind path observes one: the caller is redirected into an ACD and we let go of the leg, which is why Rosa's 2026-09-08 design reserves "accepted" for the warm path's keypress and gives this path `handed_to_queue` → `queue_answered`/`no_answer`, where even `queue_answered` means the ACD picked up and NOT that a person spoke. A staffer who reads "handoff occurred" skips the callback, which is the one thing that ticket exists to prevent. **THE DEFECT WAS A MISSING ARGUMENT, and `blindTransfer.ts` described it without knowing:** *"the distinction is carried in `method: 'blind'`, and every consumer that turns a TransferOutcome into a record or a ticket status branches on it"* — every consumer except the one that writes the RECORD, because `onCallerRedirectStarting` was a bare hook taking nothing, so `transferInFlight` collapsed warm and blind into one boolean and `callRecord` turned both into `transferredToHuman: true`, which `ticketingSyncService` carries into `humanHandoffOccurred`. The method now travels with the hook. **WHAT DOES NOT CHANGE:** `outcome` is still `transferred` on both paths — that flag exists because the redirect kills the Media Stream and the close looked like `caller_hangup`, corrupting the very transfer metrics the migration is judged by (Codex, #230 round 2). How the call ENDED was never in question; whether a HUMAN ANSWERED is. **An UNSET method reads as warm, deliberately** — warm is the per-lane default for every transfer-capable lane but pcp, so defaulting the other way would trade this bug for its mirror image and silently zero the metric. **THE MUTATION TESTING IS THE PART WORTH READING:** both ENDS had tests — `performBlindTransfer` sends `"blind"`, `toCallLogRow` honours it — and the two links BETWEEN them were uncovered, so the bridge could discard the argument and `voiceRuntime` could drop it from the lambda while every test stayed green and the live behaviour reverted exactly. 5 mutations, 5 caught only after those two were closed; the runtime lambda is pinned by reading the file, the device `ticketRequirements.test.ts` already uses for the sweep's wiring. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: PCP tickets with `pcp_handoff_status = DIALING` and `human_handoff_occurred = true` — **20 on 2026-09-14, target 0**. The guard: WARM transfers recording `transferred_to_human` must not fall, on any lane — this narrows a claim and must not erase a true one. **STILL OPEN, the other half:** the ticketing app's `update-call-data` writes `humanHandoffOccurred` raw over a value `lib/pcp/pcp-ticket.ts` already computes correctly from `finalStatus === 'CONNECTED'`, so the app should refuse to RAISE it while the handoff reads DIALING rather than trusting the caller of its own API |
| **v20** or earlier — NOT the date | `asksForAPerson` recognising the plainest ask there is. **`"Caller asked for a representative."` returned FALSE**, and so did `"Caller asked for the operator."`, `"Caller requested a live agent."` and `"Caller asked for a person."` — because both existing branches require a VERB OF CONNECTION (`speak\|talk to/with`, or `connect\|transfer\|put through\|get me`) and "asked FOR" is neither. That boolean decides three things at once: whether the director grants HAND_OFF whatever the purpose (`eligibleByAsk`), whether `handoff_to_pcp` still needs a recorded `callPurpose`, and whether the ticket carries `dispositionGrantedByExplicitAsk` — the field whose absence killed 19 of 19 transfers to 2026-08-27. **This module's own header records that exact phrase failing a test on 2026-09-08 and the author fixing THE TEST rather than the code; the consistency half was fixed then and this half never was.** Live cost 2026-09-14: `CAd77ba25e`, a VP of Partnerships at an ambulatory surgery centre, gave a COMPLETE professional intake and asked twice ("Speak to your surgery coordinator", then "Representative?") — filed fine, transfer refused, to an entity who asked, which is exactly what the operator's 2026-09-04 rule entitles to a person. `CA7a268e03`, a doctor confirming a pre-op form, got the same and answered *"Hang up if you don't put me through to the operator."* 10 of 170 substantive calls that day contain "not able to put you through". **THE NEW BRANCH ENDS AT A PHRASE BOUNDARY** because `office` and `team` can OWN things: "asked for the office fax number" and "asked for the team's direct line" stay rejected. The noun list is NOT split to achieve that — one shared list is this module's whole point, since two near-identical lists are what let `team` drift and cost the operator his own transfer on `CAa2a3a1c1`. **`operator` JOINS THE NOUNS AND `coordinator` DOES NOT**, measured over the same 170 calls on callers' own lines: operator 6 occurrences / 6 asks / 0 role statements; coordinator 24 / 1 / **23**; supervisor 3 / 1 / 2. Those 23 are answers to "What is your role?" — the #99 shape, where `'surgery center'` matched a caller's EMPLOYER and misrouted their ticket to department 2. **A JUSTIFICATION WAS CORRECTED BY MUTATION TESTING BEFORE IT SHIPPED:** I wrote that adding `coordinator` would turn those 23 into dials, and it would not — adding it fails NO test, because they are bare nouns and every branch requires a verb. THE VERB REQUIREMENT, NOT THE NOUN LIST, is the safety property, and it now has its own describe block so a future bare-noun branch goes red and sends the reader back to the measurement. **AND THE BRANCH SAID YES TWICE WHEN THE CALLER HAD NOT ASKED — both Codex P2, both in the branch above, fixed before merge.** (1) A NEGATED ASK MATCHED: *"Caller did not ask for a representative."* read as an ask, because the branch reads the verb and never looks at what sits in front of it. **The guard is scoped to the MATCH, not to the narrative, and that is the design** — this file records the grader's `connect you` rule being written THREE times because a narrative-wide negation suppressed the affirmative half of *"I can't transfer you, BUT I can connect you with the team"*; pointed this way the same mistake would DROP a real transfer, so the negator must govern the verb that actually matched and every match gets its own look. `n't` carries no leading `\b` because there is no word boundary inside "didn't". (2) **`FOR` WAS OPTIONAL AFTER `ASK`**, which is the one verb here that takes a PERSON as its object: *"Caller asked the representative, but they could not provide the status."* is a caller who SPOKE to somebody, and it matched. `for` is now mandatory after forms of `ask` and stays optional after `want`, `request` and `would like`, which have no such reading — *"Caller wants a representative."* still matches with no `for` in it. **AND A THIRD MISS, FOUND BY THE REPLAY SUITE RATHER THAN BY REVIEW:** **`"Live representative."` DID NOT LATCH** — `CA0cecc9296e`, 2026-09-14, 368 seconds, one of the 17 that left no ticket, from the number that rang **six times** that evening, whose last words at 23:01 were *"Why you sending me to the same AI thing again? I need to talk to a human being."* Every verb branch needs a verb and there is none; `A_REAL_PERSON` exists precisely so a bare noun PHRASE can count, and it listed only `live person`, `real person`, `actual person` and `human being` — the same construction with a different head noun. **THE ADJECTIVE IS THE SAFETY PROPERTY, NOT THE NOUN**, which is why this is not the bare-noun widening the section above refuses: the measured danger here is the caller's own JOB TITLE (23 of 24 `coordinator` mentions), and `live`, `real` and `actual` are words a caller reaches for to say *not this machine*, never words they introduce themselves with. "Representative." alone is still not an ask and a describe block goes red if that changes. **AND A FOURTH, A P1, WHERE THE MODULE'S OWN REASONING CONTRADICTED ITS OWN CODE.** `connect(?:ed|ing)?` matched *"Caller was connected to the representative earlier."*, *"Caller was NOT connected to a representative."* and *"Caller was connected to the office last week about a referral."* — all reports of something that already happened. Three lines above that branch sits this module's own explanation of why `transfer` is deliberately NOT inflected (*"routinely narrates something that already happened to a record or a patient"*), and I inflected `connect` anyway when widening it for *"asked to be connected"*. **THE COST IS WORSE THAN A STRAY DIAL NOW:** a false latch on `callerRequestedHuman` grants handoff eligibility, which opens the queue choice, and since the v14 ruling an accepted queue choice files NO TICKET — so a narrative about a PREVIOUS connection could dial the queue and suppress the record. The inflections now require a request lead-in (`REQUEST_LEAD`); bare `connect` keeps none, because imperative and infinitive cannot narrate a past event. **AND THE NEGATION GUARD NOW COVERS EVERY BRANCH**, not just `ASKED_FOR` — plus it may govern through a request verb, since *"never ASKED TO speak with someone"* negates `asked` while `SPEAK_TO` matches at `speak`. **ABILITY-NEGATION IS DELIBERATELY UNPINNED IN BOTH DIRECTIONS:** my first draft asserted *"was not able to speak with someone"* must not match, which was careless — it negates the OUTCOME, not the desire, and a caller who could not reach a person is precisely one who wanted one. Today the guard splits those by accident of spelling, and a test says so rather than pretending otherwise. **FOUND BY CODEX (P1, #305) AND CURSOR IN THE SAME ROUND, from opposite sides of the same branch** — two independent reviewers converging is what got it looked at instead of filed as an outlier. 69 assertions; mutations caught: removing the branch (8), dropping `operator` (2), dropping the boundary (3), removing the negation guard (5), making `for` optional again (3), **the narrative-wide negation (1)** and dropping the contraction from the negator (1); plus, for the P1: inflections needing no request lead (3), bare `connect` swallowing the inflections (3), `SPEAK_TO` skipping the guard (3), `CONNECT_TO` skipping it (3) and the negator unable to govern through a verb (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: PCP calls containing "not able to put you through" where the caller stated an organisation — 10 of 170 on 2026-09-14, target 0. The guard: PCP transfer ATTEMPTS must not rise on calls where no entity asked, because this widens a grant that ends in a real dial into a queue staffed by three or four people |
| **v21** or earlier — NOT the date | RULE ZERO 2b/2c on the PCP intake: the format in the question. Three wordings, each with its own evidence from 2026-09-14, and **no question removed and no required field changed** — that is the interrogation (D4), a POLICY matter and the operator's under standing instruction 1. **`callerFacilityType` is an EIGHT-VALUE ENUM asked as an open question** — *"What type of healthcare organization is that?"* — so a caller cannot tell it is a multiple choice, and at least six answered with the ORGANISATION NAME AGAIN (Regal Medical Group x4, Children's Surgery Centers, Optum). It now names the common options; deliberately not all eight, because a spoken question reciting eight categories is not one anybody answers, and `other_healthcare_organization` is the catch-all the classifier already has. **`patientDob` was the ONE LANE ASKING BARE:** this file's own compliance table records Rule 2b satisfied on "all four lanes — `opticalAgent.ts:193`, `surgeryAgent.ts:203`, `techAgent.ts:189`, `recordsAgent.ts:192`, plus no-ivr and answering-service", and PCP is simply absent from that list while its prompt carried no format at all. Now month, then day, then year, which is what makes the answer parseable — `dobParts.ts` records what the alternative costs. **`statedRelationship` followed `callerRole` closely enough to read as a rephrase**, and this file already records the pair drawing the same answer twice; it now asks about the caller's involvement in the patient's care rather than about their role a second time. **ALSO: a question is now worded in exactly ONE place.** `REQUIRED_PROMPTS` kept its own copies of `callerName` and `callbackNumber`, so the same spoken line lived in two files — the shape that let the noun lists in `explicitAsk.ts` drift and cost the operator his own transfer on `CAa2a3a1c1`. **STILL A VIOLATION AND DELIBERATELY NOT FIXED:** `REQUIRED_PROMPTS.patientName` asks *"the patient's first and last name?"* — two fields in one breath, which RULE ZERO 2b forbids in as many words. Splitting it means splitting the required field behind it, which changes the gate rather than the wording. OPEN FOR WAYNE. **AND EVERY DIRECTOR ASK NOW ENDS WHERE THE TURN ENDS** (Codex P2, #303): `patientDob` was the only entry in `PROMPTS` written as a STATEMENT, ending in a period, while `pcpAgent.ts:190` defines the turn boundary as *"Your turn ends the moment the question mark lands"* — directly under the one-question-then-silence rule this line's callers complain about most. It had also drifted from the four lanes this very entry cites as compliant: optical, surgery, tech and records all say *"And may I please have your date of birth, starting with the month, then the day, then the year?"* and all four end in a question mark. PCP now says the same about the patient. `ticketRequirements.test.ts` and `pcpIntakeDegradation.test.ts` already asserted this over `REQUIRED_PROMPTS` and `nextRequiredAsk`; `PROMPTS` — the list the model actually gets its next question from — had no such assertion, which is how a statement got in, and it has one now. `src/pcp/questionsCarryTheirFormat.test.ts` — 27 assertions, 7 mutations, 7 caught. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP calls where the facility-type answer repeats the organisation name — 6+ on 2026-09-14, target 0; and `dobShape` on PCP refusals, which has no PCP before-arm at all because the lane never asked in parts. The guard: median caller lines before a filing tool fires must not RISE — a clearer question should shorten the intake, and if it lengthens it the wording is worse, not better |
| **v22** or earlier — NOT the date | the PCP recording disclosure. **219 calls on 2026-09-14 and not one told the caller the call was recorded.** The greeting was *"Thank you for calling Azul Vision PCP Support. How can I help you today?"* on every single one — no disclosure, no statement that the caller is speaking to an automated system. California is a two-party-consent state and this is a healthcare practice, so it is a compliance gap rather than a stylistic one. **The clause is `noIvrAgent`'s, verbatim** — *"All calls are being recorded for quality assurance purposes"* — an operator-approved sentence already live on another lane, not one written here. **DELIBERATELY NOT COPIED:** the "dial 911" sentence and "our offices are currently closed". no-ivr carries those because it is the after-hours line with no humans behind it; PCP is a business-hours professional line, and adding a clinical-safety instruction to it would be inventing a rule rather than applying one (standing instruction 1). **IT LIVES IN THE GREETING, NOT THE PROMPT,** and that is the load-bearing choice: on the runtime the bridge plays the greeting as AUDIO before the model's first turn and `withGreetingAlreadyPlayed` then tells the model not to repeat it, so a disclosure in the prompt is one the model MAY say while a disclosure here is on every call by construction — the same reasoning #299 applied to the no-ivr greeting block a day earlier. **THE FOUR QUEUE LINES STILL HAVE NO DISCLOSURE — that is task #79, ~397 calls/day, and it is NOT fixed here.** `src/pcp/recordingDisclosure.test.ts`, 6 assertions including a length ceiling, because the greeting is dead air the caller waits through before they can speak. **THE LITERAL ALONE WAS ONE DATABASE ROW FROM USELESS** (Codex P1, #304): both live paths prefer `agents.welcome_greeting` over the registry string — `chooseGreeting` (`voiceRuntime.ts:146`) and the old core's override (`voiceAgentRoutes.ts:4423`) — and both ask `missingMandatoryCopy` whether the configured string still carries what the lane must say. `MANDATORY_GREETING_COPY` had ONLY a `no-ivr` key, so it answered `[]` for any PCP string whatsoever and a row with no disclosure would have won silently. `pcp: [RECORDING_DISCLOSURE]` closes it on both paths at once, the predicate REFERENCED rather than copied because it has survived four Codex rounds (the adverb hole, the token-versus-statement inversion, the *"monitored or recorded"* coordination false-reject) and a second hand-written copy is the `explicitAsk.ts` noun-list shape. **AND THAT FIX WALKED INTO A COMMENT THE OLD CORE HAD WRITTEN ABOUT ITSELF.** `voiceAgentRoutes.ts:4455` read `agentSlug === 'no-ivr' ? WELCOME_GREETING : null` under *"No lane but no-ivr has mandatory copy today, so this is unreachable"* — and giving `pcp` mandatory copy made it reachable, so a PCP call with lost in-memory metadata AND a non-compliant row would log `✗✗` and let the MODEL open the call, which this file records as how the disclosure and the 911 direction went missing in the first place. The #304 fix alone would have traded *recorded without a disclosure* for *recorded without a disclosure AND unscripted*. Narrow — PCP has been on the runtime since 2026-09-04 — but one routing decision away, and the comment asserting it could not happen was now false. Fixed as a TABLE rather than a second ternary arm (`src/services/compliantFallbackGreeting.ts`): `compliantFallbackGreeting.test.ts` walks the exported `MANDATED_COPY_LANES` and goes red the moment a lane has mandatory copy and no compliant greeting behind it, and separately runs each fallback back through `missingMandatoryCopy` for its own lane — a rescue string that does not carry the sentence it is rescuing is worse than none, because it looks like a rescue. 5 assertions, 3 mutations, 3 caught: the call site reverted to the hardcoded ternary (caught by reading the file, not the table — the sink-versus-source device), `pcp` dropped from the table, and a fallback with the disclosure taken out of it |
| **v23** or earlier — NOT the date | the queue-choice question being answerable. **`CA02f7febc`, 2026-09-14, 124 seconds, the entire call:** greeting → caller says *"Representative?"* → the 53-word warning ending *"Would you like me to connect you, or take it here?"* → caller says **"Me."** → end of transcript, and **no ticket of any provenance exists for that call SID.** The caller answered the question and left with nothing. **"Me." maps to NEITHER option.** The question offered two VERB PHRASES — "connect you" and "take it here" — and the reply is a pronoun that reads equally as "connect ME" or "YOU take it, not me", so `callerAcceptedQueue` could not be filled honestly and the tri-state's `not_established` branch was the only correct one. **THE FIELD IS A BOOLEAN AND THE QUESTION WAS NOT:** `readQueueChoice` takes `boolean \| undefined`, so the answer has to be yes or no; asking an either/or between two paraphrases is RULE ZERO 2c in its purest form — the shape of the question not matching the shape of the field. It now ends on ONE proposition. It was also 53 words before reaching the question, marked `[interrupted]` on 8+ calls that day, and `CA606bc754` answered it with *"For how long am I going to stay representative? The zero doesn't even have, they transferred me here."* **EVERY CLAUSE THE OPERATOR APPROVED ON 2026-09-13 SURVIVES, in their own words down to "transfers with you"** — which `queueIsAChoice.test.ts` already pins verbatim, and keeping it was the right call over loosening that assertion to fit new phrasing. `queueChoiceIsAnswerable.test.ts` pins each clause SEPARATELY so a later trim cannot quietly drop one. **THE TRI-STATE IS UNTOUCHED:** silence is still not consent, only an explicit yes suppresses the ticket, and that property still belongs to `queueIsAChoice.test.ts`. 8 assertions, **5 mutations, 5 caught**, including one that smuggles a second proposition back into the closing question. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: PCP calls that reach the queue choice and end with neither a ticket nor a transfer — at least 1 on 2026-09-14 (`CA02f7febc`), target 0. The guard: the share choosing the QUEUE must not jump, because a question that is easier to say yes to is also easier to say yes to by accident |
| **v24** or earlier — NOT the date | the date-of-birth carry instrument. A `date_of_birth` refusal now records `outcome.carry`: `fired` \| `no_entry` \| `entry_without_dob` \| `name_mismatch` \| `bad_call_sid`. Diagnosis is PR #307 (`the-dob-carry.md`). **This is not a fix.** It does not stop the person-base wipe (Bug A, 24 calls) and it does not change inherit. `dobShape` still answers "did the model send the field?" (`(none)` on 93 of 93 refusals on 09-14); `carry` answers "why didn't inherit fill it?". `name_mismatch` is the discriminator for Bug B (32 certain matches that still refused). A build without this cannot tell those two apart from SQL. **NOT MEASURED IN PRODUCTION.** The number it makes readable: among runtime `file_*_ticket` events with `missingFields` containing `date_of_birth`, the share of each arm. The guard: filing behaviour must not move — a refusal that used to file still files, a refusal that used to refuse still refuses |
| **v25** or earlier — NOT the date | chart date-of-birth inherit (the fix). Empty must not overwrite a full DOB already in `verifiedIdentity` for the same person (Bug A — person-base lookup wiping the v11 pre-context date). When the ticket first+last matches the stored name, `file_*_ticket` puts chart `patientBirthMonth` / `Day` / `Year` on the create payload even if the model omitted `date_of_birth`. Does not invent a date. Does not require DOB on create-ticket. Does not promote `certain: false`. Bug B: `nameKey` treats hyphen / accent / apostrophe as the same person; nicknames and maiden names stay refused and still read as `carry: name_mismatch`. The v25 instrument rides along. **NOT MEASURED IN PRODUCTION.** Before-arm is 2026-09-14: 94 DOB refusals / 644 substantive, 61 no ticket. The number: runtime `date_of_birth` refusals on callers already addressed from their record (51 that day), target down. The guard: tickets filed with a date of birth that is not the patient's must not appear |
| **v26** or earlier — NOT the date | the recognised-caller block being ONE thing the runtime owns. Operator, 2026-09-15: *"the things that are applicable to any conversation should be in the runtime; things applicable to that agent itself should be in the prompt"* — and caller recognition is applicable to any conversation. It was written FOUR times instead, inline in `opticalAgent`, `surgeryAgent`, `techAgent` and `recordsAgent`, and the copies drifted into contradicting each other. `personaliseGreeting` (`greetingPersonalisation.ts:147`) replaces the greeting's closing question with *"Am I speaking with <name>?"*, so the greeting ASKS it; tech and records said so, optical and surgery told the model to *"go straight to confirming"* and ask it again. **Measured 2026-09-14/15 over substantive runtime calls whose transcript contains the phrase, where the lane's wording is the only variable: optical 7 of 76 asked TWICE (9.2%), surgery 3 of 85 (3.5%), tech 0 of 142.** Zero on the lane worded correctly. **THE RULE CHANGE BESIDE IT IS THE OPERATOR'S, AND IT IS THE HALF THAT MOVES A NUMBER.** The old block said *"A first name is not verification. Ask for the last name in their own words, and still collect the date of birth."* The INTENT is RULE ZERO step 2 — validate a phone match before trusting it — and the implementation inverted the outcome: the caller's spoken surname went to `verifiedDobFor`'s name guard, which reads ANY textual difference as the wrong person (an accent, a compound surname, a mis-hearing), so a confirmation mechanism became a rejection mechanism and the patient lost a date of birth the process was already holding. On the 30 certain-phone date-of-birth refusals of 2026-09-14 (`src/tools/dobNameMismatch.test.ts`, the corpus) **24 were greeted by name, 19 of those were then asked for their last name anyway, and 27 of 30 were asked for both.** The validation did not go away — it moved to the answer the greeting's own question already collects, which discriminates: **228 callers affirmed it and 13 denied it** over the same period. An affirmed greeting now ends the identity step; a DENIAL still discards the match entirely and the block self-destructs, which was always right. **WHAT WAS NEARLY LOST IN THE MOVE, and what caught it:** the first draft dropped the *"NEVER open with 'can I get your name and date of birth' when you have a match"* bullet, keeping its reasoning and losing its imperative. `opticalAgent.test.ts` failed — and optical is the ONLY one of the four that had a test at all, which is exactly how three inline copies drifted unnoticed. **THE DRIFT GUARD IS THE DELIVERABLE AS MUCH AS THE BLOCK** (`src/runtime/recognisedCallerBlock.test.ts`), because the operator asked for one in as many words: *"maybe put in some type of guard against that type of drifting."* It walks the exported `RECOGNITION_BLOCK_LANES` and fails when an agent drops the import, stops calling it, or carries an inline copy of any of the block's own sentences — comparing PROMPT TEXT with full-line comments stripped, so a comment quoting the rule is documentation rather than a second copy. It also runs `personaliseGreeting` per lane and fails if a greeting stops asking the question the block asserts as fact, and it pins the lane table itself, because deleting a lane from the table would silently stop guarding it. 42 assertions across the two files; **11 mutations, 11 caught** — a lane re-inlining the block (5 fail), an agent keeping the import but not calling it, the *"go straight to confirming"* wording returning, the YES bullet reverting to the old rule, the denial bullet deleted, the NEVER-open bullet deleted, the block emitted for an UNMATCHED caller, the name no longer interpolated, a lane losing its greeting style, and a lane quietly dropped from the table. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: callers asked *"Am I speaking with X?"* twice — 7 of 76 optical and 3 of 85 surgery on 2026-09-14/15, target 0 on both, tech's 0 of 142 is the control that must stay 0; and runtime `date_of_birth` refusals on callers the greeting already addressed by name — 51 on 2026-09-14, target down. The guard: a caller who DENIES the greeting's question must still be treated as unidentified, so tickets carrying a date of birth that is not the patient's must not appear |
| **v27** or earlier — NOT the date | the identity ask script AGREEING with the block above it. v27 made the recognised-caller block say *"the identity step is DONE. Do not ask for their last name and do not ask for their date of birth"* — and left `### Lead the ask`, ELEVEN LINES BELOW IT IN THE SAME PROMPT, saying *"May I please have your last name?"*, *"And may I please have your date of birth…"* and **"say the order EVERY TIME"**. Two contradicting instructions on one page, for exactly the population v27 was written for. **IT IS A REGRESSION, NOT A PRE-EXISTING BUG, AND THAT IS THE PART TO READ:** the OLD block said *"A first name is not verification. Ask for the last name in their own words, and still collect the date of birth"* — which AGREED with that script. Changing the rule and leaving the script alone is what created the contradiction. A model handed both may keep asking, and then the affirmed match buys the caller nothing: the surname comparison happens anyway, `verifiedDobFor`'s name guard refuses anyway, and **v27's own number does not move while the change reads as shipped**. Found by Codex (P1, #307) AFTER the merge — the review completed at 12:54 on `0861d7d`, twelve seconds after the squash landed, which is its own lesson about marking a draft ready and merging in the same minute. **THE SCRIPT WAS A FIFTH BYTE-IDENTICAL COPY**, in `opticalAgent`, `surgeryAgent`, `techAgent` and `recordsAgent` — the same drift shape v27 existed to remove, one section further down the same files. `identityAskScript(pc)` now takes the same pre-context as the block and lives beside it, deliberately in ONE module rather than two: they are one decision — whether we are asking this caller to identify themselves — and split across two files they drift again. **THE QUESTIONS SURVIVE IN BOTH ARMS, and that is load-bearing:** the block self-destructs on a denial (*"they said NO, or gave a different name"*) and the model then needs those words, and records may be collecting for somebody who is not the caller. A recognised caller loses the INSTRUCTION TO USE the script, never the script. **The unrecognised arm is byte-for-byte what all four lanes carried before**, so that population is provably unchanged — a mutation that quietly drops its "say the order every time" goes red. 52 assertions; **5 mutations, 5 caught**: the recognition branch forced false (the regression itself, 3 fail), the questions dropped from the recognised arm, the unrecognised arm losing its instruction, a lane pasting the script back inline, and the deferral sentence deleted so the contradiction returns. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number is v27's, unchanged and now actually reachable: runtime `date_of_birth` refusals on callers the greeting already addressed by name — 51 on 2026-09-14, target down. The guard is also v27's: a caller who DENIES the question must still be treated as unidentified, so tickets carrying a date of birth that is not the patient's must not appear. **SAME SHIP, ONE HEADING DOWN — Cursor second-pass on #310.** Swapping `### Lead the ask` left `### How a call runs` saying `identity_is_certain` false means *"the number matches more than one person"* and telling the model to collect last name and date of birth. After #292 that flag is ALSO a unique `patients_master` phone hit (`identityUnconfirmed`). A recognised caller who affirmed the greeting then calls `lookup_patient`, gets false, and obeys step 1 — v27's own number does not move while v28 reads as shipped. `identityCertainMeaning(pc)` now lives beside the script. A recognised caller is told false is NOT more than one person: confirm the greeting, do not re-collect a last name or a date the record holds. Denial, a different name, or a candidate count still asks — the words stay. An unrecognised caller is still told to collect last name and date of birth; what changed is the fact (false is not only "more than one person"). Does not invent a date. Does not require DOB on create-ticket. Marker stays v28 — this is the leftover that made the draft not pull-safe, not a new ship. Tests that only asserted `identityAskScript` stayed green with that paragraph intact; the leftover phrases are now banned from the four agent sources and the built prompts are checked so a computed-and-discarded helper cannot hide |
| **v28** or earlier — NOT the date | the candidate-count exception being stated BEFORE the prohibition it excepts. **Codex P1 on #310, and it landed FOUR MINUTES AFTER THE MERGE** — ready at 14:46:14, merged at 14:46:23, review completed 14:50:25. The v27 row already records this exact pattern one PR earlier; it happened again on the PR that fixed it. v28's recognised arm said *"that is NOT more than one person"* and *"Do not collect their last name and do not collect their date of birth"* FIRST, and allowed the candidate-count exception only in its closing sentence. **A model reading in order meets the ban before the carve-out.** THE CASE IS REAL: `lookupPatient`'s `several` branch returns `identity_is_certain: false` WITH a `candidate_count` and a message telling the model *"Ask for their full name and date of birth — do not read any history back until they have given both"* — so the TOOL said ask while the PROMPT said do not, on the same result. Pre-context matches ONE person by phone; `lookup_patient` then searches phone AND name strings, so a recognised caller can come back ambiguous — **28 of 135 phone matches resolve to 2-3 people (~21%)** and the operator's own number resolves to eight. The cost is the guard v26, v27 and v28 each name: a ticket carrying a date of birth that is not the patient's. Ambiguity is now stated FIRST; the prohibition wording is kept VERBATIM so the existing assertions still bite, and the new tests compare POSITIONS rather than existence, because an assertion that both phrases merely exist passes under the broken order too. **ROUND 2, AND CODEX WAS RIGHT AGAIN: the first fix keyed on the wrong thing.** Scoping the rule to a false flag WITHOUT a `candidate_count` looked right and was not, because `certain` is false in THREE shapes and only ONE carries that FIELD: (1) `found:false`, the `several` branch, which does; (2) `found:true` with `identityUnconfirmed` TRUE, warning *"nobody has confirmed the CALLER is that person"* — one record, the no-recollection case; and (3) `found:true` with `identityUnconfirmed` FALSE, warning *"matches N different people on file, and what follows is only the most recently seen of them"* — **genuinely ambiguous, with the count only inside the PROSE and no `candidate_count` field anywhere** (`opticalTools.production.test.ts:165` pins exactly that shape). So round 1 told the model to read shape 3 as a single match while the tool was handing back the WRONG patient's record and saying so — the defect removed from one door and reintroduced through another. The rule now keys on WHAT THE WARNING SAYS, which is the code's own discriminator (`sharedPatientTools.ts:330`): several or different people -> ASK, and ONLY the unconfirmed-caller warning admits the single-record reading. **The lesson is the transferable part: a rule keyed on a FIELD is only as good as that field's presence on every branch that should trigger it — enumerate the branches before choosing the key.** The correction costs ~12 tokens per lane, so the three ratchets below were RAISED once (1936/1727/2040 -> 1948/1739/2051) with the reason recorded beside them: the ratchet going red is the ratchet working, and correctness beats twelve tokens on an arm already 200-350 over. **IT IS NOT MEASURABLE FROM SQL AND THAT IS WHY IT SURVIVED:** `toolTimeline`'s outcome allow-list (`toolTimeline.ts:249`) carries `matched_by` and `identity_is_certain` and NOT `candidate_count` or `found`, and BOTH the multi-person branch and the plain not-found branch return false with no `matched_by` — byte-identical in the timeline. A query for "how often is false actually ambiguous?" returns **0 on every lane**, and that zero is the instrument, not the fleet. Do not quote it. **BESIDE IT, A SECOND AND LARGER FINDING THE SAME SHAPE: THE TOKEN CEILINGS MEASURE THE PROMPT NOBODY IS RECOGNISED ON.** `queuePromptRulings.test.ts` builds every lane with `{ callerPhone }` and no `precontext`, so all four ceilings grade the COLD arm. Measured 2026-09-15, the recognised arm costs a uniform **+354 tokens** and **three of four lanes are already past the operator's ceiling on it**: tech 1948 against 1600, records 2051 against 1750, optical 1739 against 1500; only surgery (1652 against 1800) fits. NOT a v29 regression — the block was inline in all four agents long before it moved into the runtime, and v29 adds ~10 tokens of the total. What is new is that anybody can see it. **It matters more than the number looks, because #88/#110 exist to make pre-context recognise MOST callers (135 of 170 are on file) — succeeding there moves nearly every call onto the arm that busts the ceiling.** The three are pinned as RATCHETS at today's values rather than enforced at the operator's numbers: lowering them means deleting capability, which is his call under standing instruction 1 and a `docs/BACKEND_HANDOFF.md` change, not a test's. A fourth test asserts the warm build is larger than the cold one on every lane, because if `precontext` ever stops reaching the block the ratchets would pass while measuring nothing. **OPEN FOR WAYNE: whether the recognised arm gets trimmed to the stated ceilings, or the ceilings get restated for the arm that actually serves a recognised caller.** 97 assertions across the two files. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: tickets filed with a date of birth that is not the patient's — must stay 0, and this narrows the path to one. The guard: a recognised caller whose lookup is UNAMBIGUOUS must still not be re-asked, so v27/v28's own number (51 DOB refusals on recognised callers, 2026-09-14) must still fall |
| **v29** or earlier — NOT the date | **WITHDRAWN 2026-10-01 for the accepted arm — the operator restored the no-ticket rule; see the v86 row. The settle machinery below still serves the not-established and never-asked paths, and the accepted arm's never-answered case.** a ticket for the caller who chose the live queue, and a ticket that ever learns what the dial did. **THE OPERATOR REVERSED HIMSELF, 2026-09-15: *"yes to the v14 reversal."*** v14 (09-13) said *"We Will Not create tickets for anyone that chooses to be transferred. if they drop off, their record is lost. Their choice"*, on the reason that the queue answers at 36% and nobody works the voicemails. Asked on 09-15 whether to go back to Rosa's 09-08 design — file it anyway with a status that does not claim a person was reached — he said yes. **WHAT v14 COST WHILE IT STOOD:** `tickets.pcp_handoff_*` is the only working PCP transfer instrument (this file says to measure them there and never from `call_logs`), so the accepted arm was invisible in it, and the 36% the ruling rests on could not be re-measured on the callers it applied to. Rosa's reason was never answered, only outvoted: a caller who gives up in hold music has no record anywhere and nobody knows to call them back. **THE STATUS IS WHAT MAKES BOTH TRUE AT ONCE** — `DIALING` with `humanAnswerStatus = TRANSFERRED_TO_QUEUE` and no `connectedAt`, so the app's `humanHandoffOccurred = finalStatus === 'CONNECTED'` stays false and **v20 is untouched**: it was never the ticket's existence that claimed a human, it was the status. **TWO THINGS THE CHOICE STILL GOVERNS AND THIS DOES NOT CHANGE:** the empty round (*"they asked for a person, get them to a person"*, 09-13) and the sweep's exit. `suppressesTicket` answered all three questions with one boolean, which is the `connectsToHuman` welding this file already records — so it is DELETED rather than made to return false, and the two survivors ask `choseTheQueue`, which names what it decides. **THE SECOND HALF IS THE MEASUREMENT, and without it the reversal only half works:** the ticket said `DIALING` FOREVER, because `handoff_to_pcp` returns while the queue is still ringing and Twilio's `<Dial action>` callback lands minutes later on its own HTTP request, reaching `call_logs.transfer_outcome` and nothing else. A lane callback (`onBlindDialSettled`) is now registered before the redirect and SNAPSHOTTED onto the pending dial for the same reason `briefingGaps` is — `attempt`'s own `finally` deletes the side channel, because it holds a caller's name and callback number. The app upserts on `callSid` and updates the handoff columns whenever a payload carries a `handoff` block, so this needs **no new endpoint and nothing from that team**. `queue_answered` leaves `finalStatus` at `DIALING` and puts the bridge duration in `humanAnswerStatus` (a two-second bridge is a caller who gave up in hold music, and only the number says so); `no_answer` / `failed` go to `NO_ANSWER` / `FAILED` with `fallbackTicketStatus: OPEN` and `CREATE_TASK`, which the app permits against a HAND_OFF-default purpose for exactly those three statuses. **ORDERING IS THE SAFETY PROPERTY:** `deps.record` writes `call_logs` FIRST and the lane callback cannot cost us it — a throwing lane is swallowed into a log line, and the webhook still answers Twilio 200. **REGISTERED ONLY WHEN THE PRE-DIAL WRITE SUCCEEDED**, because the app INSERTS when it cannot find the `callSid`, so registering behind a failed write could open a SECOND ticket minutes later carrying a dial outcome and no intake. `src/pcp/queueDialReachesTheTicket.test.ts` tests the CHAIN and not just its last link — v20 is the worked example of both ends being covered while the two links between them were not — with links 3 and 4 pinned by reading the source, the device `ticketRequirements.test.ts` already uses. 12 assertions there plus the rewritten `queueIsAChoice.test.ts`; **8 mutations, 8 caught**: `queue_answered` promoted to CONNECTED, the runtime dropping the snapshot, the webhook never calling back, the v14 suppression returning on either write, the welding returning, `no_answer` no longer re-opening the request, and the settle registering behind a failed write. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP tickets for accepted queue transfers — 0 under v14, target ~the transfer count; and tickets stuck at `DIALING` with no later status — target 0. The guards: `human_handoff_occurred` must stay FALSE on every blind transfer (v20's number, 20 on 2026-09-14, target 0), and PCP transfer ATTEMPTS must not fall, because filing again must not come with a gate that dials less |
| **v30** or earlier — NOT the date | a ticket for a PCP call the model never classified. **Measured 2026-09-15, PCP's first 2h23m on the current build: 32 real conversations that did not transfer, 18 with NO TICKET OF ANY PROVENANCE.** `sweepPcpUnfiledCall` turned every one away, and the gate is why — `toldUsSomething` demands a `callPurpose` AND an identity field, and on these calls the model recorded no purpose at all. The v18 row already names this as the residual gap it deliberately left (*"a caller who asks for a person with no purpose recorded at all is a narrower residual gap, and it is noted for Wayne rather than papered over here"*); this closes it, with his answer. **OPERATOR, 2026-09-15, THREE QUESTIONS AND HIS OWN ANSWER TO THEM:** *"are we capturing the transcripts for these calls? … if we're capturing the transcripts then why are we not reading the transcripts for the call purpose … actually now that I think about it, why don't we just leave it in the PCP queue and let the PCP agents route it manually to where it needs to go — rather safe than sorry rather than dump it into medical records and create a case unnecessarily"*, and on the slug, *"anything we dont classify we log as a new slug."* **READ THE TRANSCRIPT, DO NOT CLASSIFY FROM IT** — the third sentence supersedes the second, and that is the whole design. The caller's own lines go ON the ticket so a human can route it; the SLUG is `unclassified_call`, landing in PCP Support where a person already looks. Machine-guessing a department here would be the `'surgery center'` mistake of 2026-09-08 with worse consequences: an `mr_cases` row opened on a guess starts a statutory clock on a request nobody has read. A test drives a transcript containing BOTH a records cue and a surgery cue and asserts it still files unclassified. **THE ADMISSION IS `saidMoreThanTheirOwnIdentity`, REUSED NOT REWRITTEN.** `requestSweep.ts` is the queue lanes' teardown filer and this file lists it under "do NOT rebuild these"; that predicate is deliberately the narrowest possible version, and its own docstring already says it *"does NOT try to decide what a request is … meaning is the model's job and not a regex's"* — the operator's conclusion, already written down. Silence files nothing; filler alone files nothing. **ONE GUARD IS GENUINELY WEAKER ON THIS ARM AND IT IS STATED RATHER THAN HIDDEN:** the predicate subtracts the caller's own name from their own lines, and it can only subtract a name we CAPTURED — a call the model never classified is usually one where it never recorded a name either, so *"This is <name>."* and a hang-up WILL file here where on other arms it would not. Accepted, in the direction that predicate's docstring already chose (*"the failure mode it accepts is filing the occasional identity-only ticket, which is the right direction to err on a path whose whole purpose is not losing requests"*): a department-18 ticket a staffer discards costs ten seconds, a lost request costs a caller, and closing it properly means a name DETECTOR, which is standing instruction 3 in as many words. **Both behaviours are asserted, both ways**, rather than one of them being quietly pretended away. **SHIP ORDER IS LOAD-BEARING: ticketing-app #270 must deploy FIRST.** The app's `PCP_CALL_PURPOSE_SLUGS` is a `z.enum`, and a slug the agent sends that the app does not declare is HTTP 400 — the precise mechanism that turned 17 requests into nothing on 2026-09-14. The exposure is bounded and worth stating exactly: these calls file NOWHERE today, so shipping out of order costs them nothing they are not already losing, but it buys nothing either. `replay20260914.test.ts`'s `APP_ACCEPTS` carries the dependency in a comment so a green suite cannot imply the app is ready. `src/pcp/unclassifiedCallStillFiles.test.ts` — 11 assertions, synthetic transcripts only (RULE THREE: real SIDs and shapes in the repo, real words on disk). **5 mutations, 5 caught**: the admission removed, the admission widened to every unclassified call, the slug reverted to a specialist guess, the caller's words dropped from the narrative, and the slug dropped from the Remix policy list. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: PCP substantive calls with no ticket of any provenance — **18 of 32 on 2026-09-15, target near 0**. The guards: department-16 and department-9 tickets from PCP must not rise (an unclassified call must never be auto-routed to a specialist queue), and PCP tickets a staffer closes as junk must not rise materially — that is the azul 2026-07-28 shape, where 9 of 12 spurious sweep tickets were callbacks for patients already helped |
| **v31** or earlier — NOT the date | the two Codex findings on #313, both correct, both on `main` before anybody read them. **The review started NINE SECONDS BEFORE the squash and finished six minutes after it** — ready 19:13:09, merged 19:13:22, completed 19:19:05. That is the THIRD time (v27 row: twelve seconds; v28 row: four minutes; now this), and the pattern is no longer a coincidence: the review is TRIGGERED BY the draft being marked ready, so checking for findings before merging can never see the one your own merge starts. **P1 — A TRANSIENT TICKET FAILURE HAD NO SECOND CHANCE ANYWHERE.** `handleBlindDialResult` fires the lane callback, forgets the pending dial and answers Twilio 200; Twilio has no reason to retry a 200 and the pending entry is gone, so a blip on the ticketing app left the ticket at `DIALING`/`HAND_OFF` for good. On a `no_answer` that is v30's entire point lost — the request is never reopened as an OPEN task and a caller who gave up in hold music is never called back. Confirmed before fixing: `createPcpTicket` has NO outbox behind it, unlike `createTicket`, which goes through `durableTicketFiling` → `ticketOutboxService`. **THE RETRY LIVES IN THE LANE, NOT THE TRANSPORT** — `blindTransferDialResult` knows about dials and TwiML and has no business knowing a ticket POST can fail transiently; its fire-and-forget contract is unchanged, and `persistSettlement` runs INSIDE the callback it already forgets, so Twilio still gets its TwiML immediately. ~26s over four attempts; a refusal `submitPcpTicket` produced ITSELF (`invalid_payload:`, `disposition_not_allowed:`) is NOT retried, because those are pure functions of the payload and the second try sends identical bytes to an identical check. **WHAT IT DOES NOT PROMISE, stated rather than implied:** it is in-process, so a deploy inside the retry window still loses the update; making it survive that means putting PCP payloads through `ticketOutboxService`, which today wraps only `createTicket` shapes, and that is a `docs/BACKEND_HANDOFF.md` change rather than something to smuggle in behind a P1 fix. **P2 — THE LONGEST CALLS WOULD HAVE FILED NOWHERE.** v31 pastes the caller's own lines into `narrative`, capped at 12,000, and `submitPcpTicket` safeParses BEFORE the wire — so a long enough call was refused locally with no POST and no 400 in `voice_agent_api_logs`, one console line. The calls with the most for a staffer to read were the likeliest to be dropped, by the code written to stop them being dropped. **THE FIRST FIX FOR IT WAS WRONG AND THAT IS THE PART WORTH READING:** budgeting the excerpt at the SWEEP's call site measured 11,925 characters, under the cap, and still filed nothing — because `annotateGaps` appends `[Intake incomplete — …]` AFTERWARDS, so the call site cannot see the string that is actually validated. It was found by instrumenting the real path after two rounds of arithmetic that each looked right. The clamp now lives in `annotateGaps`, the LAST hand on the narrative and one every PCP filing path already goes through, so no future caller can out-run it; the annotation is never what gets cut, because it names the fields a staffer still has to collect. `trimToBudget` cuts at a line boundary (the excerpt is a bulleted list of caller turns) and says on the ticket that it cut; the full conversation still goes out in `transcript`, cap 50,000. **AND A THIRD THING, PRE-EXISTING AND FOUND BY THE SAME RUN:** `schedulingReachesTheHub.test.ts` was the one PCP file that did not pin the clock, so `isLunchClosure()` turned `eligibleByAsk` off and three of its assertions went RED for one hour of every weekday. Caught at 12:40 Pacific, **reproduced on a pristine `main` checkout** to prove it was the clock and not the change under review, and fixed the way `lostRequestFloor.test.ts` and `queueIsAChoice.test.ts` already do it. `src/pcp/settlementSurvivesAFlake.test.ts` — 11 assertions, plus two wiring assertions in `unclassifiedCallStillFiles.test.ts` that go red if either fix is reverted at its call site while the helpers stay green (failure mode 10). **5 mutations, 5 caught**: the clamp removed from `annotateGaps`, the settle POST back to a bare `submitPcpTicket`, a deterministic refusal retried, `trimToBudget` never trimming, and the clock pin removed — that last one reproducing the exact three failures live. Full suite 4,086. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP tickets left at `DIALING` after a `no_answer` dial — target 0; and unclassified-call filings refused locally as `invalid_payload: narrative` — target 0, currently invisible in SQL because the refusal never reaches the wire, so read the `[PCP-TICKET] payload rejected` console line. The guard: tickets whose narrative LOSES the `[Intake incomplete …]` annotation must not appear — the body is what gets trimmed, never the annotation |
| **v32** or earlier — NOT the date | a bound on how many times the PCP intake may ask the same question. **Operator, 2026-09-16, naming this as one of his three priorities for the line: *"being able to quickly identify when we have an issue on the line like that, one that asks somebody something seven times or something like that, like that shouldn't be possible, right?"*** SEVEN IS THE MEASURED NUMBER, NOT A FIGURE OF SPEECH: `CA908f93dae322ed0e0dd862673ebf77fb`, 2026-09-15, 150 seconds, **no ticket of any provenance** — the caller said `"Representative?"` seven times and the agent asked `"What is the patient's first name?"` seven times. **ALL THREE OF HIS PRIORITIES FAIL IN ONE 150-SECOND CALL:** no transfer, no ticket, and nothing detected it. **NOTHING EXISTING COULD HAVE STOPPED IT, and that is why the bound goes in the director rather than anywhere else.** `toolCeiling`'s `identicalFailures` (3) and `perToolFailures` (6) count FAILURES, and every one of those `record_pcp_intake` calls **SUCCEEDED** — the model re-recorded `statedRelationship` from the same one-word reply eight times, and a success CLEARS those counters by design (rule 1 of `toolCeiling.ts`). `tool_call_count` reached 15 against a `perCallDispatches` of 40. `ticketRequirements.MAX_BLOCKS` (3) bounds how many times a FILING may be HELD, and no filing tool was ever called on that call, so that budget was never touched. The gap was a bound on the intake FORM repeating itself. **`MAX_ASKS_PER_FIELD = 2` is a judgement, not a measurement** — once to ask, once in case the first answer was mis-heard; deliberately not 1, because a genuine ASR drop on the first pass is common on this line. An exhausted field is skipped as a QUESTION, is NOT invented, and does NOT become "answered": it rides onto the ticket as NOT CAPTURED through the annotation path that already exists, which is the #288 unassigned-exit shape. **THE DECOUPLING IS THE LOAD-BEARING HALF.** `handoffEligible`'s SECOND arm reads "a complete intake on a HAND_OFF purpose" — the AUTO-transfer the operator withdrew on 2026-09-04 — and it read the same `missing` value the question does. Wired naively, spending the budget would have completed the intake by fiat and **DIALLED**: a caller put into the PCP queue because we gave up asking them a question. `next()` now computes `intakeIncomplete` (what the form genuinely lacks, budget-blind) separately from `missing` (what we ask next, budget-aware), and the handoff arm reads the former. That is the `connectsToHuman` welding this file already records, caught before it shipped rather than after. **THE BUDGET IS CHARGED BY `noteAsked`, NOT BY `next()`** — `pcpAgent` reads `next()` four more times per call (785, 842, 1154, 1852) for `handoffEligible`, `disposition` and `mayTerminate` without speaking to anybody, and charging inside `next()` would burn a caller's two asks with no question asked. Only `record_pcp_intake`, the one place a question is handed back to be spoken, calls it. **AND IT IS COUNTABLE FROM SQL**, deliberately: `askBudgetSpent` (field NAMES only, no caller data) reaches `tool_timeline` through the existing outcome allow-list, because the tool ceiling's own stops are console-only and no query can find one — this does not repeat that. **WHAT IT DOES NOT DO, stated rather than implied:** `ticketRequirements` is UNTOUCHED, so for the three fields a ticket genuinely needs (`callerName`, `patientName`, `callbackNumber`) the filing gate may still ask up to `MAX_BLOCKS` more times with its own wording — a worst case of 2 + 3 across two different budgets. Whether those two should share a counter is a POLICY question (the operator set `MAX_BLOCKS`, and the 2026-08-06 precedent is that tightening filing gates destroys requests) and is **OPEN FOR WAYNE**. On the seven-times call the change ends the `patientFirstName` loop at 2 and the request files. `src/pcp/directorAskBudget.test.ts` — 12 assertions, **6 mutations, 6 caught**: the budget removed from question selection, `handoffEligible` re-welded to the budget-aware value, the intake tool no longer charging, `askBudgetSpent` dropped from the decision, the budget charged by `next()` on every read, and `askBudgetSpent` dropped from the timeline allow-list. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP calls whose transcript repeats one agent question 3+ times — **1 on 2026-09-15 (worst 7), 0 on 2026-09-14, target 0**; and calls repeating a question at all — 18 of 09-15's, target down. The guard: **PCP tickets filed per substantive call must not fall**, because a form that asks less must not file less; and PCP transfer ATTEMPTS must not rise, which is what the decoupling exists to guarantee |
| **v33** or earlier — NOT the date | the PCP intake behaving like an ANSWERING SERVICE rather than a form. **Operator, 2026-09-16: *"ensure that the PCP line acts as a literal answering service. Meaning that it gathers the required fields, who is calling, what are you calling about, where are you calling from, who is this in regards to, and how would you like to receive the information. I think that is the crux of any request."*** **MEASURED FIRST, all 369 substantive PCP calls of 2026-09-14/15 — and the order was inverted.** Where the call died, by the last question asked: caller role 26 calls / 6 filed · caller name 23 / 2 · date of birth 20 / 1 · organisation 11 / 2 · facility type 9 / 6 · relationship 3 / 0 · **THE PATIENT 5 / 0**. **97 calls died inside the caller-credential block for 17 tickets (17.5%)**, and almost nobody died on a patient question because almost nobody survived long enough to be asked one. We collected five facts about the CALLER before asking who the call was ABOUT, so attrition ate the one field a staffer cannot work without. **AND THESE CALLERS SPEAK IN FRAGMENTS:** median first utterance under five words, **53% say three words or fewer** ("Referrals." "Appointment." "Representative?"), average 3.8 caller lines per 138-second call. Every turn spent on a credential is a turn not spent on the request. `CAd00fa911` (1,148 seconds, no ticket) is the argument in one exchange: the caller opened with the purpose unprompted, answered the name question with **name AND organisation** ("Karina from Optum Medical Clinics"), was then asked her role, her facility type and her relationship to the patient — and quit with "Speak to representative." **We never once asked which patient.** **WHAT IS NO LONGER ASKED — AND `callerRole` IS BACK IN v35, read that row before quoting this one:** `callerRole` (the single biggest killer), `callerFacilityType` (an eight-value enum read to somebody who just named their organisation), `statedRelationship` (drew the same answer as role, recorded twice in this file already) and `patientDob` (20 dead calls for 1 ticket; on a professional line the caller is reading a chart). **NONE OF THEM IS DELETED FROM THE STATE** — each is still recorded when volunteered, still travels on the ticket, and still feeds the records route, which reads `callerFacilityType` FIRST and falls back to prose by design. What changed is that we stop spending a TURN on it. **THE QUESTIONS NOW DO THE WORK THE TURNS USED TO.** `callerName` asks *"And who am I speaking with, and where are you calling from?"* because that is how professionals already answer it; `callerOrganization` stays a SEPARATE FIELD so a caller who gives both is never asked again while a caller who gives only a name still is — the funnel working with the field list rather than replacing it. `patientFirstName` asks *"And who is this in regards to — the patient's name?"*, moved from sixth of ten to third of four, with `patientLastName` catching the half-answer the same way. **THIS IS NOT RULE ZERO 2b BUNDLING**: 2b is about two facts a caller answers separately (name and date of birth). Who you are and where you are calling from is one self-introduction, and the measurement says they already give it as one. **THE REAL-WORLD PATH IS THREE QUESTIONS** — purpose (the greeting), name+organisation, patient — because caller ID seeds the callback. A test drives exactly that and fails if it grows. `src/pcp/interviewIsAnAnsweringService.test.ts` — 12 assertions, **5 mutations, 5 caught**: role and facility type returning to the asked list (8 fail), relationship and date of birth returning to the patient block (5), the name question no longer inviting the organisation, the patient question reverting, and `callerOrganization` folded away so the half-answer is never caught. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP calls dying inside the caller-credential block — **97 of 369 over 2026-09-14/15, target well down**; and median caller lines before a filing tool fires, which should FALL. The guards: **PCP tickets filed per substantive call must RISE, not fall** — a shorter form that files less has failed; and department-16 records routing must not fall, because `callerFacilityType` is no longer asked and the route now leans on its prose fallback |
| **v34** or earlier — NOT the date | the PCP line being LIGHTLY GATED, which is two changes the operator made in one morning. **FIRST, HE CORRECTED THE INTERVIEW — and he was right.** 2026-09-16: *"I think that that was pretty hasteful of you to just go by and create the interview like that. Because we know who's calling... the medical assistants, referral coordinators, things of that nature. We have to tailor this around them... obviously, who's calling, what's your title, what organization are you calling from, who is this request in regards to, and then how would you like to receive this information."* **`callerRole` RETURNS.** v34 deleted it on attrition data alone (26 dead calls for 6 tickets, the biggest single killer) — and attrition says what KILLS a call, never what a staffer NEEDS. Reading one as the other is the error. What the measurement actually indicts is the POSITION: role was question TWO, so a caller who quit on it took the whole request with them. `PROFESSIONAL_FIELDS` is now what we ask BEFORE the patient (purpose, name, organisation) and `PROFESSIONAL_ENRICHMENT` what we ask AFTER (title, email, callback) — a hang-up in the second block costs a job title on a ticket that files anyway. **AND HIS FOURTH AND FIFTH FIELDS WERE REDUNDANT:** *"what's the best number to reach you, and then how would you like us to get back to you?"* `pcpAgent.ts:510` already seeds `callbackNumber` from caller ID on every call, so asking it spends a turn on something we hold; the CHANNEL is the unknown, and on a professional line it is email — *"a lot of these people are calling from offices... I would probably use email. I would try to get the email for everyone that's on there, because if they're professionals, they have to have an email."* `callerEmail` is what the question funnels toward and `deliveryPreference` catches the caller who answers with a different channel, via `SATISFIED_BY` — **and that table caught a defect its own test found first:** a `patient_medical_records_request` is ALREADY asked *"How would you like to receive the records — by fax, by email, or by mail?"*, so without the entry the first draft asked the delivery question twice on the one purpose that had already answered it. **SECOND, THE FILING GATE IS OPEN.** Operator, same morning: *"it's like a voicemail... there doesn't need to be really any gating on either side... we shouldn't have any gates here about who's calling, why they're calling. The only thing that we are gating is if it's medical records, if it's something that doesn't belong here, then that's what we send out to the other departments."* `FILING_MAY_BE_HELD = false` makes `ticketReadiness`'s existing `spent` branch unconditional: the ticket files on the FIRST attempt with whatever the call produced, and everything missing is written on it. **DELIBERATELY NOT `MAX_BLOCKS = 0`, AND THIS IS THE PART TO READ.** That constant is a CONVERSATION budget shared with the records-delivery ask (`pcpAgent.ts` — `ticketBlocksUsed < MAX_BLOCKS`), so zeroing it would have stopped that ask firing at all and opened an `mr_cases` row with nowhere to send the records: the 2026-08-13 hard gate failing through a side door, on the one thing the operator explicitly kept gated. Two budgets that look like one number. `ticketRequirements.test.ts` goes red if MAX_BLOCKS is "tidied up" to match. **THE REVERT LEVER IS EXERCISED, NOT ASSUMED:** `ticketReadiness` takes `mayHold` as a parameter defaulting to the constant, so the old behaviour stays reachable from a test and cannot rot while it is switched off. **AND THE ANNOTATION STOPPED LYING.** *"The caller was asked and did not provide it"* was true while a filing could be HELD — that was the only route to it. Reachable on the first attempt it is a false statement about a caller on a durable record, which is the objection this module's own history records being raised in review on 2026-08-17 about a drug rep. It now says only `NOT CAPTURED ON THE CALL`. **`FIELD_PLACEHOLDERS` IS DOWN TO ONE ENTRY** for the same reason: `"Not provided"` in `pcp_caller_role` is a value a staffer reads, a report groups by, and the buildable role list would offer back as a role. It was a workaround for a required column wearing the clothes of a safety feature. **WHAT MAKES ALL OF IT SAFE IS ON THE OTHER SIDE OF THE WIRE, ticketing-app #275, AND THE SHIP ORDER IS THE HAZARD:** that app change makes the four caller credentials optional, adds `pcp_caller_email` / `pcp_delivery_preference` / `pcp_caller_role_key`, and — the load-bearing half — makes a SECOND POST on the same `callSid` ENRICH the row instead of returning `cached` and discarding it. Without that, filing early would FREEZE a thin ticket. **THE APP MUST DEPLOY FIRST.** Omitting a field the deployed app still requires is an HTTP 400, which is exactly how 17 requests became nothing on 2026-09-14; the reverse order is harmless. **WHAT IS NOT DONE, and was considered:** the operator also asked whether to stop reading the ticket number aloud and build the ticket from the transcript after the call. The readback instruction is live in FIVE places in `pcpAgent.ts` and removing it interacts with v18's lost-request-floor copy, so it is NOT in this build — and half of it already exists, because `ticketingSyncService.syncCall` posts the transcript onto the ticket at teardown. **AND THE "ALL PROMPT, NO TOOL" VERSION IS REFUSED, WITH EVIDENCE.** He floated making PCP a basic agent driven entirely by prompt. That was tried: rendering the question list into the prompt (#201) let the model READ AHEAD and fire two questions 1,141ms apart with no caller turn between them — `CAc88c6e9c`, 08-17, the caller answering *"You didn't give me a chance to respond."* `intakeScript.test.ts` exists to keep that list OUT of the prompt. So the one-question-at-a-time TOOL stays and the GATES go; those were always two different things. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP tickets carrying the literal `"Not provided"` in `pcp_caller_role` — every one filed since 2026-09-14, target 0; and PCP calls dying inside the caller-credential block — 97 of 369 over 2026-09-14/15, target well down. The guards: **PCP tickets filed per substantive call must RISE** — ungating that files less has failed outright; **department-16 records tickets must not fall**, since `callerFacilityType` is no longer asked and that route leans on its prose fallback; and **tickets must not LOSE a field between the first POST and a later one on the same call**, which is what the app-side enrichment exists to guarantee |
| **v35** or earlier — NOT the date | a first date-of-birth ask that does not open by blaming the caller. `refuseDob` has two branches and, until this build, ONE spoken line. `fix` — the channel only the MODEL reads — was always correctly split, and its own wording is the argument: *"You did not send the date_of_birth argument at all — that, not the caller, is why this was refused… Only say the message if they have not given it yet."* The spoken `message` said *"I did not catch that — may I please have the date of birth…"* on BOTH branches. On the omitted-argument branch nothing was mis-heard and on most calls the caller had never been asked, so the agent opened by blaming them for a turn that never happened — the v18 shape exactly, a branch speaking the sentence that belongs to the other one. **AND THE OMITTED BRANCH IS THE COMMON ONE:** this file already records `dobShape` as `(none)` on 93 of 93 refusals on 2026-09-14, so the wrong line was very nearly the only one callers ever heard. **MEASURED BEFORE CHANGING IT**, every lane that files a ticket, `duration >= 30`: **2026-09-15 carried it on 25 calls — surgery 11, pcp 8, optical 4, tech 2 — and 10 of those ended with NO ticket of any provenance**; 2026-09-16 had 9 more by 17:30 UTC. The worked example is `CA48a7238f2381ae130d73c9f9221181bb` (pcp, 2026-09-16, 81s): a medical-records request whose purpose, caller, organisation, patient, delivery method, fax number and title were ALL captured — then this line, then the caller hung up, and nothing filed. **THE UNREADABLE BRANCH IS DELIBERATELY UNCHANGED**: when the model DID send something and the parser refused it, "I did not catch that" describes what happened and it stays word for word. Only the branch that never had an answer to mis-hear is reworded, and it keeps the format in the question (RULE ZERO 2b) by saying the same sentence minus the false preamble — the smallest edit that stops it lying. **ONE COPY, NOT FOUR:** `opticalTools`, `surgeryTools`, `techTools` and `medicalRecordsTools` each held a byte-identical literal AND an identical `fix` ternary; `dobRefusalCopy` in `registry.ts` is now the only place either sentence exists. That is the `explicitAsk.ts` shape this repo has already paid for — two noun lists drifting apart cost the operator his own transfer on `CAa2a3a1c1` — and the recognition block that was written four times and contradicted itself. `src/tools/dobFirstAskIsNotAMishearing.test.ts` — 19 assertions, **5 mutations, 5 caught**: both branches sharing the line again (the original bug), the format dropped from the reworded ask, the branches swapped, a lane re-inlining the literal, and an empty string treated as a sent value. The lane-file assertions read the SOURCE, so a re-inline goes red even though the helper stays green. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: substantive calls whose transcript contains *"I did not catch that — may I please have the date of birth"* — **25 on 2026-09-15 across four lanes, 10 of them filing nothing; target 0**, since after this build that sentence can only be reached by a genuine parse failure. The guard: date-of-birth refusals overall must not RISE — this changes what is said, not whether the gate fires, so a jump would mean the reworded ask is being obeyed less than the old one |
| **v36** or earlier — NOT the date | the PCP request being filed BEFORE the caller is asked for their title and their email. **MEASURED ON 2026-09-16, the line's first full day on v36**, substantive PCP calls (`duration >= 30`): **25 were asked for an email, 18 ENDED on that question, and 10 left NO ticket of any provenance** — checked against `tickets` by call SID in the Support Center, not inferred from `call_logs.ticket_number`. **THREE OF THE TEN HAD SPELLED A COMPLETE ADDRESS OUT LOUD FIRST** (`CA46cad3ff36083cf32f6d335afd028f27`, `CAab207f35a07d620795f6eecb127dddbe`, `CA40f8d7eab0e7fb2e92ffc94bada1e1b8`), and one answered it *"I don't have access to email"* (`CA782b4da236a6cc80a485c50e55f4b2a1`). **THE DIAGNOSIS IS ONE SENTENCE AND IT INDICTS v35's OWN REASONING.** v35 put the enrichment block last on the stated grounds that *"by the time they are asked, purpose, name, organisation and the patient are already in hand and the request files whether or not the caller stays"*. **The second half was not true.** The model files when it RUNS OUT OF QUESTIONS, so a question standing in front of the filing is a gate whatever the filing TOOL will accept — `FILING_MAY_BE_HELD = false` opened the gate on the tool that same morning and these ten died in front of the INTERVIEW. Last was not late enough. **`ENRICHMENT_AFTER_FILING` is the fix**: `callerRole` and `callerEmail` are not offered as questions until a disposition is on the record, so the model reaches the end of the form two questions sooner and files. **WHAT MAKES IT SAFE TO ASK AFTERWARDS**: ticketing-app #275 (deployed 2026-09-16) makes a SECOND POST on the same `callSid` ENRICH the row rather than answer `cached` and discard it, and `pcpCallerRole` / `pcpCallerEmail` are both in that enrichment set (`lib/pcp/pcp-ticket.ts`) — so a title or an email collected after the ticket exists still lands on it. The prompt gained one paragraph telling the model to ask once more after filing and call `create_pcp_task` again. **`callbackNumber` IS DELIBERATELY NOT IN THE LIST**: the prompt's own rule is *"THE NUMBER COMES BEFORE THE TICKET, ALWAYS"* (standing instruction 12), and it is seeded from caller ID on every call with an E.164 ANI, so in the normal case nobody is asked anything. **THE DECOUPLING IS THE v33 ONE, REUSED, AND IT IS THE HALF THAT COULD HAVE GONE WRONG SILENTLY**: `intakeIncomplete` is still computed from the FULL required list and only `missing` reads the shortened one, because `handoffEligible`'s second arm reads `intakeIncomplete` and that arm is the AUTO-transfer the operator withdrew on 2026-09-04 — wired naively, giving up on a question would have DIALLED a caller into the PCP queue two questions sooner. Belt and braces rather than load-bearing, and the test says so: the enrichment block is only appended when the purpose does NOT allow HAND_OFF, so that arm cannot be reached today with these fields in the list. **BESIDE IT, THE EMAIL IS ASKED ONCE** — operator, 2026-09-16: *"cut the email question to one ask."* `MAX_ASKS_PER_FIELD` is two because a genuine ASR drop on the first pass is common on this line, and that reasoning is about the ANSWER being mis-heard; an email address is spelled out letter by letter, so a second ask is a second spelling, and a caller with no email does not have one the second time either. `ASKS_FOR_FIELD` is ONE TABLE read by all three comparison sites — `noteAsked` and both filters in `next()` — because a budget enforced in one place and not the other is the `explicitAsk.ts` noun-list drift that cost the operator his own transfer on `CAa2a3a1c1`. **HONEST ABOUT WHAT THIS HALF BUYS: zero of the 25 calls were asked twice**, so on the measured population the one-ask change moves nothing by itself — it caps the worst case, and the ordering change is what converts the ten. **AND UNLOCKING THE FIELDS WAS NOT ENOUGH ON ITS OWN — Codex P1 on #318, correct, caught before merge.** Only `record_pcp_intake` names a question, and the model has no reason to call it again once it is holding a ticket number to read out: `create_pcp_task` recorded the disposition and returned the raw ticket response. So the two fields would have unlocked into a conversation that had already moved on and `pcp_caller_email` would have gone to ZERO rather than merely down — the accepted cost turning into a total loss. `create_pcp_task`'s success path now asks the director for the next question and hands it back with the instruction, which is the same `say` / `guidance` channel its REFUSAL path already uses. **`askNext`, not `next`, and that is the whole budget question**: this is a question handed back to be SPOKEN, so it charges — reading the pure `next()` here would have given `callerEmail` a second ask through the back door, which is exactly what the operator cut. v33's rule is unbroken, because that rule is *the place a question is spoken is the place it is charged*, not *only one tool may speak one*. `src/pcp/enrichmentFollowsTheFiling.test.ts` — 14 assertions, **11 mutations, 11 caught**: the `callerEmail: 1` entry dropped, `noteAsked` reverted to the bare constant, `missing` reading `stillUnset` again, `askableNow` widened to everything, `callbackNumber` held back with the other two, `intakeIncomplete` welded to `askableNow` (the dial regression), `askBudgetSpent` on the bare constant, the filing tool no longer handing the question over, that hand-over reverted to the uncharged `next()`, the success copy reworded to imply a failure (the v18 shape), and the question not reaching the model. **ONE OF THE ELEVEN SURVIVED THE FIRST ATTEMPT AND IS THE REASON THIS SENTENCE EXISTS:** an early `return response;` inserted ABOVE the enrichment block left the block in the source, in the right order, and stone dead — and an assertion comparing the POSITIONS of the two lines passed. Position is not reachability. The test now asserts that the source between the filing and the hand-over contains no `return` at all. **ROUND 2 ADDED TWO MORE P2s, one taken and one declined on the evidence.** TAKEN: projecting `askNext(...)` straight to `.nextQuestion` threw away `askBudgetSpent`, which is the #315 lesson at a second call site — a caller who volunteered their role gets `callerEmail` HERE as their single ask, and if they hang up there is no later `record_pcp_intake` to carry the signal, so the instrument would have missed exactly the calls it was built for. `nextQuestion` now rides along too, because `toolTimeline` gates the whole outcome read on it and `askBudgetSpent` alone would be dropped before reaching the table. DECLINED: `record_automated_resolution` was flagged for not handing the question over as well — true, and the remedy is wrong, because `createPcpTicket` returns `{ kind: 'automated' }` BEFORE creating anything (`lib/pcp/pcp-ticket.ts:245`), so there is no ticket to enrich and the ask would spend a caller's turn on a field with nowhere to land. **AND THE ROUND-2 MUTATION LESSON IS THE TRANSFERABLE ONE:** the assertion guarding the budget log banned the literal `${MAX_ASKS_PER_FIELD}` and a hardcoded `${2}` sailed straight through it. Banning one SPELLING of a wrong value is not a guard; the rule now is that neither budget log may name a count at all. 14 mutations, 14 caught. Five assertions in `interviewIsAnAnsweringService.test.ts` and one each in `intakeScript.test.ts` and `directorAskBudget.test.ts` were rewritten rather than loosened — one of them was literally titled *"a caller who hangs up on the title question still leaves a filable request"*, which is the claim this row withdraws. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: PCP substantive calls that end on the email question with no ticket of any provenance — **10 on 2026-09-16, target 0**; and PCP tickets carrying a `pcp_caller_email`, which will FALL and is the accepted cost, not a regression. The guards: **PCP tickets filed per substantive call must RISE**, because an interview that asks less must not file less; **PCP transfer ATTEMPTS must not rise**, which is what the `intakeIncomplete` separation exists to guarantee; and **tickets must not LOSE a field between the first POST and a later one on the same call**, which is what ticketing-app #275 exists to guarantee |

| **v37** or earlier — NOT the date | a tool call reaching the database when it finishes, on the three lanes that build their own tools. **MEASURED 2026-09-16, substantive calls, `tool_call_count IS NULL`: pcp 90.9% — against optical 26.5%, tech 22.2%, surgery 16.4%, and against PCP's OWN 36.8% on 09-14 and 31.7% on 09-15.** So on the lane carrying the go-live, nine calls in ten could not say what tools had run. CLAUDE.md has recorded this column as NULL on about a third of grok rows since 2026-09-10 with the cause "not yet established"; this is the cause. **RECORDING AND PERSISTING WERE TWO ACTS AND ONLY ONE OF THEM WAS SHARED.** `realtimeAdapter` flushed after every tool, so optical, surgery, tech and records were durable within seconds. `pcp`, `no-ivr` and `answering-service` build their tools BY HAND — `recordedTool` wrapping `recordingExecute` directly — and never reach that file, so their ONLY route to the database was the 2h reaper. `timelines` is an in-memory Map, so every deploy or restart inside that window destroyed the record outright, and the three-day swing on PCP is how many times the process restarted. **AND THE ADAPTER'S OWN FLUSH WAS ONE TOOL BEHIND FOR ITS WHOLE LIFE:** its call site sat INSIDE the function `recordingExecute` wraps, and the event is recorded only AFTER that function returns — so it persisted the PREVIOUS tools and never the one that had just finished. The last tool of every call reached the database through the reaper or not at all, which is precisely the shape `realtimeAdapter.ts`'s own header describes costing most of a day (four consecutive live Surgery calls recording three tool events and nothing for the fourth). **THE FIX IS THAT THERE IS NOW ONE ACT:** `recordingExecute` persists what it has just recorded, so an agent cannot wire recording and forget persistence — there is no longer a way to have one without the other. The adapter's second call site is deleted rather than kept, because two flush sites is the `explicitAsk.ts` drift shape this repo has already paid for. **THE SECOND HALF IS WHAT MAKES THE FIRST SAFE, and it is a defect `callRecord.ts` has described since PR #227 without it ever being fixed:** the UPDATE runs `WHERE call_sid = ?`, matches NOTHING when the call's row is not open yet, and `flushedCount` was set regardless — so the entry read as durable, the reaper skipped it, and the events died in memory. Moving the flush EARLIER makes that case MORE likely, so a write is now only marked durable when `.returning()` hands a row back; a zero-row write leaves the entry dirty and says so on the console. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — though this writes only telemetry and touches no ticket, no gate and no spoken line. `src/services/recordingPersistsTheTimeline.test.ts` — 5 mutations, 5 caught: the flush removed from the recorder (5 fail), the flush fired before the event is recorded (5), a zero-row write marked durable again (1), the adapter growing its own call site back (2), and pcpAgent dropping the recorder (1). Two assertions in `realtimeAdapter.test.ts` were REWRITTEN rather than loosened — they spied on the deleted call site, and that file mocks `recordingExecute` to a pass-through so it structurally cannot see the new behaviour. The numbers: **`tool_call_count IS NULL` on substantive PCP calls — 90.9% on 2026-09-16, target near the other lanes' ~20%**; and the share on optical, surgery and tech must FALL too, because the one-behind bug was costing every lane its last tool. The guard: `tool_timeline` event counts must not DROP on any lane, and no lane's filing rate may move — this writes telemetry and must change nothing a caller hears |

| **v38** or earlier — NOT the date | a recording disclosure on the four QUEUE lanes. **MEASURED 2026-09-16: of 667 substantive calls, the 401 on optical, surgery, tech and records carried no disclosure at all.** California is a two-party-consent state and this is a healthcare practice, so it is a compliance gap rather than a stylistic one. Task #79, open since before the cutover; `pcp` got its clause on 2026-09-15 (#304) and these four were left out. **The clause is `noIvrAgent`'s, verbatim** — *"All calls are being recorded for quality assurance purposes"* — operator-approved and already live on two lanes. **DELIBERATELY NOT COPIED:** the 911 direction and "our offices are currently closed", which belong to the after-hours line; requiring a clinical-safety sentence on a business-hours queue would be inventing a rule rather than applying one (standing instruction 1). **THE TRAP IS NOT PUTTING IT IN, IT IS KEEPING IT IN.** `personaliseGreeting` runs AFTER `missingMandatoryCopy` on both pipelines, and on these four lanes its style is `append` — which calls `stripTrailingQuestion` and deletes everything from the last sentence boundary to the closing `?`. A disclosure comma-joined into that question passes the gate and is then dropped on the wire. `greetingPersonalisation.test.ts:147` already proves exactly that of the no-ivr string. **And recognition is now the COMMON case** — 2026-09-16: 65% of pcp, 72% of surgery, 67% of optical and 64% of tech calls were greeted by name — so the broken shape would have failed on most traffic while a naive "does the greeting contain it?" assertion stayed green. The clause is therefore its own `.`-terminated sentence BEFORE the closing question, and every assertion that matters runs the greeting through personalisation first. **REGISTERED IN BOTH TABLES**, not just written into the string: `MANDATORY_GREETING_COPY` gains the four lanes so `chooseGreeting` stops preferring an `agents.welcome_greeting` row that lacks the clause, and `COMPLIANT_FALLBACK_GREETINGS` gains four entries by REFERENCE to each lane's own literal so a fallback cannot drift from what it is rescuing. The old core's `registerOverflowLine` copies are patched too and pinned by reading the file — those literals have ALREADY drifted from the registry (optical says "customers", the registry says "patients"); that drift is not fixed here, but this property must not join it. **THREE TESTS WERE REPOINTED, NOT LOOSENED** — each used `optical` or `surgery` as its example of *a lane with no mandatory copy*, which those lanes have stopped being; and `voiceRuntime.test.ts`'s "prefers the configured greeting whenever it is complete" kept PASSING for the wrong reason, because with both strings deficient `chooseGreeting` falls into its "neither has it" branch which also returns `configured` — the fixture now actually satisfies optical's copy, so it tests what its name says. `src/services/queueLanesDiscloseRecording.test.ts` — 7 assertions, **5 mutations, 5 caught**: the clause deleted from a registry greeting (5 fail), the clause comma-joined into the closing question (**1 fail, and only the personalisation test — which is what proves that assertion is not redundant**), a lane dropped from `MANDATORY_GREETING_COPY` (2), a lane dropped from the fallback table (1), and the clause stripped from the old-core literal (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — though this changes only what is said in the opening seconds and touches no gate, no tool and no ticket. The number: substantive optical/surgery/tech/records calls whose transcript carries the disclosure — **0 of 401 on 2026-09-16, target all of them**. The guard: ~9 words of dead air are added before the caller can speak, so median caller lines per call must not fall and the barely-heard rate must not rise — a caller who talks over a longer greeting must still be heard |
| **v39** or earlier — NOT the date | a callback number the agent cannot actually have. **TWO SENTENCES REACHED REAL CALLERS ON 2026-09-16:** *"The number ending in ."* (pcp, three times in one call) and *"Is this number ending in \"mous\" the best one to reach you?"* (no-ivr, `CA…8d536d6646`). **The second explains both.** A withheld or blocked caller ID does not arrive as an empty string — it arrives as a WORD, so a call site guarding on `callerPhone ? … : …` passes the guard and `"anonymous".slice(-4)` is `"mous"`. Strip the non-digits first and you get `""`, which renders as *"ending in ."*. **`formatPhoneLast4` ALREADY stripped non-digits and returned `''`, and that is the trap** — an empty string reads as a VALUE at a template call site. `speakableLast4` returns `null` instead, which cannot be interpolated silently and forces every call site to carry the other branch; that branch is always ASK, because a caller who says yes to a number nobody holds produces a request that cannot be called back (standing instruction 12). **TEN DIGITS, NOT FOUR:** four was enough to stop an empty string and not enough to stop a short code, an extension or a partial ANI. **SIX CALL SITES**, all of which were slicing raw: `knowledgeBase.ts` x2, `rampEngine.ts` x3 (which already had the correct `collectCallback` fallback and simply never reached it) and `azulSchedulingPrompt.ts`. **`formatPhoneLast4` IS DELIBERATELY UNCHANGED** — other call sites use it and it is honest about what it does. **AND SWAPPING THE HELPER IN WAS NOT ENOUGH ON ITS OWN:** the azul site had no `else`, so the first edit turned *"ending in ."* into *"ending in null"*, which is worse — caught by reading the rendered branch rather than the helper. `src/utils/theCallbackNumberIsNeverInvented.test.ts` — 7 assertions, **4 mutations, 4 caught**: the digit floor back to 4 (1), the helper returning `''` again (3), a call site reverting to the raw slice (1), and a site losing its ask-instead fallback (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: substantive calls whose transcript contains `ending in .` or `ending in "` followed by a non-digit — target 0; and tickets filed with no callback number must not rise, because a site that now asks instead of offering must actually get an answer. **CODEX ROUND 3 (04:42, on `8e3d58c`) — one P2, real, taken.** Both ramp sites v40 changed set `status.state = 'CONFIRM_CALLBACK'` BEFORE consulting `speakableLast4`, so with *anonymous* in the ledger the ramp asked for a number and then parsed the ten digits the caller gave as a yes/no, rejected them, and after a second try disengaged with nothing stored — the ask-instead line in the wrong STATE. An unspeakable number now moves the ramp to `COLLECT_CALLBACK` at both sites (`COLLECT_CALLER` and `TAKE_MESSAGE`); a speakable one is still confirmed, and a control test pins that. Three behavioural tests on the real ramp (`rampEngine.test.ts`); 2 mutations, 2 caught |
| **v40** or earlier — NOT the date | the after-hours line asking for a date of birth ONCE. **MEASURED 2026-09-16, substantive calls: the agent asked for a date of birth two or more times on 73 calls fleet-wide, three or more on 30, and 25 of those left no ticket — and no-ivr was the worst lane by a mile: 19 of the 20 calls that asked at all, eleven of them three or more times, and one call FIFTEEN times.** The operator named the shape himself that day: *"one that asks somebody something seven times, like that shouldn't be possible, right?"* **WHY THIS LANE AND NOT THE OTHERS.** The four queue lanes route every filing through `src/tools/registry.ts`, where `decideDobEscape` has bounded the date-of-birth refusal at ONE per call since 2026-09-04 — the operator's own ruling (*"file it anyway … put unavailable or unmatched"*), measured the day it shipped at 9 of 11 recovered against 0 of 23 without it. no-ivr builds its `create_ticket` BY HAND (`recordedTool` in `noIvrAgent.ts`) and never reaches the registry; its own DOB validation at the top of the handler had **no counter, no key and no escape** and could return the same refusal on every invocation for the life of the call. **NOTHING ELSE IN THE REPO COULD SEE IT:** `toolCeiling` is runtime-only; `conversationLoopGuard` only nudges, and `src/director/director.ts:11` records the model ignoring its nudge and asking four more times; the v33 ask budget is imported by `pcpAgent.ts` alone. **THE DECISION THAT BLOCKED THIS WAS SETTLED BY THE LOGS, NOT A RULING.** The worry was that the after-hours ticket API might refuse a payload with no date of birth — the 2026-09-14 shape (17 requests → HTTP 400) pointed at the busiest overnight lane. `voice_agent_api_logs`, 14 days: **347 of 347 accepted no-ivr POSTs to `/submit-ticket` carried a `patientDOB` value, the B2B path already sends the literal `'Unknown'` there, and the 10 rejections were for `patientFullName` and `surgeon`, none for a date.** So the placeholder the escape sends is a value the API has been accepting all along. **TWO SMALL THINGS THAT ARE LOAD-BEARING:** the status note (`dobStatusNote`, the queue lanes' exact wording) goes in `additionalDetails` and NOT at the head of `reasonForCalling`, because the `Request Type:` header must stay that field's first line (operator, 2026-07-25); and `parsedDOB` is nulled on the escape path so the secondary name+DOB schedule lookup cannot run on a partial parse — the early return used to keep it out, and the escape must not open that door. The caller's unreadable words never reach a date field or the note; they are in the recording. `src/agents/noIvrDobEscape.test.ts` drives the REAL agent (`createNoIvrAgent`, the tool invoked the way the SDK invokes it) rather than the helper, because the helper already worked on four lanes and the defect was that this lane never called it — failure mode 10. 7 tests; **6 mutations, 5 caught**: the escape removed (3 fail), the `parsedDOB` reset dropped (1, only after a lookup spy was added — the first version could not see it), the status note dropped (3), the raw words sent in the date field (2), the escape keyed on a constant instead of the call (1); the sixth, the console `[DOB ESCAPE]` marker line, SURVIVES by design — it is a deploy counter, not behaviour, same as the queue lanes' copy. **WHAT THIS DOES NOT FIX, stated rather than implied:** the 18 surgery / 18 tech / 7 optical re-asks of the same day happen in SPEECH, not through a tool — `decideDobEscape` already bounds the tool path there — and no runtime lane has any ask counter at all; that is the larger half of W2 and it is still open. A sentinel or missing CallSid still makes the escape ask every time (`gateRefusalsSoFar` keys on `isTwilioCallSid`), which is the open "11 of 72" note above; every one of the 299 substantive no-ivr calls of 09-10..09-16 carried a canonical SID, so it does not bite this lane today. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — no-ivr is on the OLD CORE, so this ships to that pipeline and the marker dates the build rather than a runtime lane, as v18 did. The numbers: no-ivr substantive calls asking for a date of birth 3+ times — **11 on 2026-09-16 (worst 15), target 0 via the tool path**; and no-ivr tickets carrying `patientDOB = 'Unknown'` beside a `DATE OF BIRTH UNAVAILABLE/UNMATCHED` note, which will RISE and is the accepted cost. The guards: **no-ivr tickets filed per substantive call must not fall**, tickets whose `patientDOB` holds anything but a date or `Unknown` must stay 0, and the `Request Type:` header must remain the first line of every no-ivr ticket description |
| **v41** or earlier — NOT the date | the after-hours line telling a caller their filing FAILED when it did not. **Two calls on 2026-09-16, one shape, two roads — read from `tool_timeline` and `tickets`, not from the transcript note.** `CA…11e362485f` (no-ivr, 14:54): the model fired `create_ticket` TWICE, overlapping. Attempt A (9,312ms) filed VA-60434 and returned success at 14:56:50.67; attempt B started while A held the per-call lock, waited the FIXED 3s, rechecked once — nothing written back yet — and returned *"Concurrent ticket creation in progress"* at 14:56:50.24, **0.4s BEFORE A's success**. The handler mapped every non-validation failure to *"technical system error… apologize… end the call"*, so a caller twenty minutes late for an 8:00 appointment was told we had a technical issue while her ticket sat in the queue. `CA…7074e29c0c` (no-ivr, 03:13, Spanish): `create_ticket` hit the 15,000ms client timeout while the ticketing app finished the insert at the same instant — **VA-60429 exists**, and the corpus note calling it unfiled was wrong; `call_logs.ticket_number` is NULL because the write-back runs only on a success the client sees, which is the measurement trap this file already names. **14-day before-arm, no-ivr:** 3 contention refusals (every one on a call that also holds a successful filing and a ticket) + 1 timeout (ticket exists). Small, and each one is the operator's own definition of a mistake: *"did they give them a ticket number?"* **THREE CHANGES.** (1) `submitSimplifiedTicket`'s contention branch POLLS `call_logs.ticket_number` every second for up to `CONTENTION_WAIT_MS` (10s — longer than the 9.3s POST that found this, inside the client's 15s timeout) instead of one 3s recheck, so a duplicate attempt returns the SAME ticket number and nothing false is said; answering-service and after-hours share that function. (2) A contention refusal that outlasts the wait is answered on no-ivr with *another attempt is in progress — say nothing failed, wait for its result, do not call again*, never the apology. (3) A client timeout is answered *call `create_ticket` ONCE more — the system recognises this call and will not open a second ticket* (the app returns the cached result for `idempotencyKey: call-<sid>`), bounded to one retry per call through `gateAttempts`, and only a SECOND timeout speaks the apology. The retry can cost a caller another wait of up to 15s; that is bounded, and it beats telling a caller whose ticket exists that it does not. `src/agents/noIvrFalseFailure.test.ts` (the real agent, 7 tests) and `src/services/syncAgentContentionWaitsForTheWriteBack.test.ts` (fake clock, 6 tests); the existing lock test's contention case moved to fake timers because it now waits ten seconds of real time. **7 mutations, 7 caught**: the contention branch removed, the timeout branch removed, the retry unbounded, the contention copy reverted to the apology, the poll back to a single 3s recheck (4 fail), the write-back never read (2), the wait shortened to 3s (2). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: no-ivr `create_ticket` events carrying *Concurrent ticket creation in progress* — 3 in 14 days, target 0, because the poll should absorb them; and calls whose transcript carries *"experiencing a technical issue"* while a ticket exists for the SID — 2 on 2026-09-16, target 0. The guards: no-ivr tickets per substantive call must not fall, and two tickets on one SID must stay 0 — the poll never POSTs, and the retry rides the idempotency key. **CODEX ROUND 2 (04:07, on `6e7c532`) — one P2, taken in part.** The finding: the timeout and contention directives sit in `message`, which v43 documents as the spoken channel. Not on THIS agent — no-ivr builds its tools by hand, and its `message` has always been the model-facing channel: the apology branch's own `message` is the instruction *"Apologize sincerely: '…' Then end the call gracefully"*, and the control says the model reads it that way — over 30 days / 1,338 substantive no-ivr calls that instruction text was spoken **0** times while its quoted line was spoken 37. So the split is declined, with that number. **What WAS wrong, and is fixed:** the PROMPT's own TICKET CONFIRMATION RULES said, of `api_timeout` in as many words, *apologise and end* — so on a first timeout the tool said *call once more* while the prompt said *end the call*, on the same result, and the prompt is the older and the broader instruction. The carve-out (an in-progress or once-more result is NOT a failure; do exactly what it says and never speak the technical-issue line on it) now sits BEFORE the technical-error rule in both places the prompt describes a failed tool — the v29 lesson, the exception stated before the ban. Asserted on the BUILT prompt, by position; **3 mutations, 3 caught**: the carve-out deleted, moved after the rule, and the summary clause deleted |
| **v42** or earlier — NOT the date | a classify tool's instruction to the model living in the channel the model SPEAKS. `CA…8dbb8dd441` (surgery, 2026-09-16 17:06, 73s): the caller said she was checking on a surgery schedule for a detached retina; the lexicon fired (`detached retina` is a Retinal Detachment Urgent cue) and the agent then said, word for word, *"These are the words we treat as a surgical emergency."* — and only then the 911 line. That sentence was `classify_surgery_request`'s `message`: written as an instruction TO THE MODEL (*"Tell the caller to seek emergency care… file this at urgent priority. Do not take a routine message and hang up."*) and placed in the one field every other registry tool uses for what the agent SAYS. `dobRefusalCopy` documents the split — `message` is spoken, `fix` is for the model — and this tool had the two folded into one key. The urgent branch now speaks the prompt's own operator-approved direction, *"Please seek emergency care or call 911 now."*, and carries the rule in `fix`; the catch-all branches on ALL FOUR lanes (*"Nothing matched, so this is filed as 'Other - See Description'…"*, *"This does not match one of our optical categories…"*) had the same shape and move to `fix`, because a catch-all has nothing for the caller to hear. **WHAT IS NOT CHANGED, DELIBERATELY:** whether `detached retina` should fire on a SCHEDULING call is the lexicon, which is the operator's (the `can't see` precedent above) — the test uses that exact phrase because it is the corpus shape and asserts only that the rule is no longer read aloud. Same day, `CA…abf8900636`: a post-op *flash of light and a halo* got NO emergency guidance — a lexicon miss, also his to rule on. `src/tools/theToolDoesNotNarrateItsRule.test.ts`, 7 tests; **5 mutations, 5 caught**: the urgent message reverted to the instruction (2 fail), the urgent message dropped so nothing is spoken (2), a lane's catch-all back in `message` (1 each, surgery and optical tried), the model-facing `fix` dropped (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: substantive calls whose AGENT lines contain *"words we treat"* or *"Nothing matched"* — 1 on 2026-09-16, target 0. The guard: an urgent classification must still put a spoken 911 direction in front of the caller on every call — the test asserts the message text, so a build that drops it goes red |
| **v43** or earlier — NOT the date | the Observatory seeing a runtime call the way xAI's console shows one — timed turns, tool calls in place, and a recording. **MEASURED 2026-09-17: `recording_url` is NULL and `call_turns` is EMPTY on all 4,564 runtime calls since the 2026-09-03 cutover**, on the five lanes that as of v39 open every call with *"All calls are being recorded for quality assurance purposes"*. The call page fell back to the flat transcript and labelled it an instrumentation gap; nothing on it could say when a line was spoken, where a tool ran, or play a second of audio. **TWO ABSENCES, NOT ONE BUG.** (1) The old core records by `<Conference record="record-from-start">`; `<Connect><Stream>` has no such attribute, and nothing on the runtime ever asked Twilio to record — so the disclosure was false in the OTHER direction, and every v41 status note that says *"the call recording has what they said"* pointed at nothing on these lanes. (2) `call_turns` is written by the old core's `turnLog` as each transcript arrives; the runtime's `CallTranscriptLog` kept its lines and NOT the moment each was written, and nothing wrote the table for a runtime call. **THE FIX, in three pieces the same shape as the console screenshot the operator sent.** The transcript log now records the time each line is first written (`turns()`, aligned with `lines` after every kind of write — a refinement in place keeps its original time); the record carries `turns`, and `persistRuntimeTurns` writes `call_turns` AFTER the row and AFTER the sweep, never awaited, with each line's OWN time and the gap to the previous — a test pins that no line is stamped with the hang-up time, which is the lazy version of this. The state column names the identity FIELDS the record held (never values — the turn table's own rule) and `identityAsks: null`, because this pipeline counts no asks and a zero there would be a lie. A Twilio REST recording (`calls(sid).recordings.create`, DUAL channel, so the page's stereo waveform renders agent and caller) is started the moment the stream's `start` frame arrives — the call is answered by then — fire-and-forget; the public host rides in as a `<Parameter name="host">` on the TwiML so the callback can be named without a second way of learning it, and Twilio posts `RecordingUrl` + `CallSid` to the SAME `/api/voice/recording-status` handler the conference recordings use. That handler read `ConferenceSid` only; `recordingStatusTarget` now keys on the conference when there is one and on the canonical CallSid when there is not (sentinels refused — the validator this file already names), and the CallSid branch saves the URL onto the call row and pushes it to the ticket the way the conference branch always has. The call page places each tool call at its START (`at - ms` — the timeline records the END) between the lines it ran between, expandable to its arguments and outcome, and only when every turn carries a time: a flat-transcript fallback has no clock, so its chips stay on the Logs tab. **NEVER ON THE CALL'S PATH:** a recording that fails to start is one console line (`[RECORDING] failed to start`) and the call proceeds unrecorded, exactly as every runtime call has to date; the turns are telemetry behind the sweep. **COST, stated:** Twilio recording is ~$0.0025/min plus storage, roughly $4 a day at 1,500 runtime minutes — the line item the old core has paid on every call since it went live. Parity, not policy. **NOT PINNED HERE, deliberately:** whether Twilio accepts a REST recording start on a `<Connect><Stream>` leg is a fact about Twilio, and this build proves or refutes it on its first call — the console line names the refusal if it comes. `src/runtime/transcriptLog.turns.test.ts` (5), `callRecording.test.ts` (4), `recordingStatusTarget.test.ts` (6, two of them reading `voiceAgentRoutes.ts` for the wiring), `runtimeTurns.test.ts` (6), `voiceRuntime.test.ts` (+3, pinned at the RUNTIME because a helper test proves the helper and not that anything calls it — failure mode 10), and `client/src/lib/transcriptTimeline.test.ts` (11 — the chip placement extracted into a pure module so the page's ordering is testable without a DOM). **11 mutations, 11 caught:** `turns()` losing its times (3), the bridge dropping `turns` from the record (1), the runtime never handing turns to the writer (1), never starting the recording (1), the TwiML dropping the host (1), every line stamped with the hang-up time (2), the handler losing its CallSid branch (1), mono instead of dual (1), a chip placed at the call's end (1), a chip before the line it followed (1), chips on a transcript with no clock (2). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — though this writes telemetry and starts a recording, and touches no gate, tool or spoken line. The numbers: runtime calls with `recording_url` NULL — **4,564 of 4,564, target ~0** from the first call on this build; runtime calls with zero `call_turns` rows — all of them, target 0. The guards: filing rate per lane must not move, and the barely-heard rate must not rise — a REST recording start adds no audio and no delay to the stream, but that is the assumption to check rather than assert. **CODEX ROUND 1 ON #321 — TWO P1s ON THIS SHIP, BOTH REAL, BOTH TAKEN.** (1) The recording push stamped `callDataSynced: true`, the flag `ticketingSyncService` selects on — so a recording landing before the five-minute sweep would have left the ticket with a URL and no transcript, duration or outcome, which on the runtime (recording completes at hangup) would have been every call. The sync payload already carries `recordingUrl` off the row, so the callback now only saves the URL and lets the sync deliver it; it pushes directly only when the call is ALREADY synced, and the one remaining flag write sits inside that branch, where it is a no-op — kept so `ticketingSyncService.test.ts`'s rule that every successful push records delivery holds without an exception, and unreachable on a call the sync has not handled (`recordingDelivery.ts`). Measured on the old core, 14 days: 5–7 of 322 no-ivr tickets carry a recording and no duration — the race was narrow there and would have been the common case here. (2) The CallSid branch trusted a public POST behind the rate limiter alone, and a CallSid is on every ticket; it now requires the runtime's own fail-closed `checkTwilioSignature` before it reads or writes a row. The conference branch is deliberately NOT gated — that is the old core's pre-existing surface, and widening a security check onto a live path is its own change with its own after-number. 7 mutations across the three fixes, 7 caught. **CODEX ROUND 2 (04:07, on `6e7c532`) — one P2 here, real, taken.** The recording starts at the stream's first frame, deliberately BEFORE the row opens (so it holds the greeting and the disclosure it carries), so a setup hangup or a row open past its 2s deadline can deliver the completed-recording callback to a handler that finds no row — which answered 200, and Twilio does not retry a 200, so the URL was gone. Every such call still gets a row at teardown (`persistRuntimeCall` runs on all four exits, the setup-failure and early-hangup returns included), so the handler now PARKS the URL by CallSid (`parkedRecordings.ts`: TTL 30 min, capped at 500, no PHI, one process for both pipelines) and the persist takes it onto the row it writes — before the write and again after it, so a callback landing between the two cannot fall in the gap. With nothing parked the conflict update does not mention `recording_url` at all, so a URL the callback wrote itself is never clobbered by the teardown. `src/runtime/recordingBeatsTheRow.test.ts` — 8 tests, the handler's no-row arm read from source; **6 mutations, 6 caught**: the handler not parking, the persist dropping either take, the conflict update dropping the URL, the store handing a URL back twice, the TTL sweep removed. **CODEX ROUND 3 (04:42) — one P2 on the round-1 fix itself, real, taken.** Letting the sync carry the URL and pushing only on an already-synced call left a race: a call the sync had already SNAPSHOTTED into its batch when the callback saved the URL was pushed by neither side, and the sync's stale payload then marked it done for good. It is the remedy Codex offered in round 1 that I did not take: the recording push now sends the URL every time and NEVER touches `callDataSynced` — the sync still runs, carries the URL again off the row (the same value, idempotent on the app) and marks the call itself, so every ordering delivers it. `recordingDelivery.ts` and its plan are deleted; `ticketingSyncService.test.ts`'s every-push-records-delivery rule gains its one principled exemption for this partial push, and `recordingPushIsPartial.test.ts` pins that no gate and no flag write sit in the helper. 2 mutations, 2 caught (the flag write returning; a not-yet-synced gate returning). **CODEX ROUND 4 (05:16, on `1b82a86`) — two P2s here, both real, both taken on `25b023b`.** The parked URL was TAKEN off the store before the teardown upsert ran, so a write that threw lost the only copy; it is now read without consuming (`peekParkedRecording`) and released only after the write that carried it has succeeded (`releaseParkedRecording`, which keeps a newer URL parked in between) — and the teardown upsert itself is retried on a bounded 1s + 3s backoff (`PERSIST_RETRY_BACKOFF_MS`), because until now one failed write at hangup lost the call's whole row and nothing tried again. The same round found `recordRuntimeTurns` releasing its buffer in an unconditional `finally` after a failed flush, discarding the claim `flushTurns` had just given back; it now retries on the same backoff and leaves an unflushed buffer for the 2h reaper. 7 tests across `recordingBeatsTheRow`, `runtimeTurns` and `callRecord`; 5 mutations, 5 caught. **CODEX ROUND 7 (06:52, on `0142526`) — one P2 here, real, taken.** The callback looked the row up and parked only on a miss, so the teardown persist could pass straight through the gap: lookup finds no row → the teardown writes the row and runs BOTH its peeks (nothing parked yet) → the callback parks → nothing ever reads the entry and the recording expires with it, Twilio having been answered 200. The callback now PARKS BEFORE IT LOOKS (`landRecording` in `parkedRecordings.ts`, the handler's lookup/write/push extracted into it), and releases only once the write that carried the URL has returned — one ordering rule that covers every interleaving with the persist's two peeks. `recordingBeatsTheRow.test.ts` +4, including the exact interleaving Codex named (the teardown persisting and peeking WHILE the lookup is in flight, the lookup then reporting no row — the URL lands anyway) and the handler's source pinned to the lander; two `recordingStatusTarget` assertions rewritten to the new shape, not loosened. 2 mutations, 2 caught (park after the lookup — 3 fail; never released) . **CODEX ROUND 10 (07:52, on `9cbbed0`) — one P2 here, real, taken.** The round-3 rule — push every time, never touch the flag, the sync carries the URL again — covers every ordering but one: a callback that lands AFTER the sync has already finished the call, where this push is the URL's only path, and a transient failure lost it for good (the URL on the row, the flag saying done, no sweep ever looking again). A failed push on an already-synced row now RE-OPENS the sync (`afterRecordingPush`, `recordingPushOutcome.ts`): `callDataSynced` goes back to false — the one flag write on this path, and it only ever clears — so the next pass carries the full payload with the URL now on the row, idempotent on the app, and marks the call itself; a row the sync has not finished needs nothing. `recordingPushOutcome.test.ts` (3) and the partial-push pin rewritten to allow exactly that clearing write in exactly that branch; 2 mutations, 2 caught (the sync never re-opened; a synced row treated as pending). **CODEX ROUND 11 (08:16, on `84aabf5`) — two P2s on that reopen, both real, both taken.** (1) The reopen decided on a `getCallLog` snapshot read BEFORE the push, and a sweep already in flight could have selected the row before the URL landed: the snapshot says the sync is coming, the push fails, nothing reopens, the sweep's stale payload carries no URL and marks the row done — the round-3 loss through a fourth door. Rather than version the callback against the sweep, the sync's OWN mark-done is now conditional: `syncCall`'s success UPDATE matches only while the row's `recording_url` is still what the payload carried (`IS NOT DISTINCT FROM … ::text` — cast explicitly, the v52 lesson, and PREPAREd against the live Hub before it shipped), `.returning()` says whether it matched, and a zero-row write leaves the call pending with its retry count untouched for the next pass to carry. One rule that holds under every ordering: selected before the URL landed → not marked → the next pass carries it; selected after → the payload already has it; the sync finished before the URL → the round-10 reopen. (2) The reopen cleared the flag and left `ticketingSyncRetries` alone, and the success write stores the ATTEMPT NUMBER while the selector reads `< 3` — so a row that synced on its third attempt would be reopened and never selected. **0 of 5,904 synced rows in the 14 days to 2026-09-17 carry a 3** (4 synced on the second attempt); taken because it is one field in the write that branch already makes, and said so. `ticketingSyncService.test.ts` +4 (source pins, as that file's own selection pins are and for the reason it gives — the query is a Drizzle chain against a live `db`), the `recordingPushIsPartial.test.ts` pin rewritten to the new write; **3 mutations, 3 caught** (the condition dropped; the zero-row branch dropped; the retry reset dropped — 2 fail). The two console lines are the counters: `[TICKETING SYNC] ○ a recording landed on call … left pending` and `[RECORDING] the push failed on a call the post-call sync had already finished`. **CODEX ROUND 15 (09:44, on `87164da`) — one P2 on that reset, real, taken.** The two failure writes stored a SNAPSHOTTED `currentRetries + 1`, so a grade or recording landing mid-pass — which resets the column to 0 to re-open the sync — was clobbered when the same pass then failed: a row on its second retry went to 3, ineligible, with the new data never sent. Both writes now add one IN THE DATABASE (`COALESCE(retries, 0) + 1`), so a reset that lands mid-pass leaves the row at 1 and eligible. Measured before taking: 0 rows at 3 retries and 4 at 2 in the 14 days to 2026-09-17 — latent, taken because it is one expression in the write that branch already makes, the round-11 reasoning. `ticketingSyncService.test.ts` +3 source pins; 1 mutation, 1 caught (the thrown-path write back to the snapshot — 2 fail). **ROUND 16 (10:11, on `68a783b`) — one P2 on that write, real, taken.** The error text and the `retriesExhausted` verdict were still decided from the SNAPSHOT, so the row the atomic write left at 1 would have worn *GAVE UP after 3 attempts* and been reported exhausted in the result and the cycle summary. Both are now decided by the count actually written: the text is a `CASE` in the same statement against the same pre-update value (Postgres evaluates every SET against the old row, so the two reads of the column agree), and the verdict reads the count back with `RETURNING`. PREPAREd and EXECUTEd on the live Hub before it shipped. +2 source pins (both branches; the pre-write shape gone); 3 mutations, 3 caught (the ternary back — 2 fail; the verdict from the snapshot; the RETURNING dropped) |
| **v44** or earlier — NOT the date | the Grok day table: xAI's reported voice spend beside what the call rows were booked at, one row per day, refusals included. **MEASURED 2026-09-17 against the operator's own xAI usage export (`634c05df-usage-2026-09-01-2026-09-16.csv`):** the nightly reconciler IS live and has settled every runtime day since 09-03, and its day totals match the export within the text-spend and day-window noise the cost section already documents — **except 2026-09-12, where $37.43 of team voice spend was allocated onto ONE 104-second optical call** (`CAb04962a559c013987d12958542b2b02c`) and stamped `cost_is_estimated = false`, so every per-call and per-lane cost view read it as a fact. The row is corrected (14¢ / 15¢, estimated, `cost_reconciled_at` NULL; before-values on task #84). **THE GUARD THAT REFUSES THAT DAY ALREADY EXISTED AND WAS NEARLY REBUILT** — `impliedRateIsImplausible`, `RATE_SANITY_MULTIPLE = 3`, its own comment dated 2026-09-12 and citing this exact call; the row was written before it shipped. Failure mode 9, caught by grepping before building. **WHAT WAS ACTUALLY MISSING:** the reconciler kept the day's xAI figures, the lines it summed, the lines it ignored, and above all a REFUSAL, in console lines and nowhere else — so the export could not be compared against what we booked without a night of SQL, and a refused day looked from the tables exactly like a day the reconciler never ran. The OpenAI side has had `daily_openai_costs` for this since it was written. **`daily_grok_costs` is the Grok side of that table:** one row per day on EVERY outcome — reconciled or refused, with the reason — `xai_voice_cents`, the voice and ignored lines as JSON, `booked_cents` (xAI's total when the day reconciled, the sum the rows already held when it did not), the estimate, calls, seconds and the derived ¢/min. Written from `reconcileGrokCostsForDay` BEFORE the marker line; a failed summary write is a warning and never changes the outcome; the port is optional so a port built for the allocation alone still types. Lazy `CREATE TABLE IF NOT EXISTS`, like `call_events`, and `ON CONFLICT (day) DO UPDATE` so a re-run overwrites. Served at `/api/analytics/grok-usage` (a missing table is no rows, not a 500), shown on the cost dashboard as *"Grok runtime — xAI reported vs booked"* with a refused day saying why, and the call page's cost figure now carries **reconciled** or **estimated** — the Observatory read both as one number until now, which is how the $37.43 passed for a fact. **THE ALLOCATION ITSELF IS UNTOUCHED.** `src/services/grokDaySummary.test.ts` — 11 assertions, three of them reading `server/routes.ts`, `CostDashboardPage.tsx` and `CallDetailsPage.tsx` for the wiring. **5 mutations, 5 caught:** the reconciler never writing the row (4), a refusal losing its reason (2), the row forgetting the calls it read (2), the call page calling a reconciled cost estimated (1), the route renamed away from the page (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number: rows in `daily_grok_costs` — 0 today, one per runtime day from the first nightly run after this deploys (the runner settles yesterday only, so history is not backfilled unless a day is re-run); a re-run of 2026-09-12 must produce `reconciled = false` with the implausible-rate reason. The guards: `cost_reconciled_at` counts per day must not move (the allocation is untouched), and the cost-preservation trio in the cost section above must still read 0 at the OpenAI rate. **CODEX ROUND 1 ON #321 — ONE P1, REAL, TAKEN.** The scheduler attempts each day up to four times, and the upsert was unconditional — a run that could not reach xAI or the database AFTER a successful one would have overwritten `reconciled = true`, the xAI figure, the booked cost, calls and seconds with false / null / 0 while the per-call allocation stayed intact; the row would have said the opposite of the rows. `daySummaryWrite` decides: a refusal on a reconciled day, or a refusal that read no calls landing on a measured row, is recorded as `last_attempt_at` / `last_attempt_reason` and touches nothing else; a first write, a reconciliation, or a refusal that did read the calls is the full upsert. Proven on a fake pool: the failed attempt runs no INSERT . **CODEX ROUND 10 (07:52, on `9cbbed0`) — one P2 here, real, taken.** The call page's *reconciled* badge keyed on `costIsEstimated === false` — and `updateCallCostsWithTokens` (`callCostService.ts`) writes exactly that for an ordinary token-priced OpenAI call, with `costReconciledAt` NULL, so every such call wore a badge claiming the provider's reported spend had been allocated to it. The badge now keys on `costReconciledAt`; a token-priced call reads **calculated** (real usage, never checked against the bill); an estimate still reads **estimated**. The page pin in `grokDaySummary.test.ts` asserts the three arms by position and that the calculated arm never says reconciled; 1 mutation, 1 caught (the badge back on the estimate flag). **CODEX ROUND 14 (09:25, on `2dcf68a`) — a P1 and a P2 on the round-1 fix, both real, both taken on `3c7d7c5`.** (1) The preservation DECISION was a read separate from the write — three statements on the pool — and `src/server.ts` starts this scheduler in every process while `server/db.ts` supports replicas, so a failed runner that read "no row yet" while a successful runner was committing `reconciled = true` would decide `full` on a stale read and overwrite the reconciled row a moment later: the round-1 row, lost through a second door. The read, the decision and the write now run in ONE transaction on one client under `pg_advisory_xact_lock(hashtext('daily_grok_costs:<day>'))` — taken before the row is read, held through the write, keyed on the day, transaction-scoped so a runner that dies mid-write cannot wedge the day. The lock rather than an `ON CONFLICT … WHERE` predicate, deliberately: `daySummaryWrite` stays the ONE copy of the rule, and a row-level condition cannot cover two first-writers racing on a day with no row yet. PREPAREd on the live Hub before it shipped. (2) A refusal that came BEFORE the read — xAI unreachable — knew nothing about the calls, and `daySummaryFrom` wrote that ignorance as **0 calls / 0 seconds / $0.00 booked**, a measurement the run never made, which the dashboard then showed as a measured empty day. `reconcileGrokCostsForDay` now reads the day for the summary alone when the outcome never got that far; if that read fails too the row carries **NULL — UNKNOWN** — in the three measurement columns, through the type, the table (nullable; the table does not exist on the Hub yet, so the first write creates it that way), the route (`Number(null)` is 0, so it maps null to null) and the dashboard, which shows a dash. Neither read changes the outcome, and an UNKNOWN refusal counts as one that read no calls, so it never displaces a measured row. `grokDaySummary.test.ts` 17 → 25, the fake pool now handing out a client; **7 mutations, 7 caught** (the lock dropped — 2 fail; the read moved onto the pool; the rollback dropped; the summary not reading the day; the unknown day written as zero; the unknown arm treated as full; the route mapping reverted). Full suite 4,709 |
| **v45** or earlier — NOT the date | a bound on a tool that keeps SUCCEEDING with the same arguments. The ceiling's rule 1 was *"only failures count, and a success resets"*, and this file's own eleven-row table already showed every loop that reached the dispatch limit was a SUCCESS loop the failure rules could not see. **MEASURED 2026-09-17, every substantive runtime call since 09-10 (1,945 calls), by the most times ONE tool returned success with the same recorded arguments on ONE call:** ≤4 on 1,898 (97.6%); **5–9 on 30 calls, 23 of them FILED** — `lookup_patient` ×5–8 on calls that ended with a ticket, legitimate retries; **10 on none; ≥11 on 17 calls, 16 with NO TICKET** — `lookup_patient` ×35 (`CA01d27da3b5aefc6dcd5feb83b8ff0be5`, 602s), `check_open_tickets` ×35 (`CAbc5f299f63bfb36102246ba9a6fd33c2`), `resolve_location` ×35 (`CAebcb3ffe096d0bf024139cc416797a89`), each returning the SAME outcome every time. The gap between 9 and 11 is where the limits sit: **`identicalSuccesses: 10`** and, the backstop for a model that varies a field each time, **`perToolSuccesses: 20`** — the same pair shape as `identicalFailures` / `perToolFailures`, both under the 40-dispatch backstop and above every call that filed. **THE ELEVENTH IDENTICAL CALL GETS THE TENTH'S ANSWER BACK.** It is not dispatched; the model receives the tool's own last output for those exact arguments, marked `ceiling: identical-success`, with `fix` saying the answer has not changed and to speak to the caller — nothing false is sent (that IS the answer to that question) and the tool's cost is not paid again. The per-tool limit has no single answer to replay and refuses with the instruction alone and NO `message`, because v43 is what happens when a model-facing instruction sits in the channel the agent speaks. Successes are never reset within a call; a failure between the ninth and tenth identical answer does not make the eleventh new. **AND THE KEY NOW IGNORES CASE AND SPACING** — `stableKey` trims, collapses and lower-cases strings, so *"Downey"* re-sent as *"downey"* is one argument shape; this file already records the model getting 4–6 bites on a limit of 3 by varying exactly that. Different words are still different arguments. **WHAT IT DOES NOT TOUCH:** `record_pcp_intake`'s loops, whose arguments differ on every call (the director records a different field each time) — v33's ask budget bounds those; the failure rules and the 40-dispatch backstop, unchanged; and the operator's `perCallDispatches` SQL check, which still reads `>= 40`. **TWO TESTS ENCODED THE OLD RULE AND WERE REWRITTEN, NOT LOOSENED:** *"never refuses a tool that keeps succeeding"* and the bridge's *"never gets in the way of a tool that works"* both drove thirty IDENTICAL successes — the exact fixture no call that filed has ever produced — and now drive fifteen DIFFERENT questions. `src/runtime/toolCeiling.test.ts` (+9) and `mediaStreamBridge.test.ts` (+3, at the bridge so the replay is proven to reach the model). **10 mutations, 10 caught:** the identical-success check removed (4), the per-tool check removed (2), `settle` not counting a success (4), the replay dropping the tool's answer (3), the replay dropping `fix` (2), the bridge answering an identical success with the failure refusal (1), the key normalisation removed (1), either limit raised past the backstop (5, 3), and the replay reading the wrong answer (3). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The number is countable from SQL, unlike the ceiling's own stops: substantive runtime calls where one tool returned success 11+ times with the same recorded arguments — **17 since 2026-09-10, 16 with no ticket; target 0**. The guards: filing rate per lane must not fall, and calls where one tool succeeds 5–9 times (the legitimate band, 23 of 30 filed) must still file — a limit that bites there is set too low |
| **v46** or earlier — NOT the date | the after-hours line reading a phone-matched patient's appointment to whoever is calling. **MEASURED 2026-09-17, no-ivr, substantive calls over nine days (2026-09-09..17, 365 calls): the agent read an appointment — a date with a time — on 81, and on 44 of those it did so BEFORE ANY identity question at all** (12 · 6 · 6 · 2 · 3 · 3 · 5 · 5 · 2 by day). Three hand-read calls from 2026-09-16 (`CA…8ddc20db13`, `CA…97b763ab94`, `CA…e07a57a56e`) are the shape exactly: *"I just wanna know my appointment"* answered with the date, time, office and doctor of whoever the schedule matched to the calling number, the name confirmed afterwards or never — and on the first, when the caller then asked about a SECOND person, the model correctly asked for a date of birth. It knows the rule; it applies it only where the text is not already in front of it. **WHY THE PROMPT COULD NOT STOP IT:** `formatContextForAgent` rendered every upcoming appointment into the PATIENT CONTEXT section with *"AFTER IDENTITY CONFIRMED (in Phase 4): You MAY answer"* underneath, eleven lines below a pre-context block saying *"Disclose nothing from anyone's record on the strength of this match."* A sequencing instruction in front of text the model can already see is not a gate. **RULE ZERO step 2 and standing instruction 6, in as many words:** a phone match is a candidate to CONFIRM, never an identity — a household phone, a reassigned number, a spoofed caller ID. **THE FIX IS MECHANICAL, NOT VERBAL.** On a phone match (`matchedBy: 'phone'`, or the person-base rung's `identityUnconfirmed`) the prompt gets a REDACTED section: the first name only (the pre-context block's own *"do NOT speak a last name first"*), the statement that it is a candidate, and the way back — confirm the name on file, then the date of birth month/day/year and read it back, THEN `lookup_schedule(first_name, last_name, date_of_birth)`, and read the appointment from the TOOL RESULT. That is Phase 4's own standard (*"I was able to pull up a record. Is this for [Name from schedule]?" then get DOB*), not a new one. **AND THE TOOL IS THE GATE:** `lookup_schedule`'s phone-only path returned the full appointment, so one tool call would have fetched back what the prompt withheld; it now returns `{ found, identityUnconfirmed: true, patientFirstName, fix }` and nothing else, while name + date of birth returns exactly what it always did. The mandatory-lookup rule counts an UNCONFIRMED match as "no record loaded", so the model still knows to call it. **THE DISCRIMINATOR IS TESTED BOTH WAYS:** a context matched by name and date of birth keeps the full section — "always redact" would leave the after-hours line unable to answer anyone. **WHAT IT COSTS:** a caller who IS the patient now gives their name and date of birth before hearing their appointment — two questions on a line whose Phase 4 collects both for the ticket anyway. **NOT CHANGED, and a different defect:** the PCP professional line, where a clinic checking a patient's appointment is the designed purpose (`check_patient_scheduled`, `phiDisclosureAllowed: true`). `CA…8a7924d9b0` on 2026-09-16 is that path, and what is wrong there is the sentence *"I wasn't able to look that up without a date of birth"* spoken while `lookup_patient_appointments` had just found the patient — a false line, not a disclosure. `src/agents/noIvrPhoneMatchIsACandidate.test.ts` — 10 tests on the REAL agent (`createNoIvrAgent`, the tool invoked the way the SDK invokes it) plus the now-exported builder for the confirmed shape; synthetic patient, office and doctor. **7 mutations, 7 caught:** the redaction removed (3), the discriminator inverted (4), the tool's phone path handing the appointment back (1), the first name dropped (1), the mandatory-lookup rule reverted (1), the way back dropped from the tool result (1), the never-state-a-date sentence dropped (1). Console marker, PHI-free, one line per affected call: `[No-IVR Agent] PHONE MATCH IS A CANDIDATE — appointment details withheld from the prompt until the name and date of birth are confirmed`. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — no-ivr is on the OLD CORE, so this marker dates the build the way v18 and v41 do. The number: no-ivr substantive calls where an appointment is read before any identity question — **44 of 365 over nine days, target 0**. The guards: no-ivr calls that read an appointment AFTER an identity question (37 over the same window) must not vanish — the line must still answer the patient — and no-ivr tickets per substantive call must not fall |
| **v47** or earlier — NOT the date | the ambiguous lookup being COUNTABLE. `toolTimeline`'s outcome allow-list carried `matched_by` and `identity_is_certain` and not `found` or `candidate_count`, so the three shapes of `identity_is_certain: false` — found nobody, found one person nobody has confirmed, found SEVERAL — were byte-identical in SQL (the v28 row records the query answering 0 on every lane and calls that zero the instrument, not the fleet). **That blindness cost a fix on 2026-09-16:** the W1 date-of-birth carry — `forgetIfSameName` deleting the whole `verifiedIdentity` entry, pre-context date included, on an ambiguous same-name lookup — was written, and REVERTED, because nobody could say how many of the 33 refusals behind a matched lookup were that branch and how many were the no-entry gap; shipping a safety-relevant change on an unmeasurable population is the thing this operation is trying to stop doing. Two keys join the allow-list: a boolean and a count, no PHI; `candidates` and `message` stay dropped. `toolTimeline.test.ts` (+1); 1 mutation, 1 caught. **An instrument, not a fix** — it changes no behaviour a caller can hear. **NOT MEASURED IN PRODUCTION.** The number it makes readable: among runtime `lookup_patient` events with `identity_is_certain = false`, the share with `found = false` and a `candidate_count` (the ambiguous branch) against the rest — and from that, how many of the day's date-of-birth refusals on matched lookups W1 would actually rescue. The guard: nothing — a timeline that carries two more booleans changes no gate, tool or spoken line |
| **v48** or earlier — NOT the date | the runtime GRADING its own calls when they end. **MEASURED 2026-09-17 (task #139): the old core calls `callGradingService.gradeCall` at teardown (`voiceAgentRoutes.ts`, *"Grade the call if we have a substantive transcript"*); nothing under `src/runtime/` imported the grader, so every runtime call since the 2026-09-03 cutover was graded ONLY by the five-minute backfill — five rows per cycle, newest first, 60 an hour against 90–98 substantive calls an hour at peak.** On 2026-09-16 the average gap from hangup to grade was **3.5 minutes at 15:00 UTC and 161–203 minutes from 16:00 to 18:00**, and the hourly fleet watch — which reads `agent_outcome` — alarmed on a third of the fleet reading NULL. A queue, not a failure; but a queue that lags the fleet watch by three hours is a fleet watch that cannot see the last three hours. **AND THE QUEUE WAS BEING STARVED BY ITS OWN HEAD.** The two newest ungraded runtime rows had an EMPTY transcript (duration 1s): `IS NOT NULL` selected them, `if (call.transcript)` skipped them, and nothing stamped them, so they sat at the head of a newest-first `LIMIT 5` selection forever; three rows behind them were in failure backoff and `continue`d while still holding their slots. Five rows, zero attempts per cycle, and **87 calls from 2026-09-15 with deterministic `grader_results` and no `agent_outcome`** behind them that the backfill never reached. **A THIRD THING THE SAME MEASUREMENT FOUND:** `dead_air` — the 30-second silence watchdog — was recorded `status = 'failed'` unconditionally, and it fires at ANY point in a call, including after a whole conversation whose caller then walked away. **58 dead_air calls on 2026-09-14 averaging 131s and 5.9 caller lines, 18 on 09-15 averaging 7.2** — real conversations, all `failed`, so never graded (the backfill selects `completed`) and never synced to their tickets (`ticketingSyncService` selects `completed` too). **THREE CHANGES, one per finding.** (1) `runtimeGrading.ts`: the runtime grades at teardown, AFTER the row and AFTER the sweep and never awaited, with the old core's own threshold (a transcript over 200 characters); a lazy import, because the grader pulls in `server/storage`, which validates `DATABASE_URL` at load. The backfill stays, for whatever this misses. (2) `gradeCallsWithoutGrades` reads a candidate window six times its budget (never under 30), stamps `gradedAt` on a transcript under 50 characters — the empty string included — so it leaves the queue, lets a row in backoff cost no slot, and spends the budget on ATTEMPTS; a graded call leaves the backfill's selection by the same `gradedAt`, so nothing is graded twice. (3) `statusFor(outcome, transcript)`: dead_air is `failed` only when the transcript has no `CALLER:` line; `provider_failure` stays failed regardless. That is Twilio's own meaning of the column, which every other reader already assumed — completed is answered-and-ended, failed is never-connected. **NOT CHANGED:** the grader, its checks, its version, and what the Observatory reads from `grader_results`. **RIDING IN THE SAME COMMIT, task #112:** `voiceRuntime.test.ts`'s three transport-registration waits were a fixed 40ms sleep that went red in CI twice; they now `waitFor` the condition, bounded at 2s. `src/runtime/runtimeGrading.test.ts` (4), `src/services/gradingBackfillIsNotStarved.test.ts` (3, the real service over a fake storage), `callRecord.test.ts` (+2), `voiceRuntime.test.ts` (+1, at the runtime — a helper test proves the helper and not that anything calls it, failure mode 10). **8 mutations, 8 caught:** the runtime never handing the call to the grader (1), the threshold off by one (1), the grader called with no row id (1), the candidate window back to the budget (1), an empty transcript left unstamped (1), a row in backoff still costing a slot (1), dead_air failed regardless (1), dead_air completed regardless (2). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this writes a grade and a status and touches no gate, tool or spoken line. The numbers: runtime substantive calls with `agent_outcome` NULL an hour after hangup — a third of the fleet at peak on 2026-09-16, target ~0; median hangup-to-grade at peak — 161–203 min, target under a minute; and the 87 stranded 09-15 rows, which the widened backfill should drain within its first cycles. The guards: grader LLM calls per substantive call must stay at ONE (teardown or backfill, never both — `gradedAt` is the lock); runtime calls with NO caller line must still read `failed`; and the dead_air conversations now reading `completed` enter `ticketingSyncService`'s sweep, which is the point — its `ticketing_sync_error` count must not rise with them. **CODEX ROUND 7 (06:52, on `0142526`) — one P2 here, real, taken.** This row's own guard said *"grader LLM calls per substantive call must stay at ONE — `gradedAt` is the lock"*, and `gradedAt` was stamped only AFTER the LLM answered: between a completed row landing and its grade landing — the awaited sweep plus the LLM call, seconds — the five-minute backfill could select the same row and both paths paid for a grade, the last answer overwriting the first. The old core's teardown had the same race with the backfill all along; v49 added a third racer. The claim is now the stamp itself, taken atomically BEFORE the LLM is asked (`storage.claimCallLogForGrading`: `UPDATE … SET graded_at = now() WHERE id = $1 AND graded_at IS NULL RETURNING id`), inside `gradeCall` so no caller can forget it; a claim whose grade then fails is RELEASED so the backfill retries, and the one caller that means to regrade an already-graded row — the admin button — says `claim: false`. `src/services/gradingIsClaimedOnce.test.ts` — 6 tests on the real service over a fake store and a fake client: two racers pay for ONE grade, the late arrival grades nothing, a thrown or empty LLM answer releases the claim, the admin regrade bypasses it, and the automatic callers are pinned as never bypassing it. **3 mutations, 3 caught** (the claim removed — 2 fail; the release removed — 2; the admin route taking the claim — 1). Guard unchanged and now actually enforced: grader LLM calls per substantive call — ONE. **CODEX ROUND 8 (07:05, on `655a794`) — one P2 on that claim, real, taken.** A process that died between the claim and the persisted grade left the row claimed FOREVER — the catch-based release never runs and the selector reads `graded_at IS NULL` — which is WORSE than before the claim, when a crash mid-grade left the stamp NULL and the backfill retried. The claim now carries a marker (`quality_analysis = {"grading":"claimed"}`) and both the claim and the backfill selector accept a row that still reads `claimed` from longer ago than a ten-minute lease (`GRADING_CLAIM_LEASE_MS`, `gradingClaimable`); a completed grade overwrites the marker with the analysis, a release nulls it, and the dead-letter and short-transcript stamps never write it — so neither of those is ever re-spent on. `gradingIsClaimedOnce.test.ts` +5: a completed grade is never reclaimed even a lease later; an abandoned claim is taken again after the lease and not one millisecond before; the release clears both; the store's predicate, selector and claim pinned from the source; the dead-letter stamps pinned as marker-free. 3 mutations, 3 caught (the stale arm dropped, the marker not written, the release keeping the marker) . **CODEX ROUND 9 (07:21 and 07:23, on `bffeaec`) — one P2 on the lease, real, taken twice over.** The grading client was built with the SDK's defaults — a ten-minute timeout per attempt and two retries — so one legitimate `gradeCall` could outlive the ten-minute lease during an API outage: the backfill takes the row over while the first worker is still waiting, and with no OWNER on the marker either worker can overwrite the other's grade, or the first worker's late failure can null out the second's completed one through the unconditional release. Two fixes, either sufficient on its own, both taken. The client is BOUNDED (`GRADING_REQUEST_TIMEOUT_MS` 90 s, one retry) and `gradingRequestLifecycleMs()` is asserted shorter than the lease, so a claim cannot be reclaimed from under a request that is still allowed to finish. And the claim carries an OWNER TOKEN (`gradingClaimMarker(token)`, returned by `claimCallLogForGrading`): the completion write and the release both go through `ownsGradingClaim` (`quality_analysis->>'token' = $token`), so a worker whose lease expired can neither write its grade over its successor's — `completeGradingClaim` returns false and the grade is discarded with one warning line — nor release its successor's claim. The admin regrade claims nothing and still writes unfenced. `gradingIsClaimedOnce.test.ts` +4 (a grade landing after another worker took the claim is discarded and the successor's stands; the stale owner's late failure is a no-op on the successor's claim; the lifecycle fits inside the lease with the constructor pinned from the source; the store's completion and release are read from the source and both fenced); **5 mutations, 5 caught** (the completion unfenced — 2 fail; the release unfenced; the timeout back to the SDK's default; the client unbounded; the store's fence dropped). **CODEX ROUND 12 (08:39, on `f927ffd`) — one P2 here, real, taken, AND IT WAS NEVER AN OUTLIER.** The grade lands on the row seconds to minutes after teardown; the five-minute sync that carries `qualityScore`, `sentiment` and `agentOutcome` to the ticket can snapshot the completed row first, send nulls, and mark the call done — and nothing ever re-opened it. **Measured 2026-09-17 in the Support Center, agent-filed tickets with a synced transcript: 291 of 383 on 09-14, 280 of 368 on 09-15, 296 of 387 on 09-16 carry NO quality score and NO outcome, while every one of their call rows on the Hub has both**; 197 · 135 · 185 runtime rows a day were graded after the sync had stamped them. Three quarters of tickets, on both pipelines, for as long as the sync has existed. Two fixes, the round-11 pair applied to a second column: the grade's own write (`graded`, inside `gradeCall`, so the teardown grader, the backfill and the admin regrade all carry it) sets `callDataSynced: false` and `ticketingSyncRetries: 0` — a no-op on a row the sweep has not reached, a re-open on one it has — and the sweep's mark-done is conditional on the grade the payload carried as well as the recording (`quality_score`, `agent_outcome::text`, `sentiment::text`, each `IS NOT DISTINCT FROM` its typed parameter, PREPAREd on the live Hub), so a grade landing mid-flight leaves the row pending for the next pass. `gradingIsClaimedOnce.test.ts` +2, `ticketingSyncService.test.ts` +1; **2 mutations, 2 caught** (the re-open dropped — 2 fail; the grade dropped from the condition). The number: agent-filed tickets with a transcript and no `quality_score` — **~76% on 09-14/15/16, target ~0** from the first sync after this deploys. The guard: `update-call-data` POSTs per call must rise by at most one, and `ticketing_sync_error` must not rise — the second POST is the same idempotent payload with the grade on it |
| **v49** or earlier — NOT the date | the lookup's second identity miss ending the ask on the queue lanes. **MEASURED 2026-09-16 on the runtime lanes: the agent asked for a date of birth 2+ times on 35 substantive calls (surgery 16, tech 16, optical 3), 3+ on 13, and on tech 15 of the 16 were COLD callers** — nobody pre-context recognised, so v25–v28 (the recognised-caller fixes) never touch them; the W2 recommendation to wait for their after-arm was wrong for that lane and is withdrawn. **THE LOOP IS NOT A FILING-TOOL LOOP.** Those calls hit `file_*_ticket`'s date-of-birth refusal at most once (`dobShape` `(none)`, `decideDobEscape` working) and called `lookup_patient` 2.5–6.5 times each: the agent asks, the caller answers, the lookup misses, and the tool's own miss message — *"Ask for their name and date of birth if you have not already"* — sent it back to ask, every time, with no count. **THE COUNT NOW LIVES IN THE TOOL**, keyed on the call like every other per-call budget (`gateAttempts`): a miss counts only when the lookup CARRIED a name or a date of birth (the phone-first pass on a cold caller is not an ask the caller answered); the first identity miss coaches the ONE re-ask RULE ZERO 2b would shape anyway (spell the surname; month, then day, then year), and the second (`LOOKUP_MISS_LIMIT = 2`) says stop and file — the spoken line becomes *"No record found under those details. That is fine — I will take the request as given…"* and `fix` says do not ask again. That is the operator's 2026-09-04 ruling on the filing tool (*"ask once, then file anyway"*) applied one layer earlier, and v33's once-to-ask-once-if-mis-heard. **THE TRADE, MEASURED BEFORE THE LIMIT WAS CHOSEN** (09-15 / 09-16, ~310 calls with a lookup per day, `matched_by` as the hit signal because `found` is v48's and not yet deployed): ~250 found on the first lookup, 9 / 16 on the second, **10 / 7 only on the third or later** — matches a bound can cost, though most of those are the phone-first miss, one identity miss, then a hit, which this bound allows, and a ticket still files for the rest, unmatched, for staff to match; against that, **16 / 13 calls missed three or more times and were never found, and 10 / 7 of THOSE left no ticket at all.** A lost request outweighs a lost match; the limit is the dial. `lookup_misses` joins the timeline allow-list (a count, no PHI) so the after-number is SQL. `src/tools/theSecondMissEndsTheIdentityAsk.test.ts` — 9 tests through `runTool`; **7 mutations, 7 caught**: the limit unreachable, the first-miss coaching dropped, a phone-only miss counted, the stop line sending the model back to ask, the allow-list key dropped, the count not keyed on the call, the ambiguous branch counted as a miss. **A sentinel CallSid never reaches the limit** — gateAttempts' own rule — so those calls keep the old ask-every-time behaviour. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the identity path says on the busiest lanes. The numbers: runtime substantive calls asking for a date of birth 3+ times — **13 on 2026-09-16, target 0**; 2+ — 35, target down; and `lookup_misses = 2` events per day, which is how often the stop fired. The guards: **filing rate per lane must not fall**; calls found only on a later lookup today (the 3rd+ band, 7–10/day) must still FILE even if unmatched; and tickets carrying a date of birth that is not the patient's must stay 0 — the tool never invents one |
| **v50** or earlier — NOT the date | the record reaching the CALL ROW. **MEASURED over the seven days to 2026-09-17, every substantive call on every lane: `patient_found`, `patient_name` and `patient_dob` were NULL on ALL 2,914 — 2,471 of them on this runtime** (tech 926, pcp 605, surgery 532, optical 408), with `caller_name` set only on the old core (Twilio's CNAM, which this file already records as not a patient match). Task #57 recorded the runtime half as done — *"identity rides on the VoiceCallRecord, sourced from the call-facts ledger"* — and that was the `src/core` runtime deleted on 2026-09-01; this runtime was built beside it (PR #227), `persistRuntimeCall` has taken an `identity` argument nobody supplied since, and `toConflictUpdate` excluded identity from the update path every normally-opened row takes. Two absences, so a name never reached a row. **THE SOURCE IS THE STORE THE TOOLS ALREADY KEEP:** `lookup_patient` remembers a unique match per call in `verifiedIdentity.ts`, and `verifiedIdentityFor` — the teardown sweep's own reader — refuses an UNCERTAIN entry, because a phone match is a candidate to confirm and never an identity (RULE ZERO step 2, standing instruction 6). `identityForRow` reads that accessor at teardown and hands `persistRuntimeCall` `{ patientFound, patientName, patientDob }` for a CERTAIN match and nothing otherwise; the conflict update now carries identity when present and never nulls it, so it can add a name the row lacks and can never erase one another writer established. Read at teardown rather than written from inside `lookup_patient`, because a database write inside that tool's 6s budget is a latency cost on the ticket path and the upsert already runs at hangup. `src/runtime/runtimeIdentity.test.ts` (4), `callRecord.test.ts` (+2, and two rewritten — they asserted the exclusion), `voiceRuntime.test.ts` (+1, at the runtime with a canonical SID and both a certain and a candidate entry); **3 mutations, 3 caught**: the teardown no longer handing the identity over, the conflict update dropping it again, the accessor accepting an uncertain entry. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this writes three columns and changes nothing a caller hears. The number: runtime substantive calls with `patient_found = true` — **0 of 2,471 in seven days, target ≈ the share whose lookup matched one person**. The guard: a row carrying a name for a call whose lookup was only a phone candidate must stay 0 — the accessor refuses those, and the test drives one. **CODEX ROUND 4 (05:30) — one P2 here, declined on the number.** A `lookup_patient` that finishes after hangup stores a CERTAIN identity the teardown read has already missed: 3 of 1,553 runtime calls in seven days had any lookup event after `end_time`, 1 of them CERTAIN, 0 more than 2s late — the operator's sub-1% rule; recorded on #57 with the fix named (teardown awaiting in-flight dispatches, bounded by the tool's own 6s budget) |
| **v51** or earlier — NOT the date | the per-call cost write PARSING. **From `8a226a6` (2026-09-04 05:20, Codex round 13 on #268) every UPDATE that carried both a provider and a Twilio price was rejected by Postgres at PARSE** — `operator is not unique: unknown + unknown`, **3,749 times in the 24h to 2026-09-17 05:40 UTC**, read from the Hub's own postgres logs, not inferred. `buildPreservedCostSet` rendered the unreconciled total as `$4 + $5`: node-postgres sends every parameter as untyped text and the server infers a type from context, `col + $n` infers from the column, `$n + $m` has nothing to infer from. The reconciled branch (`COALESCE(col, 0) + $3`) and the one-sided writers parsed, which is why the failure looked partial: `twilio_cost_cents` was written on 544/544 and 482/482 completed calls on 09-01/02 and on 104/502 · 43/615 · 51/783 · 175/808 on 09-04 · 09-08 · 09-15 · 09-16; `cost_calculated_at` fell from 100% to 30–50%. **So the Observatory's cost views have carried a total with no Twilio component on 78% of calls for thirteen days** (4,295 of 5,486 completed calls since 09-04), and the 5-minute Twilio-cost sweep fetched each of those prices from Twilio's API every cycle and threw the answer away against the same parse error — that sweep IS the 3,749. **The guard's own test file could not see it:** every assertion rendered the SQL and read the shape, and none of them could read a type; `PREPARE` on the live Hub reproduces the refusal with two fresh parameters and accepts it with `::integer` on both (executes nothing — `WHERE false`). The fix is the column's own type on the bound value (`typedCents`), which changes no arithmetic and inlines nothing; `preservedCostSet.test.ts` +4, **3 mutations, 3 caught** (either cast dropped, the helper losing its cast). **WHAT THIS DOES NOT DO:** the sweep looks back four hours, so the 4,295 rows already missing a Twilio price stay missing until an admin recalculation runs — about 4,300 Twilio price fetches, the operator's call on timing. `docs/BACKEND_HANDOFF.md` applies. The number: completed calls per day with `twilio_cost_cents` set — **5–25% since 09-04, target ~100%** from the first call on this build, and `operator is not unique` lines in the Hub postgres log — 3,749/day, target 0. The guard: the cost-preservation trio in the cost section must still read 0 at the OpenAI rate, and `cost_reconciled_at` counts per day must not move — a reconciled row still keeps its invoice, and the tests that say so are unchanged. **Beside it, four partial indexes on `call_logs` were created on the Hub at 05:45 UTC** — live objects, in no branch, DDL and reversal in `docs/observatory/AFTER-MEASUREMENTS-20260917.md` — because the four 5-minute sweeps in `ticketingSyncService` each seq-scanned the whole table (11.7–26 s in the postgres log when cold; 1 and 9 buffers after) and that load sits beside the `lookup_patient` timeouts that came back on 09-10 (task #68) |
| **v52** or earlier — NOT the date | the record reaching the AFTER-HOURS call row — the old-core half of task #57. **Measured over the seven days to 2026-09-17: `patient_found` set on 0 of 297 substantive no-ivr calls.** The lane HAD a writer, at factory time beside the phone lookup, and it could never fire: `metadata.callLogId` is a getter the transport backfills after `session.connect()` — the same bug `answeringServiceAgent.ts:606` documents fixing on its own line — so at factory time it read `undefined` on every call. And what it would have written was the PHONE match: `patientFound: true` with the matched name — a candidate recorded as an identity, the shape v47 withholds from the prompt and v51 refuses on the runtime (RULE ZERO step 2, standing instruction 6). Both fixed as one change: the factory-time write is gone, and `create_ticket` writes the row once `enrichedContext` is CERTAIN — `patientFound`, `patientName`, `patientDob`, office and provider — which on this lane means the name + date-of-birth lookup matched (`!phoneMatchIsUnconfirmed`, the v47 predicate), reading the getter at that moment, minutes into the call. Not awaited: the caller is waiting on the ticket, not on telemetry. A phone match whose name+DOB lookup misses writes nothing; a B2B caller with no date of birth writes nothing; a confirmed identity with no row id yet is logged and skipped, and the ticket still files. `src/agents/noIvrIdentityReachesTheCallRow.test.ts` — 5 tests on the REAL agent with the transport's getter shape (undefined at the factory, set before the tool runs); **3 mutations, 3 caught**: the write never firing (the pre-v53 outcome), a phone candidate written as an identity, the factory-time context written instead of the confirmed one. **WHAT IT DOES NOT COVER:** the records lane on the old core (146 calls in seven days) has no identity writer at all, and the recommendation on #82 stands — flip its number onto the runtime, where v51 already does this. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — no-ivr is on the OLD CORE, so the marker dates the build the way v18/v41/v47 do. The number: no-ivr substantive calls with `patient_found = true` — **0 of 297, target ≈ the share whose `create_ticket` carried a name and date of birth that matched** (139 of 297 called `create_ticket`; the share that also matched is the ceiling). The guard: a no-ivr row carrying a name for a call whose only match was the phone must stay 0. **CODEX SIXTH PASS (06:31, on `fef236b`) — one P2 here, real, taken.** `buildContext` answers a name + date-of-birth query that matches SEVERAL people with `patientFound: true`, `identity.unique: false` and the newest person's rows as the primary — and the write read only `phoneMatchIsUnconfirmed`, so a collision on the lookup's name prefixes plus the date would have recorded an arbitrary patient's name as this caller's identity: the wrong-patient hazard the v25–v28 guards name, arriving through a door those guards do not watch. The write now also requires `identity.unique !== false` — one person, or nothing. +1 real-agent test (several people on the trio → no write); 1 mutation, 1 caught |
| **v53** or earlier — NOT the date | the affirmed name picking one person among several on a phone. **Measured 2026-09-16, the first full day with v27 live: runtime date-of-birth refusals on callers the greeting addressed by name fell from 50 (09-14) to 26 — and all 26 read `carry = no_entry`**, the v25 instrument's answer to "why did inherit not fill it": there was nothing to inherit FROM. Their lookups had matched by PHONE with `identity_is_certain: false` (20 of 26 on the phone alone), and in 0 of 26 was a match followed by a miss, so it was not the v12 wipe. It is the third shape the v28 row enumerates: the Schedule phone rung finds SEVERAL people on the number, returns the most recently seen one with `identity.unique: false`, and `lookup_patient` skips its remember because the match is not unique — so the filing tool finds no entry and asks for a date of birth the greeting's own question had already settled. **The affirmed name never reached the tool.** RULE ZERO step 2, in code: when `lookup_patient` is called with a first name and the phone match is non-unique, the candidates are narrowed by that name (`nameKey`); exactly ONE hit is re-resolved on its own name and date of birth and carried as CERTAIN — remembered with the chart date, `matched_by: phone`, `identity_is_certain: true`. Two people sharing the first name (a father and a son) or a name matching nobody leave the guess as it was; a re-resolve that misses leaves it too. The recognised-caller block's YES bullet now tells the model to call `lookup_patient` with `first_name "<name>"` — their yes is what locks the record — which costs ~24 tokens on the recognised arm, so the three v29 ratchets are raised once more with the reason beside them. `src/tools/theAffirmedNamePicksThePerson.test.ts` — 6 tests through `runTool` with an invented family on an invented number; **4 mutations, 4 caught**: the narrowing never running (pre-v54), two people sharing the name still picked, the guess promoted without re-resolving the picked person (the remembered date would be the wrong sibling's), the YES bullet no longer feeding the name. **The six "asked twice" calls of 09-16 were read too and are NOT the v26 defect:** in every one the caller answered the greeting's question with "hello?" and the agent asked once more — a legitimate re-ask, recorded on #126. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the identity path carries onto the ticket. The number: runtime `date_of_birth` refusals on callers the greeting addressed by name — **26 on 2026-09-16 (16 with no ticket on the row), target near 0**; and `lookup_patient` events with `matched_by = phone` AND `identity_is_certain = true`, which should appear on recognised calls. The guard: tickets carrying a date of birth that is not the patient's must stay 0 — the promotion needs exactly one candidate with the affirmed name, and the re-resolve is on that person's own trio. **CODEX SIXTH PASS (06:31, on `fef236b`) — one P1 here, real, taken.** The re-resolve calls `lookupPatient` with the picked person's trio, and that dispatch FALLS THROUGH when the trio misses — past the phone rung (no phone is passed) to the NAME rung, whose first-name predicate is a three-character prefix — so a stored date that no longer resolves would have handed back a similarly named STRANGER as `matchedBy: 'name'`, which the promotion then relabelled phone-confirmed and remembered, date and all, for the ticket to inherit. Exactly the guard this row names, defeated one rung down. The promotion now requires `picked.matchedBy === 'name_and_dob'`: only the trio itself promotes. +1 test through `runTool` (the trio misses, the name rung returns a stranger → the guess stands, nothing remembered); 1 mutation, 1 caught |
| **v54** or earlier — NOT the date | the follow-up after a tool NOT waiting for a `response.done` that has already passed — and the first per-call record of what happened to that follow-up. **FOUND 2026-09-17 07:00 WHILE RUNNING THE #51 CORPUS, and it is the largest lost-request class on the runtime that nothing had a name for.** Runtime lanes, substantive, no ticket on the row, `runtime_outcome = dead_air`, the LAST tool event a `file_*_ticket` REFUSAL and the LAST audible agent line the pre-tool filler (*"Let me get this logged for you — one moment"*): **09-10: 26 · 09-11: 25 · 09-14: 42 · 09-15: 9 · 09-16: 15** (of 141 / 113 / 265 / 224 / 224 no-ticket calls those days); widened to ANY last-event filing refusal with no ticket, 39 / 36 / 58 / 20 / 29. Read per call on 09-16 (17 calls): the refusal answered in **6–18 ms** (13 × `date_of_birth`, all `carry = no_entry`; 2 × `surgeon` at ~450 ms), the model's last words were the filler it spoke BEFORE calling the tool, the caller said nothing transcribable (they had been told "one moment"), and the 30 s watchdog tore the call down **37–67 s** after the refusal. The refusal's spoken question was never heard. **THREE CONTROLS, in the order they were run.** (1) The explicit follow-up path is NOT dead: on filed calls the ticket readback follows the filler DIRECTLY 305 times over 09-15/16, and on unfiled calls the date-of-birth question does so 20 times — so it fails on a subset. (2) It is not a rejected `response.create`: `provider_failure` is 0 on 09-16, 2 on 09-15. (3) It is not an invisible barge-in: `interruption_count` never exceeds the transcript's `[interrupted]` marks on any of 1,117 calls, and **9 of the 12 uncut silent calls had ZERO interruptions** — filler complete, tool refused, nothing for 30 s, no caller event at all. **WHAT THE CODE HAD:** `handleToolCall` set `awaitingToolResponseDone = true` unconditionally — *"function-call events precede their response's `response.done` on the ordered wire"* — and only a LATER `response.done` cleared it. A function-call event arriving AFTER its response's done waited forever for a done that had already passed: no follow-up, silence, dead air at 30 s — exactly this shape after a fast tool. **THE MECHANISM IS NOT ESTABLISHED FROM DATA AND THIS ROW SAYS SO:** `call_events` had no runtime writer, `call_turns` is empty until v44 deploys, the `[runtime]` console lines are gone, and no column counts responses — so whether the wire ever emits `done` before the function-call event is a hypothesis that fits every measured fact and is proven by none. The fix is harmless if it is wrong: the bridge now ASKS the session whether the carrying response is still open (`isResponseActive()`, true from `response.created` to its `done`) instead of assuming it, and waits only then. **AND THE INSTRUMENT IS THE OTHER HALF:** every call that ever owed a follow-up writes ONE PHI-free `call_events` row at teardown (`category = model`, `message = follow_up_summary`: owed, requested, `toolCallsAfterDone`, `lastUnanswered`, outcome) — the first runtime writer that table has had since 2026-08-13. `toolCallsAfterDone > 0` tomorrow is the hypothesis confirmed; `lastUnanswered = true` with it at 0 is the hypothesis refuted and the next link named. `src/runtime/mediaStreamBridge.test.ts` +5 (the after-done event gets its follow-up on settle — RED on the old gate; the in-response event still waits; the record's four numbers both ways), `grokSession.test.ts` +1, `src/runtime/followUpTelemetry.test.ts` (7, the runtime's call site pinned by reading the source). **6 mutations, 6 caught**: the gate unconditional again (2 fail), the after-done count dropped, `lastUnanswered` pinned false, the runtime never writing the row, the summary never warning (2), the wire always saying open. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes WHEN a follow-up is requested, on every lane. The numbers: refusal-then-silence dead-air calls per day — **15 on 2026-09-16, target 0**; and `follow_up_summary` rows with `toolCallsAfterDone > 0`, which is the count that decides whether the hypothesis was right. The guards: filing rate per lane must not fall; `dead_air` outcomes must FALL, not migrate to `caller_hangup`; and a response must never be requested INTO an open one — the session still refuses that and the tests that pin it are unchanged **CODEX ROUND 9 (07:21 and 07:23, on `bffeaec`) — one P1 and one P2 here, both real, both taken.** THE P1: the v55 gate read EVERY after-done function-call event as a batch of one, so when a response carried two tool calls and both arrived after its done, the first dispatch — the ceiling's refusal settles synchronously — dropped `pendingToolCalls` to zero and requested the model's turn before the sibling's event had been read off the socket; the sibling then earned a SECOND follow-up, which is the round-14/17 unsolicited-reply race of #227 back through the late door. No `response.done` can close a late batch (the wire's already passed), so the bridge now holds the follow-up for `LATE_TOOL_BATCH_GRACE_MS` (250 ms) after the LAST late event settles — re-armed by every late sibling, cleared at teardown, and never armed for an in-response batch, which the done still closes with no added wait. A quarter of a second against the thirty seconds of silence the late event used to cost. `mediaStreamBridge.test.ts` +4 (two late events with the first settling before the second arrives get ONE follow-up after both and leave no second window behind; a sibling inside the window keeps it open; an in-response batch arms nothing; teardown inside the window arms nothing); **4 mutations, 4 caught** (the window removed — 5 fail; the sibling not re-arming — 1; the window on every event — 10; teardown leaving the timer — 1). THE P2: `logRuntimeFollowUps` released its `call_events` buffer in an unconditional `finally`, and `flushCallEvents` swallows a failed insert and hands the events back for a retry — so a database blip at teardown deleted the only copy of the `follow_up_summary` row on exactly the calls the blip had made unmeasurable, the shape round 4 fixed in the turn writer. `flushCallEvents` now answers whether it landed; the writer retries on the teardown write's own backoff (`PERSIST_RETRY_BACKOFF_MS`) and releases only on a landed flush, leaving the rest for the 2h reaper. `followUpTelemetry.test.ts` +3 and `callEventLogFlushIsHonest.test.ts` (2, the real module over a failing then recovering `db`); **2 mutations, 2 caught** (the release unconditional; a failed flush reporting true) | **THE HYPOTHESIS IS REFUTED — measured 2026-09-23 on the instrument this row shipped for exactly that purpose.** Over **1,992 `follow_up_summary` rows, `toolCallsAfterDone` is 0 on every one** (total 0). A function-call event arriving after its response's `done` never happens on this wire, so the mechanism this row describes does not fire and the v55 gate — which asks the session instead of assuming — is harmless and is NOT what was costing the refusal-then-silence dead air. `lastUnanswered` is true on 8 rows. **v56, shipped beside it, is doing the work instead: 143 calls held a hangup and 166 holds in total**, i.e. 143 calls where the model tried to end the call holding a tool answer it had not put into words. Refusal-then-silence dead-air calls went **18 (09-16) → 6 (09-22)** and `dead_air` overall 29 → 16; four ships landed in that window (v49, v50, v55, v56) so v56 is the leading CANDIDATE for the fall and not a proven cause. The fix stays — it is correct, cheap and was shipped as harmless-if-wrong on its own terms — and the row keeps its reasoning as the worked example of a mechanism that fits every measured fact and is proven by none |
| **v55** or earlier — NOT the date | a tool answer the agent never voiced being able to END THE CALL. **FOUND 2026-09-17 08:00 reading the residual "other" bucket of the #144 death map, and MEASURED before anything was built:** PCP runtime calls ended by `terminate_call` (`runtime_outcome = agent_ended`) whose LAST agent line was the agent's own question or *"one moment"* — **17 · 32 · 38** on 09-14/15/16, of 30 · 57 · 61 agent-ended calls; 18 of the 38 on 09-16 with no ticket. The clearest sub-shape is the designed no-ticket path: `lookup_patient_appointments` → `record_automated_resolution` → `terminate_call` with the appointment answer NEVER SPOKEN — **9 · 9 · 9** a day. Seven of the nine on 09-16 read per call: the caller's last line is their ANSWER to the agent's question (the patient's name and date of birth, an email address, *"I just want to confirm if the patient has an appointment there"*), the lookup succeeds, the model records an automated resolution and calls `terminate_call` in the same tool chain with no spoken turn between, and the bridge hangs up. A clinic asked whether a patient has an appointment, gave everything, and was disconnected with no answer and no ticket. Only PCP has an end-call tool on the runtime (optical/surgery/tech: 0 such events), so this is PCP-only until no-ivr and answering-service move. **WHY THE TOOL'S OWN GUARD COULD NOT SEE IT:** `terminate_call` checks `mayTerminate` — a DISPOSITION is durably recorded — and `record_automated_resolution` records one; nothing anywhere asked whether the model had put the result into WORDS. And `record_automated_resolution` returned bare success with no instruction to speak — the exact shape the records tool's own comment in `pcpAgent.ts` documents fixing for itself on `CAdc07bca1` (*"Nothing told the agent to speak, terminate_call became legal the instant the disposition was recorded, and the caller got … a dead line"*), one tool over and never applied here. **TWO FIXES, one structural and one local.** THE BRIDGE (operator, 2026-09-15: *"the things that are applicable to any conversation should be in the runtime"*) now REFUSES an end-call tool before dispatch while the model holds a tool answer it has not voiced — `toolCallSettled(true)` remembers the agent-line count a follow-up-owing answer arrived at, `noteTranscript("agent")` advances it, and a hangup is held while the two are still equal; an utterance already streaming counts as the words (`requestHangup` waits on its completion, as it always has). The refusal carries `fix` telling the model to tell the caller what the tool found or filed, ask if there is anything else, and end the call after they answer; it settles like any other refusal, so the follow-up is requested and the model speaks. **BOUNDED at `HANGUP_HOLD_LIMIT` = 3** holds per unvoiced answer: a model that answers every refusal with another silent hangup is let go rather than looped against a refusal forever — a hangup beats a dead line. Counted on the record (`hangupsHeld`) and carried on the `follow_up_summary` `call_events` row, so the guard's own firing is SQL-readable, unlike the tool ceiling's. AND `record_automated_resolution` gains the `guidance` the records tool has — say the appointment date, time, office and provider, or that nothing is scheduled, then ask if there is anything else — so the model holds the instruction the refusal sends it back to. `mediaStreamBridge.test.ts` +6 (the refusal with its instruction and the owed turn; the hangup after the agent has spoken; a ghost call with no tool at all; the utterance in flight; the bound; the record's count both ways), `followUpTelemetry.test.ts` carries the field, `src/pcp/automatedResolutionSpeaksTheAnswer.test.ts` (2). **7 mutations, 7 caught**: the guard removed (3 fail), the streaming utterance not counted, agent lines not counted, the hold unbounded, the record not counting, the tool answer never remembered (3), the automated-resolution instruction removed (2). **A SECOND FACT read on the way, not fixed:** on the runtime every PCP `terminate_call` POSTs to OpenAI's SIP hangup endpoint — the old core's — and gets 404 (63 of 64 on 09-16); `guardsAllowedTermination` treats a numeric status as "guards passed" and the bridge hangs up, so the call ends correctly and the tool's own success branch (`pcpDirector.clear`, `markCallConcluded`) never runs. Harmless today, a wasted authenticated HTTP call per PCP hangup; on task #147. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes when a call may END, on every lane with an end-call tool. The numbers: PCP agent-ended calls whose last agent line is a question or *"one moment"* — **38 on 2026-09-16, target 0**; the lookup-then-hangup-unspoken shape — 9 a day, target 0; and `hangupsHeld > 0` rows in `follow_up_summary`, which is how often the guard fired. The guards: PCP `agent_ended` must not fall to zero (a hangup after the model has spoken still goes through); PCP `dead_air` and `max_duration` must not rise (a held hangup must not strand a call — the bound is why); PCP tickets per substantive call must not fall. **CODEX ROUND 11 (08:16, on `84aabf5`) — one P2 here, real, taken.** The counter this guard reads was advanced by `noteTranscript("agent")`, which `handleAudioDone` calls on EVERY response completion — including one that opened no utterance, the shape the greeting test already models (`onAudioDone` with no audio delta). So a silent `response.done` after the tool result — a response carrying nothing but the next tool call — counted as the words, and a `terminate_call` on the response after it went through with the answer still unvoiced: the defect back through a side door. The clock and the words are now two things. `noteTranscript` stamps the clock exactly as before (Codex round 14 of #227 is about that stamp and it is untouched), and `noteAgentWords` advances the line count only where the caller HEARD something — an utterance whose audio started (`handleAudioDone` after its `done` check), or a cut line committed at a barge-in, a guardrail or the teardown. `mediaStreamBridge.test.ts` +2 (a no-audio completion leaves the hangup held; words heard before a barge-in count as the words); **3 mutations, 3 caught** (the completion counting again — the defect; a completed utterance never counting; the barge-in cut not counting). **CODEX ROUND 12 (08:39, on `f927ffd`) — two P2s here, both real, both taken — and the first is load-bearing for this row's own headline.** (1) When ONE response carries a lookup or a filing AND `terminate_call`, the hangup's event arrives before its sibling has settled; `unvoicedToolAnswerSeq` is set only in `toolCallSettled`, so the guard read null and let the call end before the sibling's answer could be spoken — the `lookup_patient_appointments > record_automated_resolution > terminate_call` shape counted above, arriving in one batch, would have walked straight past v56. An end-call now WAITS for its in-flight siblings (`pendingSiblings`, a set of the non-end-call dispatches still open, woken from each dispatch's `finally` after its settle and by teardown) and only then runs the guard — which now sees the settled answer and holds. Bounded by the siblings' own dispatch budgets. (2) `current` is opened by the FIRST transcript delta, before any audio byte has reached Twilio, so text nobody has heard read as an utterance in flight and unlocked the hold; and a completion whose utterance carried text and never a byte counted as words. Both now read `bytes > 0` — audio, not text. `mediaStreamBridge.test.ts` +4 (a transcript delta alone still holds; a text-only completion still holds; the end-call in a batch with a slower tool is not decided until that tool answers, and is then held, with ONE follow-up for the batch; a call ending mid-wait leaves nothing dangling); **4 mutations, 4 caught** (the wait removed — 2 fail; the wait resuming on an ended call; the guard's bytes check dropped; the completion's bytes check dropped). **CODEX ROUND 13 (08:58, on `2dcf68a`) — one P2 on the round-12 wait, real, taken.** `pendingSiblings` is EMPTY when `terminate_call` is the FIRST function-call event of its batch — the lookup that follows it on the wire has not been read yet — so the round-12 wait was skipped and the same shape walked straight through whenever the hangup happened to be emitted first. The wait is now for the BATCH BOUNDARY as well as the siblings: `endCallMustWait()` is one predicate — a sibling in flight, OR the carrying response still open at the wire (`awaitingToolResponseDone`), OR a late batch whose grace window has not elapsed — read by the wait and by every wake point (a sibling's `finally`, `handleResponseDone`, the window's timer, and teardown, which clears all three so the waiter reads `ended`). **THE WINDOW IS NOW ARMED AT THE LATE EVENT'S ARRIVAL**, not only by the follow-up path once every dispatch has settled: an end-call waiting on the window is itself a pending dispatch, so a settle-armed window could never have been armed while it waited — the wait would have been forever. The round-9 property is unchanged (one follow-up after both siblings, no second window) and its test is rewritten to the arrival-measured window, not loosened; a lone late end-call now costs a quarter of a second, no more. `mediaStreamBridge.test.ts` +3 (terminate FIRST in an open response, then the done, then the sibling answers → held; terminate FIRST in a late batch with the sibling landing inside the window → held; a lone late end-call decided when the window closes); ten in-response terminate tests gain the carrying response's done. **7 mutations, 6 caught** (the done dropped from the predicate — 1 fail; the window dropped — 2; the done not waking — 12+; the window armed only at settle — 3; the timer not waking — 1; the wait resolving at once — 5); the seventh — teardown leaving the two flags set — survives and is benign: the parked waiter would only run `if (this.ended) return`, and nothing but the bridge references it. Full suite 4,701 |

| **v56** or earlier — NOT the date (v57 is retired; this ship is **v58**) | any record of WHY the identity did or did not reach the call row. **MEASURED 2026-09-17, the first full day on v56: `patient_found = true` on 0 of 633 grok calls and `patient_name` NULL on all 633, while 209 of those calls ran a `lookup_patient` that reported `identity_is_certain: true`** (187 by phone, 22 by name and date of birth). **THE 09-17 VERIFICATION THAT SAID v51 LANDED WAS WRONG AND IS WITHDRAWN:** it read "patient_found set on 633/633", and `shared/schema.ts:558` declares that column `.default(false)`, so it reads `false` on every row whatever the build does — a column default quoted as evidence, which is failure mode 8 in a new place. **v51 IS DEPLOYED AND PRODUCES NOTHING**, and seven candidate causes were ruled out from outside without reaching the eighth: not deployed (v52 sits above v51 in the same chain and IS live — `twilio_cost_cents` on completed calls went 6.5-24% to **100.0%**, 741/741 on 09-17); two module instances (probed under `npx tsx`, the production entry point — one instance, the dynamic write visible to the static read); the column mapping; the model overwriting `call_sid` (`realtimeAdapter.ts:203` spreads injected LAST); the lane agent cached with a frozen SID (`resolveLane` calls the factory fresh per call); the chain itself (the real `lookup_patient` through `runTool`, then `identityForRow`, returns the name for a unique phone match AND for name+dob); and `forgetIfSameName` clearing the entry — **192 of the 209 never went ambiguous at all and 208 of 209 ENDED on a certain lookup**. A second, independent reader agrees: the v25 `carry` instrument has never once reported `fired` — `no_entry` 147, `name_mismatch` 7, **`fired` 0 of 154** across 09-15/16/17 — and those 7 mismatches prove the store is not globally empty, which is what makes the zero strange rather than simply broken. **THE REASON SEVEN CONTROLS COULD NOT REACH IT IS THAT `identityForRow` RETURNING `{}` IS INVISIBLE** — no console line, no column, no timeline key — and that one `undefined` is four different facts. `identityStoreProbe` (PHI-free: counts and booleans, never a name, a date or a map key) and one `call_events` row per call (`category = 'tool'`, `message = 'identity_summary'`) split them: `storeSize 0` is nothing in the store at all; `storeSize > 0` with `hasEntry` false is entries under OTHER keys, the write and the read disagreeing about this call's SID — the hypothesis the production data could not test; `hasEntry` with `entryCertain` false is the entry surviving and its certainty not; `entryCertain` without `reachedRow` is v51 failing outright, and that arm plus the key mismatch are the only two that WARN. **AN INSTRUMENT, NOT A FIX** — the v47/v48 move, deliberately, because identity is the one field where a wrong answer puts one patient's name on another patient's request. **EVERY call writes a row**, unlike v55's summary which skips: here "there was nothing in the store" IS the finding, so a skip would hide the population being measured. **THE COST IS NOT WHY THIS SHIPS:** only 9 of 09-17's 47 date-of-birth refusals were on a call with a certain lookup and 1 of those left no ticket, which is the sub-1% shape the operator has ruled out chasing. What it buys is the end of the blindness — 209 calls a day where the process knew who was calling and the row says nothing, which is the measurement #57, #109 and #110 all rest on. `src/tools/identityStoreProbe.test.ts` (8, driving the REAL `lookup_patient` through `runTool` rather than a hand-seeded map — v51's own test seeded by hand, which is why it could never see this) and `src/runtime/identityTelemetry.test.ts` (16, four of them reading `voiceRuntime.ts` for the wiring). **11 mutations, 10 caught**: the probe evicting what it reports (4 fail), `certainEntries` never counted (2), `certain_but_dropped` collapsed away, `key_mismatch` never detected, the level pinned to info (2), the writer skipping an empty store (4), the buffer released after a failed flush, the runtime never calling the log, the probe taken AFTER the write, and the seam losing its default. **THE ELEVENTH SURVIVES BY DESIGN AND IS RECORDED RATHER THAN FAKED:** removing the `sidCanonical` guard from the probe's READ fails nothing, because `rememberVerifiedIdentity` refuses a non-canonical key on the WRITE so the map can never hold one — the guard stays for the reason `verifiedDobFor` states about its own, that both ends name the same rule so it survives a later relaxation. **A FIXTURE PREMISE WAS CORRECTED BY THE FIRST RED RUN:** a NON-UNIQUE phone match stores NOTHING (the remember sits under `if (uniqueMatch)`), so it yields an empty store and not an uncertain entry — which is why v54's finding that 26 of 26 recognised callers read `carry = no_entry` is internally consistent rather than surprising, and the uncertain-entry arm needs a unique NAME-only hit. **NOT MEASURED IN PRODUCTION** — it changes no gate, no tool and no spoken line. The number it makes readable: the share of each `verdict` among `identity_summary` rows, and from that the eighth cause. The guard: `patient_found` behaviour must not move — this reads the store and writes a telemetry row, and a call that wrote a name still writes it. **CODEX ROUND 4 (on `66c77d5`) — one P1, real, taken, and it is the door this PR opened.** `releaseCallEvents` did `buffers.delete(callId)` — the WHOLE per-SID buffer — and `flushCallEvents` answers TRUE for a call it cannot find, because from its side nothing is left unflushed. Both teardown writers share that buffer, so on **every runtime call that owed a follow-up**: the follow-up writer flushed its own row, released, and took the `identity_summary` row emitted a microtask later with it; the identity writer's flush then found no buffer, reported durable, and the row was gone. Round 3's reply to the same race said the reaper would recover it — true of a predecessor that FAILS, false of one that SUCCEEDS, which is the common case. **Fixed at the root rather than in the writer:** a buffer holding events nobody has written is KEPT, for the next flush or failing that the 2h reaper; indices are deliberately not re-based, because a flush in flight rolls `flushedCount` back to the index it claimed from. The chaining survives as an INSERT saved, not as the safety property. **ONE NARROWER CASE IS DECLINED AND MEASURED:** a release racing a flush already IN FLIGHT sees `events.length === flushedCount` (the claim is taken before the await) and still deletes — unreachable on the runtime, where a call emits two events, both at teardown, against an `INCREMENTAL_FLUSH_AT` of 25, and pre-existing on the old core; closing it needs an in-flight count on every flush path. `src/services/releaseKeepsUnwrittenEvents.test.ts` (3) and `src/runtime/bothTeardownRowsLand.test.ts` (2 — the REAL writers over the REAL `callEventLog`, because both ends already had tests and the one shared buffer between them was uncovered, failure mode 10); **4 mutations, 4 caught**: the unconditional delete (the defect — the identity row never reaches the INSERT), release never forgetting anything (retention as a leak), release re-basing the array, and a missing buffer answering false. Full suite 4,756. **CODEX ROUND 5 (on `4df247c`) — two P2s, both real, both taken, both on doors this PR opened.** (1) **The documented mismatch JOIN counted a lookup the probe could never have seen.** `teardown` starts the persist without awaiting a `lookup_patient` still in flight, so that dispatch settles AFTER the store was read and writes its certain result to `tool_timeline` anyway — the probe honestly reports `no_entry`, the join reads the final lookup as certain, and files the call as the write and the read disagreeing about the SID, which is the ONE hypothesis the join exists to test. The probe now carries `at`, the instant it read the map (a number, so its "counts and booleans only" guard holds unchanged), the row carries `probedAt` as ISO (because `tool_timeline`'s `at` is ISO and a join that converts one side is a join that gets the conversion wrong), and the documented SQL keeps to evidence that existed by then. Small and the wrong one to be wrong about: over the seven days to 2026-09-17, **3 of 1,553 runtime calls had ANY lookup event after `end_time`, 1 of them CERTAIN** — the population task #57 declined as sub-1%, which is fine as behaviour and fatal as noise on a count expected to be near zero. (2) **`row_write_failed` could fire on a call whose identity DID reach `call_logs`.** `persistRuntimeCall` does TWO upserts — the row, then a top-up carrying a recording URL parked between its two peeks — and both shared one try/catch and one `false`; the only consumer of that boolean is this telemetry, so a blip on the SECOND write corrupted the write-stage measurement during exactly the intermittent failure it exists to diagnose. The primary write's outcome is tracked on its own and the two failures get their own log lines, because *the row did not land* and *the row landed without its recording URL* are different facts and only the first is alarming; the top-up keeps its retries and still leaves the URL parked for the reaper (#321 round 4). **AN EXISTING TEST ASSERTED THE DEFECT AND WAS REWRITTEN, NOT LOOSENED** — `recordingBeatsTheRow.test.ts`'s *"a URL parked during the write stays parked when ITS write fails"* expected `false`; the property it is really for is that the URL stays parked, and a control beside it now fails any fix that just returns true always. **6 mutations, 6 caught**: the probe not reporting its read moment, the row dropping `probedAt`, the join losing its bound, the late-URL failure speaking for the row again (the defect), the primary write pinned true, and the two log lines collapsed back into one. The typecheck caught the new required field in a fixture that vitest could not see. Full suite 4,759 | **v61 (2026-09-23) — THE PROBE COULD NOT ANSWER ITS OWN QUESTION, AND ONE OF ITS PUBLISHED ARMS CANNOT FIRE.** The probe ran a full day: **623 `identity_summary` rows, 2026-09-22 16:26 → 00:01, and every single one reads `storeSize = 0` / `hasEntry` false / `sidCanonical` true / `rowWrite` ok / `verdict: no_entry`.** Joined to `tool_timeline`: 271 of the 623 ran `lookup_patient`, **210 had a lookup reporting `identity_is_certain: true`, all 210 read `storeSize 0`, 0 had an entry, and 0 had the certain lookup land after the probe read** — so the round-5 bound holds and this is not the late-lookup race. Round 4's fix is confirmed working: 465 calls carry BOTH an `identity_summary` and a `follow_up_summary` row, so the population is not biased toward toolless calls. **TWO MORE CAUSES ELIMINATED, both properly this time.** *Two module instances:* re-probed with the REAL file, INSIDE the repo so it inherits the package's CJS type exactly as `npx tsx src/server.ts` does, using production's two import styles verbatim — `voiceRuntime.ts:264`'s static `import { identityStoreProbe }` and `sharedPatientTools.ts:495`'s dynamic `await import('./verifiedIdentity')`. One map, one function object, the dynamic write visible to the static reader. The earlier check was a script and did not match the production module type; this one does. *A non-canonical SID at the write:* both writers key on `entry.callSid`, and three lines above the pre-context write the same variable is handed to `startRecording(entry.callSid, …)` — Twilio's REST recording API, which would refuse a SID that is not a real call. **681 of 682 grok calls on 09-22 carry a `recording_url`**, and 682 of 682 `call_sid`s pass the canonical validator with 0 upper-case-hex. So the write's key is canonical at the moment of the write. *`forgetIfSameName`:* 208 of 209 certain-lookup calls ENDED on a certain lookup, and a later certain write re-stores, so a delete cannot be the last word. **AND THE PUBLISHED DESIGN NOTE IS WRONG — read this before trusting the arms.** This row and `verifiedIdentity.ts` both said a write/read SID disagreement shows up as `storeSize > 0` with `hasEntry` false, the `key_mismatch` arm. **False for the case that matters:** a non-canonical write SID is refused AT THE GUARD, nothing is stored, and the map stays empty — indistinguishable from a write that never ran. `key_mismatch` can only fire when the write SID is canonical AND different, which the recording control now says it is not. The arm was built to test a hypothesis it structurally cannot reach. **SO THE INSTRUMENT MOVES TO THE WRITE.** `rememberVerifiedIdentity` returns `stored` \| `merged` \| `refused_sid` \| `refused_name` and prints one PHI-free console line on each refusal (a CallSid is not a patient, so the offending value is printed; the name branch reports only which half was missing). The verdict is RETURNED rather than accumulated in a second store, because both call sites already sit somewhere countable: `lookup_patient` puts it on its own recorded outcome as `identity_write` (allow-listed in `toolTimeline`) and the runtime puts it on the `identity_summary` row as `precontextWrite`. **No new map, no second TTL, no behaviour change** — no gate, no tool result a caller can hear, no spoken line. **AN ABSENT VERDICT IS ALSO AN ANSWER:** the branch sits under `if (uniqueMatch)`, so nothing at all means the write was never reached, which is one of the two facts `storeSize 0` was hiding. `src/tools/identityWriteSaysWhy.test.ts` (9, driven through the REAL `lookup_patient` via `runTool` — a probe proven only against a hand-seeded map is the mistake v51's own test made) plus one in `toolTimeline.test.ts`; **9 mutations, 9 caught**: the two refusal verdicts swapped, the writer no longer distinguishing a refusal from a store, `identity_write` dropped from the outcome, the lookup no longer capturing it, `identity_write` dropped from the allow-list, `precontextWrite` dropped from the row, the runtime no longer capturing the pre-context write, the runtime no longer forwarding it at teardown, and the refusal line printing the caller's name. Full suite 4,769. **NOT MEASURED IN PRODUCTION**; it is an instrument, the fourth in a row on this question, and that is deliberate — identity is the one field where a wrong answer puts one patient's name on another patient's request, and this repo already carries a W1 fix written and REVERTED on 2026-09-16 for shipping onto an unmeasurable population. The console half is what makes this round cheap: one test call answers the fork the same hour instead of the next day. The numbers it makes readable: among runtime `lookup_patient` events, the share of each `identity_write` value and the share with none; and among `identity_summary` rows, the share of each `precontextWrite` value. The guard: `patient_found` behaviour must not move. Working notes: `docs/observatory/SPEC-20260923.md` |

| **v61** or earlier, and **v59** is a SIBLING of this — NOT the date | the ticket saying WHY NOBODY WAS DIALLED, so an ordinary task on a handoff-default purpose stops being an HTTP 500 the model retries. **MEASURED 2026-09-19 in `voice_agent_api_logs`, not inferred: 7 calls, 41 refused POSTs, worst storm 8 POSTs on ONE call, 2026-09-15..18** — grievance_follow_up 4 calls / 25 POSTs, peer_to_peer 2 / 10, health_plan_visit_inquiry 1 / 6. The ticketing app refuses a `CREATE_TASK` on a purpose whose `defaultDisposition` is `HAND_OFF` unless the payload carries a failed `handoff.finalStatus`, and the route turned that throw into a BARE HTTP 500 with no field guidance — which the model reads as retryable, so it re-sent about once a second until the call ended. **THE COMMON SHAPE IS THE ONE NOBODY HAD NAMED: 4 of the 7 NEVER ATTEMPTED A HANDOFF AT ALL** (0 of the 7 carried a handoff block of any kind), and 3 came through this agent's own `handoff_not_eligible` fallback. So the guard's premise — that a task on such a purpose can only follow a failed dial — EXPIRED when the operator withdrew auto-transfer on 2026-09-04 (*"never auto-transfer; transfer only when the caller ASKS and is an entity"*), and it has been refusing CORRECT behaviour since. **AND THE GRIEVANCE HALF WAS A ONE-SIDED TABLE DRIFT, which is the finding worth carrying forward.** `grievance_follow_up` was flipped to `CREATE_TASK` on THIS side by v17 (task #114, the withdrawn auto-transfer) and the ticketing app's copy of the same table was never flipped with it — so the agent was sending the right disposition and the app was refusing it. **The policy table exists in two repositories and NOTHING reconciled them**, which is exactly how a drift like that survives a month. Operator, 2026-09-21: *"grievance department exists but not in the ticketing sense, it is used as a workspace for processing grievances, those can go to the After Hours Hub and they will know how to work it"* — so on the app side it now files as a task into **After Hours (department 8)** rather than PCP Support, carrying a declared label because the After Hours catch-all reason would have put *"Other - See Description"* on the subject. **`HAND_OFF` STAYS ALLOWED on both sides**, which is load-bearing: `eligibleByAsk` still connects a caller who explicitly asks for a person. **WHAT SHIPS ON THIS SIDE: `handoffNotAttemptedReason`, read from the policy table and TWO SERVER-OWNED DIRECTOR LATCHES and never from a model argument** — the v17 P1 is why (a guard that read `create_pcp_task`'s `disposition` was reading an argument with `.default('CREATE_TASK')` behind it, so the model could satisfy it by accident). **EACH VALUE IS ONE CODE PATH, NOT A RANKED PREDICATE**, which is the v29 round-2 lesson applied before it could cost anything — that fix keyed a rule on a FIELD and got it wrong because the field was absent on one of the three branches that should have triggered it. So: `caller_declined_queue` (the decline branch latches it), `not_eligible` (`handoff_to_pcp` ran and was refused — latched BEFORE the fallback payload is built, because `buildPayload` reads it), `not_requested` (neither happened and the caller never asked, the operator's own default rule). **`undefined` IS AN ANSWER, NOT A GAP:** a caller who asked for a person, was never refused and never declined, whose request is then filed as a task, IS a lost transfer — nothing is sent, the app refuses, and that refusal is now a 422 carrying the server's own words and `retryable: false` instead of a storm; `sweepPcpUnfiledCall` admits a caller whose explicit ask went unhonoured (v19), so the request survives either way. **THE POLICY READ MUST NOT THROW and that is load-bearing rather than tidiness:** `getPcpCallPurpose` throws on an unknown slug, and `buildPayload` is called from EIGHT places including the teardown sweep at `pcpAgent.ts:2931` — the lost-request floor itself — so a throw there would lose exactly the request the floor exists to save, the v18 shape arriving through a change written to stop it. `defaultDispositionFor` answers `undefined` instead. **THE RECONCILIATION IS THE OTHER HALF OF THE DELIVERABLE**, in both directions: `src/pcp/appPolicyTableAgrees.test.ts` pins the APP's `allowedDispositions` as a literal read on 2026-09-21 and fails if this repo ever declares something the app would refuse, and ticketing-app `lib/pcp/pcpPolicyTablesAgree.test.ts` pins this repo's 20 defaults and asserts MEMBERSHIP rather than equality so a deliberate divergence is stated once instead of silently costing a ticket. **SHIP ORDER IS LOAD-BEARING: ticketing-app #291 DEPLOYS FIRST.** An unknown field on that app's `.strict()` schema is an HTTP 400, which is how 17 requests became nothing on 2026-09-14; the reverse order is harmless. `src/pcp/handoffNotAttempted.test.ts` (18) and `appPolicyTableAgrees.test.ts` (5), with `buildPayload` and both latch sites pinned by reading the source — failure mode 10, and v20 is the worked example where both ENDS had tests and the two links between them did not. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: HTTP 500s from `/api/voice-agent/pcp-ticket` — **7 calls / 41 POSTs over 09-15..18, target 0**; and `handoffNotAttemptedReason` values on filed tickets, where `not_requested` should dominate on the evidence above. The guards: **PCP tickets filed per substantive call must not fall** (this widens what the app accepts and must tighten nothing), PCP transfer ATTEMPTS must not fall (a reason that explains away a dial is the failure mode, not the win), and tickets carrying a reason while `disposition` is `HAND_OFF` must stay 0 |
| **v62** or earlier, and **v63** is a SIBLING of this — NOT the date | any count of whether the CALLER'S AUDIO EVER REACHED US. **MEASURED 2026-09-24 over 09-17..09-23, runtime, `duration >= 30`, CALLER: lines counted from the transcript: optical 435 substantive with **59 zero-caller-line (13.6%)** against surgery 40 of 518 (7.7%) and tech 67 of 808 (8.3%).** Optical's whole excess is the ZERO bucket and its heard-exactly-once share is the **LOWEST** of the three (4.8% against 6.0% and 5.3%) — **so this was never the VAD losing a caller mid-call, and the W3 recommendation to dial `RUNTIME_VAD_THRESHOLD` again would not have touched it. That recommendation is withdrawn.** Four causes are ruled out WITH CONTROLS rather than by argument: **robocalls** (51 distinct numbers behind 59 calls, 1.16 calls/number, identical to tech's 1.16, worst repeat 3); **a wrong IVR option** (2 of 59 are later heard on ANOTHER lane, against 15 on the same one); **greeting length** (already in this file, and optical's is the shortest); and **greeting shape** (all three lanes are structurally identical and end *"How can I help you today?"*). And **15 of the 59 rang optical BACK inside 24h and were heard**, so they are not all dead air. **WHAT NO QUERY COULD ANSWER is the split that remains:** frames arrived and none were voiced (an open line nobody spoke into) against frames arrived carrying speech and NO transcript (we did not hear a caller who was speaking). Those need opposite fixes and nothing could tell them apart, because `handleTwilioFrame`'s media case is `this.session.appendAudio(frame.media.payload)` and **caller audio has never been counted anywhere**. **FRAME COUNT ALONE WOULD SAY NOTHING** — Twilio sends a 20ms μ-law frame continuously once the call is up whether or not anybody speaks — **and a non-silence BYTE test would say nothing either**, because comfort noise puts some in almost every frame on a real line. What separates speech from an open line is LOUDNESS, and μ-law encodes it directly: after inverting the byte, bits 4-6 are the exponent, hiss sits at 0-1, speech peaks far above. A frame is voiced when its LOUDEST sample reaches `VOICED_EXPONENT` (4 of 7) — integer work over 160 bytes, no decoding, no allocation, counted at the SOCKET the moment the frame is parsed and before any branch that can drop one (see the three review findings at the end of this row). **`VOICED_EXPONENT = 4` IS A JUDGEMENT, NOT A MEASUREMENT**, set clear of the noise band rather than tuned to a corpus we do not have — the counts it produces are what will say whether it wants moving, which is the point of shipping an instrument first. One `call_events` row per call (`category = 'vad'`, `message = 'caller_audio_summary'`): `verdict` (`no_frames` \| `silent_line` \| `voiced`), frames, voiced, voicedPct, outcome — **counts and a verdict, never a byte of audio and never a transcript**. It uses the EXISTING `vad` `EventCategory` rather than widening the enum. **EVERY call writes a row**, unlike `follow_up_summary` which skips: here *there was no caller audio at all* IS the finding, so a skip would hide the exact population being measured — the v58 identity summary made the same choice for the same reason. Chained `after` the identity writer with that writer's own discipline (emit first, wait only before FLUSHING) because all three share one per-SID buffer and #322 round 4 was a P1 about precisely that. **AN INSTRUMENT, NOT A FIX** — the v47/v48/v58/v61 move, deliberately, and v61 records a fix written and REVERTED for shipping onto a population nobody could count. **A SECOND, SHARED FINDING, NOT FIXED HERE:** after the greeting's response completes with no pending tool and no owed response, `handleResponseDone` calls `clearDeadAir()` and **nothing re-arms the watchdog until the caller speaks** — deliberately, so *"a caller taking their time over the question can never trip the watchdog"*. So a caller who NEVER speaks is never detected: these end `caller_hangup` at 68s average rather than `dead_air` at 30, the watchdog fired on **1 of 138** zero-line calls across the three lanes, and two optical calls sat open to the 602-second ceiling. A silence re-prompt is the obvious fix and is NOT here: no such thing exists anywhere in the runtime (grepped), and the line spoken to a patient is the operator's to word, the way the recording disclosure was. **OPEN FOR WAYNE.** `src/runtime/callerAudioEnergy.test.ts` — 21 assertions, the μ-law arithmetic pinned against bytes whose loudness is known by construction, and the BRIDGE and RUNTIME call sites pinned by reading the source because a helper test proves the helper and not that anything calls it (failure mode 10; v20 is the worked example). **8 mutations, 8 caught** on the first round — the bridge stopping counting, counting BEFORE `appendAudio`, the counts dropped from the record, the runtime never writing the row, the threshold lowered into the noise band, the peak measure turned into an all-bytes one, `silent_line` collapsed into `no_frames`, and the row's missing-counts default flipped to voiced. **THE LAST ONE SURVIVED THE FIRST RUN AND IS WHY THIS SENTENCE EXISTS:** every other assertion passed `callerAudio` explicitly, so the `??` default was never exercised — and that default is load bearing, because a record we know nothing about must read `no_frames` and never `voiced`, since `voiced` on a zero-caller-line call is what accuses our own STT. **ONE EXISTING ASSERTION WAS REWRITTEN, NOT LOOSENED:** `identityTelemetry.test.ts`'s *never awaits the identity writer* asserted the literal `void `, a sound proxy while nothing needed that promise; this row chains off it, so the call site is an assignment. It now tests the PROPERTY (no `await`, and it still handles its own rejection) and was proven to still fail when a real `await` is inserted. **NOT MEASURED IN PRODUCTION** — it changes no gate, no tool and nothing a caller hears. The numbers it makes readable: the share of each `verdict` per lane, and joined to `call_logs` the one that matters — among zero-caller-line calls, `voiced` against `silent_line` per lane, which is what finally says whether optical's gap is callers we never heard or lines nobody spoke into. The guard: filing rate and the barely-heard rate must not move, because nothing here changes behaviour. **CODEX ROUND 1 ON #327 — THREE P2s, ALL REAL, ALL TAKEN, AND TWO OF THEM WERE THE INSTRUMENT LYING IN THE DIRECTION THAT MATTERS.** (1) **THE COUNTS CAME FROM THE BRIDGE, WHICH NEVER SEES THE FRAMES THE STARTUP HOLD DISCARDS.** `voiceRuntime` queues caller audio while the agent is built and drops its OLDEST frame past `PRE_BRIDGE_FRAME_CAP` (500, ten seconds), so a caller who spoke during a slow start and went quiet afterwards would have been reported `silent_line` — audio that reached this server, recorded as a line nobody spoke into, by the one measure built to tell those two apart, and biased toward the exact wrong answer on the exact calls this exists to explain. The meter moved to the SOCKET, one `note` immediately after the frame is parsed and before every branch that can lose one; the bridge now counts nothing and `VoiceCallRecord.callerAudio` is gone. (2) **THREE EXITS WROTE A `call_logs` ROW AND NO CALLER-AUDIO ROW**, so "every call writes one" was false of an unknown or disabled lane, a caller who hangs up while the agent is being built, and a setup failure before the bridge exists — which are PART OF the no-audio population, i.e. the claim held everywhere except where it was most load-bearing. All three write one now, and the socket meter is what gives them counts to write; `logCallerAudio` therefore takes `{callSid, outcome}` and the counts rather than a `VoiceCallRecord`, because three of the four exits never build one. (3) **A RELEASE RACING AN IN-FLIGHT FLUSH**, which is the narrower case #322 round 4 named and declined. `flushCallEvents` claims its slice BEFORE the await, so mid-insert a buffer whose events are in the AIR is indistinguishable from one whose events are WRITTEN, and `releaseCallEvents` deleted it — leaving the rollback on a failed insert to land on an object no longer in the map. One `inFlight` counter in the one flush function, not the change to every flush path round 4 estimated. **MEASURED BEFORE TAKING IT, and the measurement moves WHY rather than whether:** over the seven days to 2026-09-24, **2,835 grok calls carry `call_events` rows, the most any ONE of them carries is 2, and 0 reach the flush threshold of 25** — so the third writer takes that ceiling to 3 and the runtime still cannot reach the race; on the OLD CORE the same week, **488 calls, max 263 events, and 369 of them past 25**, so the incremental flush fires there routinely and that is where this was always live. Taken for the old core's sake, not because this PR made it reachable. **The behaviour is driven at the REAL runtime** (`voiceRuntime.test.ts` +5, through the harness's new `logCallerAudio` seam) rather than by reading source, because both wiring P2s are the kind a helper test cannot see — including the worked case, 1 loud frame then 500 silent ones, where the cap discards the loud one and a bridge-side meter reads `silent_line` while the socket reads voiced. **10 mutations, 10 caught:** counting moved back behind the bridge (3 fail), each of the three bridgeless exits dropped (1 each), the teardown row no longer reading the socket meter (2), the missing-counts default flipped to voiced, the release ignoring an in-flight flush, `inFlight` never decremented (4 — retention as a leak), `inFlight` never incremented, and the bridge re-inlining the meter. Full suite 4,821 |

| **v64** or earlier, and **v65** and **v66** are SIBLINGS of this — NOT the date (v59 is claimed by the open #293; v57, v60 and v63 are retired; this ship is **v67**) | any sign on the ticket that the callback number is one NOBODY GAVE US. **TRACED 2026-09-24 from a referral coordinator's emailed complaint** — her office has patients to book, the agent files a ticket, and nobody calls back. Her calls all FILED: eight of them, every one with a ticket. **`asked_callback` is FALSE on all eight**, because `pcpAgent.ts:583` seeds `callbackNumber` from caller ID whenever the ANI is E.164 and the intake then skips a field that already reads answered — the behaviour standing instruction 12 asks for, and correct in the common case. Her ANI is an out-of-state area code on a Southern California referral office, i.e. a trunk identifier rather than a desk, and a staffer rang it and closed the ticket *"Processed callback but line is unavailable… little to no information provided"* while a ticket from the same office on a different ANI resolved *"Called back and assisted the caller"*. **So the loss is not the filing and not the routing — it is that the number on the ticket was never vouched for and the ticket does not say so.** `callbackFromCallerIdOnly` is set in the SAME update that seeds the number, CLEARED in the same update whenever `record_pcp_intake` carries one the caller stated, and read where a staffer actually looks: the cross-queue ticket body now says the callback *reaches the requesting office, not the patient* — which was always right and stays verbatim — plus either *UNVERIFIED — this is the inbound caller ID, not a number the caller gave; if it does not answer, ask them for a direct line* or *Given by the caller.* **NO QUESTION IS ADDED, AND THAT IS THE DECISION, NOT AN OMISSION.** The obvious fix is to ask a professional caller to confirm the number, and v37 measures what that costs on this lane: **18 of 25 PCP calls ENDED ON a pre-filing question and 10 left NO ticket of any provenance**, and the teardown sweep caught none of them. My own earlier reasoning — that the sweep is a floor under one more question — is refuted by that measurement and is withdrawn. Whether to confirm the number, and on WHICH SIDE of the filing (the v37 ordering lever already exists as `ENRICHMENT_AFTER_FILING`), collides with the prompt's own *THE NUMBER COMES BEFORE THE TICKET, ALWAYS* and is therefore **OPEN FOR WAYNE**. Labelling the provenance is the zero-risk half and is what makes either answer measurable. `src/pcp/callbackNumberSaysWhereItCameFrom.test.ts` — 8 assertions. **THE FIRST VERSION OF ONE OF THEM PROVED NOTHING and is recorded because the shape recurs:** it anchored on the ANI guard's own source text and sliced to the first `}`, which is the one inside the regex quantifier `{10,15}` — so the window ended before the object literal and `toContain` ran against an empty haystack. It failed loudly here; pointed the other way it is a green test asserting nothing, which is failure mode 10. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this writes a line on a ticket and changes no gate, no tool and nothing a caller hears. The numbers: PCP tickets whose callback line says UNVERIFIED, which is the first count of how large this population is (8 of 8 on the traced office, fleet share unknown); and PCP tickets resolved *line is unavailable* or equivalent, which should FALL as staff stop ringing trunk identifiers blind. The guard: `asked_callback` must not move and PCP tickets per substantive call must not fall — this adds no question, so a change in either means the label is being read as a gate. **THIS ROW HAS BEEN RE-KEYED TWICE BY SIBLING MERGES, AND THE DRIFT GUARD CAUGHT THE FIRST COLLISION.** Both branches came off v61, so both wrote a `v61 or earlier` row; `markerTableIsIntact.test.ts` failed with *a union merge kept two copies of a row*, which is the exact failure the sweep note warned about and the exact thing a union merge hides. v63 merged the v62 `main`, so it contains v62 and this row is keyed there | **AND RE-KEYED AGAIN WHEN #327 MERGED, 2026-09-24.** That merge moved `main` to **v64**, which put this branch's v63 BELOW `main` — a marker below `main` reads as a failed pull, the one thing the constant exists to prevent. So v63 joins v57 and v60 as RETIRED rather than reused (a build must never read it), this ship takes **v67**, and the row is keyed on the v64 it now contains. **v65 (#328) and v66 (#325) are open SIBLINGS off the v62 `main`**, so this number being the highest of the four says nothing whatever about containment — it says only that it was allocated last.

| **v67** or earlier, and **v66** is a SIBLING of this — NOT the date (v59 is claimed by the open #293; v57, v60 and v63 are retired; this ship is **v68**) | any bound on how long a caller may say nothing. **OPERATOR, 2026-09-24, describing behaviour he remembers and asking for it back: *"I've heard the agent speak several times before, I cannot hear you, after the third time, the agent cuts the call. That's how it was and always should be to protect against malicious users, bots and things."*** **IT DOES NOT EXIST ANYWHERE IN THIS REPO** — grepped before building rather than assumed (failure mode 9), and the only hits for that phrase are `afterHoursEscalationGate.ts`'s cue list, which detects the CALLER saying it, and `azulSchedulingAgent`'s `HOLD_LADDER`, which fills silence while a transfer dials. It may have lived in the `src/core` pipeline deleted on 2026-09-01, or predate this system; I could not find it and said so rather than pretending to. **AND IT CLOSES A MEASURED GAP, which is why it goes in the runtime and not in a prompt.** `handleResponseDone` CLEARED the dead-air watchdog once the agent's line was delivered and nothing was owed — deliberately, and its comment says why: *"a caller quietly thinking about a question can never trip it"* — and **nothing re-armed it until the caller spoke**. So a caller who NEVER speaks was detected by nothing at all: measured over 2026-09-17..23 on optical, surgery and tech, of **138 substantive calls whose transcript held no caller line the watchdog fired on ONE**, the rest ended `caller_hangup` at 68 seconds average, and **two optical calls sat open to the 602-second ceiling**. That gap is recorded in the v64 row as OPEN FOR WAYNE on the one question I would not answer myself — the words spoken to a patient — and his message answers it in his own words. **THE CLOCK GAINS A THIRD CAUSE RATHER THAN A SECOND TIMER.** `armDeadAir` already clears before it arms, and every path that matters already calls it, so `"caller"` rides the existing lifecycle: a caller who speaks arms `"response"` and the ladder's clock is gone by construction, `transferWaitExtraMs` still joins every window, and no new teardown path exists. A second timer with its own arming and clearing would have had to re-derive all of that. The `else this.clearDeadAir()` branch becomes `else this.armDeadAir("caller")` — the agent's debt is still discharged there, which was always right; what is new is that the caller's own window takes its place. **DETERMINISTIC, NEVER MODEL-SPOKEN**, the v22/v39 reasoning: a line in the prompt is a line the model MAY say, and a protection against diallers cannot be optional. `session.speak(SILENCE_PROMPT_LINE, { interruptible: true })` puts it on the wire verbatim the way the greeting's words go — and `interruptible: true` unlike the greeting, because the whole purpose is to make somebody talk, so their first syllable must cut it off. **THE CUT IS A NEW OUTCOME, NOT `dead_air`**, and that distinction is this file's own rule twice over: `dead_air` means the AGENT owed something and never delivered it, and folding a silent caller into it would move the v54 refusal-then-silence count with no defect behind it moving — the `total_turns` mistake. `caller_silent` takes `statusFor`'s dead_air RULE rather than a flat `failed`, for the reason dead_air stopped taking one: the ladder resets when a caller is heard, so it can also end a call that HELD a conversation and then went quiet, and that call must still be graded and synced. **THE SIGN-OFF IS SPOKEN BY THE TwiML, NOT THE AGENT** (`RUNTIME_CANNOT_HEAR_LINE`), because teardown closes the media stream and a line started as the call ends is cut mid-word — `blindTransfer.ts` records exactly that reasoning for its own warning. It is deliberately NOT the technical-trouble line: nothing failed, we could not hear them, and telling a caller we had a fault is a claim about our own side the evidence does not support. **THE WINDOW STARTS WHEN THE CALLER FINISHED HEARING, NOT WHEN THE PROVIDER FINISHED GENERATING** — see the Codex round at the end of this row; the first version got that wrong and it was the one error in this change that could have hung up on a caller who was listening. **12 SECONDS IS A JUDGEMENT AND NOTHING IN PRODUCTION CAN INFORM IT YET**, because nothing has ever counted silence: long enough that a caller reading a date of birth off a card is not interrupted, short enough that they have not already given up. `RUNTIME_SILENCE_PROMPT_MS` moves it without a deploy (the `RUNTIME_VAD_THRESHOLD` pattern), clamped to 5–60s so a typo can neither disarm the ladder nor let it fire over the agent. **THE RESET IS KEYED ON A TRANSCRIPT, NOT ON `speech_stopped`:** the VAD fires on a cough and on hold music, and a ladder reset by noise is a ladder a dialler holds open for ever. **THE HONEST RISK, stated rather than buried:** if optical's zero-caller-line population turns out to be callers who WERE speaking and we did not hear them, this ladder tells them three times that we cannot hear them and then hangs up on a real patient. **v64's caller-audio instrument is what answers that** (`voiced` against `silent_line` on exactly those calls), and if the answer is `voiced` the fix is the transcriber and this window should be widened or the cut removed — the dial is there for that. Against it: those callers get 68 seconds of silence and hang up themselves today, so three sentences telling them what is wrong is strictly more than they get now, and only the cut costs them anything. **COUNTABLE FROM SQL**, unlike the tool ceiling's stops, which are console-only and are why nobody could ever prove that ceiling fired: `silencePrompts` and `silenceCut` ride the existing `follow_up_summary` `call_events` row, the way v56 put `hangupsHeld` there. **ITS GATE HAD TO WIDEN AND THAT IS THE PART TO READ** — `followUpEvent` returned null when `owed === 0`, and a caller who never speaks runs no tools, so the row was skipped on exactly the population the ladder exists for: the v58 shape, an instrument blind to its own subject. `src/runtime/silenceLadder.test.ts` (15) plus one in `voiceWebhook.test.ts`. **13 mutations, 13 caught:** the clock cleared again instead of armed for the caller (8 fail), the ladder never speaking (3), the prompt locked like the greeting, the ladder never re-arming (5), the cut never happening (3), the cut recorded as `dead_air` (2), the caller's window taking the agent's 30 seconds (14), the reset on being heard removed (2), the counts never reaching the record (2), the telemetry gate staying closed on a silence-only call (2), `caller_silent` reading failed regardless, the sign-off reverting to the technical-trouble line, and the clamp letting any value through. Beside them, **three existing bridge test NAMES were corrected rather than loosened** — "clears once the opening line is delivered" is no longer what happens, and they now say the AGENT's clock clears, which is the property they always proved. `followUpTelemetry.test.ts`'s exact-key-set PHI guard gained the two counts rather than being relaxed, so a field carrying anything a caller SAID still goes red. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes when a call may END, on every runtime lane. The numbers: runtime substantive calls with zero caller lines where nothing detected it — **137 of 138 over 2026-09-17..23, target ~0**, replaced by `caller_silent`; and `silencePrompts > 0` rows, which is how often the ladder spoke at all. The guards: **prompts on calls that then carried on normally** (`silencePrompts > 0` with `silenceCut` false and a caller line) is the false-positive rate and the window is its dial — a high number means 12 seconds is too short; `dead_air` must not FALL by more than the silent-caller population moves into `caller_silent`, because the two must not be trading places; and filing rate per lane must not fall, since a call cut at ~48 seconds must never be one that was going to file. **CODEX ROUND 1 ON #328 — A P1 AND A P2, BOTH REAL, BOTH TAKEN, AND THE P1 IS THE ONE THIS CHANGE COULD NOT AFFORD TO GET WRONG.** (1) **THE CLOCK STARTED AT THE PROVIDER'S `response.done`, WHICH IS NOT WHEN THE CALLER STOPPED HEARING.** `onAudioDone` means Grok finished GENERATING; this file's own architecture notes say *"Twilio `mark` events are the ONLY ground truth that audio actually played to a caller"*, and Grok streams faster than real time, so at that moment up to the whole line can still be sitting in Twilio's buffer. A bare 12-second window would therefore expire while the agent was still talking, speak the prompt over its own question, and on the third one **hang up on a caller who was listening attentively** — the exact failure this ladder exists to avoid, arriving through the timer meant to prevent it. **IT WAS LATENT AT 30 SECONDS AND SHRINKING THE WINDOW MADE IT REACHABLE:** the watchdog this branch used to CLEAR was 30s, which outlasts any plausible buffered tail, so nothing in the old code had to think about playback. That is the v28 round-2 lesson again — *a fix that changes the shape of a rule invalidates the sentence that justified the old shape* — and this time the shape that changed was a duration. **THE FIX IS TWO-SIDED AND DEGRADES SAFELY IN BOTH DIRECTIONS:** the arm at `response.done` carries the utterance's OWN playback duration (`bytes / MULAW_BYTES_PER_MS`) as the upper bound on what is still unplayed, so it can only ever be too patient and never too eager; and `handleTwilioMark`, at the exact line where it already proves playback is over (`assistantAudioPlaying = false`, newest mark, no media after it), RESTARTS the window from the true moment the caller was left holding the turn. A mark that never echoes therefore costs at most one line's worth of extra patience and never a word over the agent. **The echo re-arms ONLY while the CALLER's clock is the one running** — an agent debt (a pending tool, a response owed from the greeting) is not this timer's business, and a playback echo must not extend it. Chosen over a bare `assistantAudioPlaying` guard on the prompt, which looked simpler and has a silent failure mode: that flag is cleared ONLY by the mark echo, so a dropped mark would have left the ladder re-arming for ever and never firing at all. (2) **THE LADDER'S RESET ERASED THE PROMPT THAT WORKED.** `silencePrompts` was one field doing two jobs, and resetting it when the caller was heard destroyed the record of the prompt that brought them back — so a call where the ladder spoke and the caller answered read ZERO, `followUpEvent` skipped its row (owed 0, prompts 0), and **this row's own guard number was unmeasurable by construction**: prompts on calls that then carried on normally is the false-positive rate and the window's dial, and it is the number that says whether 12 seconds is too short. Two counters now: `silenceStrikes` consecutive and reset on a heard caller, which drives the ladder; `silencePrompts` cumulative and never reset, which is what the record and the telemetry row carry. **ONE TEST ASSERTED THE DEFECT AS THOUGH IT WERE THE DESIGN** — *"records a prompt that was answered as spoken but NOT as a cut"* expected `silencePrompts` to be 0 and its comment called that *"the point"*; the point was the LADDER resetting, and the test is rewritten to the property rather than loosened. **AND THE TEST HELPER WAS MEASURING THE WRONG STATE:** its `speak()` stopped at `onAudioDone`, which is a line still buffered inside Twilio — so every ladder test was driving the state the P1 is about and calling it "the agent has spoken". It now echoes the mark, and `generate()` exists separately for the buffered case, which has three tests of its own. **7 mutations, 7 caught:** the window armed at the provider's done (the P1 defect itself — 2 fail), the mark echo never restarting it (10), the echo re-arming unconditionally and extending an agent debt (1), the two counters collapsed back into one (the P2 defect — 2), the ladder reading the cumulative count so it can never reset (1), the cumulative count never advancing (3), and the ladder never resetting on a heard caller (1). Full suite 4,815 | **RE-KEYED WHEN #327 MERGED, 2026-09-24.** That merge moved `main` to **v64**, so this branch merged it and the row is keyed on the v64 it now contains; v65 was already above `main` and did not need re-bumping. The remaining siblings are **v66** (#325, the PCP floor) and **v67** (#326, the callback provenance, re-bumped from v63 by the same merge because v63 fell BELOW `main`). **#326 AND THIS BRANCH NOW BOTH KEY ON v64, WHICH IS CORRECT FOR EACH AND WILL COLLIDE WHEN THE SECOND ONE MERGES** — `markerTableIsIntact.test.ts` will fail with *a union merge kept two copies of a row*, which is the guard working and is exactly what it caught between v63 and #323. Whichever lands second re-keys onto whatever `main` then carries; do not resolve it by deleting a row.

| **v68** or earlier — NOT the date (v59 is claimed by the open #293; v57, v60, v63, v65 and v66 are retired; this ship is **v69**, the LAST of the four siblings off the v62 `main`, so `main` now contains the other three) | any teardown filer at all on the PCP lane. **`sweepPcpUnfiledCall` had never run.** Three ships of work went into its admissions — v18 (the caller who asked for a person and was refused), v30 and v31 (the call nobody classified, and the narrative clamp) — and its ONLY caller was `voiceAgentRoutes.ts:4713`, inside the OLD CORE's OpenAI SIP teardown. **PCP moved to this runtime on 2026-09-04.** The runtime's own teardown sweep declines the lane by table: `DEPARTMENT_BY_SLUG` in `requestSweep.ts` holds optical, surgery, tech and records, so `decideSweep` returns `not-a-queue-lane` for pcp before any other test. So the lane that carries the go-live had no teardown filer on the pipeline that serves it, and a filer nobody calls files nothing. **READ FROM PRODUCTION RATHER THAN INFERRED: across ALL of `voice_agent_api_logs`, 0 POSTs have ever carried `failureInformation` = `caller_hung_up_before_completion` or `call_not_classified`** — the two literals only that function writes. Full corpus and the before-arm: `docs/observatory/W2-CORPUS-20260922.md`. **THE BEFORE-ARM: 38 PCP calls on 2026-09-22 ran the intake, filed nothing, and carry no ticket of any provenance; 24-53 a day over six business days.** Wiring the floor as it stands rescues **16 of the 38 certainly and 17 probably (~45%)**, with no new rule and no new admission — resolved from `askBudgetSpent` rather than from transcripts, because `missing` returns the FIRST unset askable field in the required order, so a `nextField` past `callerName` with `callerName` absent from the spent list means the name was ANSWERED and `toldUsSomething` is true. **BOTH SWEEPS NOW RUN AND CANNOT DOUBLE-FILE:** the generic one declines pcp at its first line and this one runs only for pcp. **Adding `pcp` to `DEPARTMENT_BY_SLUG` would have been the smaller diff and the wrong one** — that path builds a queue-lane payload against a department id, where this lane has its own endpoint (`/api/voice-agent/pcp-ticket`), its own payload and its own disposition rules. **AWAITED like the generic sweep and unlike the telemetry beside it**, because it files a caller's request rather than describing one, and bounded at `PCP_FLOOR_BUDGET_MS` = 25s — the same bound the old core has always raced this call against — so a wedged ticketing app cannot hold teardown open. It also frees the lane's per-call state: the sweep's `finally` is the only caller of `pcpDirector.clear` this runtime ever reaches, since `terminate_call`'s success branch needs an `ok` from OpenAI's SIP hangup endpoint and got 400 on 94 of 94 PCP calls on 2026-09-22. **WHAT IS STILL INERT, stated rather than left to be discovered:** the runtime supplies no `getTranscript` in its lane context — only the old core does — so inside the sweep `transcript` is `''`, `saidMoreThanTheirOwnIdentity` is false, and the v31 `unclassified` admission CANNOT fire on this pipeline. That costs nothing on the measured population (all 38 carried a `callPurpose` at teardown, and `unclassified` requires the purpose to be ABSENT), and a floor-filed ticket still gets the caller's words, because `ticketingSyncService.syncCall` puts the transcript on the ticket after the call regardless — just not in the same request. Supplying the getter is a separate change with its own arm and is NOT smuggled in behind this one. `src/runtime/pcpFloor.test.ts` plus the runtime pin in `voiceRuntime.test.ts`, because a helper proven in isolation proves the helper and not that anything invokes it (failure mode 10, and the wiring IS the defect here). The seam defaults to the REAL sweep and a test asserts so: a seam defaulted to a no-op would pass every behavioural test in that file and file nothing in production — the fix reintroduced through its own test seam. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this files tickets. The numbers: PCP substantive calls with no ticket of any provenance — **38 on 2026-09-22, target down by the ~16-17 the floor admits**; and POSTs carrying `caller_hung_up_before_completion` or `call_not_classified`, which are 0 all-time and should become non-zero from the first call on this build. The guards: **PCP tickets a staffer closes as junk must not rise materially** — that is the azul 2026-07-28 shape, where 9 of 12 spurious sweep tickets were callbacks for patients already helped; department-16 and department-9 tickets from PCP must not rise, since an unclassified call must never be auto-routed to a specialist queue; and two tickets on one call SID must stay 0, because both sweeps now run on every PCP teardown |

| **v69** or earlier — NOT the date (v13 and v57 were withdrawn; v60, v63, v65 and v66 are retired; this ship is **v70**, and `main` now contains all four siblings off the v62 base, so this is the first marker in five days with no open sibling beside it) | RULE ZERO 2a GATING anything. The runtime lanes never asked *"Are you a new patient or an existing patient?"* at all until #293 — zero hits in `opticalAgent`, `surgeryAgent`, `techAgent`, `recordsAgent`, surviving only as `rampEngine.ts:60`, imported by ONE file, `voiceAgentRoutes.ts`, the OLD CORE — and when #293 added it, it appended PROMPT GUIDANCE and gated nothing, which its own body said in as many words and put to the operator. **He answered on 2026-09-19: *"new should hard suppress lookup patient."*** So a spoken "new" now makes `lookup_patient` REFUSE TO DISPATCH: it returns `found: false` with `suppressed: 'caller_said_new'`, a `fix` telling the model there is no record to find and never to say we have no record of them, and **NO `message`** — v43 is what happens when a tool's instruction to the model sits in the channel the model speaks, and a suppression has nothing for the caller to hear. RULE ZERO 2a has said this since it was written (*"NEW means STOP LOOKING: no lookup, no appointment search, no 'we have no record of you'"*); only the prompt was obeying it. **THE SOURCE IS THE TRANSCRIPT, NOT THE MODEL'S ARGUMENT, and that is measured rather than chosen:** `dobShape` read `(none)` on 75 of 75 date-of-birth refusals on 2026-09-08, so a gate depending on an argument arriving would fire on almost nothing. `spokenPatientStatus.ts` is `spokenDob.ts`'s shape for a second field — the bridge posts the whole record as it grows, beside `noteSpokenDob`, and the tool reads the answer back by CallSid. **THE WINDOW RULE IS THE WHOLE DESIGN AND IT IS MEASURED.** Over the four runtime queue lanes 2026-09-15..18, 1,238 substantive calls with a caller line: "new" appears ANYWHERE in 53 of them (tech 36, surgery 10, optical 7) and only **3 of those 53 contain "new patient"** — the rest are new glasses, a new prescription, a new insurance card, a new phone number. A reader that swept the transcript would be wrong on roughly 94% of its own firings, and every one of those refuses to look for a real record. So a window opens only on an AGENT line carrying the ALTERNATION the prompt instructs, closes at the next agent line, and nothing outside one is read; a model that rewords the question opens no window and suppresses nothing, which fails SAFE. **A PREMISE THIS CORRECTED, recorded because it was mine:** I expected optical to be the worst lane, reasoning that *"I need new glasses"* is the commonest sentence on an optical line. Optical is the LOWEST of the three at 2.7%. The window rule is right for the reason above and not the one I assumed — and that table is BASELINE NOISE rather than the population, because the question is not asked in production yet, so nobody in it was answering one. **RULE 1 OUTRANKS THE ANSWER**, which is the guard on the operator's own stated failure mode (an existing patient who answers "new", on lanes where 63% of found-nobody callers are in `patients_master`): a call whose identity the process has already ESTABLISHED is never suppressed, read through `verifiedIdentityFor`, which refuses an UNCERTAIN match by design — so a phone candidate does not count (standing instruction 6) and a confirmed identity does. In the ordinary sequence that fires, because the model looks up the injected caller phone before the question is ever asked. **AND IT IS REVERSIBLE, deliberately, because a sticky misclassification is a defect this file already carries open** (`CAbf717457` link 1: a `patient_caller` misread *"is sticky and silently forfeits the transfer for the rest of the call"*). Two exits: the reader takes the LATEST window, so an agent who asks again gets the corrected answer; and `lookup_patient` accepts `patient_status: 'existing'`, which the suppression's own `fix` names. **The override lives in its OWN store and the first version's bug is worth reading:** it wrote into the map the bridge RECOMPUTES from the transcript on every caller turn — whose latest window still says "new", since that is why the gate fired — so the escape hatch closed again one turn after the model used it. It is sticky on purpose, because the two directions do not cost the same: a needless lookup costs one tool call, a needless suppression costs a record. **IT SUPPRESSES THIS TOOL AND NOTHING ELSE** — `file_*_ticket` still files, `resolve_location` still routes optical by office, and a new patient's ticket carrying no match is correct rather than a gap. **AND `fold` NEARLY SHIPPED BREAKING THE WINDOW:** the window bounds itself with `[^.?!]` and the first fold turned every `.` into a space, making that bound inert — *"I have a new prescription. Or is it an existing order?"* opened a window across two sentences and read the next caller turn as an answer. Found by probing the reader before writing the suite; it is now a test. `src/tools/newMeansStopLooking.test.ts` — 24 assertions driven through `runTool`, the entry point the model calls, on an invented caller, plus three wiring assertions read from `mediaStreamBridge.ts` because a suite that drives `notePatientStatus` by hand would stay green with the bridge never calling it (failure mode 10, and #291's office carry is the worked example). **19 mutations, 16 caught, and the three survivors are recorded rather than hidden because each says something:** the gate removed (3 fail), the Rule 1 guard removed, a spoken `message` added (the v43 defect), the way back dropped from the `fix`, the override honoured for one call only (3), the override written into the transcript store (my own first bug), `patientStatusFor` ignoring the override (3), `fold` stripping sentence ends (the inert bound), the object test removed, existing checked after new, the FIRST window winning, an empty read clearing the answer, the bridge never posting (2), `suppressed` dropped from the allow-list, the prompt dropping `patient_status`, the prompt rewording the question, and the window never closing at an agent line. **THE THREE SURVIVORS:** two are EQUIVALENCES — the window is defended twice (`close()` resets the turns, and the push is gated on `open`), either guard alone suffices, so removing one is a no-op while removing BOTH is caught; and the sentinel guard on the WRITE is unobservable because the READ carries its own copy, which is what `spokenDob.ts` says that pair is for. A fourth apparent survivor was my own badly chosen mutation — it reworded the tail and left the phrase the test asserts standing; removing the way back for real is caught. `suppressed` is on `toolTimeline`'s outcome allow-list from the start, because v48 exists for the opposite mistake. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the identity path does on the four busiest lanes. The numbers: `lookup_patient` events carrying `suppressed = 'caller_said_new'` — 0 today, and the share of calls they land on is the first thing to read; and the before-arm the rule is FOR, ten days to 2026-09-12, **627 of 2,511 substantive queue calls ran `lookup_patient` and found NOBODY, 235 of those ending with no ticket** — a "new" caller should stop producing a refusal, a retry or *"we have no record of you"*. The guards, and they matter more than the primary: **filing rate per lane must not fall**; **tickets filed with no `location_id` must not rise** on optical, which routes BY office; and **`lookup_patient` calls per substantive call must not fall while tickets carrying no identity rise**, because that combination is an existing patient being classified new, which is the failure mode and not the win **CODEX ROUND 1 ON #293 — THREE P1s, all real, all reproduced against the reader before being fixed, all taken because all three are on a door this PR's own change opened.** (1) **A NEGATED EXISTING CLAIM READ AS EXISTING.** `EXISTING_CUES` carries a broad `(been|was) (a )?patient`, so *"I've never been a patient"* matched it and classified the caller EXISTING — the lookup then ran and produced the very *"no record found"* this gate exists to suppress. The specific negation is now read BEFORE the broad claim it negates, and the mirror is pinned both ways: *"not a new patient"* is still existing, because `not a patient` cannot span the "new" between. (2) **ANY NEW/EXISTING ALTERNATION OPENED A WINDOW.** *"Do you need a new prescription or refill an existing one?"* answered with a bare *"New."* read as a NEW PATIENT and suppressed the lookup — an existing patient wanting a new prescription, whose record we then refuse to look for, and the object test cannot catch it because the noun is in the AGENT's question while the caller said one word. The alternation must now name the patient. Measured over the same 1,843 calls: the agent offered such an alternation on exactly ONE, and that one was not about patient status — low today because the question is not asked yet, and the narrowing is free. **THAT FIX BROKE REVERSIBILITY AND THE REPAIR IS THE PART TO READ:** the bare re-ask *"Sorry, new or existing?"* stopped opening a window, so a caller's CORRECTION no longer landed — the property this row leans on. It is admitted again, but ONLY when the alternation ENDS THE CLAUSE, so the noun that made the P1 dangerous cannot be there; requiring merely that the pair be BARE would still have admitted *"new or existing frame"*, where the shared noun follows the pair instead of sitting between it. (3) **SPANISH WAS UNREADABLE, and the measurement is why it is supported rather than noted: 199 of those 1,843 caller sides carry a Spanish cue — 10.8%, tech 60 · surgery 71 · optical 68.** One caller in nine, on lanes that all tell the model to translate its questions, so the gate did not exist for them. Added the Spanish question, the Spanish answers and the Spanish OBJECT form — the adjective follows the noun there (*"lentes nuevos"*), so translating the English pattern word for word would have matched nothing and read it as an answer — and `fold` now decomposes and drops combining marks, because the character class was turning every accented letter into a SPACE and *"sí"* read as *"s"*. **EVERY OTHER LANGUAGE IS STILL UNCOVERED, deliberately:** no window opens, nothing is suppressed, the call behaves as today — the fail-safe direction, and the same call `dobParts.ts` makes about Turkish. Guessing at a translation inside a gate that REFUSES TO LOOK FOR A RECORD is worse than not firing. 41 assertions; **11 mutations, 11 caught** — the negation check removed (6 fail), the negation checked after existing (4, the original inversion), `never been` dropped (3), the window back to any alternation (3), the bare re-ask no longer clause-final, the bare re-ask removed entirely (2), every Spanish question pattern dropped (4), accent folding removed, the Spanish answers and the bare Spanish read both dropped (2), the Spanish object form dropped, and the Spanish existing cues dropped (2). **TWO EARLIER SURVIVORS WERE REDUNDANCIES AND ONE WAS A REAL TEST GAP, all recorded:** dropping ONE of three Spanish question patterns or the Spanish `NEW_CUES` entries changed nothing, because a sibling pattern and the bare Spanish read respectively already covered them — caught by mutating the whole group instead. The real gap was the accent test: it hinged on *"existente"*, which has NO accent, so removing the fold changed nothing; it now turns on *"había"* and *"número"*, which become *"hab a"* and *"n mero"* unfolded and match no cue at all. **AND A PROCESS NOTE WORTH MORE THAN THE FINDINGS:** the first mutation run was done on UNCOMMITTED fixes, and the harness's `git checkout -- <file>` reverted all three of them mid-run. Nothing was lost that could not be rewritten, and the accident produced an unplanned red-state proof (the new tests showed 11 failures against the unfixed module) — but **commit before mutating**, every time. `fold`'s two character classes also held raw UTF-8 rather than escapes, so the combining-mark range read as literal invisible marks in source; the apostrophe class had the same problem from before this PR, and both are now escapes **CODEX ROUND 2 — THREE MORE P1s, and every one of the five reproduced cases returned `new` for an EXISTING patient**, so every one suppressed a real record's lookup. That is the only direction on this gate that costs anybody anything, so none was weighed against a base rate. (1) **A BARE PAIR WITH A NOUN BEFORE IT IS NOT A RE-ASK.** Round 1's clause-final carve-out closed the noun AFTER the pair and left the noun BEFORE it open: *"Is the prescription new or existing?"* still opened a window and a bare *"New."* still suppressed. The bare form is now a SEPARATE, weaker window under two INDEPENDENT conditions — a qualified window must already have opened on this call (a bare pair continues a status conversation, it cannot start one), AND a bare WORD does not answer a re-ask window, only an explicit cue does. Each closes cases the other cannot, and the mutation run is what proved that rather than the prose: removing guard 1 survived every case in the file until a test was added for the one shape guard 2 cannot cover — a bare pair answered with an explicit cue (*"Is the frame new or existing?"* / *"I'm new here."*). (2) **A SPANISH NEGATED-NEW ANSWER READ AS NEW.** `no soy paciente` had been written as a bare prefix in the negated-EXISTING list, so it matched *"No soy paciente NUEVO; soy paciente existente"* — the exact inversion the English cues were careful about, in the other language. `NEGATED_NEW` now carries the Spanish forms and is read first. (3) **AN EXPLICIT CLAIM MUST BEAT A QUALIFYING CLAUSE.** *"Existing, but I've never been to this office"* hit the broad `never been` cue and read as new. **Resolved with the governance rule this file already records the grader paying for three times** on `connect you`: a negation refuses a claim only when it GOVERNS it. A whole-turn test cannot separate *"I'm not an existing patient"* from *"Existing, but I've never been to this office"* — both carry the word and a negator — but stripping the GOVERNED occurrences and asking what remains can. The never-been cues are also tied to being a PATIENT or being SEEN rather than to a place, and those two guards turn out to be mutually redundant: each alone covers every measured case, and only removing BOTH goes red. **AND THE SPANISH HALF OF THE GOVERNANCE FIX WAS CAUGHT BY ITS OWN TEST, not by review:** Spanish puts the verb between the negator and the word — *"no SOY PACIENTE existente"* — so the English strip shape could not reach it, and that assertion failed while the English one passed. 57 assertions; **16 mutations, 16 caught, after three of them sent me back for a sharper test.** The three that first survived are worth reading because none was a hole: guard 1 of the re-ask (covered by guard 2 on every existing case), `NEGATED_NEW`'s position (the layers above it agreed on every case in the file until *"I'm not new, this is not my first time"* was added, where they disagree), and the R2-C pair above. **THE PATTERN ACROSS BOTH ROUNDS IS THE THING TO CARRY FORWARD:** six P1s, all in one hand-written cue reader, all the same SHAPE — a precedence or scope error where a broad cue outranked a specific one. Each fix was structural rather than another entry on a list, which is the #99 lesson applied (*"no edit to the cue list closes it"*). **If a third round finds another of this shape, the answer is not a seventh fix but a smaller reader:** drop the PROSE cue families entirely and keep only the negations, the explicit claims and the bare word, so a caller who answers in prose simply goes unclassified — which suppresses nothing and is the fail-safe direction. That trades coverage for surface and is the operator's call, not a test's **CODEX ROUND 3 — THREE MORE P1s, AND THE PREDICTION ABOVE IS WHAT WAS DONE RATHER THAN A SEVENTH FIX.** All three on `spokenPatientStatus.ts`, all reproduced against the real reader before anything changed, and **all six reproduced cases returned `new` for an EXISTING or UNKNOWN caller** — so every one suppressed a lookup that should have run, which is the only direction on this gate that costs anybody anything. (A) *"No, this isn't my first time"* matched `first time`; *"I've never been here, but I'm already a patient downtown"* and *"…I go to your Covina office"* matched `never been here`. (B) *"I'm not really a new patient"* and *"I'm not exactly a new patient"* missed the negation, because `not\s+(an?\s+)?new` permitted only an ARTICLE between the negator and the word — and `ungoverned` was narrowed identically, so `new patient` stood for the explicit layer to read. (C) `seenQualified` never expired, so a clause-final pair minutes later — *"Are the glasses new or existing?"* — became a status window. **NINE P1s across three rounds, every one the same shape, so the PROSE FAMILIES THAT ANSWER `new` ARE DELETED and each deletion is justified by the cue rather than by safety:** `first time` / `primera vez` (a first time CALLING is not a first time as a patient), `never been here/there` / `nunca he venido` (a PLACE — `si_locations` holds **105** offices, so this is the Covina/West Covina lesson again), `i'm new` / `soy nuevo` as a CUE (*"I'm new to progressives"*), and BOTH noun lists (`NEW_TAKES_AN_OBJECT` and its Spanish mirror), which the sentence test subsumes. **THE INVARIANT THAT REPLACES THEM, and it is what makes a fourth round of this shape impossible in the expensive direction: `new` is only ever returned by a DENIAL OF PATIENT HISTORY, an ungoverned "new patient", or a SENTENCE THAT IS THE ANSWER. No prose infers `new`. Prose may only infer `existing`, whose failure costs ONE TOOL CALL** — the lookup runs, misses, and RULE ZERO 2a says a miss on a new patient is EXPECTED. The two directions are not symmetric, so they do not get symmetric surface. **THE ANSWER IS A SENTENCE, NOT A SUBSTRING**, and that is what retires the noun lists: the old layer asked *does the turn contain `new` and none of these 20 nouns?*, a list that can always be one noun short, while a funnel question (RULE ZERO 2c) is answered WITH the answer — so *"New."*, *"Uh, new."*, *"I'm a new patient."* and *"New. I've never been there before."* all read, and *"I need new glasses"*, *"I'm new to progressives"* and *"Necesito un número nuevo"* do not, with nothing enumerating `glasses`. B is fixed with ONE shared `NEG_RUN` — negator, hedges, article — read by `NEGATED_NEW`, `DENIES_PATIENT_HISTORY` and `ungoverned`, because round 3 found those three drifted apart on exactly this; C by expiring eligibility when the caller says anything OUTSIDE a window, no timer and no magic number. **AND ONE PRE-EXISTING BUG THE SECOND CASE WALKED INTO:** `EXISTING_CUES` carried `i\s+(am|'m)\s+already` and there is no space inside "i'm", so that cue only ever fired on *"i am already"* — fixing it is what makes case A2 read `existing`, the RIGHT answer rather than merely the safe one. **THE COST IS COVERAGE, STATED RATHER THAN BURIED:** *"First time calling."* and *"I've never been there."* now go UNCLASSIFIED — nothing is suppressed, the lookup runs, v50 bounds the asks and the ticket files. **Whether to buy that coverage back with more surface is OPEN FOR WAYNE**, since this row already said it is his dial and not a test's. 57 -> **81 assertions; 15 mutations, 15 caught** after two survivors sent me back for sharper tests — and both survivors were the SUITE's fault, which is the transferable part: the expiry survived because *"I'm new to progressives"* reads nothing now the prose cue is gone, so guard 2 covered the case and the expiry did no visible work (the added case is an explicit DENIAL, which is read whatever the window KIND — round 2's "guard 1 earns its place", one round on); and the layer ORDER survived because `withoutDenials` already separates the two families for every strippable phrase, so the order only matters for `not an existing patient`, where a turn carrying BOTH a denial and an existing claim must resolve toward LOOKING THEM UP. **Three existing assertions were rewritten rather than loosened**, and the third matters: *"guard 1 earns its place"* turned on *"I'm new here"* being an explicit cue, so deleting that cue made it pass for the WRONG reason and the round-2 mutation would have survived again **CODEX ROUND 4 — THREE MORE P1s, TWO OF THEM IN ROUTES ROUND 3 LEFT STANDING, AND `new` NOW COMES FROM ONE ROUTE.** All reproduced against the real reader first, all in the expensive direction. (A) *"I've never been seen at this office"*, *"I am not a patient at this location"* and *"…at your Covina office"* all read `new` — **round 3 deleted the place-based cues by NAME and left the QUALIFIER that can follow the ones it kept**, which is my own criterion applied to half the problem; `si_locations` holds 105 offices, so a patient of another one says exactly those sentences and means the opposite. (B) *"I don't think I'm a new patient"*, *"I don't believe…"* and *"I'm not sure if…"* read `new`, because the explicit claim is a CONTAINS test with no way to see a negation in the clause around it. (C) NOT a cue problem at all: `CallTranscriptLog.callerCompleted` REPLACES a caller line in place when Grok re-emits the same item, so *"New."* becoming *"I need new glasses."* left the read at undefined and the STORE at `new` — suppressing an existing caller on words no longer in the transcript, **while this module's docstring claimed the opposite of its own code** (*"this store never holds a verdict the transcript has stopped supporting"*, above an early return that kept one). **TWELVE P1s IN ONE READER ACROSS FOUR ROUNDS, so the route that has NEVER produced a finding is now the only one: `new` is returned when, and only when, a SENTENCE IN THE CALLER'S TURN *IS* THE ANSWER, in a qualified window.** `DENIES_PATIENT_HISTORY` and the contains-based `EXPLICIT_NEW` are DELETED rather than guarded, which closes A and B by construction — there is no prose left for a qualifier or a subordinate clause to defeat — and it is what RULE ZERO 2c asks for: shape the question, then read the shape it produces and nothing else. **`withoutDenials` OUTLIVES the family that answered `new` with it, deliberately:** round 4 stopped a denial answering `new`; it must still stop one answering `existing`, which is a claim the caller did not make. **DELETING THE STALE VERDICT IS SAFE BECAUSE THE LOG NEVER DROPS A LINE** — checked before taking it: `transcriptLog.ts` only pushes or replaces in place, no cap and no eviction, so the whole record is re-read on every post and an answer given in an earlier window is still found; the only way a later read comes back empty is that the transcript stopped saying it. The model's OVERRIDE is in its own map and is untouched. **THE COST, and it is the whole of it:** *"I've never been a patient."*, *"I'm not an existing patient."* and their Spanish forms are no longer read as new-patient answers, and a caller can no longer correct themselves TO `new` in a bare re-ask window (correcting to `existing` still works). Every one goes UNCLASSIFIED — nothing suppressed, the lookup runs, `LOOKUP_MISS_LIMIT` bounds the asks, the ticket files. 81 -> **90 assertions; 12 mutations, 12 caught.** Eighteen assertions were rewritten rather than loosened and two are worth naming: *"a reading that finds nothing overwrites nothing"* posted a SHORTER record on its second call, which the bridge never does (it always posts `transcriptLog.lines` in full), so it asserted a pattern that cannot happen and would now pass only because of the bug C names; and *"guard 1 earns its place"* was rewritten a SECOND time because round 4 removed its expensive-direction job entirely — with one `new` route, qualified-only, guard 2 already makes a re-ask window unable to produce `new` under any answer, so guard 1 now pins the cheap direction and says so rather than looking like it proves more than it does. **OPEN FOR WAYNE, and this is the fourth round of one shape:** whether to keep buying coverage back at all, or accept a gate that fires only on the funnel's own answer. My recommendation is the latter — it is what the measurement across four rounds says, and the share is readable from `suppressed = 'caller_said_new'` once this deploys **CODEX ROUND 5 — TWO P1s, AND NEITHER IS THE PROSE SHAPE.** (A) INSIDE the one surviving route: `sentences()` split on `[.?!]` and DISCARDED the terminator, so *"New? I don't think so."*, *"New?"* and *"New. I don't think so."* all read `new` — a caller who ECHOED the option as a question read as answering it. Fixed with TWO mechanical rules and deliberately not a third cue list (a list of rejection phrases is what the twelve earlier P1s came out of): the split keeps the terminator and an interrogative segment is not an answer; and **ANY negation in the turn refuses the answer outright**, which is what closes the declarative *"New. I don't think so."* that rule 1 cannot see. **THE ACCEPTED COST:** *"New. I've never been there before."* carries "never" and now goes UNCLASSIFIED — supported from round 3 until now. The cheap direction is untouched on purpose: *"Existing?"* still reads `existing`. (B) NOT the reader at all — **RECORDS ASKED A PROXY ABOUT THEIR OWN PATIENT STATUS.** `recordsAgent.ts` handles attorneys, health plans, doctors' offices and relatives and warns the caller may not be the patient; the question asks about the CALLER, so a proxy's "New." describes themselves while the gate reads it as the patient whose chart they want and suppresses THAT patient's lookup — a category error, wrong even once. **MEASURED before taking it, records 2026-09-10..18, 206 substantive calls: 87 (42%) carry a proxy cue against 20 with a self cue** — close to the modal caller, so the ask is REMOVED from the lane rather than guarded. `LANES_THAT_ASK` is now optical, surgery, tech; records loses RULE ZERO 2a entirely and behaves exactly as today. **Codex's other remedy — ask about the TARGET PATIENT after establishing who is requesting — is a new question on a live intake, so it is the operator's and is flagged rather than built.** 103 assertions across the two files; **7 mutations, 7 caught.** Three assertions rewritten rather than loosened, including the lane-list test, which asserted records ASKS and now asserts it does not, with the 42% beside it **CODEX ROUND 6 — FOUR P1s, TWO INSIDE ROUND 5's OWN GUARD AND TWO ON THE OVERRIDE, all reproduced against the real reader first, all in the expensive direction.** (B) The round-5 negator set carried no modals, so *"New. That can't be right."*, *"New. I cannot be."*, *"New. That couldn't be right."* and *"New. Nope."* all read `new` — four rejections, four suppressed records. (C) A window holds every caller turn until the next agent line and the negation was tested per TURN, so `CALLER: New.` followed by `CALLER: I don't think so.` read `new` while the same words in ONE turn correctly read nothing — my own docstring said "whole-turn" and the window is not a turn. **ADDING `can't` WOULD BE THE THIRTEENTH ENTRY ON A LIST THAT CAN ALWAYS BE ONE SHORT, so the list is REMOVED from this route and one mechanical rule replaces both findings: the window's caller side must contain exactly ONE substantive segment, and that segment must BE the answer.** Nothing enumerates what rejection sounds like — a rejection, a correction or a second sentence of any kind is a second segment, which is RULE ZERO 2c read literally. `NEG` survives for the three `existing` layers, where its incompleteness costs one tool call. **THE ACCEPTED COST, and it is larger than round 5's:** an answer with anything added — *"New. I need an appointment."*, *"New. This is my first visit."* — now goes UNCLASSIFIED, and it CANNOT BE MEASURED because the question is not asked in production yet. Every one is the safe direction: nothing suppressed, the lookup runs, `LOOKUP_MISS_LIMIT` bounds the asks, the ticket files. **(A) AND (D) CLOSE TOGETHER WITH ONE NARROWING, smaller than the lane plumbing either finding proposed.** (A) `patient_status` was offered to every lane, so a RECORDS agent — whose caller is a proxy on 42% of calls — could send `new` describing the CALLER and suppress the lookup for the PATIENT whose chart they rang about: round 5 took the QUESTION off that lane and left this door open beside it. Keying the gate on the lane is not available — `ToolQueue` is `optical | surgery` and tech, which DOES ask, injects none — and would have been the wrong hinge anyway. (D) A stored `new` then beat every later transcript read for the whole TTL, so a caller correcting themselves could not get out: the escape hatch this store exists to BE, locked from the inside. **`existing` IS NOW THE ONLY OVERRIDE THERE IS** — the store holds a timestamp, the schema offers one value and says not to report `new`, and `noteStatusOverride` is typed `'existing'` with a runtime guard behind it. Nothing is lost: the transcript already says `new` when the caller said it, and when they did not, a model asserting it is the unverified suppression this gate must never make. Sticky was always right for the CHEAP direction and indefensible for the expensive one, and round 5 left the parameter open to both. 103 -> **117 assertions; 9 mutations, 8 caught.** TWO assertions rewritten rather than deleted, both pinning behaviour this round withdraws — R5-B's title named a rule that no longer exists, and *"patient_status new suppresses on its own, with no transcript at all"* asserted the defect. **THE ONE SURVIVOR IS AN EQUIVALENCE, recorded rather than hidden:** the call-site check and the store's own guard are each sufficient against a model-asserted `new`, so removing one is a no-op while removing BOTH is caught (M9). **AND A MUTATION CORRECTED THE SUITE BEFORE IT SHIPPED:** a reader that looked only at the LAST caller turn passed every R6-C case, because all of them put the answer in the final turn — the added case puts it in the first with filler in the last, which only a whole-window read gets right. **OPEN FOR WAYNE, fifth round running:** whether to buy any of the surrendered coverage back, or accept a gate that fires only on the funnel's own clean answer. My recommendation is unchanged and now stronger — accept it, and let `suppressed = 'caller_said_new'` price the residue once it deploys **CODEX ROUND 7 — TWO P1s, ONE TAKEN AND ONE DECLINED WITH ITS NUMBER, and the taken one is where I contradicted myself one round earlier.** (B) TAKEN. Round 5 took the QUESTION off records and round 6 took `new` off the override, and the transcript READER still read EVERY lane — so a records agent that asked the question anyway opened a window in which a PROXY's *"New."*, describing themselves, suppressed the lookup for the PATIENT whose chart they rang about. A category error rather than a mis-read, and wrong even once. **My round-6 reply said keying on the lane "would have been the wrong hinge anyway" — true of the OVERRIDE, which the narrowing closed outright, and false of the READER, which had no other hinge.** `lookup_patient` now takes an injected `lane` (the `queue` shape: not a schema field, merged UNDER the model's arguments, so the model can neither set it nor be asked for it) and reads the transcript only for a lane in `LANES_THAT_ASK` — **exported from `newOrExistingAsk.ts` and imported by the tool, one table read by the runtime that asks and the tool that acts**, because two lane lists is the `explicitAsk.ts` drift this repo has already paid for. AN ABSENT LANE DOES NOT SUPPRESS, deliberately: that covers the HTTP surface, pcp, no-ivr and answering-service, and it fails in the CHEAP direction — the cost is that a lane which stops declaring itself has a silently inert gate, so three assertions read the AGENT SOURCES and go red if one drops it. **AND THE SECOND HALF WAS THE TRANSPORT, not the field:** `askAs` on `patient_status` carries the new-or-existing question and `realtimeAdapter` spread the whole `input_schema` into `parameters`, so that question reached EVERY lane's model, records included. Deleting that one `askAs` was the wrong layer and **the full suite caught it** — `sharedPatientTools.test.ts` requires every field to carry one (*"a tool asking for something hands the agent the sentence to say"*), so the delete traded a leak for a hole in that contract. `stripInternalKeys` removes house metadata in the ADAPTER, so no tool's `askAs` reaches any model and the convention stands. (A) **DECLINED, and this is the only finding in seven rounds not taken.** `response.function_call_arguments.done` can arrive before the caller turn's `input_audio_transcription.completed`, so the store can be empty when the tool reads it and a caller who said *"New."* is looked up anyway. Real, and the failure direction is the gate going INERT — which is the behaviour on 100% of calls before this PR, so the race can reach the status quo and never past it. **Both remedies cost more than the gap.** Holding the lookup until transcription completes spends the budget of the FIRST tool every queue call runs: measured 2026-09-13..19 over the four runtime queue lanes, `lookup_patient` has a **median of 391 ms and a p95 of 6,000 ms — the budget itself**, with 135 of 2,361 events (5.7%) and **93 of 1,536 substantive calls (6.1%)** spending all of it, and #68 is the loss that already causes. *(That also re-measures this file's own 13–17% from 2026-09-01 on a different basis — `ms >= 6000` on the timeline — so do not quote the older figure as current, and do not read 6.1% as an improvement either: different detection, different window.)* And carrying the status "through a source available at dispatch time" means the MODEL's argument, which round 6 removed for `new` precisely because a model-asserted `new` is an unverified suppression — the remedy is forbidden by the same round's own fix, and `dobShape` at `(none)` on 75 of 75 says it would fire on almost nothing anyway. The control that bounds it: `noteSpokenDob` is posted from the SAME hook with the identical dependency, live since 2026-09-10, and nothing has been attributed to that race. **WHAT WOULD PRICE IT, and it is a follow-up rather than this PR:** a teardown check on the `call_events` row v55 already writes — did a lookup dispatch on a call whose FINAL transcript held a qualified new-patient answer? — which costs a day of traffic and no latency. 117 -> **123 assertions; 6 mutations, 6 caught.** Every `queue: 'optical'` call site in the suite gained `lane: 'optical'`, because each already meant that lane. **AND A MUTATION CAUGHT MY OWN TEST COMMITTING FAILURE MODE 10 IN THE ROUND THAT CITED IT:** the `askAs` assertion called `stripInternalKeys` directly, so reverting the ADAPTER's call site survived it — the claim now runs against the BUILT tool in `realtimeAdapter.test.ts`, where that contract belongs  **CODEX ROUND 8 — ONE P1, REAL, REPRODUCED, AND **HELD** RATHER THAN FIXED, because every remedy left is a change to what the agent asks a live caller.** On optical, surgery and tech — the three lanes that DO ask — a PROXY who states the relationship in one turn and answers the window with one clean word has that answer applied to the PATIENT: *"I need to check on my husband's glasses order."* / *"New."* reads `new` and suppresses the lookup for the husband, who is an existing patient. Round 5 took the ask off RECORDS for this reason and round 7 stopped the READER reading that lane; neither touches the lanes where the question belongs. **The repo documents the same category error one field over** — `surgeryTools.ts:550` and `:566`, of the PHONE rather than the question: *"the phone matches a spouse, an adult child or the previous owner of a reassigned mobile — and we would attach THAT person's surgeon."* **THE EXPOSED SHAPE IS NARROWER THAN THE FINDING**, because round 6's single-segment invariant already refuses *"New. I'm calling for my mother."* — the relationship must be stated in a DIFFERENT turn for the answer to read at all. **MEASURED before deciding, the way round 5's 42% was, 2026-09-10..18, `duration >= 30`, caller lines only: 30 of 2,484 substantive calls carry a proxy cue — 1.2% (tech 19/1,211, surgery 9/718, optical 2/555) — against 331 self cues, eleven to one the other way.** Records was 42% and lost the question; these three are its mirror image, and the exposure is a SUBSET of the 1.2%. **THE REMEDY I REFUSED MATTERS MORE THAN THE ONES ESCALATED:** the obvious mechanical fix is a proxy-cue list that REFUSES the answer — read in the safe direction — and it is not written, because twelve P1s across four rounds came out of one hand-written cue reader in this file and this PR's settled invariant is **no prose infers `new`**. A refusal list does not escape it: one cue short leaves the expensive failure reachable, merely narrower, so it buys a fraction of 1.2% by re-opening the surface that produced every finding here (#99 — no edit to the cue list closes it). The sound discriminator — *is this lookup for the caller or a third party?* — is unavailable too: scoping the suppression to lookups carrying no third-party name lets through precisely the call the gate exists to stop, a genuinely new patient's named lookup, which is where *"we have no record of you"* comes from. **SO THE THREE REMEDIES LEFT ARE ALL THE OPERATOR'S:** ask about the PATIENT rather than the caller (my recommendation — it makes the gate correct by construction instead of narrowing it, and it is RULE ZERO 2c read literally, since the field is *is the patient new*; but the wording is his own quoted sentence); defer the question until the target patient is known (reorders a live intake); or accept the residue. Flagged as his in the round-5 reply and in this row already, so this is the third time and not a new escalation. **NOTHING SHIPPED FOR THIS FINDING AND NOTHING IS CLAIMED CLOSED.** The residue is already priceable with no code change: `suppressed = 'caller_said_new'` has been on the timeline allow-list from the start, so one query crossed against the proxy-cue scan gives the real exposure after a day of traffic instead of an estimate of it. **OPEN FOR WAYNE, and it is the same dial rounds 3, 4, 5 and 6 each ended on** — **AND HE CLOSED IT ON 2026-09-21: *“forget about that 1.2%, you spend all those rounds on something that rarely happens.”*** So the dial is set to **ACCEPT THE RESIDUE**, which was the recommendation each of those rounds carried, and it is the third of the three remedies rather than a new one: the question keeps asking about the CALLER on optical, surgery and tech, no proxy-cue list is written, and the gate fires only on the funnel's own clean answer. **THERE IS NO ROUND 9 AND NOTHING FURTHER IS OWED ON THIS SHAPE.** The ruling is a decision about where to spend rounds, not a claim that the residue is zero — the exposure stays a SUBSET of the 1.2%, the failure is a proxy's *“New.”* suppressing the patient's lookup, and it stays priceable with no code change from `suppressed = 'caller_said_new'` crossed against the proxy-cue scan. **THE GENERAL FORM, because it now outranks a finding's correctness on this operation:** a review finding that is real, reproduced and rare is measured FIRST and priced against what fixing it costs, and a share this small is declined WITH ITS NUMBER rather than closed with a fix. Twelve P1s in one hand-written cue reader is what the rounds bought; the thirteenth was not worth the fourteenth. | **THIS ROW HAS BEEN RE-KEYED TWICE AND THE NUMBER YIELDED TWICE, WHICH IS THE RULE WORKING.** It was keyed on v58 with v59 as its sibling while both sat open off the v56 `main`; that sibling merged and four more ships landed on top of it, so the key is now v69 and the marker v70. The auto-merge left the v58-keyed row ABOVE main's v56 row, i.e. the table briefly ran DESCENDING — `markerTableIsIntact.test.ts` is what refuses that, and it is the same guard that caught the duplicate-row collision between #326 and #328.
| **v70** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v71**, and it is now ON `main`, having merged inside #329) | one import style for the identity store. Ten production sites reached `verifiedIdentity`'s module-level `Map` through `await import('./verifiedIdentity')` — four in `sharedPatientTools`, two in `opticalTools`, one each in `techTools`, `surgeryTools`, `medicalRecordsTools` and the runtime's own pre-context write — while every READER imported it statically. All ten are static now. **THE CLAIM THAT MOTIVATED THIS IS REFUTED, BY ITS OWN REPRODUCTION, AND THAT IS THE PART TO READ.** I reported on 2026-09-25 that the two styles were resolving to two module instances (a CJS `require` cache and an ESM registry) and that this explained the v58/v61 finding: `precontextWrite = 'stored'` on 325 of 625 `identity_summary` rows against `storeSize` 0 on all 625, both written at the same teardown by the same process. Before changing anything I built the probe that check needed — inside this package, importing the module both ways exactly as `voiceRuntime.ts:264` and `:989` did — and it reports **one** instance: the same function object, and a dynamic write the static reader sees. Three further facts agree: `verifiedIdentity` is a LEAF (it imports `callSid`, which imports nothing, and `dobParts` — no `db`, no `server/storage`, no env validation), there is exactly ONE copy of the file on disk with no build output beside it, and `npm start` is `npx tsx src/server.ts`, so the unbundled loader my probe used is the loader production uses. **SO THE `storeSize 0` FINDING IS STILL OPEN**, the five predictions I hung on the split (`patient_found` ~0, the probe's zero, `carry: fired` never in six days, the sweep skipping the callers it serves, `verifiedDobFor` still working) are unexplained again, and this row must not be read as closing any of them. **WHY IT SHIPPED ANYWAY, on the operator's go-ahead:** two import styles for one piece of mutable module state is a hazard whose cost is invisible until the module graph moves under it — a bundler that splits a chunk, a move to `"type": "module"`, a second entry point — and this repo has already paid twice for two copies of one thing drifting apart (the noun lists in `explicitAsk.ts` that cost the operator his own transfer on `CAa2a3a1c1`, and the recognised-caller block written four times until it contradicted itself). The leaf check is what makes it free: nothing here was deferring a load-time cost. `src/tools/identityStoreHasOneImportStyle.test.ts` — 3 assertions, and the third pins the LEAF property, because it is the reason the first one is safe rather than a tidiness claim. **AND IT CAUGHT A DEFECT IN #329's OWN GUARD:** `markerCarriesClaim.test.ts` required every "IS WHAT `main` CARRIES" sentence to name THIS BUILD's marker, which is sound only while the branch and `main` agree — true for exactly one day. On any branch that ships it demands prose saying the branch's number is what `main` carries, which is false, so the guard would have had to be lied to to stay green. It now checks what a test on a branch honestly can: no claim above the build's marker, and every claim citing a commit; the numeric half is deliberately weak because all five bad arrivals were stale-LOW. **AND THAT REPLACEMENT WAS STILL NOT ENOUGH — Codex P2 on the review the ready-mark triggered, and it is the ORIGINAL defect reachable through my own weakening.** The ceiling admits every stale-LOW claim, and the citation check asks only whether a sha is PRESENT — a stale claim carries a stale sha, which still looks like one — so two claims could disagree with EACH OTHER while both passed. Reproduced before fixing, by putting 2026-09-24's actual prose back: three claims, `main` carrying v67 (`a5815ca`) and v70 (`c247479`) in the same file, suite green. The fourth assertion is AGREEMENT, comparing the version AND the sha, which is the strongest check that is honest on a branch: what `main` carries is a present-tense fact with one value, restating it is legitimate and two restatements differing never is, and internal consistency needs no knowledge of `main`. All three earn their place rather than folding into one — the ceiling catches a SINGLE claim that is too high, which agreement cannot see because one claim always agrees with itself; the citation check catches a claim with no sha at all; agreement catches the multi-claim drift both are blind to. **THE GENERAL LESSON IS THE v28 ROUND-2 ONE AGAIN, at one more remove: a fix that changes the SHAPE of a rule invalidates the sentence that justified the old shape.** Replacing equality with a ceiling moved the question from *does this claim match the constant* to *do the claims agree with one another*, and I answered the new question with the old one's leftovers. **NOT MEASURED IN PRODUCTION and there is nothing to measure** — this changes no gate, no tool answer and nothing a caller hears, and under one module instance it is a runtime no-op. The marker moves so a deploy can still be told apart, not because a number should move with a refactor. The guard: `patient_found`, the `carry` column and filing rate per lane must all be UNCHANGED — if any of them moves, the one-instance reproduction above is wrong about production and that is the finding, not the fix **THE REFUTATION IN THIS ROW IS ITSELF REFUTED — 2026-09-28, the first business day on a build carrying v71.** `patient_found` reached the call row on **282 of 582** runtime substantive calls, after reading 0 of 577 · 578 · 526 · 508 on 09-22, 23, 24 and 25, and the v61 probe's own rows agree (`reached_row` 283, `entry_not_certain` 126, `no_entry` 271). Nothing between 09-25 and 09-28 touched the identity store but this change. The one-instance reproduction above ran on Node 22 — every test, every CI run and every local probe did — and the v78 row found the same afternoon that Replit runs Node 20, where a dynamic import evaluates the module a SECOND time: the v77 outage's mechanism, two stores. So the `storeSize 0` finding is CLOSED by this row after all, and the five predictions hung on the split stand. The guard this row named ("if any of them moves, the one-instance reproduction is wrong about production and that is the finding") is what caught it. |
| **v71** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v72**, and it is now ON `main`, the head of #329) | a ladder that stops cutting a caller it has already heard. **OPERATOR RULING, 2026-09-26: *"stop cutting calls where the caller has been heard."*** **MEASURED ACROSS THE FOUR DAYS v68 HAD BEEN LIVE, and it was getting worse rather than settling:** on 2026-09-25, of 495 runtime substantive calls the ladder spoke on 166 (326 prompts, worst NINETEEN on one call) and cut 13 — and **EIGHT of those 13 were on calls where the caller HAD been transcribed, six of the eight leaving no ticket of any provenance**. On 09-24 it was 6 harmful of 12 cuts with 3 lost, and single instances on the two days before that; the hourly watches logged seven harmful cuts and five lost requests on 09-25 alone before the day's own total came in higher. **THE CUT IS NOW SPLIT BY WHO IS ON THE LINE, which is the whole change.** A caller never transcribed is what the ladder was asked for — a dialler, a robocall, an open line nobody spoke into — and that arm is UNCHANGED: three prompts, then `caller_silent`, which is the protection the operator asked for on 2026-09-24 and which the v64 measurement says was real (137 of 138 zero-caller-line calls over 09-17..23 were detected by nothing at all, two of them sitting open to the 602-second ceiling). A caller who HAS been heard is a person, and ending their call ends their request, so the ladder **STANDS DOWN**: it stops speaking, stops re-arming, and the call ends the way it did before v68 existed — on the caller's own hangup, or at `DEFAULT_MAX_CALL_MS`, which is what keeps standing down bounded. **STANDING DOWN RATHER THAN PROMPTING FOR EVER IS THE OTHER HALF OF THE RULING AS MEASURED**, and it is the part a naive reading of "do not cut them" gets wrong: at a 12-second window an unbounded ladder would speak roughly FIFTY times inside the ten-minute ceiling, against a worst observed nineteen. Not cutting a caller is not a licence to talk over them indefinitely. **IT IS A WHOLE-CALL LATCH, NOT THE STRIKE COUNTER, and that distinction is the one bug this change could have shipped.** `silenceStrikes` is reset by every caller turn, so at the moment the ladder fires it reads the same non-zero value whether the caller spoke once and stopped or never spoke at all — it cannot answer the question the ruling turns on. `callerEverHeard` is set from the same `onCallerTranscript` event that resets the strikes and is never cleared, the same reasoning `silencePrompts` already carries for not being reset. Keyed on a TRANSCRIPT rather than `speech_stopped` for the reason v68 gives: the VAD fires on a cough and on hold music, and a latch set by noise is a latch a dialler trips on purpose. **COUNTABLE FROM SQL from the first call:** `silenceStoodDown` rides the existing `follow_up_summary` `call_events` row beside `silencePrompts` and `silenceCut`, so every `true` is a call the previous build would have ended. It deliberately does NOT raise the row's level — standing down is the designed outcome now, not a suspicion; `silenceCut` still warns, because that arm ends a call. `src/runtime/silenceLadder.test.ts` gains 8 tests on the real bridge, in the ladder's own suite rather than a new file so one harness covers both arms and the never-heard guard sits beside the change that could disarm it. **7 mutations, 7 caught:** the latch never set, the latch cleared on a later window, the stand-down branch removed (the defect itself), the branch taken for a caller never heard (which would retire the protection), the stand-down still re-arming the clock (fifty prompts), the flag dropped from the record, and the flag dropped from the telemetry row. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes when a call may END, on every runtime lane. The numbers: silence cuts on calls with a caller line — **8 of 13 on 2026-09-25, target 0**; and `silenceStoodDown` rows, which is the same population counted from the other side and should be about 8 a day. The guards: **`caller_silent` must not fall to zero** — the never-heard arm is untouched and was 5 of 13 that day, so a zero there means the latch is being set when nobody spoke; **`max_duration` must not rise materially**, because a stood-down call now runs to the caller's own hangup; and **filing rate per lane must not fall**, since the six lost requests a day this recovers should push it the other way |
| **v72** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v73**, and it is ON `main` since #333 merged 2026-09-27 (`0039a9d`)) | the records line asking for a name ONCE and then filing, the on-clock gate bounded on that lane, and the post-call sync stamping the lane slug rather than an agents-table uuid. **OPERATOR, 2026-09-27, on the records-line review (`docs/observatory/RECORDS-LINE-REVIEW-20260927.md`): *"go ahead and flip records to the runtime and the other 5 points you made."*** This build is points 2, 3 and 5; point 1 is his Twilio repoint (the review's § 5 carries the exact URL), point 4 is admin configuration plus one design question, and point 6 is doc 17, which follows on a lane that files. **MEASURED FIRST, fourteen business days 09-08..09-25 on the records line, `duration >= 30`: 417 calls, 239 filed (57%), and of the 178 that did not, 66 were real conversations the agent dropped** — 45 ran `lookup_patient` and never reached a filing tool, and **21 were REFUSED by `file_records_ticket` and never filed: eleven for a NAME, five for the on-clock destination/date-range gate, one for a date of birth.** Twenty of the twenty-one lasted ninety seconds or more, and on the old core nothing sweeps them up afterwards — on the one department whose Corrective Action Plan SOP §4.2 requires every access request LOGGED on day one. **THE NAME WAS A `required` FIELD, SO `validateInput` REFUSED BEFORE THE HANDLER COULD LOOK AT ANYTHING:** a caller whose identity `lookup_patient` had already established was refused for a name the process was holding (RULE ZERO in as many words), and a caller who would not give one was refused for ever. `first_name`/`last_name` leave `required`; the handler (1) takes the name from the CERTAIN identity on this call through `verifiedIdentityFor` — the accessor `verifiedDobFor` already trusts for the date of birth, which refuses a phone candidate by design (standing instruction 6) — (2) otherwise asks ONCE, one field per question (RULE ZERO 2b: the first name, then the last), with `fix` telling the model this is the one ask, and (3) on the next invocation files with NO name and a staff note in `callData.transcript`, never the description, which is an SMS body. `RECORDS_ASK_LIMIT = 1`, keyed on the CallSid through `gateAttempts` exactly as `RESOLVE_ASK_LIMIT` and `decideDobEscape` are, so a sentinel SID keeps the ask-every-time behaviour rather than sharing a counter across calls. **OMITTED, NOT BLANKED:** the payload carries no name keys at all, because the app treats a missing name as missing and a blank one as a name. **THE TEARDOWN SWEEP FILES A NAMELESS RECORDS REQUEST TOO** — `FILES_WITHOUT_A_NAME` is a one-lane set — with the same staff note; the 2026-09-03 "no name, no ticket" ruling was written for the queue lanes' callback tickets, where a name is what a clerk rings back with, and it stands on every other lane, tested lane by lane. **THE ON-CLOCK GATE (operator, 2026-08-13) STILL ASKS, ONCE**, and the next invocation files with `Send to: NOT CAPTURED` / `Dates needed: NOT CAPTURED` in the words the PCP exit already uses, so a clerk chases a destination instead of a request that never existed; the PCP `on_clock_ask_exhausted` flag is untouched, and the two asks are budgeted separately so spending one never spends the other. **POINT 5 WAS ONE LINE IN THE POST-CALL SYNC:** `agentUsed: call.agentId \|\| "unknown"`, and the app's `update-call-data` writes whatever arrives onto `tickets.agent_used`. 126 of 307 agent-filed Medical Records tickets in the window carry an agents-table uuid there (pcp 99, records 10, tech 10, surgery 6, optical 1), and this file already records 91 rows reading `unknown` on 2026-09-03 — both branches of the same line. The review's first draft blamed the PCP records route; the route was innocent, and the sync re-stamps every ticket it touches. It now sends `call.agentUsed`, the lane slug, and omits the field when the row has none so the filing's own value stands. **SHIP ORDER IS LOAD-BEARING: ticketing-app #320 DEPLOYS FIRST.** The app's create-ticket schema had `min(1)` on both names, so a nameless payload against the deployed app is HTTP 400 — the mechanism that turned 17 requests into nothing on 2026-09-14. #320 makes both optional, keeps a BLANK name refused, gives the routing gate a both-names-or-nothing guard on its fuzzy verification AND its surgeon derivation (a search on an empty string against a date of birth shared by 3-33 real patients returns somebody, and the gate would have written that somebody's name onto a stranger's request), and puts *Unnamed caller (name not captured on the call)* in the subject. **CODEX P2 ON #320, correct, taken:** the optional schema relaxed the endpoint for EVERY department, so `namelessRequestVerdict` now decides in the handler against the Medical Records id the app configures — fully named anywhere, fully unnamed on Medical Records only, a half name refused everywhere — and the refusal reuses the gate's 400 shape so the voice tools read it as a question. **CODEX P1 ON #333, correct, taken:** with no verified name to subtract, `saidMoreThanTheirOwnIdentity` could not tell *"Mary Smith"* from a request, so an anonymous caller who answered the name question and hung up would have filed a HIGH-priority dept-16 ticket and, through `ensureCaseForTicket`, opened a regulated case on a statutory clock. The protection only ever worked because the name was known. The fix reads the QUESTION, not the answer — RULE ZERO 2c, the `spokenDob` device: an agent line asking for a name, spelling, date of birth, phone number or new-or-existing opens a window, the caller's turns inside it are answers, and a name-sized answer (≤3 words once scaffolding, dates and spelled letters are gone) is identity; anything longer still files. No name detector, no request-word list (standing instruction 3). **MEASURED before choosing three**, records lane 09-08..09-25, the 150 no-ticket calls whose caller spoke: **6 exhausted by identity answers → now skipped `identity-only`; 3 answered a name question with more than a name → still file; 141 said something outside every window → file as before.** The residue Codex named — a bare name VOLUNTEERED with no question — is NOT closed (that is a name detector) and is asserted as the accepted residue in the test, the same residue v31 accepted on the PCP sweep; on this lane it costs a clerk a cancellation. **AND THEN THE OPERATOR REDIRECTED THE WHOLE DAY, and this row carries that too.** 2026-09-27, later: *"the end goal is to not even have a ticket period, to just automatically redirect the patients via SMS or via email or even via verbal … Any patient that is requesting their records should be redirected directly to the digital form … We can log the records in the medical records as Pending Auth so we can track it but it shouldn't start the clock and when he does sign the auth it should attach right to that original request … we need the voice agent to send SMS or emails with the link whenever a patient is requesting records."* **THE FORM AT CALL TIME IS ON THIS SAME v73, and it is the deliverable; the name exit above is what lets a caller who will not identify themselves on the phone still receive the form, which collects the name.** The spec he asked to keep beside him is the artifact *Records Funnel Spec*. **THE VOICE HALF:** `file_records_ticket` gains `form_channel` (`sms` \| `email` \| `verbal` \| `declined`), asked with the format in the question (RULE ZERO 2c: *"is this a mobile number that receives texts, or would you rather have it by email?"*); for a patient or personal representative choosing text or email the tool files the request as `requestPathway: 'pending_authorization'` with `capClockApplies: false` — LOGGED AND TRACKABLE, CLOCK NOT RUNNING — and sends `formChannel`, which makes the ticketing app text or email the single-use signing link in the SAME request that opens the case; the on-clock destination/date-range gate stands down because the form collects both (doc 17 decision 2); the email is asked ONCE and falls back to a text; `verbal` files on today's path and hands the agent the spoken directions (`WEBSITE_DIRECTIONS`, one constant — the documented domain is azulvision.com); a third party's `form_channel` is IGNORED, not refused, so a provider, plan or attorney files exactly as before with no form and no question. `send_records_form` is the re-send (text did not arrive, or the other channel), latched on a filing having SUCCEEDED on this call through `gateAttempts`' per-call facts — never a model argument (the v17 P1 lesson) — and it never sees the URL. The tool result hands the agent what to SAY (`form_sent`, both on the timeline allow-list): *"your request is logged, and I've just sent a link by text to this number — a short form, about four minutes, and you sign at the end; that is what lets us release the records"*, or that the records team will send the form when the app could not. The records prompt's *"two more are required"* block became the funnel; every pinned records ruling survives (`queuePromptRulings` is the guard), the *"records team explains the paperwork"* sentence is gone because the agent now sends it, and **the two records ceilings were RAISED ONCE with the reason** (cold 1,750 → 1,900 at 1,857 measured; recognised 2,076 → 2,280 at 2,235) — the ceiling is the operator's, this was his top priority that day, and trimming the offices block instead is recorded as open in the spec. **THE APP HALF (ticketing-app #320, DEPLOYS FIRST):** one send service extracted from the staff button (`intake-send-service.ts`: mint → attempt audit → send → outcome audit → thread → state move), called by the staff route, by `create-ticket` (which accepts `formChannel` and sends right after the case opens, stepping a fresh case `received → intake_review → awaiting_authorization`, and answers `form: { requested, sent, channel, statusMove, error }` — a failed send never fails the ticket) and by the new re-send endpoint `POST /api/voice-agent/records-intake-link` (by ticket number or call SID, optional email); `pending_authorization` joins `RequestPathway` and `NON_CLOCK_PATHWAYS`, so the case sits in "Chase authorization" off every clock consumer; **the signed form starts the clock** — `startClockOnSignedAuthorization` rewrites the pathway to the signer's right-of-access pathway with `received_at` = now and the due date from now (Cal. Health & Safety Code §123110 runs the days from the WRITTEN request), writes a `clock_started` audit row, and the case moves `awaiting_authorization → intake_review` (doc 17 decision 1); the state machine opens exactly two INTAKE-stage states to a non-human sender and nothing past intake; the dead `/api/voice-agent/records-request` is deleted (decision 6). Two decisions were TAKEN there that are workflow decisions and are recorded as his to overrule: an automated sender moving a case within intake, and the clock starting at the signature rather than the call. **STILL HIS:** Spanish (the form is English only; 4% of records calls show Spanish cues), whether a typed signature satisfies identity verification (nothing has ever set that flag), what happens to a verbal/declined caller's later website submission (it arrives as a fresh case, not attached — accept the duplicate or hold the phone case off the clock too), and the ceiling. `src/tools/recordsFormAtCallTime.test.ts` (13, through `runTool` with the client mocked at both methods), `src/agents/recordsPromptFunnel.test.ts` (the prompt and the tool list); app: `tests/the-agent-sends-the-form.test.ts` (18). **11 mutations, 11 caught:** the third-party gate removed, the pathway not switched to pending (2), the clock not switched off, the on-clock gate not standing down (8), the email asked every time, the re-send latch removed, the latch never set (3), `form.sent` read as always true (2), the verbal directions dropped, a form sent on a redirected ticket, and the email fallback removed. Guards: **third-party requests receiving a form must stay 0**; forms sent on a ticket that left Medical Records must stay 0 (the `!redirect` gate); records tickets per substantive call must not fall; and Pending Auth cases older than 14 days with no signature are the ones the link did not reach — watched weekly. `requestSweep.test.ts` +11; **6 mutations, 5 caught on the first run and 6 on the second** — the window ignored, any length inside a window read as identity, the window never closing, `date of birth` no longer opening one, every agent line opening one; and **spelled letters counted as speech SURVIVED the first run**, because the fixture spelled a five-letter surname and two of its letters (`s`, `i`) are already identity scaffolding, so the three left sat inside the name-sized bound by accident. An eight-letter surname is the test that makes the single-letter filter load-bearing, and the commit that recorded six caught before that test existed says so in its successor. **AND THE PCP SWEEP INHERITS IT:** `sweepPcpUnfiledCall` reads the same predicate, so the v31 accepted cost (an unnamed identity-only call over-filing into department 18) narrows to the volunteered-name residue — `unclassifiedCallStillFiles.test.ts`'s "accepted cost" test was REWRITTEN to that residue, not loosened, and the full suite is what found it. Out of order it costs these calls nothing they are not already losing, and buys nothing. `src/tools/recordsFilesWithoutAName.test.ts` (14, through `runTool`), `requestSweep.test.ts` (+6), `sweepRunner.test.ts` (+2), `ticketingSyncService.test.ts` (+3 source pins); on the app, `tests/create-ticket-files-without-a-name.test.ts` (8, the gate driven with its own suite's mocks). **12 mutations, 12 caught:** the identity fill removed, the name ask never spent (2), names blanked instead of omitted, the note into the description, the name refusal not counted (2), the on-clock exit back to opt-in only (2), the on-clock refusal not counted (2), `first_name` back in `required` (6), the sweep exception widened to tech (7), removed (5), its staff note dropped (2), and the sync back to `agentId \|\| "unknown"` (2). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this files tickets. The numbers: records-line conversations refused by `file_records_ticket` and never filed — **21 in fourteen business days, target 0**; dept-16 tickets carrying `PATIENT NAME NOT CAPTURED`, which is the first count of how large that population is; and new dept-16 tickets carrying a uuid in `agent_used` — **target 0** against 126 of 307 in the window. The guards: **records tickets per substantive call must RISE**; tickets carrying a name that is not the patient's must stay 0 (a phone candidate never fills the name, and the app's gate no longer searches on an empty one); and no other lane's `no-name` sweep skips may fall, because the sweep exception is one lane by name |
| **v73** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v74**, and it is ON `main` since #335 merged 2026-09-27 (`f998a0b`)) | the after-hours line treating an email preference with no address as a QUESTION rather than a technical failure. **FOUND BY THE 21:20 UTC FLEET WATCH ON 2026-09-27 AND READ FROM `voice_agent_api_logs`, NOT INFERRED.** `CA42f5b35d3924b8a1e5e66c00ee927742`, no-ivr, 20:48 UTC, 217 seconds, 14 caller lines: a reschedule request whose caller asked to be reached by EMAIL and spelled the address out on the call. The model called `create_ticket` with `preferred_contact: "email"` and **no `email` argument** — the caller's address never left the transcript — and the ticketing app refused the POST, HTTP 400, because `voice-agent-ticket-service.ts` requires `patientEmail` when the contact method is email. **No ticket of any provenance exists for that call**, and the agent's last words were the technical-issue apology: *"I'm sorry, I'm experiencing a technical issue on my end right now. I have your information and our team will call you back."* It did not have their information and nobody was going to call. **THE CHAIN HAS FOUR LINKS AND EVERY ONE OF THEM WAS ALREADY WRITTEN DOWN SOMEWHERE ELSE IN THIS FILE.** (1) The app's refusal body is `{ error: "Missing required fields: patientEmail. Please collect these from the patient before submitting., missing: patientEmail", success: false, validationErrors: [...] }` — **no `missingFields` key reaches the client**, because the route drops the service's array. (2) `makeRequest` throws on a 4xx with the body's `error` TEXT and nothing else, and `submitTicket` catches that into `{ errorCode: 'request_failed', error: <text> }`. (3) `submitSimplifiedTicket` read `response.missingFields` — undefined on every real refusal, so the branch that writes `Missing required information: …` fired on NOTHING — and returned the raw text. (4) The no-ivr handler matched `includes('Missing required information')`, the sink's spelling and not the app's, so the refusal fell through to the generic branch, whose copy is the apology — **the v18 shape exactly: a branch speaking the sentence that belongs to its sibling.** Two spellings of one refusal, and every reader on the path knew one of them. **14-DAY CONTROL, same table:** no-ivr POSTs carrying an email preference — **8 accepted, every one with an address; 2 refused for `patientEmail`.** Small, and each one is a request lost after a caller has spent three minutes on the phone, on the lane that takes all overnight and weekend volume. **THREE CHANGES, one per link that was ours.** (a) **THE ASK IS BOUNDED THE WAY THE DATE-OF-BIRTH ASK IS** (v41, `decideDobEscape`): the handler checks BEFORE the schedule lookup — an email preference with no address is refused ONCE, keyed on the CallSid through `gateAttempts`, with the funnel question in the model's instruction (*"What email address should we use? Please spell it out for me, letter by letter."* — RULE ZERO 2b, the format in the question) and the way out named (`preferred_contact: "phone"`); on the next attempt the request **FILES, for a PHONE callback at the number already on it**, with `CONTACT PREFERENCE: … filed for a PHONE callback` in `additionalDetails` and never at the head of `reasonForCalling`, where the `Request Type:` header must stay (operator, 2026-07-25). The caller's words never reach the note; the recording has them. `patientEmail` is omitted rather than blanked, because the app reads `.trim()` and refuses a blank. (b) **ONE PARSER FOR BOTH SPELLINGS** — `src/services/missingFieldsRefusal.ts`, read by the sink so every lane through `submitSimplifiedTicket` (no-ivr, answering-service, after-hours) gets `Missing required information: <fields>` back whichever wording the app used, and read again by the no-ivr handler so the model is told WHAT to ask for in words (*"the email address to reach them at, spelled out letter by letter"*) rather than in the app's column names, and told that nothing failed. One function, two call sites, because two near-identical matchers is the `explicitAsk.ts` drift this repo has already paid for. (c) The prompt's contact-method block gains the funnel line, so the address is asked for at the moment the preference is stated instead of discovered missing at filing. **WHAT IS NOT CHANGED:** the app's rule (an email ticket needs an email — correct), the client's throw shape (read by `createTicketDurable` for the 4xx split, and widening it is its own change), and the generic apology branch itself, which is still right for an outage. `src/agents/noIvrEmailPreferenceIsNotAFailure.test.ts` (the REAL agent, the tool invoked the way the SDK invokes it — a helper test proves the helper and not that this lane calls it, failure mode 10), `src/services/missingFieldsRefusal.test.ts` (the parser on the app's exact logged text), `src/services/syncAgentReadsTheAppsRefusal.test.ts` (the sink on the client's `request_failed` shape). **14 mutations, 14 caught:** the pre-check removed (6 fail), the ask never spent (2 — the loop), the fallback keeping `email` (2), the staff note dropped, the handler back to `includes` with the old passthrough (3 — the apology returns on the corpus shape), the sink back to the array only, the sink's message in column names (2), the ask not keyed on the call, a blank email forwarded as-is, the prompt line removed, the parser reading only the sink's spelling (5), the parser running past the sentence end (6), the handler dropping *nothing has failed*, and whitespace counted as an address. **One arm was REMOVED rather than recorded as an equivalence:** the parser first read the app's `missing:` tail as well as the head, and the tail repeats the head word for word on every real shape, so a mutation dropping it could never go red — a second arm that cannot disagree with the first is a second thing to keep right for no case. **CODEX P2 ON #335, correct, taken:** the staff note said the address was *"not captured on the call"* — and on the corpus call it WAS, spelled out letter by letter; the model dropped it. The handler cannot tell a caller who never gave an address from a model that lost one, so the note now says no address reached the TICKET and sends the staffer to the recording, where on that call it was sitting. The console marker says the same (*"no email address reached the tool"*). Pinned on the constant: the old claim is banned, the recording is named. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the after-hours line says and files, on the OLD CORE, so the marker dates the build the way v18, v41, v47 and v53 do. The numbers: no-ivr `/submit-ticket` refusals for `patientEmail` — **2 in 14 days, target 0**, because the handler now refuses before the wire; and no-ivr calls whose transcript carries *"experiencing a technical issue"* with a refused POST and no ticket behind them — **1 on 2026-09-27, target 0**. The guards: **no-ivr tickets with `preferredContactMethod = 'email'` must not fall to zero** — the ask must still collect addresses (8 of 10 did), and a zero means the fallback is firing where the question should have; the `[EMAIL ESCAPE]` console line counts the fallback; **no-ivr tickets per substantive call must not fall**, and tickets carrying an email that is not the caller's must stay 0 — nothing here invents one |
| **v74** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v75**, on the #336 branch, ABOVE `main`'s v74 — and v75 and v76 ship together in one PR, so only v76 ever reaches a deployment; a build reading v75 does not exist, the v34/v35 shape) | the transcriber detecting the caller's language instead of being told it is English. **Operator, 2026-09-28: *"xai specifically states that large prompts are unnecessary, they also have their recommendations for handling spanish calls, we need to ensure the runtime follows those docs to the letter."*** So the docs were read — `docs.x.ai`, Speech to Speech and its Prompting Guide, pulled to disk and diffed line by line against `src/`, the whole audit in `docs/observatory/XAI-DOCS-CONFORMANCE-20260928.md`. **ON SPANISH THE RUNTIME DEPARTED IN ONE PLACE.** The docs: *"The model automatically detects the input language and responds naturally in the same language — no configuration required"*, and `language_hint` exists to *"bias ASR transcription toward a specific language"*. `buildSessionConfig` seeded `language_hint: "en"` on EVERY call, because every registered lane carries `language: 'en'` copied from the old core, where the PROMPT did the detecting — a default nobody chose, sent as a bias against the caller's first turns before anyone had heard them. **MEASURED FIRST, 2026-09-14..27, runtime queue lanes, `duration >= 30`:** 507 calls carried a Spanish cue in the caller's own lines (8.9% — a TIGHT cue list; *doctor*, *para* and *una* are English words and the first pass with them read 28%); the model called `set_spoken_language` on **480 of them (94.7%)**, and those filed at **82.3% against 68.1%** for English (84.4% vs 79.5% restricted to callers heard on 2+ lines). **So Spanish callers are served at least as well as English ones today and this is docs conformance, not the rescue of a measured loss** — the operator's own 09-05 guidance was *"AFTER you hear Spanish, send es-MX"*, after and not before. A defaulted English now seeds nothing (`seedsLanguageHint`, `languageExplicit` on the voice config, only an ENV value counts as a choice); an env-set language or a non-English lane still seeds its regional hint; `set_spoken_language` retargets mid-call exactly as before, es-MX as the docs require. **Revert lever, no deploy: `XAI_VOICE_LANGUAGE=en`.** Everything else on Spanish already matched the docs — regional `es-MX`, the mid-session retarget, the lock clause (*"Control language explicitly if unwanted language switching appears"*). **THE AFTER-HOURS LANE HAD NO `set_spoken_language` AT ALL** — it builds its tools by hand and the registry tool never reached it, so on the runtime (where it is about to move, carrying every overnight call) its hint could never follow a Spanish caller; the tool is now on the lane from ONE shared copy of its words (`SET_SPOKEN_LANGUAGE_DESCRIPTION`, `spokenLanguageResult`), and its 🗣️ LANGUAGE block is restated in the guide's language-lock shape, naming the tool. On the OLD CORE the tool returns its result and moves nothing on the wire, which is harmless and lasts until the repoint. **AND THE 66 NO-CUE SWITCHES WERE UNCOUNTABLE** — 574 switch events in the window, `args {}` and `outcome {success:true}` on every one, because `language` was not on `toolTimeline`'s outcome allow-list; it is now (the normaliser's tag, never the caller's word), and those 66 — the lanes' WORST filing arm at 45.5% — are the first thing to read. **ON PROMPT SIZE THE DOCS STATE A DIRECTION, NOT A NUMBER:** the migration guide's *"Simplify your system prompt. The model is significantly more capable, so your prompt should be much shorter … Remove workaround prompting"*, and the Prompting Guide's five `##` sections in order, second person, *"use [CRITICAL] sparingly"*. The four queue lanes conform (all five sections, 0 CRITICAL, 1–2 NEVER/ALWAYS, 6,374–7,421 own chars). **PCP does not carry the five sections** (~2,400 own tokens, an H1 rule on top, 9 absolutes) and is live — restructuring is a ticket-path change with its own arm. **THE AFTER-HOURS PROMPT WAS NEVER REWRITTEN FOR GROK AT ALL:** 28,478 own chars (~7,100 tokens) before the 9,317-char knowledge pack, none of the five sections, a six-phase *"INTERNAL WORKFLOW PLAYBOOK (FOLLOW THIS EXACTLY)"*, 6 CRITICAL banners, 26 NEVER/ALWAYS, a SECOND office list (2,396 chars) under the pack's own, and the workaround prompting the guide names — anti-narration and forbidden-phrase lists, anti-repetition, interruption recovery, a numbered CORRECT SEQUENCE. **That rewrite is the next piece of work and is NOT in this build**, deliberately: its content is escalation policy (the three cases, 911, the 1 AM robocall rule) and the operator reads it line by line before it goes on the line that takes every overnight call; it ships on the build that moves the lane, so the migration is a rewrite and not a port. The knowledge pack's office directory and surgeon roster are the *"long or document-bound"* half the docs send to a knowledge base (`file_search`) — recommended for measurement first, not built. `grokSession.test.ts` (+3), `laneRegistry.test.ts` (+2), `toolTimeline.test.ts` (+1), `src/agents/noIvrSpeaksTheCallersLanguage.test.ts` (7, the REAL agent, the bridge's name table read from source). **9 mutations, 9 caught:** the seed always sent (2 fail — the pre-v75 behaviour), the registry's default read as a choice, an env language read as a default, `language` off the allow-list, the after-hours lane dropping the tool (4), the result without its tag (the bridge would have nothing to switch on), the lock line deleted, an empty `transcription` block still sent, and the bridge's name table renamed (the no-ivr wiring assertion is what catches it). **AND THE SOURCE-READING HTTP GUARD CAUGHT A REAL THING ON THE WAY:** `serverRegistration.test.ts` reads `registerTool({ name: '…'` off the source, so replacing the literal with the shared constant made every queue lane's `set_spoken_language` read as unreachable over HTTP — the registration keeps the literal and a test pins the constant to the bridge's own table, so the two spellings cannot drift. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the transcriber is told on every runtime call. The numbers: Spanish-cue calls' switch share (94.7%) and filing (82.3%) must not fall; and `set_spoken_language` outcomes carrying a `language`, 0 today, target all of them. The guards: **no-cue filing (68.1%) and barely-heard (18.8%) must not move** — an English caller mis-detected as something else would show there first; and tickets carrying a language the caller did not speak must stay 0 |
| **v75** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v76**, on the #336 branch, ABOVE `main`'s v74; v75 and v76 ship together with v77 in one PR and only v77 reaches a deployment) | the after-hours prompt in the shape xAI's own docs prescribe — on the Grok pipeline only. **The docs audit (v75 row, `docs/observatory/XAI-DOCS-CONFORMANCE-20260928.md`) found the migration text describing this prompt exactly:** *"Simplify your system prompt. The model is significantly more capable, so your prompt should be much shorter. Ask Grok to generalize your existing system prompt rather than porting it verbatim. Remove workaround prompting."* The legacy body is the OpenAI-era prompt: 28,478 own characters, a six-phase *"INTERNAL WORKFLOW PLAYBOOK (FOLLOW THIS EXACTLY)"*, six CRITICAL banners, twenty-six NEVER/ALWAYS, and the patches the guide names — anti-narration and forbidden-phrase lists, anti-repetition, interruption recovery, a numbered CORRECT SEQUENCE — each written against a failure the runtime now handles mechanically (the v46 ceiling, the v68/v72 ladder, the bridge's barge-in, the v41 date-of-birth escape in the tool). The v18 trim of 2026-09-14 removed borders and padding *"with no rule changed"* and said reaching a Grok-sized prompt *"means deleting capability, which is his call"*; on 2026-09-28 he made it, in the docs' direction. **`src/agents/noIvrPromptForGrok.ts` is the SAME RULES in the guide's shape** — `## Role & Persona`, `## Objective`, `## Conversation Flow` (five phases as Goal / How / Exit when), `## Guardrails & Escalation`, `## Voice & Communication Style`, one `## CRITICAL INSTRUCTIONS` with three absolutes — **14,082 built characters against 28,801 (49%), and 23,399 against 38,118 with the knowledge pack** — 2,489 of which is the triage block and the urgent-symptom list both bodies share verbatim; the body's own text is ~9,600 of it. Still above the queue lanes' 6,374–7,421, because this line carries escalation, ghost-call and triage policy they do not, and what is left to cut is policy. **THE GROK PIPELINE GETS IT AND ONLY THE GROK PIPELINE.** `voiceRuntime` marks its per-call metadata `pipeline: 'runtime'`; the SIP core never does; `noIvrPromptShape` picks on that — so this can deploy today and changes NOTHING on the live after-hours line until the number is repointed, and the migration is then a rewrite rather than a port, the way the docs describe it. Revert lever `NO_IVR_PROMPT_SHAPE=legacy`, no deploy — and ONLY legacy, see the Codex note at the end of this row. **THE RULINGS MAP IS THE DELIVERABLE AS MUCH AS THE BODY:** `noIvrPromptShapeForGrok.test.ts` drives the REAL agent on both pipelines' metadata and holds BOTH bodies to ONE list of twenty-three operator rulings — the three escalation cases, a patient asking for a human is not an emergency, ghost and robot calls end and never escalate (the 1 AM rule), the wait line before `create_ticket`, B2B date of birth optional, new-or-existing on a lookup miss, filing a partial ticket IS the job, a failed tool is never an escalation, never promise a recording, the full name in one question, the email funnel, the language lock naming `set_spoken_language`, no *"is that correct?"*, the ticket number not read out, the technical-issue sentence verbatim — plus the ORDER `noIvrFalseFailure.test.ts` pins on the legacy body (the in-progress/once-more carve-out BEFORE the technical-error rule), plus the guide's own rules: five sections once each in order, CRITICAL exactly once, no second office list (the runtime prefixes the knowledge pack, which has one), and **every tool the prompt names is on the agent** (*"Only mention tools that exist in the tool definition"*), tested against a fleet-wide tool list so it cannot pass vacuously. **ONE DELIBERATE RULE CHANGE, NAMED FOR THE OPERATOR TO OVERRULE:** the recognised-caller block told the model to take *"the last name AND the date of birth IN ONE question, never one and then the other"*; the Grok body takes the last name in their own words, then the date of birth in parts — RULE ZERO 2b, one field per question, the way every other lane asks. Everything else in that block survives (do not open with a name confirmation, do not speak over the greeting, a first name confirms no last name, a denial discards the match, disclose nothing). **NOT MEASURED IN PRODUCTION** — no-ivr is on the old core, where this body is never built — and `docs/BACKEND_HANDOFF.md` applies from the first call after the repoint: the before-arm is the review's fourteen days (617 substantive, 346 filed, 56.1%). The numbers: no-ivr tickets per substantive call must not fall; escalations per substantive call must not rise; ghost/robot terminations must not fall. The guards: the three-case escalation must still fire on a clinician's call (the review's test call 2), a patient asking for a human must still get a ticket and never a dial, and the ratchet (15,000 built chars) is lowered when a trim lands and never raised silently. **11 mutations, 11 caught:** the picker always legacy (7 fail), always grok (3), the runtime forgetting to name its pipeline, the env lever ignored, a ruling deleted, the carve-out moved after the technical rule, a CRITICAL banner sprinkled back in, a phantom tool scripted, the office list returning, two fields in one breath returning, and the language tool dropped from the body (2). **CODEX ROUND 1 ON #336 (09:22 UTC, on `adda86f`, triggered by the ready-mark) — one P2 here, real, taken.** `noIvrPromptShape` honoured `NO_IVR_PROMPT_SHAPE=grok` on the SIP core too, and the Grok body is NOT self-contained there: it leans on `bindAgent` for the knowledge pack, the language mechanism and the language tool, and the SIP path in `voiceAgentRoutes.ts` calls the factory directly and binds nothing — so forced onto the live line it would have answered from practice facts it was never given and lost its English-and-Spanish rule. `grok` is no longer a lever at all: the shape is decided by the pipeline alone, and `legacy` stays the one revert. The test that asserted the defect (`=grok the other way`) is rewritten, not loosened, and a second drives the REAL agent with the env set and no pipeline and asserts the legacy body, tools and policy statement come back |
| **v76** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v77**, on the #336 branch, ABOVE `main`'s v74; v75 and v76 never reach a deployment on their own) | the language mechanism being the RUNTIME's — and the docs' shape being guarded on every lane the runtime serves, not on the one that was rewritten. **Operator, 2026-09-28, of v75/v76: *"Shouldn't this be for the runtime in general?"*** Yes, and the 2026-09-15 ruling already said where: *"the things that are applicable to any conversation should be in the runtime; things applicable to that agent itself should be in the prompt."* Following the caller's language is applicable to any conversation, and it was written into FIVE prompts (four queue lanes since 2026-09-03, the after-hours lane on v75) and listed by five tool lists — pcp, live on this runtime since 09-04, had neither. The bridge already did the transport step by NAME for any lane; every prompt re-explained it. **THREE THINGS MOVE INTO THE RUNTIME.** (1) **The tool.** `laneRegistry` binds `set_spoken_language` to every lane it resolves (`RUNTIME_OWNED_TOOLS`, through the same adapter and telemetry the lanes' own tools use), and `bindAgent` adds a runtime tool only when the agent does not already declare one of that name. The four queue lanes' `*_TOOLS` lists and the after-hours lane's v75 hand-built copy are gone; `serverRegistration.test.ts` still holds the HTTP surface. (2) **The words.** `src/runtime/languageMechanism.ts` is the ONE copy — the moment the caller speaks another language call the tool, switch only if the caller switches, every quoted question is a shape to translate, arguments in English — appended by the binding to the END of `## Voice & Communication Style`, which is where xAI's Prompting Guide puts language control (*"Language lock … Control language explicitly if unwanted language switching appears"*); a prompt with no such section gets one. **The POLICY stays with the lane, as configuration:** `spokenLanguages` on the agent's registration (`AgentConfig`, `LaneConfig`) renders into the block's first clause — the after-hours line declares `['en','es']` (an old-core-era rule the operator has not revisited: any other language is answered in English) and every queue lane declares nothing, so it follows the caller (a Turkish caller was followed live on 2026-09-03). The five per-lane sentences are deleted; the legacy after-hours body keeps a tool-less statement of its policy for the old core, where the runtime binds nothing. (3) **The facts.** The knowledge pack moves from a preamble to `## Business Facts` directly after `## Role & Persona` on any five-section prompt — the docs' *"Facts are baked in verbatim … under Role & Persona or a small `## Business Facts` section"* and their fixed order with Role & Persona first. ADR-001 put it in front for a shared cache prefix; that reasoning was written for a token-billed API, and the voice model is billed by the minute and *"contributes no measurable tokens"* (the cost section), so the prefix bought nothing the order does not. A prompt not in the shape keeps the pack in front, as before. **PCP IS RE-SECTIONED**, sentences unchanged: `# WHAT YOU DO` → `## Objective`, the director and intake blocks under `## Conversation Flow` as `###` sub-sections, `# SAFETY` + `# WHEN A TOOL SAYS NO` → `## Guardrails & Escalation`, `# HOW YOU SPEAK` → `## Voice & Communication Style` (its own *"Speak English unless the caller asks"* line deleted — the mechanism now says it, and two instructions on one subject is what the guide calls out). The shared triage block's `# TRIAGE` H1 becomes a `###`. `pcpPromptRulings.test.ts` names `## Role & Persona` and the bare `## Conversation Flow` heading as the two docs-required sections that carry no unique ruling. **THE GUARD IS THE DELIVERABLE:** `src/runtime/promptShapeIsTheDocs.test.ts` resolves optical, surgery, tech, records, pcp and no-ivr through the REAL registry the way `voiceRuntime` does — NOT gated on `RUNTIME_LANE_SMOKE`, because a guard that runs only where somebody enables it is not a guard — and holds the BOUND prompt and tool list to the docs: opens `## Role & Persona\nYou`, the six sections once each in order, the pack once under Business Facts, no H1, CRITICAL at most once and only appended, every tool the text names on the offered list (against a fleet-wide tool list, so it cannot pass vacuously), the language tool bound and dispatchable to `es`, the mechanism present exactly once inside the Voice section with the lane's own policy, and `set_spoken_language` named once. answering-service (off-limits, never a runtime call) and azul-scheduling (refused) are excluded by name. **MEASURED AS THE RUNTIME BUILDS THEM (chars, ~tokens by chars/4), all six in the docs' order:** optical 15,457 / 6,140 own · surgery 15,110 / 5,793 · tech 16,265 / 6,948 · records 17,340 / 8,023 · pcp 19,731 / 10,414 · no-ivr 23,607 / 14,290, the pack 9,317 on each. **WHAT IT COST TO GET HERE, recorded:** `resolveLane` now imports the tool library, whose telemetry module validates the environment at import, so `laneRegistry.test.ts` and `voiceRuntime.test.ts` gained the same dummy connection string the after-hours suites already set; `agentBinding.test.ts`'s *"takes the agent's own instructions verbatim"* and *"prefix first, agent's text last"* were REWRITTEN to the new composition, not loosened, and it gained the Business-Facts placement and the never-twice-under-one-name rule; the two lane tests that pinned the exact tool list now pin *the agent's tools, then the pipeline's*. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes every runtime lane's prompt (the pack's place, the language block) and PCP's headings, so it is a ticket-path change on five live lanes. The numbers: filing rate per lane must not move; `set_spoken_language` events per Spanish-cue call (94.7% on the queue lanes) must not fall and should APPEAR on pcp, which had no tool; PCP tickets per substantive call must not fall (the before-arm is this week's). The guards: tickets filed with no `location_id` must not rise on optical; an English caller answered in another language must stay 0; and no lane's prompt may grow past its own ratchet. **10 mutations, 10 caught:** the runtime binding no tools (15 fail), the mechanism not appended (9), the pack always in front (7), a runtime tool duplicating a lane's own name, the mechanism appended after the Voice section instead of inside it (13), the policy ignoring the lane's list (2), the after-hours registration dropping its policy (2), PCP's Voice section back to an H1, the shape-to-translate ruling dropped (6), and a lane naming the tool a second time. **CODEX ROUND 1 ON #336 (09:22 UTC, on `adda86f`) — one P2 here, real, taken, and it is the v77 design contradicting itself.** The runtime bound the SAME tool, with the SAME words, to every lane — and the after-hours lane declares `spokenLanguages: ['en','es']`. So that lane's prompt said *"for any other language, say in English that this line can help in English and Spanish, and continue in English"* while its tool said *"call this the moment the caller speaks a language other than the one you are using — then carry on in that language"*, and the tool's result is the NEWER instruction: `setSpokenLanguage` appends a lock line to keep every utterance in the requested language, so a Tagalog caller would have had the whole session retargeted against the policy. Two instructions on one subject, which is exactly what the guide's language-lock rule and this row's own "one copy" argument exist to prevent. **THE POLICY NOW REACHES THE TOOL:** `runtimeOwnedTools` injects `spoken_languages` as context (the `lane` shape `lookup_patient` uses — not a schema field, merged UNDER the model's arguments, so the model can neither set it nor be asked for it), `spokenLanguageResult` refuses a language outside the list with `suppressed: 'language_not_spoken_here'` (already on the timeline allow-list, so every refusal is SQL-countable) and a `fix` that restates the policy and says NOTHING was switched — and NO `language` key, which is the load-bearing half: `languageToSwitchTo`, the bridge's one reader, returns undefined and the wire does not move. The tool's DESCRIPTION is composed per policy too (`spokenLanguageToolDescription`: the policy head, the shared tail), so a lane that speaks two languages is never told to follow a third; a lane with no policy keeps the original words verbatim and still follows any caller (`Tagalog` → `tl`, asserted on every undeclared lane by the fleet guard). `noIvrSpeaksTheCallersLanguage.test.ts` +3 (Tagalog refused through the REAL registry with the bridge's own reader saying so; Spanish, `es-MX` and English still switch; the description carries the policy) and `promptShapeIsTheDocs.test.ts` +1 per lane (policy lanes refuse, undeclared lanes follow) |
| **v77** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v78**, ON `main` since #337 merged 2026-09-28 (`d89e3b5`); **A BUILD READING v77 IS THE OUTAGE BUILD**) | the language tool being registered ONCE — every runtime lane was down on this build. **THE OUTAGE, 2026-09-28.** The operator republished v77 at 14:17 UTC. The first runtime call after it, `CA565a7f5b8bc12a8f8318348896376e3a` (records, 14:23:22 UTC, 10 s), died at setup, and so did every runtime call after it — `CA0837aefed9ad94778afd479a4833ad80` (records), a pcp call at 14:29, the operator's own test calls from two numbers — all `runtime_outcome = provider_failure`, `total_turns 0`, no transcript, `local_duration_seconds 1`, while the old core's no-ivr line kept filing (VA-64924…64930). The operator's first reading was that the records repoint had a corrupted URL and then that the Spanish change had done it; neither: the URL answered `/voice/records` correctly (a bad URL leaves no `call_logs` row at all, these calls had rows on the Grok pipeline), and xAI accepted the exact v77 session config for records, optical and pcp — real prompts, real tools, with and without the language hint, with and without keyterms — from here in under 1.5 s every time. **THE DEPLOYMENT LOG NAMED IT, read through the Replit connector after two hours of the wrong hypotheses:** `ERROR call setup failed for CA565a7f5b8bc12a8f8318348896376e3a: [TOOLS] duplicate tool name: set_spoken_language`. **THE MECHANISM, REPRODUCED AND NOT ARGUED.** `registerTool` (`registry.ts:122`) refuses a second registration of a name; `languageTools.ts` registers `set_spoken_language` at module top level. The process that serves `/voice/*` is `server/index.ts` (port 5000 — NOT `src/server.ts`, which is the old core on 8000), and it loads the tool library through `await import('../src/tools/server')`, whose static `import './languageTools'` registers the tool at boot. v77's `runtimeOwnedTools` then did `await import("../tools/languageTools")` inside `resolveLane` — and **on Node 20, the version Replit runs (`.replit`: `nodejs-20`), that dynamic import evaluated the module a SECOND time**, so the second top-level `registerTool` threw inside call setup, `voiceRuntime`'s catch recorded `provider_failure`, and the caller heard the call drop. **It does not reproduce on Node 22**, which every test, every CI run and every local probe ran on — five probes here passed before the sixth, built with the API process's exact boot shape (the runtime and the tool surface both dynamically imported, then a lane resolved) and run under a fetched Node 20 binary, threw production's error word for word; the same probe on Node 22 resolved every lane. **THE FIX IS ONE IMPORT STYLE**, the v71 rule for a second module family, and this time the hazard that rule was written against has fired: `laneRegistry` imports `languageTools` and `realtimeAdapter` STATICALLY, so the module goes through the same loader and cache as the boot-time import and is evaluated once — proven by the same Node 20 probe resolving records, optical and pcp with the language tool bound. **`pcpAgent.ts` carried the same shape since v15** (`await import('../tools/medicalRecordsTools')` in `fileToMedicalRecords`) and is static now too; on this pipeline that route may have been throwing the same duplicate on Node 20 and answering `records_tool_unavailable` instead of filing to Medical Records, which would explain a department-16 count that never rose — **the after-number below, not a claim**. **`registerTool` STAYS STRICT, deliberately:** an idempotent registry would have hidden this duplicate and every genuine one (two files claiming one name), and the second instance's handlers would have silently shadowed the first's. `src/runtime/toolModulesAreImportedOneWay.test.ts` scans every production source under `src/runtime` and `src/agents` for a dynamic import whose target is a module with a top-level `registerTool`, pins the two static imports in `laneRegistry`, and pins the strict guard. **WHAT WAS LOST WHILE IT WAS DOWN:** every runtime call from 14:17 UTC to the rollback — count them from `call_logs` with `voice_provider = 'grok' AND runtime_outcome = 'provider_failure' AND created_at >= '2026-09-28 14:17'`; the old core was untouched. **THE PROCESS LESSON, recorded because it cost two hours of a live outage:** the deployment log is one connector call away and names the failure; I spent that time proving the URL, the key and the session config innocent from the outside because the first hypothesis (the repoint) was the operator's and the second (the Spanish change) was mine. **Read the deployment log FIRST on any runtime failure** — `ask_question` on the Replit app answers with the raw lines. And a fix proven only on the developer's Node version is not proven: CI runs Node 22, Replit runs Node 20, and this repo now has a fetched-Node-20 probe recipe in the row above for exactly this class. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — though this restores the pre-outage behaviour and changes nothing a caller hears. The numbers: the first runtime call on this build must resolve its lane (a `call_logs` row on the Grok pipeline with a transcript and `runtime_outcome` not `provider_failure`); `provider_failure` per day must return to its September baseline (near 0); `set_spoken_language` must be bound on every lane (a Spanish-cue call on pcp switching is the proof v77 wanted). The guards: department-16 tickets from PCP records requests must not FALL and may rise, and PCP `records_tool_unavailable` refusals in `tool_timeline` must read 0 |
| **v78** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v79**, ON `main` since #338 merged 2026-09-28 (`df07335`)) | the records tool asking the CHANNEL itself. **THE RECORDS LANE'S FIRST BUSINESS DAY ON THE RUNTIME, 2026-09-28, read end to end at 16:30 UTC.** Seven real calls by 16:21, seven filed, the disclosure on every one, `agent_used` the lane slug, no old-core records call since 14:00 — the lane works. **AND THE SIGNING LINK WENT OUT ON ZERO OF THE FOUR PATIENT CALLS.** Every create-ticket POST answered `form: {requested:false, sent:false}` — `formChannel` never reached the wire — so every patient case opened ON the fifteen-day clock with no link (VA-64969/64970, VA-64972, VA-64980), and the transcripts carry no funnel line at all: the model never asked *"is this a mobile number that receives texts, or would you rather have it by email?"* By 21:00 UTC: **14 patient or personal-representative callers with a case and no link (17 cases, three of them the race's duplicates), against ONE where the funnel fired** (VA-65262, 19:42, signed twenty minutes later — so the prompt's instruction reaches the model on about one patient call in fifteen). The operator's own 09-27 test had worked because he SAID how he wanted the link; real callers do not volunteer it. **THE MECHANISM, on `CA7de0c90285a5b1bca6bc6a4a32ac00ab`:** the model filed with no channel, the tool refused for destination and dates — the on-clock gate, which stands down only when a channel is stated — and that refusal walked the model down the old path: a refusal IS a question (RULE ZERO 2c), and the question it was handed was the wrong one. `dobShape (none)` on 75 of 75 was the same lesson on a different field: an argument the tool does not ask for does not arrive. **SO THE TOOL ASKS.** On a patient or personal-representative request with no `form_channel`, the FIRST refusal is now the channel question, in the schema's own `askAs` words, with `fix` telling the model not to ask where or which dates (the form collects both). **ONCE**, keyed on the call through `gateAttempts` like every other ask on this lane (`RECORDS_ASK_LIMIT`); a second invocation still carrying no channel is the model failing to relay the answer, not the caller failing to give one, and it files with a TEXT to the callback number — the fallback the email ask already uses (a landline turns it into a delivery failure on the case for the staff button). **What that trades:** a caller who declined the link and whose decline the model then dropped gets a text they did not ask for; against it, the case the operator called unacceptable (*"these are cap cases"*), an on-clock CAP case with no link. `verbal` and `declined` are answers and pass straight to the destination-and-dates gate as before; a third party is never asked (no form for them); a REDIRECTED request is never asked — the cross-queue verdict is now decided ONCE, before the ask, on the same words the filing reads, so a caller who pressed the wrong option and wants an appointment is not offered a records form; a sentinel CallSid asks every time; and a lane that DECLARES it cannot ask (`on_clock_ask_exhausted`, which PCP sets on every records filing because it collects neither a destination nor a range) is not asked either — the full suite caught that one, 13 PCP records tests red, because the ask would have turned every patient records call on the PCP line into a refusal that lane has no question to answer, the exact shape #296 fixed. PCP's patients get the form from the app's backfill. **THE TWO THINGS BESIDE IT ARE ON THE TICKETING APP, same day, same ruling:** (1) **duplicate cases** — six records calls by 21:00 opened two or three cases each (`CA7de0c…` VA-64969+64970, `CA074ea…` VA-64985+64986, `CA8b6f8b…` three), POSTs a second apart on ONE idempotency key, because `create-ticket`'s key check is a SELECT at the top and an INSERT after the ticket exists, and the model's batched filing calls race past it — 0 such pairs in the fourteen days before; fixed with a session advisory lock on the key held for the whole request, failing OPEN; (2) **the backfill** — `scripts/send-missing-records-forms.ts` sends the same link the call should have, through the same service the staff button and the voice agent use, to every patient case with no link, once per call, and lists the race's duplicates for a person to close (the operator, 2026-09-28: *"figure out who needs the form, we cant leave them hanging, they have made a formal request"*). `src/tools/recordsFormAtCallTime.test.ts` +8 through `runTool`; the patient fixtures in `medicalRecordsTools.test.ts` and `recordsFilesWithoutAName.test.ts` now answer the question (`form_channel: 'declined'`, the one answer that leaves every path they measure exactly as it was). **10 mutations, 10 caught:** the ask removed (4 fail), the ask unbounded, a third party asked, a redirected request asked, the ask not keyed on the call (2), `declined` no longer an answer, the fallback filing with no channel instead of a text, the redirect decided a second time after the ask, the `fix` no longer forbidding the destination-and-dates questions, and the lane's own cannot-ask declaration ignored (4, three of them PCP's). **AND THAT LAST GUARD WAS LOST ONCE BEFORE IT SHIPPED:** it was added after the first commit, the mutation run's `git checkout -- <file>` restored the COMMITTED file, and the full suite went red on the six PCP tests the guard exists for — the #293 round-1 accident again (*commit before mutating, every time*), caught by running the full suite a second time rather than trusting the targeted one. On the app side, `idempotency-lock.test.ts` and `create-ticket-serialises-one-key.test.ts` — 7 mutations, 7 caught (never unlocking, an unlock failure returning the connection to the pool, a timeout that throws, a wait that gives up at once, the lock taken after the key is read, the lock released before the key is stored, an unacquired lock becoming a 503). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this adds a spoken question to the CAP lane's intake. The numbers: patient-pathway create-ticket POSTs with `form.requested = true` — **1 of 15 on 2026-09-28 by 21:00 UTC, target nearly all**; `mr_cases` opened by voice with `request_pathway = 'pending_authorization'` — 0 that day, target the patient share; and `file_records_ticket` refusals with `missingFields = ['form_channel']` per call — must never exceed one. The guards: third-party requests receiving a form must stay 0; forms on a ticket that left Medical Records must stay 0; records tickets per substantive call must not fall (an ask is a place to hang up, and the teardown sweep does not send forms); and duplicate dept-16 cases per call must read 0 once the app side deploys. **CODEX ROUND 1 ON #338 (22:00 UTC, on `7635f60`, triggered by the ready-mark) — one P1, real, COMMON, taken on `cf12cc0`.** When the model emits two `file_records_ticket` calls in ONE response the runtime dispatches them side by side, so the first notes the channel ask and the sibling reads it as spent milliseconds later — before the refusal is returned, let alone spoken — and defaulted to a text and filed before the caller had answered. **THE SURGEON-CLAIM SHAPE (v57) ON A NEW ASK, and NOT the sub-1% kind the 2026-09-21 ruling declines:** the six duplicate-case calls above ARE this batch, and measured on the lane's first runtime day (09-27 19:00 → 09-28 22:00 UTC) the gaps between consecutive `file_records_ticket` events on one call are **fourteen sibling gaps of 3–1,178 ms and then NOTHING until the first genuine re-ask at 4,807 ms** (the rest 5 s → 6 min); the two populations do not touch. **THE FIX IS A WINDOW, NOT A WAIT:** `gateAttempts` gains `gateRefusalAgeMs` (the count says WHETHER an ask was spent, the age says WHEN), and a refusal noted less than `ASK_BATCH_WINDOW_MS` (2 s) ago is a sibling's — it gets the SAME question back and spends nothing; only an invocation past the window is the model coming back with no answer, which is the fallback v79 built. Nothing awaits anything, so nothing can interleave — v57's serialisation drew six rounds of exactly that and was withdrawn, and a test pins the decision as await-free. **Scoped to the two form asks** (channel, and email one arm down, the same shape), whose fallback SENDS to a channel the caller has not chosen; the name and on-clock asks keep spending on a sibling because their fallback FILES, the direction a records request must err in, and `recordsFilesWithoutAName.test.ts` invoking the name ask twice at one instant is the pin. The 2 s is a judgement between two measured modes with room either side (1.7x over the slowest sibling, 2.4x under the fastest turn); the `[RECORDS] a batched sibling of the … ask` console line counts how often it fires, and the batch shape is SQL-countable as consecutive events under 2 s apart. `recordsFormAtCallTime.test.ts` +6 (the suite now drives the clock: back-to-back is a batch, a turn moves it), `gateAttempts.test.ts` +3; **8 mutations, 8 caught:** the window zeroed (4 fail), the sibling branch removed (3), the window unbounded (4), the email ask back to a bare count, a sibling re-noting (the count pin), the boundary flipped, a sentinel's age reading 0, and the window widened onto the name ask (2 — the other file's pin, as promised). Marker stays v79: the v79 without this is `7635f60`, which never deployed |
| **v79** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v80**, ON `main` since #339 merged 2026-09-29 (`480c0b9`)) | a refused after-hours escalation FILING THE TICKET. **Operator, 2026-09-29: *"fix the no-ivr refused escalation so it files a ticket."*** The corpus call is `CA05daa62fd6c7156a322ea4810d590923` (00:09 UTC that morning, 417 s, 26 caller lines, found by the 00:20 fleet watch): `escalate_to_human` was refused twice by the gate in under 3 ms, the agent then said TWICE that it would connect the caller with the on-call team, `create_ticket` never ran, `terminate_call` ended it, and no ticket of any provenance exists. **Fourteen days before it, no-ivr: 9 calls had an escalation refused, 3 left no ticket, and all 3 spoke a promise to connect and never called `create_ticket`; 22 escalations were sanctioned and all 22 reached a human.** TWO LINKS. (1) **The refusal FILES.** The gate's directive already said *"call create_ticket now"* — a sentence the model could ignore, and on 3 of 9 it did. The tool now files from its own arguments (reason, symptoms, provider, name, date of birth, callback) plus caller ID, through `submitSimplifiedTicket` with the same `call-<sid>` idempotency key `create_ticket` uses, so it cannot open a second ticket beside one the call already holds and a later `create_ticket` returns the same one — the post-call sync then carries the whole transcript onto it, so nothing the caller says afterwards is lost to the team. The note that the escalation was asked for and not sanctioned goes in `additionalDetails`, never at the head of the description (the `Request Type:` rule, operator 2026-07-25). **On `symptoms_not_stated_by_caller` the model's sentence does NOT become the request** — that arm exists because the model wrote symptoms the caller never said, and the on-call provider acts on what is written — so the ticket says the claims were uncorroborated and points a staffer at the recording, and the result leaves the door open for an emergency the caller then describes in their own words. The result tells the model what has ALREADY happened, the line to say (the number they gave, this number, or a question for one — ten digits or nothing, because a withheld caller ID arrives as a WORD, the v40 lesson) and forbids any promise of a connection; a filing that fails claims no record and sends the model to `create_ticket`. (2) **The prompts stop scripting the promise BEFORE the tool answers.** Both bodies said *Say "I want to connect you with our on-call team", then call escalate_to_human*, so every refusal landed after a promise had been spoken; both now call the tool first and speak from its answer, and the rulings map both bodies are held to gains the sentence. **INSTRUMENT:** `refused` and `ticket_filed` join the timeline's outcome allow-list — until now a refused and a sanctioned escalation were byte-identical in `tool_timeline` but for `success`, and the recorded args carry only `reason`, so an earlier reading of the corpus as a schema failure (the model omitting `caller_type`) was withdrawn as unsupported by the instrument. **WHAT IT DOES NOT DO:** the three cases are the operator's and unchanged, nothing is paged, and the duplicate-escalation refusal after a sanctioned transfer still files nothing, because that caller is with a human. `src/agents/noIvrRefusedEscalationFiles.test.ts` — 16 tests on the REAL agent (the tool invoked the way the SDK invokes it, failure mode 10), including the uncorroborated-symptoms arm driven through `recordCallerSpeech`. **11 mutations, 11 caught:** never filing while claiming filed (8 fail), the old directive-only result (8), a failed filing claiming ALREADY filed (9), `knownNumber` at one digit, the result promising a connection (3), the symptoms arm filing the model's sentence, the legacy prompt promising before the tool (2), the Grok body likewise (2), the two allow-list keys dropped, the raw caller ID on the ticket (2), and a thrown filer throwing the tool. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — no-ivr is on the OLD CORE, so the marker dates the build the way v18, v41 and v74 do. The numbers: no-ivr calls with a refused escalation and no ticket — **3 of 9 in fourteen days, target 0**; and `escalate_to_human` outcomes carrying `ticket_filed = true`, which should equal the refusals. The guards: sanctioned escalations must not fall (22 in fourteen days, every one reaching a human — this changes nothing the gate decides); no-ivr tickets per substantive call must not fall; and two tickets on one no-ivr call must stay 0 (the idempotency key is the mechanism) — with the ONE exception the next paragraph names. **CODEX ROUND 1 ON #339 (09:26 UTC, on `cd80d62`, triggered by the ready-mark) — a P1 taken and a P2 declined with its number, on `ebc7d02`.** THE P1: the refusal files under the call's own key, and that key is what makes a later `create_ticket` return the same ticket — it would ALSO have made the sanctioned path's urgent transfer record return it, because `submitSimplifiedTicket`'s per-call claim hands back the existing number without posting. So a caller refused first (an invented symptom, a detail the agent could not collect) who then described the emergency in their own words and WAS connected would have ended the call with one ticket reading NOT SANCTIONED at normal priority and no word of the transfer. **MEASURED before fixing, thirty days of no-ivr to 2026-09-29: 74 calls ran `escalate_to_human`, 26 had one refused, 51 had one sanctioned, and 3 of the 26 went on to a sanctioned transfer on the same call** — not the sub-1% shape the 2026-09-21 ruling declines. The record now files BESIDE the earlier ticket: `fileRefusedEscalationTicket` remembers what it filed per call, and the sanctioned path passes `secondTicketOnThisCall` to the sink, which skips the per-call claim, keys on `call-<sid>-urgent-transfer` and never writes `call_logs.ticket_number` back, so the caller's request ticket stays the call's ticket for the post-call sync; the record's note names the earlier ticket — SUPERSEDES on the uncorroborated-symptoms arm (that ticket was the model's own sentence; no callback is needed on it), SEE ALSO on the other two (that ticket is the caller's own request and still stands). **That is the ONE sanctioned exception to the two-tickets guard, and the second ticket names the first.** `noIvrRefusedEscalationFiles.test.ts` +5 on the real agent, `src/services/secondTicketOnThisCall.test.ts` (4, the defect itself as a control: an ordinary filing on a call that already holds a ticket posts nothing and hands the old number back); **8 mutations, 8 caught:** the record ignoring the earlier ticket (2 fail), the refusal never remembering (2), the sink still claiming (1), keying on the call (1), writing back (1), SUPERSEDES lost (2), every record filed as a second ticket (2), a FAILED refusal filing remembered (3). THE P2 — skip the refusal's filing when the reason is an office-hours question — DECLINED: 0 of the 26 refusal reasons in thirty days is one, and the remedy is a cue list over the model's own sentence (`classifyAfterHoursRequest`'s reason 166 matches `which office`, `address`, `weekend` and `open at` inside real requests, first hit wins), the surface that cost twelve P1s on #293; an hours-only ticket costs a staffer ten seconds and a skipped real request costs the caller, which is the loss this row exists to close. **Two more facts from the same thirty days, not fixed here:** refused-escalation calls with no ticket on the row are 10 of 26 (the fourteen-day figure above was 3 of 9); and `CA475654e4cfbf7e97f89c82d72f058f5e` (2026-09-28 00:38 UTC, 50 s, one caller line, no ticket of any provenance in the Support Center) was a physician's peer-to-peer REFUSED — which code is NOT on the timeline before this build (the outcome carried only `success`), and probed against `judgeEscalation` the recorded reason sentence alone is ALLOWED for both `caller_type` values the schema accepts (`patient_urgent_medical` opens by default, `healthcare_provider` is case 2), so the refusal came from a `symptoms_summary` or `provider_info` the args allow-list does not keep, and only this build's `refused` key will say which — and the agent said *"I'll connect you with our on-call team now"* and then *"the transfer didn't go through"*, both false. Under this build that call files a ticket and neither sentence is spoken; why a gate whose first case is a clinician refused a physician's peer-to-peer is a gate question for the operator, and it becomes answerable from SQL the first time it recurs on this build |
| **v80** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v81**, on its own branch ABOVE `main`'s v80) | the surgeon exit opening on the SECOND refusal instead of the third. **Operator, 2026-09-30: *"lower the surgeon exit to the second refusal."*** The exit (`routingAskExhausted`, the 2026-09-02 ruling that gave surgery the unassigned exit optical already had) fired only when TWO surgeon refusals were already noted on the call, so it needed a THIRD filing attempt. **MEASURED 2026-09-29, surgery, every call that took a surgeon refusal:** 7 died holding exactly two refusals with no third attempt (CA7fdf7ae6, CAb6d1f904, CA65ff315b, CAbbb14a77, CA133e4f97, CA5ce6cb8d, CA7bd7e83f), all 7 having taken the date-of-birth refusal first, and the calls that filed were the ones that made the next attempt. That is the surgeon gate sitting behind the date-of-birth gate — the reason surgery's date-of-birth refusals filed 8 of 18 that day while every other lane's filed 36 of 36; the escape itself worked on all 18. **READ BY THE EVENT TIMESTAMPS THE 7 SPLIT TWO WAYS, AND THE SPLIT IS THE DESIGN:** 4 were SPACED pairs — the second attempt started 10–23 s after the first refusal returned, so it read a count of 1 — and a threshold of one files all four on their last attempt; 3 were CONCURRENT pairs — the second attempt STARTED 0.9–1.1 s before the first refusal returned, both reading 0 — which no threshold reaches (the v57 shape, and in all three the caller then NAMED the surgeon, the agent said the filler, the filler was cut and the call died in dead air; that cut-filler shape is a runtime defect and is NOT fixed here). **THE COST, same day:** of the calls that filed after two spaced refusals, 3 were routed to a surgeon the roster matched on a third or fourth attempt (CA4dfab121, CAafd86aa4, CAe694e07a); at one refusal they file UNASSIGNED with the caller's spoken surgeon in the description and a coordinator assigns by hand — which already happens to 37 of 55 exit tickets (`ticket_events`, 2026-09-17). Four requests saved against three tickets routed by a person instead of the roster; the operator chose. **ONE LINE CHANGES:** `gateRefusalsSoFar(callSid, SURGERY_FILE_TOOL, 'surgeon') >= 1`. The first refusal is still the ask; a refusal for another field, an outage or a sentinel CallSid still spends nothing; a resolved surgeon or a redirect still keeps the flag off the wire. `surgeryUnassignedExit.test.ts` rewritten to the new threshold — 10 tests, including the 09-29 corpus chain (a date-of-birth refusal, then one surgeon refusal, then the exit) and the CONCURRENT pair asserted as the recorded residue it is, with a delayed mock so both attempts really are in flight together. **7 mutations, 7 caught:** the threshold back to two (3 fail — the ruling itself), the threshold at zero so the exit fires before the ask (7), the refusal never noted (4), the resolved-surgeon guard dropped (1), the surgery-queue guard dropped (1), a refusal for any field counted as the surgeon ask (1), and an outage counted as a refusal (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this is a ticket-path change on department 2, the queue whose provider fill went ~98% → 49% once. The numbers: surgery calls ending on a surgeon refusal with no ticket — **7 on 2026-09-29, target ≤3** (the concurrent pairs stay until the batch shape is fixed); department-2 tickets carrying `routingAskExhausted` should RISE by about 3 a day, and that is the accepted cost. The guards: **surgery tickets per substantive call must RISE** (59 of 86 on 09-29); department-2 tickets with `provider_id` NULL must not rise by more than the exit tickets do; and the `[surgery] SURGEON ASK ALREADY SPENT` console line now prints one refusal earlier, so a rise in it is the exit firing, not a defect |
| **v81** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v82**, stacked on v81 on the same branch, ABOVE `main`'s v80) | caller memory being a CANDIDATE. **Operator, 2026-09-30, on his own test call to the after-hours line (`CA32108e28bc5b21ca1514a126303d0671`, 13:31 UTC, old core): *"we are violating rule zero, it greeted me by name, it knew who I was soon as it answered the call. next step should have been to verify, but barge in broke it and it lost its footing, it gave my my appointment information and then wanted to verify."*** Read from the transcript and `tool_timeline`, not inferred: caller ID matched and the greeting used the first name; the v47 redaction DID withhold the appointment (the agent said *"I was able to pull up a record"* and read nothing); the barge-in cut the confirmation turn and the model resumed with two fields in one breath, which the caller answered *"Yes"*; the model then called `lookup_schedule(first_name, last_name, date_of_birth)` at 13:32:26 — BEFORE the caller had said a surname or a date — and got `found: false` in 2 ms; asked new-or-existing (RULE ZERO 2a forbids it on a recognised caller); took the date of birth; called the lookup again at 13:32:56 with the spoken date and a surname the caller had never said, `found: true`; read the appointment; and only then asked *"Am I speaking with <full name>?"*. **WHERE THE SURNAME AND THE DATE CAME FROM: the CALLER HISTORY section.** `callerMemoryService.buildContextForPrompt` wrote the previous call's `KNOWN PATIENT: <name> (DOB: …)` into the prompt — keyed on the PHONE, from `call_logs.patient_name || caller_name`, the second of which is Twilio's CNAM, the name on the phone bill — under *"Don't re-ask for information you already have (name, DOB)"*, plus the last provider and office seen and each previous call's summary. The v47 guard withheld the schedule; this section handed the model the two fields the guard exists to withhold, and the Grok body takes the same section (`${p.callerHistorySection}`), so the runtime carried the door too. **RULE ZERO step 2 and standing instruction 6, applied to memory: keyed on the calling number, it is a candidate, never an identity.** The section now carries only what is true of the NUMBER — how many times it has called, each recent call's OUTCOME (a ticket number at most; the summary is gone, because a previous caller's *"post-op pain"* read to a household member is the same leak), open tickets, a contact preference, the counts in `notes` — and says in as many words not to greet by name from it and not to skip the name or date-of-birth questions. No name, no date of birth, no provider, no office. One renderer, so the SIP core and the runtime get it together; the fields stay on the `CallerMemory` interface because `noIvrAgentV2` and `workflowPromptBuilder` (the dev lane) still read `patientName` — the same hazard on a lane that takes no traffic, noted and not touched. **WHAT THIS DOES NOT DO, stated:** validation is still prose. With memory closed the model has NO source for a surname or a date but the caller — pre-context and the redacted schedule section carry a first name only, and `lookup_schedule` needs all three to return anything — so on this call's shape the surname must now come from the caller's mouth; but a latch in the tool that refuses the full-record lookup until the date was HEARD in the caller's turn (the `spokenDob` device) is the mechanical form of the rule, and it is the next change if the operator wants it. And the new-or-existing question on a lookup miss still fires for a recognised caller in both prompt bodies (RULE ZERO 2a); on this call that miss was the memory artefact and cannot recur, but the rule is still the prompt's and not the code's. `src/services/callerMemoryIsACandidate.test.ts` (7, the renderer) and `src/agents/noIvrMemoryIsACandidate.test.ts` (10 — the REAL agent on both pipelines' metadata with a memory carrying every field the old section rendered, plus the wiring read from the source). **10 mutations, 10 caught:** the pre-v82 renderer restored byte for byte (12 fail — the defect itself), the name back (6), the date of birth back (3), the provider back (3), the office back (3), the previous call's summary back on the outcome line (5), the don't-re-ask guidance back (3), greet-by-name back (2), the agent inlining the name beside the section (5), and the Grok body dropping the section (3). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — no-ivr is on the OLD CORE until the repoint, so the marker dates the build the way v18, v41 and v74 do, and the runtime lane gets it at the same republish. The number: after-hours calls where an appointment is read before the caller has stated a surname and a date of birth — 1 known (the corpus call), target 0. The guards: after-hours tickets per substantive call must not fall (a first-time caller's prompt is unchanged, and a returning caller loses nothing a ticket needs); and callers greeted by first name from PRE-CONTEXT must not fall, because that path is untouched |
| **v82** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v83**, on its own branch ABOVE `main`'s v82) | the after-hours line STATING the office hours. **Operator, 2026-10-01, on his own test call to the after-hours line on its first business morning on the runtime (`CA2a1f76ebec78912a86ccd36ec8b72a94`, 13:25 UTC, Grok, 36 s): *"it couldn't even give me the time the office opens. I thought the runtime included the knowledgebase for all agents, these questions are a must."*** He asked when the Pasadena office opens and was told *"I don't want to give you the wrong time for that office — I can have someone confirm it when they're back in."* **THE KNOWLEDGE BASE WAS THERE.** The practice facts sit under `## Business Facts` on every runtime lane, the after-hours one included, and carry every office's address, phone, fax and hours (`knowledgePack.test.ts`, `promptShapeIsTheDocs.test.ts`, both green on the day). The model held the fact and was told not to say it: the Grok body's Conversation Flow said *"Do not state an exact per-office time — say …"* and the sentence the operator heard is that script verbatim. **THE RULE WAS MINE, NOT HIS.** It was written in early August into the legacy `escalate_to_human` tool DESCRIPTION (*"OFFICE HOURS — ANSWER THE COMMON QUESTION, WITHHOLD ONLY THE EXACT TIMES"*), reached git through a Replit deployment commit on 2026-09-03, and was carried into v76's rewrite as one of its rulings. Its own stated reason: the hardcoded table reads 8–5 for every office and *"disagrees with the practice's own live data, which has Encinitas closing at 4:30"*. It cites no operator decision, and the four queue lanes and PCP have stated the same table to callers every day without it. **THERE IS NO LIVE SOURCE OF OPENING HOURS, AND THE COLUMNS THAT LOOK LIKE ONE ARE NOT.** The operator asked for the Console's `si_locations.transfer_hours` / `transfer_days` to be populated since every office is the same; their column comments say they are the LIVE-TRANSFER window (*"NULL = service env default (08:00-17:00)"*, *"NULL = service env default (Mon-Fri)"*), NULL on all 112 rows including 46 surgery centres and 16 hospitals, and `lunch_window` beside them is the 12–1 no-transfer rule. Writing 8–5 onto them is a no-op for the clinics and a routing statement for a hospital, so they were left NULL and the reason given. Opening hours have no Console column today; the voice repo's table is the only source, and **the operator confirmed on 2026-10-01 that every office keeps the same hours: Monday to Friday, 8 to 5, closed 12 to 1.** **THE CHANGE.** Both after-hours bodies answer an hours question from the practice facts, the office's own opening and closing time included, and never hedge it; *"Every office is closed right now"* and *no ticket for an hours question* survive in both; the rulings map in `noIvrPromptShapeForGrok.test.ts` gains the ruling so neither body can drop it. The legacy prompt BODY also gains the practice's hours line, because its compact location table carries none (name, address, phone) — on the old core the model could never have stated a time whatever the rule said; the shared `buildCompactLocationReference` is untouched because answering-service reads it (standing instruction 5). `src/agents/noIvrAnswersOfficeHours.test.ts` — 5 tests on the REAL agent on both pipelines' metadata, plus the REAL lane registry for the bound runtime prompt (a helper proven alone proves the helper, failure mode 10), with a real office's hours line asserted in it. **5 mutations, 5 caught:** the Grok hedge restored (2 fail), the legacy tool description withholding again (1), the legacy body's hours line dropped (3), the pack dropping per-office hours (2), the Grok body silent on stating the time (3). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the after-hours line says on both pipelines. The numbers: after-hours calls whose agent says *"wrong time for that office"* — **1 known (the corpus call), target 0**; hours questions ending in a ticket — must stay 0. The guards: the time spoken must be the table's (8am–5pm, closed 12–1) — a different time is a hallucination, not a feature; and no-ivr tickets per substantive call must not fall. **FOLLOW-UP, the operator's:** a Console column for opening hours, which the pack can then read instead of the file — the one source of truth of standing instruction 14 |
| **v83** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v84**, stacked with **v85** in ONE PR, #342, ON `main` since it merged 2026-10-01 (`c086b3c`) — only v85 reaches a deployment, a build reading v84 does not exist) | the PersonID join reading the CONSOLE's schedule mirror. **Operator, 2026-10-01, twice in one afternoon: *"we should be getting the same mirror from the patient console that everyone uses"* and *"we do not use EDW schedules anymore."*** Standing instruction 14 has said it since 2026-08-31; this is the first voice reader to obey it. **WHAT FORCED IT:** the Hub's `Schedule` copy (2,161 MB, 17 indexes, 1.02M rows) was fed hourly by a LaunchAgent on the operator's Mac reading `EDW.dbo.vwScheduleAll` and upserting 1,000-row batches as one INSERT each — ~119 columns × 1,000 rows of bind values, ~900 KB of statement text, and because NULLs are not normalised every batch a NEW `pg_stat_statements` entry. Supabase's exporter reads that whole text file every minute. Measured after the 12:26 UTC crash that day: **16.3 MB of statement text in 108 minutes, 15.9 MB of it those 19 batches**; disk IO budget at 100% since ~Sep 26; exporter timeouts 60–90 an hour for 48 h, 0 after the crash wiped the file; Postgres's own buffered reads in the same window 1.6 GB (0.4 MB/s against a 39 MB/s baseline). Software-constrained, not hardware — the compute upgrade I recommended that morning is withdrawn; a Large instance would have been pinned too. The job is being replaced (Console → Hub, COPY + one fixed upsert, full reload with `--history drop`, no NoShow) by the agent that owns it; this build is the voice app's half. **WHAT MOVES:** `lookupByPersonId` and `appointmentsForPerson` read `si_appointment_facts` joined to `si_locations`, `si_providers` and `patients_master` over the Console pool `patientVerification` already holds (`OBS_CONSOLE_DATABASE_URL`, set in production since v10). The rows come back ALREADY IN THE HUB ROW SHAPE (`consoleScheduleFacts.toScheduleRow`), so `buildContext`, the office ladder, the surgeon rule (`SURGEON_DOCTOR_TYPES`), the equipment filter and the upcoming/past split run unchanged on either source. **THE LABELS ARE THE HUB'S, DELIBERATELY:** the Console says "Azul Vision San Bernardino" and "Paymohn Mahdavi, M.D.", the Hub and everything that routes on it says "San Bernardino" and "Paymohn Mahdavi, MD" (95% of locations and 70% of physicians differ, measured by the sync agent over 800k matched appointments). The crosswalk was learned from the Hub's own rows by `ApptID = appointment_id` — one sample per Console location — eight overrides (DTLA → Downtown LA, Mission Hlls → North Valley Eye, Willow → Long Beach Willow, Riverside Latham → Riverside, the screening sites → Mobile DRS, …) plus the brand-prefix strip, and the degree dots dropped from provider names. Hub `ProviderID` IS the Console's `provider_id` (checked on four surgeons), so `DoctorType` comes from the Console's provider type (Retina / MD / OD; a DO is typed MD, as the Hub did) and a slot with a resource and no provider is `Equipment`, so a machine is never the last physician. **STATUS IS THE OPERATOR'S RULE:** *"no show or kept is determined by an active status post appointment date"* — `is_cancelled` → Removed, else Active, and there is no NoShow on this path. **THE HUB COPY IS THE FALLBACK, LOUDLY:** when the pool is not configured, or the Console throws, the Hub query runs and `[ScheduleLookup] PersonID join: the CONSOLE did not answer, falling back to the Hub copy` is printed — that line is the counter, target 0 — and `(console)` / `(hub)` is in every join log line. **NOT IN THIS BUILD, stated:** the phone / name / date-of-birth STRING rungs of `lookup_patient` still search the Hub copy's patient strings (the Console mirror carries none, by design — they become `findByPhone` / `verifyPatient` on `patients_master` then this join, which is RULE ZERO in full and the next ship); `providerRoster` still reads the Hub copy at boot; `patientVerification`'s degraded fallback to the Hub copy stays. All three go when the Hub table goes. **BEFORE-ARM, ten days to 2026-09-30, runtime queue lanes, `duration >= 30`:** 2,838 substantive calls, 2,425 ran `lookup_patient`, **348 found nobody (14.4%)**; `lookup_patient` p50 250 ms, p95 2,038 ms, **86 events at the 6 s budget**; Optical Support agent tickets 391, **15 with no `location_id`**; Surgery Coordination 428, **8 with no `provider_id`**. `src/services/consoleScheduleFacts.test.ts` (16, the mapping) and `src/services/lookupJoinReadsTheConsole.test.ts` (6, through the REAL service and the REAL answers with both sources faked — which source answered, and what `buildContext` made of it). **10 mutations, 10 caught:** the join never reading the Console (3 fail), a Console failure no longer falling back, a cancelled fact reading Active, an override dropped from the crosswalk, the provider label keeping its dots (2), an equipment slot typed as its provider, the answers never reading the Console, the screening sites no longer folding under Mobile DRS, the brand prefix no longer stripped (2), and the answers counting a Removed appointment. Full services + tools suites 2,389 green; `tsc` clean. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes what the identity path carries onto the ticket on every lane. The numbers: `[ScheduleLookup] PersonID join (console)` must appear on recognised calls from the first call on this build; the fallback line must read 0; found-nobody (14.4%) must not rise. The guards: **filing rate per lane must not fall; optical tickets with no `location_id` must not rise above 15 of 391; surgery tickets with no `provider_id` must not rise above 8 of 428** — the labels are what those two routings read, and the crosswalk is the assumption to check rather than assert |
| **v84** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v85**, stacked on v84 in #342, ON `main` since it merged 2026-10-01 (`c086b3c`)) | the person base answering FIRST. **RULE ZERO step 1 in code, four months after it was written on the wall:** MATCH on `patients_master`, VALIDATE, JOIN on `PersonID`. Until this build the person base was the LAST rung of `lookupPatient` (v10, 2026-09-12), consulted only after three STRING searches of the Hub's appointment-book copy — phone, surname prefix, surname + date of birth — had missed, so a caller's identity was whatever the book's strings said and `patients_master` could only ever ADD a match. With the join reading the Console (v84) there was no reason left for the book to answer WHO. **BEFORE-ARM, ten days to 2026-09-30, runtime queue lanes, `lookup_patient` events by `matched_by` / `identity_is_certain`:** phone certain **1,921 events on 1,778 calls**; found nobody 838 / 411; phone uncertain 318 / 207; name+dob certain 182 / 178; name uncertain 79 / 60; person-base ambiguity 65 / 27; name+dob uncertain 9 / 7. The timeline cannot say which TABLE a phone match came from (both say `phone`); the console lines can, and the v61 `identity_write` key says whether the person base stored it. **WHAT CHANGES:** when `OBS_CONSOLE_DATABASE_URL` is set, `lookupPatient` asks the person base FIRST — `verifyPatient` on name + date of birth, then `findByPhone` — RETURNS its answer including AMBIGUITY (several people on the number, none picked, which is standing instruction 6 and is never traded for a string match), and falls through to the book's string rungs only when the person base finds nobody or is unreachable (the mirror breaker still stands down into the old behaviour). Without the secret the old order stands byte for byte, so the old-core agents that call `lookupByPhone` directly are untouched. **AND THE NARROWING MOVES ONE RUNG DOWN:** `findByPhone(phone, firstName)` narrows a shared number by the affirmed first name INSIDE the person base, with the same `narrow()` `verifyPatient` has always used — exactly one person on the number carrying that name is the match, none or several stays ambiguous — so v54's narrowing of the book's candidates (28 of 135 phone matches resolve to 2-3 people; the operator's own number to eight) now happens at the source. **A phone match from the person base is `identityUnconfirmed`** by design, so the recognised-caller flow (the greeting's question, the YES bullet calling `lookup_patient` with the first name) is what confirms it, and a filing on a bare phone candidate still refuses the chart date — nothing here promotes a candidate to an identity. `src/services/thePersonBaseAnswersFirst.test.ts` (8, the REAL service with the three book rungs and the join stubbed, the `lookupPersonBaseRung` pattern) and `src/services/findByPhoneNarrowsByFirstName.test.ts` (5, the real `findByPhone` over the faked pool). **8 mutations, 8 caught — the eighth only after a test was tightened, and that is the one to read:** `if (personBaseFirst) return this.emptyContext();` guards against asking the person base a SECOND time at the tail, and deleting it survived the first run because every test where the person base found nobody had the BOOK answer next, so the tail was never reached; the nobody-anywhere test now asserts one call. Also caught: the person base back to the last rung (5 fail), ambiguity discarded, nobody in the person base no longer trying the book (2), the first name not handed over, the new order forced onto the unconfigured old core (2), a name shared by two people still picking one (2), and the narrowing removed. Full services + tools suites green; `tsc` clean. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes WHO the identity path says is calling, on every runtime lane. The numbers: the console line `the PERSON BASE identified this caller` per substantive call (0 today on calls the book answered, target most recognised calls); found-nobody (348 of 2,425 lookups, 14.4%) must not rise; runtime `date_of_birth` refusals on callers the greeting addressed by name (26 on 2026-09-16) must not rise. The guards: **filing rate per lane must not fall; optical tickets with no `location_id` must not rise above 15 of 391; surgery tickets with no `provider_id` must not rise above 8 of 428; tickets carrying a date of birth that is not the patient's must stay 0** — the person base never picks between two people, and this build makes that refusal the first word rather than the last |
| **v85** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v86**, ON `main` since #343 merged 2026-10-01 (`655de97`)) | a UNIQUE caller-ID match being carried as CERTAIN once the person base answers first. **v85 WENT LIVE AT 17:21:57 UTC ON 2026-10-01 AND REINTRODUCED RULE ZERO'S OWN NAMED LOSS ON EVERY RUNTIME LANE AT ONCE, within its first minute, and it was my change.** The v10 person-base rung (PR #292) carried every phone match as `identityUnconfirmed: true` — Codex P1 on that PR: a caller-ID hit *"establishes only who OWNS the number"* — and that was harmless for nineteen days because the rung ran LAST, reached only after the Schedule's own phone rung (which carried a unique phone match as CERTAIN) had missed. v85 made it the FIRST rung and kept the flag, so from the first call every phone match on optical, surgery, tech, records and pcp read `identity_is_certain: false`: **3 of the first 3** (`CA15dbf665ee693132b138db1435a26318` tech, `CA8cc83d479eb603bbca90b8751bef64c6` tech, `CA4f3e821538bbe16aaa83bc19b92cb51b` surgery), and the surgery call did what the prompts tell a model holding that flag to do — asked the recognised caller for their name and their date of birth, and only then matched `name_and_dob`. **Nothing in #342's tests could see it:** `thePersonBaseAnswersFirst.test.ts` and `lookupJoinsOnPersonId.test.ts` both ASSERTED `identityUnconfirmed: true` on a phone match, so the suite pinned the defect as the design, and the PR body repeated it as a feature (*"A phone match from the person base is `identityUnconfirmed` by design"*). The after-arm's own guard names what it would have cost: `verifiedDobFor` refuses an uncertain entry (the DOB ask returns on ~180 recognised calls a day, the 1,778 phone-certain calls of the before-arm), `patient_found` on the call row returns to 0 (v51 writes only a certain entry), optical's `usualOfficeFor` and surgery's surgeon-from-record both lean on `certain`, so the two routing guards (15 of 391, 8 of 428) would have broken — all tickets still filing, one question later and routed by hand. **THE RULE RESTORED IS THE SCHEDULE RUNG'S, WHICH PRODUCTION RAN FOR MONTHS:** `findByPhone` answers `verified` ONLY when the number resolves to exactly ONE person — unique across all 915,843, or narrowed to one by the caller's affirmed first name (RULE ZERO step 2) — and several people is `ambiguous`, reported and never picked (standing instruction 6). A verified phone match is therefore carried `identityUnconfirmed: false`; `verifiedDobFor`'s name guard still refuses the stored date for a caller who gives a different name. The Codex P1 reasoning this reverses (a household phone, a reassigned number, a spoofed caller ID) applied equally to the Schedule rung the whole time and was never applied there; a person base unique across 915k rows is a STRONGER uniqueness than the book's window, not a weaker one. **Two assertions rewritten to the restored rule, not loosened**, with the reason in each. **NOT MEASURED IN PRODUCTION** beyond the three calls above, `docs/BACKEND_HANDOFF.md` applies — this is the identity path on every lane. The numbers: runtime `lookup_patient` events with `matched_by = phone` and `identity_is_certain = true` — **0 of 3 on v85, target the before-arm's share (1,921 of 2,425 events)**; runtime date-of-birth refusals on callers the greeting addressed by name — target the 09-16 level (26/day), not the v85 level; `patient_found` on runtime substantive rows — target the 09-28 share (282 of 582). The guards: **tickets carrying a date of birth that is not the patient's must stay 0** (the name guard is unchanged); a number shared by several people must still read ambiguous, never a pick; and the two routing guards above |
| **v86** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v87**, on its own branch ABOVE `main`'s v86) | one ticket per PCP call, and NO ticket for a caller who chooses the PCP queue. **OPERATOR, 2026-10-01: *"fix the PCP double ticket, if the caller chooses to go into the queue, do not create the ticket. i know that may differ from the record but update the md and let's get this squared away, if you choose the queue, we dont generate a ticket. As long as we are explaining this on the call as we should, we should be fine."*** **THE TWO HALVES TURNED OUT TO BE TWO DIFFERENT THINGS, AND THE DATA SAID SO BEFORE ANY CODE MOVED.** Measured the same evening over the PCP calls of 2026-09-17..10-01 in the Support Center (agent provenance, canonical SIDs): **61 of 793 calls with an agent ticket carried two or more, 72 surplus tickets — and NOT ONE was a queue transfer**, because the pcp-ticket endpoint upserts on `callSid`, so the pre-dial write, the post-dial write and the settle all land on one row. The double ticket has three shapes and one cause — every later filing call re-ran every routing door and could leave through a different one: **35 a PCP ticket then a Medical Records ticket** (`CA3eec2c7d`, `CAe3d1fbed`, `CA0bd7f87d`: the enrichment re-file v37 hands back asks the caller's TITLE after filing, and the title is what lets v16's professional records route identify the requester, so the SECOND `create_pcp_task` took the records door); **11 a PCP ticket then a create-ticket ticket in another department** (`CA60a4bd3b`); **15 the patient path filing again on every call** (`CA743da180`: ten VA tickets four seconds apart — that path POSTs create-ticket with no upsert and no idempotency key). **THREE CHANGES.** (1) **ONE CALL, ONE TICKET:** a server-owned `ticketFiled` latch on the director records the FIRST successful filing's door (`pcp` or `create_ticket`, first write wins — the model can neither set nor clear it, the v17 reason). After it, `create_pcp_task` and `handle_patient_medical_records_request` skip every routing door: a `pcp` filing is re-POSTed to the pcp endpoint, which enriches the same row (what v37 always said it did), and a `create_ticket` filing POSTs NOTHING and hands back its number with `alreadyFiled: true` — on the timeline allow-list, so the guard firing is a count. (2) **THE TITLE BEFORE FILING ON A RECORDS REQUEST:** `callerRole` leaves `ENRICHMENT_AFTER_FILING` for `patient_medical_records_request` only, so the one ticket reaches Medical Records where the 2026-09-12/14 rulings say records go, instead of PCP Support. Without it the latch alone would have kept all 35 in department 18, halving PCP's Medical Records routing (30 calls reached it as a single ticket in the same window). The email stays deferred and is never asked on that purpose (SATISFIED_BY); a caller who hangs up on the title is still filed by the v69 teardown floor, because purpose and name are in hand. (3) **NO TICKET ON AN ACCEPTED QUEUE CHOICE:** no pre-dial write, no post-dial write. **THIS RESTORES THE 2026-09-13 RULE THAT 09-15 REVERSED (the v29 row), AND THE CALLER-FACING WORDS NEVER CHANGED:** `QUEUE_CHOICE_WARNING` ("nothing we've gone over transfers with you") was written for the no-ticket rule, and the prompt still read *"Yes means the queue, no ticket and nothing kept"* the whole time — so the code moves back into line with what the caller hears. **ONE CASE STILL FILES, AND IT KEEPS A SENTENCE TRUE RATHER THAN BENDING THE RULING:** when the queue never picks up, `blindTransferDialResult` answers Twilio with `BLIND_TRANSFER_NO_ANSWER` — *"I have your request recorded and the team will follow up"* — on a leg the agent no longer holds, so the accepted path's settle callback files ONE ticket then (`queueChoiceOwesATicket`: not on a bridge, not on `CANCELED`, which is the caller leaving — "if they drop off, their record is lost, their choice"). **Measured before choosing it: of 425 PCP transfer tickets since 09-17, 405 settled `QUEUE_ANSWERED` and 20 never settled — the ACD answers essentially every dial — so this files close to never.** **AND THE REDIRECT'S OWN LINE HAD TO CHANGE TOO:** the approved `BLIND_TRANSFER_WARNING` ends *"I've taken your details down, so they have them either way"*, false with nothing filed; `requestOnRecord: false` on the side channel makes the transport speak the operator's first two clauses and stop (`BLIND_TRANSFER_WARNING_UNRECORDED` — a clause removed, no copy added). A caller who filed EARLIER on the call and then chose the queue keeps that ticket, and the warning may still say so (`requestOnRecord` reads the earlier filing too). A redirect that FAILS still files the fallback, because the caller is still on the line, not in the queue. **THE INSTRUMENT COST, STATED:** accepted transfers are invisible in `tickets.pcp_handoff_*` again — count them from `call_logs.runtime_outcome = 'transferred'` on the pcp lane and from the `[PCP] handed to the queue on the caller's own choice` console line, never from tickets, where they will read as a fall of roughly 30 a day. **NOT COVERED, and small:** a `handoff_to_pcp` write after a create-ticket filing still POSTs the pcp endpoint; whether that endpoint's callSid upsert lands on the VA row (`CA14c234c8`'s handoff answered with the VA number, which suggests it does) is not established here. `src/pcp/oneCallOneTicket.test.ts` (14), `queueIsAChoice.test.ts` (the accepted describe rewritten, 7, driving the agent's own settle callback off the side channel rather than reading its source), `blindTransfer.test.ts` (+3), `pcpBlindTransferWiring.test.ts` (+2, the runtime link), `toolTimeline.test.ts` (+1); `queueDialReachesTheTicket.test.ts`'s source pin rewritten to the two registrations. **22 mutations, 22 caught — 17 on the first run, and the five survivors were real gaps closed by new tests:** first-write-wins on the latch, the Hub door skipped when enriching, the Medical Records and Hub filings latching, and `alreadyFiled` on the allow-list. Full suite 5,394 green before those five tests. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes the PCP ticket path. The numbers: **PCP calls with two or more agent tickets — 61 of 793 over 2026-09-17..10-01, target 0**; PCP records requests whose only ticket is in Medical Records — 30 in that window, target ~65 (the 35 doubles folding into it); `alreadyFiled` events per day, which is how often the latch stopped a second POST; and PCP tickets at `DIALING`, which should fall to the not-established and never-asked paths. The guards: **PCP requests filing NOWHERE must not rise** (`sweepPcpUnfiledCall` is the floor behind the title question); **department-16 tickets from PCP must not fall**; and **PCP tickets per substantive call WILL fall by the accepted-transfer share** — that is the ruling, not a regression, and anyone reading that number must subtract `runtime_outcome = 'transferred'` first |
| **v87** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v88**, stacked on v87 on #344, ABOVE `main`'s v86 — v87 and v88 ship together and only v88 reaches a deployment) | the on-call TEXT before an after-hours transfer rings, and the URGENT TICKET after one rings out. **OPERATOR, 2026-10-02 00:2x UTC: *"I just got a call on the after hours line and I was waiting for the sms and it never arrived. It was an urgent call, i need those alert sms to let me know who is calling and why."*** **THE CORPUS CALL IS `CA3a8fd9cc0f2f79eae30f5785ceba6d22`** (2026-10-02 00:15 UTC, 64 s), the first urgent escalation the runtime dialled after the after-hours number ending 1543 moved here at ~00:23 UTC on 2026-10-01: `escalate_to_human` was sanctioned, the warm transfer rang the clinical destination for **40 seconds with no text in front of it**, `NO_ANSWER`, the caller hung up while the agent offered to take a message, and **no ticket of any provenance exists**. **BOTH HALVES WERE THE OLD CORE'S, AND NEITHER WAS EVER PORTED:** `sendUrgentTransferSms` (`voiceAgentRoutes.ts`, the *"📞 INCOMING TRANSFER"* text to `URGENT_NOTIFICATION_NUMBER`, fire-and-forget, sent before `addHumanAgent` dials since 2026-08-06) and `fileUrgentHandoffFallbackTicket` (an urgent After Hours ticket on a ring-out, since July). `grep src/runtime` for either finds nothing — the lanes that took runtime traffic before 2026-10-01 have no clinical transfer (standing instruction 9), so nothing exercised the gap until the after-hours line moved, and the old core's no-ivr row in this file never listed the alert as a pipeline duty. **ONE COPY OF THE WORDS:** `src/services/urgentTransferAlert.ts` holds the text builder and the ticket payload, moved verbatim, and the old core now reads them too, so the operator reads the same text whichever pipeline served the call. `src/runtime/urgentTransferAlerts.ts` sends them with the runtime's env and a lazy Twilio client; `runtimeTransfer.ts` calls the text after the policy check and BEFORE the mode branch (only when the policy allowed a dial, never for PCP — the old core's two rules), and the ticket from `settle()` after a failed dial that was not `UNAVAILABLE` (nothing rang) and not PCP (it files its own). The per-call claim lock in `SyncAgentService` makes the fallback and a later `create_ticket` one ticket, as on the old core. **NOT CHANGED, AND OPEN FOR WAYNE: WHICH PHONE RINGS.** The old core sends a no-ivr escalation to `NO_IVR_HUMAN_AGENT_NUMBER` (`resolveClinicalTransferNumber`; `call_logs.human_agent_number` shows the number ending 7471 on 50 old-core no-ivr transfers to 2026-09-30, and the number ending 9400 on 51 before 2026-08-30); the runtime dials `HUMAN_AGENT_NUMBER` for every clinical lane, and both runtime no-ivr transfers rang the number ending 9400. Parity is one line, and who is woken at night is the operator's to say, not a test's. `src/runtime/urgentTransferAlerts.test.ts` drives the REAL `createRuntimeTransfer` with recording seams: text-then-dial order, no text on a refused dial or for PCP, the ticket on a ring-out carrying the escalation read before the attempt's `finally` clears it, no ticket on an answered, refused or PCP dial, the production sender's recipient and words, its skip and its swallowed failure, and the old core reading the shared builders with no second copy in code. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies. The numbers: runtime no-ivr transfers with a `[runtime-xfer] ✓ urgent SMS sent before the dial` line — 0 of 2 before this build, target all of them; and runtime no-ivr transfers with `transfer_outcome.status` other than accepted and no ticket on the SID — 2 of 2 before this build (`CA475654e4cfbf7e97f89c82d72f058f5e` on 2026-09-28 and the corpus call), target 0. The guard: two tickets on one no-ivr call must not rise — the claim lock is the mechanism |
| **v88** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v89**, ON `main` since #345 merged 2026-10-02 (`97ca3c9`)) | the after-hours line routing what the operator ruled, and the urgent ring-out ticket reaching After Hours. **OPERATOR, 2026-10-02, answering the decisions on the after-hours review (artifact *After-Hours Runtime Review*): *"1, no, it should record an urgent ticket in after hours. 3, no, leave as is, same day tickets are worked in the after hours department."*** D1 asked whether a post-op patient whose medication never reached the pharmacy rings the on-call provider; D3, whether the line *"I can make sure the on-call doctor receives your message"* changes (it does not, by ruling); D4, who works same-day after-hours tickets. **MEASURED FIRST, every no-ivr runtime call since the cutover** (47 substantive through 2026-10-02 00:46 UTC, 21 filed): the corpus post-op case is `CAa2e451aba415a1deb97a72374e3e1784` and `CAb475175ff010615e82b9f6799c0fb114` — a patient whose post-op steroid drops were not at the pharmacy the evening of their procedure, two medium tickets, one in Technicians Support, both unassigned, and on the second call the agent said the on-call doctor would get the message. And **7 of the 8 tickets filed 6–8 AM Pacific on 2026-10-01 were same-day** (confirming 8:00, running late for 8:00, moving 9:20, cancelling 2:30, confirming 2:00, eye pain wanting to be seen today, a patient outside a closed building for a 7:15 surgery), every one medium, every one routed to the HVA Hub or Surgery Coordination, first touched by staff at 8:17–8:26 — after both 8:00 appointments; VA-66656, the patient at the door, had no human touch at all. **NO TICKETING-APP CHANGE:** `/submit-ticket` already takes `departmentId` (validated, then it WINS over the derivation, `resolveSuppliedDepartment`) and `priority`; this repo had simply never sent a department, by design (`noIvrAfterHoursHint.test.ts` asserted none) — that guard is narrowed, not dropped: a department may be named ONLY from `route.departmentId`, and the route answers `default` for every call the operator has not ruled on. **THE DECISION LIVES IN ONE PURE MODULE**, `src/services/afterHoursRouting.ts`: post-op prescription (the model's new `post_op_prescription` flag, or the words: the operation already happened AND a medication is the subject) → department 8, priority `urgent`, hint 35/171 *Post-Procedure Questions* so hint and department agree; same-day (the model's `appointment_today` flag, today-plus-a-visit or running-late words, or a CONFIRMED record with an appointment LATER today) → department 8, no priority of its own (none was ruled); **same-day never after 5 PM Pacific**, because on an evening call "today" is a day that is over. A phone candidate's appointments are not the caller's and never route anything. **THE GATE MATCHES THE RULING:** `post-op` and `after surgery` are ACUTE terms, so an escalation about missing post-op drops would have RUNG; `judgeEscalation` now refuses it with code `post_op_medication` when the operation, a medication and NO symptom word are all present — any symptom (pain, vision, redness, swelling, discharge, Spanish too) steps aside and the acute check rings as before, and a clinician calling about a post-op patient is still case 1. The v80 refusal files the same urgent After Hours ticket, and its result leaves the door open for a NEW symptom described afterwards. **A BUG CAUGHT BEFORE IT SHIPPED, by the real-agent test:** the flag was first named `post_op_medication`, and `toolDirection.gateBeforeExecution` blocks ANY `create_ticket` whose arguments contain *medication* or *refill* until a drug is named — so the flag's own NAME would have blocked every post-op ticket, the corpus caller among them (*"we don't know the name"*). Renamed, and a post-op prescription ticket is exempt from the drug-name check. **AND THE URGENT RING-OUT TICKET WAS NOT REACHING AFTER HOURS — v88's own claim was false.** `urgentFallbackTicketParams` sent `config/afterHoursTicketing`'s `AFTER_HOURS_DEPARTMENT_ID`, which is **3, Technicians Support**, with the `sudden_vision_loss` mapping — request type 12 / reason 53, a RETINAL SURGERY pair owned by department 2. Measured in the Support Center: of the 17 *URGENT TRANSFER NOT ANSWERED* / *Transfer dial failed* tickets since 2026-05-12, **14 landed in Technicians Support**, 2 in the HVA Hub, 1 in After Hours. It now sends department 8, type 34, reason 159 *Transferred to On-Call Provider*, from `tools/afterHoursTaxonomy` (whose constant is the right one); the config constant is left alone because other callers pair it with that config's own types, and `urgentTransferAlerts.test.ts` had pinned the defect (`departmentId: AFTER_HOURS_DEPARTMENT_ID`) and now pins 8/34/159. **WHAT IS NOT CHANGED:** the D3 line (ruling), the escalation cases, every other night call's routing, and priority on same-day tickets. `src/services/afterHoursRouting.test.ts` (14), `src/services/postOpMedicationIsNotARing.test.ts` (6), `src/agents/noIvrAfterHoursRouting.test.ts` (10, the REAL agent), plus the rewritten guards. **16 mutations, 16 caught:** the route ignoring the flag (3 fail), ignoring the words (2), the evening guard removed (2), the record backstop removed (2), the record's time ignored (1), the department not sent (6), the priority not sent (3), a candidate's record counting (1), the gate carve-out removed (3), its symptom guard removed (1), the refusal filing not routed (1), the drug-name exemption removed (1), the fallback back to department 3 (1), the server's clock instead of Pacific (5), the staff note dropped (2), the fallback back to the surgery type (1). Full suite 5,444. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes the after-hours ticket path. The numbers: after-hours tickets in department 8 whose description is same-day, and first staff touch on them against the appointment time — the before-arm is 2026-10-01's 7 morning tickets, first touched 8:17–8:26; post-op prescription tickets at `urgent` in department 8 — 0 before (the corpus pair were medium, departments 3 and 8); urgent ring-out tickets in department 8 — 1 of 17 before, target all. The console lines `[AFTER-HOURS ROUTE] same_day|post_op_medication` count the route. The guards: **after-hours tickets per substantive call must not fall** (the drug-name exemption is the one path that could have moved it the wrong way, and it moves it the right way); **escalations sanctioned for real symptoms must not fall** — a post-op caller who names a symptom still rings; and **department-8 tickets that are neither same-day nor post-op must not rise**, because the route must stay a two-kind exception and never become the night's classifier **CODEX ROUND 1 ON #345 (09:17 UTC, on `6e9d5b1`, triggered by the ready-mark) — two P2s taken, a P1 declined with its number, on `4fb88e1`.** (1) `POST_OP_PATTERN` read *"had surgery scheduled for tomorrow"* as a completed operation, against this module's own rule that a future operation is a different request; a lookahead on the words straight after the operation now rejects scheduled / booked / tomorrow / next / upcoming, and a completed operation with a follow-up scheduled LATER in the sentence still counts. (2) The confirmed record's later-today appointment routed ANY request to department 8 — a refill or a billing question from a patient who happens to be due that afternoon — when the record says WHEN they are due and never WHAT they are calling about; it now backs up only a request already about an appointment: an appointment category (the call site passes `appointmentIntent` from `CATEGORY_TO_REQUEST_TYPE`) or the request's own appointment words. (3) DECLINED: symptom words in a medication sense (*"pressure drops"*, *"can't see my prescription"*) keep the gate's carve-out from firing so the call rings as before — real, and **0 of 172 no-ivr `escalate_to_human` reasons since 2026-08-01 match post-op plus a medication** (2 mention an operation and a medication in any form); the corpus pair went through `create_ticket`, which never reads `SYMPTOM_PATTERN`, and any medication-sense exclusion list can only err toward refusing a real post-op symptom, the dangerous direction. Tests 14 → 17 and 10 → 12; **5 mutations, 5 caught** (the lookahead removed, the record gate dropped — 2 fail, the category not wired at the call site, the appointment words ignored, the intent flag ignored — 2). Full suite green. |
| **v89** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v90**, ON `main` since #346 merged 2026-10-03 (`23ffe2a`)) | a PCP teardown floor that can FILE on this runtime. **v69 (2026-09-24) wired `sweepPcpUnfiledCall` into the runtime's teardown, and it has never filed a ticket.** Read from production, not inferred: since v69, **0 POSTs** in `voice_agent_api_logs` have carried either literal only that function writes (`caller_hung_up_before_completion`, `call_not_classified`), and the deployment log for **2026-10-02 holds 13 lines reading `[PCP] SWEEP: … has intake but no metadata — cannot build a payload`** (16:09–22:56 UTC). Each matches, to within 1–10 seconds of hangup, one PCP call that recorded a purpose with `record_pcp_intake` and hung up 25–171 seconds in. 12 were substantive, none has a ticket of any provenance, and 6 were scheduling or records requests. **THE CAUSE IS THE v77 OUTAGE'S MECHANISM IN A SECOND MODULE, AND THIS TIME NOTHING THREW.** `pcpFloor.ts` loaded the sweep with `await import("../agents/pcpAgent")`. The agent that served the call was built from `src/config/agents.ts`, which imports pcpAgent STATICALLY and is itself reached through laneRegistry's one lazy `import("../config/agents")`. On Node 20, the version Replit runs, the floor's dynamic import evaluated pcpAgent a SECOND time. The second copy had an EMPTY `pcpCallMetadata` map, while the director state it imports was shared. So the sweep passed its admission test on the intake, found no metadata, and returned, on every call. **Reproduced before fixing**, inside the repo so the probe inherits the package's module type as `npx tsx` does. The factory from `defaultLaneSource()` against the module from the floor's import is the same object on Node 22.22.2 and a different one on Node 20.20.2. The agent was built through the registry and its intake seeded through its own `record_pcp_intake` tool, so the state landed in the copy the agent really uses. The old path then printed production's exact `has intake but no metadata` line on Node 20. The new path printed `ended with no disposition — filing what we have` and stopped only at `TICKETING_SYSTEM_URL not configured`, i.e. at the POST. Every test and CI run is on Node 22, which is why v69's own suite was green and its runtime pin passed with a stub. **THE FIX IS NOT A SECOND IMPORT STYLE, IT IS NO IMPORT.** A static import in `pcpFloor.ts` would also have worked on Node 20. It would also have pulled the whole agent tree into `voiceRuntime`'s import, which is the lazy boundary `defaultLaneSource` exists for. Instead the sweep TRAVELS WITH THE FACTORY. `src/config/agents.ts` registers `teardownSweep: sweepPcpUnfiledCall` on the pcp entry, from the same import statement as `createPcpAgent`; `LaneConfig`/`AgentConfig` gain the optional field. The runtime calls `runPcpFloor(record, { source: laneSource })` with the SAME lane source it resolved the call's agent from. One import statement is one module evaluation whatever the loader does, so the metadata the factory wrote is the metadata the sweep reads, by construction. `pcpFloor.ts` now imports only a type. With no source and no injected sweep it logs `[PCP FLOOR] the pcp lane registers no teardownSweep` and returns: a loud wiring defect instead of v69's silence. **THE GUARD IS WIDENED**, because v78's only refused dynamic imports of modules that call `registerTool`, and pcpAgent does not. `toolModulesAreImportedOneWay.test.ts` now also refuses any `import()` of a module under `src/agents` from a runtime source, with a non-vacuity check that the scanner does see laneRegistry's own lazy import. **STILL OPEN AND NOT TOUCHED HERE:** the runtime still supplies no `getTranscript` to the PCP lane, so the floor's `unclassified` admission cannot fire and its ticket carries no `transcript` field (the post-call sync adds it). All 12 of 10-02's calls carried a purpose, so that costs nothing on the measured population. The same dual-loader shape exists wherever an agent dynamic-imports a stateful service the runtime also loads statically (`syncAgentService`'s per-call claim is the one to read first). That is an audit, not this fix. `pcpFloor.test.ts` (four wiring tests rewritten to the new design, not loosened: no `import()` of an agent; the sweep and the factory in ONE import statement; the source is read and keyed on the CallSid; a missing sweep or source is loud and does not throw). `voiceRuntime.test.ts` +1 runs the runtime's REAL floor default and asserts the pcp lane's own `teardownSweep` receives the CallSid; every other test there replaces the floor with a stub, which is how the v69 pin passed. `toolModulesAreImportedOneWay.test.ts` +2. **8 mutations, 8 caught:** the registry dropping `teardownSweep` (1 fail), the floor back to its own dynamic import (5), the runtime default losing the source (2), the floor ignoring the source (3), the sweep keyed on the slug (3), the sweep imported in a second statement (1), a missing sweep throwing (1), and the floor reading another lane's registration (3). Full suite 5,455. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies, because this files tickets. The numbers: `has intake but no metadata` lines in the deployment log, **13 on 2026-10-02, target 0**; POSTs carrying `caller_hung_up_before_completion`, **0 all-time, target about a dozen a day**; PCP substantive calls with no ticket of any provenance and no queue transfer, 26 on 2026-10-02, which should fall by about 12. The guards: **PCP tickets a staffer closes as junk must not rise materially** (the azul 2026-07-28 shape); **two tickets on one PCP call SID must stay 0** (v87's number, 0 on 2026-10-02, and the floor runs only when no disposition was recorded); and department-16 and department-9 tickets from PCP must not jump, since a floor-filed records or scheduling request routes the way the in-call filing would have. |
| **v90** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v91**, ON `main` since #347 merged 2026-10-07 (`96151a1`)) | the session stall reconnects, and a setup that never starts files a ticket. **xAI accepts the WebSocket (HTTP 101, ~0.2 s) and sometimes never sends `session.created`.** The runtime used to wait the 15 s setup deadline, then tear the call down: the caller heard nothing and no ticket of any provenance existed. Production, 2026-10-05/06: ~1 in 18 connections (worst ~1 in 7). Ninety off-production probes of the same model and session setup hung 5 of 90 for 20 s with no error and no close, so the stall is on their side. **`connectWithFirstEventRetry` waits 2500 ms for the FIRST event** (`RUNTIME_FIRST_EVENT_TIMEOUT_MS`, clamp 1000–10000), detaches the stalled socket so its later close cannot end the call, and opens a new one. Two retries after the first attempt — three attempts (`RUNTIME_CONNECT_RETRIES`, clamp 0–4). A handshake that never upgrades is bounded at 5000 ms (`RUNTIME_WS_HANDSHAKE_TIMEOUT_MS`, clamp 2000–15000). Inbound frames buffer until `commitBuffered` after the session binds `onMessage`, so a late-commit first event is not dropped. **WHAT GETS LOGGED, PHI-free:** the HTTP 101 upgrade headers `x-trace-id` and `CF-RAY` on each attempt (`[PROVIDER CONNECT] attempt n/N … x-trace-id=… cf-ray=…`), and `[SESSION] created session=… conversation=…` once a session actually starts. Never a name, a number or a transcript. **WHEN EVERY RETRY STALLS, `runSetupFailureFloor` files one ticket** in the lane's department — optical Other 66/536, stand-in name Unnamed/Caller, idempotency `call-<sid>-setup-failure`, priority high, the sweep's callback-only description, staff note pointing at caller ID — and the TwiML speaks the existing technical-trouble apology. It files only on `provider_failure` + `agentTurns === 0` + a known department + a callback number. **CODEX P1 ON #347: the floor is not hostage to the call-row write.** The no-bridge path used to chain `persistCall(...).then(() => fileSetupFailure(...))`, so a rejected write skipped the ticket and a hung write waited forever — the outage the floor exists to cover. Persist is now bounded the same way as bridge teardown (`withinOrNull` + `PERSIST_BEFORE_SWEEP_MS`), and `fileSetupFailure` always runs. Same idempotency key `call-<sid>-setup-failure`. Two more runtime tests: persist rejects, persist never settles; both still file exactly one ticket and speak the apology. Defaults work; no new secret is required. `src/runtime/providerConnect.test.ts`, `src/runtime/setupFailureFloor.test.ts`, and four runtime tests: a first-event stall that succeeds on the retry, every retry exhausted then the optical ticket plus the apology, and the two persist-failure arms. **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes when a call may START and when a silent drop files. The numbers: runtime `provider_failure` with zero agent turns and no ticket — target 0 from the first call on this build; `[PROVIDER CONNECT] first-event stall` lines per day, which is how often a socket was discarded; and setup-failure tickets (`idempotencyKey` ending `-setup-failure`). The guards: **filing rate per lane must not fall**; **two tickets on one SID must stay 0** except this new key, which cannot collide with a later real filing; and **`provider_failure` with a ticket should RISE** — that is the floor working, not a defect. |
| **v91** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v92**, stacked with **v93** in ONE PR, #348, ABOVE `main`'s v91 (`96151a1`) — only v93 reaches a deployment, a build reading v92 does not exist) | the TEARDOWN filers taking the app's unassigned exit on optical and surgery, and the setup floor declining a caller who never waited. **The request sweep (`requestSweep.ts` / `sweepRunner.ts`) and the v91 setup-failure floor both file AFTER the caller has gone, and on the two queues that route by a field the call must supply create-ticket refused them for that field** — *"Missing required information: office"* on optical (1) and *"…: surgeon"* on surgery (2). That refusal is a QUESTION for a caller on the line; at teardown there is nobody to put it to, so it was final, and the request the floor exists to save was lost on its last step. **MEASURED in `voice_agent_api_logs`, 2026-09-28..10-08, sweep-shaped POSTs (priority high, the department's Other reason, no date of birth, a staff note): 36 optical and 51 surgery swept requests REFUSED HTTP 400, one POST per call, against 2 and 3 accepted** (the app derived the field from the patient's record on those). **Tech (3) and records (16), which route by nothing the call supplies, filed every swept request in the same window — 101 and 88.** The floor's one optical filing (`CA8460d0f3b0b80955da57d46a35a84c18`, 2026-10-08, 14 s on the line) was refused for `office` too. **THE FIX IS THE APP'S OWN EXIT, NOT A NEW RULE:** `routingAskExhausted` is the operator's 2026-09-02 unassigned exit, honoured by the ticketing app for departments 1 and 2 (`DEPARTMENTS_WITH_UNASSIGNED_EXIT`), and both in-call filing tools already send it once their own ask is spent. At teardown the ask is exhausted by definition. **AND IT CANNOT COST A TICKET ITS ROUTING:** read from the app's `routing-gate.ts` on `main`, the DERIVE step (office from the patient's most attended office, surgeon from the schedule) runs BEFORE the exit is consulted, so the flag only changes a refusal into an unassigned ticket — the five swept tickets that were routed by derivation stay routed. **ONE SET, TWO READERS:** `TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS` (`{1, 2}`) lives in `requestSweep.ts` and the floor imports it, because two copies of a department list is the `explicitAsk.ts` drift. Never sent on any other department, where it would claim an ask that did not happen. **BESIDE IT, THE FLOOR'S FIRST-EVENT GUARD:** a setup-failure ticket is no longer filed for a caller who HUNG UP inside the call's configured first-event wait (`RUNTIME_FIRST_EVENT_TIMEOUT_MS`, 2.5 s by default) — inside that even a healthy session has not been declared late, so that caller left rather than was failed. **3 of the floor's 4 tickets in its first 30 days were after-hours callers on the line 1–2 s** (VA-68899, VA-68900, VA-69923: callback tickets with a stand-in name to somebody who never waited); the 14 s optical caller still files. **IT KEYS ON THE HANGUP, NOT ON THE CALL'S LENGTH, and the first draft got that wrong twice — the existing runtime suite is what caught it.** Length alone cannot tell a caller who left from a setup WE failed fast (an agent tree that throws is short too, and that caller is still on the line hearing the apology, so they keep their ticket). And the record's own end time is when the runtime NOTICED, which for a hangup during the wait is the END of the wait — the retry checks for an abort between attempts — so a 1 s caller reads as one who waited. The runtime now stamps `socketGoneAtMs` when the caller's socket closes and hands the floor `callerLeftAfterMs` plus the wait the call was actually configured with; no hangup, or no context (the bridge-teardown path), files. **WHAT IS NOT CHANGED, STATED:** the app's unassigned-exit advisory says *"the caller was asked and could not supply one"*, which is not literally true of a hangup — the ticket's staff note (`Recovered at teardown` / `PROVIDER SETUP FAILED`) says what happened, and the advisory wording is the app's; and the sweep still sends no `locationId` or `providerId` from a verified record, leaving that to the app's derivation. `src/runtime/teardownTakesTheUnassignedExit.test.ts` (12, the REAL runner and the REAL floor with `createTicketDurable` mocked at its boundary — the payload that leaves, failure mode 10) `setupFailureFloor.test.ts` (+8, including a 1 ms fast failure on our side that still files), and `voiceRuntime.test.ts` (+2 on the REAL runtime: a caller who hangs up 40 ms into a 400 ms wait gets no ticket; one who hangs up after the first attempt has stalled gets one, carrying the exit flag). **14 mutations, 14 caught — 13 on the first run, and the survivor was failure mode 10 in its plainest form:** the runtime's default `fileSetupFailure` WRAPPED the floor, a wrapper that dropped the context passed every behavioural test because the runtime suite's harness injects its own `fileSetupFailure`. Fixed in the structure rather than with another test: the floor's signature is now `(record, ctx, filer)`, the runtime passes it unwrapped, and a pin goes red if a wrapper returns. Caught: the sweep never setting the flag (2 fail), setting it on every department (2), the runner dropping it (2), the set widened to tech (3), the floor never setting it (3), the floor's filer dropping it (2), the guard removed (7), the guard ignoring the configured wait (2), the boundary moved to `<=` (1), the runtime never stamping the hangup (1), the runtime measuring when it NOTICED instead of when the caller left (1), the runtime dropping the wait (1), the default wrapped (1), and the persist helper dropping the context (1). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this files tickets on departments 1 and 2. The numbers: sweep-shaped optical and surgery POSTs refused HTTP 400 — **87 over 2026-09-28..10-08 (~8 a business day), target 0**; and `[RoutingGate] UNASSIGNED EXIT` lines on the app, which rise by about that much. The guards: **optical tickets with no `location_id` and surgery tickets with no `provider_id` WILL rise by the recovered count** — that is these requests existing at all, not routing getting worse, so read them net of the sweep's priority-high Other-reason tickets; tickets the sweep files on tech and records must not change; and setup-floor tickets for callers who stayed past the wait must not fall — the guard removes only hangups inside it |
| **v92** or earlier — NOT the date (v13 and v57 were withdrawn; v59, v60, v63, v65 and v66 are retired; this ship is **v93**, stacked on v92 in #348, ABOVE `main`'s v91) | the after-hours URGENT TRANSFER RECORD filing at all, and filing in After Hours. **Operator mandate 2026-07-25, in the code beside it: *"every urgent outcome leaves a record ticket pinned to the After Hours queue."*** On a CONNECTED transfer `escalate_to_human` files that record fire-and-forget beside the handoff, through `/submit-ticket`, and **MEASURED in `voice_agent_api_logs`, 2026-08-11..10-09, it failed two ways on 31 of 95 connected transfers.** (1) **22 refused HTTP 400 *"Could not parse patient name"*** — with no patient name recorded the payload fell back to `'Unknown Caller'`, and the app's `parseFullName` refuses any name whose every word is on `INVALID_NAME_PATTERNS`, which holds BOTH `unknown` and `caller`. Every one of the 22 was a caller who WAS connected (21 found in `call_logs`, all `transferred_to_human`; the 4 on the runtime read `CONNECTED`), **and none has a ticket of any provenance** — the corpus shape is a clinician calling about a patient whose name the model never recorded (`CAf746549c0b24b252a761959031c097f4`, `CA62977ba64183d6a3227b0c22a3be45e6`, `CA7ae28b7165f09fc1a7652c0428f993d8`). (2) **9 refused *"Missing required information: surgeon"*** — the payload named NO department, so the app classified the description (a post-op patient reads as Surgery) and department 2's contract demanded a surgeon. And **of the 54 records that filed and could be traced, only 32 landed in After Hours** — 9 Technicians, 5 HVA Hub, 5 Surgery, one each Optical, OCS Hub and PCP. The comment said "pinned to the After Hours queue"; the payload never named it, the v89 shape (the ring-out fallback was sending department 3) one path over. **TWO CHANGES.** The record names `departmentId: 8`, which `resolveSuppliedDepartment` takes over the app's derivation, and the surgeon gate is department 2's alone (`voice-agent-ticket-service.ts`, read on `main`). **No reason hint**: the app refuses 159 *Transferred to On-Call Provider* as a hint by design (`DISPOSITION_REASON_IDS` — a disposition, not a request reason), so the description still picks the reason, and an off-department classification falls back to department 8's catch-all. And the name is `nameOrStandIn` (`src/services/standInName.ts`): what the caller gave, or — when it is blank or every word is an app placeholder, a model's `"Unknown"` included — **`Unnamed Caller`, the stand-in the v91 setup floor already sends**, with `STAND_IN_NAME_NOTE` in `additionalDetails` so a staffer knows it is not a name. **ONE STAND-IN ACROSS THE FLEET:** the floor now imports the same constants. `APP_PLACEHOLDER_NAME_WORDS` is a PINNED COPY of the app's list (read 2026-10-09), and the stand-in is tested against it — if the app ever adds `unnamed`, that copy goes red first. **The refused-escalation filing (v80) takes the stand-in too** — it sent the same `'Unknown Caller'` — but keeps its own routing (department only on post-op, v89). **WHAT IS NOT CHANGED, STATED:** the app's own phone-lookup still REPLACES a ticket's name with the phone's owner on a single phone match (strategy 3), on every `/submit-ticket` ticket, named or stand-in — a phone candidate written as an identity, app-side, pre-existing, and not touched here; `create_ticket`'s own name refusal stays a question the model can put to a caller still on the line; and the old core's answering-service line is untouched (standing instruction 5). **A FIXTURE WAS A NAME THE APP REFUSES:** `noIvrRefusedEscalationFiles.test.ts` used the synthetic patient *"Test Caller"* — both words on the list — so it now uses one the app accepts; three more assertions there were rewritten to the new payload, not loosened (the bare record now carries exactly the stand-in note; a failed earlier filing still leaves nothing to cross-reference). `src/services/standInName.test.ts` (10) and `src/agents/noIvrTransferRecordFiles.test.ts` (7, the REAL agent). **NOT MEASURED IN PRODUCTION**, `docs/BACKEND_HANDOFF.md` applies — this changes where urgent after-hours records land. The numbers: no-ivr urgent `/submit-ticket` POSTs refused *"Could not parse patient name"* — **22 over 2026-08-11..10-09, target 0**; refused for a surgeon — **9, target 0**; and connected-transfer records landing outside department 8 — **22 of 54, target 0**. The guards: **two tickets on one no-ivr call must stay 0 except the v80 beside-ticket** (this changes no key); department-8 tickets per night rise by about the recovered count, which is the mandate working; and tickets whose name reads `Unnamed Caller` with no `NAME NOT CAPTURED` note must stay 0 |

### THE SURGEON CLAIM — BUILT, REVIEWED SIX TIMES, WITHDRAWN 2026-09-17

**Operator ruling, 2026-09-17:** *"if it's only 9 callers, I would remove if we
are unsure"* — and we were unsure. The ship was v57, it is out of #321, and
**the number v57 is retired rather than reused**: the next ship takes v58, so a
deployment can never read a marker for code that does not exist.

**THE MEASUREMENT STANDS AND IS THE POINT OF KEEPING THIS.** Task #75's
after-number, never taken since the exit merged on 2026-09-02, measured
2026-09-17 over 09-08..09-16 (seven business days):

| surgery calls that took the surgeon refusal | 96 |
|---|---|
| filed | 50 |
| **left no ticket of any provenance** | **46** |
| … of those, reached the THIRD filing attempt the exit needs | 29 |
| … of those, the batched shape the withdrawn fix addressed | **9** |

88 POSTs across the 46, every one refused *Missing required information:
surgeon*. The exit DID fire on 57 other calls (82 POSTs, all accepted) and on
**none of the 46**. The link: on all 9 batched calls, POSTs 2 and 3 landed
**1–100 ms apart** — the model emitted them in ONE response, so every
invocation read the per-call counter before any refusal had returned to be
noted, and a flag that needs "two refusals already noted" could never be true.
The 36 control calls where it fired had 8–42 s between POSTs. **Optical's exit
does not share the defect** (17 flags sent, 0 batched misses).

**WHY IT WAS PULLED RATHER THAN SHIPPED.** The fix was ordering: a claim that
waits for the attempts ahead of it, then reads the confirmed refusals. That
serialises POSTs which previously went out in parallel, and each of six Codex
rounds (16 through 21) found a new interleaving in the machinery holding it up.
Round 21 is the one that could not be closed by tuning a constant: three
serialised 15 s client timeouts is 45 s, which is exactly the bridge's
tool-dispatch watchdog (`DEFAULT_DEAD_AIR_MS + TOOL_DISPATCH_GRACE_MS`), so no
value of a settlement bound buys the last attempt its budget. Closing it means
extending or re-arming that watchdog, or not serialising — both larger changes
than 9 callers over seven business days justifies.

**THE DESIGN FOR THE NEXT ATTEMPT, and it needs no concurrency machinery at
all:** flag on the SECOND refusal rather than the third. A batch of two is not
the failing shape, the counter never has to be read mid-flight, and the
serialisation that drew all six rounds disappears. Whether the threshold should
move is the operator's dial, and it is the same dial the 37-of-46 residue
below turns on.

**THE OPERATOR SET THE DIAL ON 2026-09-30: *"lower the surgeon exit to the
second refusal."* Shipped as v81 — the v80 row in the marker table carries the
2026-09-29 measurement it rests on (4 of the 7 lost calls rescued on their last
attempt, 3 tickets routed on a later attempt now filed unassigned) and names
the 3 CONCURRENT pairs the threshold cannot reach, which stay open with the
cut-filler dead air they died in.**

**WHERE THE EXIT'S TICKETS LAND — read this before re-opening the work, and
note the first reading of it was WRONG.** An earlier version said the ticketing
app's exit *re-routes* a surgeon-less request out of department 2. It does not:
`applyRoutingGate` (ticketing-app `lib/voice-agent/routing-gate.ts`) answers
`takesUnassignedExit` with `ok: true` and touches no department, and every
flagged surgery POST in the window went to department 2. Re-read through
`ticket_events` at 10:45 UTC on 2026-09-17: **all 55 exit tickets were CREATED
in Surgery Coordination, and 37 of them were then MOVED by a logged-in user** —
a `department_transferred` event with an actor on every one, none by the API's
null actor — 19 to Technicians Support, 13 to the HVA Hub, 2 to the OCS Hub, 2
to Medical Records, 1 to Billing. The 18 still in department 2 carry 15
providers the app derived from the schedule and 3 unassigned. So department 2's
provider fill held at 100% from 08-25 to 09-14 because **staff triage the
exit's unassigned tickets out of the queue by hand**, not because the app moves
them.

**STILL OPEN FOR WAYNE, and it does not depend on any code:** two readings of
that triage, and only he can pick. Either it is the exit working — a person
routed 37 requests that would otherwise have filed nowhere — or two thirds of
what the surgeon gate catches was never a surgery-coordination request at all,
and the ask is being spent on another queue's caller. The queries are in
`docs/observatory/AFTER-MEASUREMENTS-20260917.md`.

**AND THE 37 OF 46 THAT DIED ON THE FIRST OR SECOND REFUSAL WERE NEVER THIS
FIX'S POPULATION** — they are v55's and v56's, and the threshold's.

---

**READ THE VERSION, NEVER THE DATE — FOUR BUILDS SHARE 2026-09-12.**
v10 (the person base and the join), v11 (the locked record, #290) and v12
(optical's office ladder) are a CHAIN on `main`: each merged after the one
before and brought it in, so v12 contains both.

**AND THE SEQUENCE HAS TWO HOLES IN IT ON PURPOSE: v13 AND v57. v93 IS THE
NEWEST — the after-hours urgent transfer record files (a stand-in name the
app accepts, and department 8 named) — stacked on v92 in #348 (the teardown
filers take the app's unassigned exit on optical and surgery, and the floor
stops filing for a caller gone inside the first-event wait), so only v93
reaches a deployment; ABOVE `main` —
AND
v91 IS WHAT `main` CARRIES, SINCE #347 MERGED 2026-10-07 (`96151a1`): the
session stall reconnects (a first-event timeout detaches a silent xAI socket
and opens a new one, and a setup that never started files a ticket); on top
of v90 (#346, `23ffe2a`, the PCP teardown floor reads the factory's own
module, so it files on the runtime for the first time since v69 wired it
in); on top of v89 (#345,
`97ca3c9`, the after-hours line routes what the operator ruled on 2026-10-02
(a post-op prescription problem files urgent to After Hours instead of
ringing the on-call provider, a same-day request files to After Hours, and
the urgent ring-out ticket reaches After Hours instead of Technicians
Support); on top of v88 (#344,
`6032e26`, the on-call text before an after-hours transfer rings and the urgent
ticket after one rings out, stacked on v87 in the same PR, one call, one ticket
on the PCP lane and no ticket for a caller who chooses the PCP queue), v86 (#343,
`655de97`, one person on the number is certain), v85 (#342, `c086b3c`, the person base answering first, stacked on v84, the
PersonID join reading the Console's schedule mirror), v83 (#341, `5b2eed4`,
the after-hours line stating the office hours), v82
(#340, `dfb036c`,
caller memory as a candidate stacked on v81), v80 (#339, `480c0b9`), v79 (#338,
`df07335`), v78 (#337, `d89e3b5` — the fix for the outage that a build reading
v77 IS), v77 (#336, `df9b6b1`), v74 (#335, `f998a0b`) and v73 (#333,
`0039a9d`); AND v57, v59, v60, v63, v65 AND v66 ARE ALL RETIRED RATHER
THAN REUSED — see THE SURGEON CLAIM below the table for v57.** **THIS LINE
GOES STALE EVERY TIME A MARKER LANDS, SO RE-READ IT AGAINST `main` RATHER
THAN TRUSTING IT.** TWENTY-ONE corrections have landed on it in seventeen days and every
one was the same trap: it read `v58 IS WHAT main CARRIES` after #324 moved
`main` to v61, `v61` after #323 moved it to v62, `v62` after #327 moved it to
v64, `v64` after #326 moved it to v67, `v67` after #328 moved it to v68, `v68`
after #325 moved it to v69, `v69` after #293 moved it to v70, `v70` after
#329 moved it to v72, `v72` after #333 moved it to v73, `v73` after #335
moved it to v74, `v74` after #336 moved it to v77, `v77` after #337
moved it to v78, `v78` after #338 moved it to v79, `v79` after #339 moved
it to v80, `v80` after #340 moved it to v82, `v82` after #341 moved it to
v83, `v83` after #342 moved it to v85, `v85` after #343 moved it to
v86, `v86` after #344 moved it to v88, `v88` after #345 moved it
to v89, and `v90` after #347 moved it to v91 — **NINETEEN of those arrived ON `main` already wrong**, because a branch's own prose does not
update itself when that branch merges, and the branch that writes it cannot
know it will be the last to land. **THE EIGHTH AND NINTH ARE THE ONES THE #329
GUARD WAS BUILT FOR AND COULD NOT SEE:** both claims went stale-LOW together, so they
still agreed with each other, still sat below the marker and still cited a sha
— every assertion in `markerCarriesClaim.test.ts` green on prose that was
false the second the merge button landed. The guard's own docblock says the
numeric half is deliberately weak; this is what that weakness costs, and it is
the price of the only rule a test running on a branch can honestly enforce.

**THEY SPLIT AGAIN THE SAME AFTERNOON THEY REJOINED, AND REJOINED AGAIN BY
EVENING.** For part of 2026-09-27 they were one number — v71 and then v72 sat
above `main` while #329 was open, and #329 merging closed the gap — then #333
took v73 above `main`'s v72 for four hours, and #333 merging at 16:49 UTC
(`0039a9d`) closed it again. All three states are ordinary and none is a
problem: a branch that ships sits ABOVE `main` until it merges, and only a
marker BELOW `main` reads as a failed pull. **The previous version of this
paragraph predicted that #333 merging would stale the NEWEST sentence in the
other direction; it did** — the merge carried `v72 IS WHAT main CARRIES`
onto a `main` that carried v73, the seventh such arrival in the list above.
The next branch to take v74 splits them again, and this paragraph goes stale
with it; that is the list's job, not a defect in it. **AND IT DID, THE SAME
NIGHT:** v74 — the after-hours email preference is a question, not a failure —
sat above `main`'s v73 on its own branch for four hours, and #335 merging at
23:06 UTC (`f998a0b`) rejoined them a third time — carrying, as predicted, a
NEWEST sentence that still said `v73 IS WHAT main CARRIES`: the eighth such
arrival, corrected here from a fresh branch off that `main`.

**AND IT CAUGHT A DEFECT IN THE GUARD ADDED FOR THE STALE-CLAIM TRAP.**
`markerCarriesClaim.test.ts` (#329) required every "IS WHAT `main` CARRIES"
sentence to name THIS BUILD's marker — sound only while the branch and `main`
agree, which was true for that one day. On any branch that ships, the rule
demands prose saying the branch's own number is what `main` carries, which is
false; a guard that has to be lied to in order to stay green manufactures the
very staleness it was built to catch. It now checks the two things a test on a
branch honestly can: no claim may name a version ABOVE the build's marker, and
every claim must cite a commit. **The numeric half is deliberately weak** —
all five bad arrivals were stale-LOW and the ceiling admits those — so the sha
is the part that bites.

**`main` NOW CONTAINS ALL FOUR SIBLINGS off the v62 base** — v64 (#327, the
caller-audio meter), v67 (#326, the callback provenance), v68 (#328, the
silence ladder) and v69 (#325, the PCP floor) — **THEN v70 (#293), AND v71 AND
v72 ON TOP OF THEM from #329, AND v73 (#333, the records line asks once, then
files) ON TOP OF THAT since 2026-09-27 (`0039a9d`)**, which contains all of it.
**v13 was #293's original number and it has now yielded twice:** the branch
merged `main` at v56 and took v59, then merged it again at v69 and takes
**v70**, which is the rule working rather than a renumbering — a marker
re-bumps only when it falls BELOW `main`, where it would read as a failed pull.
**NEWEST IS NOT THE SAME AS CONTAINED:** v70 contains v69 because `main` was
merged into it, not because 70 > 69. **A build must never read v13, v57, v59,
v60, v63, v65 or v66** — v13 and v57 were withdrawn, and the other five were
branch numbers given up the moment a merge put them below `main`. The next ship takes **v94**. v19-v24 were siblings off v18 on 2026-09-15 — v19 the PCP lost-requestfloor (#300), v20 the blind transfer telemetry (#302), v21 the ask detection
(#301), v22 the question format (#303), v23 the recording disclosure (#304),
v24 the answerable queue choice (#306). Distinct numbers were assigned UP FRONT
precisely so six open branches could never make six different builds read alike
at `/voice/health`; they are not evidence that one contains another. The
integration branch (#305) carries v24 because it contains all six, which is the
one place those six numbers and the containment agree. **v25 stacks on that
integrated v24** — it is the date-of-birth `carry` instrument, not another
sibling. **v26 stacks on v25** — stop-erase + inherit-on-file; the instrument
rides along. A deployment reading v25 does not contain the fix. Do not treat
#308 (v25 alone) as the next ship. **v27 stacks on v26** — the recognised-caller
block moved into the runtime, with its drift guard. **v28 stacks on v27** — the
identity ask script made to agree with that block instead of contradicting it,
and `### How a call runs` stopped telling a recognised caller that
`identity_is_certain` false means collect last name and date of birth.
**v29 stacks on v28** — the candidate-count exception stated BEFORE the
prohibition it excepts, so a genuinely ambiguous lookup is still disambiguated,
plus the first measurement of the RECOGNISED prompt against the token ceilings. **v30 stacks on v29** —
the v14 reversal: a caller who chooses the live queue gets a ticket again, at
`DIALING` and never `CONNECTED`, and Twilio's `<Dial action>` result now
reaches that ticket instead of only `call_logs`. **v31 stacks on v30** — a
PCP call the model never classified files as `unclassified_call` into
department 18 with the caller's own words on it, instead of filing nowhere.
**v32 stacks on v31** — the two Codex findings on #313: a transient failure on
the dial-settlement POST is retried instead of lost, and the narrative is
clamped to the schema's cap in `annotateGaps` so the longest calls still file.
**v33 stacks on v32** — the ask budget: the PCP intake stops offering a field
after two unanswered attempts, so the seven-times call cannot happen again,
and `handoffEligible` is decoupled from that budget so giving up on a question
can never become a dial.
**v34 stacks on v33** — the interview becomes an answering service: the caller
credentials that killed 97 calls in two days stop being asked, who the call is
about moves to the front of the intake, and two questions are reworded to
collect what callers already volunteer in one breath.
**v35 stacks on v34, and partly CORRECTS it** — the operator put the caller's
title back and called its removal hasty, so the interview is now split around
the patient rather than shortened: credentials that a staffer needs are asked
AFTER the request is already filable. Beside it the filing gate opens
(`FILING_MAY_BE_HELD = false`), so nothing the intake asks can hold a ticket.
v34 and v35 ship together in one PR and only v35 ever reaches a deployment;
a build reading v34 does not exist.
**v36 stacks on v35** — the date-of-birth refusal stops opening with *"I did not
catch that"* when the model never sent a date, and the four lanes stop each
carrying their own copy of that sentence.
**v37 stacks on v36** — the PCP interview stops asking a caller for their title
and their email address BEFORE the request is filed, because the model files
when it runs out of questions and those two were still questions; and the email
is asked once rather than twice.
**v38 stacks on v37** — recording a tool call and persisting it become one act,
so pcp, no-ivr and answering-service stop depending on a 2h in-memory reaper
that every restart beat; and a write that touched no row stops marking itself
durable.
**v39 stacks on v38** — the four queue lanes tell the caller the call is being
recorded, which 401 calls on 2026-09-16 did not; the clause sits before the
closing question so personalisation cannot strip it from a recognised caller,
and both greeting tables gain the lanes so a database row cannot drop it.
**v40 stacks on v39** — six call sites stop slicing the last four digits off a
caller ID that may be the word "anonymous", and fall through to asking for the
number instead. v39 and v40 ship in one PR and only v40 reaches a deployment;
a build reading v39 does not exist, the same shape as v34/v35.
**v41 stacks on v40** — the after-hours line's `create_ticket` asks for a date
of birth once and then files with it marked unavailable or unmatched, the
queue lanes' 2026-09-04 escape reaching the one lane that built its own tool
and so never had it; the fifteen-ask call of 2026-09-16 cannot recur through
that tool.
**v42 stacks on v41** — a filed ticket is never spoken as a failure: a
duplicate `create_ticket` waits for the in-flight attempt's number instead of
refusing at 3s, a contention refusal that survives the wait says so rather than
apologising, and a client timeout is retried once against the app's
idempotency key.
**v43 stacks on v42** — a classify tool's instruction to the model moves out of
the channel the model speaks, so the surgery agent stops reading its own
emergency rule to callers. v42 and v43 ship in one PR and only v43 reaches a
deployment; a build reading v42 does not exist, the same shape as v39/v40.
**v44 stacks on v43** — the Observatory sees a runtime call the way xAI's
console shows one: the bridge keeps the time each line was written and hands
timed turns to `call_turns`, a dual-channel Twilio recording is started on
every runtime call and lands on the old core's handler by CallSid, and the
call page puts each tool call where it ran.
**v45 stacks on v44** — the Grok day table: one `daily_grok_costs` row per day
on every outcome, served to the cost dashboard, and the call page says whether
a cost is reconciled or estimated. v44 and v45 ship in one PR and only v45
reaches a deployment; a build reading v44 does not exist, the same shape as
v42/v43.
**v46 stacks on v45** — a success loop is a loop: the tool ceiling stops the
eleventh identical successful call and hands the model the tenth's answer
back, bounds any one tool at twenty successes, and keys arguments without
regard to case or spacing.
**v47 stacks on v46** — a phone match is a candidate: the after-hours line
withholds a phone-matched patient's appointment from the prompt and from the
phone-only lookup until the name and date of birth are confirmed, and reads it
back from the tool result afterwards.
**v48 stacks on v47** — the ambiguous lookup is countable: `found` and
`candidate_count` reach `tool_timeline`, so the W1 date-of-birth question can
be answered from a day of data instead of an argument.
**v49 stacks on v48** — the fleet is graded at teardown: the runtime hands
every substantive call to the grader when it ends, the backfill can no longer
be starved by empty or backed-off rows at its head, and a dead_air ending
after a real conversation is recorded `completed` so it is graded and synced.
**v50 stacks on v49** — the second miss ends the identity ask: `lookup_patient`
counts identity misses per call, coaches one shaped re-ask on the first and
says stop-and-file on the second, so a cold caller on the queue lanes is asked
for a name and date of birth at most twice.
**v51 stacks on v50** — the record reaches the call row: a CERTAIN identity
the tools established is written onto `call_logs` at teardown, on the insert
and the update path alike, never a candidate and never a null.
**v52 stacks on v51** — the cost write parses: the per-call cost UPDATE
types its two bound components, so the statement Postgres has refused at
PARSE since 2026-09-04 goes through and `twilio_cost_cents` is written again.
**v53 stacks on v52** — the record reaches the after-hours call row: no-ivr's
`create_ticket` writes a CERTAIN identity (name + date of birth matched) onto
`call_logs` reading the transport's `callLogId` at write time, and the
factory-time phone-candidate write that never fired is gone.
**v54 stacks on v53** — the affirmed name picks the person: when a phone
carries several people and the caller has affirmed a first name, `lookup_patient`
narrows to that one person, re-resolves them and carries them as certain, so the
filing tool inherits the chart date instead of asking for it.
**v55 stacks on v54** — the follow-up does not wait for a done that already
passed: the bridge asks the wire whether a tool's carrying response is still
open instead of assuming it, so a function-call event that lands after its
response's `done` gets its follow-up the moment the tool settles; and every
call that owed a follow-up writes a PHI-free summary row to `call_events`, so
the 9–42 dead-air losses a day since 09-10 become measurable by link.
**v56 stacks on v55** — an unvoiced tool answer cannot end the call: the
bridge holds an end-call tool while the model has a tool result it has not put
into words, bounded at three holds per answer, and `record_automated_resolution`
tells the model to say the appointment it found — 38 PCP calls on 09-16 ended
on the agent's own question, nine of them with a found appointment never spoken.
**v57 WAS WITHDRAWN AND THE NUMBER IS RETIRED, NOT REUSED.** The surgeon-ask
claim was built, reviewed six times and pulled out before merge on the
operator's ruling — see THE SURGEON CLAIM below the marker table. A build must
never read v57; **v58 was that next ship** — the identity probe, an instrument
and no behaviour change (see the v56 row below for what it measures). It is no
longer the current marker: see the paragraph beneath this one.

**v91 (#347) IS WHAT `main` CARRIES (merged 2026-10-07, `96151a1`), AND v57,
v59, v60, v63, v65 AND v66 ARE RETIRED RATHER THAN REUSED.** Each of the last
five was a branch's own number while it sat below `main`, and each was given up
the moment a merge put it there: two branches carrying one version make two
builds indistinguishable at `/voice/health` — the single thing this constant
exists to prevent — and a number BELOW `main` reads as a failed pull. **v59 is
the newest addition to that list** — it was #293's number from 2026-09-19 until
#325 moved `main` to v69, at which point it fell below and the branch re-bumped
to v70. **THIS PARAGRAPH ITSELF HAS ARRIVED ON `main` WRONG FOURTEEN TIMES**, once naming
v67 as what `main` carried, once describing #328 and #293 as open siblings,
once naming v70 after #329 had moved `main` to v72, once naming v72 after
#333 had moved `main` to v73, once naming v73 after #335 had moved `main`
to v74, once naming v78 after #338 had moved `main` to v79, once naming
v79 after #339 had moved `main` to v80, once naming v80 after #340 had
moved `main` to v82, once naming v82 after #341 had moved `main` to v83,
once naming v83 after #342 had moved `main` to v85, once naming v85
after #343 had moved `main` to v86, once naming v86 after #344 had moved
`main` to v88, once naming v88 after #345 had moved `main` to v89, and once
naming v90 after #347 had moved `main` to v91 — the fourth through
seventeenth of the nineteen the sequence sentence counts.
Containment is stated once, in the sequence sentence above; see the v56 row for
what v61 measures.

**AND THE TWO FIXES BELOW ARE v58'S, NOT v61'S** — they rode in with the
identity probe on #322 and are recorded here because the surgeon claim was
withdrawn out of the same PR, not because they belong to a later marker.
**Two fixes that rode in with it STAY
in the PR and are nothing to do with the surgeon claim:** Codex round 15, where
the post-call sync's failure writes add one to the retry count IN THE DATABASE
instead of storing a snapshot that could clobber the grade or recording
writer's reset; and Codex round 20's root fix, where
`ticketingApiClient.makeRequest` keeps its abort timer armed until the response
BODY has been read — it used to clear it the moment the headers arrived and
then await `response.json()` with no bound at all, so a hung body read hung a
ticket POST forever, on every lane. That one is a real fleet-wide defect the
surgeon work merely uncovered.

**v14-v18 WERE a chain, which is why the distinction matters.** v14 (the PCP
queue choice), v15 (PCP records), v16 (professional records), v17 (PCP
scheduling to the Hub) and v18 (the no-IVR prompt trim and its greeting fix)
each merged after the one before and brought it in, so v18 genuinely contains
all five. Reading v19-v24 the same way is the error this paragraph exists to
prevent. #293 has held
`voice-runtime-v13-new-or-existing-20260912` on its branch since before the
PCP queue choice existed, and two open branches carrying one version would
make two different builds indistinguishable at `/voice/health` — the single
thing this constant exists to prevent. So the queue choice took v14 rather
than colliding on v13. A gap in the sequence is readable; a collision is not.
**#293 still has to merge `main` and re-bump above whatever `main` then
carries** — it branched off v10 and contains none of v11, v12, v14, v15, v16,
v17 or v18, so landing it at v13 would send `/voice/health` BACKWARDS past
six live markers and read as a failed pull.

**v13 IS NOT IN THAT CHAIN.** #293 (RULE ZERO 2a, the new-or-existing ask)
branched off v10 and contains NEITHER v11 NOR v12. Before it lands it must
merge `main` and re-bump above whatever `main` then carries. A marker that
goes BACKWARDS is worse than a stale one: it describes less code than the
deployment is running, and it will be believed. #290 and #291 each re-bumped
once for exactly that reason, from v8 and v9.

**THREE builds also share 2026-09-11, so on that date the DATE TELLS YOU
NOTHING either — read the version.** v5 → v6 → v7, each strictly containing
the one before it. That is the case this table's own warning was written for,
and it has now happened on two separate days.

**THIS TABLE IS THE POINT AND IT WAS ADDED LATE.** Until 2026-09-11 this
section named the v4/20260908 marker as current and rejected only dates
*before* 09-08 — so a pull that silently failed would serve v4, an operator
following these very instructions would accept it as current, and the
date-of-birth backstop would be diagnosed as deployed-but-not-firing when it
was simply not deployed. That is the 2026-09-05 failure recurring inside the
documentation written to prevent it (Codex, PR #285). **Bumping
`VOICE_RUNTIME_DEPLOY_MARKER` and not bumping this line leaves the trap
armed: change both in the same commit.**

**This exists because the marker failed at the one job it has, on 2026-09-05.**
It read `voice-runtime-v2-transfer-guardrails-tools` from 2026-08-29 straight
through to 2026-09-05, unchanged across every commit between — including
`91498ff` on 08-31, which added the `[runtime] pre-context` diagnostic. Wayne
searched a live deployment for that line, found nothing, and **the marker could
not say whether the build contained it**: the identical string is served either
side of the change. Neither could the rest of the payload — `transferDestinations`
landed 08-30, one day too early to discriminate. The only health field that
dates a build at all is **`lanes`**, added 09-04.

So: the rule "bump it on every ship whose effect is hard to see" was already
written at the top of `src/runtime/readiness.ts` and was not enough on its own.
The date is now in the string, `markerSetOn()` parses it back out, and
`readiness.test.ts` fails if a future bump drops the suffix.

### AN ABSENT RUNTIME LOG LINE USUALLY MEANS NO RUNTIME CALLS

**The build was current all along, and the missing line meant nothing.** Both
halves came out of `call_logs`, which is where this should have started:

- **The build is ≥ 2026-09-04.** 405 grok rows carry an `agent_id` that the
  live process stamped itself — they are NOT in the 259-row backfill snapshot
  `call_logs_agent_id_backfill_20260904` — and `src/runtime/agentIdentity.ts`
  merged 2026-09-04 03:45 UTC. Earliest such call 2026-09-04 15:01:28 UTC. So
  the deployed code is newer than the 08-31 log line by a clear margin.
- **The runtime served ZERO calls that day.** Last grok call
  2026-09-04 23:55:48 UTC. Every one of 2026-09-05's 49 calls was `no-ivr` on
  the OLD CORE, 00:01–06:15 UTC. Nothing ran, so nothing printed.

**AND THAT IS THE NORMAL WEEKEND SHAPE, not an outage.** Queue lanes take
essentially nothing Saturday or Sunday — 08-22: 1 queue call vs 155 no-ivr ·
08-23: 1 vs 59 · 08-29: 0 vs 120 · 08-30: 0 vs 36 · 09-05: 0 vs 49. Standing
instruction 13 routes it all to the after-hours agent, which is old core.

```sql
-- Before concluding a runtime log line is missing, ask whether the runtime
-- ran at all. Substitute the day.
SELECT coalesce(voice_provider,'old-core') AS pipeline, agent_used, count(*),
       min(created_at AT TIME ZONE 'UTC'), max(created_at AT TIME ZONE 'UTC')
FROM call_logs WHERE created_at::date = '<day>' GROUP BY 1,2 ORDER BY 3 DESC;
```

**To read the pre-context diagnostic you need a runtime call first.** On a
weekday the queue lanes open around 15:00 UTC (first grok call was 15:24 on
09-03, 15:01 on 09-04). On a weekend, one test call to a queue number is the
only way to produce one.

**If the marker is absent, the code is not live and the call proves nothing.**
Whenever you ship something whose effect is hard to see, add a marker like this.

Markers added 2026-09-01, all on the branch `claude/determined-brown-o5qsft`
(PR #244). Two print at boot, so they are the fastest way to tell whether a
pull took:

```
[TICKET OUTBOX] Starting retry worker (every 60s; up to 12 attempts,
  backoff 30s → 30m; queue payloads re-sent verbatim; a 400/422 writes refusal_status_code)
[ALERT SERVICE] Starting ticket-filing alarm (every 5 minutes; a terminal 4xx is follow-up, not a stall)
```

The other three print only when the thing they watch happens, which makes each
of them a live counter as well as a marker:

```
[TOOLS] file_surgery_ticket: kept the call's call_sid over the model's "unknown"
[TICKET FILING] surgery: create-ticket REFUSED the payload (HTTP 400) — ...
[PROMPTS] ✗ REFUSED a write to agent_prompts for "<slug>"
```

One of them needs no log at all: after the deploy, **no create-ticket POST
from a queue agent should carry a `callData.callSid` that does not begin with
`CA`.** Before it, 6–8% of live POSTs did.

Marker added 2026-09-03 on the runtime (`src/runtime/toolCeiling.ts`). It
prints only when a repeated-failure loop is stopped, so it is a live counter
too — and it never carries arguments, because they hold PHI:

```
[TOOL CEILING] file_optical_ticket not dispatched — 3 consecutive failures
  with the same arguments; answering with the tool's own refusal and telling
  the agent to speak to the caller
```

Its no-log check is the one that matters, and it is SQL. The threshold is
`>=`, not `>`, and that is the whole point of the check: `begin` refuses at
`dispatches >= perCallDispatches`, so a call can REACH 40 and can never
exceed it. Written as `> 40` — as it was from 2026-09-03 until it was
corrected — it proved the ceiling had shipped and then could never again see
a loop that reached the limit. It missed eight of them.

```sql
-- Each row is a CANDIDATE runaway loop, not a confirmed ceiling stop.
-- Read the call's tool_timeline before calling it a loop; see below for why.
-- Keep 40 in step with DEFAULT_CEILING_LIMITS.perCallDispatches
-- (src/runtime/toolCeiling.ts); ceilingDocCheck.test.ts fails if they drift.
SELECT call_sid, tool_call_count FROM call_logs
WHERE voice_provider = 'grok' AND tool_call_count >= 40;
```

**A row is a candidate, and the verification is one column away.** A count of
40 says 40 dispatches were ALLOWED — nothing more. `begin` refuses when
`this.dispatches >= 40`, so the 40th dispatch still runs (39 >= 40 is false)
and it is the **41st attempt** that is refused; that refused attempt is never
counted. A call whose model simply stopped after its 40th tool therefore looks
identical here to one the ceiling stopped. Confirm by reading `tool_timeline`:
a loop repeats one tool 30-odd times, and a call that merely finished busy
does not. All eleven below were confirmed that way, not assumed.

**This check sees ONE of the ceiling's three rules.** An empty result says
only that no call reached `perCallDispatches` — it is not proof the build is
healthy, and it is not proof the ceiling did not fire. A stop by
`identicalFailures` (3) or `perToolFailures` (6) can happen at any call
total below 40, so it never appears here at all. Do not expect such a call to
read 3 or 6: those two limits are **per-tool** counters, not call totals —
`begin` reads them off that tool's own `byArgs` / `toolFailures` state, while
`tool_call_count` counts every tool that ran. Twenty good calls to one tool
followed by three identical failures of another is a stop at a total of 23.
What IS guaranteed is only that the total is under 40, because the call-total
check runs first and would have fired instead.

Those two rules' stops are not merely below the threshold, they are
**unrecorded everywhere**. `begin` returns before `agent.dispatch`, so the
agents' `recordingExecute` never runs and the attempt is absent from
`tool_timeline` and from `tool_call_count` (which is that timeline's length).
The bridge does push a `ceiling:<reason>` entry onto its own `toolEvents`, but
`callRecord.ts` deliberately keeps that off the row — "for logs and tests, and
off the row". So the only trace a repeated-failure stop leaves anywhere is the
console `[TOOL CEILING]` line, and **no SQL can count it.** Raising this
query's threshold would not help; there is nothing in the row to find.

A row above 40 is a fault **only if the call is post-deployment**. Nothing can
exceed the limit while the ceiling is in the dispatch path, so a recent 41
means it is not. But this query carries no deployment-time predicate, so it
will ALWAYS return the pre-ceiling call of 2026-09-03 at 118 — check the date
before concluding anything from a row above 40. As of 2026-09-10 that
historical row is still the only one.

Note also that `tool_call_count` is NULL on **714 of 1,952 grok calls —
36.6%** (measured 2026-09-10 21:51 UTC; the table is live, and this read
577/1,620 = 35.6% nine hours earlier on the same day). So this check is blind
to about a third of the population whatever the threshold. The control that
says this is not a legacy gap: the NULL share is steady on every day the lane
has run (39.3 / 35.6 / 34.5 / 35.1% across 09-03, 09-04, 09-08, 09-09), it
does not fall as the runtime matures, and the whole-population share moved
only 1 point while the denominator grew by 332 calls. Why the column is unwritten on a third of
calls is not yet established, and until it is, **this check's floor is unknown
rather than zero.** That gap is larger than the `>`/`>=` bug this section
documents, and nothing currently watches it.

**What the corrected check found. Re-measured 2026-09-10 21:51 UTC: ELEVEN
rows at `>= 40`** — the pre-ceiling optical call of 09-03 at 118, and **ten
sitting at exactly 40**. Nothing at all between 24 and 39 — the highest count
any call reaches without touching the limit is still 23 — so a 40 is the limit
being reached, never drift. **None of the eleven filed a ticket**
(`ticket_number` NULL on all eleven).

**It is not decaying, and the per-day count is the reason to care:** 09-03 ×1
(the pre-ceiling 118) · 09-04 ×3 · 09-08 ×2 · 09-09 ×3 · **09-10 ×2**. This
section read NINE earlier the same day and gained two before the day was out.
Roughly two lost requests a day, each after a caller has spent two minutes on
the phone.

| call_sid | lane | day | dur | the loop | the gate that was refusing |
|---|---|---|---|---|---|
| CAc9f38039b80c47cf13cf5c15b79c1c37 | optical | 09-03 | 245s | `file_optical_ticket` ×110, all failing | `["date_of_birth"]` |
| CA3985d8bcabd63bb29e7861a58cfc682b | optical | 09-04 | 120s | `resolve_location` ×32, **all succeeding** | `file_optical_ticket` ×2 `["location"]` |
| CAefbdd1832725217d5846f723c259f944 | optical | 09-04 | 161s | `lookup_patient` ×35, **all succeeding** | `file_optical_ticket` ×2 `["location"]` |
| CA60675f75fcbb9211e68dc01e7416a83f | pcp | 09-04 | 247s | `record_pcp_intake` ×40, **no outcome recorded at all** | — |
| CA9f9710a9fe054f387f1d6e4c6f3b6350 | optical | 09-08 | 159s | `resolve_location` ×30, **all succeeding** | `file_optical_ticket` ×2 `["location"]` |
| CA3ccec8b38c1734b990f7f6c91fec71e6 | optical | 09-08 | 121s | `resolve_location` ×32, **all succeeding** | `file_optical_ticket` ×2 `["location"]` |
| CA511a3e2dcc4a53d63e2d4cd2a6dcb29d | optical | 09-09 | 168s | `resolve_location` ×30, **all succeeding** | `file_optical_ticket` ×3 `["location"]` |
| CAefddb2f48d13678c9df2f27e6750f227 | optical | 09-09 | 160s | `resolve_location` ×33, **all succeeding** | `file_optical_ticket` ×3 `["location"]` |
| CAa6a32e9c9459a8b4d149383e5e083971 | surgery | 09-09 | 291s | `lookup_patient` ×35, **all succeeding** | `file_surgery_ticket` ×2 `["surgeon"]` |
| CAebcb3ffe096d0bf024139cc416797a89 | optical | 09-10 | 140s | `resolve_location` ×35, **all succeeding** | `file_optical_ticket` ×3 `["location"]` |
| CA4ffd0c125b59ea0f84f773e4256148ae | optical | 09-10 | 123s | `resolve_location` ×31, **all succeeding** | `file_optical_ticket` ×3 `["location"]` AND `["date_of_birth"]` |

**The finding that matters: only the 118 was a failure loop.** All ten
that reached the limit were loops of tools reporting SUCCESS (or, on pcp,
reporting nothing). That means `identicalFailures: 3` and `perToolFailures: 6`
were structurally blind to every one of them — they count failures, and a
success clears the counters by design (rule 1 of `toolCeiling.ts`).
**Closed on v46 (2026-09-17):** the ceiling now bounds identical successes at
10 and any one tool at 20 successes, with the measurement in the v45 marker
row. This table stays as the before-arm.

**Say "reached the limit", not "the ceiling stopped it" — even here.** The
timelines prove these are loops: one tool repeated 30-odd times is not a call
that merely got busy. They do NOT prove the ceiling refused anything. The
refusal lands on the 41st attempt and is written nowhere — not
`tool_timeline`, not `tool_call_count`, not the call row — so a call that
looped 40 times and then ended on its own is indistinguishable from one the
ceiling cut off. Only the console `[TOOL CEILING]` line separates them, and it
is not retained. Two claims live here and only the first is evidenced:
**these are loops** (proven), and **the ceiling stopped them** (not provable
from anything persisted).

Say no more than that. It is tempting to conclude `perCallDispatches` is the
only rule that ever fires, and the evidence cannot carry it: stops by the
other two rules leave no trace on the call row, so a census built from
`tool_call_count` is structurally incapable of finding one. How often the
repeated-failure rules fire is **unknown, not zero** — which is the same trap
this whole section documents, one level down.

**And the shape is general, not an optical quirk.** On every one of the nine
strikes that recorded outcomes at all, the same thing happens: a filing tool
refuses for a missing field, and the model answers by re-running a LOOKUP tool
that keeps returning success, instead of asking the caller for the field.
Eight of the nine are optical hitting `["location"]`; the ninth is **surgery
hitting `["surgeon"]` and re-running `lookup_patient` 35 times**. The lane and
the field change; the loop does not — so **a fix scoped to `opticalTools.ts`
would leave surgery looping.**

### A FIX IS MERGED. DO NOT REBUILD IT — and do not assume it worked either

**PR #282, merged 2026-09-10 as `de89ac2` on `main`.** Two changes, both in
`src/tools/sharedPatientTools.ts` so surgery gets them too:

1. **`resolve_location` REFUSES when the office is the wrong KIND of facility
   for the queue** — a surgery centre named on the optical line. That branch
   returned `success: true` with an advisory `message`, which is precisely
   the trap the `!hit` branch above it had already been fixed for and whose
   own comment calls it *"the worst loop we had"*: a success envelope tells
   the model the call worked, so it retries. The fix stopped one branch short
   the first time.
2. **The office ask is bounded at two per call** via `gateAttempts`. Past
   that the caller's words pass through with `resolved: false, verified:
   false`, and `file_*_ticket`'s own escape takes the request unassigned at
   high priority rather than losing it.

**MERGED WITHOUT THE AFTER-NUMBER, on Wayne's explicit instruction**, with the
Codex P1 saying so left OPEN on #282. `docs/BACKEND_HANDOFF.md` forbids that
by default; the reason given was that the change cannot produce its own
after-number while it sits unmerged and the loop was costing ~2 requests a
day. **So nothing below is proven.** The after-measurement, including the
guard, is in task #103 and in the #282 body.

**The guard matters more than the primary number.** This change can trade a
ROUTED optical ticket for an UNASSIGNED one, and optical assigns BY location —
the department-2 shape that went ~98% → 49% once already. **Optical tickets
filed with no `location_id` must not rise materially.** If they do,
`RESOLVE_ASK_LIMIT` (currently 2) is the dial; it is a judgement, not a
measurement, because nothing tells us how often a caller names a resolvable
office on the THIRD attempt — the tool never let them get that far.

**The after-control is `[RESOLVE LOCATION] the office ask is spent`**, one
line per CALL. It printed per INVOCATION when first written, which on a
30-call loop would have read ~28 exhausted calls — the number meant to prove
the fix worked, inflated by the failure it detects. Found by Codex, fixed
before merge.

**STILL OPEN, and #282 did not touch it:** why 11 of 72 optical calls hitting
the location gate never reached `file_optical_ticket`'s OWN CallSid-keyed
escape, which demonstrably works on 61 of 72 (those 61 filed 53; the 11 filed
**0**). A reproduction shows an absent or sentinel CallSid produces exactly
the observed shape — three refusals, no ticket, `createTicket` never called —
but what makes the SID go missing on ~4% of runtime calls is NOT established.
The obvious cross-check does not settle it: the DOB gate does not loop on
those same calls, but it is barely reached on them either, so that is an
absent measurement, not evidence the keying worked.

Whether a verified lookup answer is failing to reach the filing tool's view of
the call is still open, and it lives in the filing tools, not in the ceiling.
The two standing suspects are present but are NOT the loop: `resolve_location`
with no argument appears once or twice per call, and the location gate two or
three times.

Markers added 2026-09-03 (late), all on `claude/determined-brown-o5qsft`.
Each prints only when the thing it watches happens, so each is a live counter:

```
[DOB] refused a date of birth in the shape # # ##      <- and "(none)" is the
[DOB] refused a date of birth in the shape (none)         one that matters
[REQUEST SWEEP] tech: recovered request filed as VA-… (CA…)
[REQUEST SWEEP] surgery: a request was made and nobody was identified —
  not filed, needs a callback (CA…)
[TOKENS] usage reported by the provider on this response: <keys>
```

`dobShape` also lands in SQL, which is how the date-of-birth question was
finally settled — the log line is convenience, this is the evidence:

```sql
SELECT e->'args'->>'dobShape', count(*)
FROM call_logs c, LATERAL jsonb_array_elements(c.tool_timeline->'events') e
WHERE e->'args' ? 'dobShape' GROUP BY 1;
-- "(none)" means the MODEL omitted the field. Anything else means the parser.
```

Markers added 2026-09-03 to the ticket-filing alarm
(`server/services/ticketFilingHealth.ts`, `ticketFilingPulse.ts`). The first
prints every five minutes and now names what it did NOT count; the second
prints only when a run reached the threshold and was disconfirmed, so it is a
live counter of false alarms prevented:

```
[ALERT SERVICE] Ticket filing OK — 3 call(s) since the last ticket
  (2 greeting-only hangup(s) not counted), 0 held in the outbox
[ALERT SERVICE] Ticket filing alarm HELD — a run of 12 reached the threshold
  but a ticket was confirmed filed inside it; filing has not stopped
```

The alarm email now carries `greetingOnlySkipped` beside `unfiledRun`, so a
future alert says how much of its run was hangups without anyone re-deriving
it. On 2026-09-03 18:24:56 that ratio was 4 of 12.

**A PAYLOAD REFUSAL IS NOT A STALL — 2026-09-25.** Three `ticket_outbox`
rows (optical office, two surgery surgeon) were dead-lettered by terminal
400s after the ticketing app recovered. `assessTicketFiling` treated ANY
`dead_letter` as `ticket_filing_stalled` and re-emailed every five minutes
while tickets were still landing 1–4 minutes before each alert. Same false
alarm shape as 2026-09-02.

The split is the persisted `refusal_status_code` (400 or 422 only — never
inferred from `last_error`). A transport dead letter (timeout, 5xx, network,
or a NULL status) still stalls. A terminal 4xx does not; it sends ONE
`ticket_needs_followup` email via `emailService.sendEmail` (not `sendAlert`,
so the cooldown and hourly cap cannot throttle a row), recorded on
`followup_notified_at`. Resolved rows (`resolved_at`) drop out of both
planes. The Observatory amber banner lists every unresolved dead letter;
Resolve is admin-only (`POST /api/ticket-outbox/:id/resolve`).

The three 2026-09-25 rows were written BEFORE the column existed, so their
`refusal_status_code` is NULL. They still count as transport until Wayne
resolves them from the Observatory after this deploys. The migration does
not backfill or auto-resolve. Apply the SQL (`migrations/add_ticket_outbox_refusal_and_resolution.sql`)
on the same pull; if the columns are missing, the snapshot falls back to
counting every dead letter as transport so the run plane stays armed rather
than returning null and going silent. The follow-up notice runs before the
snapshot read, so a `call_logs` blip cannot skip it.

New marker on the same boot line:

```
[ALERT SERVICE] Starting ticket-filing alarm (every 5 minutes; a terminal 4xx is follow-up, not a stall)
[TICKET FOLLOW-UP] notified N terminal refusal(s) as CA…
```

---

## THE ACCEPTANCE INSTRUMENT: `src/pcp/replay20260914.test.ts`

Wayne, 2026-09-15: *"If we run the same transcripts through our process, they
must pass our tests to clear them."* That file is it, and it lives on the
integration branch (#305) because it goes green only with all six of that
day's PCP fixes present.

**WHAT IT IS.** The 17 calls of 2026-09-14 that left no ticket of any
provenance, each by its real `call_sid`, each with the caller's own first
substantive line read out of `call_logs.transcript`. It drives the real agent
tools twice over the same corpus — once with the ticketing app accepting, once
with it refusing — and asserts the caller is never told their request was
recorded when it was not, and that the request exists somewhere afterwards.

**THE TICKETING MOCK CARRIES THE APP'S REAL SLUG LIST.** The 17 were not lost
in this repo: the agent POSTed correctly and the app answered HTTP 400 because
its `PCP_CALL_PURPOSE_SLUGS` held 18 of the agent's 19. A mock that accepts
everything would have been green on the day it happened. It also re-derives
the agent's own list and fails if the two drift again — the check nobody had.

**WHAT IT CANNOT DO, and this is the part to read before trusting it.**
`voice_agent_api_logs.request_body` stores every `narrative` as the literal
string `[REDACTED - stored securely]`, so **the sentences the model actually
sent are not recoverable** and the narratives in the file are constructed. The
`callPurpose` column is NOT redacted and is what grounds the replay
(`patient_caller` on all 17, read from the table). So a case turning on
narrative PHRASING is a fact about that phrasing — two such known misses are
asserted as misses at the end of the file rather than quietly fixed.

**IT EARNED ITS KEEP TWICE BEFORE IT SHIPPED.** It found `"Live
representative."` — a bare noun phrase from the caller who rang SIX times —
failing `asksForAPerson`, which review had not (see the v20 row). And
**mutation testing found the suite itself lying**: the first version replayed
only against an app that accepts, so the whole failure arm was unreachable and
three mutations survived it, including reverting the refusal copy that cost us
the 17. A fourth was hidden by module-level state — `pcpDirector` is keyed on
call id and only the sweep clears it, so replaying the same SID twice carried
`dispositionRecorded` into the second arm and fourteen floor assertions were
measuring a sweep that never ran.

**Six mutations, six caught**, each reproducing a distinct piece of the day:
the app rejecting `patient_caller` (20 fail), the false completion sentence
(18), the missing ask-for branch (2), the either/or queue question (1), the
sweep demanding a name (15), and `A_REAL_PERSON` without the phrase family (1).

---

## My recurring failure modes — check yourself against this list

1. **Building instead of swapping.** He asked for a pipeline swap; I built a
   whole new agent (a state machine). Days lost.
2. **Patching symptoms.** Fix on top of fix on top of fix. He named this
   repeatedly and was right every time.
3. **Making him the test harness.** Changing code and asking him to dial to
   find out if it worked.
4. **Filling gaps instead of asking.** Inventing procedure he never approved.
5. **Losing context and re-asking / re-proposing** what was already decided or
   already built. This file is the fix. Use it.
6. **Declaring success before evidence.** Report what the log actually shows,
   including when it shows nothing.
7. **Theorising instead of diffing.** On 2026-08-12 I stated three wrong root
   causes out loud for one bug. What found it was a *control* — Wayne asking why
   Optical could file a ticket when Surgery could not. Two paths through the same
   code, one working: diff them before theorising. See
   `.agents/memory/realtime-tool-schemas.md`.
8. **Quoting a number without checking the instrument.** 2026-09-03: I
   reported filing rates all afternoon from `tool_timeline`, which silently
   drops a third of successful filings. Every number was understated and I only
   caught it because three consecutive calls read out a ticket number the
   timeline said did not exist. **Before quoting a rate, find the control that
   proves the measure** — see the measurement section above.

9. **Building a second system without looking for the first.** 2026-09-08: I
   built a records-delivery intake in the director and wrote in a commit
   message that its escape value bounded the refusal loop. `gateBeforeExecution`
   had enforced its OWN delivery rule since 2026-08-07, out of the call-facts
   ledger, and it runs BEFORE the tool body — so wherever a ledger exists the
   escape is unreachable and a MAIL request is asked for a fax number forever.
   **My tests were green because `getLedger` returns nothing in a unit test**,
   so the suite exercised a path that does not exist in production. Before
   adding a rule, grep for the rule.

10. **Testing the sink instead of the source.** Three times in one day
    (2026-09-08), and only mutation testing found any of them: a briefing test
    that could not tell the source fix from the downstream floor; a `DECLINED`
    mapping that lived inside a closure so flattening it failed nothing; and an
    ack-ordering test that exercised the store, which cannot see WHEN anything
    calls it. A suite that asserts against the last component in a chain proves
    the chain has an end, not that it is wired. **Mutate the fix and watch a
    test fail, or the test is decoration.**

11. **Accepting a constraint as immovable.** I treated "the API has no way to
   express *no category*" as the end of the discussion. Wayne: *"why don't you
   just create one?"* Ask whether the constraint can be changed before designing
   around it.

---

## Where to look next

Full running history, decisions and open items:
**`docs/observatory/STATE-OF-PLAY.md`** — read it with this file.

Hard-won specifics, one topic per file, indexed in **`.agents/memory/MEMORY.md`**.
Start there before debugging anything in these areas:

| If you are about to… | Read first |
|---|---|
| **anything that touches identity, a gate, or an intake question** | **`the-record-and-the-funnel.md` — RULE ZERO, binding** |
| debug "the agent won't call the tool" | `realtime-tool-schemas.md` |
| build or change a queue agent | `queue-agents.md` |
| file, route or classify a ticket | `ticketing-api-contract.md` |
| touch ticket creation on the after-hours path | `ticket-creation-lock.md` |
| add a column to `call_logs` that the ticket needs, or touch the post-call sync | `the-sync-snapshot-race.md` |
| quote a number at Wayne | `measurement-traps.md` |
