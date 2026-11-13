/**
 * A BLANK FIELD IS A FIELD THE MODEL DID NOT FILL (v219).
 *
 * CORPUS: every PCP runtime call of 2026-11-05..12 (`duration >= 30`) whose
 * LAST `record_pcp_intake` attempt was refused `invalid_arguments` and never
 * repeated: 28 calls. Read from `tool_timeline`, which keeps field NAMES only:
 * the refusal's `invalidFields`, and `recorded`, the keys the model sent with
 * a value. On every one of the 28, each refused field is absent from
 * `recorded`, so the model sent it blank (the refusal's own guidance reads
 * "too short (at least 1 characters)" and the date-of-birth format, the shapes
 * of an empty string). The refusal threw away everything else on the call too.
 *
 * Each case below is that call's shape: the refused fields sent blank, the
 * recorded fields sent with an invented value. On main the whole intake is
 * refused and the invented facts never reach the director; on this branch the
 * tool runs on the filled fields, exactly as if the blanks had been left out.
 *
 * Every value is invented. No production caller appears here.
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
const { refuseInvalidInputByName, withoutRefusedBlankFields } = await import('../services/toolInputRefusal');

let n = 0;
const freshCall = () => `pcp-blank-field-${++n}`;
const build = (callId: string) =>
  createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), {
    callId,
    callSid: `CA${String(n).padStart(32, '0')}`,
    callerPhone: '+17605550100',
  });
const invoke = async (agent: any, name: string, input: string) => {
  const t = agent.tools.find((tool: any) => tool.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.invoke({} as any, input);
};
const asObject = (raw: unknown) => (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>;

/** An invented value for each field the corpus calls carried filled. */
const FILLED: Record<string, unknown> = {
  callPurpose: 'check_patient_scheduled',
  callerIsThePatient: false,
  callerFacilityType: 'ipa_medical_group',
  callerName: 'Dana Okafor',
  callerOrganization: 'Example Medical Group',
  patientFirstName: 'Teodoro',
  patientLastName: 'Quillfeather',
  patientDob: '1955-10-13',
};

