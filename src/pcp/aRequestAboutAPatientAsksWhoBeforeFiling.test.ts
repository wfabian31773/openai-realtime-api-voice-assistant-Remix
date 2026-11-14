/**
 * v235 — A PCP REQUEST ABOUT A PATIENT ASKS WHO, THEN THE DATE OF BIRTH,
 * BEFORE IT FILES.
 *
 * Operator, 2026-11-14, asked whether the date of birth should be asked after
 * the ticket is filed or before: "Ask before filing." His 2026-09-16 ruling
 * already names "who is this request in regards to" among the five PCP fields.
 *
 * THE CORPUS is the daily review of 2026-11-12 and 2026-11-13 (the Daybook's
 * close-to-close days): 101 PCP-line tickets with no date of birth the caller
 * was never asked for, and 30 with no patient name nobody asked for, 103
 * tickets in all. Read call by call, five shapes:
 *
 *   A  36  a patient calling for themselves: the patient intake asked a name
 *          and a number, never a date of birth, and the create-ticket payload
 *          had no date-of-birth columns at all.
 *   B  25  a professional on a purpose that needs a patient (appointment
 *          checks, referrals, records): the name was asked, the date of birth
 *          never was (the records tool's own gate never asked it either).
 *   C   4  a purpose that may transfer (grievance, scheduling, peer-to-peer):
 *          1 was filed with nothing asked; 3 were headed for a person and are
 *          correctly not held on the questions.
 *   D  36  a professional on a purpose whose policy row asks no patient:
 *          25 were about one patient (a pharmacy's prescription, an
 *          authorization, a pre-op question, a glasses order) and 11 were not
 *          (a provider-directory check, a plan, a wheelchair question, callers
 *          who only asked for a named person).
 *   -   2  a patient caller whose gap was a different patient's name; not this.
 *
 * Fixtures are synthetic. The SIDs and ticket numbers are the real calls;
 * nothing a caller said is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Not the lunch hour: transfers are off 12:00-12:59 Pacific.
const NOT_LUNCH = new Date('2026-11-13T17:00:00Z');
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOT_LUNCH);
});
afterAll(() => {
  vi.useRealTimers();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-90000' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-90100' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector, PcpDirector, requestConcernsAPatient, askBudgetFor } = await import('./director');
const { RECORDS_ASK_BATCH_MS } = await import('./recordsIntakeGate');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function lastPayload(fn: { mock: { calls: unknown[][] } }): any {
  const calls = fn.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : undefined;
}

let n = 0;
function agentFor(sid: string) {
  // A SID is used once per test: the director keys on the call id.
  const callId = `${sid}-${++n}`;
  return {
    callId,
    agent: createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
      callId,
      callSid: sid,
      callerPhone: '+15005550006',
    } as never),
  };
}

/** A synthetic office and patient. */
const OFFICE = { callerName: 'Test Assistant', callerOrganization: 'Example Family Practice' };
const PATIENT = { patientFirstName: 'Test', patientLastName: 'Patient' };
const DOB = '1950-02-03';

