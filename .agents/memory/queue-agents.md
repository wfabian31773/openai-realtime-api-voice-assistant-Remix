# Queue agents — one line, one subject, five tools

The pattern behind Optical, Surgery Coordination and Clinical Tech Support, and
the template for PCP, Medical Records, Scheduling and After Hours.

## Why they are small

**The line that rang is the classification.** These queues are forwarded from
specific numbers, so a call is an optical call because of the number it reached —
not because a model decided. Almost all of the answering-service prompt (~4,900
tokens) is that decision: which department, which request type, which guard. None
of it is needed on a queue line, and **none of it can be got wrong there.**

What is left is the job: who is calling, which office, have they already asked,
what kind of request, file it. Five tools, from the shared library — the agent
and the HTTP surface run the same code.

| | slug | dept | tools |
|---|---|---|---|
| Optical | `optical` | 1 | lookup_patient, resolve_location, check_open_tickets, classify_optical_request, file_optical_ticket |
| Surgery | `surgery` | 2 | …, classify_surgery_request, file_surgery_ticket |
| Clinical Tech | `tech` | 3 | …, classify_tech_request, file_tech_ticket |
| Medical Records | `records` | 16 | …, classify_records_request, file_records_ticket |

**Adding the next one — SEVEN places, and the test only knows six.**

Put its slug in `QUEUE_LINES` in `agents/agentWiring.test.ts` FIRST. That
table-driven test then names every code hookup you have not done:

1. webhook route (`registerOverflowLine`)
2. registry entry (`config/agents.ts`)
3. slug gates (`validAgentSlugs`, `validInboundAgents`)
4. `PRECONTEXT_SLUGS`
5. factory case in the switch
6. greeting personalisation (`greetingStyleFor`)

**7. A ROW IN THE `agents` TABLE (Operations Hub), which no test can catch.**

Optical, Surgery, Tech and Records all shipped without one and nobody noticed
until the operator asked for a list of endpoints on 2026-08-13. They still
worked — the greeting falls back to the hardcoded route string — so nothing was
visibly broken, which is exactly why it survived.

What is lost without the row:

- `resolveConfiguredGreeting` returns null, so the DB **rescue** never fires.
  That rescue exists because the realtime webhook can land on a different
  instance than the one that stored the call metadata, and the greeting is then
  improvised. That is the documented root cause of four live SD calls opening
  wrong on 2026-08-06. Single-instance deploys hide it completely.
- The greeting is not editable from the admin UI.

The test cannot enforce this: importing the DB would make it a guard that only
runs where a database is configured, which the file itself argues is not a
guard. So it lives here instead.

**Set `system_prompt` to a note saying the prompt is versioned in code** — the
`pcp` row already does this. These agents build their instructions in
`buildXPrompt()`; a row whose prompt field looks editable but changes nothing is
the same trap as an admin-editable greeting the code ignores.

**Verify the greeting matches the code by hash**, not by eye. The DB value
OUTRANKS the hardcoded one, so a near-miss silently replaces the agent's opening
with a slightly different sentence, and it will look like a model that will not
follow instructions.

**THERE IS NO HUB LINE.** I built one on 2026-08-13 and removed it the same day:
the HVA Hub is the scheduling team, not a queue. Operator: *"we don't have a
queue for the HVA hub… those have been landing, and then they've been moving
over manually into the HVA hub."* `hubTaxonomy` survives as the reason table
`queueRouting` uses when it files INTO department 9 on another queue's behalf —
that redirect **is** the manual move, done at filing time.

**Records must be told it cannot read a record back or promise a date** — release
needs a signed authorization it does not handle, and the model will otherwise
oblige.

**Route by queue.** Each queue gets its own number, webhook and slug. Do not
multiplex queues onto one agent with a mode flag.

## Operator rulings that shape every one of them