/** sid -> [fields the model sent blank, fields it sent filled], from the timeline. */
const CORPUS: Array<[string, string[], string[]]> = [
  ['CA02dbce27f042a841ddc10fac4daf7308', ['patientDob'], []],
  ['CA058427513b73b22c2d7aafea704be653', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerIsThePatient', 'callPurpose']],
  ['CA0b2908abfa27c4fc03f1b597351673a7', ['patientDob', 'patientFirstName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient', 'patientLastName']],
  ['CA11b574d5aeaef2ebbef85596a6539845', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerIsThePatient', 'callPurpose']],
  ['CA1cebb066f5e5dbe16721bc1427101b1a', ['patientDob'], []],
  ['CA22cd94852862244f7ed68acc2f6adcf5', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient']],
  ['CA2386e3eec1102419685457381dbdb404', ['patientDob'], []],
  ['CA309cdcb931ef202fa24dd4149fb385b7', ['patientDob'], []],
  ['CA4e3374bc9dcb6a24d0b8eff4a5c1ce39', ['patientMrn'], ['callerIsThePatient', 'callPurpose', 'patientDob', 'patientFirstName', 'patientLastName']],
  ['CA5df1d4e8dfc3084326b1059f68521b17', ['patientDob'], []],
  ['CA5df5cb81b28d120418c00c6350083a33', ['patientFirstName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient', 'patientLastName']],
  ['CA6de91d53fe315dafeec32f6c80a5176d', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient']],
  ['CA86e0b5ae29eecefe7c674c921bd681c1', ['patientFirstName'], ['callerFacilityType', 'callerIsThePatient', 'patientLastName']],
  ['CA9012073a1d189757e9124e5a5d5323cd', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient']],
  ['CAa6b725161ad5c62c8cbc3783d434f22f', ['patientDob'], []],
  ['CAb2362f03598cd4b314f3f4970b7f51dd', ['patientDob'], []],
  ['CAb65103376747f8b6d3f654ce085e09a9', ['patientDob'], []],
  ['CAb812eb33866dff9d76aeb45b1c713715', ['patientDob'], []],
  ['CAbe59a249116d917c34bbdbc9bcd4b2ae', ['patientDob'], []],
  ['CAbfb2dab6c7cec88347d2541f41185362', ['patientDob'], []],
  ['CAc731114ad7cc7214dcbecd898aceafcc', ['patientDob'], []],
  ['CAd360bee1c353e7e5216a8ce7cd1eb8fb', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerIsThePatient', 'callPurpose']],
  ['CAd64dbd3046675b5f1da2573394011d69', ['patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient', 'callerName', 'callerOrganization']],
  ['CAec1638bebd3094a24bd40386428b695c', ['patientDob', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient']],
  ['CAeef59d8b134f35d525c5b046e92e1e94', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient']],
  ['CAf4cc81774440088e903d12606f13a52b', ['patientDob'], []],
  ['CAf5d7b2e7184bc8f714c07dbf31cf070e', ['patientDob', 'patientFirstName', 'patientLastName', 'patientMrn'], ['callerFacilityType', 'callerIsThePatient', 'callerName', 'callerOrganization']],
  ['CAfebb95bfefcf247afb87b70255361966', ['patientDob'], []],
];

const argsFor = (blank: string[], filled: string[]) => ({
  ...Object.fromEntries(blank.map((f) => [f, ''])),
  ...Object.fromEntries(filled.map((f) => [f, FILLED[f]])),
});

describe('the corpus: the last intake attempt of 28 calls, refused for blank fields alone', () => {
  it('holds 28 calls, and 14 of them carried facts beside the blanks', () => {
    expect(CORPUS).toHaveLength(28);
    expect(new Set(CORPUS.map(([sid]) => sid)).size).toBe(28);
    expect(CORPUS.filter(([, , filled]) => filled.length > 0)).toHaveLength(14);
  });

  it.each(CORPUS)('%s: runs, and every fact it carried reaches the director', async (_sid, blank, filled) => {
    const callId = freshCall();
    const agent = build(callId);
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify(argsFor(blank, filled))));
    expect(out.refused).toBeUndefined();
    expect(out.success).not.toBe(false);
    const state = pcpDirector.get(callId) as unknown as Record<string, unknown>;
    for (const f of filled) expect(state[f]).toEqual(FILLED[f]);
    // A blank never lands as a value.
    for (const f of blank) expect(state[f] ?? undefined).toBeUndefined();
  });

  it('is recorded on the timeline as a run, with only the filled keys', async () => {
    const callId = freshCall();
    const agent = build(callId);
    const [, blank, filled] = CORPUS.find(([sid]) => sid === 'CA5df5cb81b28d120418c00c6350083a33')!;
    await invoke(agent, 'record_pcp_intake', JSON.stringify(argsFor(blank, filled)));
    const intake = (getAzulTimeline(callId) ?? []).filter((e) => e.tool === 'record_pcp_intake');
    expect(intake).toHaveLength(1);
    expect((intake[0].outcome as any).refused).toBeUndefined();
    expect([...(intake[0].args as any).recorded].sort()).toEqual([...filled].sort());
    expect(JSON.stringify(intake[0])).not.toContain('Quillfeather');
  });
});

describe('what a blank does not do', () => {
  it('a blank does not overwrite a value the director already holds', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await invoke(agent, 'record_pcp_intake', JSON.stringify({ callPurpose: 'check_patient_scheduled', patientLastName: 'Quillfeather' }));
    await invoke(agent, 'record_pcp_intake', JSON.stringify({ patientLastName: '', callerName: 'Dana Okafor' }));
    expect(pcpDirector.get(callId).patientLastName).toBe('Quillfeather');
    expect(pcpDirector.get(callId).callerName).toBe('Dana Okafor');
  });

  it('null and a string of spaces are blank too', async () => {
    const callId = freshCall();
    const agent = build(callId);
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      callPurpose: 'check_patient_scheduled', patientMrn: null, patientDob: '   ',
    })));
    expect(out.refused).toBeUndefined();
    expect(pcpDirector.get(callId).callPurpose).toBe('check_patient_scheduled');
  });

  it('a filled value in the wrong form is still refused, by name, and nothing is recorded', async () => {
    const callId = freshCall();
    const agent = build(callId);
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({
      callPurpose: 'check_patient_scheduled', patientDob: '10/13/1955', patientMrn: '',
    })));
    expect(out.refused).toBe('invalid_arguments');
    expect(out.invalidFields).toContain('patientDob');
    expect(pcpDirector.get(callId).callPurpose).toBeUndefined();
  });

  it('a placeholder word is not blank, and is refused where the form is wrong', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({ patientDob: 'unknown' })));
    expect(out.refused).toBe('invalid_arguments');
    expect(out.invalidFields).toEqual(['patientDob']);
  });

  it('a required field sent blank is still refused (handoff_to_pcp narrative)', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'handoff_to_pcp', JSON.stringify({ narrative: '' })));
    expect(out.refused).toBe('invalid_arguments');
    expect(out.invalidFields).toContain('narrative');
  });

  it('a field the tool does not have is still refused, blank or not', async () => {
    const agent = build(freshCall());
    const out = asObject(await invoke(agent, 'record_pcp_intake', JSON.stringify({ callPurpose: 'check_patient_scheduled', notAField: '' })));
    expect(out.refused).toBe('invalid_arguments');
    expect(out.invalidFields).toEqual(['notAField']);
  });
});

