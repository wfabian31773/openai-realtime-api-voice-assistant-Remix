/**
 * A PCP TOOL'S INPUT ERROR NAMES THE FIELD (v177; v173 while #426 was open).
 *
 * CORPUS: CAa36ae68ef6d5654594fe11253d30a942 (pcp, 2026-11-03 17:15 UTC). An
 * outside clinic asked whether a patient was scheduled. The deployment log
 * shows `record_pcp_intake not dispatched — 10 identical successful calls`,
 * then four `20 successful calls` refusals; the timeline holds nine other
 * tools refused `call_purpose_required` and no `record_pcp_intake` at all. The
 * caller was told her request was with the team. No ticket exists.
 *
 * The chain, read from `@openai/agents-core/dist/tool.js`: a zod refusal of
 * the model's arguments throws a bare `ModelBehaviorError`, and the SDK's
 * default error function answers "An error occurred while running the tool.
 * Please try again." — no field, an instruction to repeat, a string the
 * runtime reads as a success, and `execute` (and so the timeline) never runs.
 *
 * Which field the model got wrong on the day is not recoverable (the SDK logs
 * it at debug level only), so the corpus shape here is the plausible one — a
 * spoken date of birth where the schema takes YYYY-MM-DD — beside every other
 * kind of refusal the hand-built schema can make.
 *
 * Every fixture is invented. No production caller appears here.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: vi.fn(), lookupByNameAndDOB: vi.fn() },
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { getAzulTimeline } = await import('../services/toolTimeline');
const { inputRefusalFor, refuseInvalidInputByName } = await import('../services/toolInputRefusal');

const CORPUS_SID = 'CAa36ae68ef6d5654594fe11253d30a942';
const CALLER_PHONE = '+17605550100';

let n = 0;
const freshCall = () => `pcp-input-error-${++n}`;

const build = (callId: string) =>
  createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), {
    callId,
    callSid: `CA${String(n).padStart(32, '0')}`,
    callerPhone: CALLER_PHONE,
  });

/** The tool exactly as the runtime calls it: `invoke` with a JSON string. */
const invoke = async (agent: any, name: string, input: string) => {
  const t = agent.tools.find((tool: any) => tool.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.invoke({} as any, input);
};

const asObject = (raw: unknown) => (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>;

/** The corpus shape: what the agent said back on the day, as intake arguments. */
const CORPUS_INTAKE = {
  callPurpose: 'check_patient_scheduled',
  callerName: 'Dana Okafor',
  callerOrganization: 'Example Veterans Clinic',
  patientFirstName: 'Teodoro',
  patientLastName: 'Quillfeather',
  patientDob: '10/13/1955',
};

describe(`the corpus shape (${CORPUS_SID})`, () => {
  it('names the field, says nothing was recorded, and is a failure the runtime can see', async () => {
    const callId = freshCall();
    const agent = build(callId);
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify(CORPUS_INTAKE)));

    expect(out.success).toBe(false);
    expect(out.refused).toBe('invalid_arguments');
    expect(out.invalidFields).toEqual(['patientDob']);
    expect(out.guidance).toMatch(/NOTHING WAS RECORDED/);
    expect(out.guidance).toMatch(/patientDob must be YYYY-MM-DD/);
    expect(out.guidance).not.toMatch(/try again/i);
    // Model-facing only: there is nothing for the caller to hear.
    expect(out.say).toBeUndefined();
    expect(out.message).toBeUndefined();
    // Nothing the model sent is repeated back.
    expect(out.guidance).not.toContain('10/13/1955');
    expect(out.guidance).not.toContain('Quillfeather');
  });

  it('is recorded on the call timeline, by field name only', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await invoke(agent, 'record_pcp_intake', JSON.stringify(CORPUS_INTAKE));
    const events = getAzulTimeline(callId) ?? [];
    const intake = events.filter((e) => e.tool === 'record_pcp_intake');
    expect(intake).toHaveLength(1);
    expect(intake[0].outcome).toMatchObject({
      success: false,
      refused: 'invalid_arguments',
      invalidFields: ['patientDob'],
    });
    const stored = JSON.stringify(intake[0]);
    expect(stored).not.toContain('10/13/1955');
    expect(stored).not.toContain('Quillfeather');
  });

  it('records nothing on a refusal — the call purpose is still unset', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await invoke(agent, 'record_pcp_intake', JSON.stringify(CORPUS_INTAKE));
    expect(pcpDirector.get(callId).callPurpose).toBeUndefined();
  });

  it('the corrected call records the intake, and the purpose gate opens', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await invoke(agent, 'record_pcp_intake', JSON.stringify(CORPUS_INTAKE));
    const fixed = asObject(
      await invoke(agent, 'record_pcp_intake', JSON.stringify({ ...CORPUS_INTAKE, patientDob: '1955-10-13' })),
    );
    expect(fixed.success).not.toBe(false);
    expect(pcpDirector.get(callId).callPurpose).toBe('check_patient_scheduled');
    expect(pcpDirector.get(callId).patientDob).toBe('1955-10-13');
  });
});