1. **No handoff for any answering-service agent.** Only PCP and Scheduling SD
   transfer. *"All other agents politely state they are unable to handoff and can
   only create a request for a callback."*
   These agents have **no transfer tool at all** — not a disabled one, not one
   that files a request. **A tool the agent cannot see is a promise it cannot
   make.**

2. **The greeting must pre-empt the request for a human.** Operator-dictated
   shape, two jobs in one sentence — say *why* a person is not answering, and say
   what *will* happen:
   > "Thank you for calling Azul Vision optical. All of our opticians are
   > currently assisting other customers, but I can take a message and they will
   > follow up with you. How can I help you today?"
   Otherwise the caller spends the call trying to reach a human this line cannot
   reach. It is also the honest framing for compliance: nobody is told they are
   talking to a person.

3. **Confirm the callback number BEFORE filing, not after.** A ticket is a record
   the team acts on; correcting a number afterwards means a second ticket and a
   patient who was told the wrong thing. Ask once — *"is the number ending 1234
   the best one to reach you?"* — then file.

4. **Caller recognition is credibility, not cosmetics.** Wayne: *"it lets the
   person know that, hey, I have your information in my hand so I'm able to
   help… if they know my name, they might know when my next appointment is."*
   Opening cold with "can I get your name and date of birth" tells a patient the
   system holds nothing.
   But a phone match is a **candidate to confirm, never an identity** — Wayne's
   own number resolves to eight records in the mirror. The recognition block only
   renders when the number matches exactly one person, it never speaks a last
   name first, and it discloses nothing from the record on the strength of the
   match.

5. **After hours, everything routes to the after-hours agent** via enterprise
   routing in Nextiva, which escalates to Wayne directly. *"It's impossible to
   reach that line after hours because all calls are routed to the after hours
   agent."* So a queue line's after-hours behaviour is not the queue agent's
   problem — do not build one.

## What four live calls found that 1,400 tests did not — 2026-08-13

Wayne pointed the numbers and called Optical, Surgery, Tech and Records himself,
deliberately **from an unregistered number** to exercise the verification path.
Three defects, all in the last thirty seconds of the call, none reachable by a
unit test because each is about *ordering in time* rather than output:

1. **The number was confirmed after the ticket was filed.** Ruling 3 above was
   written and still not obeyed — the prompt stated the requirement but not the
   sequence, so the model filed and then tidied up. It reproduced on Optical and
   Surgery identically: *"you fix one you fix all."*
2. **Dead silence while the ticket was being created.** The filing call takes
   seconds and the model said nothing through it, which on a phone reads as a
   dropped call. It must speak *before* the tool, not after.
3. **"Customers".** Wayne: *"change customers to patients, customers sounds like
   we are a department store."* It came from the operator's own dictated
   greeting and survived four agents.

The fix is one shared block, verbatim in every queue prompt:

```
# TWO THINGS ABOUT THE LAST THIRTY SECONDS
THE NUMBER COMES BEFORE THE TICKET…
NEVER GO SILENT WHILE FILING… Say "Let me get this logged for you — one moment." FIRST
```

**A rule the model must obey in a particular order has to state the order.** A
requirement phrased as a fact ("confirm the callback number") is satisfied by
doing it at any point.

**And beware a blanket find-and-replace on prompt vocabulary** — mine renamed a
test called *"does not call patients customers"* into *"does not call patients
patients"*, which passes forever.

The fourth call, PCP, was hung up on: *"completely broken, sounds nothing like
the other lines you created."* It still had the pre-queue prompt. Scheduling has
the same problem and is **not yet done** — it is ~2,000 lines and books real
appointments through the Eye Care rules engine, a different contract from a
queue agent.

## Rewriting a prompt that encodes incidents — Scheduling, 2026-08-13

`azulSchedulingAgent`'s prompt was ~275 lines and almost every line was paid for
by a real call. Restyling it into the house voice is exactly the change that
silently drops one and looks fine in review.