describe('the wrapper, directly', () => {
  const inner = () => vi.fn(async (..._args: unknown[]): Promise<unknown> => 'ran');

  it('hands the SDK the arguments without the blank keys, and nothing else changed', async () => {
    const schema = z.object({ a: z.string().min(1).optional(), b: z.string() }).strict();
    const run = inner();
    const wrapped = refuseInvalidInputByName({ invoke: run }, schema, vi.fn());
    expect(await wrapped.invoke!({}, JSON.stringify({ a: '', b: 'x' }), { id: 1 })).toBe('ran');
    expect(run).toHaveBeenCalledWith({}, JSON.stringify({ b: 'x' }), { id: 1 });
  });

  it('leaves a blank the schema accepts exactly as sent', () => {
    const schema = z.object({ a: z.string().nullable().optional(), b: z.string().min(2) }).strict();
    // b is refused for its length, not blank; a is null and accepted: nothing to drop.
    expect(withoutRefusedBlankFields(schema as any, JSON.stringify({ a: null, b: 'x' }))).toBeNull();
    // b is blank and refused: dropped; a's accepted null stays.
    const schemaOpt = z.object({ a: z.string().nullable().optional(), b: z.string().min(2).optional() }).strict();
    expect(withoutRefusedBlankFields(schemaOpt as any, JSON.stringify({ a: null, b: '' }))).toEqual({
      input: JSON.stringify({ a: null }),
      dropped: ['b'],
    });
  });

  it('valid arguments are untouched, and so is input that is not a JSON object', () => {
    const schema = z.object({ a: z.string().min(1).optional() }).strict();
    expect(withoutRefusedBlankFields(schema as any, '{"a":"x"}')).toBeNull();
    expect(withoutRefusedBlankFields(schema as any, '{a:')).toBeNull();
    expect(withoutRefusedBlankFields(schema as any, '[""]')).toBeNull();
  });

  it('logs field names, never a value', async () => {
    const schema = z.object({ secret: z.string().min(1).optional(), keep: z.string() }).strict();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const wrapped = refuseInvalidInputByName({ name: 'demo', invoke: inner() } as any, schema, vi.fn());
    await wrapped.invoke!({}, JSON.stringify({ secret: '', keep: 'Quillfeather' }));
    const lines = spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[TOOL INPUT]'));
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('demo');
    expect(lines[0]).toContain('secret');
    expect(lines[0]).not.toContain('Quillfeather');
  });
});
