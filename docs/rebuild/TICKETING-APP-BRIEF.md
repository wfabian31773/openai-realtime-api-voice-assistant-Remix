# Brief for the ticketing-app agent

**From:** the agent working in `openai-realtime-api-voice-assistant-remix` (the
voice side). **To:** whoever is working in `wfabian31773/ticketing-app`.
**Written 2026-08-11.** Operator: Wayne.

I cannot read your repo — it is outside my session's allow-list. Everything
below about your code came from GitHub code search, and everything about
behaviour came from the live databases. **Re-verify anything you intend to act
on; every claim here ships with the query that produced it.**

---

## 0. The one rule, decided by the operator today

> NextGen is the source of truth. It is mirrored into the **Eye Care Patient
> Console** for speed — so a lookup is a local query, not a live NextGen API
> call that can be slow or fail. **Nothing queries NextGen directly, and
> nothing keeps its own third copy.**

Two projections of that source are legitimate:

| Projection | Purpose |
|---|---|
| `si_providers` / `si_locations` (Console) | the roster — 77 providers, 105 locations, **synced daily** |
| `Schedule` (Operations Hub) | a denormalised read model for fast patient lookup on a live call |

Anything else holding provider or location identity is a copy that will drift.
**Your `providers` (92 rows) and `locations` (33 rows) tables are that copy.**

---

## 1. What my side already does — build to this contract

Shipped and verified in production this morning (commit `6cf0a69`):

- Every provider name we send is **cleaned before it leaves us**: credential
  suffixes (`, OD` / `, M.D.` / `, DNP`) and honorifics (`Dr.`) stripped,
  double spaces collapsed.
- Values that are **not people** are no longer sent at all — `OCT-VF`,
  `A-Scan`, `DRS`, `Unknown`, `Desconocido`, `No especificado`, `Not yet
  assigned`, and the rest of that family. Previously 483 lookups in 90 days.
- Location names have the **brand prefix stripped** (`Azul Vision Encinitas`
  → `Encinitas`).
- Names are checked against `si_providers` / `si_locations` before sending; a
  name the mirror has never heard of is dropped rather than sent.

**Measured on the first 10 tickets after deploy:** 6 carried a provider from
us, **0 still suffixed, 6 matched, 0 failed.** The remaining names you see with
`, MD` are ones **your** side derived server-side — we sent nothing on those
calls.

**So: assume inbound `lastProviderSeen` and `locationOfLastVisit` are already
canonical and clean.** If you see a dirty one, tell Wayne — it means something
bypassed our sanitizer.

---

## 2. The work, ranked

### W1 — Feed `providers` and `locations` from the Console *(highest value)*

**Evidence.** Seven providers in the mirror cannot be matched from your tables,
carrying **11,296 appointments in 90 days**. Not formatting — genuinely
different names for the same person:

| 90-day vol | Console `nextgen_name` | Your `providers` | Failure |
|---|---|---|---|
| 3,628 | `Talin Khachatoor Sarkissian, O.D.` | `talin khachatoor` | surname truncated |
| 3,594 | `Timothy Hammill, OD` | `timothy hammil` | **spelling, one L vs two** |
| 1,701 | `Claudia Montana Collins, O.D.` | `claudia collins` | middle name dropped |
| 1,266 | `Chris Ciampa, O.D.` | `christopher ciampa` | short form vs full |
| 1,076 | `Evelyn Perez, OD` | *absent* | never synced |
| 31 | `Laura Syniuta, MD` | `dr. laura syniuta` | honorific stored in the name |

This is why `Dr. Sarkissian` and `Talin Khachatoor, OD` both fail — same
doctor, neither form matches.

Also **21 rows exist in your tables that are not in the mirror at all**,
including duplicates under a second form (`minh shaw o.d.` alongside
`minh shaw`). Nothing distinguishes "departed" from "duplicate", because your
copy carries no deleted flag. The Console has `is_deleted_in_nextgen` and
`last_seen_in_nextgen`, so retirement becomes automatic.

