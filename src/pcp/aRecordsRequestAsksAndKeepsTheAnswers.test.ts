/**
 * A PCP RECORDS REQUEST ASKS WHO, WHOSE, HOW AND WHERE — ONCE EACH — AND
 * KEEPS THE ANSWERS (v197).
 *
 * Operator, 2026-11-10, on PCP-82755: "what good does it do us if we create a
 * ticket that leads us to more work than had we taken the call ourselves …
 * we need to understand why these fields are not being populated correctly."
 *
 * MEASURED, PCP records tickets 2026-10-27..11-10 (171), read against their
 * transcripts and tool timelines:
 *   - 23 named no patient; on 18 of those nobody asked whose records they were.
 *   - 15 said "Delivery method NOT captured"; on all 15 the caller had
 *     answered "by fax, by email, or by mail?".
 *
 * Two causes, both in `handle_patient_medical_records_request`:
 *   1. Its patient check read `ticketReadiness` with the module default, which
 *      has been "never hold" since 2026-09-16 (FILING_MAY_BE_HELD = false), so
 *      on the one PCP path that ruling kept gated, whose records they were was
 *      never asked.
 *   2. It asked for the delivery method and its only argument was a narrative.
 *      The caller's "Fax." had nowhere to go: the model called the tool again
 *      with "fax" in the narrative until the strike budget ran out, and the
 *      ticket said both "fax" and "NOT captured".
 *
 * The corpus is indexed by the real call SIDs; the callers, offices and
 * numbers below are synthetic stand-ins in the same shapes. Driven through the
 * real agent's own tools, with the ticketing client mocked at the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-197' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-197' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { RECORDS_ASK_BATCH_MS } = await import('./recordsIntakeGate');

const RECORDS = 'handle_patient_medical_records_request';

/** PCP-82755's call: the model passed the narrative and nothing else, four times. */
const PCP_82755 = 'CAcb222de3b32c7449aa01c3188adc5b6d';

/** No patient on the ticket AND delivery not captured. */
const NO_PATIENT_AND_NO_DELIVERY = [
  'CAc945bbb9905f69c798ea98dfbc8961a2',
  'CA37e8d07cc6f3250217d5b0c5099456a3',
  'CAf3396737e0c6d88268a4744c88e7cb06',
  'CA8054050de428a220894c8a50d1401964',
  'CA51323904fb207f606fad9c82fbaa5a6c',
  'CAd360bee1c353e7e5216a8ce7cd1eb8fb',
  PCP_82755,
] as const;

/** The patient was named; the caller answered the method and it was lost. */
const DELIVERY_LOST_ONLY = [
  'CAc321b23e39a1e21299ece42912d03f65',
  'CAf5e87a3acf011da178407fb1cc0eb032',
  'CAcf4d9693b1219e5043a94bb097704e56',
  'CA310432d4a5420610d8a2df873204efde',
  'CAb494e42956a6b36213fe75fb500347b4',
  'CAdd7b79056a34fb45e1fdc188173ae062',
  'CA5df1d4e8dfc3084326b1059f68521b17',
  'CAd4d2a1a7b7faf873df6070c3d7dfd87b',
] as const;

/** The delivery method was on file; whose records they were was never asked. */
const NO_PATIENT_ONLY = [
  'CA89ec614e1237db7fb9d904e52f678b9f',
  'CA9748fb75f3673756317570a47374e50d',
  'CAbc743e4b58d1c5004f9f893514ff2ada',
  'CAcebee780c1ce776254df57b6df49a623',
  'CA3b3236262da13ad2561347634fae4d04',
  'CA4c2a73388be9ecff76cd95d092d2e332',
  'CA1344144d364991c5631970827b60c27f',
  'CA81d33c6bcbc63be921e56a5d66d60349',
  'CAd30c0400c23d6c66c19839d61aee6085',
  'CAabb6e37a5b1335692b0fb1f7bda2149f',
  'CA147d6ec4b712fe3ba5197a0c996af4e2',
  'CA3d8793550fcab54233a3d3f681a4e51e',
  'CA2a0cb13e186ac9b5f19ae5b6a61e30d6',
  'CA30db1912a469594170c1654fc431af06',
  'CAcb2e3e163a5fd43e8edbb5ee23835e08',
  'CA4a8065a38e4158e29aca0d3348b155e4',
] as const;

