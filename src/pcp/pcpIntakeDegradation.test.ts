/**
 * A PCP request must never be discarded for want of an administrative field.
 *
 * 2026-08-06. The PCP tool timeline shipped that evening and, within ten
 * minutes of going live, showed what had been invisible all day:
 *
 *   e0384db1 (253s): record_pcp_intake x5, then create_pcp_task, handoff_to_pcp
 *                    x3 and create_pcp_task again — all ten dying on
 *                    `missing_required_field:callbackNumber`.
 *   e761053a (215s): five attempts, every one `missing_required_field:callerName`.
 *
 * `requireState` threw whenever the director still wanted anything, and every
 * ticket tool called it FIRST — so one uncaptured field discarded the whole
 * request. The caller heard "it seems like there was an issue recording". Of
 * 196 PCP calls that day 41 produced a ticket, and 21 medical-records requests
 * left none at all: providers asking for chart copies, patients asking for
 * their own records, and one caller who rang back eight minutes later and got
 * nothing a second time.
 *
 * These tests pin the property that prevents a repeat: the gap goes ON the
 * ticket, never in place of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UPDATED 2026-08-17, because the operator reinstated blocking deliberately:
 *
 *   "we should not be filing tickets in 27 seconds... we should not create a
 *    ticket unless we have enough information to do so, a ticket should be
 *    blocked without required fields... the most important parts of a ticket
 *    are who is calling, who is the call about and how do we contact you."
 *
 * The MECHANISM changed; the GUARANTEE did not. A request is still never
 * discarded — it is asked about first, and the asking is BOUNDED. After
 * MAX_BLOCKS questions the ticket files with the gaps written on it, exactly as
 * these tests always demanded.
 *
 * The 08-06 defect was never "it asked a question". It was that the refusal
 * carried no way out, so the agent retried the same call ten times and the
 * caller heard nothing but apologies. Two things prevent that now, both tested
 * below: the bounded budget, and a refusal that hands the agent the question to
 * ask (src/pcp/refusals.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const filed: any[] = [];

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: {
    createPcpTicket: async (payload: any) => {
      filed.push(payload);
      return { success: true, ticketId: filed.length, ticketNumber: `PCP-${1000 + filed.length}` };
    },
  },
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

let n = 0;
const freshCall = () => `pcp-degrade-${++n}`;

/** Drive a tool the way the model does: by name, with a JSON argument string. */
const call = async (agent: any, name: string, args: unknown) => {
  const t = agent.tools.find((tool: any) => tool.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.invoke({} as any, JSON.stringify(args));
};

const build = (callId: string, callerPhone?: string) =>
  createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), {
    callId,
    callSid: `CA${callId}`,
    callerPhone,
  });

/**
 * Drive a filing tool until it files, the way a call actually goes: the tool
 * asks for something, the caller does not supply it, the agent tries again.
 *
 * Bounded at six attempts and asserts it took FEWER — the whole point of
 * MAX_BLOCKS is that a caller who answers nothing still gets a ticket in a
 * handful of turns rather than the ten of e0384db1.
 */
async function fileAfterAsking(agent: any, tool: string, args: unknown): Promise<string[]> {
  const asked: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const raw = await call(agent, tool, args);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const result = parsed?.result ?? parsed;
    if (result?.success !== false) return asked;
    if (typeof result?.say === 'string') asked.push(result.say);
  }
  throw new Error(`${tool} never filed after 6 attempts — the floor is broken`);
}

beforeEach(() => {
  filed.length = 0;
});

describe('a records request survives an incomplete intake', () => {
  it('files even when the caller never gave a name, role or organization', async () => {
    // The 11:36 call: the caller said "Medical records. Patient's medical
    // record." and nothing else. Fifty seconds, no ticket.
    //
    // It is asked for now, and when it still does not come it files anyway.
    const callId = freshCall();
    const agent = build(callId, '+15624494183');
    const asked = await fileAfterAsking(agent, 'handle_patient_medical_records_request', {
      narrative: 'Caller is requesting a copy of a patient medical record.',
    });

    expect(filed).toHaveLength(1);
    expect(filed[0].callPurpose).toBe('patient_medical_records_request');
    expect(filed[0].disposition).toBe('CREATE_TASK');
    // It asked, but it did not interrogate.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length, 'this is the e0384db1 shape if it grows').toBeLessThanOrEqual(3);
  });

  it('every question it asks is one a caller can answer out loud', async () => {
    // The 08-06 failure was a slug the agent could only retry. Every hold now
    // hands over a sentence.
    const { REQUIRED_PROMPTS } = await import('./ticketRequirements');
    for (const prompt of Object.values(REQUIRED_PROMPTS) as string[]) {
      expect(prompt).toMatch(/\?$/);
      expect(prompt).not.toMatch(/missing_required_field|callerName|patientName/);
    }
  });

  it('names every gap on the ticket, so staff know what to ask for', async () => {
    const callId = freshCall();
    await fileAfterAsking(build(callId, '+15624494183'), 'handle_patient_medical_records_request', {
      narrative: 'Records request.',
    });
    // The caller ID supplied the callback number, so it is NOT a gap; the three
    // fields nobody captured are.
    expect(filed[0].narrative).toContain('Intake incomplete');
    for (const gap of ['caller name', 'caller role', 'organization']) {
      expect(filed[0].narrative).toContain(gap);
    }
    // And the new annotation names the ones we actually held the ticket for.
    expect(filed[0].narrative).toContain('NOT CAPTURED');
  });

  it('reports the PATIENT-context gaps too, not just the professional ones', async () => {
    // The live timeline showed a records call burning ELEVEN attempts on
    // missing_required_field:statedRelationship — a second class of required
    // field the first pass at this fix did not account for. None of these
    // blocks filing, but "we do not know which patient" must be stated.
    const callId = freshCall();
    const agent = build(callId, "+15626022508");
    await call(agent, "record_pcp_intake", { callerName: "Edna", callerRole: "receptionist" });
    await fileAfterAsking(agent, "handle_patient_medical_records_request", { narrative: "Records request." });

    expect(filed).toHaveLength(1);
    for (const gap of ['patient first name', 'patient last name', 'patient date of birth', 'relationship to the patient']) {
      expect(filed[0].narrative).toContain(gap);
    }
    // and it still files, which is the whole point
    expect(filed[0].callPurpose).toBe('patient_medical_records_request');
  });

  it('never lets a placeholder read as something the caller said', async () => {
    const callId = freshCall();
    await fileAfterAsking(build(callId), "handle_patient_medical_records_request", { narrative: "Records request." });
    expect(filed[0].callerName).toBe('Not provided by caller');
    expect(filed[0].callerRole).toBe('Not provided');
    // Caller ID withheld — say so rather than inventing a number.
    expect(filed[0].callerCallbackNumber).toBe('NOT PROVIDED');
    expect(filed[0].narrative).toContain('Caller ID was withheld');
  });
});

