/**
 * CA9dfc0fa32af0d0548cbda1a764cd11c0: scheduling reached Optical, six office
 * refusals, then a callback promise without a ticket. Synthetic failure shapes
 * exercise the live create_pcp_task tool; only the ticketing boundary is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';
import type { CreateTicketParams, CreateTicketResponse } from '../../server/services/ticketingApiClient';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createTicket: vi.fn<(params: CreateTicketParams) => Promise<CreateTicketResponse>>(),
  createPcpTicket: vi.fn(),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

let sequence = 0;
function patientCall() {
  const callId = `pcp-patient-scheduling-${++sequence}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' }), { callId });
  pcpDirector.update(callId, {
    callPurpose: 'patient_caller',
    callerIsThePatient: true,
    callerName: 'Synthetic Patient',
    callbackNumber: '5005550006',
  });
  const file = async (narrative: string, urgency = 'normal') => {
    const tool = agent.tools.find((candidate) => candidate.name === 'create_pcp_task')!;
    if (!('invoke' in tool)) throw new Error('create_pcp_task must be a function tool');
    const raw = await tool.invoke(new RunContext({ history: [] }), JSON.stringify({ narrative, urgency }));
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
  return { callId, file };
}

beforeEach(() => {
  ticketing.createTicket.mockReset();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST-122' });
  ticketing.createPcpTicket.mockReset();
});

describe('a PCP patient scheduling request reaches the HVA Hub', () => {
  it.each([
    'I need to schedule my appointment for new glasses.',
    'Patient requests appointment scheduling for glasses.',
  ])('routes scheduling ahead of eyewear: %s', async (narrative) => {
    const { callId, file } = patientCall();
    const result = await file(narrative);

    expect(result).toMatchObject({ success: true, routed_to: 'HVA Hub', ticketNumber: 'VA-TEST-122' });
    expect(ticketing.createTicket).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      departmentId: 9, requestTypeId: 32, requestReasonId: 146,
    }));
    expect(pcpDirector.filedForCurrentPatient(callId)?.ticketNumber).toBe('VA-TEST-122');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it.each([
    ['schedule_appointment', 146],
    ['reschedule_appointment', 147],
    ['cancel_appointment', 148],
  ] as const)('honors the captured %s purpose for a patient', async (callPurpose, requestReasonId) => {
    const { callId, file } = patientCall();
    pcpDirector.update(callId, { callPurpose });
    const result = await file('Patient needs a different visit for their glasses.');

    expect(result.routed_to).toBe('HVA Hub');
    expect(ticketing.createTicket).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      departmentId: 9, requestTypeId: 32, requestReasonId,
    }));
  });

  it.each([
    ['My glasses broke at the hinge.', 1],
    ['I need to reschedule my cataract surgery.', 2],
  ] as const)('preserves the destination for %s', async (narrative, departmentId) => {
    const { callId, file } = patientCall();
    pcpDirector.update(callId, { callPurpose: 'reschedule_appointment' });
    // Eyewear-only requests have no stated scheduling purpose.
    if (departmentId === 1) pcpDirector.update(callId, { callPurpose: 'patient_caller' });
    await file(narrative);
    expect(ticketing.createTicket.mock.calls[0][0].departmentId).toBe(departmentId);
  });
});

describe('PCP uses the unassigned exit after a routing-field refusal', () => {
  it.each([
    ['My glasses broke at the hinge.', 1, 'office', 400],
    ['My glasses broke at the hinge.', 1, 'location', 422],
    ['I have a question about my cataract surgery.', 2, 'surgeon', 400],
    ['I have a question about my cataract surgery.', 2, 'office', 422],
  ] as const)('uses the unassigned exit for %s (department %s, missing %s, status %s)', async (narrative, departmentId, field, statusCode) => {
    ticketing.createTicket.mockImplementation(async (params) => params.routingAskExhausted
      ? { success: true, ticketNumber: 'VA-TEST-122' }
      : { success: false, statusCode, error: `Missing required information: ${field}.` });
    const { callId, file } = patientCall();
    const result = await file(narrative);

    expect(result).toMatchObject({ success: true, ticketNumber: 'VA-TEST-122' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
    const [first, second] = ticketing.createTicket.mock.calls.map(([params]) => params);
    expect(first).toMatchObject({ departmentId });
    expect(first.routingAskExhausted).toBeUndefined();
    expect(second).toEqual({ ...first, routingAskExhausted: true });
    expect(second.locationId).toBeUndefined();
    expect(second.providerId).toBeUndefined();
    expect(pcpDirector.filedForCurrentPatient(callId)?.ticketNumber).toBe('VA-TEST-122');

    const repeated = await file(narrative);
    expect(repeated.alreadyFiled).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'office'], [503, 'office'], [401, 'office'],
    [400, 'date_of_birth'], [422, 'patientPhone'],
  ] as const)('does not use unassigned for status %s / field %s', async (statusCode, field) => {
    ticketing.createTicket.mockResolvedValue({ success: false, statusCode, error: `Missing required information: ${field}.` });
    const { callId, file } = patientCall();
    const result = await file('My glasses broke.');
    expect(result.success).toBe(false);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketing.createTicket.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
  });

  it('does not waive a routing field in a different department', async () => {
    ticketing.createTicket.mockResolvedValue({ success: false, statusCode: 400, error: 'Missing required information: office.' });
    const { file } = patientCall();
    await file('I need a refill of my eye drops.');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketing.createTicket.mock.calls[0][0].departmentId).toBe(3);
  });

  it('stops after one unassigned retry and does not claim an unfiled request is recorded', async () => {
    ticketing.createTicket.mockResolvedValue({ success: false, statusCode: 400, error: 'Missing required information: office.' });
    const { callId, file } = patientCall();
    const result = await file('My glasses broke.');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(result.guidance).toMatch(/do not ask for an office or surgeon/i);
    expect(result.guidance).toMatch(/no ticket was created/i);
    expect(result.guidance).toMatch(/do not .*promise a callback/i);
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
  });

  it.each([400, 422])('caches an unassigned payload refusal (HTTP %s)', async (statusCode) => {
    ticketing.createTicket
      .mockResolvedValueOnce({ success: false, statusCode: 400, error: 'Missing required information: office.' })
      .mockResolvedValueOnce({ success: false, statusCode, error: 'Payload refused.' });
    const { file } = patientCall();
    await file('My glasses broke.');
    const repeated = await file('My glasses broke.');

    expect(repeated).toMatchObject({ success: false, error: 'Payload refused.' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
  });

  it('routes a later records request for the same patient after an Optical refusal', async () => {
    ticketing.createTicket
      .mockResolvedValueOnce({ success: false, statusCode: 400, error: 'Missing required information: office.' })
      .mockResolvedValueOnce({ success: false, statusCode: 422, error: 'Payload refused.' });
    const { callId, file } = patientCall();
    pcpDirector.update(callId, {
      patientDob: '1990-01-01', recordsDeliveryMethod: 'fax', recordsDeliveryDestination: '5005550010',
    });
    await file('My glasses broke.');

    const records = await file('I need a copy of my records.');
    expect(records).toMatchObject({ success: true, routed_to: 'Medical Records' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(3);
    expect(ticketing.createTicket.mock.calls[2][0].departmentId).toBe(16);
  });

  it.each([
    ['a different route', 'I need a refill of my eye drops.', 'normal', 3],
    ['a changed description on the same route', 'My glasses need a new lens.', 'normal', 1],
    ['a changed priority on the same route', 'My glasses broke.', 'urgent', 1],
  ])('allows %s after a rejected unassigned payload', async (_case, narrative, urgency, departmentId) => {
    ticketing.createTicket
      .mockResolvedValueOnce({ success: false, statusCode: 400, error: 'Missing required information: office.' })
      .mockResolvedValueOnce({ success: false, statusCode: 422, error: 'Payload refused.' });
    const { file } = patientCall();
    await file('My glasses broke.');

    const result = await file(narrative, urgency);
    expect(result).toMatchObject({ success: true, ticketNumber: 'VA-TEST-122' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(3);
    expect(ticketing.createTicket.mock.calls[2][0].departmentId).toBe(departmentId);
  });

  it('allows a corrected contact number after a rejected unassigned payload', async () => {
    ticketing.createTicket
      .mockResolvedValueOnce({ success: false, statusCode: 400, error: 'Missing required information: office.' })
      .mockResolvedValueOnce({ success: false, statusCode: 422, error: 'Payload refused.' });
    const { callId, file } = patientCall();
    await file('My glasses broke.');
    pcpDirector.update(callId, { callbackNumber: '5005550011' });

    const result = await file('My glasses broke.');
    expect(result).toMatchObject({ success: true, ticketNumber: 'VA-TEST-122' });
    expect(ticketing.createTicket.mock.calls[2][0].patientPhone).toBe('5005550011');
  });

  it('allows corrected contact details after the unassigned retry still names the routing field', async () => {
    const missingOffice = { success: false, statusCode: 400, error: 'Missing required information: office.' };
    ticketing.createTicket.mockResolvedValueOnce(missingOffice).mockResolvedValueOnce(missingOffice);
    const { callId, file } = patientCall();
    await file('My glasses broke.');
    pcpDirector.update(callId, { callbackNumber: '5005550011' });

    const result = await file('My glasses broke.', 'urgent');
    expect(result).toMatchObject({ success: true, ticketNumber: 'VA-TEST-122' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(3);
    expect(ticketing.createTicket.mock.calls[2][0].patientPhone).toBe('5005550011');
  });

  it.each([408, 429, 401, 403, 409, 503])(
    'allows a later filing after the unassigned retry receives HTTP %s',
    async (statusCode) => {
      ticketing.createTicket
        .mockResolvedValueOnce({ success: false, statusCode: 400, error: 'Missing required information: office.' })
        .mockResolvedValueOnce({ success: false, statusCode, error: 'Temporarily unavailable.' })
        .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-122' });
      const { callId, file } = patientCall();
      const result = await file('My glasses broke.');

      expect(result.success).toBe(false);
      if (statusCode === 401 || statusCode === 403) {
        expect(result.guidance).toMatch(/do not ask for an office or surgeon.*repeat this filing/i);
      }
      expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
      expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();

      const recovered = await file('My glasses broke.');
      expect(recovered).toMatchObject({ success: true, ticketNumber: 'VA-TEST-122' });
      expect(ticketing.createTicket).toHaveBeenCalledTimes(3);
      const payloads = ticketing.createTicket.mock.calls.map(([params]) => params);
      expect(payloads[2].idempotencyKey).toBe(payloads[0].idempotencyKey);
    },
  );
});
