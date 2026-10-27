/**
 * A HAND-BUILT TOOL'S FIELD DESCRIPTIONS REACH THE MODEL (v109).
 *
 * THE FINDING, measured 2026-10-21 during review of #359: on the two live
 * lanes whose tools are built by hand with `tool()` — no-ivr and pcp — the
 * schema Grok receives carried 1 of no-ivr's 31 field descriptions and 1 of
 * pcp's 2. `@openai/agents` 0.3.7 converts a zod schema with any `.optional()`
 * field through its fallback converter, which drops every `.describe()`, and
 * keeps no reference to the zod object afterwards; `agentBinding.toJsonSchema`
 * then passes that already-JSON schema through unchanged
 * (`src/services/toolFieldDescriptions.ts` has the mechanism).
 *
 * WHAT THIS READS IS THE WIRE, NOT THE SOURCE. Each lane is built by its REAL
 * factory and bound by `resolveLane` with `pipeline: 'runtime'` — the path a
 * live call takes — and every assertion is on `lane.agent.tools`, the
 * definitions the session sends Grok. The zod source is read only to know what
 * the wire SHOULD say: `tool()` is wrapped to record each tool's zod
 * `parameters` and the schema the SDK itself made from it.
 *
 * THREE CLAIMS, each its own assertion so a failure names one thing:
 *   1. every description the zod source carries is on the wire, word for word;
 *   2. NOTHING ELSE moved — the wire schema, descriptions aside, is the SDK's
 *      own, so no type, enum or `required` entry changed under the model;
 *   3. validation is the SDK's zod parse, as before — an argument the schema
 *      refuses is still refused.
 *
 * The queue lanes are not here: they register plain JSON Schema through the
 * tool registry and `realtimeAdapter`, which `tool()` passes through as given,
 * descriptions included. answering-service builds by hand too and is left
 * alone (standing instruction 5).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
  process.env.XAI_API_KEY ||= 'test-unused';
});

/** What each hand-built tool was declared with, by tool name, per build. */
const declared = vi.hoisted(() => new Map<string, { zod: unknown; sdkSchema: unknown }>());
vi.mock('@openai/agents/realtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('@openai/agents/realtime')>();
  return {
    ...real,
    tool: ((options: any) => {
      const built = real.tool(options);
      if (options?.parameters?._def) {
        declared.set(built.name, {
          zod: options.parameters,
          sdkSchema: structuredClone((built as { parameters: unknown }).parameters),
        });
      }
      return built;
    }) as typeof real.tool,
  };
});
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
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

const { resolveLane } = await import('./laneRegistry');
const { createNoIvrAgent } = await import('../agents/noIvrAgent');
const { createPcpAgent } = await import('../agents/pcpAgent');

type Schema = Record<string, any>;
type Lane = NonNullable<Awaited<ReturnType<typeof resolveLane>>>;

/** The lanes, registered as `src/config/agents.ts` registers them. */
const LANES = {
  'no-ivr': { factory: createNoIvrAgent, spokenLanguages: ['en', 'es'] },
  pcp: { factory: createPcpAgent, spokenLanguages: undefined },
} as const;
type Slug = keyof typeof LANES;

const built = new Map<Slug, { lane: Lane; declared: Map<string, { zod: unknown; sdkSchema: unknown }> }>();

async function bind(slug: Slug) {
  declared.clear();
  const { factory, spokenLanguages } = LANES[slug];
  const lane = await resolveLane(
    slug,
    {
      callSid: 'CA00000000000000000000000000000109',
      callId: `descriptions-${slug}`,
      callerPhone: '+15555550100',
      dialedNumber: '+15555550199',
      pipeline: 'runtime',
    } as never,
    {
      source: {
        getAgentConfig: (id: string) =>
          id === slug ? { id, enabled: true, factory: factory as never, spokenLanguages } : undefined,
      },
      handoff: () => async () => ({ ok: true }),
    },
  );
  expect(lane, `${slug} should bind`).not.toBeNull();
  return { lane: lane!, declared: new Map(declared) };
}

