# Ramp Script Listing — FOR OPERATOR APPROVAL (CP-1)
Status: APPROVED by Wayne 2026-08-07 (chat), with the PCP contact-method
rule below. This document is now the single source of truth for the ramp
engine, the graders, and the Observatory. Structure: per agent → per state → per branch (including
every tool-call outcome), each with the recommended exact line.
Format: `STATE | trigger/branch | LINE THE AGENT SAYS | next state`.

Sections:
1. Shared spine states (greeting, identity, classification) — all agents
2. Answering Service (tickets only)
3. PCP Support (routes, non-blocking patient attach)
4. SD Pilot / azul-scheduling (schedules)
5. After-Hours (tickets only, 911-first)
6. Tool-result direction table (verify/lookup/book/ticket outcomes)

## 1. Shared spine (all agents)
GREETING | call start | (approved per-agent greeting, verbatim — enforced) | CLASSIFY or CONFIRM_ID
CONFIRM_ID | caller-ID matched | "Hello, thank you for calling Azul Vision. Am I speaking with {first}?" | yes→CONFIRM_DOB / no→CLASSIFY
CONFIRM_DOB | after yes | "Great — just to confirm your identity, may I have your date of birth?" | verify tool
CONFIRM_DOB | ambiguous date | "Is that {monthA} {dayA} or {monthB} {dayB}?" | verify tool
VERIFIED | verify=match | "Thanks, {first} — how can I help you today?" | INTENT
VERIFY_FAIL_1 | verify=no match | "Hmm — that doesn't match what I have. Could you give me your last name one more time?" | re-verify
VERIFY_FAIL_2 | 2nd no match | "I'm not finding a match on my end — let me get you over to our team so they can assist further." (ticket-only lines: "…I'll take your information and have the team contact you.") | EXIT_PATH
CLASSIFY | unmatched or "no" | "Are you calling for a new patient or an existing patient?" | existing→COLLECT_NAME / new→S4 per agent
COLLECT_NAME | existing | "May I have the patient's first and last name?" | COLLECT_DOB
COLLECT_DOB | name given | "And their date of birth?" | verify tool
INTENT | verified | (open listen — model classifies to: schedule / reschedule / cancel / question / message / other) | agent role flow

## 2. Answering Service (tickets only — NEVER transfers, NEVER schedules)
HUMAN_REQ | any ask for human, EVERY time | "All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available." | TAKE_MESSAGE
SCHEDULE_REQ | asks to book/reschedule/cancel | "I can take down all the details and have our scheduling team take care of that for you — they'll call you back to confirm." | TAKE_MESSAGE
TAKE_MESSAGE | entered | "What would you like the team to know?" | CONFIRM_CALLBACK
CONFIRM_CALLBACK | callback unconfirmed | "Is this number ending in {last4} the best one to reach you?" | yes→FILE / no→"What's the best number to reach you?"→FILE
FILE | ticket filed | "You're all set — I've passed that to the team and they'll contact you as soon as they're available. Is there anything else?" | WRAP
NEW_PATIENT | S4 | "I'll take your details so our team can get you set up." → name → DOB → CONFIRM_CALLBACK | FILE
DECLINED_MSG | caller refuses message | "No problem — the team is available during business hours if you'd like to call back. Is there anything else I can note for them?" | WRAP

## 3. PCP Support (routes to PCP queue — never books)
GREETING→ | provider line | (approved PCP greeting) | COLLECT_CALLER
COLLECT_CALLER | entered | "May I have your name and the office or medical group you're calling from?" | COLLECT_REQ
COLLECT_REQ | caller identified | "How can I help you today?" | classify: schedule→ROUTE / clinical/records/other→TAKE_DETAILS
ROUTE | any schedule request | "I'll get that over to our PCP scheduling queue right away — one moment." | transfer to PCP queue
PATIENT_REF | caller names a patient | (SILENT: attempt match; attach to ticket if found — NEVER blocks, NEVER interrogates the professional) | continue
TAKE_DETAILS | non-schedule request | contact method MATCHES the request (operator 2026-08-07): | branch below
CONTACT_CALLBACK | default | "I'll make sure that gets to the right team — what's the best callback number for your office?" | FILE
CONTACT_FAX | fax/records-by-fax requested | "What's the best fax number to send that to?" → read back once | FILE
CONTACT_EMAIL | email requested | "What's the best email address for that?" → read back once | FILE
FILE | ticket filed | "Done — the team will follow up with your office. Anything else I can help with?" | WRAP

## 4. SD Pilot / azul-scheduling (schedules)
NEW_PATIENT | S4 | "I'm unable to schedule new patients, but our team can take care of that for you — one moment while I connect you." | transfer + ticket w/ collected facts
APPT_INTENT | verified, wants appt | "What day and times work best for you?" | slots lookup
SLOTS_OK | lookup returns slots | "I have {slot1} or {slot2} — which works better for you?" | book tool
SLOTS_EMPTY | no availability match | "I don't have anything matching that — the closest I have is {nearest}. Would that work?" | book tool / retry once
BOOKED | book=success | "You're booked for {day} at {time} at {location}. You'll get a text confirmation shortly. Anything else?" | WRAP
BOOK_FAIL | book=error | "I'm having trouble finalizing that on my end — let me get you over to our team so they can lock it in. One moment." | transfer + ticket
HUMAN_REQ_1 | first ask | "I can usually help faster — may I ask what it's regarding?" | continue
HUMAN_REQ_2 | second ask | "Of course — one moment while I connect you." | transfer

## 5. After-Hours (tickets only, 911-first greeting enforced)
HUMAN_REQ | any ask | "Our offices are closed — I'll take your information and make sure the right team member calls you back first thing." | TAKE_MESSAGE
URGENT | urgency detected | (existing urgent-triage flow unchanged — 911 script already first in greeting) | urgent path
TAKE_MESSAGE→FILE | same as Answering Service scripts | | WRAP

## 6. Tool-result direction table (every tool, every outcome → the line)
verify_patient_identity=match | → VERIFIED line
verify_patient_identity=no_match #1 | → VERIFY_FAIL_1 line
verify_patient_identity=no_match #2 | → VERIFY_FAIL_2 line (per-agent exit)
verify tool=timeout/error | "One moment while I pull that up…" then retry ONCE; second failure → per-agent exit path (never expose the error)
slots lookup=results | → SLOTS_OK line
slots lookup=empty | → SLOTS_EMPTY line
slots lookup=error | "Let me check that availability for you — one moment." retry once; then BOOK_FAIL path
book=success | → BOOKED line
book=error/timeout | → BOOK_FAIL line
create_ticket=success | → FILE confirmation line
create_ticket=error | retry once silently; then "I've noted everything and the team will follow up with you." (+ alert flag — the ticket MUST be recovered by the sweep)
transfer=no answer | ticket-capable: "The team isn't picking up right now — I'll make sure they get your information and call you back." / SD: BOOK_FAIL wording
patient match (PCP, silent)=found | attach to ticket, say NOTHING about it
patient match (PCP)=not found | file ticket without record link, say NOTHING

WRAP (all agents) | end | "Thanks for calling Azul Vision — take care." | end_call