/** A: the patient on the phone, by ticket, call and the purpose the call recorded. */
const A_PATIENT_CALLERS: Array<[string, string, string]> = [
  ['VA-84204', 'CAc1f77037e2cee2c444df02c689b21069', 'patient_caller'],
  ['VA-84228', 'CA3582e5f4f179ced38d241500581a06f5', 'reschedule_appointment'],
  ['VA-84301', 'CA03b85212c9872a8dc1d614f724f2e85a', 'patient_caller'],
  ['VA-84304', 'CA336e39d47ecf102cbca4ab67b6acf61f', 'grievance_follow_up'],
  ['VA-84379', 'CAd0777bfc1120451542fc27be04b147ad', 'patient_caller'],
  ['VA-84422', 'CA034e269dd9b4e138f1bfe3a94d760d9a', 'schedule_appointment'],
  ['VA-84426', 'CA75efa8524e2cb88906f9fb7d9d414af7', 'patient_caller'],
  ['VA-84443', 'CA587c5b9d03d766a21716fe4ef3dfec44', 'check_patient_kept_appointment'],
  ['VA-84448', 'CA045800e65dbe2f11ce4fdf1dbdc32597', 'cancel_appointment'],
  ['VA-84449', 'CAd91c33486b01ee902c006dcaab715e37', 'schedule_appointment'],
  ['VA-84453', 'CAc4325fff296ee5f191ac20b488ef54d4', 'check_patient_scheduled'],
  ['VA-84533', 'CA6619209d5f2b6ba14c55e0b46d1121b8', 'schedule_appointment'],
  ['VA-84549', 'CA36df1176de96b439eeaded8b793c5166', 'patient_caller'],
  ['VA-84560', 'CA292dc77313077fd129bc1a6611202891', 'patient_caller'],
  ['VA-84579', 'CA4302a6cc9dd16bcb6fd9cf77daef8629', 'patient_caller'],
  ['VA-84624', 'CAe86ebcc6c617e4890c745bdb22278ef0', 'patient_caller'],
  ['VA-84634', 'CA7d6acfd9b77d1f6046aac95bb1fad9cd', 'check_patient_scheduled'],
  ['VA-84876', 'CA26807a2e186d231e78fdcf0f9c8bab78', 'check_patient_scheduled'],
  ['VA-84907', 'CA4b5cf49e1147c2d5dc34580200e9ca07', 'schedule_appointment'],
  ['VA-84924', 'CA72da32bbf56ea431a463fd0e35b5df91', 'schedule_appointment'],
  ['VA-84960', 'CA6ff9993b621c1d732171eba505a62064', 'patient_caller'],
  ['VA-85003', 'CA731b1c9bce1f9badc0ac343132fba84c', 'patient_caller'],
  ['VA-85017', 'CA9296a5d4709740b8315e81d7f4312719', 'patient_caller'],
  ['VA-85105', 'CA28f7d18151edd6528b9229864ce95826', 'schedule_appointment'],
  ['VA-85134', 'CA456dcdc43ce958c4e7cf72043f4c5191', 'patient_caller'],
  ['VA-85137', 'CA30f4d2278002ab7b9dfe3a604fcc1b3f', 'check_patient_scheduled'],
  ['VA-85142', 'CA12e3c053a5e2f118d58e55fbbee65f5d', 'schedule_appointment'],
  ['VA-85143', 'CAe6b424e5ea7883ccf4f77d9c746c78ba', 'patient_caller'],
  ['VA-85221', 'CA760a9e0bfb1d7330ea59e6697f8ef54a', 'check_patient_scheduled'],
  ['VA-85247', 'CA3b8d7ab88923ae920c9e99bb4fd15f4d', 'patient_caller'],
  ['VA-85266', 'CA64b87ecf4261ca6d6ab3f02acdb3e77c', 'patient_caller'],
  ['VA-85269', 'CAfea4a7d3e317d427761b02ea1f5c8519', 'patient_caller'],
  ['VA-85285', 'CA6ca4843e21ea9a3eab679ababa0649f4', 'patient_caller'],
  ['VA-85295', 'CAc2dafdccf50fd6cfdbd256f611a1de71', 'check_patient_scheduled'],
  ['VA-85352', 'CA2f84494fa10a236afefbdf045069e6d2', 'schedule_appointment'],
];
/** A, the one the purpose cannot reach: a patient's own request read as a service inquiry. */
const A_SERVICE_INQUIRY = ['VA-85095', 'CA7a58b52d5ba4c9297dcde6b8ee454a73'] as const;

