# Identity drift — providers and locations exist in three places

**Part 6 of the rebuild spec.** Measured 2026-08-11.

Wayne's architectural rule, stated plainly:

> Anything NextGen-related — scheduling, providers, locations — is derived from
> the Eye Care agent service. The Patient Console uses those tools to build
> snapshots. **Nothing queries NextGen directly; everything queries the Patient
> Console, which has the mirrors and the snapshots.**

This document measures what happens where that rule is not followed. It is also
a correction: I previously wrote that a provider was "genuinely absent" from the
system. She was not. She was absent from a **copy**.

---

## 1. The three sources

| Source | Providers | Locations | Synced | Authority |
|---|---|---|---|---|
| **Patient Console** `si_providers` / `si_locations` | **77** | **105** | **daily — every row 2026-08-11** | **authoritative** |
| Ticketing app `providers` / `locations` | 92 | 33 | unknown | a copy |
| Operations Hub `Schedule` | free text `RenderingPhysician` / `OfficeLocation` | — | nightly | a projection |

The Console snapshots are rich: `nextgen_name`, `degree`, `facility_kind`,
`volume_30d/90d/12m`, `is_deleted_in_nextgen`, `last_seen_in_nextgen`. They know
which providers are still seeing patients (75 of 77) and what kind of place each
location is.

The ticketing app's tables have none of that, and drift **in both directions**.

---

## 2. Provider drift — 11,296 appointments unreachable

**Seven providers in the mirror are missing from the ticketing app**, and
between them they carry 11,296 appointments in the last 90 days:

| 90-day volume | Canonical name (Console) | In the ticketing app | Why it fails |
|---|---|---|---|
| **3,628** | `Talin Khachatoor Sarkissian, O.D.` | `talin khachatoor` | surname truncated |
| **3,594** | `Timothy Hammill, OD` | `timothy hammil` | **spelling — one L vs two** |
| **1,701** | `Claudia Montana Collins, O.D.` | `claudia collins` | middle name dropped |
| **1,266** | `Chris Ciampa, O.D.` | `christopher ciampa` | short form vs full |
| **1,076** | `Evelyn Perez, OD` | *absent* | not synced at all |
| 31 | `Laura Syniuta, MD` | `dr. laura syniuta` | honorific baked in |
| 0 | `Marialejandra Diaz Ibarra` | *absent* | not synced |

**No string-cleaning rule can fix these.** They are not formatting differences;
they are two systems holding different names for the same person. This is why
`Dr. Sarkissian` (10 failures) and `Talin Khachatoor, OD` (5) both fail — they
are the same doctor, and neither matches.

And **21 entries exist in the ticketing app that are not in the NextGen mirror
at all**:

```
alvaro torres · angela perry · christopher ciampa · cindy van truong ·
claudia collins · dr. laura syniuta · farzad jacob khoubian ·
gautam vangipuram · jeanette tang o.d. · joni lu · kevin h tran ·
ledia samwil · logan m haak · minh shaw o.d. · nhung tran · nicole fuerst ·
priscilla luke · richard phan · stevie olney · talin khachatoor · timothy hammil
```

Some are duplicates of a real provider under a different form
(`minh shaw o.d.` alongside `minh shaw`). Others are presumably people who have
left. Nothing distinguishes the two cases, because the copy carries no
`is_deleted_in_nextgen` flag.

---

## 3. Location drift — the "missing" locations were never missing

Part 3 reported that surgery centers "do not exist" and called it a data gap.
**That was measured against the wrong table.** Every one of them is in the
Console, active, synced today, with volume:

| Location | `facility_kind` | 90-day volume | In ticketing? |
|---|---|---|---|
| Chevy Chase Surgery Center | surgery_center | **1,817** | no |
| Ontario Adv Surgery Center | surgery_center | 771 | no |
| Glenwood Surgery Center | surgery_center | 551 | no |
| Mobile DRS Site | mobile | 514 | no |
| Barranca Surgery Center | surgery_center | 368 | no |
| Los Angeles County Offsite Fundus Screen | screening_site | 330 | no |
| Aurora Surgery Center | surgery_center | 318 | no |
| H Jones Surgery Center | surgery_center | 280 | no |
| Inland Empire Offside Fundus Screening | screening_site | 242 | no |
| **Azul Vision Beaumont** | **clinic** | 209 | no |
| Inland Surgery Center | surgery_center | 89 | no |
| Loma Linda Surgery Center LLC | surgery_center | 80 | no |

**105 locations in the mirror; 33 in the ticketing app.** The Console even
classifies them — `clinic`, `surgery_center`, `screening_site`, `mobile` —
which is exactly the distinction the ticket router needs and does not have.

---

## 4. What this changes

### The sanitizer still earns its place — but it is not the fix

`sanitizeTicketLookupFields` (commit `b11a219`) addresses the **credential and
placeholder** classes: 503 lookups that should never have been sent, and 467
that fail only on `, OD`. That is real and it stands.

It cannot touch the drift class. Those seven providers need the mirror.

### The wrong fix would be to insert into the ticketing app

Loading the twelve missing locations into `locations` creates a **fourth copy**
that starts drifting the day it lands. That is the thing Wayne asked us to stop
doing.

### The right fix, in order of preference

1. **Sync the ticketing app's `providers` and `locations` FROM
   `si_providers` / `si_locations`.** One direction, authoritative, scheduled.
   The Console already carries `is_deleted_in_nextgen` and `last_seen_in_nextgen`,
   so retirement becomes automatic instead of manual. Ships as a seed script in
   the repo, per the ticketing app's own lesson F-8.
2. **Or have the ticketing app resolve names against the Console** and stop
   keeping its own tables at all.

Both are changes to the ticketing app, which is outside this session's access.
**This is an operator decision.**

---

## 5. What we can verify from the Console today

Between `si_providers`, `si_locations`, `si_appointment_facts` (867,735 rows),
`si_persons` (the phone→patient mirror powering caller-ID recognition) and
`patients_master` (910,508), essentially anything a caller says can be checked:

- who they are, from their phone number, before they say a word
- which provider they actually saw, and whether that provider still practises
- which location, and whether it is a clinic, a surgery center or a screening site
- what was scheduled, when, and its outcome

**The verification layer is already built.** The gap is that the ticketing app
does not use it.

---

## 6. Correction log

- **"Evelyn Perez is genuinely absent from the providers table."** Wrong. She is
  in `si_providers` with 1,076 appointments in 90 days, synced today. Absent
  from the ticketing app's copy only. Corrected in
  `providerNameCorpus.ts` and `providerCorpus.test.ts`.
- **"Surgery centers do not exist in the locations table"**, stated as a data
  gap. Accurate about the ticketing app, wrong as a statement about the system.
  All twelve are in `si_locations`, active, with volume.