/** Synthetic stand-ins. */
const OFFICE = { callerName: 'Testa Caller', callerOrganization: 'Example Family Medicine' };
const PATIENT = { patientFirstName: 'Testpatient', patientLastName: 'Example' };
const FAX = { recordsDeliveryMethod: 'fax', recordsDeliveryDestination: '202-555-0199' } as const;
const NARRATIVE = "Caller is requesting a copy of a patient's medical records.";

const asked = (prompt: string) => ({ asks: /call about|patient's first and last name/i.test(prompt) ? 'patient' : prompt });

function build(callSid: string, callerPhone = '+12025550100') {
  // A SID can only be used once per module: the director keys on it.
  const callId = `${callSid}-${++n}`;
  return { callId, agent: createPcpAgent((async () => ({ ok: true as const })) as never, { callId, callSid, callerPhone } as never) };
}
let n = 0;

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** The caller takes longer to answer than the model's own batch window. */
const callerAnswers = () => vi.setSystemTime(new Date(Date.now() + RECORDS_ASK_BATCH_MS + 1_000));

function filedPayload(): Record<string, unknown> | undefined {
  const last = (calls: unknown[][]) => calls[calls.length - 1]?.[0];
  const pcp = last(ticketing.createPcpTicket.mock.calls as unknown as unknown[][]);
  const records = last(ticketing.createTicket.mock.calls as unknown as unknown[][]);
  return (records ?? pcp) as Record<string, unknown> | undefined;
}

/** Everything a staffer reads on the ticket, whichever door it went through. */
function ticketText(p: Record<string, unknown>): string {
  return [p.narrative, p.description, p.additionalDetails].filter(Boolean).map(String).join('\n');
}

function patientOn(p: Record<string, unknown>): string {
  return [p.patientFirstName, p.patientLastName].filter(Boolean).join(' ');
}

beforeEach(() => {
  ticketing.createTicket.mockClear();
  ticketing.createPcpTicket.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('who, whose, how, where: asked in order, and the answers land', () => {
  it.each(NO_PATIENT_AND_NO_DELIVERY)('%s', async (sid) => {
    const { agent } = build(sid);
    const order: string[] = [];

    let r = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r.success).toBe(false);
    order.push(r.say);
    callerAnswers();
    r = await call(agent, RECORDS, { narrative: NARRATIVE, ...OFFICE });
    expect(r.success).toBe(false);
    order.push(r.say);
    callerAnswers();
    r = await call(agent, RECORDS, { narrative: NARRATIVE, ...PATIENT });
    expect(r.success).toBe(false);
    order.push(r.say);
    callerAnswers();
    r = await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryMethod: 'fax' });
    expect(r.success).toBe(false);
    order.push(r.say);
    callerAnswers();
    r = await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryDestination: FAX.recordsDeliveryDestination });
    expect(r.success, JSON.stringify(r)).not.toBe(false);

    // Who is calling, whose records, how, where — the operator's interview.
    expect(order[0]).toMatch(/who am I speaking with/i);
    expect(order[1]).toMatch(/patient's first and last name/i);
    expect(order[2]).toMatch(/fax.*email.*mail/i);
    expect(order[3]).toMatch(/fax number/i);

    const p = filedPayload()!;
    expect(patientOn(p)).toBe('Testpatient Example');
    const text = ticketText(p);
    expect(text).not.toMatch(/Delivery method NOT captured/);
    expect(text).not.toMatch(/which patient the call is about/);
    expect(text).toMatch(/fax/i);
    expect(text).toContain(FAX.recordsDeliveryDestination);
  });
});

describe('the caller said "Fax." and it reached the ticket', () => {
  it.each(DELIVERY_LOST_ONLY)('%s', async (sid) => {
    const { agent } = build(sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...PATIENT });
    const r = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r.say).toMatch(/fax.*email.*mail/i);
    callerAnswers();
    const r2 = await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryMethod: 'fax' });
    expect(r2.say).toMatch(/fax number/i);
    callerAnswers();
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryDestination: FAX.recordsDeliveryDestination });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    const text = ticketText(filedPayload()!);
    expect(text).not.toMatch(/Delivery method NOT captured/);
    expect(text).toContain(FAX.recordsDeliveryDestination);
  });
});