beforeAll(async () => {
  for (const slug of Object.keys(LANES) as Slug[]) built.set(slug, await bind(slug));
});

/** Every `.describe()` on a field, keyed by its path, outermost wrapper first —
 *  the same reading zod itself gives a re-described field. */
function sourceDescriptions(zod: any, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  const shape: Record<string, any> = zod?.shape ?? {};
  for (const [key, field] of Object.entries(shape)) {
    let core = field;
    let description: string | undefined = core?.description;
    while (core?._def?.innerType || core?._def?.schema) {
      core = core._def.innerType ?? core._def.schema;
      description ??= core?.description;
    }
    if (description) out.set(path + key, description);
    if (core?._def?.typeName === 'ZodObject') {
      for (const [k, v] of sourceDescriptions(core, `${path}${key}.`)) out.set(k, v);
    }
  }
  return out;
}

function wireDescription(schema: Schema, path: string): string | undefined {
  let node: Schema | undefined = schema;
  for (const key of path.split('.')) {
    const holder: Schema | undefined = node?.properties ? node : node?.anyOf?.find((b: Schema) => b?.properties);
    node = holder?.properties?.[key];
  }
  return node?.description;
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => k !== 'description').map(([k, v]) => [k, withoutDescriptions(v)]),
    );
  }
  return value;
}

const wireTool = (slug: Slug, name: string) => built.get(slug)!.lane.agent.tools.find((t) => t.name === name);

describe.each(Object.keys(LANES) as Slug[])('%s, bound for the runtime', (slug) => {
  it('builds its hand-made tools through tool() with zod — so this file is reading something', () => {
    const { declared } = built.get(slug)!;
    const described = [...declared.values()].reduce((n, d) => n + sourceDescriptions(d.zod).size, 0);
    // Floors, not counts: a description added later must not fail this. They
    // stop a broken capture from passing the assertions below vacuously.
    expect(declared.size).toBeGreaterThanOrEqual(slug === 'no-ivr' ? 6 : 8);
    expect(described).toBeGreaterThanOrEqual(slug === 'no-ivr' ? 31 : 2);
    for (const name of declared.keys()) expect(wireTool(slug, name), `${name} is not on the wire`).toBeTruthy();
  });

  it('every field description the zod source carries reaches the wire, word for word', () => {
    const { declared } = built.get(slug)!;
    const lost: string[] = [];
    for (const [name, { zod }] of declared) {
      const wire = wireTool(slug, name)!.parameters as Schema;
      for (const [path, words] of sourceDescriptions(zod)) {
        if (wireDescription(wire, path) !== words) lost.push(`${name}.${path}`);
      }
    }
    expect(lost, `${slug}: these field descriptions never reach the model`).toEqual([]);
  });

  it('changes nothing else: the wire schema, descriptions aside, is the SDK\'s own', () => {
    const { declared } = built.get(slug)!;
    for (const [name, { sdkSchema }] of declared) {
      const wire = wireTool(slug, name)!.parameters;
      expect(withoutDescriptions(wire), `${slug}/${name}`).toEqual(withoutDescriptions(sdkSchema));
    }
  });
});