/** B: a professional on a purpose that needs a patient, filed through record_pcp_intake. */
const B_PROFESSIONAL: Array<[string, string, string]> = [
  ['PCP-84347', 'CA6e0c1a39520589e51dd854ed8c16e23c', 'check_patient_scheduled'],
  ['PCP-84636', 'CAf3beefe7d32bc6774c89fb7d09128e96', 'check_patient_scheduled'],
  ['PCP-85057', 'CA894ba7044d17db8828f394729b71c33e', 'check_patient_scheduled'],
  ['PCP-85308', 'CA06644cc5a2b56d08e42b196e345325fe', 'check_patient_scheduled'],
  ['PCP-84648', 'CA91b1eafdc7c31a3396eb1715dc870257', 'check_patient_kept_appointment'],
  ['PCP-84686', 'CAa577c237f1c266e72af1d06cd7fe822c', 'check_patient_kept_appointment'],
  ['PCP-84711', 'CA5d4ceb3f65152c819082e301722ab386', 'check_patient_kept_appointment'],
  ['PCP-85297', 'CAa63b522f79dc468fec409666a3c83ac4', 'check_patient_kept_appointment'],
  ['PCP-84241', 'CA3be9ac3b509f861ecedae5ebc6d1cb33', 'outside_referral_status'],
  ['PCP-84629', 'CA3ab5748b2befb8359858623a3fdd5c35', 'outside_referral_status'],
  ['PCP-84983', 'CAb004e12bdae37238e4ac7f87a7b46b6f', 'outside_referral_status'],
  ['PCP-85315', 'CA1f979ffbe04b5d6a2a8c8782d5dad7cb', 'outside_referral_status'],
  ['PCP-84661', 'CAba64e40e504a3da68ac6689ff16fb3e2', 'notify_referral_approval'],
  ['PCP-85357', 'CAf2cfea5dea3fe8a096ab64f6ef110d5c', 'notify_referral_approval'],
  ['PCP-84593', 'CAd1366c9d9deff5596d45c9ef7275c38f', 'patient_medical_records_request'],
  ['PCP-85028', 'CAb20ae5d559b6793fd6d0a58f96039d97', 'patient_medical_records_request'],
  ['PCP-85078', 'CAf001b147d499b90fd420fd22b8769f25', 'patient_medical_records_request'],
  ['PCP-85186', 'CA568e9becc9184b9e0f87b8f5c193fc5a', 'patient_medical_records_request'],
  ['PCP-85224', 'CAb3bd4590f18b1e24706e72224c1d0f44', 'patient_medical_records_request'],
  ['PCP-85321', 'CA729992ff99934684759dc8359cc542d5', 'patient_medical_records_request'],
];
/** B, through handle_patient_medical_records_request and its own gate. */
const B_RECORDS_TOOL: Array<[string, string]> = [
  ['PCP-84408', 'CA41deaeb2ad38802b8b1020653692f739'],
  ['PCP-84510', 'CAd367ff97536f4d3e6bb064686c538f19'],
  ['PCP-84726', 'CA4e816ad983805aee4ad6b24a571df223'],
  ['PCP-84736', 'CA18494ee35abc0b9aa5127264d6f7e355'],
  ['PCP-84763', 'CA8c112f77a9a85db79a0834960d04ae61'],
];

