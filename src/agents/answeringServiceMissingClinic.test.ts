import { beforeEach, expect, it, vi } from 'vitest';

// Exercise the actual handler and Zod inputs without starting the voice SDK.
// SDK schema conversion remains covered by contactCaptureWire.test.ts.
vi.mock('@openai/agents/realtime', () => ({
  RealtimeAgent: class {
    constructor(options: object) { Object.assign(this, options); }
  },
  tool: (definition: {
    parameters: { parse(input: unknown): unknown };
    execute(input: unknown): unknown;
  }) => ({
    ...definition,
    invoke: (_context: unknown, raw: string) => definition.execute(definition.parameters.parse(JSON.parse(raw))),
  }),
}));

const h = vi.hoisted(() => ({ lookup: vi.fn(), phone: vi.fn(), submit: vi.fn() }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => {} } }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_ctx: unknown, _name: string, execute: unknown) => execute }));
vi.mock('../services/callerMemoryService', () => ({ CallerMemoryService: {
  getInstance: () => ({ getCallerMemory: async () => null }),
} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupByNameAndDOB: h.lookup, lookupByPhone: h.phone },
}));
vi.mock('../services/syncAgentService', () => ({ SyncAgentService: { submitSimplifiedTicket: h.submit } }));
import { createAnsweringServiceAgent } from './answeringServiceAgent';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';

const sid = 'CA' + 'e'.repeat(32);
const args = { first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02' };
const record = { patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
  patientData: { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' },
  upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Clinic' }],
  pastAppointments: [], totalAppointmentsFound: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  resetVerifiedIdentities();
  h.lookup.mockResolvedValue(record);
  h.phone.mockResolvedValue({ ...record, matchedBy: 'phone', identityUnconfirmed: true });
  h.submit.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});
async function invoke(agent: any, name: string, input: Record<string, unknown>) {
  const raw = await agent.tools.find((t: any) => t.name === name).invoke({}, JSON.stringify(input));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const opticalRequest = {
  ...args, department_id: 1, request_type_id: 1, request_reason_id: 1,
  callback_number: '5555550100', subject: 'Optical callback requested',
  description: 'Synthetic glasses question',
};

it.each([false, true])('Optical files a missing-clinic request for human review after asking (held identity: %s)', async (held) => {
  h.lookup.mockResolvedValue({ ...record, upcomingAppointments: [], totalAppointmentsFound: 0 });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  if (held) await invoke(agent, 'lookup_schedule', args);
  const request = held ? { ...opticalRequest, first_name: '', last_name: '', date_of_birth: '' } : opticalRequest;

  expect(await invoke(agent, 'create_ticket', request)).toMatchObject({ success: false });
  expect(h.submit).not.toHaveBeenCalled();

  const unresolved_info = 'Asked for the office; caller does not know which clinic they visit';
  expect(await invoke(agent, 'create_ticket', { ...request, unresolved_info }))
    .toMatchObject({ success: true, department: 'Optical Support' });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
    patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02',
    locationOfLastVisit: undefined, callSid: sid,
    reasonForCalling: expect.stringContaining(`NEEDS HUMAN REVIEW — could not complete on the call. Missing: ${unresolved_info}`),
  }));
});

it.each([undefined, '', '   '])('Optical still asks for a missing clinic without a cannot-provide note (%j)', async (unresolved_info) => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  const result = await invoke(agent, 'create_ticket', { ...opticalRequest, unresolved_info });
  expect(result).toMatchObject({ success: false });
  expect(result.missingFields).toHaveLength(1);
  expect(result.missingFields[0]).toMatch(/location/);
  expect(h.submit).not.toHaveBeenCalled();
});

it('a cannot-provide clinic note does not bypass the DOB gate', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  expect(await invoke(agent, 'create_ticket', {
    ...opticalRequest, date_of_birth: '', unresolved_info: 'Caller cannot provide their clinic',
  })).toMatchObject({ success: false, missingFields: ['date_of_birth'] });
  expect(h.submit).not.toHaveBeenCalled();
});