**Locations.** Your 33 rows are the active clinics and that is *correct* as far
as it goes — the Console has 32 clinics with volume. The gap is **20 active
surgery centers and 10 screening/mobile sites** that you have none of.
`select count(*) from locations where name ilike '%surgery%'` returns **0**.
Those are where surgery-coordination patients actually go: Chevy Chase (1,817
appointments/90d), Ontario Adv (771), Glenwood (551), Mobile DRS (514),
Barranca (368), Aurora (318), H Jones (280), Loma Linda (80). Plus **Azul
Vision Beaumont**, a plain clinic with 209.

**The Console classifies each one** — `facility_kind` is `clinic`,
`surgery_center`, `screening_site` or `mobile`. That is a distinction your
router currently cannot make and probably wants.

**Do it as a scheduled one-way sync, shipped as a seed script in your repo** —
your own lesson F-8 ("ship taxonomy changes as a seed script, not a manual
admin action") and F-6 ("every baked copy is a cache and needs a working
refresh, or it diverges").

**Do NOT hand-insert the missing rows.** That makes a fourth copy that starts
drifting the day it lands, which is the thing Wayne explicitly ruled out.

**Acceptance:** a provider or location added in NextGen appears in your tables
without anyone touching the admin UI; a retired one disappears; `Evelyn Perez`
resolves.

---

### W2 — Find out why the department guard is not firing

`VOICE_ALLOWED_DEPARTMENTS = new Set([1, 2, 3, 4, 8, 9])` is still present in
`lib/services/voice-agent-ticket-service.ts`, right after
`getDepartmentForRequestType(reasonMapping.requestTypeId)`, and appends a
`[ROUTING NOTE]` when it redirects.

**It is not catching these:**

| Dept | Agent | Since 2026-07-30 | With `[ROUTING NOTE]` |
|---|---|---|---|
| 16 Medical Records | `answering-service` | **183** | **0** |
| 15 OCS Hub | `answering-service` | 59 | **0** |
| 17 Locations | Sage / UUID agents | 96 | 0 |

Dept 17 is explained — ROUTING-MAP §3.4 says it comes from the Eye Care
service, outside the guard. **Depts 15 and 16 arrive via `answering-service`,
which is the `submit-ticket` path the guard governs.** Either the allow-list
was widened after 2026-07-30, the guard sits on a branch these do not take, or
the department is resolved downstream of it.

I could not settle this from search fragments. **You can read the whole file.**

---

### W3 — Taxonomy referential integrity (F-10), still current

14-day window, 4,002 tickets:

- **36.3%** carry a `request_reason_id` that does not belong to their
  `request_type_id` (your doc said 35% — unchanged)
- **24.5%** have no request type at all
- **0** have a type belonging to a different department — that chain is clean
- **0 inactive** request types or reasons; nothing has ever been retired

Consequence for the rebuild: any agent reading `request_reason_id` to decide
anything is wrong a third of the time. Either add the constraint or validate at
write time.

---

### W4 — `submit-ticket` latency

p50 3.6s, **p95 22.8s**, p99 32.7s, **max 319s**. One in four submissions
leaves the caller waiting over 5 seconds; one in thirteen over 15.

**Partially explained.** A failed provider lookup triggers the Schedule-DB
fallback described in your own skill doc, and that roughly doubles it:

```
providerMatched=true    avg  5,184ms    4.1% over 15s
providerMatched=false   avg 10,741ms   21.5% over 15s
```

48% of the worst waits were failed provider matches. **My sanitizer removes a
large share of those**, so measure again before attributing the remainder.

The unexplained part is the floor: ~4–6s even on clean matches. The codebase
map lists an **inline welcome SMS** — one `gpt-4o-mini` generation plus a
Twilio send — running before the response (`create-ticket/route.ts:344-378`),
with making it fire-and-forget noted as optional item 4b and never done. **That
is the first thing I would look at.** A 319-second worst case also exceeds the
300s ceiling any managed voice platform will allow.

---

## 3. Do not do these

- **Do not hand-insert providers or locations.** See W1.
- **Do not change the voice agents' prompts.** Different repo, and the operator
  has been explicit that prompt changes go through him.
- **Do not "fix" the `, OD` suffix by loosening your matcher.** The names are
  already clean on arrival; a fuzzy matcher would mask W1 rather than fix it.
- **Do not retire `create-ticket`.** I nearly recommended it. Your
  `PCP-SUPPORT-SPEC.md` shows it exists so PCP and after-hours can bypass the
  server-side conflict overrides that would otherwise yank a PCP call to
  HVA Hub or Surgery. It is an escape hatch, not legacy.
- **Do not prioritise §7.1 urgent flattening.** Real in code, but 9 tickets in
  90 days and the after-hours agent produced exactly 1. Fix it when that line
  comes back.

---

## 4. Questions for Wayne — do not guess these

1. **Should Medical Records (16) receive voice tickets at all?** Ruling C3 in
   `MASTER.md` says no — records is "an entirely new process". Production is
   doing ~180/month, and each inline-creates an `mr_cases` row. Contract and
   reality disagree; only he can say which changes.
2. **Do PCP records requests belong on the HHS CAP?** A provider-to-provider
   request is plausibly `authorization_disclosure`, not patient right-of-access,
   and would carry no §123110 clock. This is why records work is currently
   written in two places.
3. **OCS Hub (15) and Locations (17)** take voice tickets despite §9 saying
   never. Intentional drift, or drift?

---

## 5. Verify everything here yourself

**Support Center** (yours): Supabase project `vsmcxhxeirkoobmjcrbn`.
**Patient Console** (the mirror): `kbbmywvasbsxnbblrhot`.
**Operations Hub** (voice side): `pslzngjciiifowemrzza`.

```sql
-- W1: providers in the mirror your tables cannot match
select nextgen_name, volume_90d from si_providers
where coalesce(is_deleted_in_nextgen,false) = false
order by volume_90d desc;

-- W1: the facilities you are missing, with their type
select nextgen_name, facility_kind, volume_90d from si_locations
where coalesce(volume_90d,0) > 0 and facility_kind <> 'clinic'
order by volume_90d desc;

-- W2: guard bypass — expect routing notes, find none
select d.name, t.agent_used, count(*),
       count(*) filter (where t.description ilike '%ROUTING NOTE%') as noted
from tickets t join departments d on d.id = t.department_id
where t.department_id in (15,16,17) and t.created_at >= '2026-07-30'
group by 1,2;

-- W3: taxonomy integrity
select count(*) filter (where rr.request_type_id <> t.request_type_id) as reason_wrong_type,
       count(*) filter (where t.request_type_id is null) as no_type,
       count(*) as total
from tickets t left join request_reasons rr on rr.id = t.request_reason_id
where t.created_at >= now() - interval '14 days';

-- W4: latency, and whether provider matching still explains it
select coalesce(response_body->>'providerMatched','(none)') as matched,
       count(*), round(avg(processing_time_ms)) avg_ms,
       percentile_disc(0.95) within group (order by processing_time_ms) p95
from voice_agent_api_logs
where endpoint='/api/voice-agent/submit-ticket'
  and created_at > now() - interval '7 days'
group by 1;
```

---

## 6. Reaching me

There is no direct channel between our sessions — Wayne relays. If you need
something from the voice side (a payload shape, why a field arrives as it does,
a replay of real caller utterances), ask him and I will answer from the voice
repo, where I have full access and a 970-string regression corpus of real
provider names.

**One request in return:** when W1 lands, tell me, so I can re-measure the
provider match rate and tell Wayne what it actually bought. Neither of us can
see that number alone — I can see what we send, you can see what resolves.
