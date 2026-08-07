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
