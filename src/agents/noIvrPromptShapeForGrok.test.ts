/**
 * THE AFTER-HOURS PROMPT IN xAI'S SHAPE, AND THE RULINGS IT MUST NOT DROP.
 *
 * Operator, 2026-09-28: *"xai specifically states that large prompts are
 * unnecessary … we need to ensure the runtime follows those docs to the
 * letter."* The docs' migration text: *"your prompt should be much shorter …
 * Remove workaround prompting."* The Prompting Guide: five `##` sections in a
 * fixed order, second person, CRITICAL used sparingly, only tools that exist.
 *
 * This drives the REAL agent (`createNoIvrAgent`) on both pipelines' metadata
 * and holds BOTH bodies to ONE list of operator rulings, so the rewrite cannot
 * drop one and the legacy body cannot drift from it either. The ordering
 * assertions mirror noIvrFalseFailure.test.ts, which pins them on the legacy
 * body: the carve-out (an in-progress or once-more result is not a failure)
 * must sit BEFORE the technical-error rule — the v29 lesson, the exception
 * stated before the ban.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

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

const { createNoIvrAgent, buildNoIvrSystemPrompt } = await import('./noIvrAgent');
const { noIvrPromptShape } = await import('./noIvrPromptForGrok');

const base = {
  callId: 'noivr-shape-1',
  callSid: 'CA0000000000000000000000000000beef',
  callerPhone: '+15555550100',
} as const;

async function prompt(meta: Record<string, unknown>): Promise<string> {
  const agent = await createNoIvrAgent(async () => {}, { ...base, ...meta } as any);
  return String((agent as any).instructions);
}
async function toolNames(meta: Record<string, unknown>): Promise<string[]> {
  const agent = await createNoIvrAgent(async () => {}, { ...base, ...meta } as any);
  return (agent as any).tools.map((t: any) => t.name);
}

const SECTIONS = [
  '## Role & Persona',
  '## Objective',
  '## Conversation Flow',
  '## Guardrails & Escalation',
  '## Voice & Communication Style',
  '## CRITICAL INSTRUCTIONS',
];

describe('which pipeline gets which body', () => {
  it('the runtime gets the Grok shape; the old core keeps the prompt written for it', async () => {
    const grok = await prompt({ pipeline: 'runtime' });
    const legacy = await prompt({});
    expect(grok).toMatch(/^## Role & Persona\nYou are the after-hours agent/);
    expect(grok).not.toContain('INTERNAL WORKFLOW PLAYBOOK');
    expect(legacy).toContain('INTERNAL WORKFLOW PLAYBOOK');
    expect(legacy).not.toContain('## Role & Persona');
  });

  it('NO_IVR_PROMPT_SHAPE=legacy is the revert lever on the runtime; =grok cannot force the Grok body onto the SIP core', () => {
    expect(noIvrPromptShape({ pipeline: 'runtime' }, {})).toBe('grok');
    expect(noIvrPromptShape({}, {})).toBe('legacy');
    expect(noIvrPromptShape({ pipeline: 'runtime' }, { NO_IVR_PROMPT_SHAPE: 'legacy' })).toBe('legacy');
    // Codex P2 on #336: the Grok body is not self-contained — it leans on the
    // runtime's binding for the knowledge pack, the language mechanism and the
    // language tool, and the SIP path binds nothing. A forced `grok` there
    // would answer from facts it was never given, so the pipeline decides.
    expect(noIvrPromptShape({}, { NO_IVR_PROMPT_SHAPE: 'grok' })).toBe('legacy');
    expect(noIvrPromptShape({ pipeline: 'runtime' }, { NO_IVR_PROMPT_SHAPE: 'grok' })).toBe('grok');
  });

  it('a forced grok on the old core still builds the legacy body, tools and all', async () => {
    const saved = process.env.NO_IVR_PROMPT_SHAPE;
    process.env.NO_IVR_PROMPT_SHAPE = 'grok';
    try {
      const agent = await createNoIvrAgent(async () => {}, { ...base, callId: 'forced-grok-sip' } as any);
      const p = String((agent as any).instructions);
      expect(p).toContain('INTERNAL WORKFLOW PLAYBOOK');
      expect(p).not.toContain('## Role & Persona');
      // The legacy body carries its own policy statement, because nothing
      // appends the runtime's mechanism on this pipeline.
      expect(p).toMatch(/You speak English and Spanish\. Start in English\./);
    } finally {
      if (saved === undefined) delete process.env.NO_IVR_PROMPT_SHAPE;
      else process.env.NO_IVR_PROMPT_SHAPE = saved;
    }
  });

  it("the runtime's own metadata carries the pipeline, so the pick is not left to a test", () => {
    const src = readFileSync('src/runtime/voiceRuntime.ts', 'utf8');
    expect(src).toMatch(/pipeline: "runtime" as const,/);
  });
});

describe("the Grok body is the shape xAI's Prompting Guide prescribes", () => {
  it('carries the five sections, once each, in the documented order, then CRITICAL', async () => {
    const p = await prompt({ pipeline: 'runtime' });
    const positions = SECTIONS.map((h) => {
      const first = p.indexOf(h);
      expect(first, `${h} is missing`).toBeGreaterThan(-1);
      expect(p.indexOf(h, first + 1), `${h} appears twice`).toBe(-1);
      return first;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('uses CRITICAL as one section, not as a banner sprinkled through the body', async () => {
    const p = await prompt({ pipeline: 'runtime' });
    expect((p.match(/CRITICAL/g) ?? []).length).toBe(1);
    expect(p).not.toMatch(/⚠️/);
    expect(p).not.toMatch(/=====\s*(INTERNAL|HARD RULES|ANTI-NARRATION|INTERRUPTION|CONFUSION)/);
  });

  it('is much shorter — the migration text in one number', async () => {
    const grok = await prompt({ pipeline: 'runtime' });
    const legacy = await prompt({});
    expect(grok.length).toBeLessThan(legacy.length / 2);
    // A RATCHET, not a measurement: the built prompt with no caller context
    // read 14,082 characters on 2026-09-28 against 28,801 for the legacy body
    // — 49%, of which 2,489 is the triage block and the urgent-symptom list
    // both bodies share verbatim. Raise it with the reason beside it, never
    // silently; lower it when a trim lands.
    expect(grok.length).toBeLessThan(15_000);
  });

  it('carries no second office list — the runtime prefixes the knowledge pack, which has one', async () => {
    const grok = await prompt({ pipeline: 'runtime' });
    expect(grok).not.toContain('OFFICE LOCATIONS REFERENCE');
    expect(grok).not.toMatch(/\(\d{3}\) \d{3}-\d{4}/);
  });

  it('names only tools that are on the agent (the guide: "only mention tools that exist")', async () => {
    const EVERY_TOOL_THIS_FLEET_HAS = [
      'lookup_patient', 'resolve_location', 'file_optical_ticket', 'file_surgery_ticket',
      'file_tech_ticket', 'file_records_ticket', 'classify_surgery_request', 'classify_tech_request',
      'classify_optical_request', 'send_records_form', 'handoff_to_pcp', 'record_pcp_intake',
      'create_pcp_task', 'record_automated_resolution', 'transfer_call', 'end_call', 'web_search',
      'lookup_schedule', 'check_open_tickets', 'emit_decision', 'create_ticket', 'escalate_to_human',
      'terminate_call', 'set_spoken_language',
    ];
    for (const meta of [{ pipeline: 'runtime' }, {}]) {
      const p = await prompt(meta);
      const onAgent = new Set(await toolNames(meta));
      const named = EVERY_TOOL_THIS_FLEET_HAS.filter((t) => new RegExp(`\\b${t}\\b`).test(p));
      const phantom = named.filter((t) => !onAgent.has(t));
      expect(phantom, `${JSON.stringify(meta)} scripts a tool it does not have`).toEqual([]);
      // And it scripts the ones that matter, so this is not passing vacuously.
      expect(named).toEqual(expect.arrayContaining(['create_ticket', 'escalate_to_human', 'terminate_call']));
    }
  });
});

/**
 * THE RULINGS MAP. One list, both bodies. Each entry is an operator ruling
 * this file's history pins for the after-hours line; the regex is written to
 * match the legacy wording and the rewrite alike, so a rewrite that drops a
 * rule and a legacy edit that drops one go red the same way.
 */
