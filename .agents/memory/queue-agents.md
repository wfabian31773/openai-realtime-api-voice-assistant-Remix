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
