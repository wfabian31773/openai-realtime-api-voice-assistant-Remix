import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { bindAgent, toGrokTools, toJsonSchema, type LiveTool, composeWithBusinessFacts } from './agentBinding';
import { LANGUAGE_MECHANISM_MARKER } from './languageMechanism';

function tool(over: Partial<LiveTool> = {}): LiveTool {
  return {
    name: 'create_ticket',
    description: 'File a callback request.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    invoke: async () => ({ ticket: 'VA-1' }),
    ...over,
  };
}

describe('bindAgent — borrows the real agent, changes nothing', () => {
  it('takes the agent\'s own instructions verbatim, then adds only the runtime\'s own language block', async () => {
    const bound = await bindAgent({ instructions: 'You are Sage.', tools: [] });
    // v77: following the caller's language is the PIPELINE's mechanism, so the
    // binding appends it once (languageMechanism.ts); the agent's words are
    // untouched ahead of it.
    expect(bound.instructions.startsWith('You are Sage.')).toBe(true);
    expect(bound.instructions).toContain('## Voice & Communication Style');
    expect(bound.instructions).toContain(LANGUAGE_MECHANISM_MARKER);
    expect(bound.instructions.split(LANGUAGE_MECHANISM_MARKER).length - 1).toBe(1);
  });

  it('refuses to run an agent with no instructions — that would put a nameless improviser on a patient line', async () => {
    await expect(bindAgent({ instructions: '   ', tools: [] })).rejects.toThrow(
      /no instructions/,
    );
    await expect(bindAgent({ tools: [] })).rejects.toThrow(/no instructions/);
  });

  it('prepends the runtime prefix to a prompt that is not in the five-section shape, agent\'s text intact after it', async () => {
    const bound = await bindAgent(
      { instructions: 'You are Sage.', tools: [] },
      { instructionsPrefix: 'PRACTICE KNOWLEDGE' },
    );
    expect(bound.instructions.startsWith('PRACTICE KNOWLEDGE\n\nYou are Sage.')).toBe(true);
  });

  it('places the prefix as Business Facts after Role & Persona on a five-section prompt (the docs\' order)', async () => {
    const own = '## Role & Persona\nYou are Sage.\n\n## Objective\nFile it.\n\n## Conversation Flow\nAsk.\n\n## Guardrails & Escalation\nNone.\n\n## Voice & Communication Style\nShort.';
    const bound = await bindAgent({ instructions: own, tools: [] }, { instructionsPrefix: 'PRACTICE KNOWLEDGE' });
    expect(bound.instructions.startsWith('## Role & Persona\nYou are Sage.')).toBe(true);
    const facts = bound.instructions.indexOf('## Business Facts\nPRACTICE KNOWLEDGE');
    expect(facts).toBeGreaterThan(0);
    expect(facts).toBeLessThan(bound.instructions.indexOf('## Objective'));
    // The mechanism lands INSIDE the Voice section, not after it.
    const voice = bound.instructions.indexOf('## Voice & Communication Style');
    expect(bound.instructions.indexOf(LANGUAGE_MECHANISM_MARKER)).toBeGreaterThan(voice);
    expect(bound.instructions.indexOf('\n## ', voice + 1)).toBe(-1);
    expect(composeWithBusinessFacts('plain prompt', 'FACTS')).toBe('FACTS\n\nplain prompt');
  });

  it('binds the runtime\'s own tools alongside the agent\'s, never twice under one name', async () => {
    const mine = tool({ name: 'set_spoken_language', invoke: async () => ({ mine: true }) });
    const runtimes = tool({ name: 'set_spoken_language', invoke: async () => ({ mine: false }) });
    const withOwn = await bindAgent({ instructions: 'You are Sage.', tools: [mine] }, { runtimeTools: [runtimes] });
    expect(withOwn.toolNames.filter((n) => n === 'set_spoken_language')).toHaveLength(1);
    expect(JSON.parse((await withOwn.dispatch('set_spoken_language', {})).output)).toEqual({ mine: true });
    const without = await bindAgent({ instructions: 'You are Sage.', tools: [] }, { runtimeTools: [runtimes] });
    expect(without.toolNames).toEqual(['set_spoken_language']);
    expect(JSON.parse((await without.dispatch('set_spoken_language', {})).output)).toEqual({ mine: false });
  });
});

