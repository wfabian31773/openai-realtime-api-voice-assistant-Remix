/**
 * EVERY LANE THE RUNTIME SERVES, HELD TO xAI'S OWN DOCS — BY THE RUNTIME.
 *
 * Operator, 2026-09-28: *"xai specifically states that large prompts are
 * unnecessary, they also have their recommendations for handling spanish
 * calls, we need to ensure the runtime follows those docs to the letter"* —
 * and, of the first pass that fixed one lane: *"Shouldn't this be for the
 * runtime in general?"* Yes. This is the fleet guard: it resolves every lane
 * through the REAL registry the way voiceRuntime does, and checks the BOUND
 * prompt and tool list — what the model is actually handed — against the
 * Prompting Guide's rules, verbatim:
 *
 *   - *"Write system prompts in the second person, in Markdown, with these
 *     `##` sections in this order: Role & Persona · Objective · Conversation
 *     Flow · Guardrails & Escalation · Voice & Communication Style"*
 *   - *"Facts are baked in verbatim … under Role & Persona or a small
 *     `## Business Facts` section"*
 *   - *"Only mention tools that exist in the tool definition."*
 *   - *"Real deployments frequently append a `## CRITICAL INSTRUCTIONS`
 *     section … Use this section sparingly."*
 *   - *"Control language explicitly if unwanted language switching appears."*
 *
 * And the 2026-09-15 ruling that decides WHERE each rule lives: *"the things
 * that are applicable to any conversation should be in the runtime; things
 * applicable to that agent itself should be in the prompt."* The language
 * mechanism and the language tool are the pipeline's, so this asserts the
 * RUNTIME put them on every lane; the five sections are each lane's own
 * writing, so this asserts each lane wrote them.
 *
 * NOT gated on RUNTIME_LANE_SMOKE like realLanes.test.ts: a guard that runs
 * only where somebody remembers to enable it is not a guard. The registry
 * loads under the same dummy environment the after-hours suites use.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
process.env.XAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: async () => ({ success: true, ticketNumber: 'VA-TEST' }),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { resolveLane, defaultLaneSource, RUNTIME_OWNED_TOOLS } = await import('./laneRegistry');
const { buildKnowledgePack } = await import('./knowledgePack');
const { LANGUAGE_MECHANISM_MARKER, renderLanguagePolicy } = await import('./languageMechanism');
const { DEFAULT_LANGUAGE_TOOL_NAMES } = await import('./mediaStreamBridge');

/** The lanes that take calls on this runtime today or on the next repoint.
 *  answering-service is registered servable but has never taken a runtime
 *  call and is off-limits (standing instruction 5); azul-scheduling is
 *  refused. Both are named here so their absence is a decision, not a gap. */
const LANES = ['optical', 'surgery', 'tech', 'records', 'pcp', 'no-ivr'] as const;
const NEEDS_A_TRANSFER = new Set(['pcp', 'no-ivr']);

const SECTIONS = [
  '## Role & Persona',
  '## Business Facts',
  '## Objective',
  '## Conversation Flow',
  '## Guardrails & Escalation',
  '## Voice & Communication Style',
];

/** Every tool name the fleet has anywhere, so "names a tool it does not have"
 *  cannot pass vacuously on a lane whose prompt names none. */
const EVERY_TOOL_THIS_FLEET_HAS = [
  'lookup_patient', 'resolve_location', 'file_optical_ticket', 'file_surgery_ticket',
  'file_tech_ticket', 'file_records_ticket', 'classify_surgery_request', 'classify_tech_request',
  'classify_optical_request', 'send_records_form', 'handoff_to_pcp', 'record_pcp_intake',
  'create_pcp_task', 'record_automated_resolution', 'handle_patient_medical_records_request',
  'lookup_patient_appointments', 'check_patient_scheduled', 'transfer_call', 'end_call', 'web_search',
  'lookup_schedule', 'check_open_tickets', 'emit_decision', 'create_ticket', 'escalate_to_human',
  'terminate_call', 'set_spoken_language',
];

async function bound(slug: string) {
  const source = await defaultLaneSource();
  const lane = await resolveLane(
    slug,
    {
      callSid: 'CA00000000000000000000000000000fee',
      callId: `shape-${slug}`,
      callerPhone: '+15555550100',
      dialedNumber: '+15555550199',
      pipeline: 'runtime',
    },
    {
      source,
      env: {},
      ...(NEEDS_A_TRANSFER.has(slug) ? { handoff: () => async () => ({ ok: true }) } : {}),
    },
  );
  expect(lane, `${slug} should resolve`).not.toBeNull();
  return lane!;
}

