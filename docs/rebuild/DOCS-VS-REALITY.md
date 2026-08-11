# Docs vs. reality — the ticketing routing layer, measured

**Part 5 of the rebuild spec.** Reconciles `ticket-workflow/MASTER.md`,
`ticket-workflow/ROUTING-MAP.md` (2026-07-30) and
`research/01-codebase-map.md` against the live Support Center database on
**2026-08-11**.

Those documents are excellent and describe intent, code paths and guards. What
they cannot say is **which paths actually carry traffic.** That is the gap this
fills, and it changes what to fix first.

---

## 1. The headline: two "known defects" are dormant, two are live

| Documented | Doc's assessment | Measured | Verdict |
|---|---|---|---|
| §7.1 after-hours urgent flattening | *"the highest-value routing defect currently in the system"* | **9 tickets in 90 days** | **dormant** |
| §7 Guard #1 `VOICE_ALLOWED_DEPARTMENTS` | rewrites 15/16/17 → dept 8 | **1,016 tickets landed in 15/16/17 anyway** | **not firing** |
| F-10 taxonomy integrity | 35% bad reason, 27% no type | **36.3% / 24.5%** | **live, unchanged** |
| C5 hard-requires (location, surgeon) | enforcement architecture | **0.4% / 1.9% missing** | **working — keep it** |

---

## 2. §7.1 is dormant because the after-hours agent is not running

ROUTING-MAP calls the urgent-flattening defect the highest-value routing bug:
retinal detachment and post-op complications stored as `3 / 8 / 212`
("Tech Support / Patient Assistance / Callback Request").

Measured over 90 days of voice tickets (n = 17,476):

- Tickets stored as `3 / 8 / 212`: **9**
- Of those, `priority = 'urgent'`: **9**
- Tickets with `agent_used = 'after-hours'`: **1**

**The after-hours agent produced one ticket in ninety days.** The defect is real
in code and effectively unexercised in production. ROUTING-MAP §3.1 describes
after-hours as *"Default for every IVR call"* — that is no longer true of actual
traffic.

Note the distinction that makes this confusing: the **After Hours department
(8)** is busy — 988 voice tickets — but they arrive from `no-ivr` (698) and
`answering-service` (177), i.e. as the review-queue fallback (C4), not from the
after-hours *agent*.