describe('every kind of refusal names its field', () => {
  it('a field the tool does not have', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      callPurpose: 'check_patient_scheduled',
      patientFullName: 'Teodoro Quillfeather',
    })));
    expect(out.invalidFields).toEqual(['patientFullName']);
    expect(out.guidance).toMatch(/patientFullName is not a field of this tool — leave it out/);
    expect(out.guidance).not.toContain('Quillfeather');
  });

  it('a purpose that is not one of the slugs, listed, with the invented one not echoed', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      callPurpose: 'appointment_verification_request',
    })));
    expect(out.invalidFields).toEqual(['callPurpose']);
    expect(out.guidance).toMatch(/callPurpose must be exactly one of: .*check_patient_scheduled/);
    expect(out.guidance).not.toContain('appointment_verification_request');
    // The floor's own slug is not offered to the model.
    expect(out.guidance).not.toContain('unclassified_call');
  });

  it('a value that is too short', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({ callbackNumber: '555' })));
    expect(out.invalidFields).toEqual(['callbackNumber']);
    expect(out.guidance).toMatch(/callbackNumber is too short \(at least 7 characters\)/);
    expect(out.guidance).not.toContain('555');
  });

  it('a value of the wrong type', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({ callerIsThePatient: 'no' })));
    expect(out.invalidFields).toEqual(['callerIsThePatient']);
    expect(out.guidance).toMatch(/callerIsThePatient must be a boolean/);
  });

  it('several fields at once, each named once', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      patientDob: 'October 13 1955',
      callPurpose: 'not_a_slug',
      extra: true,
    })));
    expect(out.invalidFields.sort()).toEqual(['callPurpose', 'extra', 'patientDob']);
  });

  it('arguments that are not JSON at all', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', '{callPurpose: check'));
    expect(out.success).toBe(false);
    expect(out.invalidFields).toEqual(['(arguments)']);
  });

  it('applies to every PCP tool, not only the intake', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'create_pcp_task', JSON.stringify({
      narrative: 'Clinic asking whether a patient is scheduled.',
      urgency: 'whenever',
    })));
    expect(out.success).toBe(false);
    expect(out.invalidFields).toEqual(['urgency']);
  });
});

describe('arguments the schema accepts run exactly as before', () => {
  it('a valid intake reaches the director and answers with the next question', async () => {
    const callId = freshCall();
    const agent = build(callId);
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      callPurpose: 'check_patient_scheduled',
      callerName: 'Dana Okafor',
    })));
    expect(out.success).not.toBe(false);
    expect(out.refused).toBeUndefined();
    expect(pcpDirector.get(callId).callerName).toBe('Dana Okafor');
  });

  it('a valid call is handed to the SDK invoke untouched', async () => {
    const schema = z.object({ a: z.string() }).strict();
    const inner = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'ran');
    const wrapped = refuseInvalidInputByName({ invoke: inner }, schema, vi.fn());
    expect(await wrapped.invoke!({}, '{"a":"x"}', { id: 1 })).toBe('ran');
    expect(inner).toHaveBeenCalledWith({}, '{"a":"x"}', { id: 1 });
  });

  it('a refused call never reaches the SDK invoke, and a failing recorder does not change the answer', async () => {
    const schema = z.object({ a: z.string() }).strict();
    const inner = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'ran');
    const wrapped = refuseInvalidInputByName({ invoke: inner }, schema, () => { throw new Error('db down'); });
    const out = (await wrapped.invoke!({}, '{"b":1}')) as unknown as Record<string, any>;
    expect(inner).not.toHaveBeenCalled();
    expect(out.invalidFields.sort()).toEqual(['a', 'b']);
  });

  it('a schema with no regex check gets the generic format line, never a guessed one', () => {
    const schema = z.object({ code: z.string().email() }).strict();
    const verdict = inputRefusalFor(schema as any, '{"code":"nope"}');
    expect(verdict?.refusal.guidance).toMatch(/code is not in the form this tool accepts/);
  });
});