describe('whose records they are is asked', () => {
  it.each(NO_PATIENT_ONLY)('%s', async (sid) => {
    const { agent } = build(sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...FAX });
    const r = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r.success).toBe(false);
    expect(asked(r.say).asks).toBe('patient');
    callerAnswers();
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE, ...PATIENT });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    expect(patientOn(filedPayload()!)).toBe('Testpatient Example');
  });
});

describe(`${PCP_82755}: a model that never fills the fields still files, once each was asked`, () => {
  it('asks each missing field once, then files with every gap written on it', async () => {
    const { agent } = build(PCP_82755);
    const says: string[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await call(agent, RECORDS, { narrative: 'Caller requested patient medical records. Delivery method: fax.' });
      if (r.success !== false) break;
      says.push(r.say);
      callerAnswers();
    }
    // callerName, patientName, recordsDeliveryMethod: the callback came from caller ID.
    expect(says).toHaveLength(3);
    expect(new Set(says).size, 'a question asked twice').toBe(3);
    const text = ticketText(filedPayload()!);
    expect(text).toMatch(/NOT CAPTURED ON THE CALL/);
    expect(text).toMatch(/Delivery method NOT captured/);
  });
});

describe('the model\'s own batch is not the caller\'s answer', () => {
  it('a second call inside the batch window gets the same question and spends nothing', async () => {
    const { agent } = build(NO_PATIENT_ONLY[0]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...FAX });
    const first = await call(agent, RECORDS, { narrative: NARRATIVE });
    const sibling = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(sibling.say).toBe(first.say);
    callerAnswers();
    // The ask was spent once, by the first call: the caller's answer is read now.
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE, ...PATIENT });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
  });
});

describe('the answers are stored the way record_pcp_intake stores them', () => {
  it('a patient asking for their own records is not asked whose records they are', async () => {
    const { agent } = build(NO_PATIENT_ONLY[1]);
    const r = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r.say).toMatch(/who am I speaking with/i);
    callerAnswers();
    const r2 = await call(agent, RECORDS, { narrative: NARRATIVE, callerName: 'Testpatient Example', callerIsThePatient: true });
    expect(r2.say).toMatch(/fax.*email.*mail/i);
  });

  it('a changed method drops the old destination', async () => {
    const { agent, callId } = build(DELIVERY_LOST_ONLY[0]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...PATIENT, ...FAX });
    await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryMethod: 'email' });
    expect(pcpDirector.get(callId).recordsDeliveryMethod).toBe('email');
    expect(pcpDirector.get(callId).recordsDeliveryDestination).toBeUndefined();
  });

  it('a stated callback number is no longer caller ID only', async () => {
    const { agent, callId } = build(DELIVERY_LOST_ONLY[1]);
    expect(pcpDirector.get(callId).callbackFromCallerIdOnly).toBe(true);
    await call(agent, RECORDS, { narrative: NARRATIVE, callbackNumber: '202-555-0123' });
    expect(pcpDirector.get(callId).callbackNumber).toBe('202-555-0123');
    expect(pcpDirector.get(callId).callbackFromCallerIdOnly).toBe(false);
  });
});

describe('an office is not the patient: the case never opens on the patient\'s clock for a caller who named where they call from', () => {
  // CA29957eba32773563e1d4919e9f83dc6a and CA5df1d4e8dfc3084326b1059f68521b17:
  // a doctor's office, filed to Medical Records as the patient's own request.
  for (const sid of ['CA29957eba32773563e1d4919e9f83dc6a', 'CA5df1d4e8dfc3084326b1059f68521b17']) {
    it(`${sid}: an office the records route recognises files off the clock`, async () => {
      const { agent } = build(sid);
      await call(agent, 'record_pcp_intake', {
        callerName: 'Testa Caller', callerOrganization: 'Example Medical Group', ...PATIENT, patientDob: '1950-01-02', ...FAX,
      });
      const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
      expect(filed.success, JSON.stringify(filed)).not.toBe(false);
      const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
      expect(p, 'the records library filed it').toBeTruthy();
      expect(p.departmentId).toBe(16);
      expect(p.requestorType).toBe('provider');
      expect(p.capClockApplies).toBe(false);
    });
  }

  it('an office the route cannot classify goes to PCP Support for a person, never onto the patient clock', async () => {
    const { agent } = build('CA29957eba32773563e1d4919e9f83dc6a');
    await call(agent, 'record_pcp_intake', {
      callerName: 'Testa Caller', callerOrganization: 'Example Wellness', ...PATIENT, patientDob: '1950-01-02', ...FAX,
    });
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });

  it('a patient asking for their own records still takes the patient route', async () => {
    const { agent } = build('CA9161cc5d90836e8e7104daee7d744a5f');
    await call(agent, 'record_pcp_intake', {
      callerName: 'Testpatient Example', callerIsThePatient: true, patientDob: '1950-01-02', ...FAX,
    });
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(p, 'the records library filed it').toBeTruthy();
    expect(p.requestorType).toBe('patient');
  });

  it('a patient who also names a workplace is still the patient', async () => {
    // The caller said they are the patient; where they work does not make
    // their own request a third party's.
    const { agent } = build('CA9161cc5d90836e8e7104daee7d744a5f');
    await call(agent, 'record_pcp_intake', {
      callerName: 'Testpatient Example', callerIsThePatient: true, callerOrganization: 'Example Medical Group',
      patientDob: '1950-01-02', ...FAX,
    });
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(p, 'the records library filed it').toBeTruthy();
    expect(p.requestorType).toBe('patient');
  });
});

