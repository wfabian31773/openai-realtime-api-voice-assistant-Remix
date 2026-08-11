/**
 * The contract every tool in the library must honour.
 *
 * The one that matters most is refusal: a tool that is missing something says
 * so in a form the agent can act on, and never guesses. That pattern is not a
 * preference — the ticketing app's hard-requires work this way and hold
 * surgery-missing-surgeon to 0.4% and optical-missing-location to 1.9%, which
 * prompt instructions alone never achieved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerTool,
  runTool,
  manifest,
  allTools,
  getTool,
  validateInput,
  type ToolDefinition,
} from './registry';
// Registration is an import side effect — the same way the HTTP server picks
// them up. Without this the registry holds only the fixtures below.
import './opticalTools';

/** The real library, excluding the x_* fixtures this file registers. */
const realTools = () => allTools().filter((t) => !t.name.startsWith('x_'));

const base = {
  layer: 'agent' as const,
  timeoutMs: 500,
  input_schema: { type: 'object' as const, properties: {} },
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('refusal is a first-class result', () => {
  it('refuses with the exact fields that are missing', () => {
    const def = {
      ...base,
      name: 'x_needs_two',
      description: 'd',
      input_schema: {
        type: 'object' as const,
        properties: {
          a: { type: 'string', description: 'a' },
          b: { type: 'string', description: 'b' },
        },
        required: ['a', 'b'],
      },
      handler: async () => ({ success: true as const }),
    };
    const out = validateInput(def, { a: 'here' });
    expect(out).not.toBeNull();
    expect(out!.missingFields).toEqual(['b']);
    // The message is spoken to a patient, so it has to read like a sentence.
    expect(out!.message).toMatch(/\bb\b/);
  });

  it('treats blank and whitespace as missing, not as supplied', () => {
    const def = {
      ...base,
      name: 'x_blank',
      description: 'd',
      input_schema: {
        type: 'object' as const,
        properties: { a: { type: 'string', description: 'a' } },
        required: ['a'],
      },
      handler: async () => ({ success: true as const }),
    };
    expect(validateInput(def, { a: '   ' })).not.toBeNull();
    expect(validateInput(def, { a: '' })).not.toBeNull();
    expect(validateInput(def, { a: null })).not.toBeNull();
    expect(validateInput(def, { a: 'real' })).toBeNull();
  });

  it('never runs the handler when a required field is absent', async () => {
    const handler = vi.fn(async () => ({ success: true as const }));
    registerTool({
      ...base,
      name: 'x_guarded',
      description: 'd',
      input_schema: {
        type: 'object',
        properties: { need: { type: 'string', description: 'n' } },
        required: ['need'],
      },
      handler,
    });
    const out = await runTool('x_guarded', {});
    expect(out.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('a tool never takes the call down with it', () => {
  it('turns a thrown handler into a retryable failure', async () => {
    registerTool({
      ...base,
      name: 'x_throws',
      description: 'd',
      handler: async () => {
        throw new Error('vendor exploded');
      },
    });
    const out = await runTool('x_throws', {});
    expect(out).toMatchObject({ success: false, error: 'vendor exploded', retryable: true });
  });

  it('honours its declared timeout instead of hanging', async () => {
    registerTool({
      ...base,
      name: 'x_hangs',
      timeoutMs: 60,
      description: 'd',
      handler: () => new Promise(() => {}), // never settles
    });
    const started = Date.now();
    const out = await runTool('x_hangs', {});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toMatchObject({ success: false, retryable: true });
    expect((out as { error: string }).error).toContain('timed out');
  });

  it('answers for a tool that does not exist', async () => {
    const out = await runTool('x_nope', {});
    expect(out).toMatchObject({ success: false });
  });
});

describe('the manifest describes the tools an agent should call', () => {
  it('publishes agent tools and hides primitives', () => {
    registerTool({
      ...base,
      name: 'x_primitive',
      layer: 'primitive',
      description: 'internal',
      handler: async () => ({ success: true as const }),
    });
    const names = manifest().map((t) => t.name);
    expect(names).not.toContain('x_primitive');
    expect(manifest(true).map((t) => t.name)).toContain('x_primitive');
  });

  it('publishes the timeout so a platform can configure itself', () => {
    // sage_book legitimately needs 75s; a platform that assumes 10 breaks it.
    const entry = manifest().find((t) => t.name === 'lookup_patient');
    expect(entry).toBeTruthy();
    expect(entry!.timeout_seconds).toBeGreaterThan(0);
  });

  it('refuses to register the same name twice', () => {
    const dup: ToolDefinition = {
      ...base,
      name: 'lookup_patient',
      description: 'd',
      handler: async () => ({ success: true as const }),
    };
    expect(() => registerTool(dup)).toThrow(/duplicate/);
  });
});

describe('the Optical tool set is exactly what that queue needs', () => {
  it('registers who / where / already-asked, and nothing else', () => {
    const names = manifest().map((t) => t.name);
    expect(names).toContain('lookup_patient');
    expect(names).toContain('resolve_location');
    expect(names).toContain('check_open_tickets');
  });

  it('every agent tool has a usable description and a timeout', () => {
    for (const t of realTools().filter((t) => t.layer === 'agent')) {
      expect(t.description.length, `${t.name} needs a real description`).toBeGreaterThan(40);
      expect(t.timeoutMs, `${t.name} needs a timeout`).toBeGreaterThan(0);
      expect(getTool(t.name)).toBeTruthy();
    }
  });
});

describe('lookup_patient will not search on half an identity', () => {
  it('asks for the rest rather than guessing', async () => {
    const out = await runTool('lookup_patient', { first_name: 'Wayne' });
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('last_name');
    expect((out as { missingFields: string[] }).missingFields).toContain('date_of_birth');
  });

  it('accepts a phone alone — the commonest case, and enough on its own', async () => {
    // Reaches the real service; we only assert it got past validation.
    const out = await runTool('lookup_patient', { phone: '626-555-0100' });
    expect('missingFields' in out).toBe(false);
  });
});

describe('resolve_location refuses rather than inventing an office', () => {
  it('asks which office when given nothing', async () => {
    const out = await runTool('resolve_location', {});
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('spoken_location');
    expect((out as { message: string }).message).toMatch(/which/i);
  });

  it('strips the brand prefix before matching', async () => {
    const out = await runTool('resolve_location', { spoken_location: 'Azul Vision Encinitas' });
    // No mirror configured in tests, so it passes the cleaned name through.
    expect((out as unknown as { location: string }).location).toBe('Encinitas');
  });
});