const RULINGS: Array<[string, RegExp]> = [
  ['exactly three escalation cases', /EXACTLY THREE CASES, NOTHING ELSE/],
  ['a patient asking for a human is not an emergency', /IS NOT AN\s*\n?\s*EMERGENCY/],
  ['ghost and robot calls never escalate', /NEVER escalate to (a|the) human/i],
  ['the 1 AM robocall rule', /1 AM/],
  ['robot calls terminate', /terminate_call with reason "robot_call"/],
  ['ghost calls terminate', /terminate_call with reason "ghost_call"/],
  ['date of birth is asked in parts', /starting with the month, then\s*\n?\s*the day, then the year/],
  ['the create_ticket wait line', /Give me one moment while I get this submitted for you/],
  ['B2B callers are not blocked on a date of birth', /DOB IS OPTIONAL FOR BUSINESS CALLERS/],
  ['new-or-existing on a lookup miss', /are you a new patient with us, or have you been seen/],
  ['filing a partial ticket is the job', /Filing a partial ticket IS the job/],
  ['a failed tool is never an escalation', /A failed tool is NOT an escalation case/],
  // 2026-09-29: the refusal files the ticket itself; the prompt must say so and
  // must not script a promise to connect before the tool has answered.
  ['a refused escalation has already filed the ticket', /it has ALREADY filed\s*\n?\s*a ticket/],
  ['never promise a recording', /Never promise a recording/],
  ['the full name in one question', /"What is your full name\?"/],
  ['the email funnel, once, then a phone callback', /spell\s*\n?\s*it out for me, letter by letter/],
  // The language MECHANISM (call set_spoken_language, switch only if the caller
  // switches, arguments in English) is the RUNTIME's since v77 and is asserted
  // on every bound lane in src/runtime/promptShapeIsTheDocs.test.ts. The
  // legacy body still states this line's POLICY in its own words for the old
  // core; the Grok body gets the policy from `spokenLanguages` at binding.
  ['anything else before ending', /Anything else\?/],
  // 2026-10-01: the operator rang the line, asked when an office opens and
  // was told "I don't want to give you the wrong time for that office". The
  // hours are the practice's own and every other lane states them.
  ['office hours are answered with the times, never hedged', /including the office's own opening and closing time, exactly as written\s*\n?\s*there/],
  ['no "is that correct?"', /DO NOT ask "Is that correct\?"|Do not ask "Is that correct\?"/],
  ['the ticket number is not read out', /(DO NOT|Do not) read (out )?the ticket number/],
  ['the technical-issue line is a fixed sentence', /I'm sorry, I'm having a technical issue on my end right now\. I have your information and our team will call you back at \[callback number\] as soon as possible\./],
  ['the urgent-symptom list is present', /URGENT SYMPTOMS/],
  ['the triage block is present', /Triage — ask one question, then decide/i],
];

describe('every ruling survives in both bodies', () => {
  it.each(RULINGS)('%s', async (_label, pattern) => {
    expect(await prompt({ pipeline: 'runtime' }), 'missing from the Grok body').toMatch(pattern);
    expect(await prompt({}), 'missing from the legacy body').toMatch(pattern);
  });

  it('the carve-out for an in-progress or once-more result sits BEFORE the technical-error rule, in both', async () => {
    for (const meta of [{ pipeline: 'runtime' }, {}]) {
      const p = await prompt(meta);
      const rules = p.slice(p.indexOf('TICKET CONFIRMATION RULES'));
      const carveOut = rules.indexOf('ALREADY IN PROGRESS');
      const technical = rules.indexOf('TECHNICAL ERROR (system_error, api_timeout');
      expect(carveOut, `${JSON.stringify(meta)}: no carve-out`).toBeGreaterThan(-1);
      expect(technical, `${JSON.stringify(meta)}: no technical rule`).toBeGreaterThan(carveOut);
      expect(rules.slice(carveOut, technical)).toMatch(/never speak the technical-issue line/i);
    }
  });

  it('a recognised caller: the block keeps its rules and asks one field at a time (RULE ZERO 2b)', async () => {
    const pc = { matched: true, firstName: 'Zelda' };
    const grok = await prompt({ pipeline: 'runtime', precontext: pc });
    expect(grok).toContain('DO NOT OPEN WITH A NAME CONFIRMATION, AND DO NOT SPEAK OVER THE GREETING');
    expect(grok).toContain('am I speaking with Zelda?');
    expect(grok).toMatch(/Disclose nothing from anyone's record/);
    // The deliberate change, for the operator to overrule: not two fields in one breath.
    expect(grok).not.toMatch(/IN ONE question, never one\s*\n?\s*and then the other/);
    expect(grok).toMatch(/take the last name in their own words, then the date of birth in parts/);
    // Unrecognised: no block at all.
    expect(await prompt({ pipeline: 'runtime' })).not.toContain('Caller-ID pre-context');
  });

  it('the withheld phone-match section rides into the Grok body unchanged', () => {
    const p = buildNoIvrSystemPrompt(
      { ...base, pipeline: 'runtime' } as any,
      { patientFound: true, matchedBy: 'phone', patientName: 'Zelda Quixote', upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 1 } as any,
    );
    expect(p).toContain('PHONE MATCH — UNCONFIRMED');
    expect(p).toContain('Is this for Zelda?');
    expect(p).not.toContain('Quixote');
  });
});