describe('Box Codex review of 7c8df0ca (#445)', () => {
  /**
   * P1: a personal representative who also names a medical workplace was
   * routed as a professional, because the route read only callerIsThePatient
   * and callerOrganization. A relationship the caller stated is the stronger
   * evidence, and it puts the request on the patient's clock.
   */
  for (const relationship of ['personal representative', 'my mother', 'legal guardian']) {
    it(`a caller who says "${relationship}" and names a medical workplace takes the patient route`, async () => {
      const { agent } = build('CA29957eba32773563e1d4919e9f83dc6a');
      await call(agent, 'record_pcp_intake', {
        callerName: 'Testa Caller', callerOrganization: 'Example Medical Group', statedRelationship: relationship,
        ...PATIENT, patientDob: '1950-01-02', ...FAX,
      });
      const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
      expect(filed.success, JSON.stringify(filed)).not.toBe(false);
      const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
      expect(p, 'the records library filed it').toBeTruthy();
      expect(p.departmentId).toBe(16);
      expect(p.requestorType).toBe('personal_representative');
      expect(p.capClockApplies).not.toBe(false);
    });
  }

  it('an office that states a professional relationship still files off the clock', async () => {
    const { agent } = build('CA5df1d4e8dfc3084326b1059f68521b17');
    await call(agent, 'record_pcp_intake', {
      callerName: 'Testa Caller', callerOrganization: 'Example Medical Group', statedRelationship: 'referring provider',
      ...PATIENT, patientDob: '1950-01-02', ...FAX,
    });
    const filed = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    const p = (ticketing.createTicket.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(p, 'the records library filed it').toBeTruthy();
    expect(p.requestorType).toBe('provider');
    expect(p.capClockApplies).toBe(false);
  });

  /**
   * P2: the destination ask was keyed by field only, so after the fax-number
   * ask a switch to email cleared the destination and the spent ask let the
   * request file without ever asking for the email address.
   */
  it('a switch from fax to email after the fax-number ask is asked for the email address once', async () => {
    const { agent } = build(DELIVERY_LOST_ONLY[2]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...PATIENT, recordsDeliveryMethod: 'fax' });
    const r1 = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r1.say).toMatch(/fax/i);
    callerAnswers();
    const r2 = await call(agent, RECORDS, { narrative: NARRATIVE, recordsDeliveryMethod: 'email' });
    expect(r2.say, JSON.stringify(r2)).toMatch(/email/i);
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    callerAnswers();
    // The email ask is spent too: the next call files, with the gap written on it.
    const r3 = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r3.say ?? '').not.toMatch(/email address/i);
    const p = filedPayload();
    expect(p, 'it filed').toBeTruthy();
  });

  it('the same method is not asked for its destination twice', async () => {
    const { agent } = build(DELIVERY_LOST_ONLY[3]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, ...PATIENT, recordsDeliveryMethod: 'fax' });
    const r1 = await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(r1.say).toMatch(/fax/i);
    callerAnswers();
    await call(agent, RECORDS, { narrative: NARRATIVE });
    expect(filedPayload(), 'it filed after one fax-number ask').toBeTruthy();
  });
});
