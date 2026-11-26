/**
 * v277 (review of #526, round 2): the production asker parses the model's JSON. Only an
 * explicit `"request": null` is the model saying the caller asked nothing; a
 * missing or mistyped field is an answer we cannot read, so the after-hours
 * floor must take it as the reader failing and never as "no request".
 *
 * The OpenAI client is faked; every transcript here is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replies: string[] = [];

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({ choices: [{ message: { content: replies.shift() ?? '' } }] }),
      },
    };
  },
}));

process.env.OPENAI_API_KEY = 'test-key-not-real';

const { askModelForTheRequest, readTheRequest } = await import('./requestFromTheRecording');

const TRANSCRIPT = 'AGENT: How can I help?\nCALLER: Synthetic request words.';

describe('v277: the production asker reads only an explicit null as no request', () => {
  beforeEach(() => {
    replies.length = 0;
    delete process.env.REQUEST_FROM_RECORDING_DISABLED;
  });

  it('a string request is the request', async () => {
    replies.push(JSON.stringify({ request: 'Wants to move an eye appointment.' }));
    expect(await askModelForTheRequest(TRANSCRIPT)).toEqual({ request: 'Wants to move an eye appointment.' });
  });

  it('an explicit null is the model saying nothing was asked', async () => {
    replies.push(JSON.stringify({ request: null }));
    expect(await askModelForTheRequest(TRANSCRIPT)).toEqual({ request: null });
  });

  for (const [label, body] of [
    ['no request field', '{}'],
    ['a number', JSON.stringify({ request: 5 })],
    ['a boolean', JSON.stringify({ request: true })],
    ['an object', JSON.stringify({ request: { text: 'x' } })],
    ['the field misspelt', JSON.stringify({ requests: 'Wants a refill.' })],
  ] as const) {
    it(`${label} is no answer from the asker`, async () => {
      replies.push(body);
      expect(await askModelForTheRequest(TRANSCRIPT)).toBeNull();
    });

    it(`${label} reaches the floor's reader as unavailable, never as none`, async () => {
      replies.push(body);
      const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, []);
      expect(reading.kind).toBe('unavailable');
    });
  }

  it('an explicit null reaches the reader as none', async () => {
    replies.push(JSON.stringify({ request: null }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, []);
    expect(reading.kind).toBe('none');
  });

  it('a blank sentence reaches the reader as unavailable, never as none (review of #526)', async () => {
    replies.push(JSON.stringify({ request: '   ' }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, []);
    expect(reading.kind).toBe('unavailable');
  });

  for (const text of ['...', '!?', '--', '…', '12345']) {
    it(`a first answer of only "${text}" reaches the reader as unavailable, never as none (review of #532)`, async () => {
      replies.push(JSON.stringify({ request: text }));
      const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, []);
      expect(reading.kind).toBe('unavailable');
    });
  }

});

describe('v277: the second answer decides what the reader reads (review of #526)', () => {
  beforeEach(() => {
    replies.length = 0;
    delete process.env.REQUEST_FROM_RECORDING_DISABLED;
  });

  it('a second answer that names no topic is none', async () => {
    replies.push(JSON.stringify({ request: 'Wants to speak with Mara Quill.' }));
    replies.push(JSON.stringify({ request: 'Wants to speak with someone.' }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
    expect(reading.kind).toBe('none');
  });

  it('a second answer with an explicit null is none', async () => {
    replies.push(JSON.stringify({ request: 'Wants Mara Quill to call.' }));
    replies.push(JSON.stringify({ request: null }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
    expect(reading.kind).toBe('none');
  });

  it('a second answer that fails a content check too is still a request, with no sentence', async () => {
    replies.push(JSON.stringify({ request: 'Mara Quill wants a refill.' }));
    replies.push(JSON.stringify({ request: 'Mara wants a refill of drops.' }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
    expect(reading).toEqual({ kind: 'request' });
  });

  it('a second answer that is clean is the request, with its sentence', async () => {
    replies.push(JSON.stringify({ request: 'Mara Quill wants a refill of her drops.' }));
    replies.push(JSON.stringify({ request: 'Wants a refill of eye drops.' }));
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
    expect(reading).toEqual({ kind: 'request', sentence: 'Wants a refill of eye drops.' });
  });

  for (const text of ['...', '!?', '--', '12345']) {
    it(`a second answer of only "${text}" is still a request, never a retraction (review of #532)`, async () => {
      replies.push(JSON.stringify({ request: 'Mara Quill wants a refill.' }));
      replies.push(JSON.stringify({ request: text }));
      const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
      expect(reading).toEqual({ kind: 'request' });
    });
  }

  it('a second answer the model failed to give is still a request (the first had a topic)', async () => {
    replies.push(JSON.stringify({ request: 'Mara Quill wants a refill.' }));
    replies.push('{}');
    const reading = await readTheRequest(TRANSCRIPT, askModelForTheRequest, ['Mara', 'Quill']);
    expect(reading).toEqual({ kind: 'request' });
  });
});
