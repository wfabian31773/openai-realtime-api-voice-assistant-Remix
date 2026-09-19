/**
 * A PROFESSIONAL CALLER'S RECORDS REQUEST REACHES MEDICAL RECORDS, OFF THE
 * CLOCK — operator ruling, 2026-09-14.
 *
 * v15 sent the PATIENT's records request to department 16. It left every
 * other requester where they were, because the department-16 route sits
 * inside `create_pcp_task`'s `patient_caller || callerIsThePatient` branch and
 * a professional caller never enters it.
 *
 * MEASURED BEFORE THIS, over live PCP records tickets (backfills excluded):
 * 41 sitting in department 18 — 16 from a provider organisation, 6 from a
 * medical assistant or referral coordinator, 6 from a health plan, and 2
 * mentioning "peer-to-peer" at all. That last figure is why the rule reads the
 * CALLER and not the phrase: scoping this to the `peer_to_peer` purpose slug
 * would have moved two tickets.
 *
 * THE CLOCK IS THE HAZARD, AND IT ONLY RUNS ONE WAY HERE. A patient's
 * right-of-access request is CAP-reportable on a statutory deadline; a
 * clinic's is not. Getting a PATIENT wrong would switch off a real deadline,
 * so the two routes are separated at the call site — `route: 'patient'` reads
 * only what it always read, and cannot pick up the professional signals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-58400' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-58500' })),
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
  const callId = `CAprofrec${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

/** Everything a professional intake gathers, minus whatever a case is testing. */
const CLINIC = {
  callerName: 'Dr Joseph Perez',
  callerRole: 'primary care provider',
  callerOrganization: 'De La Pena Family Medicine',
  callerFacilityType: 'pcp_office' as const,
  callPurpose: 'peer_to_peer' as const,
  patientFirstName: 'A',
  patientLastName: 'B',
  patientDob: '1973-03-17',
  callbackNumber: '9095550123',
};
const DELIVERY = { recordsDeliveryMethod: 'fax' as const, recordsDeliveryDestination: '9095550199' };
const RECORDS = { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' };

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-58400' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-58500' });
});

const filedToRecords = () => (ticketing.createTicket.mock.calls as any[])[0][0];

describe('a professional records request reaches Medical Records', () => {
  it('routes a clinic to department 16 as a provider, off the clock', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...DELIVERY });

    const filed = await call(agent, 'create_pcp_task', RECORDS);

    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
    expect(filed.routed_to).toBe('Medical Records');
    const payload = filedToRecords();
    expect(payload.departmentId).toBe(16);
    expect(payload.requestorType).toBe('provider');
    expect(payload.requestPathway).toBe('third_party_treatment');
    expect(payload.capClockApplies, 'a clinic does not start a patient right-of-access clock').toBe(false);
    expect(ticketing.createPcpTicket, 'and it does not also sit in PCP Support').not.toHaveBeenCalled();
  });

  /**
   * THE ORGANISATION IS DELIBERATELY UNNAMEABLE IN PROSE. A first version of
   * this test used "SCAN Health Plan" with the role "chart review" — both cue
   * words in the taxonomy's own health-plan list — so the prose classifier
   * answered and the facility enum was never consulted. Deleting the enum's
   * `health_plan` case left the test green, which is a test of the cue list
   * wearing the name of a test of the map.
   */
  it('routes a health plan on its own pathway, not the treatment one', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      ...CLINIC,
      callerOrganization: 'Regional Care Partners',
      callerRole: 'reviewer',
      callerFacilityType: 'health_plan',
      ...DELIVERY,
    });

    await call(agent, 'create_pcp_task', RECORDS);

    const payload = filedToRecords();
    expect(payload.requestorType).toBe('health_plan');
    expect(payload.requestPathway).toBe('third_party_plan');
    expect(payload.capClockApplies).toBe(false);
  });

  it('names the organisation as the requester, not "the patient themselves"', async () => {
    // The CAP record has to say who asked. Zero of 470 existing mr_cases rows
    // carry a requester, which is the hole this whole field exists to close.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...DELIVERY });
    await call(agent, 'create_pcp_task', RECORDS);

    const name = String(filedToRecords().requestorName);
    expect(name).toMatch(/De La Pena Family Medicine/);
    expect(name).not.toMatch(/the patient themselves/i);
  });

  it('asks where the records go before it routes, and carries the answer', async () => {
    // Off the clock the library does NOT gate `deliver_to`, so if PCP does not
    // ask, an mr_cases row opens with nowhere to send — the 2026-08-13 hard
    // gate's own failure, arriving through the side door.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', CLINIC);

    const asked = await call(agent, 'create_pcp_task', RECORDS);
    expect(asked.success).toBe(false);
    expect(asked.error).toMatch(/recordsDelivery/);
    expect(ticketing.createTicket, 'nothing files before we know where').not.toHaveBeenCalled();

    await call(agent, 'record_pcp_intake', DELIVERY);
    await call(agent, 'create_pcp_task', RECORDS);
    expect(JSON.stringify(filedToRecords())).toMatch(/9095550199/);
  });
});

