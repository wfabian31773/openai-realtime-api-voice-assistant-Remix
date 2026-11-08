/**
 * PCP'S ANSWER REACHES THE RECORDS CASE — v188.
 *
 * PCP asks "How would you like to receive the records" (103 of 108 records
 * calls, 2026-10-25..11-07), and until this build the answer reached the
 * ticket only inside the "Send to:" prose: `mr_cases.delivery_method_requested`
 * was empty on every PCP case until a staffer filled it. Driven through the
 * real agent's own tools, with the ticketing client mocked at the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-188' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-188-PCP' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CApcp188${++n}`;
  return createPcpAgent((async () => ({ ok: true as const })) as never, { callId } as never);
}

/** A synthetic office asking for a mutual patient's records. */
const PROFESSIONAL = {
  callerName: 'Test Caller',
  callerRole: 'referral coordinator',
  callerOrganization: 'Example Family Medicine',
  callerFacilityType: 'pcp_office',
  callbackNumber: '2025550142',
  statedRelationship: 'primary care provider',
  callPurpose: 'peer_to_peer',
  patientFirstName: 'Testpatient',
  patientLastName: 'Example',
  patientDob: '1950-01-02',
};

beforeEach(() => {
  ticketing.createTicket.mockClear();
  ticketing.createPcpTicket.mockClear();
});

describe('the method PCP asked travels as a field', () => {
  for (const [said, onCase] of [['fax', 'fax'], ['email', 'secure_email'], ['mail', 'mail']] as const) {
    it(`${said} → ${onCase}`, async () => {
      const agent = freshCall();
      await call(agent, 'record_pcp_intake', {
        ...PROFESSIONAL,
        recordsDeliveryMethod: said,
        recordsDeliveryDestination: said === 'email' ? 'office@example.test' : '202-555-0199',
      });
      const filed = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient.' });
      expect(filed.success, JSON.stringify(filed)).toBe(true);
      const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown> | undefined;
      expect(p, `the records library must be the one that filed: ${JSON.stringify(filed)} pcp=${ticketing.createPcpTicket.mock.calls.length}`).toBeTruthy();
      expect(p!.departmentId).toBe(16);
      expect(p!.deliveryMethodRequested).toBe(onCase);
      expect(String(p!.description)).toContain(`Delivery: by ${said}`);
    });
  }

  it('"unspecified" is an answer: no field, the gap written, and nothing asked twice', async () => {
    const agent = freshCall();
    await call(agent, 'record_pcp_intake', { ...PROFESSIONAL, recordsDeliveryMethod: 'unspecified' });
    const filed = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient.' });
    expect(filed.success, JSON.stringify(filed)).toBe(true);
    const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(p.deliveryMethodRequested).toBeUndefined();
    expect(String(p.description)).toContain('Delivery: NOT CAPTURED');
  });
});
