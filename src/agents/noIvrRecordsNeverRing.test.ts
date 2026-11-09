/**
 * RECORDS REQUESTS NEVER RING THE ON-CALL — v190.
 *
 * Operator ruling, 2026-11-09: "no, records requests never ring the on-call."
 *
 * The corpus is ticket #73052 (VA-82150), two calls from one provider's office
 * on Saturday 2026-11-07, both asking for a patient's medical records:
 *
 *   CAbccc433f0627622f50d32ff4abd7cec8 (136 s): the office said "Doctor's
 *     office slash clinic", the gate sanctioned it as a provider call and the
 *     on-call phone rang 47 s and was declined. The agent then asked the
 *     CALLER's own last name and date of birth as if they were the patient,
 *     the model wrote "not provided - caller provider's office" for the date,
 *     the refusal that followed was spoken as "I'm having a technical issue",
 *     and the caller rang back.
 *   CAe8f5c1f0daedc324c21dc244dce7832d (81 s): rang the on-call phone again
 *     (24 s, no answer); the caller hung up and the teardown floor filed
 *     VA-82150 to After Hours with no requester. When staff moved it to
 *     Medical Records the case opened on the patient's 15-day clock — the
 *     ticketing app's deliberate rule for an unstated requester.
 *
 * Driven through the REAL registry, factory and floor (the v90 rule: a sweep
 * imported apart from its factory can read another copy of the per-call
 * state). Synthetic names and numbers only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LiveTool } from '../runtime/agentBinding';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

const h = vi.hoisted(() => ({
  getCallLogBySid: vi.fn(),
  submitSimplifiedTicket: vi.fn(),
  checkOpenTickets: vi.fn(),
  lookupByPhone: vi.fn(),
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: h.submitSimplifiedTicket,
    createTicketFromAgentInput: async () => ({ success: true, ticketNumber: 'VA-SYNTHETIC' }),
    checkOpenTickets: h.checkOpenTickets,
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: h.lookupByPhone,
    lookupPatient: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] }),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { defaultLaneSource } = await import('../runtime/laneRegistry');
const { runLaneTeardownFloor } = await import('../runtime/pcpFloor');
const { recordCallerSpeech } = await import('../services/symptomCorroboration');
const { judgeEscalation, RECORDS_REQUEST } = await import('../services/afterHoursEscalationGate');
const { FLOOR_RECORDS_NOTE } = await import('../services/afterHoursTeardownFloor');
const { resetGateAttempts } = await import('../tools/gateAttempts');

let serial = 0;
beforeEach(() => {
  resetGateAttempts();
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  h.checkOpenTickets.mockReset().mockResolvedValue([]);
  h.lookupByPhone.mockReset().mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [] });
});

async function call(callerSaid: string[] = []) {
  const source = await defaultLaneSource();
  const config = source.getAgentConfig('no-ivr')!;
  const callSid = `CA${String(++serial).padStart(32, 'b')}`;
  const callId = `synthetic-records-${serial}`;
  const handoff = vi.fn(async () => {});
  const agent = await config.factory(...[handoff, { callId, callSid, callerPhone: '+12025550100' }] as never[]);
  for (const line of callerSaid) recordCallerSpeech(callId, line);
  const transcript = callerSaid.map((l) => `CALLER: ${l}`).join('\n');
  const finish = () => runLaneTeardownFloor(
    { slug: 'no-ivr', callSid: callId, outcome: 'caller_hangup', transcript },
    { source: async () => source },
  );
  return { callSid, callId, handoff, finish, agent: agent as { tools: LiveTool[] } };
}

async function invoke(agent: { tools: LiveTool[] }, name: string, args = {}) {
  const tool = agent.tools.find((t) => t.name === name)!;
  expect(tool, `${name} is not on the agent`).toBeTruthy();
  const result = await tool.invoke!({}, JSON.stringify(args));
  return typeof result === 'string' ? JSON.parse(result) : result;
}

/** The two corpus calls, as the model wrote them and the caller said them. */
const CALL_1_SAID = ['Requesting medical records for a patient.', "Doctor's office slash clinic."];
const CALL_1_ESCALATION = {
  reason: "Caller is requesting medical records for a patient and has now identified as calling from a doctor's office/clinic.",
  caller_type: 'healthcare_provider',
};
const CALL_2_SAID = [
  'Trying to call to talk to an operator.',
  "First name is Sam, calling on behalf of Dr. Lee at the Example Rheumatology Center. I'm trying to request some medical records for a patient.",
];
const CALL_2_ESCALATION = {
  reason: 'Dr. Lee from Example Rheumatology Center is calling to request medical records for a patient. Provider office calling about a patient.',
  caller_type: 'healthcare_provider',
  provider_info: 'Example Rheumatology Center',
};

