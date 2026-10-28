import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';
import { toGrokTools, type LiveTool } from '../runtime/agentBinding';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createAnsweringServiceAgent } = await import('./answeringServiceAgent');
const { createAfterHoursAgent } = await import('./afterHoursAgent');
const { createNoIvrAgentV2 } = await import('./noIvrAgentV2');
const { createTicketTool } = await import('./tools/createTicketTool');
const agents = new Map<string, LiveTool[]>();

beforeAll(async () => {
  const handoff = async () => {};
  agents.set('answering-service', (await createAnsweringServiceAgent(handoff, {})).tools as LiveTool[]);
  agents.set('after-hours', (await createAfterHoursAgent(handoff)).tools as LiveTool[]);
  agents.set('no-ivr-v2', (await createNoIvrAgentV2(handoff, { callId: 'synthetic-contact-wire' })).tools as LiveTool[]);
  agents.set('shared-create-ticket', [createTicketTool] as LiveTool[]);
});

describe('contact guidance on the schema sent to the model', () => {
  it.each([
    ['answering-service', 'lookup_schedule', 'last_name', /spell.*letter by letter/],
    ['answering-service', 'create_ticket', 'last_name', /spell.*letter by letter/],
    ['answering-service', 'create_ticket', 'email', /complete address back.*confirm/],
    ['after-hours', 'create_after_hours_ticket', 'patient_last_name', /spell.*letter by letter/],
    ['after-hours', 'create_after_hours_ticket', 'patient_email', /complete address back.*confirm/],
    ['no-ivr-v2', 'lookup_schedule', 'last_name', /spell.*letter by letter/],
    ['no-ivr-v2', 'create_ticket', 'last_name', /spell.*letter by letter/],
    ['no-ivr-v2', 'create_ticket', 'email', /complete address back.*confirm/],
    ['shared-create-ticket', 'create_ticket', 'patientLastName', /spell.*letter by letter/],
    ['shared-create-ticket', 'create_ticket', 'patientEmail', /complete address back.*confirm/],
  ] as const)('%s/%s.%s keeps its capture instruction', (agent, name, field, wording) => {
    const { defs } = toGrokTools(agents.get(agent)!);
    const schema = defs.find((t) => t.name === name)?.parameters as {
      properties?: Record<string, { description?: string }>;
    } | undefined;
    expect(schema?.properties?.[field]?.description).toMatch(wording);
  });

  it('keeps SDK validation on the shared ticket tool', async () => {
    expect(await createTicketTool.invoke(new RunContext(), JSON.stringify({ patientLastName: 42 })))
      .toContain('Invalid JSON input for tool');
  });

  it('allows answering-service filing to omit identity fields supplied by a held record', () => {
    const schema = toGrokTools(agents.get('answering-service')!).defs
      .find((t) => t.name === 'create_ticket')!.parameters as { required?: string[] };
    for (const field of ['first_name', 'last_name', 'date_of_birth']) {
      expect(schema.required ?? []).not.toContain(field);
    }
  });

  it.each([
    ['answering-service', 'lookup_schedule', false],
    // Held validated identity can supply an omitted surname at filing.
    ['answering-service', 'create_ticket', false],
    ['no-ivr-v2', 'lookup_schedule', false],
    ['no-ivr-v2', 'create_ticket', true],
  ] as const)('%s/%s preserves surname validation and required status', async (agent, name, required) => {
    const tools = agents.get(agent)!;
    const live = tools.find((t) => t.name === name);
    expect(await live?.invoke?.(new RunContext(), JSON.stringify({ last_name: 42 })))
      .toContain('Invalid JSON input for tool');
    const schema = toGrokTools(tools).defs.find((t) => t.name === name)?.parameters as { required?: string[] };
    expect(schema.required?.includes('last_name') ?? false).toBe(required);
  });
});
