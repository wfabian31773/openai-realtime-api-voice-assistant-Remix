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
  it('registers who / where / already-asked / what-kind / file-it', () => {
    // Five tools, and they are the whole call: who is calling, which office
    // they use, whether they have already asked, what kind of request it is,
    // and file it. Nothing here decides WHETHER the call is optical — that came
    // from the queue it arrived on, which is the point of routing by queue and
    // why this set stays small.
    const names = manifest().map((t) => t.name);
    expect(names).toContain('lookup_patient');
    expect(names).toContain('resolve_location');
    expect(names).toContain('check_open_tickets');
    expect(names).toContain('classify_optical_request');
    expect(names).toContain('file_optical_ticket');
  });

  it('gives filing enough time to finish', () => {
    // submit-ticket's measured p95 is 22.8s and its worst case 319s. Filing is
    // the one step where giving up early loses the caller's request outright,
    // so its timeout is deliberately not the default.
    const file = manifest().find((t) => t.name === 'file_optical_ticket');
    expect(file!.timeout_seconds).toBeGreaterThanOrEqual(30);
  });

  it('will not file without the things a ticket cannot be assigned without', () => {
    const file = manifest().find((t) => t.name === 'file_optical_ticket');
    const required = file!.input_schema.required ?? [];
    expect(required).toContain('first_name');
    expect(required).toContain('last_name');
    expect(required).toContain('callback_number');
  });

  /**
   * `date_of_birth` left `required` on 2026-09-01 for the same reason
   * `location` did, and the gate is unchanged in both cases.
   *
   * Operator: *"if we do our job and validate and pass the patient records
   * along, you will not have this issue."* `lookup_patient` finds the caller on
   * 95% of queue calls and the service returns their date of birth with the
   * match — but `validateInput` refuses before the handler runs, so the handler
   * could never consult it. 45 calls in fourteen days were refused for a date
   * of birth and lost; on 23 the patient had already been identified.
   *
   * The behaviour that matters is asserted instead of the schema shape: with
   * nothing verified for this call, the tool still refuses.
   */
  it('still refuses a date of birth it has neither been given nor verified', async () => {
    const { resetVerifiedIdentities } = await import('./verifiedIdentity');
    resetVerifiedIdentities();
    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      callback_number: '845-531-7471',
      location: 'Eastvale',
      request_description: 'my glasses broke at the hinge',
      call_sid: 'CA00000000000000000000000000000078',
    });
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('date_of_birth');
  });

  /**
   * CHANGED 2026-09-01, and the old assertion is written out here so this is
   * not read as the gate being dropped: this used to require `location` in the
   * schema's `required` list, on the reasoning that one optician per office
   * means a ticket without one reaches nobody. That reasoning still holds.
   *
   * What changed is where it is enforced. Operator ruling: *"if you gate the
   * location, the agent will ask and if no answer, unassigned."* `validateInput`
   * refuses before the handler runs, so while `location` sat in `required` the
   * second half of that sentence was unreachable — a caller who could not name
   * an office was refused for as long as they stayed on the line, and then lost.
   * 62 calls in fourteen days ended exactly that way.
   *
   * So the gate moved into the handler, which can count how many times this
   * call has already been asked. The assertion moved with it, from the shape of
   * the schema to the behaviour, which is the thing that actually mattered.
   */
  it('still refuses the first time it is called without an office', async () => {
    const { resetGateAttempts } = await import('./gateAttempts');
    resetGateAttempts();
    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'my glasses broke at the hinge',
      call_sid: 'CA00000000000000000000000000000077',
    });
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('location');
    expect((out as { message: string }).message).toMatch(/which of our offices/i);
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

describe('lookup_patient must not hand Optical a surgery center', () => {
  // Found by predicting this tool's answer for a real patient before running
  // it: their most recent Active visit is at Loma Linda SURGERY CENTER. An
  // agent that took "where were they last seen" as "which office do they use"
  // would file a glasses ticket against a building with no optician — and
  // Optical assigns by location, so it would reach nobody.
  it('separates the clinic from the last place they were seen', async () => {
    const out = await runTool('lookup_patient', { phone: '845-531-7471' });
    if (!('found' in out) || out.found !== true) return; // no DB in this sandbox
    // The two must be distinct fields, so an agent cannot conflate them.
    expect(out).toHaveProperty('usual_clinic');
    expect(out).toHaveProperty('last_location_any_kind');
  });

  it('degrades to a clean answer when the database is unreachable', async () => {
    // This sandbox has no DATABASE_URL, so the lookup cannot run. What matters
    // is that the agent gets something it can act on rather than an exception:
    // either a real answer, or a retryable failure. Never a throw, never a
    // hang, never a half-built object.
    const out = await runTool('lookup_patient', { phone: '000-000-0000' });
    if (out.success) {
      expect(out).toHaveProperty('found');
    } else {
      expect(out).toMatchObject({ retryable: true });
      expect((out as { error: string }).error).toBeTruthy();
    }
  });
});
