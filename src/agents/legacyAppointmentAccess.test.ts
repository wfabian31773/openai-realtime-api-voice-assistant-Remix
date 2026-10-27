import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({ db: {}, pool: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/callerMemoryService', () => ({ CallerMemoryService: class {}, callerMemoryService: {} }));
vi.mock('../services/toolDirection', () => ({ withToolDirection: (_a: unknown, _c: unknown, _n: unknown, fn: unknown) => fn }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_c: unknown, _n: unknown, fn: unknown) => fn }));
const { lookupByNameAndDOB } = vi.hoisted(() => ({ lookupByNameAndDOB: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: { lookupByNameAndDOB } }));
import { createNoIvrAgent, buildNoIvrSystemPrompt } from './noIvrAgent';
import { createAnsweringServiceAgent } from './answeringServiceAgent';
import { buildPcpPrompt } from './pcpAgent';

describe('item #15 existing appointment tools keep the same read-only policy', () => {
  it.each([undefined, 'runtime'] as const)('VA-75007: after-hours policy on pipeline %s reviews bookings first', (pipeline) => {
    const prompt = buildNoIvrSystemPrompt({ callId: 'synthetic-item15', pipeline });
    expect(prompt).toContain('Before an appointment request, use lookup_schedule');
    expect(prompt).toMatch(/same booking/i);
    expect(prompt).not.toContain('if the caller corrects you, trust the caller');
  });
  it('VA-75007: PCP appointment policy respects its existing access gate', () => {
    expect(buildPcpPrompt()).toContain('Before an appointment request, use lookup_patient_appointments');
  });
  it.each([
    ['VA-74600', createNoIvrAgent], ['67478', createAnsweringServiceAgent],
  ] as const)('%s: the existing lookup_schedule compares a named office with the booking', async (_ticket, factory) => {
    lookupByNameAndDOB.mockResolvedValue({
      patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
      scheduleReadStatus: 'available', pastAppointments: [], totalAppointmentsFound: 1,
      upcomingAppointments: [{ isoDate: '2099-11-04', startTime: '9:30 AM', location: 'Example North', provider: 'Morgan Example, MD' }],
    });
    const agent = await factory(async () => {}, { callId: 'synthetic-item15' });
    expect(String(agent.instructions)).toContain('Before an appointment request, use lookup_schedule');
    const tool = agent.tools.find((t) => t.name === 'lookup_schedule')!;
    const raw = await (tool as any).invoke({}, JSON.stringify({
      first_name: 'Synthetic', last_name: 'Example', date_of_birth: '1980-01-02', office: 'Example South',
    }));
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result).toMatchObject({ office_check: 'not_matched', scheduling_action: 'clarify_record_difference', read_only: true });
  });
});
