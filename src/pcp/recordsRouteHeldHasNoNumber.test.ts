/**
 * A RECORDS REQUEST THE OUTBOX HOLDS HAS NO NUMBER, AND PCP MUST NOT INVENT
 * ONE — Codex P2 on #376.
 *
 * `file_records_ticket` answers `success: true` with `filed_pending` and no
 * `ticket_number` when the outbox holds the request: on a plain outage, and
 * since v127 when a refused filing's recovery POST fails too. PCP's records
 * route read every success as numbered, so the agent was told "Filed as
 * undefined with our medical records team. Read the ticket number back".
 *
 * Asserted on the AGENT path, because the defect lives in PCP's wrapper — the
 * records tool's own answer was already right. Synthetic names only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-58100' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-58200' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const writeToOutbox = vi.hoisted(() => vi.fn());
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox } };
});

const { createPcpAgent } = await import('../agents/pcpAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { pcpDirector } = await import('./director');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAheldnonumber${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

const OUTAGE = { success: false, error: 'upstream 503' };
const UNASKABLE_400 = { success: false, statusCode: 400, error: 'Missing required information: somethingElse' };

async function clinicAsksForRecords(agent: any) {
  await call(agent, 'record_pcp_intake', {
    callPurpose: 'patient_medical_records_request',
    callerName: 'Dr Testcaller Example',
    callerRole: 'primary care provider',
    callerOrganization: 'Example Family Medicine',
    callerFacilityType: 'pcp_office',
    statedRelationship: 'primary care provider',
    patientFirstName: 'Testpatient',
    patientLastName: 'Example',
    patientDob: '1950-01-02',
    recordsDeliveryMethod: 'fax',
    recordsDeliveryDestination: '9095550199',
  });
  return call(agent, 'handle_patient_medical_records_request', {
    narrative: 'Records request for a mutual patient, to be faxed.',
  });
}

beforeEach(() => {
  resetGateAttempts();
  ticketing.createPcpTicket.mockReset();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-58100' });
  ticketing.createTicket.mockReset();
  writeToOutbox.mockReset();
});

describe('a records request the outbox holds', () => {
  it('on a plain outage: says there is no number, never "undefined"', async () => {
    ticketing.createTicket.mockResolvedValueOnce(OUTAGE as never);
    writeToOutbox.mockResolvedValue({ outboxId: 'ob-pcp-1', alreadyExists: false });
    const { agent, callId } = freshCall();

    const out = await clinicAsksForRecords(agent);

    expect(out.success).toBe(true);
    expect(out.filed_pending).toBe(true);
    expect(out.routed_to).toBe('Medical Records');
    // Held is filed: the call may end, and the teardown floor has nothing left to file.
    expect(pcpDirector.next(callId).mayTerminate).toBe(true);
    expect(out.ticketNumber).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/undefined/);
    expect(String(out.message)).toMatch(/no ticket number yet/i);
    expect(String(out.message)).toMatch(/do not invent one/i);
    expect(String(out.message)).toMatch(/do not ask them to call back/i);
    // Held by the outbox is still filed: no second ticket in PCP Support.
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('on a refusal whose recovery the outbox holds (the Codex path): the same, and the recovery is counted', async () => {
    ticketing.createTicket
      .mockResolvedValueOnce(UNASKABLE_400 as never)
      .mockResolvedValueOnce(OUTAGE as never);
    writeToOutbox.mockResolvedValue({ outboxId: 'ob-pcp-2', alreadyExists: false });
    const { agent, callId } = freshCall();

    const out = await clinicAsksForRecords(agent);

    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
    expect(writeToOutbox).toHaveBeenCalledTimes(1);
    expect(out.success).toBe(true);
    expect(out.filed_pending).toBe(true);
    expect(out.recovered_after_refusal).toBe(true);
    expect(out.routed_to).toBe('Medical Records');
    expect(out).not.toHaveProperty('ticketNumber');
    expect(pcpDirector.next(callId).mayTerminate).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/undefined/);
    expect(String(out.message)).toMatch(/no ticket number yet/i);

    const again = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Records request for a mutual patient, to be faxed.',
    });
    expect(again.alreadyFiled).toBe(true);
    expect(String(again.guidance)).toMatch(/no ticket number yet/i);
    expect(String(again.guidance)).not.toMatch(/undefined|read it now/i);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('a second ask on the call is answered as already filed — still with no number to read back', async () => {
    ticketing.createTicket.mockResolvedValueOnce(OUTAGE as never);
    writeToOutbox.mockResolvedValue({ outboxId: 'ob-pcp-3', alreadyExists: false });
    const { agent } = freshCall();
    await clinicAsksForRecords(agent);

    const again = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Records request for a mutual patient, to be faxed.',
    });

    expect(again.alreadyFiled).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(String(again.guidance)).toMatch(/no ticket number yet/i);
    expect(String(again.guidance)).not.toMatch(/read it now/i);
  });

  it('CONTROL: a numbered filing still reads its number back', async () => {
    ticketing.createTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-58201' } as never);
    const { agent } = freshCall();

    const out = await clinicAsksForRecords(agent);

    expect(out.ticketNumber).toBe('VA-58201');
    expect(out.filed_pending).toBeUndefined();
    expect(String(out.message)).toMatch(/^Filed as VA-58201 with our medical records team/);
  });

  it('CONTROL: a numbered recovery is counted on the PCP tool', async () => {
    ticketing.createTicket
      .mockResolvedValueOnce(UNASKABLE_400 as never)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-58202' } as never);
    const { agent } = freshCall();

    const out = await clinicAsksForRecords(agent);

    expect(out.ticketNumber).toBe('VA-58202');
    expect(out.recovered_after_refusal).toBe(true);
  });
});
