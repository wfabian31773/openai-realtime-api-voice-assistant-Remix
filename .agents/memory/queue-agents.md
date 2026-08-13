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
| Scheduling Hub | `hub` | 9 | …, classify_hub_request, file_hub_ticket |
| Medical Records | `records` | 16 | …, classify_records_request, file_records_ticket |

**Adding the next one:** put its slug in `QUEUE_LINES` in
`agents/agentWiring.test.ts` FIRST. That table-driven test then names every
hookup you have not done — slug gates, precontext set, factory case, greeting
personalisation, webhook route, registry entry. It exists because the Optical
rollout answered as the after-hours line three times running, each time because
of one more list nobody thought to check.

**Two things a queue agent must be told it cannot do**, because the model will
otherwise oblige: the Hub cannot BOOK (it cannot see the schedule or hold a
slot), and Records cannot read a record back or promise a date (release needs a
signed authorization it does not handle).

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