/** D: about one patient, on a purpose that asks no patient. Asked when the model says so. */
const D_ABOUT_A_PATIENT: Array<[string, string, string]> = [
  ['PCP-84403', 'CA092dfc617a2d57d9574c1f2cdecb92f3', 'service_inquiry'],
  ['PCP-84226', 'CA16317eec0ccaf921caed08c689b056ca', 'service_inquiry'],
  ['PCP-84325', 'CA48ffa75ecb9501fee3fc9fee8320bcad', 'service_inquiry'],
  ['PCP-84508', 'CAfa1400ea15d629ff852193aeda4f38d9', 'service_inquiry'],
  ['PCP-84978', 'CA0aa872262552cb9c4b5538af8620d152', 'service_inquiry'],
  ['PCP-84712', 'CA3941af3c683ea9fc2a0e88498ad91cb4', 'service_inquiry'],
  ['PCP-84860', 'CA3d2d52bba01326c6891b0db28fa92b08', 'service_inquiry'],
  ['PCP-84998', 'CA3fe1bdc90d106941b0cb95a90b096c05', 'service_inquiry'],
  ['PCP-84641', 'CA62b336c4a180dbdc4a32dcec8fb30098', 'service_inquiry'],
  ['PCP-85109', 'CA761127b26eb0ed0c53764741b1cf3a88', 'service_inquiry'],
  ['PCP-84537', 'CA9b4a6f5baaf7ebe209ab33745bb8cee8', 'service_inquiry'],
  ['PCP-84742', 'CAa39d9f3d9e9e666534d02cd50c5632b9', 'service_inquiry'],
  ['PCP-84722', 'CAab44188a25dfb97adf6e917834cd57a9', 'service_inquiry'],
  ['PCP-85090', 'CAd6c5e2b391b23b582dfb2685abcb9578', 'service_inquiry'],
  ['PCP-85072', 'CAe2756b41590a34af68af9a46762e3379', 'service_inquiry'],
  ['PCP-84906', 'CAe39e4df61d97f399c28df27b57b47680', 'service_inquiry'],
  ['PCP-85115', 'CA01a2af532df941a4a1fe390afc680a12', 'service_inquiry'],
  ['PCP-85117', 'CA2ff23b5d472ea12fc9cb15a83485828f', 'service_inquiry'],
  // Filed by the teardown floor as unclassified_call, which the model cannot
  // record (v136); the model's nearest purpose stands in.
  ['PCP-84919', 'CA001d103f3b3d8364fb2513b5cef8abbe', 'service_inquiry'],
  ['PCP-84759', 'CAe9f551a31f47c52a22d65d0c95e390be', 'provider_information'],
  ['PCP-84405', 'CAff0267a223419ff36a18f886b0c19462', 'provider_information'],
  ['PCP-84305', 'CAd0422e4beeb7aba5b8a2283a23315fe8', 'pharmaceutical_representative'],
  ['PCP-84535', 'CA22cd94852862244f7ed68acc2f6adcf5', 'pharmaceutical_representative'],
  ['PCP-84536', 'CA854db92307a2dd02d5b7f05309dc8eb0', 'pharmaceutical_representative'],
  ['PCP-84590', 'CA68f03c3e13ca7be8bac3a6bed59e8cce', 'pharmaceutical_representative'],
];
/** D: about the practice, or nothing the call made clear. Correctly asked no patient. */
const D_ABOUT_THE_PRACTICE: Array<[string, string, string]> = [
  ['PCP-84285', 'CA685e34ff175f27ea147b04cceceec5d4', 'service_inquiry'],
  ['PCP-84259', 'CA95726e7a6b4a77ecfdd24ce1f225f6dd', 'service_inquiry'],
  ['PCP-85025', 'CAf982806b240ff5d677696b0ea44d7910', 'service_inquiry'],
  ['PCP-85257', 'CA9bf5a97afdfe07a28d161e7669e26531', 'service_inquiry'],
  // unclassified_call on the ticket (the floor's); see PCP-84919.
  ['PCP-84741', 'CA6c211412236664b31de6bd443c0e932b', 'service_inquiry'],
  ['PCP-84278', 'CA3b2d710938f62f2a57fa3ccd61ec84d2', 'provider_information'],
  ['PCP-84527', 'CAe6bf63067a46929d1018d17e59eca510', 'provider_information'],
  ['PCP-84673', 'CAdca3eb7aecae389188ca34586e3f3345', 'provider_information'],
  ['PCP-85044', 'CA21a74745cd6fdac6ebfdd022e0835b5d', 'plan_participation'],
  ['PCP-85170', 'CAff9b99b9c5fc5794a286cd999f7b48f2', 'plan_participation'],
  ['PCP-85194', 'CAfde0243f9ccbbd5f68c4ea33af8f9845', 'disability_accommodation'],
];

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90000' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90100' });
});

