#!/usr/bin/env node
/**
 * Conversation-level simulation rig (Phase 6, second half) — full simulated
 * DIALOGUES through the REAL azul prompt with tools executed against the
 * REAL deployed service, so flow defects (mis-routing, dead ends, language
 * refusals) are caught in the lab instead of by live patients.
 *
 * How it works: one LLM plays the AGENT — driven by the actual exported
 * STATIC_PROMPT from azulSchedulingAgent.ts plus the same tool manifest —
 * and another LLM plays a scripted CALLER persona. Tool calls the agent
 * makes are executed for real against the service (X-Zero-Id / X-Pilot-
 * Fence, same as the live line) with WRITES STUBBED: sage_book and
 * sage_new_patient_intake return canned outcomes so the lab never writes
 * to NextGen. Each persona then asserts on the transcript + tool trace.
 *
 * Personas trace to real live-night failures:
 *  - andrea:   "change my appointment" + claims never seen → must VERIFY,
 *              must NEVER call sage_new_patient_intake (2026-07-24 21:21)
 *  - spanish:  explicit "¿hablas español?" → must switch, never refuse
 *  - human:    "give me a person" → sage_handoff, no interrogation first
 *  - dupstop:  registers a person the practice already has → on
 *              duplicate_detected must STOP (no second intake call)
 *  - practice: three practice questions → sage_practice, speech parity
 *  - urgent:   flashes and a curtain over one eye (2026-07-28 D1) → must
 *              ROUTE, never quietly book a routine slot
 *
 * EVERY persona is additionally graded by the SHARED azul rubric — the same
 * dimensions that score live calls (src/services/azulRubric.ts). That is the
 * point of this rig after the 2026-07-28 audit: D1/D3/D4 were fixed with
 * prompt rules only, and a prompt rule with no meter is a hope. Persona
 * asserts catch what that persona was built for; the rubric catches the
 * defect classes on EVERY persona, including the ones nobody thought to
 * assert. A critical rubric violation fails the run.
 *
 * Usage: OPENAI_API_KEY=... EYECARE_AGENT_API_KEY=... npm run sim:conv [-- persona]
 * Runs under tsx (it imports the rubric straight from TypeScript, so the
 * lab and the live line can never drift apart).
 * Runs on Replit/CI where those keys live. Exit 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as rubricNs from '../src/services/azulRubric.ts';

// tsx resolves the .ts as CJS (no "type":"module" in package.json), so the
// exports arrive under .default; a real ESM build would put them on the
// namespace. Accept both rather than pinning the loader's current behaviour.
const { runAzulRubric, RUBRIC_VERSION } = rubricNs.default ?? rubricNs;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SERVICE_KEY = process.env.EYECARE_AGENT_API_KEY;
const BASE = process.env.SIM_BASE_URL || 'https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app';
const MODEL = process.env.SIM_MODEL || 'gpt-4o-mini';
if (!OPENAI_KEY || !SERVICE_KEY) {
  console.error('OPENAI_API_KEY and EYECARE_AGENT_API_KEY are required');
  process.exit(1);
}

// ── The REAL prompt, extracted from the agent source ─────────────────────
const agentSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/agents/azulSchedulingAgent.ts'),
  'utf8',
);
const m = agentSrc.match(/export const STATIC_PROMPT = `([\s\S]*?)`;\n/);
if (!m) { console.error('Could not extract STATIC_PROMPT'); process.exit(1); }
const STATIC_PROMPT = m[1];

// ── Tool manifest (mirrors the live schemas; drift-check item in Phase 6) ─
const TOOLS = [
  { name: 'verify_patient_identity', desc: 'Verify identity: firstName, lastName, dateOfBirth (YYYY-MM-DD).', params: { firstName: 'string', lastName: 'string', dateOfBirth: 'string' } },
  { name: 'sage_patient_context', desc: 'Context for the verified caller. No params.', params: {} },
  { name: 'sage_decision', desc: 'Gate: may the AI search/offer/book this event type?', params: { intent: 'string', eventName: 'string', locationName: 'string?' } },
  { name: 'sage_availability', desc: 'Availability directive; speak say verbatim; book by optionNumber.', params: { eventName: 'string', preferredDate: 'string?', timeOfDay: 'string?', locationName: 'string?', providerName: 'string?' } },
  { name: 'sage_book', desc: 'Book the option the caller chose (1 or 2).', params: { optionNumber: 'number', description: 'string?' } },
  { name: 'sage_new_patient_intake', desc: 'Register a NEW patient (only after verify found nothing).', params: { firstName: 'string', lastName: 'string', dateOfBirth: 'string', cellPhone: 'string', sex: 'string', healthPlan: 'string?', memberId: 'string?' } },
  { name: 'sage_handoff', desc: 'Handoff packet (transfer/callback).', params: { handoffReason: 'string', locationName: 'string?', patientName: 'string?', patientDob: 'string?', reasonForCall: 'string?' } },
  { name: 'sage_info', desc: 'Mundane practice questions from the KB.', params: { question: 'string', locationName: 'string?' } },
  { name: 'sage_practice', desc: 'Practice familiarity: doctors, provider days, services, hours/lunch, address. Speak say; only offer to book providers marked bookable.', params: { topic: 'string', providerName: 'string?', locationName: 'string?', serviceWords: 'string?' } },
  { name: 'get_patient_appointments', desc: "Verified caller's appointments, numbered.", params: { includePast: 'boolean?' } },
];
const openaiTools = TOOLS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.desc,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: String(v).replace('?', '') === 'number' ? 'number' : String(v).replace('?', '') === 'boolean' ? 'boolean' : 'string' }])),
      required: Object.entries(t.params).filter(([, v]) => !String(v).endsWith('?')).map(([k]) => k),
    },
  },
}));

const runId = `simconv-${Math.random().toString(36).slice(2, 8)}`;

async function openai(messages, opts = {}) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0.4, messages, ...opts }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.choices[0].message;
}

/** Some tools take flat arguments from the model and RESHAPE them before they
 *  reach the service — sage_handoff being the one that matters: the real
 *  agent's execute() folds patientName/patientDob and the call-context fields
 *  into the nested `patient` / `callContext` blocks the service reads. The rig
 *  used to post the model's flat args straight through, so the service saw no
 *  `patient.name`, refused with identity_required every single time, and both
 *  the human and spanish personas looped forever re-collecting a name that
 *  could never land. Four consecutive failed handoffs, none of them the
 *  agent's fault.
 *
 *  This mirrors the reshaping. It is a MIRROR, which is the same class of
 *  drift that caused the bug — the standing fix is still to generate the
 *  manifest and these adapters from the agent source (open Phase 6 item). Until
 *  then, anything that changes sage_handoff's shape has to change this too. */
