# The Eye Care scheduling service — the model to copy

**Part 4 of the rebuild spec.** Source: `wfabian31773/eyecare-scheduling-agent`
(read directly from the repo, 2026-08-11).

**Headline: the tool library Wayne described already exists, for scheduling.**
It is running in production. The ticketing side should be built to match it
rather than invented from scratch.

---

## 1. It already has the architecture we were about to design

| What Wayne asked for | What the service already does |
|---|---|
| A shared library agents pull from | `lib/tools.ts` — **41 low-level tools** with `name`, `description`, `input_schema` |
| Agent-facing tools with guardrails | **14 `sage_*` tools** in `lib/scheduling-intel/sage-tools.ts` — rules-gated wrappers over the primitives |
| Tools configurable without a deploy | `GET /api/tools` returns the **whole manifest** — name, description, JSON schema |
| One auth story | Bearer `EYECARE_AGENT_API_KEY`, or same-origin |
| One endpoint shape | `POST /api/tools/<name>` |

`api/tools/[name].ts:319` resolves a call from **either** registry:

```ts
const tool = TOOLS_BY_NAME.get(name) ?? SAGE_TOOLS_BY_NAME.get(name);
```

**This two-layer split is exactly right and should be the pattern for
ticketing:** dumb primitives underneath, a small set of guarded, voice-facing
tools on top. An agent never touches the primitives.

### The 14 voice-facing tools

`sage_precontext`, `sage_patient_context`, `sage_decision`, `sage_availability`,
`sage_book`, `sage_reschedule`, `sage_confirm_appointment`,
`sage_new_patient_intake`, `sage_insurance_check`, `sage_info`, `sage_practice`,
`sage_handoff`, `sage_record_transfer_bridge`, `sage_resolve_callback`

Two of these — `sage_record_transfer_bridge` and `sage_resolve_callback` — were
missing from Part 1's inventory, which was built from the voice repo only.

---

## 2. Defect: the manifest does not describe the tools that matter

`api/tools/index.ts` builds the manifest from `TOOLS` only:

```ts
tools: TOOLS.map((t) => ({ name, description, input_schema }))
```

`TOOLS` is the **41 primitives**. The **14 `sage_*` tools are absent from
`GET /api/tools`** — and so is the 404 handler's `availableTools` list
(`[name].ts:323`), which also enumerates `TOOLS_BY_NAME` only.

So: the tools a voice agent should call are **invisible to discovery**, while
the ones it should never call are fully published.

This matters directly for the migration. If we point AssemblyAI (or any
platform) at `GET /api/tools` to learn the surface, it gets the wrong 41 and
misses all 14 that matter. **Fix: include `SAGE_TOOLS` in the manifest**, ideally
with a `layer: "agent" | "primitive"` field so a consumer can filter.

Small change. Large consequence.

---

## 3. Root cause of every ticketing location failure

Part 3 found 18 of 19 `create-ticket` validation failures were
`No active location matches 'Azul Vision Oceanside' / 'Azul Vision Encinitas'`.
The reason is now fully explained, and it is **not an agent bug.**

`lib/tools.ts` translates location names at the tool-output boundary:

```ts
// "Atlantis Eyecare Encinitas"  ->  "Azul Vision Encinitas"
export function brandifyLocationName(name) {
  if (name.startsWith("Atlantis Eyecare ")) return "Azul Vision " + name.slice(17);
  return name;
}
export function presentLocationName(name) {
  return correctLocationName(brandifyLocationName(name));
}
```

**Two systems, two naming conventions, nothing translating between them:**

| System | Name for the same clinic |
|---|---|
| NextGen master data | `Atlantis Eyecare Encinitas` (legacy) |
| Eye Care service, after `brandify` | **`Azul Vision Encinitas`** |
| Support Center `locations` table | **`Encinitas`** |

The agent learns the brandified name from scheduling context — correctly, that
is what it should say to a patient — then passes it to ticketing, which stores
bare city names. The match fails. **The agent did nothing wrong.**

It gets worse in two specific spots the corrections table already documents:

- **`Azul Vision Willow` is the Long Beach clinic**, surfaced as
  `Azul Vision Willow (Long Beach)`. The Support Center has *both*
  `Long Beach` (19) **and** `Long Beach Willow` (20).
- Typos are baked into NextGen master data and corrected only on the eyecare
  side: `Azul Vision Mission Hlls`, `Los  Alamitos Medical Center` (double
  space), and three truncated "Offsite Fundus Screening" names.

And the failure from Wayne's live call —
`Location "Loma Linda Surgery Center LLC" not found in system` — is a third
class again: **surgery centers exist in the schedule but not in the Support
Center's 33-row `locations` table at all.**

### What the library needs

**One location resolver, owned by the tool library, used by every tool that
accepts a location.** It must:

1. Strip a leading `Azul Vision ` / `Atlantis Eyecare ` before matching.
2. Apply the existing `LOCATION_NAME_CORRECTIONS` map — **do not re-derive it,
   it encodes real NextGen data defects.**
3. Match case-insensitively, and on city as well as name (the `Willow` case).
4. Accept the `LOCATION_ALIASES` already defined.
5. Return **"unresolved, here is the raw string"** rather than failing the whole
   ticket. A patient's refill must not be lost because a clinic name did not
   match.
6. Know that surgery centers are not clinics.

Rules 1–4 are **reuse, not new code.** The logic exists in `lib/tools.ts`; it
simply never crossed into ticketing.

---

## 4. Still blocked

`wfabian31773/ticketing-app` is **not in this session's repository scope**
(allowed: `5star`, `agent-operation-hub`,
`openai-realtime-api-voice-assistant-remix`, `eyecare-scheduling-agent`), and
the tool to add it is not available in this session. **Wayne must add it.**

Without it I cannot answer:

- What makes `submit-ticket` take 22.8s at p95 and 319s at worst (Part 3 §3).
- How server-side classification picks department / type / reason — the logic
  that lets department agents keep small prompts.
- Whether `create-ticket` can be retired safely.
- What the location resolver on that side currently does.

**These are the last four unknowns before the tool library can be specified
completely.**