describe('the rulings the finding named are among them', () => {
  const field = (slug: Slug, tool: string, path: string) =>
    wireDescription(wireTool(slug, tool)!.parameters as Schema, path);

  it("no-ivr: escalate_to_human's caller_type carries the provider rule (v99)", () => {
    expect(field('no-ivr', 'escalate_to_human', 'caller_type')).toContain(
      'ONLY when the caller has said so in their own words',
    );
    expect(field('no-ivr', 'escalate_to_human', 'caller_type')).toContain('that is create_ticket, never this tool');
  });

  it("no-ivr: create_ticket's routing flags say when to set them", () => {
    expect(field('no-ivr', 'create_ticket', 'appointment_today')).toMatch(/^TRUE when the request is about an appointment or visit TODAY/);
    expect(field('no-ivr', 'create_ticket', 'post_op_prescription')).toContain('It is NOT a reason to call escalate_to_human');
    expect(field('no-ivr', 'escalate_to_human', 'reason')).toContain('ALWAYS write in English');
  });

  it("pcp: record_pcp_intake's callerIsThePatient says who counts as the patient", () => {
    expect(field('pcp', 'record_pcp_intake', 'callerIsThePatient')).toMatch(/^TRUE only when the person ON THE PHONE is the patient/);
  });

  it('a field that had no description is not given one', () => {
    expect(field('pcp', 'record_pcp_intake', 'callerName')).toBeUndefined();
    expect(field('pcp', 'create_pcp_task', 'urgency')).toBeUndefined();
  });

  it("pcp's defaulted fields stay required, as the SDK made them", () => {
    // zod-to-json-schema would take these OUT of `required` (they carry
    // `.default()`), which is why the fix copies words instead of converting.
    expect((wireTool('pcp', 'create_pcp_task')!.parameters as Schema).required).toEqual(['narrative', 'urgency', 'disposition']);
    expect((wireTool('pcp', 'handoff_to_pcp')!.parameters as Schema).required).toEqual(['narrative', 'urgency']);
  });
});

describe('validation is the SDK zod parse, as it was', () => {
  const REFUSED = 'Invalid JSON input for tool';

  it('no-ivr: emit_decision still refuses a decision_type outside its enum', async () => {
    const lane = built.get('no-ivr')!.lane;
    const refused = await lane.agent.dispatch('emit_decision', { decision_type: 'not_a_type', value: 'x' });
    expect(refused.output).toContain(REFUSED);
    const taken = await lane.agent.dispatch('emit_decision', { decision_type: 'urgency_classified', value: 'non-urgent' });
    expect(taken.output).not.toContain(REFUSED);
  });

  it('pcp: record_pcp_intake still refuses a date of birth not in YYYY-MM-DD, and a field it does not have', async () => {
    const lane = built.get('pcp')!.lane;
    expect((await lane.agent.dispatch('record_pcp_intake', { patientDob: '03/17/1973' })).output).toContain(REFUSED);
    expect((await lane.agent.dispatch('record_pcp_intake', { notAField: 'x' })).output).toContain(REFUSED);
  });
});

describe('what the descriptions cost on the wire', () => {
  /**
   * A CEILING SET WHERE THE TOOLS NOW ARE, the way the prompt ceilings are
   * (pcpPromptRulings.test.ts): it asserts only that the tool definitions do
   * not grow while nobody is looking. Measured 2026-10-21 as
   * JSON.stringify(lane.agent.tools).length, runtime-owned tools included:
   *
   *   no-ivr   9,026 chars before -> 12,205 after   (+3,179, ~795 tokens)
   *   pcp      5,793 chars before ->  6,135 after   (+342,   ~85 tokens)
   *
   * For scale, the bound instructions are 24,437 (no-ivr) and 19,735 (pcp)
   * characters. Tool definitions sit outside the prompt, so the prompt
   * ceilings in noIvrPromptForGrok.test.ts and pcpPromptRulings.test.ts are
   * unaffected; this is the first ceiling on the tools themselves.
   */
  it.each([
    // Item #14 + main's appointment-access fields. Measured on the bound tools
    // after that merge: no-ivr 13,113 chars; pcp 6,879 chars. The ceiling
    // stays a ratchet, not a target — do not grow the descriptions to fill it.
    ['no-ivr', 13_200],
    ['pcp', 7_000],
  ] as const)('%s stays under %i characters', (slug, ceiling) => {
    expect(JSON.stringify(built.get(slug)!.lane.agent.tools).length).toBeLessThan(ceiling);
  });
});