describe('A: a patient calling for themselves is asked their own date of birth, and it reaches the ticket', () => {
  it.each(A_PATIENT_CALLERS)('%s (%s, %s)', async (_ticket, sid, purpose) => {
    const { agent, callId } = agentFor(sid);
    const afterName = await call(agent, 'record_pcp_intake', {
      callPurpose: purpose, callerIsThePatient: true, callerName: 'Test Patient',
    });
    expect(afterName.nextQuestion?.field).toBe('patientDob');
    expect(afterName.nextQuestion?.prompt).toMatch(/^And may I please have your date of birth, starting with the month, then the day, then the year\?$/);
    const done = await call(agent, 'record_pcp_intake', { patientDob: DOB });
    expect(done.nextQuestion).toBeUndefined();
    await call(agent, 'create_pcp_task', { narrative: 'Patient request.', callerStatedARequest: true });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload).toMatchObject({ patientBirthYear: '1950', patientBirthMonth: '02', patientBirthDay: '03' });
    pcpDirector.clear(callId);
  });

  it(`${A_SERVICE_INQUIRY[0]}: a patient's own request read as a service inquiry is asked when the model says it is about them`, async () => {
    const { callId } = agentFor(A_SERVICE_INQUIRY[1]);
    pcpDirector.update(callId, { callPurpose: 'service_inquiry', callerIsThePatient: true, callerName: 'Test Patient' });
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('patientDob');
    pcpDirector.update(callId, { requestIsAboutAPatient: true });
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientDob');
    pcpDirector.clear(callId);
  });

  it('a date of birth already on record is not asked again (RULE ZERO step 5)', () => {
    const { callId } = agentFor(A_PATIENT_CALLERS[0][1]);
    pcpDirector.update(callId, { callPurpose: 'patient_caller', callerName: 'Test Patient', patientDob: DOB });
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('patientDob');
    pcpDirector.clear(callId);
  });
});

describe('B: a professional is asked the patient\'s date of birth after the name, before filing', () => {
  it.each(B_PROFESSIONAL)('%s (%s, %s)', async (_ticket, sid, purpose) => {
    const { agent, callId } = agentFor(sid);
    const first = await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: purpose });
    expect(first.nextQuestion?.field).toBe('patientFirstName');
    const second = await call(agent, 'record_pcp_intake', PATIENT);
    expect(second.nextQuestion?.field).toBe('patientDob');
    expect(second.nextQuestion?.prompt).toMatch(/the patient's date of birth, starting with the month, then the day, then the year\?$/);
    pcpDirector.clear(callId);
  });

  it('PCP-84241: the date of birth reaches the PCP ticket', async () => {
    const { agent, callId } = agentFor(B_PROFESSIONAL[8][1]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'outside_referral_status' });
    await call(agent, 'record_pcp_intake', PATIENT);
    const done = await call(agent, 'record_pcp_intake', { patientDob: DOB });
    expect(done.nextQuestion, 'the title and the email still wait until the ticket exists').toBeUndefined();
    await call(agent, 'create_pcp_task', { narrative: 'Referral status.', callerStatedARequest: true });
    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(payload.patientDob).toBe(DOB);
    expect(payload.narrative).not.toContain('patient date of birth');
    pcpDirector.clear(callId);
  });

  it('PCP-84347: asked once; a date that does not come files with the gap written on it', async () => {
    const { agent, callId } = agentFor(B_PROFESSIONAL[0][1]);
    expect(askBudgetFor('patientDob')).toBe(1);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'check_patient_scheduled' });
    const asked = await call(agent, 'record_pcp_intake', PATIENT);
    expect(asked.nextQuestion?.field).toBe('patientDob');
    // The caller does not have it: the next turn records nothing new.
    const again = await call(agent, 'record_pcp_intake', { callerName: OFFICE.callerName });
    expect(again.nextQuestion?.field, 'the date of birth is asked once').not.toBe('patientDob');
    expect(again.askBudgetSpent).toContain('patientDob');
    await call(agent, 'create_pcp_task', { narrative: 'Checking an appointment.', callerStatedARequest: true });
    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(payload.narrative).toContain('patient date of birth');
    pcpDirector.clear(callId);
  });
});

