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

import { createClaudeBrain, splitForSpeech, repairHistory } from './claudeBrain';

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

/**
 * Live call 2026-08-11 00:15. A turn came back with
 *   400 messages.20: `tool_use` ids were found without `tool_result` blocks
 * and the caller sat in silence for 31 seconds. The API rejects the WHOLE
 * history, not the bad turn, so once one turn leaves the conversation
 * malformed every later turn of that call is dead too.
 */
describe('one bad turn must not kill the call', () => {
  const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string);

  it('rewinds a failed turn so the next one starts from clean history', async () => {
    const brain = await createClaudeBrain({ callId: 'c-rewind' });
    fetchMock.mockResolvedValueOnce(textReply('Thank you for calling.'));
    await brain!.respond('hello');

    // A turn that blows up mid-flight.
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    const bad = await brain!.respond('I need my records faxed');
    expect(bad.error).toBeTruthy();

    fetchMock.mockResolvedValueOnce(textReply('Of course.'));
    await brain!.respond('are you still there?');

    const sent = bodyOf(2).messages;
    // The turn that failed left nothing behind — not its user message, and
    // certainly not half a tool exchange.
    expect(JSON.stringify(sent)).not.toContain('records faxed');
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'are you still there?' });
  });

  it('never sends a tool_use without the tool_result that answers it', async () => {
    const brain = await createClaudeBrain({ callId: 'c-pairs' });
    fetchMock
      .mockResolvedValueOnce(toolReply('lookup_schedule', { first_name: 'Wayne' }))
      .mockResolvedValueOnce(textReply('Your last visit was July 13th.'));
    await brain!.respond('when was my last appointment?');

    const sent = bodyOf(1).messages;
    for (let i = 0; i < sent.length; i++) {
      const uses = (Array.isArray(sent[i].content) ? sent[i].content : []).filter(
        (c: { type: string }) => c.type === 'tool_use',
      );
      if (!uses.length) continue;
      const answers = (Array.isArray(sent[i + 1]?.content) ? sent[i + 1].content : []).filter(
        (c: { type: string }) => c.type === 'tool_result',
      );
      expect(answers.map((a: { tool_use_id: string }) => a.tool_use_id).sort()).toEqual(
        uses.map((u: { id: string }) => u.id).sort(),
      );
    }
  });

  it('repairs a history that is already malformed instead of 400ing on it', () => {
    // Exactly the shape the live call died on: a tool_use with nothing
    // answering it, followed by more conversation.
    const broken = [
      { role: 'user', content: 'when was my last appointment?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_orphan', name: 'lookup_schedule', input: {} }],
      },
      { role: 'user', content: 'hello? are you there?' },
    ] as Parameters<typeof repairHistory>[0];

    expect(repairHistory(broken)).toBe(1);

    const answers = (broken[2].content as Array<{ type: string; tool_use_id?: string }>).filter(
      (c) => c.type === 'tool_result',
    );
    expect(answers).toHaveLength(1);
    expect(answers[0].tool_use_id).toBe('toolu_orphan');
    // Folded into the message immediately after the tool_use — anywhere else
    // is still a 400, and a message of its own would leave two user messages
    // back to back.
    expect(broken).toHaveLength(3);
    expect((broken[2].content as Array<{ type: string }>)[0].type).toBe('tool_result');
    // The caller's words are not thrown away to make room for the repair.
    expect(JSON.stringify(broken[2].content)).toContain('are you there?');
  });

  it('leaves a well-formed history alone', () => {
    const fine = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup_schedule', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{}' }] },
    ] as Parameters<typeof repairHistory>[0];
    const before = JSON.stringify(fine);
    expect(repairHistory(fine)).toBe(0);
    expect(JSON.stringify(fine)).toBe(before);
  });

  it('gives the caller words rather than silence when the loop runs long', async () => {
    const brain = await createClaudeBrain({ callId: 'c-rounds' });
    // Every round wants another tool. The last round is asked for words, so
    // this must still end in something the caller can hear.
    fetchMock.mockResolvedValue(toolReply('lookup_schedule', { first_name: 'Wayne' }));
    const spoken: string[] = [];
    const turn = await brain!.respond('when was my last appointment?', (s) => spoken.push(s));

    // tool_choice: none on the final round — the model is told it cannot ask
    // for another tool.
    const last = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body as string);
    expect(last.tool_choice).toEqual({ type: 'none' });
    expect(turn.ms).toBeLessThan(20_000);
  });
});

describe('speaking before the answer is finished', () => {
  it('splits on sentence ends so the first clause can go out early', () => {
    expect(splitForSpeech('Thanks, Wayne. And your date of birth? I can look it up.')).toEqual([
      'Thanks, Wayne.',
      'And your date of birth?',
      'I can look it up.',
    ]);
  });

  // Live call 00:37. The model wrote for a screen: "**Wednesday, December 30,
  // 2026 at 8:00 AM** with **Dr. Dwayne Logan**". Asterisks are not sound, and
  // "**Dr." is not preceded by whitespace, so the title guard missed it and
  // the name was cut in half a second time.
  it('never sends markdown to the mouth', () => {
    expect(splitForSpeech('Your visit was **Wednesday** at **8:00 AM**.')).toEqual([
      'Your visit was Wednesday at 8:00 AM.',
    ]);
    expect(splitForSpeech('See `lookup` and _the_ notes.').join(' ')).not.toMatch(/[*_`]/);
  });

  it('keeps a bolded title attached to the name inside the same bold run', () => {
    expect(
      splitForSpeech('That was with **Dr. Dwayne Logan** at **Loma Linda Surgery Center LLC**.'),
    ).toEqual(['That was with Dr. Dwayne Logan at Loma Linda Surgery Center LLC.']);
  });

  it('speaks a link as its words, not its url', () => {
    expect(splitForSpeech('Visit [our site](https://azulvision.com) for details.')).toEqual([
      'Visit our site for details.',
    ]);
  });

  it('does not split a date or an abbreviation into pieces', () => {
    expect(splitForSpeech('Your last visit was 03/17/1973 at our Redlands office.')).toHaveLength(1);
  });

  // The first live call really did say "…at 8:00 AM with Dr." and then, as a
  // separate utterance, "Dwayne Logan at Loma Linda Surgery Center LLC."
  it('keeps a title attached to the name that follows it', () => {
    expect(
      splitForSpeech('Your last appointment was on Wednesday at 8:00 AM with Dr. Dwayne Logan.'),
    ).toEqual(['Your last appointment was on Wednesday at 8:00 AM with Dr. Dwayne Logan.']);
  });

  it('keeps an initial attached to the surname that follows it', () => {
    expect(splitForSpeech('You saw Dr. J. Tran last time. Would you like to see them again?')).toEqual([
      'You saw Dr. J. Tran last time.',
      'Would you like to see them again?',
    ]);
  });

  it('still splits a real sentence end that follows a title', () => {
    expect(splitForSpeech('That was with Dr. Logan. Anything else today?')).toEqual([
      'That was with Dr. Logan.',
      'Anything else today?',
    ]);
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