describe('tool schemas — .agents/memory/realtime-tool-schemas.md', () => {
  it('passes a plain JSON Schema through UNCHANGED — no re-derivation', () => {
    const schema = {
      type: 'object',
      properties: { reason: { type: 'string' }, note: { type: 'string' } },
      required: ['reason'],
    };
    const { defs } = toGrokTools([tool({ parameters: schema })]);
    // Byte-for-byte the agent's own schema. Translation is the hazard.
    expect(defs[0].parameters).toEqual(schema);
  });

  it('NEVER emits a strict flag — strict mode silently rejected every call on 2026-08-12', () => {
    const { defs } = toGrokTools([tool()]);
    expect('strict' in defs[0]).toBe(false);
    expect(JSON.stringify(defs[0])).not.toContain('strict');
  });

  it('converts a real Zod schema, and optional stays OUT of required', () => {
    // The original bug: .nullable() made every field required. A field the
    // model legitimately omits must not be required.
    const parameters = z.object({
      reason: z.string(),
      note: z.string().optional(),
    });
    const { defs } = toGrokTools([tool({ parameters })]);
    const p = defs[0].parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(Object.keys(p.properties ?? {}).sort()).toEqual(['note', 'reason']);
    expect(p.required).toEqual(['reason']);
    expect(p.required).not.toContain('note');
  });

  it('an unconvertible schema still yields a usable tool — untyped beats missing', () => {
    const { defs, skipped } = toGrokTools([tool({ parameters: undefined })]);
    expect(defs).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(defs[0].parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('a tool with no implementation is skipped AND reported — a vanished tool looks like a model that would not call it', () => {
    const { defs, skipped } = toGrokTools([tool({ invoke: undefined })]);
    expect(defs).toHaveLength(0);
    expect(skipped).toEqual([{ name: 'create_ticket', reason: 'no implementation' }]);
  });

  it('an unnamed tool is skipped and reported', () => {
    const { defs, skipped } = toGrokTools([tool({ name: undefined })]);
    expect(defs).toHaveLength(0);
    expect(skipped[0].reason).toBe('no name');
  });
});

describe('instructions that are a FUNCTION (Codex review, PR #227)', () => {
  it('evaluates the agent\'s prompt closure instead of stringifying it', async () => {
    // azulSchedulingAgent.ts:1929 — `instructions: () => buildAzulSchedulingPrompt(metadata)`.
    // Stringified, Grok receives the literal source text as its system
    // prompt and the lane loses its whole workflow and safety rules.
    const bound = await bindAgent({
      instructions: (() => 'The real scheduling prompt.') as never,
      tools: [tool()],
    });
    expect(bound.instructions).toContain('The real scheduling prompt.');
    expect(bound.instructions).not.toContain('=>');
  });

  it('prefers the SDK getSystemPrompt contract when the agent exposes one', async () => {
    const bound = await bindAgent({
      instructions: (() => 'closure value') as never,
      getSystemPrompt: async () => 'resolved via getSystemPrompt',
      tools: [tool()],
    } as never);
    expect(bound.instructions).toContain('resolved via getSystemPrompt');
  });

  it('awaits an asynchronous prompt closure', async () => {
    const bound = await bindAgent({
      instructions: (async () => 'async prompt') as never,
      tools: [tool()],
    });
    expect(bound.instructions).toContain('async prompt');
  });

  it('REFUSES rather than sending source text it could not evaluate', async () => {
    await expect(
      bindAgent({ instructions: (() => undefined) as never, tools: [tool()] }),
    ).rejects.toThrow(/instructions/i);
  });
});

describe('dispatch — every tool call must be answered, so it never throws', () => {
  it('calls the real implementation with the arguments as a JSON string', async () => {
    // Typed parameters, not a bare `vi.fn()`: the assertion below is about
    // the SECOND argument, and an untyped mock records a zero-length tuple
    // that the typecheck cannot index.
    const invoke = vi.fn(async (_ctx: unknown, _input: string) => ({ ticket: 'VA-51121' }));
    const bound = await bindAgent({ instructions: 'x', tools: [tool({ invoke })] });
    const res = await bound.dispatch('create_ticket', { reason: 'refill' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toBe(JSON.stringify({ reason: 'refill' }));
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.output)).toEqual({ ticket: 'VA-51121' });
  });

  it('a string result is passed through rather than double-encoded', async () => {
    const bound = await bindAgent({
      instructions: 'x',
      tools: [tool({ invoke: async () => 'VA-1 filed' })],
    });
    const res = await bound.dispatch('create_ticket', {});
    expect(res.output).toBe('VA-1 filed');
  });

  it('an unknown tool returns a structured refusal — the turn still gets an answer', async () => {
    const bound = await bindAgent({ instructions: 'x', tools: [tool()] });
    const res = await bound.dispatch('book_appointment', {});
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.output)).toEqual({ ok: false, error: 'unknown_tool' });
    expect(res.error).toContain('book_appointment');
  });

  it('a THROWING tool is answered, not propagated — an unanswered call is dead air', async () => {
    const bound = await bindAgent({
      instructions: 'x',
      tools: [tool({ invoke: async () => { throw new Error('ticket API 500'); } })],
    });
    const res = await bound.dispatch('create_ticket', { reason: 'refill' });
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.output)).toEqual({ ok: false, error: 'tool_failed' });
    expect(res.error).toContain('ticket API 500');
  });

  it('a tool that was skipped cannot be dispatched — the allow-list is the offered set', async () => {
    const bound = await bindAgent({ instructions: 'x', tools: [tool({ invoke: undefined })] });
    expect(bound.toolNames).toEqual([]);
    const res = await bound.dispatch('create_ticket', {});
    expect(res.ok).toBe(false);
  });
});

describe("output guardrails are borrowed with instructions and tools", () => {
  const base = {
    instructions: "You are the no-ivr agent.",
    tools: [],
  };

  it("carries the agent's own guardrails through, verbatim", async () => {
    const guardrail = {
      name: "No diagnosis",
      policyHint: "Do not diagnose.",
      execute: async () => ({ tripwireTriggered: false, outputInfo: {} }),
    };
    const bound = await bindAgent({ ...base, outputGuardrails: [guardrail] } as never, {});
    // The same OBJECT, not a copy — the SDK's rules run unmodified.
    expect(bound.guardrails).toHaveLength(1);
    expect(bound.guardrails[0]).toBe(guardrail);
  });

  it("binds to an empty list when the agent declares none — queue agents have none", async () => {
    const bound = await bindAgent({ ...base } as never, {});
    expect(bound.guardrails).toEqual([]);
  });

  it("drops a malformed entry rather than crashing the call, but keeps the rest", async () => {
    const good = {
      name: "No prescribing",
      execute: async () => ({ tripwireTriggered: false }),
    };
    const bound = await bindAgent(
      {
        ...base,
        outputGuardrails: [null, { name: "no execute" }, { execute: async () => ({}) }, good],
      } as never,
      {},
    );
    expect(bound.guardrails).toEqual([good]);
  });
});