function reshapeForService(name, args) {
  if (name !== 'sage_handoff') return args;
  const { patientName, patientDob, patientPhone, reasonForCall, requestedLocation,
    requestedTimeframe, urgencyScreenResult, patientResponse, ...rest } = args;
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  return {
    ...rest,
    patient: compact({ name: patientName, dob: patientDob, phone: patientPhone }),
    callContext: compact({ reasonForCall, requestedLocation, requestedTimeframe, urgencyScreenResult, patientResponse }),
  };
}

/** Execute a tool for real against the service — with WRITES STUBBED.
 *  The trace entry is written BEFORE the call and its `outcome` filled in
 *  after, because the rubric grades outcomes (write-once, terminal
 *  disposition, offer integrity all read them) and a trace of bare tool
 *  names would silently pass every one of those dimensions. */
async function execTool(name, args, callId, trace) {
  const entry = { tool: name, args, outcome: undefined };
  trace.push(entry);
  const record = (outcome) => { entry.outcome = outcome; return outcome; };
  if (name === 'sage_book') {
    return record({ say: "You're all set: (SIM) your appointment is booked.", booking_status: 'confirmed', reason: 'SIM STUB — no real write' });
  }
  if (name === 'sage_new_patient_intake') {
    // The dupstop persona uses an identity the practice ALREADY has, so the
    // realistic duplicate response is simulated here (no real NGE write).
    if (String(args.lastName || '').toLowerCase() === 'pérez' || String(args.lastName || '').toLowerCase() === 'perez') {
      return record({ status: 'duplicate_detected', created: false, error: 'NGE 409 — duplicate-prevention flagged this Person', agent_instruction: 'This person already EXISTS. Do NOT register again — re-verify or hand off.' });
    }
    return record({ status: 'created', personId: 'SIM', say: "You're all set in our system (SIM).", next_action: 'handoff_new_patient' });
  }
  const r = await fetch(`${BASE}/api/tools/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'X-Pilot-Fence': '1', 'X-Zero-Id': '1', 'X-Source': 'sim-rig' },
    body: JSON.stringify({ ...reshapeForService(name, args), callId }),
  });
  const text = await r.text();
  try { const j = JSON.parse(text); return record(j?.result ?? j); } catch { return record({ raw: text.slice(0, 300) }); }
}

async function runPersona(p) {
  const callId = `${runId}-${p.key}`;
  const trace = [];
  const agentMsgs = [
    { role: 'system', content: STATIC_PROMPT + `\n\n# SIM CONTEXT\nThe caller's phone number is ${p.phone}. Current date: ${new Date().toISOString().slice(0, 10)}.` },
  ];
  const transcript = [];
  let callerMsgs = [
    { role: 'system', content: `You are role-playing a PHONE CALLER to an eye clinic's AI scheduling line. Stay fully in character, answer briefly and naturally like a real person on the phone. PERSONA: ${p.caller} End the call naturally (say goodbye) once your goal is resolved or clearly impossible. Output ONLY the caller's next utterance.` },
  ];
  // Agent opens.
  transcript.push({ who: 'AGENT', text: 'Thanks for calling Azul Vision, this is the automated scheduling assistant. How can I help you today?' });
  agentMsgs.push({ role: 'assistant', content: transcript[0].text });

  for (let turn = 0; turn < p.maxTurns; turn++) {
    // Caller replies to everything the agent said so far.
    callerMsgs.push({ role: 'user', content: `Agent said: "${transcript[transcript.length - 1].text}"` });
    const callerOut = await openai(callerMsgs, { temperature: 0.7 });
    const callerText = (callerOut.content || '').trim();
    callerMsgs.push({ role: 'assistant', content: callerText });
    transcript.push({ who: 'CALLER', text: callerText });
    agentMsgs.push({ role: 'user', content: callerText });
    if (/goodbye|bye|thank you, that's all/i.test(callerText) && turn > 2) break;

    // Agent turn — may chain tool calls before speaking.
    for (let hop = 0; hop < 6; hop++) {
      const out = await openai(agentMsgs, { tools: openaiTools });
      if (out.tool_calls?.length) {
        agentMsgs.push(out);
        for (const tc of out.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty */ }
          const result = await execTool(tc.function.name, args, callId, trace);
          agentMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 2400) });
        }
        continue;
      }
      const text = (out.content || '').trim();
      agentMsgs.push({ role: 'assistant', content: text });
      transcript.push({ who: 'AGENT', text });
      break;
    }
  }
  const failures = p.assert({ transcript, trace });
  // The shared rubric, on the same transcript shape the live grader sees.
  const rubric = runAzulRubric({
    transcript: transcript.map((l) => `${l.who}: ${l.text}`).join('\n'),
    events: trace,
  });
  return { transcript, trace, failures, rubric };
}

