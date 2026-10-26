/**
 * A 200 that changes nothing is worse than a 501 that says why.
 *
 * `PUT /api/agent-prompts/:slug` wrote to `agent_prompts` and answered 200
 * with the saved row. The only importers of that table are `server/storage.ts`
 * and the API itself — `src/`, which is every agent and the entire call path,
 * does not mention it. So the write succeeded, the version history recorded it,
 * and the live agent said exactly what it said before.
 *
 * Checked before changing it, and it corrects something I wrote in the survey:
 * `agent_prompts` is EMPTY, and no page in `client/src` calls the endpoint. So
 * this never silently lost anyone's edit — it was waiting to.
 */
import { describe, it, expect } from 'vitest';
import { agentPromptWriteRefusal, AGENT_PROMPT_WRITE_STATUS } from './agentPromptSurface';

describe('the refusal has to send the operator somewhere real', () => {
  const body = agentPromptWriteRefusal('no-ivr');

  it('does not imply the edit landed', () => {
    expect(AGENT_PROMPT_WRITE_STATUS).toBe(501);
    expect(body.liveOnCalls).toBe(false);
    expect(body.message).toMatch(/does not change what agent "no-ivr" says/i);
  });

  it('names the surface that IS live for the greeting', () => {
    // The one that outranks the code, and the one that took the no-IVR
    // recording disclosure off the line without a code change.
    expect(body.where.greeting).toMatch(/agents\.welcome_greeting/);
    expect(body.where.greeting).toMatch(/greetingResolver/);
  });

  it('says plainly that the rest is code, so nobody hunts for a second table', () => {
    expect(body.where.everythingElse).toMatch(/src\/agents/);
    expect(body.where.everythingElse).toMatch(/deploy/i);
  });
});
