# Test calls — say this, expect this, check this

**For Wayne, 2026-08-09.** Every test below has three parts: the exact words to
say, the exact line that must come back, and the log line that proves the call
kept its constants.

## Before you start

1. Pull latest `main` and republish. The Observatory gains a **New Core
   Replays** tab (between *Daily Brief* and *Health*) — if it isn't there, the
   build is old.
2. Every caller turn now prints ONE line in the server log:

```
[CONTEXT] no-ivr a3f9c2 | name=Wayne(caller-ID) Fabian(caller-ID) | dob=1973-03-17(caller-ID) | verified=no | callback=7471(unconfirmed) | reason="medication refill" | lang=en | core=old
```

Read it left to right: what the call knows, and **where each fact came from** —
`(caller-ID)` = pulled from the matched record before you spoke, `(said)` = you
told it. `core=old|NEW` tells you which engine answered.

**A slot showing `—` after you've said it out loud is the bug.** That single
line is the whole "flying blind" problem, made visible per turn.

## Turning a line on (and off)

```
NEW_CORE_LINES=no-ivr           # after-hours on the new core
NEW_CORE_LINES=no-ivr,azul-scheduling
NEW_CORE_LINES=                 # everything back to the old core
```
Set the secret, republish. Rollback is the same move with the name removed.

---

## A. After-hours / no-IVR — the line that is live right now

### A1 · Recognized caller, simple request
**Say:** *"Hi, I need a refill on my eye drops."* → then answer the identity
questions normally.

**Must hear:** your name in the confirm question (not "are you a new or
existing patient"), then ONE date-of-birth ask, then the callback confirmed by
its **last four** — never asked to read the whole number back.

**Log check:** `name=` and `dob=` show `(caller-ID)` on the FIRST line, before
you said anything. `reason=` fills on turn one and never changes.

### A2 · Ask for a person, three times
**Say:** *"Can I talk to a real person?"* … *"I need someone now."* … *"Just
get me a human."*

**Must hear, verbatim, every time:**
> "Our offices are closed right now — I'll take your information and make sure
> the right team member calls you back first thing."

**Must NOT hear:** any promise to transfer or connect you. Never.

### A3 · The one that broke Friday — force a ticket failure
**Say:** *"I need to talk to someone about my medication refill."* Complete the
call normally.

**Must NOT hear, under any circumstance:** "technical issue", "technical
difficulties", "I'm having trouble", or an apology followed by a hang-up. If
filing fails the line says *"I've noted everything and the team will follow up
with you"* and raises an internal alert.

### A4 · Urgency
**Say:** *"I'm seeing flashes and a curtain over my vision."*

**Must hear:** the 911 line first, then the message flow at urgent priority.

### A5 · Spanish
**Say:** *"Hola, necesito ayuda con mi receta, por favor."*

**Must hear:** the next line in Spanish. **Never** a refusal or "I can only
speak English." Log shows `lang=es`.

---

## B. Answering service — Monday's heavy lift

### B1 · Recognized caller states the reason first
**Say:** *"I never got my glasses order."* → confirm identity → date of birth.

**Must hear:** "Thanks, {your name}." then straight to the callback confirm.
**Must NOT hear:** "What would you like the team to know?" — you already said
it. That re-ask is the constants failing.

### B2 · Scheduling request (this line never schedules)
**Say:** *"I need to reschedule my appointment for next week."*

**Must hear:** "I can take down all the details and have our scheduling team
take care of that for you — they'll call you back to confirm." Then identity.
**Must NOT hear:** any attempt to offer times.

### B3 · Wrong DOB on purpose
**Say:** the right name, then a **wrong** date of birth. Then the wrong one
again.

**Must hear:** one "that doesn't match" retry, then "I'm not finding a match on
my end — I'll take your information and have the team contact you," and the
call CONTINUES to take your message.
**Must NOT hear:** "Are you calling for a new patient or an existing patient?"
You were recognized; that question is prohibited.

### B4 · Surgery request without naming a surgeon
**Say:** *"I have a question about my cataract surgery."* When asked who your
surgeon is, say *"I don't remember."*

**Must hear:** the request still gets filed, with the gap noted — not a dead
end.

### B5 · Two requests in one call
After it confirms the first ticket and asks "anything else?", **say:** *"Yes,
also tell them my eye drops ran out."*

**Must hear:** the second request captured. **Must NOT hear:** the callback
number asked again — it's a constant now.

---

## C. SD / Azul Scheduling — Monday's other heavy lift

> Its replay says **not ready** (it books 8 of the 21 calls the old core
> booked). These tests are to see the failure with your own ears before we
> decide. Run them on the OLD core first, then again if we flip it.

### C1 · Recognized patient, clear preference
**Say:** *"Yes, this is {name}"* → date of birth → *"Tuesday morning works
best."*

**Must hear:** the offer sentence exactly as the scheduling service returns it,
then a read-back of the time it is about to book, then the confirmation.
**Watch for:** any time mentioned that was NOT in the offer. That is the bug
class the read-back exists to make impossible.

### C2 · Neither time works
**Say:** *"Neither of those work for me."* then *"How about Thursday
afternoon?"*

**Must hear:** a NEW offer from the service. **Must NOT hear:** an invented
time, or an offer for a day you didn't ask about with no acknowledgement.

### C3 · Spoken date of birth
**Say your DOB in words:** *"August twenty-seventh, nineteen forty-five."*

**Must hear:** verification proceeding. (Spoken dates were not recognized at
all until today — this is the fix that mattered most for SD.)

### C4 · New patient
**Say:** *"I'm a new patient."*

**Must hear:** "I'm unable to schedule new patients, but our team can take care
of that for you — one moment while I connect you," AND the transfer actually
happening in the same breath.

---

## What to send me after testing

For any call that goes wrong: the **time**, the **line you called**, and one
sentence about what it said. I'll pull the transcript, the `[CONTEXT]` lines,
and the tool timeline for that exact call. The `[CONTEXT]` trail is what tells
us whether the fact was never captured, captured and then lost, or captured and
ignored — three different bugs that look identical on the phone.