describe('the gate: a records request never rings, whoever asks', () => {
  it.each([
    ['CAbccc433f0627622f50d32ff4abd7cec8', CALL_1_ESCALATION.reason],
    ['CAe8f5c1f0daedc324c21dc244dce7832d', CALL_2_ESCALATION.reason],
    ['a patient', 'Patient wants a copy of their records tonight'],
    ['a hospital', 'Hospital ER needs the patient\'s chart sent over'],
  ])('%s is refused as records_request', (_label, reason) => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason,
      corroboration: { haveSpeech: true, providerStated: true, symptomStated: false, acuteStated: false, supported: [], unsupported: [] } as never,
    });
    expect(v).toMatchObject({ allowed: false, code: 'records_request' });
  });

  it('an eye emergency the caller described still rings, records or not', () => {
    const v = judgeEscalation({
      callerType: 'patient_urgent_medical',
      reason: 'Sudden loss of vision in the left eye; also wants their records',
      corroboration: { haveSpeech: true, providerStated: false, symptomStated: true, acuteStated: true, supported: ['vision loss'], unsupported: [] } as never,
    });
    expect(v.allowed).toBe(true);
  });

  it('"on record" is not a records request: a provider about a patient on file still rings', () => {
    expect(RECORDS_REQUEST.test(' the referral for our mutual patient is on record with your office ')).toBe(false);
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: "Dr. Lee's office calling about a mutual patient whose referral is on record with the practice",
      corroboration: { haveSpeech: true, providerStated: true, symptomStated: false, acuteStated: false, supported: [], unsupported: [] } as never,
    });
    expect(v).toMatchObject({ allowed: true, basis: 'provider_or_facility' });
  });

  it('a lab calling on a recorded line is not a records request', () => {
    expect(RECORDS_REQUEST.test(' example lab calling on a recorded line with stat results for dr. lee ')).toBe(false);
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Example Lab calling on a recorded line with stat results for a patient of Dr. Lee',
      corroboration: { haveSpeech: true, providerStated: true, symptomStated: false, acuteStated: false, supported: [], unsupported: [] } as never,
    });
    expect(v).toMatchObject({ allowed: true, basis: 'provider_or_facility' });
  });
});

describe('the agent: nothing rings, the patient is asked for, and the request reaches Medical Records', () => {
  it('call 2: the escalation is refused, nothing is dialled and nothing is filed yet', async () => {
    const c = await call(CALL_2_SAID);
    const r = await invoke(c.agent, 'escalate_to_human', CALL_2_ESCALATION);
    expect(r).toMatchObject({ success: false, refused: 'records_request', ticket_filed: false });
    expect(r.message).toMatch(/PATIENT's first and\s+last name/);
    expect(r.message).toMatch(/never the caller's own/);
    expect(r.message).not.toMatch(/ALREADY been filed/);
    expect(r.message).toMatch(/do NOT say there is a technical issue/);
    expect(c.handoff).not.toHaveBeenCalled();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('then create_ticket files to Medical Records with the office as the requester, off the patient clock', async () => {
    const c = await call(CALL_2_SAID);
    await invoke(c.agent, 'escalate_to_human', CALL_2_ESCALATION);
    const r = await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: '03/04/1960',
      callback_number: '2025550100',
      request_category: 'medical_records_request',
      records_requester: 'provider_office',
      requester_name: 'Sam, Example Rheumatology Center',
      request_summary: 'Provider office requesting the patient\'s medical records, to be faxed to the office',
    });
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    expect(sent.recordsRequester).toEqual({
      requestorType: 'provider',
      requestPathway: 'third_party_treatment',
      capClockApplies: false,
      requestorName: 'Sam, Example Rheumatology Center',
    });
    expect(sent.patientFullName).toMatch(/Pat Example/);
    expect(sent.suggestedRequestTypeId).toBeUndefined();
    expect(String(sent.additionalDetails)).toMatch(/MEDICAL RECORDS: an after-hours records request/);
    expect(c.handoff).not.toHaveBeenCalled();
  });

  it('a refused records request routes create_ticket to Medical Records even when the model picks another category', async () => {
    const c = await call(CALL_2_SAID);
    await invoke(c.agent, 'escalate_to_human', CALL_2_ESCALATION);
    await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: '03/04/1960', callback_number: '2025550100',
      request_category: 'general_question',
      request_summary: 'Office asking for a patient chart',
    });
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    // The provider was noted at the refusal: the caller said who they were.
    expect(sent.recordsRequester).toMatchObject({ requestorType: 'provider', capClockApplies: false });
  });

  it('a records ticket carries no After Hours request-type hint, even when its summary would classify', async () => {
    const c = await call(CALL_2_SAID);
    await invoke(c.agent, 'escalate_to_human', CALL_2_ESCALATION);
    await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: '03/04/1960', callback_number: '2025550100',
      request_category: 'medical_records_request', records_requester: 'provider_office',
      // This summary classifies as an After Hours type (test results), not the catch-all.
      request_summary: "Office requesting the patient's records and test results",
    });
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    expect(sent.suggestedRequestTypeId).toBeUndefined();
    expect(sent.suggestedRequestReasonId).toBeUndefined();
  });

  it('a patient asking for their own records stays on the clock', async () => {
    const c = await call(['I need a copy of my medical records.']);
    await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: '03/04/1960', callback_number: '2025550100',
      request_category: 'medical_records_request', records_requester: 'patient',
      request_summary: 'Patient requesting a copy of their own medical records',
    });
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    expect(sent.recordsRequester).toMatchObject({ requestorType: 'patient', requestPathway: 'roa_patient', capClockApplies: true });
  });

  it('nobody said who is asking: Medical Records, and no requester is guessed', async () => {
    const c = await call(['I need some records.']);
    await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: '03/04/1960', callback_number: '2025550100',
      request_category: 'medical_records_request',
      request_summary: 'Records request',
    });
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    expect(sent.recordsRequester).toBeUndefined();
  });
});

