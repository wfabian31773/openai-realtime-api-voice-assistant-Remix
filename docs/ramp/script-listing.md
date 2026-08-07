# Ramp Script Listing — FOR OPERATOR APPROVAL (CP-1)
Status: DRAFT for Wayne's line-by-line review. Nothing builds until every
line is approved. Structure: per agent → per state → per branch (including
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