describe('B: the records tool asks whose records, then their date of birth', () => {
  const callerAnswers = () => vi.setSystemTime(new Date(Date.now() + RECORDS_ASK_BATCH_MS + 1_000));
  afterAll(() => vi.setSystemTime(NOT_LUNCH));

  it.each(B_RECORDS_TOOL)('%s (%s)', async (_ticket, sid) => {
    const { agent, callId } = agentFor(sid);
    const tool = 'handle_patient_medical_records_request';
    const narrative = "Caller is requesting a copy of a patient's medical records.";
    let r = await call(agent, tool, { narrative, ...OFFICE });
    expect(r.say).toMatch(/patient's first and last name/i);
    callerAnswers();
    r = await call(agent, tool, { narrative, ...PATIENT });
    expect(r.success).toBe(false);
    expect(r.say).toMatch(/the patient's date of birth, starting with the month/i);
    callerAnswers();
    r = await call(agent, tool, { narrative, patientDob: DOB });
    expect(r.say).toMatch(/fax.*email.*mail/i);
    expect(pcpDirector.get(callId).patientDob).toBe(DOB);
    callerAnswers();
    // The method is not given: the request files, with the date of birth on it.
    await call(agent, tool, { narrative });
    const library = lastPayload(ticketing.createTicket);
    const pcp = lastPayload(ticketing.createPcpTicket);
    const filed = library ?? pcp;
    expect(filed, 'it filed').toBeTruthy();
    expect(JSON.stringify(filed)).not.toContain("NOT CAPTURED ON THE CALL: the patient's date of birth");
    pcpDirector.clear(callId);
  });

  it('a records request whose date of birth does not come says so on the ticket', async () => {
    const { agent, callId } = agentFor(B_RECORDS_TOOL[0][1]);
    const tool = 'handle_patient_medical_records_request';
    const narrative = "Caller is requesting a copy of a patient's medical records.";
    await call(agent, tool, { narrative, ...OFFICE });
    callerAnswers();
    await call(agent, tool, { narrative, ...PATIENT });
    callerAnswers();
    await call(agent, tool, { narrative, recordsDeliveryMethod: 'fax' });
    callerAnswers();
    await call(agent, tool, { narrative, recordsDeliveryDestination: '202-555-0199' });
    const filed = lastPayload(ticketing.createTicket) ?? lastPayload(ticketing.createPcpTicket);
    expect(JSON.stringify(filed)).toContain("NOT CAPTURED ON THE CALL: the patient's date of birth");
    pcpDirector.clear(callId);
  });
});

describe('one date-of-birth ask per call, whichever tool makes it (Codex P2 on #479)', () => {
  const callerAnswers = () => vi.setSystemTime(new Date(Date.now() + RECORDS_ASK_BATCH_MS + 1_000));
  afterAll(() => vi.setSystemTime(NOT_LUNCH));
  const tool = 'handle_patient_medical_records_request';
  const narrative = "Caller is requesting a copy of a patient's medical records.";

  it('PCP-84726: the intake spent the ask, so the records tool does not ask again and writes the gap', async () => {
    const { agent, callId } = agentFor(B_RECORDS_TOOL[2][1]);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'patient_medical_records_request' });
    const asked = await call(agent, 'record_pcp_intake', PATIENT);
    expect(asked.nextQuestion?.field).toBe('patientDob');
    callerAnswers();
    // The caller does not have it. The records tool goes straight to how to send them.
    let r = await call(agent, tool, { narrative });
    expect(r.say).not.toMatch(/date of birth/i);
    expect(r.say).toMatch(/fax.*email.*mail/i);
    callerAnswers();
    r = await call(agent, tool, { narrative, recordsDeliveryMethod: 'fax' });
    callerAnswers();
    await call(agent, tool, { narrative, recordsDeliveryDestination: '202-555-0199' });
    const filed = lastPayload(ticketing.createTicket) ?? lastPayload(ticketing.createPcpTicket);
    expect(filed, 'it filed').toBeTruthy();
    expect(JSON.stringify(filed)).toContain("NOT CAPTURED ON THE CALL: the patient's date of birth");
    pcpDirector.clear(callId);
  });

  it('PCP-84736: the records tool spent the ask, so the intake does not ask again', async () => {
    const { agent, callId } = agentFor(B_RECORDS_TOOL[3][1]);
    await call(agent, tool, { narrative, ...OFFICE });
    callerAnswers();
    const r = await call(agent, tool, { narrative, ...PATIENT });
    expect(r.say).toMatch(/date of birth/i);
    callerAnswers();
    const intake = await call(agent, 'record_pcp_intake', { callPurpose: 'patient_medical_records_request' });
    expect(intake.nextQuestion?.field).not.toBe('patientDob');
    pcpDirector.clear(callId);
  });

  it('PCP-84763: a sibling call inside the batch window gets the same date-of-birth question and files nothing (Codex P2 on #479, round 2)', async () => {
    const { agent, callId } = agentFor(B_RECORDS_TOOL[4][1]);
    ticketing.createTicket.mockClear();
    ticketing.createPcpTicket.mockClear();
    await call(agent, tool, { narrative, ...OFFICE });
    callerAnswers();
    const first = await call(agent, tool, { narrative, ...PATIENT });
    expect(first.say).toMatch(/date of birth/i);
    // The model's own batch, no caller turn between: everything else complete.
    const sibling = await call(agent, tool, {
      narrative,
      recordsDeliveryMethod: 'fax',
      recordsDeliveryDestination: '202-555-0199',
    });
    expect(sibling.say).toBe(first.say);
    expect(pcpDirector.get(callId).askCounts?.patientDob, 'the sibling spends nothing').toBe(askBudgetFor('patientDob'));
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    pcpDirector.clear(callId);
  });

  it('a sibling inside the batch window does not move on to the delivery question or spend it', async () => {
    const { agent, callId } = agentFor(B_RECORDS_TOOL[4][1]);
    await call(agent, tool, { narrative, ...OFFICE });
    callerAnswers();
    const first = await call(agent, tool, { narrative, ...PATIENT });
    expect(first.say).toMatch(/date of birth/i);
    const sibling = await call(agent, tool, { narrative });
    expect(sibling.say).toBe(first.say);
    expect(sibling.say).not.toMatch(/fax.*email.*mail/i);
    // The caller cannot give it. The delivery question is asked now, once, not spent by the sibling.
    callerAnswers();
    const next = await call(agent, tool, { narrative });
    expect(next.say).toMatch(/fax.*email.*mail/i);
    pcpDirector.clear(callId);
  });
});

