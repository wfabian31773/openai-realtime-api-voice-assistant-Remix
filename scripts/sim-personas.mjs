#!/usr/bin/env node
/**
 * Simulation rig v1 (Phase 6) — scripted caller personas against the REAL
 * deployed service, so the operator's phone is the LAST check, never the
 * first. Runs the tool layer headless with the same headers the azul voice
 * agent sends (X-Pilot-Fence, X-Zero-Id) and asserts the contracts that
 * every post-mortem this week taught us to enforce:
 *
 *   - zero-identifier: NO GUID/token ever appears in a zero-id response
 *   - mint health: availability returns say + numbered offer_options
 *     (the int4-overflow bug class — silent mint death — fails loudly here)
 *   - identity gates: person-required tools refuse without verification
 *   - KB: mundane questions answered, found=true
 *   - directive sanity: decision gate allows the pilot event type
 *
 * SAFE against production: read-only calls + refusal paths + one token
 * mint under a sim- callId (rows purge in the daily cron). NO bookings,
 * NO cancellations, NO patient writes.
 *
 * Usage:  EYECARE_AGENT_API_KEY=... node scripts/sim-personas.mjs
 * Env:    SIM_BASE_URL (default: production service URL)
 * Exit:   0 all personas pass; 1 any failure (wire into deploy checks).
 */

const BASE =
  process.env.SIM_BASE_URL ||
  "https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app";
const KEY = process.env.EYECARE_AGENT_API_KEY;
if (!KEY) {
  console.error("EYECARE_AGENT_API_KEY is required");
  process.exit(1);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const runId = `sim-${Math.random().toString(36).slice(2, 10)}`;

async function call(tool, body) {
  const r = await fetch(`${BASE}/api/tools/${tool}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "X-Pilot-Fence": "1",
      "X-Zero-Id": "1",
      "X-Source": "sim-rig",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { unparsed: text }; }
  return { status: r.status, body: json?.result ?? json, raw: text };
}

/** No GUIDs anywhere in a zero-id response — the parrot-vocabulary rule.
 *  callId echoes (sim-*) and phone numbers are not UUIDs, so a plain
 *  regex sweep over the serialized body is exact. */
function assertNoGuids(name, raw, failures) {
  const hit = raw.match(UUID_RE);
  if (hit) failures.push(`${name}: GUID leaked in zero-id response: ${hit[0]}`);
}

function nextTuesday() {
  const d = new Date();
  d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

const personas = [
  {
    name: "info-hours (KB, zero handoffs)",
    run: async (f) => {
      const r = await call("sage_info", { question: "What are your office hours in Encinitas?", locationName: "Encinitas" });
      if (r.body?.found !== true || !r.body?.say) f.push("sage_info: hours not answered from KB");
      assertNoGuids("sage_info", r.raw, f);
    },
  },
  {
    name: "directive-sanity (decision gate)",
    run: async (f) => {
      const r = await call("sage_decision", { intent: "search", eventName: "Refraction Only", locationName: "Encinitas" });
      if (r.body?.decision !== "allowed") f.push(`sage_decision: expected allowed, got ${r.body?.decision} (${r.body?.reason ?? "no reason"})`);
      assertNoGuids("sage_decision", r.raw, f);
    },
  },
  {
    name: "mint-health (availability directive + numbered offers)",
    run: async (f) => {
      const r = await call("sage_availability", {
        eventName: "Refraction Only", preferredDate: nextTuesday(), timeOfDay: "PM",
        locationName: "Encinitas", callId: `${runId}-avail`,
      });
      if (r.body?.token_mint_error) f.push(`availability: TOKEN MINT FAILED: ${r.body.token_mint_error}`);
      const opts = r.body?.offer_options;
      if (Array.isArray(opts) && opts.length > 0) {
        if (!r.body?.say) f.push("availability: offers minted but no 'say' directive");
        if (!opts.every((o) => Number.isFinite(o?.optionNumber))) f.push("availability: offer_options missing optionNumber");
        if (opts.some((o) => o?.token)) f.push("availability: token leaked through zero-id strip");
      } else if (r.body?.next_action !== "zero_availability_ladder" && r.body?.next_action !== "handoff_required") {
        f.push(`availability: no offers AND no ladder/handoff next_action (got ${r.body?.next_action ?? "none"})`);
      }
      assertNoGuids("sage_availability", r.raw, f);
    },
  },
  {
    name: "identity-gate: book refuses unverified call",
    run: async (f) => {
      const r = await call("sage_book", { optionNumber: 1, callId: `${runId}-noverify` });
      if (r.body?.error !== "identity_required") f.push(`sage_book unverified: expected identity_required, got ${r.body?.error ?? JSON.stringify(r.body).slice(0, 120)}`);
    },
  },
  {
    name: "identity-gate: cancel refuses unverified call",
    run: async (f) => {
      const r = await call("cancel_appointment", { appointmentOrdinal: 1, callId: `${runId}-noverify` });
      if (r.body?.error !== "identity_required") f.push(`cancel unverified: expected identity_required, got ${r.body?.error ?? JSON.stringify(r.body).slice(0, 120)}`);
    },
  },
  {
    name: "identity-gate: patient context refuses unverified call",
    run: async (f) => {
      const r = await call("sage_patient_context", { callId: `${runId}-noverify` });
      if (r.body?.error !== "identity_required") f.push(`patient_context unverified: expected identity_required, got ${r.body?.error ?? JSON.stringify(r.body).slice(0, 120)}`);
    },
  },
  {
    name: "zero-id read sweep (locations + providers)",
    run: async (f) => {
      const a = await call("lookup_location", { name: "Encinitas" });
      assertNoGuids("lookup_location", a.raw, f);
      const b = await call("list_locations", {});
      assertNoGuids("list_locations", b.raw, f);
      const c = await call("get_provider_locations", { providerName: "Wernow" });
      assertNoGuids("get_provider_locations", c.raw, f);
      if (c.body?.error === "provider_ambiguous_or_unknown") {
        // acceptable directive, not a failure — but note it
        console.log("    note: 'Wernow' did not uniquely resolve — corrective directive returned (by design)");
      }
    },
  },
];

const results = [];
for (const p of personas) {
  const failures = [];
  const t0 = Date.now();
  try {
    await p.run(failures);
  } catch (e) {
    failures.push(`threw: ${e?.message ?? e}`);
  }
  results.push({ name: p.name, ok: failures.length === 0, ms: Date.now() - t0, failures });
  console.log(`${failures.length === 0 ? "PASS" : "FAIL"}  ${p.name} (${Date.now() - t0}ms)`);
  for (const msg of failures) console.log(`      ✗ ${msg}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} personas passed (${runId})`);
process.exit(failed.length ? 1 : 0);