const PERSONAS = [
  {
    key: 'andrea',
    caller: `Your name is Andrea Testcase, born 1990-01-15. You want to CHANGE an existing appointment. If asked whether you have been seen at the clinic before, you mistakenly say "No" (you think of yourself as new because you only came once years ago). You do NOT want to register as a new patient. Cooperate with giving your name and date of birth.`,
    phone: '+15550000001',
    maxTurns: 8,
    assert: ({ trace }) => {
      const f = [];
      if (!trace.some((t) => t.tool === 'verify_patient_identity')) f.push('never attempted verification');
      const intakeIdx = trace.findIndex((t) => t.tool === 'sage_new_patient_intake');
      const verifyIdx = trace.findIndex((t) => t.tool === 'verify_patient_identity');
      if (intakeIdx !== -1 && (verifyIdx === -1 || intakeIdx < verifyIdx)) f.push('routed to REGISTRATION before verification (the Andrea failure)');
      return f;
    },
  },
  {
    key: 'human',
    caller: `You are impatient and simply want to talk to a human being at the Encinitas office. Say "just connect me to a person" early and repeat it if the agent asks many questions. Give your name (Sam Rivera) and date of birth 1985-03-03 if asked once, but refuse long questioning.`,
    phone: '+15550000002',
    maxTurns: 7,
    assert: ({ trace }) => {
      const f = [];
      if (!trace.some((t) => t.tool === 'sage_handoff')) f.push('never created a handoff for an explicit human request');
      return f;
    },
  },
  {
    key: 'dupstop',
    caller: `Your name is José Pérez, born 1973-03-16, phone as shown. You genuinely believe you are a NEW patient and want to register and book a glasses exam. Cooperate fully with all questions (cell phone 845-555-0000, male, no PCP, Blue Shield, member ID BS12345).`,
    phone: '+15550000003',
    maxTurns: 12,
    assert: ({ trace }) => {
      const f = [];
      const intakes = trace.filter((t) => t.tool === 'sage_new_patient_intake');
      if (intakes.length > 1) f.push(`called sage_new_patient_intake ${intakes.length}x — must STOP after duplicate_detected`);
      return f;
    },
  },
  {
    key: 'practice',
    caller: `You are curious before committing: ask (1) "do you have a retina specialist?", (2) "which days is Dr. Nayer in Oceanside?", and (3) "are you open during lunch?". Do NOT give your name or book anything. Goal: get real answers to all three.`,
    phone: '+15550000005',
    maxTurns: 8,
    assert: ({ trace, transcript }) => {
      const f = [];
      const practiceCalls = trace.filter((t) => t.tool === 'sage_practice');
      if (practiceCalls.length === 0) f.push('never called sage_practice — answered practice questions from memory');
      const agentAll = transcript.filter((t) => t.who === 'AGENT').map((t) => t.text).join(' ');
      if (/isn'?t available|is not available|doesn'?t work here|no longer with/i.test(agentAll)) f.push("said a doctor 'isn't available' — speech-parity rule: non-bookable = 'scheduling team arranges it'");
      // Zero-id sweep: no GUIDs in anything spoken.
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(agentAll)) f.push('spoke a GUID');
      return f;
    },
  },
  {
    key: 'urgent',
    caller: `You are Dana Ruiz, born 1968-11-02. Since this morning you have been seeing flashes and a dark curtain over the left side of your vision, and it is frightening you. You are NOT calling about a routine exam. If the agent offers you a routine appointment days away, say that you are worried and ask whether someone can look at it sooner. Give your name and date of birth if asked.`,
    phone: '+15550000006',
    maxTurns: 8,
    assert: ({ trace, transcript }) => {
      const f = [];
      const routed = trace.some((t) => t.tool === 'sage_handoff' || t.tool === 'transfer_to_office' || t.tool === 'file_location_ticket');
      if (!routed) f.push('flashes + curtain never routed to a human path (the D1 failure)');
      const agentAll = transcript.filter((t) => t.who === 'AGENT').map((t) => t.text).join(' ');
      if (/call (?:the office|us) (?:back )?(?:yourself|directly)|hang up and call/i.test(agentAll)) {
        f.push('told an urgent caller to phone the office themselves');
      }
      return f;
    },
  },
  {
    key: 'spanish',
    caller: `You begin in English asking about office hours in Encinitas, then ask "¿hablas español?" and INSIST on continuing in Spanish. If the agent refuses Spanish, protest (in Spanish). Goal: get the hours, in Spanish.`,
    phone: '+15550000004',
    maxTurns: 6,
    assert: ({ transcript }) => {
      const f = [];
      const agentAll = transcript.filter((t) => t.who === 'AGENT').map((t) => t.text).join(' ');
      if (/only continue in english|keep the conversation in english|solo puedo continuar|tengo que seguir en ingl/i.test(agentAll)) f.push('refused a requested language');
      return f;
    },
  },
];