What made it safe: **extract the prompt to its own module, then assert the RULES
survived, not the wording.** `azulSchedulingPrompt.test.ts` names each rule and
what it protects — "seven refused handoffs in 34 seconds", "Oct 25 verified as
January 25", "five callers ended with nothing". Whitespace-tolerant matching, so
a re-wrap does not break it.

**The rewrite found a contradiction no reader had caught.** The prompt said,
under *What you cannot do*: "You cannot reschedule — cancel + book through the
allowed flow." Four sections earlier it said: "NEVER cancel their appointment
and then look for a new time." Both shipped together, with `sage_reschedule`
registered as a real tool. The stale line instructed the exact failure the
reschedule flow calls SERIOUS — `cancelled_not_rebooked`, where the old
appointment is gone and the new one did not take. A prompt long enough to
contradict itself will, and only reading it end to end finds it.

## What one live day taught that 1,600 tests had not — 2026-08-13

The four queue lines ran for a day. Every finding below came from reading real
calls and real tickets; none of them would have surfaced from the code.

**Catch-all rate is the health metric for a taxonomy.** Tech 9.6%, Surgery 67%,
Optical 85%. Tech was the only one whose cues were GENERATED from measured
ticket text; the other two were hand-written. That difference is the entire
gap, and it is the same lesson as `PHARMACY_TRANSFER_CUES` — a hand-listed
phrase encodes one word order, and callers use all of them. "schedule my
surgery" does not match "schedule **a cataract** surgery".

**A test corpus written by whoever wrote the cues proves only that they agree
with each other.** `surgeryTaxonomy.test.ts` passed throughout while the queue
filed 67% catch-all. Pull the strings from the database.

**Looping is measurable, and worth measuring per line.** From
`call_logs.tool_timeline`, count calls where one tool fires 3+ times:
Tech 4.6%, Surgery 8.3%, answering-service 8.3%, **Optical 20.7%**. The looping
optical calls averaged 229s against 134s and NONE ended `resolved`.

**A tool that returns `success: true` having done nothing is an invitation to
retry.** `resolve_location` returned `{success: true, verified: false}` and the
model called it ten times in a row with identical arguments. The advisory
message told it to go and ask the caller; the envelope said the call had
worked. Refuse with `missing()` instead — the prompts already teach the agent
to answer that by speaking to the caller. `retryable: true` on a name that did
not match is the same mistake: **a definite answer about the input is not a
transient failure.**

**Short cues need word boundaries, not banning.** `sx` is the practice's own
word and had to be added; matched as a substring it is the `er` bug again.
`SHORT_CUE_MAX = 3` — at 4, `pain` stopped matching "painful", so a boundary
rule that is too generous silently turns stems into whole words.

## Greeting personalisation

`src/services/greetingPersonalisation.ts`. `greetingStyleFor` returns `'append'`
for optical/surgery/tech, so the recognition question is appended to the
configured greeting rather than replacing it.

`stripTrailingQuestion` removes the greeting's own closing question before
appending, so the caller does not hear two questions in a row. **It strips any
trailing question — `/\s*[^.!?]*\?\s*$/` — not a hardcoded phrase.** Codex caught
the first version keying on the literal "How can I help you today?"; the greeting
is admin-editable, so any edit would have silently reintroduced the double
question.

## Cross-queue routing — nobody is told to call back

Wayne, 2026-08-13: *"if someone calls and they press two for medication refill,
and it's an optical question, we can't just tell the patient call back, call the
wrong extension… anything that's schedule related that comes through any of these
should go to the HVA hub."* Then: *"cross queue routing should be for all
agents."*

`src/tools/queueRouting.ts` — `detectCrossQueue(text, homeDepartmentId)`. Wired
into all three queue filing tools **and** the shared `createTicketTool` guard
used by answering-service, no-IVR and no-IVR v2.

- Scheduling → **HVA Hub (9), type 32.** Type 32 is the live one (456 reschedules,
  198 new, 55 same-day in 90 days); type 40 carries the same four concepts and is
  dead at 7.