describe('what the route deliberately does not touch', () => {
  /**
   * THE ORGANISATION HERE CARRIES A PROVIDER CUE ON PURPOSE. A first version
   * used "Allergan" with the role "medical science liaison", which classifies
   * as nothing at all — so the caller was unroutable for want of any match and
   * removing the exclusion entirely left the test green. It proved the absence
   * of a cue, not the presence of a rule. "Medical Group" in the name is what
   * the prose classifier would otherwise read as a provider, so the exclusion
   * is now the only thing keeping this request out of Medical Records.
   */
  it('leaves a pharmaceutical representative in PCP Support', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      ...CLINIC,
      callerOrganization: 'Allergan Medical Group',
      callerRole: 'medical science liaison',
      callerFacilityType: 'pharmaceutical_representative',
      callPurpose: 'pharmaceutical_representative',
      ...DELIVERY,
    });

    const filed = await call(agent, 'create_pcp_task', RECORDS);

    expect(ticketing.createTicket, 'never routed to Medical Records').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket, 'but the request is still taken').toHaveBeenCalled();
    expect(filed.success).toBe(true);
  });

  it('leaves a professional whose organisation we never established in PCP Support', async () => {
    // No facility type, no role, nothing classifiable. Falling back to the
    // patient default here would put a stranger's request on the patient's own
    // statutory clock and name them as the requester on a CAP record.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Sam',
      callPurpose: 'service_inquiry',
      patientFirstName: 'A',
      patientLastName: 'B',
      patientDob: '1973-03-17',
      callbackNumber: '9095550123',
      ...DELIVERY,
    });

    const filed = await call(agent, 'create_pcp_task', RECORDS);

    expect(ticketing.createTicket, 'we do not guess who is asking').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket, 'the request is still taken, as it is today').toHaveBeenCalled();
    expect(filed.success).toBe(true);
  });

  /**
   * CODEX P1 ON #297, and it is the finding that mattered most.
   *
   * `classifyRecords` answers WHICH records reason applies, and carries bare
   * organisation words to do it — `TO_ANOTHER_PROVIDER_CUES` holds "primary
   * care", "referring provider" and "another office". Keyed on as an INTENT
   * test, it reads this narrative — a real `outside_referral_status` call —
   * as a records request, asks a clinic where to send records they never
   * mentioned, and files their referral question to Medical Records.
   *
   * Misrouting ordinary professional traffic into a records queue is a larger
   * loss than the one this route exists to fix. My own negative control used a
   * narrative with no records vocabulary at all, so it could not see this.
   */
  it('leaves an outside-referral call alone, though it names a primary care office', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, callPurpose: 'outside_referral_status' });

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'The primary care office is checking the status of an outside referral.',
    });

    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
    expect(ticketing.createTicket, 'a referral question is not a records request').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalled();
    // And nobody was asked where to send records nobody asked for.
    expect(String(filed.error ?? '')).not.toMatch(/recordsDelivery/);
  });

  it('files an attorney on the legal pathway, not the generic one', async () => {
    // CODEX P2. The facility enum has no attorney value, so a law firm picks
    // `other_healthcare_organization` — and letting that generic bucket win
    // outright filed them `third_party_other`, never reaching the legal cues.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      ...CLINIC,
      callerName: 'K. Ruiz',
      callerRole: 'paralegal',
      callerOrganization: 'Ruiz Law Firm',
      callerFacilityType: 'other_healthcare_organization',
      ...DELIVERY,
    });

    await call(agent, 'create_pcp_task', RECORDS);

    const payload = filedToRecords();
    expect(payload.requestorType).toBe('legal');
    expect(payload.requestPathway).toBe('third_party_legal');
    expect(payload.capClockApplies).toBe(false);
  });

  it('leaves a professional call that is NOT about records alone', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', CLINIC);

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Calling to discuss a shared patient with the doctor.',
    });

    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalled();
    expect(filed.success).toBe(true);
  });

  it('still puts the PATIENT on the clock, whatever else the intake carries', async () => {
    /**
     * THE DANGEROUS DIRECTION, and be precise about which guard this proves.
     *
     * There are two defences and this asserts the OUTCOME, not the mechanism.
     * The primary is the route split: `route: 'patient'` never reads
     * `callerFacilityType`. The backstop is `resolveRequesterType`, which
     * refuses to let a stated off-clock value beat an on-clock reading of the
     * prose — and on this branch the requester string is always "the patient
     * themselves", which always classifies as `patient`.
     *
     * Mutation-checked: forcing the patient route through the professional
     * read leaves this test GREEN, because the backstop catches it. So the
     * route split is redundant here rather than load-bearing, and this test
     * proves the clock stays on — which is the property that matters — not
     * that the split is what kept it on.
     */
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_caller',
      callerIsThePatient: true,
      callerName: 'A B',
      callerFacilityType: 'pcp_office',
      patientFirstName: 'A',
      patientLastName: 'B',
      patientDob: '1973-03-17',
      callbackNumber: '9095550123',
      ...DELIVERY,
    });

    await call(agent, 'create_pcp_task', { narrative: 'I need a copy of my own records, faxed.' });

    const payload = filedToRecords();
    expect(payload.requestorType).toBe('patient');
    expect(payload.capClockApplies, 'the patient clock cannot be switched off by a facility type').toBe(true);
  });
});
