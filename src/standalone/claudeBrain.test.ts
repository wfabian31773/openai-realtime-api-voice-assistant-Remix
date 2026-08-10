/**
 * The brain: the real agent's prompt and tools, on a Claude tool loop.
 *
 * The agent itself is stubbed here — creating the real one reads the database
 * and the caller's schedule, which a unit test has no business doing. What is
 * tested is the LOOP: does a tool call reach the real execute, does its result
 * go back to the model, does a caller ever end up in silence when something
 * fails, and does speech start before the answer is finished.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/** The invoke() of the real tool, so we can assert it was actually called. */
// Typed with its real parameters, so mock.calls is a tuple the compiler knows
// about. Declaring it argument-free typechecks locally but breaks the deploy
// build, which compiles tests too.
const lookupInvoke = vi.fn(
  async (_ctx: unknown, _input: string): Promise<string> =>
    JSON.stringify({ patientFound: true, lastAppointment: '2026-07-13' }),
);

vi.mock('../agents/answeringServiceAgent', () => ({
  answeringServiceAgentConfig: { version: '3.7.0', greeting: 'Thank you for calling Azul Vision.' },
  createAnsweringServiceAgent: vi.fn(async () => ({
    instructions: 'You are the OVERFLOW ANSWERING SERVICE for Azul Vision.',
    tools: [
      {
        name: 'lookup_schedule',
        description: 'Look up patient appointment context.',
        parameters: { type: 'object', properties: { first_name: { type: 'string' } } },
        invoke: lookupInvoke,
      },
    ],
  })),
}));

import { createClaudeBrain, splitForSpeech } from './claudeBrain';

/** An Anthropic SSE stream, as the real API sends one. */
function stream(events: Array<Record<string, unknown>>) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return {
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(body) };
          },
        };
      },
    },
  };
}

const textReply = (t: string) =>
  stream([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);

const toolReply = (name: string, args: Record<string, unknown>) =>
  stream([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]);

beforeEach(() => {
  fetchMock.mockReset();
  lookupInvoke.mockClear();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('speaking before the answer is finished', () => {
  it('splits on sentence ends so the first clause can go out early', () => {
    expect(splitForSpeech('Thanks, Wayne. And your date of birth? I can look it up.')).toEqual([
      'Thanks, Wayne.',
      'And your date of birth?',
      'I can look it up.',
    ]);
  });

  it('does not split a date or an abbreviation into pieces', () => {
    expect(splitForSpeech('Your last visit was 03/17/1973 at our Redlands office.')).toHaveLength(1);
  });
});

describe('the tool loop', () => {
  it('calls the REAL tool and feeds its result back to the model', async () => {
    fetchMock
      .mockResolvedValueOnce(toolReply('lookup_schedule', { first_name: 'Wayne', last_name: 'Fabian' }))
      .mockResolvedValueOnce(textReply('Your last appointment was Monday, July 13.'));

    const brain = await createClaudeBrain({ callId: 'c1', callerPhone: '8455317471' });
    const said: string[] = [];
    const turn = await brain!.respond('When was my last appointment?', (s) => said.push(s));

    // The real tool ran, with the model's arguments.
    expect(lookupInvoke).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lookupInvoke.mock.calls[0][1])).toMatchObject({ first_name: 'Wayne' });
    expect(turn.toolsUsed).toEqual(['lookup_schedule']);
    expect(said.join(' ')).toContain('Monday, July 13');

    // The tool RESULT went back — otherwise the model answered blind.
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const results = second.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    expect(results.some((c: any) => c.type === 'tool_result' && c.content.includes('2026-07-13'))).toBe(true);
  });

  it('caches the prompt instead of re-reading 10,000 tokens every turn', async () => {
    fetchMock.mockResolvedValue(textReply('Sure.'));
    const brain = await createClaudeBrain({ callId: 'c2' });
    await brain!.respond('hello');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('a tool that throws becomes information, not a dead call', async () => {
    lookupInvoke.mockRejectedValueOnce(new Error('schedule service down'));
    fetchMock
      .mockResolvedValueOnce(toolReply('lookup_schedule', { first_name: 'Wayne' }))
      .mockResolvedValueOnce(textReply('I could not pull that up — let me take a message.'));

    const brain = await createClaudeBrain({ callId: 'c3' });
    const turn = await brain!.respond('when was my last appointment');
    expect(turn.error).toBeUndefined();
    expect(turn.sentences.join(' ')).toContain('take a message');
  });

  it('never leaves the caller in silence when the vendor fails', async () => {
    fetchMock.mockRejectedValue(new Error('anthropic down'));
    const brain = await createClaudeBrain({ callId: 'c4' });
    const turn = await brain!.respond('hello');
    expect(turn.error).toBeTruthy();
    expect(turn.sentences).toEqual([]); // the LINE says the apology, not the brain
  });

  it('refuses to build without a key, so the line can fall back', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await createClaudeBrain({ callId: 'c5' })).toBeNull();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('carries the conversation forward across turns', async () => {
    fetchMock.mockResolvedValue(textReply('Thanks, Wayne.'));
    const brain = await createClaudeBrain({ callId: 'c6' });
    await brain!.respond('I need a refill');
    await brain!.respond("Yeah. It's Wayne Fabian.");
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    // Turn two sees turn one — the whole call, not one sentence.
    expect(second.messages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(second.messages)).toContain('I need a refill');
  });
});