- Optical → 1 (66/536), Surgery → 2 (65/535), Medication → 3 (72/542).

**Surgery is the exception to the Hub rule** — asked directly, Wayne: *"surgery is
an exception to that hva hub rule."* Moving a surgery date drags a surgeon's
block, a facility slot, pre-op measurements and a drop schedule with it, which is
why department 2 has its own reason 531. The exception is the **operation**, not
the word "reschedule": *"reschedule my post-op appointment"* stays with Surgery,
*"reschedule my eye exam"* still goes to the Hub.

**It is not a general classifier and must not become one.** Its job is the obvious
misroute; when unsure it returns null and the home queue keeps the call, because
**the line that rang is better evidence than a keyword.** A request mentioning
both its home subject and another one stays home — *"refill the drops for my
cataract surgery"* on the medication line is a refill.

**The ambiguous-cue split.** "Prescription" means a drug on the medication line
and a pair of glasses on the optical one. `TECH_CUES_AMBIGUOUS`
(`prescription`, `receta`, `rx`) identifies a medication call but does **not**
hold one against a clearer signal from another queue; only `TECH_CUES_STRONG`
does.

## Cue design — three ways a cue list is quietly wrong

All three were found by testing against real ticket text, and none would have
been found by reading the code.

**1. Spanish nominalises where English uses a verb.** Tickets say
*"Reprogramación de cita"* and *"Cancelación de la cita"*, not *"reprogramar"*
and *"cancelar mi cita"*. A list written English-first with Spanish appended
missed **10 of a 17-line sample** from department 8. Use stems (`reprogram`
covers all three forms), and fold diacritics on both sides — "cancelación" and
"cancelacion" both appear because transcription and staff typing disagree.

**2. Hand-listed English encodes whichever tense came to mind.** `fax to dr`
missed *"faxed to Dr. Ann Warn's office"*. Worse, the object of the verb sits in
the middle: *"fax **the records** to Dr. Warn"*. Generate `verb × object ×
target` rather than guessing, exactly as `PHARMACY_TRANSFER_CUES` does. A
substring cue cannot express "verb … target", and pretending otherwise fails
silently.

**3. The last bucket can afford breadth; nothing else can.** A bare `copy of` is
safe in Medical Records' 500 *because* every stronger claim has already matched.
The same cue placed first would take the whole department — which is roughly
what reason 500 would do, and what reason 153 actually does in department 3.

Corollary: **ordering is the design.** In Medical Records every request is
literally a request for medical records; "Medical records request for Social
Security office" contains both the generic phrase and the specific one. In After
Hours the six clinical emergencies go first and are deliberately generous,
because a false positive is a ticket marked urgent that was not, and a false
negative is a retinal detachment that waited until morning.

**When two terms must co-occur and are far apart, add a second condition rather
than a cross product.** `alsoRequires` exists for exactly one case — "over the
phone" only means an interpreter booking if an interpreter is also mentioned —
and is documented not to grow.

## Building a taxonomy — the method

Measure the queue before designing anything. For Clinical Tech Support: 9,288
tickets / 90 days, 103/day, the largest in the practice — and the agent path used
**two reasons** across 8,064 tickets (6,905 on one, 1,714 with no reason at all)
while staff used seventeen by hand. That gap is the whole design brief.

Two findings that only came from reading real caller language:

- **Pharmacy almost never means transfer.** The word appears constantly; the
  request is nearly always "it isn't there yet". `PHARMACY_TRANSFER_CUES` is
  generated as `MOVE_VERBS × DETERMINERS` so only actual movement matches.
- **Glaucoma is named by drug, not by condition.** Callers say "Latanoprost", not
  "my glaucoma". `GLAUCOMA_DRUGS` carries 27 brand/generic names, and a glaucoma
  refill files at `priority: 'high'` — pressure rises within days and the damage
  does not come back.

`classifyTechRequest` **never returns null**; it falls through to the catch-all.
A classifier that can refuse hands the problem to the model.