describe('call 1: a date of birth the caller cannot give is not a technical issue', () => {
  it('"not provided - caller provider\'s office" files without a date of birth', async () => {
    const c = await call(CALL_1_SAID);
    const r = await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example',
      date_of_birth: "not provided - caller provider's office",
      callback_number: '2025550100',
      request_category: 'medical_records_request', records_requester: 'provider_office',
      request_summary: 'Provider office requesting records for a patient',
    });
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.patientDOB).toBe('Unknown');
  });

  it('an unreadable date is asked once, and the refusal says how to file without it', async () => {
    const c = await call(CALL_1_SAID);
    const r = await invoke(c.agent, 'create_ticket', {
      first_name: 'Pat', last_name: 'Example', date_of_birth: 'the third',
      callback_number: '2025550100', request_category: 'general_question',
      request_summary: 'Question for the team',
    });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/call create_ticket again straight away with date_of_birth "unknown"/);
    expect(r.message).toMatch(/never tell the caller there is a technical issue/);
  });
});

describe('the floor: a records caller who hangs up is filed to Medical Records', () => {
  it('call 2 shape: refused, hung up, filed to department 16 with the office as requester', async () => {
    const c = await call(CALL_2_SAID);
    await invoke(c.agent, 'escalate_to_human', CALL_2_ESCALATION);
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(16);
    expect(sent.recordsRequester).toMatchObject({ requestorType: 'provider', requestPathway: 'third_party_treatment', capClockApplies: false });
    expect(sent.suggestedRequestTypeId).toBeUndefined();
    expect(String(sent.additionalDetails)).toContain(FLOOR_RECORDS_NOTE);
  });

  it('a call with no records request is filed to After Hours exactly as before', async () => {
    const c = await call(['My glasses broke and I need to come in.']);
    await c.finish();
    const sent = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.departmentId).toBe(8);
    expect(sent.recordsRequester).toBeUndefined();
    expect(String(sent.additionalDetails)).not.toContain(FLOOR_RECORDS_NOTE);
  });
});

describe('both prompt bodies carry the ruling', () => {
  const agentSource = readFileSync(new URL('./noIvrAgent.ts', import.meta.url), 'utf8');
  const grokSource = readFileSync(new URL('./noIvrPromptForGrok.ts', import.meta.url), 'utf8');
  it('the old core body', () => {
    expect(agentSource).toMatch(/EXCEPT RECORDS — never a transfer: get the PATIENT's name and DOB/);
  });
  it('the runtime body', () => {
    expect(grokSource).toMatch(/Records never transfer: take their name and office, then one at a time the PATIENT's name/);
  });
});
