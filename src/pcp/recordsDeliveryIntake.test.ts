/**
 * CAdc07bca1b6e2c7daf43c9f3a8f5ee4fa — 2026-09-08 12:21 UTC, the operator's
 * own test call. Filed PCP-57918 and got three things wrong at once.
 *
 *   AGENT: Which organization are you calling from?
 *   AGENT: What type of healthcare organization is that?
 *   AGENT: What is your professional relationship to this patient?
 *   AGENT: What is the patient's first name?
 *   AGENT: What is the patient's last name?
 *   AGENT: What is the patient's date of birth?
 *   AGENT: Let me get this logged for you — one moment.
 *   [call ends]
 *
 * A records request was taken without ever asking WHERE THE RECORDS GO, and
 * then the line went dead mid-breath — no ticket number, no "here is what
 * happens next", no goodbye.
 *
 * Operator, same day: "if you want medical records, how would you like to
 * receive them by fax? What's the fax number? By email. What's your email?
 * ... gathering the information as we go, sort of filling out a form, asking
 * a question by question. That's what I think that everything should be like."
 *
 * So this is an EXTENSION of the director's existing one-question-at-a-time
 * machine, not a redesign of it — he was explicit that the guided shape is
 * what works and should not be tinkered with.
 *
 * The callback number is deliberately NOT part of this. It is seeded from
 * caller ID (pcpAgent.ts), and asking for it anyway was the single biggest
 * cause of discarded requests on 2026-08-06. The gap is that the number a
 * clinic happened to dial from is not somewhere you send records.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-57918' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CArecords${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

/** Everything the 12:21 call had gathered by the time it filed. */
const INTAKE_AS_ON_THE_CALL = {
  callPurpose: 'patient_medical_records_request',
  callerName: 'Dr Joseph Perez',
  callerRole: 'primary care provider',
  callerOrganization: 'De La Pena Family Medicine',
  callerFacilityType: 'pcp_office',
  statedRelationship: 'primary care provider',
  patientFirstName: 'A',
  patientLastName: 'B',
  patientDob: '1973-03-17',
};

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-57918' });
});

describe('a records request asks where the records go', () => {
  it('asks the delivery method before it files', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);

    const next = pcpDirector.next(callId).nextQuestion;
    expect(next?.field, 'the form is not finished until we know where records go').toBe(
      'recordsDeliveryMethod',
    );
    expect(next?.prompt).toMatch(/fax|email/i);
  });

  it('then asks for the destination, in the words of the method chosen', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'fax' });

    const next = pcpDirector.next(callId).nextQuestion;
    expect(next?.field).toBe('recordsDeliveryDestination');
    expect(next?.prompt, 'a fax destination is a fax number, not "an address"').toMatch(/fax number/i);

    // The same field, asked differently when the answer was email — the point
    // of asking question by question rather than reading one generic line.
    const second = freshCall();
    await call(second.agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(second.agent, 'record_pcp_intake', { recordsDeliveryMethod: 'email' });
    expect(pcpDirector.next(second.callId).nextQuestion?.prompt).toMatch(/email/i);
  });

  it('stops asking once it has both', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', {
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '9095550199',
    });
    expect(pcpDirector.next(callId).nextQuestion).toBeUndefined();
  });
});

describe('the caller is told what happened before the line goes quiet', () => {
  it('the records tool tells the agent to read the ticket number back', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      ...INTAKE_AS_ON_THE_CALL,
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '9095550199',
    });

    const filed = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Records request for a mutual patient, to be faxed.',
    });

    expect(filed.success).toBe(true);
    expect(filed.ticketNumber).toBe('PCP-57918');
    // The 12:21 defect: the tool returned bare success, so nothing told the
    // agent to speak and it ended the call mid-breath.
    expect(filed.message, 'the tool must tell the agent what to say').toBeTruthy();
    expect(filed.message).toContain('PCP-57918');
  });

  it('carries the delivery instruction onto the ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      ...INTAKE_AS_ON_THE_CALL,
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '9095550199',
    });
    await call(agent, 'handle_patient_medical_records_request', { narrative: 'Records request.' });

    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    const blob = JSON.stringify(payload);
    expect(blob, 'a staffer cannot send records without knowing where').toMatch(/fax/i);
    expect(blob).toContain('9095550199');
  });
});

/**
 * CODEX ROUND 4 ON PR #273 — four findings, all real, all reproduced here.
 * The first two are holes in my own change; the third contradicted a claim I
 * made in the commit message.
 */
describe('the delivery gate cannot be walked around', () => {
  it('holds a PATIENT records request too, though the purpose never says records', async () => {
    // A patient or family member is stored as `patient_caller`, so the
    // director's records branch never fires — and the tool sets the records
    // purpose ITSELF and used to file on the spot. The gate has to live here.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_caller',
      callerName: 'A Patient',
      callerIsThePatient: true,
    });

    const r = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Patient requesting their own records.',
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/recordsDeliveryMethod/);
    expect(ticketing.createPcpTicket, 'nothing may file without a destination').not.toHaveBeenCalled();
  });

  it('lets a caller who will not answer still get their request filed', async () => {
    // The unbounded loop: nothing incremented MAX_BLOCKS for these fields, so
    // the director named the same one forever. 'unspecified' is a recordable
    // answer, which is what ends it.
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'unspecified' });

    expect(pcpDirector.next(callId).nextQuestion, 'a recorded refusal ends the question').toBeUndefined();

    const filed = await call(agent, 'handle_patient_medical_records_request', { narrative: 'Records.' });
    expect(filed.success).toBe(true);
    const blob = JSON.stringify((ticketing.createPcpTicket.mock.calls as any[])[0][0]);
    /**
     * "NOT CHOSEN", not "not captured" — and the distinction is the staffer's,
     * not ours. `ticketDeliveryNote` writes three different sentences because
     * three different things happen: nobody was asked, they were asked and
     * declined, or a route was named without a destination. A clerk reading
     * "not captured" cannot tell whether to ring the requester back or whether
     * they already refused. This assertion originally pinned the literal
     * "NOT captured", which was the wording for a case this test is not.
     */
    expect(blob, 'the ticket must say the requester declined to choose').toMatch(/NOT chosen/i);
    expect(blob, 'and that they were asked, so nobody re-asks blindly').toMatch(/did not specify/i);
  });

  it('never asks for a destination once the method is unspecified', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'unspecified' });
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('recordsDeliveryDestination');
  });
});

describe('a changed delivery method does not keep the old destination', () => {
  it('forgets the fax number when the caller switches to email', async () => {
    // "Deliver by EMAIL to <fax number>" — records sent somewhere the caller
    // never named. `update` merges, so the stale value survived.
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', {
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '9095550199',
    });
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'email' });

    expect(pcpDirector.get(callId).recordsDeliveryDestination).toBeUndefined();
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('recordsDeliveryDestination');
    expect(pcpDirector.next(callId).nextQuestion?.prompt).toMatch(/email/i);
  });

  it('keeps a replacement supplied in the same breath', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE_AS_ON_THE_CALL);
    await call(agent, 'record_pcp_intake', {
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '9095550199',
    });
    await call(agent, 'record_pcp_intake', {
      recordsDeliveryMethod: 'email',
      recordsDeliveryDestination: 'records@delapena.example',
    });
    expect(pcpDirector.get(callId).recordsDeliveryDestination).toBe('records@delapena.example');
  });
});