## Refusal contract

Tools return `{missingFields, message}` with speakable `askAs` text. The prompt
says: *"A tool asking you for something is NOT a fault. When a tool comes back
saying it needs a field, it hands you the sentence to say — just say it and carry
on. Never tell a caller there is a technical problem unless a tool actually
reported an error."* Without that line the model narrates the refusal as a system
failure.

## Gotchas that cost time

- **Registration is an import side effect, and registries are per-process.** Two
  processes (`[PROXY]` lines in the logs) hold different tool sets. An agent
  importing `../tools/techTools` is what puts those tools in *its* registry.
- **`caller_phone` vs `phone`.** The shared patient tools accept either:
  `const phone = str(input.phone) || str(input.caller_phone);` plus a
  name+DOB→phone retry. A ticket filed without it loses the callback number.
- **Rebind, never mutate, a service's returned object.** `Object.assign(ctx,
  byPhone)` corrupted a shared test fixture; use `let resolved = ctx`.
- **Backticks inside a template literal** broke three agent prompts at once.
- **`case '…'` inside a comment** truncated the factory-switch scanner.
- Tests that assert on prompt text need **whitespace-tolerant regexes**, or a
  re-wrap breaks them.

## PCP, 2026-08-14 morning: the ticket is filed before the intake

`CA7a5f2bfa` (06:48:03 PT, 124s, 15 turns). Timeline, against the transcript:

    +27s  handle_patient_medical_records_request -> PCP-51559 filed
    +37s  caller gives his name and medical group
    +55s  caller gives the patient name and DOB
    +82s  caller gives the callback number
    +85s  caller gives the fax number
    +89s  terminate_call

`record_pcp_intake` was **never called on this call**. So PCP-51559 carries
`FIELD_PLACEHOLDERS` — "Not provided by caller", "Not provided", "NOT PROVIDED"
— on a call where the caller answered every single question. The records desk
gets a blank ticket and a 124-second recording nobody will listen to.

Why it files that early is not a bug on its own: on 2026-08-06 this tool threw
on a missing administrative field like every other, and **21 records requests
reached this line with nothing filed behind them**, including one caller who
rang back eight minutes later and got nothing a second time. Filing immediately
with whatever exists was the fix, and it was the right one.

What is missing is the other half. Three facts, and they compose badly:

1. The tool files on first mention, with whatever intake produced.
2. There is **no amend path**. `updateTicketCallData` updates recording,
   transcript, duration and quality score — it cannot touch an intake field.
   Adding one is the ticketing app's API, not ours.
3. The realtime PCP agent has **no hangup fallback**. `pcpLine.finalize()`
   exists in the deterministic core (`core/pcpLine.ts`) and files a
   `CALL ENDED BEFORE CONFIRMATION` task; the realtime agent inherited nothing
   equivalent. So filing early is currently the *only* guarantee.

Which means the fix cannot be "file later" on its own — that reintroduces the
08-06 loss. It is one of:

  (a) a hangup fallback for the realtime PCP agent, after which filing can move
      to the end of the intake — entirely within our control; or
  (b) an amend endpoint on the ticketing app, after which the early file stands
      and `record_pcp_intake` updates it — needs the ticketing team.

(a) is ours and is the smaller change. Do not do either unilaterally: the
08-06 ruling was the operator's and this trades against it. **Ask.**

## The same morning, the other call: three voices, no gate

`CAf00cfcb4` (06:45:30 PT) and `CA7a5f2bfa` are the same root cause wearing two
faces. Three places send an out-of-band `response.create` — the greeting
guarantee, the director's author action, the holding callback — and none
checked `responseInFlight`. The caller hears:

    AGENT: Thank you for calling Azul
    AGENT: Hello, and thank you for calling Azul Vision's PCP support line...
    AGENT: Understood. One moment while I
    AGENT: Of course —
    CALLER: Hello.                          <- he thought the line had dropped
    AGENT: Still with you — one moment while I log that

Four fragments, three truncated. Fixed on `claude/pcp-sequencing` (PR #201).
**Anything that exists to fill silence must check whether there is silence.**

## The after-hours line is `no-ivr`, and it is the only agent that can transfer

2026-08-15, operator: *"It's called no-IVR only because initially we had tried
the IVR selection. But in true meaning it's the after-hours agent. That's the
agent that takes all the after-hours phone calls."*

Names to carry: the slug `no-ivr` maps to `src/agents/noIvrAgent.ts` (1,596
lines). `no-ivr-v2` and `dev-no-ivr` map to `noIvrAgentV2.ts`. There is also a
separate `afterHoursAgent.ts` behind the `after-hours` slug — 4 calls ever, and
it is NOT the after-hours line. Do not confuse them again.

**It holds `escalate_to_human`, and it is the ONLY agent in the fleet that
does.** Verified by grep: answering-service, optical, surgery, tech, records
and afterHoursAgent have no transfer tool at all. Out of hours the transfer
goes to on-call; in hours `urgentTransfer.ts` asks the rules engine for the
office queue.

I got this wrong on 08-13 and put `no-ivr` in the grader's `NO_TRANSFER_AGENTS`,
which made "escalation language, ticket filed" score 1.0 — *"the whole
obligation for this agent"*. On this line it is not. A hospital that gets a
ticket instead of a transfer is a failure, and the grader was blind to it.

### The operator's rule, verbatim, and the three cases

> "The only times it's supposed to fire is if it's calling from a provider's
> office, if it's calling from a hospital, or if it's a truly urgent situation
> with a patient. Not 'I need an urgent appointment tomorrow because I need an
> eye checkup.'"

Everything else — including *"I couldn't hear the patient"* — is
`create_ticket` with whatever was collected. **Filing a partial ticket IS the
job.** That is what an after-hours triage agent is for.

### What went wrong, and the general lesson

`escalate_to_human` offered `patient_unresponsive` as a caller type: "cannot
communicate after 3 attempts". It became the biggest escalation bucket on the
line — 14 of 33 events over 14 days. **A tool that OFFERS a category will have
that category used.** The prompt saying "RARE - TRUE EMERGENCIES ONLY" three
hundred lines away does not outrank an enum value the model can select.

Two more that compound it:
- **Nothing refused a second escalation.** One call fired three, another two —
  each dialling on-call and filing its own record ticket. Most of "all kinds of
  different messages" was one call several times, not many calls.
- **The prompt and the tool description disagreed.** Phase 6 listed only
  clinical symptoms and omitted providers/hospitals; the tool listed all three.
  When two places state a rule, they drift, and the model gets to choose.

The fix is `services/afterHoursEscalationGate.ts` — deterministic, server-side,
on the arguments actually sent. **Allow by default**: a refusal must be
positively matched, because a needless transfer costs a phone call and a
wrongly refused one could cost somebody their sight. Identity is checked first,
so a discharge nurse who says "appointment" in the same breath still gets
through.

### Backtesting a gate against real strings is worth more than the tests

Replaying all 26 recorded escalation reasons through the gate caught three
acute phrases the substring list missed — **"severe EYE pain"**, **"recent EYE
surgery"**, **"large floaTER"**. All three still passed, but only via
default-open, which means they would have been REFUSED had the sentence also
contained "appointment". A list of keywords does not survive contact with how
people actually speak; an interposed word breaks it silently.

## Capabilities are properties of an agent, never lists of slugs

2026-08-15, operator: *"do the refactor, capability based not slug lists."*

The audit that prompted it found the same question answered four different ways
in four files, every one written when the answering service was the only tenant:

    conversationLoopGuard  NO_TRANSFER_AGENTS  = {answering-service}
    callGradingService     NO_TRANSFER_AGENTS  = {answering-service, no-ivr,
                                                  after-hours, dev-no-ivr,
                                                  optical, surgery, tech, records}
    callGradingService     TICKET_ONLY_AGENTS  = {answering-service, no-ivr,
                                                  after-hours, dev-no-ivr}
    voiceAgentRoutes       (two inline literals) = {after-hours, no-ivr,
                                                    answering-service,
                                                    azul-scheduling, pcp}

**Splitting one agent into many turns every such list into a migration step
nobody schedules.** The loop-guard list cost Tech, Surgery, Optical and Records
callers a second ask before being told the line cannot transfer. And I put
`no-ivr` — the ONLY agent in the fleet with a transfer tool — into a
no-transfer set, which made a hospital getting a ticket instead of a transfer
score 1.0.

`config/agentCapabilities.ts` now owns the answer. Three properties worth
copying if this pattern is repeated elsewhere:

- **Store the EVIDENCE, not just the boolean.** `transferTool: 'escalate_to_human'`
  rather than `canTransfer: true` alone. A boolean can be wrong and nothing
  notices; a tool name is checkable, and `agentCapabilities.test.ts` reads each
  agent's source to verify it. A registry that can drift from the code is just a
  fifth list, and a worse one because everything now trusts it.
- **Derive what can be derived.** `isTicketOnly = filesTickets && !canTransfer`.
  The two lists that disagreed with each other were expressing one fact twice.
- **Fail safe in a NAMED direction.** An unregistered slug is assumed unable to
  transfer (worst case: takes a message when it could have connected someone)
  and assumed to file tickets (worst case: a wasted no-op push). Both chosen so
  the failure is the cheap one. Never throws — it sits in the live call path.

The grep that makes the conformance test honest: `name: "escalate_to_human"`,
i.e. a model-callable tool DEFINITION — not a substring. `techAgent` contains
`_handoffToHuman: undefined` as a deliberate no-op and `answeringServiceAgent`
declares a `handoffToHuman` parameter it never invokes. A naive substring search
calls both transfer-capable and both are wrong.

**Per-agent WORDING stays keyed by slug** — the director's ceiling scripts and
exit lines are genuinely per-agent. What must not be per-agent is the CHOICE OF
SHAPE: those now fall back through `isTicketOnly`, so a ticket-only line can
never be handed a script that names a transfer tool it does not have.

## An agent's summary is not evidence of what the caller said

2026-08-15. Operator forwarded a transfer SMS reading *"red eye with pain and
vision changes reported"* — patient 90 years old, on-call provider paged — with
*"This is not a reason for the agent to pass the call through as urgent."*

Call d30ca58b, 10:20:35 PT, verbatim:

    CALLER: Yes, I would like somebody to give me a call.
    ...
    CALLER: And my right eye. With discharge.
    AGENT:  ...Is there any pain with it, and has your vision changed at all?
    CALLER: Hello
    AGENT:  ...Is there any pain with the redness, and has your vision changed?
    CALLER: Yes.

**The caller never said pain. She never said vision.** She said DISCHARGE and
asked for a callback. One "Yes" to a compound question became two reported
symptoms in a page to a doctor.

And the compound question was **mine**: `afterHoursTriage` shipped
`"Is there any pain with it, and has your vision changed at all?"` as the
redness entry's single "one question" — inside the very taxonomy whose prompt
says *"ask ONE question, WAIT for the answer, do not stack them"*. The agent
obeyed the data, not the prose. **When a rule and an example disagree, the
example wins**, and the example lives in the config.

Three things worth carrying:

- **A gate that reads the agent's own summary cannot catch fabrication.** By
  the time the reason string says "pain", the pain has been invented. The check
  has to be against what the CALLER said —
  `services/symptomCorroboration.ts`, fed from the same caller-line tap the
  loop guard uses.
- **A bare "yes" is not corroboration.** It is precisely what the compound
  question harvested. Attributing it to both halves is the defect.
- **Fail open in every direction, and say which.** No caller speech recorded →
  allow (a transcription gap is not evidence of fabrication). One of two claims
  supported → allow (quibbling with half a write-up must not block a real
  transfer). Provider or hospital → allow before corroboration even runs, since
  a nurse reports someone else's symptoms by definition.

The `spoken` side is deliberately far broader than the `claim` side, matched on
STEMS: "it stings", "burning", "cloudy", "me duele", "veo borroso" all count.
The first version used `\bstinging\b` and would have called "it stings so much"
an invented symptom — the exact false accusation this must never make.

## The first full day on the Grok runtime — 2026-09-03

Read this with the line-status table in CLAUDE.md. Cutovers: optical 15:24:58,
surgery 19:43:57, tech 19:51:10 UTC. **Records did not move**, which is what
makes the comparison worth anything — it is a same-day control on the old core.

### The cutover did not change the filing rate

tech 67.1% → 69.7% (n=73 vs 66). surgery 50.0% → 56.3% (n=44 vs 32). Neither is
significant. **The runtime matches the old core.** Anyone claiming a win or a
regression from a single lane's afternoon is reading noise; the control is what
tells you the day itself was ordinary.

What did move: turn detection got better (callers say more, in fewer fragments,
at the same duration) and the agent talks in about twice as many short lines.

### Where the losses actually are

53 substantive queue calls produced no ticket. Two of those were "what time do
you close?" and correctly needed none. The other 51:

| cause | calls | avg length |
|---|---|---|
| the date-of-birth gate | 23 | 2m49 |
| asked for a human, then hung up | 12 | 1m12 |
| no tool ever ran | 7 | 1m09 |
| other | 9 | 1m50 |

The date-of-birth calls are the longest, which is the cruel part: these are
people who engaged fully, gave everything asked, and were failed at the last
step. See `measurement-traps.md` for why that gate was terminal.

### Three things about the tooling this surfaced

1. **`resolve_location` was called with NO argument 34 times across 16 calls**,
   because its description named a moment ("call it before you file a ticket")
   and never a precondition. Only 5 of those 16 calls filed — the worst
   recovery of any gate. A tool description must say when NOT to call it.
2. **The repeated-failure ceiling keys on IDENTICAL arguments**, so a model that
   varies them slightly gets more than three bites; observed 4–6 per call. It
   did stop the 110-refusal disaster (one optical call, 16:00) — refusals per
   call went 110 → 12 → 1–6 once it landed.
3. **Ceiling stops are invisible in `tool_timeline`.** The ceiling
   short-circuits before dispatch, so `wrapWithTelemetry` never runs and no
   event is written. Console-only, uncountable from SQL. A safety mechanism
   whose activations cannot be counted is one you cannot tune.

### Identity is the root, and it is upstream of the agents

Pre-context produced a usable name on **zero of 143** substantive queue calls,
so no caller heard "Am I speaking with…?" all day. Of 132 distinct callers, 2
are in `si_persons` (the 3,774-row table pre-context reads) and 100 are in
`patients_master` (915,843). `lookup_patient` meanwhile reads the Operations Hub
appointment book, not the mirror — `scheduleLookupService.ts` line 2 is
`import { schedule }`.

Outcome by what the lookup managed:

| lookup_patient | calls | filed | DOB refusals |
|---|---|---|---|
| certain match | 69 | 39 | 2 |
| no match | 53 | 24 | 17 |
| matched but NOT certain | 4 | **0** | 2 |
| never ran | 17 | **0** | 0 |

A certain match is worth roughly twelve points of filing rate, because it is
what lets the handler fall back to the verified date of birth. **Matched but
uncertain files nothing, ever.**

The caution that survives all of this: even reading the right table, 75 of 100
phone numbers resolve to more than one person (average 2.2, and Wayne's own
number resolves to eight). Pointing pre-context at `patients_master` buys a name
to CONFIRM. It does not buy an identity, and treating it as one is the failure
standing instruction 6 exists to prevent.
