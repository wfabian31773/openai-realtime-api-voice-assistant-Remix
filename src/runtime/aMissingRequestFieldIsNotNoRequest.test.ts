/**
 * v276, review of #526: the production asker parses the model's JSON. Only an
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

describe('v276: the production asker reads only an explicit null as no request', () => {
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
});