describe('C: a purpose that may transfer asks only when the caller is not headed for a person', () => {
  it('PCP-85264 (CA81089d2f2de68f76f33d907a3414fc56): a grievance filed as a task asks who, then the date of birth', () => {
    const { callId } = agentFor('CA81089d2f2de68f76f33d907a3414fc56');
    pcpDirector.update(callId, { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'grievance_follow_up' });
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientFirstName');
    pcpDirector.update(callId, PATIENT);
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientDob');
    pcpDirector.clear(callId);
  });

  it('PCP-84428 (CA172874216f6cd63525b97254dd765cda): a grievance caller who asked for a person is not held', () => {
    const { callId } = agentFor('CA172874216f6cd63525b97254dd765cda');
    pcpDirector.update(callId, { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'grievance_follow_up', callerRequestedHuman: true });
    const next = pcpDirector.next(callId);
    expect(next.handoffEligible).toBe(true);
    expect(next.nextQuestion).toBeUndefined();
    pcpDirector.clear(callId);
  });

  it('PCP-84377 (CA8ad2147de0e38fee74333994ed77c978): a scheduling caller who asked for a person is not held on the date of birth', () => {
    const { callId } = agentFor('CA8ad2147de0e38fee74333994ed77c978');
    pcpDirector.update(callId, { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'schedule_appointment', callerRequestedHuman: true });
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('patientDob');
    expect(pcpDirector.next(callId).handoffEligible).toBe(true);
    pcpDirector.clear(callId);
  });

  it('PCP-85318 (CAc968938fb72a206efabc504111518031): a peer-to-peer still transfers on a complete professional intake', () => {
    const { callId } = agentFor('CAc968938fb72a206efabc504111518031');
    pcpDirector.update(callId, { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'peer_to_peer' });
    const next = pcpDirector.next(callId);
    expect(next.nextQuestion?.field).not.toBe('patientDob');
    expect(next.intakeMissing).not.toContain('patientDob');
    expect(next.handoffEligible, 'a date of birth the caller lacks would hold the dial for good').toBe(true);
    pcpDirector.clear(callId);
  });

  it('a default-transfer purpose that cannot transfer (lunch) asks who and the date of birth', () => {
    const d = new PcpDirector({ lunchClosure: () => true });
    d.update('CAv235lunch', { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'peer_to_peer' });
    expect(d.next('CAv235lunch').nextQuestion?.field).toBe('patientFirstName');
  });
});