describe('the callback number comes from the call itself', () => {
  it('seeds it from caller ID, which is what killed e0384db1', async () => {
    const callId = freshCall();
    await fileAfterAsking(build(callId, "+16263455967"), "handle_patient_medical_records_request", { narrative: "x" });
    expect(filed[0].callerCallbackNumber).toBe('+16263455967');
    expect(filed[0].narrative).not.toContain('callback number');
  });

  it('is overridden the moment the caller states a different one', async () => {
    // A direct line beats the switchboard they happened to dial from.
    const callId = freshCall();
    const agent = build(callId, '+16263455967');
    await call(agent, 'record_pcp_intake', { callbackNumber: '+15625551234' });
    await fileAfterAsking(agent, "handle_patient_medical_records_request", { narrative: "x" });
    expect(filed[0].callerCallbackNumber).toBe("+15625551234");
  });

  it('does not treat a withheld caller ID as a phone number', async () => {
    const callId = freshCall();
    await fileAfterAsking(build(callId, "Anonymous"), "handle_patient_medical_records_request", { narrative: "x" });
    expect(filed[0].callerCallbackNumber).toBe('NOT PROVIDED');
  });
});

describe('create_pcp_task no longer refuses a filable request', () => {
  it('files while the director still has a question outstanding', async () => {
    /**
     * THE DISTINCTION THE 2026-08-17 RULING TURNS ON.
     *
     * The director wants six fields from a professional. Only three of them
     * hold a ticket: who is calling, who it is about, how to reach them. A
     * director question about a ROLE or an ORGANISATION must never stop a
     * filable request — that is the 08-06 defect, and it is still forbidden.
     */
    const callId = freshCall();
    const agent = build(callId, '+17607769511');
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'notify_referral_approval',
      callerName: 'Edna Ruiz',
      patientFirstName: 'Wayne',
      patientLastName: 'Fabian',
    });
    // Director still wants callerRole / callerOrganization / callerFacilityType.
    expect(pcpDirector.next(callId).nextQuestion).toBeTruthy();

    const out = await call(agent, 'create_pcp_task', {
      narrative: 'Referral approved for mutual patient.',
      urgency: 'normal',
      disposition: 'CREATE_TASK',
    });
    expect(JSON.stringify(out)).not.toContain('missing_required_field');
    expect(filed).toHaveLength(1);
  });

  it('still refuses without a call purpose — the one thing that routes the ticket', async () => {
    const callId = freshCall();
    const out = await call(build(callId, '+17607769511'), 'create_pcp_task', {
      narrative: 'Something.', urgency: 'normal', disposition: 'CREATE_TASK',
    });
    expect(JSON.stringify(out)).toContain('call_purpose_required');
    expect(filed).toHaveLength(0);
  });
});

describe('an ineligible handoff leaves a task behind, not an error', () => {
  it('files the request when the transfer cannot be offered', async () => {
    const callId = freshCall();
    const agent = build(callId, '+19093934334');
    await call(agent, 'record_pcp_intake', { callPurpose: 'peer_to_peer' });
    // Incomplete intake ⇒ not handoff-eligible. Previously: throw, then nothing.
    const out = await call(agent, 'handoff_to_pcp', { narrative: 'Peer-to-peer about a mutual patient.', urgency: 'high' });

    expect(filed).toHaveLength(1);
    expect(filed[0].disposition).toBe('CREATE_TASK');
    expect(JSON.stringify(out)).toContain('task_created');
  });
});

describe('the safety properties that must NOT relax', () => {
  it('will not claim an automated resolution without an authoritative tool success', async () => {
    const callId = freshCall();
    const agent = build(callId, '+17607769511');
    await call(agent, 'record_pcp_intake', { callPurpose: 'check_patient_scheduled' });
    const out = await call(agent, 'record_automated_resolution', { narrative: 'Told them it is booked.' });
    expect(JSON.stringify(out)).toContain('authoritative_tool_success_required');
    expect(filed).toHaveLength(0);
  });

  it('will not file AUTOMATE against a purpose that forbids it', async () => {
    const callId = freshCall();
    const agent = build(callId, '+17607769511');
    await call(agent, 'record_pcp_intake', { callPurpose: 'grievance_follow_up' });
    const out = await call(agent, 'record_automated_resolution', { narrative: 'Handled.' });
    expect(JSON.stringify(out)).toContain('automate_not_allowed_for_purpose');
    expect(filed).toHaveLength(0);
  });
});
