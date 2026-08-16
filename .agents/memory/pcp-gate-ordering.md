# The field every gate needed was the last one collected

**2026-08-16.** Why the PCP line came off the air on 08-08, diagnosed eight days
late from telemetry that was there the whole time.

## The shape

`callPurpose` was the sixth of six fields in `PROFESSIONAL_FIELDS` and the third
of three in `PATIENT_INTAKE_ORDER` — the **last** thing the intake collected. It
is also the field that **four** tools refuse to run without:

- `handoff_to_pcp`
- `create_pcp_task`
- `lookup_patient_appointments`
- `record_automated_resolution`

So the agent had to finish a six-question interview before it was permitted to
do anything, and every tool it reached for before that came back
`call_purpose_required`.

There was no classifier. `callPurpose` was set in exactly one place — an
**optional** argument the model may or may not choose to pass to
`record_pcp_intake`.

## The numbers

Ten days to 2026-08-16, from `tool_timeline`:

| tool | calls | refused | rate |
|---|---:|---:|---:|
| `handoff_to_pcp` | 240 | 211 | **88%** |
| `get_public_practice_information` | 15 | 11 | 73% |
| `create_pcp_task` | 85 | 33 | 39% |
| `terminate_call` | 82 | 26 | 32% |
| `lookup_patient_appointments` | 57 | 18 | 32% |

None are API failures. All are our own local guards.

**The regression has a date.** 08-06: 23 handoffs, 2 refused. 08-07: **207
handoffs, 199 refused, 180 of them `call_purpose_required`.** That Friday is the
one the operator described as "the disasters I was seeing on that line", and the
line came off the next morning. Still live on 08-14: 5 of 5 handoffs refused the
same way.

## The second-order cost

`director.next()` decides it is talking to a PATIENT by
`callPurpose === 'patient_caller'`. With the purpose collected last, the
director **could not know a patient was a patient until after it had asked them
their role, their organisation and their facility type.**

CAbd89b226, the last call this line ever took — a woman asking how long she
could go without her autologous serum drops:

> AGENT: What is your role at Optum Clinic?
> CALLER: Covina. I'm a patient.

The prompt already said "switch the moment it is clear you are speaking to a
patient". The prompt ALSO said `record_pcp_intake`'s answer "is the authority" —
and that kept returning professional fields. Two halves of one prompt in direct
contradiction, resolved in favour of the wrong one.

## A gate is not a fault, and the caller must never hear about it

Every guard returned a bare `{success:false, error:'<slug>'}`. Nothing told the
model what the slug meant or what to do instead, so it improvised — out loud, to
a healthcare professional. CA1de3229a, 188 seconds:

> "I'm sorry, but it looks like a direct handoff isn't available for this purpose."
> "I'm still here—one moment. Let me ensure the call disposition is securely recorded."
> "It looks like something isn't finalized yet."
> "Something still isn't finalized. Let me walk through the key details again."

Three separate leaks of internal vocabulary, and the agent said goodbye **three
times** because `terminate_call` kept refusing without saying why.

## The fix

1. **`callPurpose` moved to first** in both intake orders. The greeting already
   asks "How can I help you today?" and callers already answer it — every
   transcript reviewed states the purpose in the opening sentence. Recording it
   first costs nothing and unblocks everything.
2. **`next()` uses `PATIENT_INTAKE_ORDER`** instead of its own inline copy of
   the same list. Two literals for one order is drift waiting to happen.
3. **`src/pcp/refusals.ts`** — every gate now returns two fields:
   - `say` — a sentence for the CALLER, present only when they are genuinely
     owed one. `azulRubric` grades every `outcome.say` for verbatim delivery.
   - `guidance` — an instruction for the MODEL. Never spoken.

## The trap worth remembering

**A directive must never go in `say`.** It would fail the say-verbatim grader
and, worse, invite the model to read it aloud — which is not hypothetical here.
STATE-OF-PLAY §3 records an earlier attempt at mouthpiece rules in per-response
instructions where "the model read them to patients." Every `guidance` string
opens by saying it is not an error and must not be mentioned, the same
discipline `gateBeforeExecution` in `toolDirection.ts` already uses.

## What the ordering test should assert

The old test checked `PROFESSIONAL_FIELDS[0]` and `[1]` after seeding one field.
It passed on the order that refused 88% of handoffs, because it only ever
compared the director against the constant — never against what a call needs.
The replacement walks the **whole** list, and adds a test that a patient is
never asked a professional question. Order tests that check two positions do not
catch a bad order; they only catch disagreement.