describe('D: a purpose that asks no patient asks when the model says the request is about one', () => {
  it.each(D_ABOUT_A_PATIENT)('%s (%s, %s)', async (_ticket, sid, purpose) => {
    const { agent, callId } = agentFor(sid);
    const first = await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: purpose, requestIsAboutAPatient: true });
    expect(first.nextQuestion?.field).toBe('patientFirstName');
    const second = await call(agent, 'record_pcp_intake', PATIENT);
    expect(second.nextQuestion?.field).toBe('patientDob');
    pcpDirector.clear(callId);
  });

  it.each(D_ABOUT_THE_PRACTICE)('%s (%s, %s) is asked about no patient', async (_ticket, sid, purpose) => {
    const { agent, callId } = agentFor(sid);
    const first = await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: purpose, requestIsAboutAPatient: false });
    expect(first.nextQuestion?.field).not.toBe('patientFirstName');
    expect(first.nextQuestion?.field).not.toBe('patientDob');
    expect(first.intakeMissing ?? []).not.toContain('patientDob');
    pcpDirector.clear(callId);
  });

  it('a patient named on a service inquiry is asked the rest, flag or not', () => {
    const { callId } = agentFor(D_ABOUT_A_PATIENT[0][1]);
    pcpDirector.update(callId, { ...OFFICE, callbackNumber: '5005550006', callPurpose: 'service_inquiry', patientFirstName: 'Test' });
    expect(requestConcernsAPatient(pcpDirector.get(callId))).toBe(true);
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientLastName');
    pcpDirector.clear(callId);
  });

  it('the model is offered the flag on the wire', async () => {
    const { agent } = agentFor('CAv235wire000000000000000000000000');
    const intake = agent.tools.find((t: any) => t.name === 'record_pcp_intake') as any;
    expect(Object.keys(intake.parameters.properties)).toContain('requestIsAboutAPatient');
    expect(intake.parameters.properties.requestIsAboutAPatient.description).toMatch(/specific patient/);
    const records = agent.tools.find((t: any) => t.name === 'handle_patient_medical_records_request') as any;
    expect(Object.keys(records.parameters.properties)).toContain('patientDob');
  });
});
