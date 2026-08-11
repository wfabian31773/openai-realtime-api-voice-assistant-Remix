# START HERE — rebuild spec, reading order

**If you are a new session: read `/CLAUDE.md` first, then this, then the five
documents below in order. Do not re-derive any of it.** Everything here was
measured against live systems on 2026-08-10/11, not inferred.

---

## Read in this order

| # | Doc | What it settles |
|---|---|---|
| 0 | **`/CLAUDE.md`** | Wayne's standing instructions, line status (who decided what and why), what already exists, my recurring failure modes |
| 0b | **`/docs/observatory/STATE-OF-PLAY.md`** | Running history, honest ledger, the quality benchmark call, open decisions |
| 1 | `TOOL-LIBRARY-SPEC.md` | 68 tool definitions → 54 names; the `create_ticket` fork; the empty `agent_tools` registry. **§1.2 is superseded — see Part 3 §0** |
| 2 | `PLATFORM-DECISION.md` | AssemblyAI chosen; the economics; `session.end` + duration cap |
| 3 | `TICKETING-ANALYSIS.md` | Department taxonomy with real volumes; the two ticket endpoints; provider/location lookup failures |
| 4 | `SCHEDULING-SERVICE.md` | The two-layer tool pattern to copy; the manifest gap; the location naming split |
| 5 | `DOCS-VS-REALITY.md` | Which documented defects actually carry traffic. **Read this before acting on any of 1–4** |

The ticketing app's own docs — `ticket-workflow/MASTER.md`, `ROUTING-MAP.md`,
`research/01-codebase-map.md`, `PCP-SUPPORT-SPEC.md` — are accurate on **intent
and code paths** and are the authority on both. Part 5 is the authority on
**what production actually does.**

---

## The state, in six lines

1. **Production is fine.** Answering service ~579 calls/day, quality flat. PCP
   and San Diego are off — see `/CLAUDE.md` for who decided and why.
2. **AssemblyAI is the platform decision.** $0.075/min all-in, free BAA. Vapi is
   out on a $2,000/month HIPAA fee.
3. **Tools first, agents later.** Wayne's explicit direction: prove every tool
   works before connecting any agent. Agents are "the easiest part."
4. **The enforcement model is server-side refusal**, not prompt instruction.
   Proven: C5 hard-requires give 0.4% / 1.9% miss rates.
5. **The highest-value single fix** is the provider resolver — it is both the
   largest dead-air source and pure data hygiene.
6. **Do not rebuild the Operations Hub.** The tool layer is the six months of
   value; the transport is what failed.

---

## Next actions, in order

1. **Provider resolver** — strip `, OD` / `, MD`; reject `OCT-VF`, `A-Scan`,
   `DRS`, `Unknown` as *not a provider*. ~650 fewer fallback round-trips.
2. **Load surgery centers into `locations`** — currently zero exist.
3. **`session.end` on every terminal path + a hard call-duration cap** —
   ~$1,059/month, independent of everything else, worth doing on the current
   system.
4. **Then** wrap `lookup_schedule` and patient verification as HTTP, and only
   then point one agent at them.

---

## Access notes for a new session

- **Supabase MCP is the workhorse.** Support Center = `vsmcxhxeirkoobmjcrbn`
  (tickets, departments, `voice_agent_api_logs`). Operations Hub =
  `pslzngjciiifowemrzza` (call_logs, Schedule). Patient-Console =
  `kbbmywvasbsxnbblrhot` (`patients_master`).
- **`ticketing-app` is outside the repo allow-list.** Clone and file reads fail;
  **GitHub code search works** (`mcp__github__search_code` with
  `repo:wfabian31773/ticketing-app`). That is how §7 of Part 5 was answered.
  If a future session has it in scope, clone it — but it is **not** a blocker.
- Allowed repos: `5star`, `agent-operation-hub`,
  `openai-realtime-api-voice-assistant-remix`, `eyecare-scheduling-agent`.

## Open, and genuinely unresolved

- What dominates `submit-ticket` p95 (22.8s) — the inline welcome SMS or the
  provider fallback. Only the fallback is measured.
- How dept 16 tickets bypass `VOICE_ALLOWED_DEPARTMENTS` (confirmed still
  `{1,2,3,4,8,9}`). 183 landed since 2026-07-30 with no `[ROUTING NOTE]`.
- **Operator rulings owed:** should Medical Records keep receiving voice tickets
  (C3 says no, production does ~180/month)? Which departments become agents?