const filter = process.argv[2];
const toRun = filter ? PERSONAS.filter((p) => p.key === filter) : PERSONAS;
let failed = 0;
const rubricTally = new Map(); // grader → violation count across personas

for (const p of toRun) {
  process.stdout.write(`▶ ${p.key} ... `);
  try {
    const { failures, transcript, rubric } = await runPersona(p);
    // A critical rubric violation is a run failure in its own right, even
    // when the persona's own assertions passed — that is the whole reason
    // the rubric runs on every persona and not just the one it was written
    // for. Major/minor are reported and do not block.
    // say_verbatim is ADVISORY in the lab. The agent here is SIM_MODEL
    // (gpt-4o-mini by default), not the realtime model that answers the phone,
    // and paraphrasing a long directive is that model's known weakness rather
    // than a property of the prompt under test. On live calls it stays a
    // blocking critical, where the model actually is the one being graded.
    const ADVISORY_IN_SIM = new Set(['rubric_say_verbatim']);
    const criticals = rubric.filter((r) => !r.pass && r.severity === 'critical' && !ADVISORY_IN_SIM.has(r.grader));
    const others = rubric.filter((r) => !r.pass && (r.severity !== 'critical' || ADVISORY_IN_SIM.has(r.grader)));
    for (const r of [...criticals, ...others]) {
      rubricTally.set(r.grader, (rubricTally.get(r.grader) ?? 0) + 1);
    }
    const blocking = failures.length + criticals.length;

    if (blocking === 0) {
      console.log(others.length ? `PASS (${others.length} non-blocking rubric note(s))` : 'PASS');
    } else {
      failed += 1;
      console.log('FAIL');
      for (const f of failures) console.log(`    ✗ ${f}`);
      for (const r of criticals) console.log(`    ✗ [rubric/critical] ${r.grader}: ${r.detail}`);
      for (const line of transcript.slice(0, 14)) console.log(`      ${line.who}: ${line.text.slice(0, 110)}`);
    }
    for (const r of others) console.log(`    · [rubric/${r.severity}] ${r.grader}: ${r.detail}`);
  } catch (e) {
    failed += 1;
    console.log(`ERROR: ${e?.message ?? e}`);
  }
}

console.log(`\n${toRun.length - failed}/${toRun.length} conversation personas passed (${runId}, rubric v${RUBRIC_VERSION})`);
if (rubricTally.size) {
  console.log('Rubric violations across the run:');
  for (const [grader, n] of [...rubricTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${grader}: ${n}`);
  }
}
process.exit(failed ? 1 : 0);
