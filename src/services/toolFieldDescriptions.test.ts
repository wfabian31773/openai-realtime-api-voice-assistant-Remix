/**
 * The description copy on its own, against the SDK's real converter — the
 * shapes the two live lanes do not exercise today (nesting, arrays, nullable,
 * effects) and the one trap they did: the converter's shared leaf objects.
 * The lanes themselves are pinned on the wire in
 * src/runtime/toolFieldDescriptionsReachTheWire.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '@openai/agents/realtime';
import { keepFieldDescriptions, withFieldDescriptions } from './toolFieldDescriptions';

/** What the SDK sends for `zod` today — an optional field forces its fallback. */
const sdkSchema = (zod: z.ZodObject<any>) =>
  (tool({ name: 't', description: 'd', parameters: zod, execute: async () => 'ok' }) as any).parameters;

describe('withFieldDescriptions', () => {
  it('the SDK really does drop them, so this is fixing something', () => {
    const zod = z.object({ a: z.string().describe('A'), b: z.string().optional().describe('B') });
    expect(JSON.stringify(sdkSchema(zod))).not.toContain('"description"');
  });

  it('copies each field its own words, through optional, nullable, default and effects', () => {
    const zod = z.object({
      plain: z.string().describe('plain'),
      optional: z.boolean().optional().describe('optional'),
      inner: z.boolean().describe('inner').optional(),
      defaulted: z.enum(['x', 'y']).default('x').describe('defaulted'),
      nullable: z.string().nullable().describe('nullable'),
      refined: z.string().refine((s) => s.length > 1).describe('refined'),
      bare: z.boolean().optional(),
    });
    const out = withFieldDescriptions(sdkSchema(zod), zod) as any;
    const words = Object.fromEntries(Object.entries(out.properties).map(([k, v]: [string, any]) => [k, v.description]));
    expect(words).toEqual({
      plain: 'plain', optional: 'optional', inner: 'inner', defaulted: 'defaulted',
      nullable: 'nullable', refined: 'refined', bare: undefined,
    });
  });

  it('gives two fields of one type their OWN words — the SDK shares one leaf object between them', () => {
    const zod = z.object({ first: z.boolean().optional().describe('first'), second: z.boolean().optional().describe('second') });
    const sdk = sdkSchema(zod);
    expect(sdk.properties.first).toBe(sdk.properties.second); // the trap, as the SDK builds it
    const out = withFieldDescriptions(sdk, zod) as any;
    expect([out.properties.first.description, out.properties.second.description]).toEqual(['first', 'second']);
  });

  it('never writes into the schema it was given, nor into the SDK\'s shared leaves', () => {
    const zod = z.object({ flag: z.boolean().optional().describe('flag') });
    const sdk = sdkSchema(zod);
    const before = JSON.stringify(sdk);
    withFieldDescriptions(sdk, zod);
    expect(JSON.stringify(sdk)).toBe(before);
    expect(JSON.stringify(sdkSchema(z.object({ other: z.boolean().optional() })))).not.toContain('flag');
  });

  it('reaches nested objects and array items', () => {
    const zod = z.object({
      who: z.object({ name: z.string().optional().describe('name') }).optional().describe('who'),
      maybe: z.object({ id: z.string().describe('id') }).nullable().optional(),
      list: z.array(z.object({ code: z.string().optional().describe('code') })).optional().describe('list'),
    });
    const out = withFieldDescriptions(sdkSchema(zod), zod) as any;
    expect(out.properties.who.description).toBe('who');
    expect(out.properties.who.properties.name.description).toBe('name');
    expect(out.properties.maybe.anyOf[0].properties.id.description).toBe('id');
    expect(out.properties.list.description).toBe('list');
    expect(out.properties.list.items.properties.code.description).toBe('code');
  });

  it('keeps a description the schema already has, and leaves a plain JSON tool alone', () => {
    const zod = z.object({ a: z.string().describe('from zod') });
    const given = { type: 'object', properties: { a: { type: 'string', description: 'already here' } }, required: ['a'] };
    expect((withFieldDescriptions(given, zod) as any).properties.a.description).toBe('already here');
    expect(withFieldDescriptions(given, given)).toBe(given);
  });

  it('keepFieldDescriptions changes the parameters and nothing else on the tool', async () => {
    const zod = z.object({ n: z.number().optional().describe('n') });
    const built = tool({ name: 't', description: 'd', parameters: zod, execute: async () => 'ran' }) as any;
    const kept = keepFieldDescriptions(built, zod) as any;
    expect(kept.parameters.properties.n.description).toBe('n');
    expect({ ...kept, parameters: undefined }).toEqual({ ...built, parameters: undefined });
    // The zod parse is the SDK's, so a wrong type is still refused.
    expect(await kept.invoke({}, JSON.stringify({ n: 'not a number' }))).toContain('Invalid JSON input for tool');
    expect(await kept.invoke({}, JSON.stringify({ n: 3 }))).toBe('ran');
  });
});