**Implication:** do not spend the rebuild's first week on §7.1. Fix it when
after-hours comes back, and prefer moving that agent onto the free-text path
(ROUTING-MAP §9 B5's own recommendation) over widening `validDepartments`.

---

## 3. Guard #1 is not firing — 1,016 tickets prove it

ROUTING-MAP §7 #1: `VOICE_ALLOWED_DEPARTMENTS = {1,2,3,4,8,9}`; anything else is
rewritten to dept 8 with a `[ROUTING NOTE]` appended.

Measured on departments 15, 16 and 17:

| Dept | Agent | Tickets | First → last | Since 2026-07-30 | With `[ROUTING NOTE]` |
|---|---|---|---|---|---|
| 15 OCS Hub | `answering-service` | 569 | 2026-03-25 → 08-10 | 59 | **0** |
| 16 Medical Records | `answering-service` | 401 | 2026-06-09 → 08-10 | **183** | **0** |
| 17 Locations | UUID / `azul-scheduling` | 167 | 2026-07-22 → 08-09 | 96 | **0** |

**183 Medical Records tickets have landed since the map was written, and not one
carries a routing note.** Dept 17 behaves exactly as §3.4 predicts (driven by the
Eye Care/Sage service, outside both repos) — but **15 and 16 arrive via
`answering-service`, which is the `submit-ticket` path Guard #1 governs.**

So one of these is true, and it needs confirming in the app:
- the allow-list was widened after 2026-07-30, or
- the guard is not applied on this branch, or
- these depts are resolved somewhere downstream of it.

**This also means ruling C3 is being violated at scale.** MASTER §9 C3:
*"Medical Records (16): no voice-agent routing"* — records is *"an entirely new
process."* Production is routing ~180 records requests a month into it from the
answering service, and §6 of ROUTING-MAP says each one inline-creates an
`mr_cases` row. Whether that is now desirable is **an operator decision, not a
code question.**

---

## 4. F-10 confirmed, current, and unimproved

14-day window, 4,002 tickets:

| Check | Doc (2026-07-30) | Measured (2026-08-11) |
|---|---|---|
| Reason does not belong to its type | 35% | **36.3%** (1,451) |
| No request type at all | 27% | **24.5%** (981) |
| Type belongs to a different department | — | **0** ✅ |
| Inactive request types / reasons | 0 / 0 | **0 / 0** |

The type→department chain is clean; the reason→type chain is broken on more than
a third of tickets. Nothing has been retired, ever — consistent with the doc.

**For the rebuild:** any department agent that reads `request_reason_id` to
decide anything will be wrong a third of the time. Treat reason as advisory
until the constraint exists.

---

## 5. The one thing that works — and the pattern to copy

MASTER §9 C5 hard-requires location (Optical) and surgeon (Surgery), enforced by
the app returning `missingFields` so the agent re-asks conversationally.

| Department | Requirement | Tickets | Missing |
|---|---|---|---|
| 2 Surgery Coordination | surgeon | 3,531 | **15 — 0.4%** |
| 1 Optical Support | location | 1,685 | **32 — 1.9%** |

**This is the highest-performing control in the entire system.** Prompt rules
alone never achieved 0.4%; server-side refusal did.

**Carry this into the rebuild as the enforcement model:** the tool refuses with
a machine-readable `missingFields`, and the agent re-asks. Not "the prompt says
to collect it."

---

## 6. What the docs do not cover — measured here first

These are not in MASTER, ROUTING-MAP or the codebase map:

1. **`submit-ticket` latency: p50 3.6s, p95 22.8s, p99 32.7s, max 319s.**
   One in four submissions leaves the caller waiting over 5s; one in thirteen
   over 15s.
2. **Provider-name resolution fails 19.7%** (3,088 of 15,663) and **doubles
   latency** — 5,184ms → 10,741ms average, 4.1% → 21.5% over 15 seconds. 48% of
   the worst waits are provider-match failures.
   - ~448 are diagnostic codes sent as a provider (`OCT-VF` 217, `A-Scan` 123,
     `DRS` 108).
   - ~200 are credential suffixes: `Todd Mishima, OD` fails although Mishima is
     in `providers`.
   - The Schedule-DB fallback **rescues the routing** (only 0.4% end with no
     provider) but the caller pays the wait.
3. **Location resolution fails 15.5%** (2,385 of 15,411), dominated by **surgery
   centers that do not exist in `locations` at all** —
   `select count(*) from locations where name ilike '%surgery%'` returns **0**.
4. **Classification itself is healthy**: `usedFallbackReason` is true on 88 of
   17,116 (0.5%).

Item 2 is the highest-value fix available: it is simultaneously the largest
dead-air source and pure data hygiene, and roughly 650 of the 3,088 failures are
fixable at the tool layer alone.

---

## 7. Revised priority order

1. **Provider resolver** — strip `, OD` / `, MD`; reject `OCT-VF` / `A-Scan` /
   `DRS` / `Unknown` as *not a provider* rather than searching. Removes ~650
   fallback round-trips and the dead air with them.
2. **Load surgery centers into `locations`** — no string matching finds a row
   that is not there.
3. **Confirm Guard #1's real behaviour**, then get an operator ruling on
   Medical Records (C3 says no voice routing; production does ~180/month).
4. **`session.end` + a hard call-duration cap** (see `PLATFORM-DECISION.md` §3)
   — worth ~$1,059/month and independent of everything above.
5. **F-10 constraint** — or treat `request_reason_id` as advisory.
6. **§7.1 urgent flattening** — when after-hours returns, not before.

---

## 8. Still unverifiable without the repo

`ticketing-app` is outside this session's allow-list; GitHub **code search**
reaches it, file reads and clone do not. Open:

- What exactly makes `submit-ticket` slow — the welcome SMS (inline
  `gpt-4o-mini` + Twilio, codebase map §5 step 12) and the provider fallback are
  both candidates; only the latter is proven.
- Whether `VOICE_ALLOWED_DEPARTMENTS` still reads `{1,2,3,4,8,9}`.
- Whether the Batch 2a department guard is on the `submit-ticket` path.