describe.each(LANES)('%s — the bound prompt is the shape the docs prescribe', (slug) => {
  it('opens in the second person under Role & Persona, with the facts and the four sections in order, once each', async () => {
    const p = (await bound(slug)).agent.instructions;
    expect(p.startsWith('## Role & Persona\nYou ')).toBe(true);
    const positions = SECTIONS.map((h) => {
      const first = p.indexOf(`${h}\n`);
      expect(first, `${h} is missing`).toBeGreaterThan(-1);
      expect(p.indexOf(`${h}\n`, first + 1), `${h} appears twice`).toBe(-1);
      return first;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('carries the practice facts once, as Business Facts, not as a preamble', async () => {
    const p = (await bound(slug)).agent.instructions;
    const pack = buildKnowledgePack();
    expect(p.split(pack).length - 1, 'the knowledge pack should appear exactly once').toBe(1);
    expect(p.indexOf(pack)).toBeGreaterThan(p.indexOf('## Business Facts'));
    expect(p.indexOf(pack)).toBeLessThan(p.indexOf('## Objective'));
  });

  it('has no H1 headers and uses CRITICAL as at most one appended section', async () => {
    const p = (await bound(slug)).agent.instructions;
    expect(p).not.toMatch(/^# /m);
    const critical = p.match(/CRITICAL/g) ?? [];
    expect(critical.length, 'CRITICAL is a section, not a banner').toBeLessThanOrEqual(1);
    if (critical.length === 1) {
      expect(p.indexOf('## CRITICAL INSTRUCTIONS')).toBeGreaterThan(p.indexOf('## Voice & Communication Style'));
    }
    expect(p).not.toMatch(/⚠️/);
  });

  it('names only tools the model is actually offered', async () => {
    const lane = await bound(slug);
    const p = lane.agent.instructions;
    const offered = new Set(lane.agent.toolNames);
    const named = EVERY_TOOL_THIS_FLEET_HAS.filter((t) => new RegExp(`\\b${t}\\b`).test(p));
    expect(named.length, 'the prompt names no tool at all — the scan is wrong').toBeGreaterThan(0);
    expect(named.filter((t) => !offered.has(t)), 'scripted but not offered').toEqual([]);
  });

  it('is handed the language tool by the RUNTIME, under the name the bridge switches on', async () => {
    const lane = await bound(slug);
    for (const name of RUNTIME_OWNED_TOOLS) {
      expect(lane.agent.toolNames, `${slug} lacks ${name}`).toContain(name);
      expect(DEFAULT_LANGUAGE_TOOL_NAMES).toContain(name);
    }
    expect(lane.agent.skipped).toEqual([]);
    // And it is dispatchable — the registry's own handler, recorded like any lane tool.
    const out = await lane.agent.dispatch('set_spoken_language', { language: 'Spanish' });
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.output)).toMatchObject({ success: true, language: 'es' });
  });

  it("the tool honours the lane's own policy at dispatch (Codex P2 on #336)", async () => {
    const lane = await bound(slug);
    const source = await defaultLaneSource();
    const policy = source.getAgentConfig(slug)!.spokenLanguages;
    const parsed = JSON.parse((await lane.agent.dispatch('set_spoken_language', { language: 'Tagalog' })).output);
    const def = lane.agent.tools.find((t) => t.name === 'set_spoken_language')!;
    if (policy) {
      // A lane that names its languages refuses the rest, with no `language`
      // key for the bridge to act on, and its tool description says so.
      expect(parsed, slug).toMatchObject({ success: false, suppressed: 'language_not_spoken_here' });
      expect(parsed, slug).not.toHaveProperty('language');
      expect(def.description, slug).toContain(renderLanguagePolicy(policy));
    } else {
      // A lane with no policy follows the caller — the words and the tool unchanged.
      expect(parsed, slug).toMatchObject({ success: true, language: 'tl' });
      expect(def.description, slug).toMatch(/speaks a language other than the one you are using/);
    }
  });

  it("carries the runtime's language mechanism exactly once, inside Voice & Communication Style, with the lane's own policy", async () => {
    const lane = await bound(slug);
    const p = lane.agent.instructions;
    expect(p.split(LANGUAGE_MECHANISM_MARKER).length - 1).toBe(1);
    const voice = p.indexOf('## Voice & Communication Style');
    const next = p.indexOf('\n## ', voice + 1);
    const section = p.slice(voice, next === -1 ? undefined : next);
    expect(section).toContain(LANGUAGE_MECHANISM_MARKER);
    expect(section).toMatch(/Switch only if the caller switches/);
    expect(section).toMatch(/shape to translate, not a script to read/);
    expect(section).toMatch(/Keep every tool ARGUMENT in English/);
    // The policy is the lane's registration, rendered by the runtime.
    const source = await defaultLaneSource();
    expect(section).toContain(renderLanguagePolicy(source.getAgentConfig(slug)!.spokenLanguages));
    // No lane writes its own second copy any more.
    expect(p.match(/set_spoken_language/g)!.length, 'the tool is named once, by the mechanism').toBe(1);
  });
});

describe('the policy is configuration', () => {
  it('the after-hours line speaks English and Spanish; the queue lanes follow the caller', async () => {
    const source = await defaultLaneSource();
    expect(source.getAgentConfig('no-ivr')!.spokenLanguages).toEqual(['en', 'es']);
    for (const slug of ['optical', 'surgery', 'tech', 'records', 'pcp']) {
      expect(source.getAgentConfig(slug)!.spokenLanguages, `${slug} should follow any language`).toBeUndefined();
    }
    expect(renderLanguagePolicy(['en', 'es'])).toBe(
      'This line speaks English and Spanish. For any other language, say in English that this line can help in English and Spanish, and continue in English.',
    );
    expect(renderLanguagePolicy(undefined)).toMatch(/follow the caller into their language/);
  });
});
