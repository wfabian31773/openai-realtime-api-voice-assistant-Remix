/**
 * The conversation, read with a tool — the working agent's mechanism.
 *
 * Operator, 2026-08-10: "someone can say, well, I was thinking and, you know,
 * and then you know what happened and then… oh, my… yeah. My name is Wayne
 * Fabian. How would you be able to parse that?"
 *
 * You do not. The value of the tool is that the model reads the WHOLE call and
 * fills typed arguments. The risk of the tool is that a model will happily
 * fill an argument the caller never said, which is what the grounding check
 * refuses — the same guard azulSchedulingAgent carries for the same reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { noteAgent, noteCaller, readConversation, forgetConversation } from './conversationReader';

/** The model calls record_facts with these arguments. */
function toolReply(args: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }],
    }),
  };
}

const C = 'call-reader';

beforeEach(() => {
  fetchMock.mockReset();
  forgetConversation(C);
  process.env.OPENAI_API_KEY = 'test-key';
});
afterEach(() => forgetConversation(C));

describe('reading the whole conversation', () => {
  it('takes a name stated mid-ramble, turns after it was asked for', async () => {
    noteAgent(C, "May I have the patient's first and last name?");
    noteCaller(C, 'Well I was thinking, and you know what happened, and then—');
    noteAgent(C, "May I have the patient's first and last name?");
    noteCaller(C, 'oh, my… yeah. My name is Wayne Fabian.');
    fetchMock.mockResolvedValue(toolReply({ patient_name: 'Wayne Fabian' }));

    const r = await readConversation(C);
    expect(r.values.patient_name).toBe('Wayne Fabian');
    // The model was given the whole call, not one utterance.
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.messages[1].content).toContain('I was thinking');
    expect(sent.messages[1].content).toContain('Wayne Fabian');
    expect(sent.tools[0].function.name).toBe('record_facts');
  });

  it('fills several fields from one breath', async () => {
    noteCaller(C, 'Wayne Fabian, March 17th 1973, and please fax it to 760 870 1200');
    fetchMock.mockResolvedValue(
      toolReply({ patient_name: 'Wayne Fabian', patient_dob: '1973-03-17', fax_number: '7608701200' }),
    );
    const r = await readConversation(C);
    expect(r.values).toMatchObject({
      patient_name: 'Wayne Fabian',
      patient_dob: '1973-03-17',
      fax_number: '7608701200',
    });
  });

  it('REFUSES a name the caller never said', async () => {
    // A confident model completing a half-heard word is how one patient's
    // request lands on another patient's chart.
    noteAgent(C, "May I have the patient's first and last name?");
    noteCaller(C, "It's Wayne, uh—");
    fetchMock.mockResolvedValue(toolReply({ patient_name: 'Wayne Fabian' }));
    const r = await readConversation(C);
    expect(r.values.patient_name).toBeUndefined();
    expect(r.refused).toContain('patient_name');
  });

  it('REFUSES a date of birth whose year was never spoken', async () => {
    // The exact failure the working agent's grounding guard exists for: a
    // model reassembling a date out of loose digits.
    noteAgent(C, "And the patient's date of birth?");
    noteCaller(C, 'March seventeenth');
    fetchMock.mockResolvedValue(toolReply({ patient_dob: '1973-03-17' }));
    const r = await readConversation(C);
    expect(r.values.patient_dob).toBeUndefined();
    expect(r.refused).toContain('patient_dob');
  });

  it('REFUSES a phone number that is not in the call', async () => {
    noteCaller(C, 'you can reach me at home');
    fetchMock.mockResolvedValue(toolReply({ callback_number: '5625550134' }));
    const r = await readConversation(C);
    expect(r.values.callback_number).toBeUndefined();
  });

  it('accepts a date the caller gave in another format', async () => {
    noteCaller(C, "It's 03/17/1973.");
    fetchMock.mockResolvedValue(toolReply({ patient_dob: '1973-03-17' }));
    const r = await readConversation(C);
    expect(r.values.patient_dob).toBe('1973-03-17');
  });

  it('never blocks the call when the model is down, slow or unset', async () => {
    noteCaller(C, 'Wayne Fabian');
    fetchMock.mockRejectedValue(new Error('vendor down'));
    expect((await readConversation(C)).values).toEqual({});

    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect((await readConversation(C)).values).toEqual({});

    delete process.env.OPENAI_API_KEY;
    expect((await readConversation(C)).values).toEqual({});
    process.env.OPENAI_API_KEY = 'test-key';
  });
});
