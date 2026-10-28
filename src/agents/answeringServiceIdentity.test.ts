import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lookup: vi.fn(), phone: vi.fn(), submit: vi.fn() }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => {} } }));
vi.mock('../services/toolTimeline', () => ({ recordingExecute: (_ctx: unknown, _name: string, execute: unknown) => execute }));
vi.mock('../services/callerMemoryService', () => ({ CallerMemoryService: {
  getInstance: () => ({ getCallerMemory: async () => null }),
} }));
vi.mock('../services/scheduleLookupService', async (original) => ({
  ...await original<typeof import('../services/scheduleLookupService')>(),
  scheduleLookupService: { lookupByNameAndDOB: h.lookup, lookupByPhone: h.phone },
}));
vi.mock('../services/syncAgentService', () => ({ SyncAgentService: { submitSimplifiedTicket: h.submit } }));
import { createAnsweringServiceAgent } from './answeringServiceAgent';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { clearAllLedgers } from '../services/callFactsLedger';

const sid = 'CA' + 'e'.repeat(32);
const args = { first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02' };
const record = { patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true },
  patientData: { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02' },
  upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Clinic' }],
  pastAppointments: [], totalAppointmentsFound: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  resetVerifiedIdentities();
  clearAllLedgers();
  h.lookup.mockResolvedValue(record);
  h.phone.mockResolvedValue({ ...record, matchedBy: 'phone', identityUnconfirmed: true });
  h.submit.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});
async function invoke(agent: any, name: string, input: Record<string, unknown>) {
  const raw = await agent.tools.find((t: any) => t.name === name).invoke({}, JSON.stringify(input));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
it('VA-75419 / #12: answering-service lookup stays locked for later appointment questions', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);
  h.lookup.mockResolvedValue({ ...record, patientFound: false });
  expect(await invoke(agent, 'lookup_schedule', args)).toMatchObject({ found: true });
  expect(h.lookup).toHaveBeenCalledTimes(1);
});
it('VA-75969: answering-service filing inherits held DOB and clinic without another search', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);
  expect(await invoke(agent, 'create_ticket', { department_id: 3, request_type_id: 1,
    request_reason_id: 1, callback_number: '5555550100', subject: 'Callback requested',
    description: 'Synthetic appointment question' })).toMatchObject({ success: true });
  expect(h.lookup).toHaveBeenCalledTimes(1);
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ patientFullName: 'Alex Synthetic',
    patientDOB: '1970-01-02', locationOfLastVisit: 'Synthetic Clinic' }));
});
it('VA-76217: a phone candidate with the same DOB cannot override a different stated surname', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid,
    callId: 'synthetic-conflicting-name', callLogId: 'synthetic-log', callerPhone: '5555550100' });
  h.lookup.mockResolvedValue({ ...record, patientData: { ...record.patientData, lastName: 'Caller' } });
  await invoke(agent, 'lookup_schedule', { ...args, last_name: 'Caller' });
  expect(h.lookup).toHaveBeenCalledWith('Alex', 'Caller', '1970-01-02');
});
it('VA-76198: answering-service phone lookup returns a candidate without visit history', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  const result = await invoke(agent, 'lookup_schedule', { phone: '5555550100' });
  expect(result).toMatchObject({ found: true, identityUnconfirmed: true });
  expect(result.upcomingAppointments).toBeUndefined();
  expect(result.patientData).toBeUndefined();
});

it('keeps a preloaded phone match confirmed for later appointment questions without DOB', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid,
    callId: 'synthetic-dob-confirmation', callLogId: 'synthetic-log', callerPhone: '5555550100' });
  expect(await invoke(agent, 'lookup_schedule', { date_of_birth: args.date_of_birth }))
    .toMatchObject({ verified: true, appointment_access: 'available' });

  for (const query of [{}, { first_name: args.first_name, last_name: args.last_name }]) {
    const result = await invoke(agent, 'lookup_schedule', query);
    expect(result).toMatchObject({ found: true, appointment_access: 'available',
      upcomingAppointments: record.upcomingAppointments });
    expect(result.identityUnconfirmed).not.toBe(true);
  }
  expect(h.phone).toHaveBeenCalledTimes(1);
  expect(h.lookup).not.toHaveBeenCalled();
});

it('keeps an ambiguous preloaded phone match restricted after a matching DOB', async () => {
  h.phone.mockResolvedValue({ ...record, matchedBy: 'phone', identityUnconfirmed: true, identity: { unique: false } });
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid,
    callId: 'synthetic-ambiguous-dob', callLogId: 'synthetic-log', callerPhone: '5555550100' });
  const result = await invoke(agent, 'lookup_schedule', { phone: '5555550100', date_of_birth: args.date_of_birth });
  expect(result).toMatchObject({ found: true, identityUnconfirmed: true, appointment_access: 'identity_required' });
  expect(result.upcomingAppointments).toBeUndefined();
  expect(result.patientData).toBeUndefined();
});

it('preserves the requested clinic when filing with held appointment history', async () => {
  const agent = await createAnsweringServiceAgent(async () => {}, { callSid: sid });
  await invoke(agent, 'lookup_schedule', args);
  expect(await invoke(agent, 'create_ticket', { department_id: 3, request_type_id: 1,
    request_reason_id: 1, callback_number: '5555550100', subject: 'Callback requested',
    description: 'Synthetic appointment question', location_name: 'Synthetic Caller Clinic' }))
    .toMatchObject({ success: true });
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ patientFullName: 'Alex Synthetic',
    patientDOB: '1970-01-02', locationOfLastVisit: 'Synthetic Caller Clinic' }));
  expect(h.lookup).toHaveBeenCalledTimes(1);
});
