import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({ db: {}, pool: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_c: unknown, _n: unknown, fn: unknown) => fn }));
import { createOpticalAgent } from './opticalAgent';
import { createSurgeryAgent } from './surgeryAgent';
import { createTechAgent } from './techAgent';
import { createRecordsAgent } from './recordsAgent';

describe('item #15 appointment access reaches the voice model', () => {
  it.each([
    ['VA-74600', createOpticalAgent], ['76186', createSurgeryAgent],
    ['67478', createTechAgent], ['VA-75007', createRecordsAgent],
  ] as const)('%s: the built agent can check and review a booking before requesting another', async (_ticket, factory) => {
    const agent = await factory(undefined, { callId: 'synthetic-item15', callSid: `CA${'15'.repeat(16)}` });
    const tool = agent.tools.find((t) => t.name === 'check_patient_appointments');
    expect(tool).toBeDefined();
    const prompt = String(agent.instructions) + '\n' + (tool as { description: string }).description;
    expect(prompt).toContain('check_patient_appointments');
    expect(prompt).toMatch(/before.*appointment request/i);
    expect(prompt).toMatch(/never claim.*no appointment access/i);
    expect(prompt).toMatch(/same booking/i);
    expect(prompt).toMatch(/duplicate/i);
  });
});
