/**
 * THE PROMPT ENDPOINT THAT ACCEPTS AN EDIT AND CHANGES NOTHING.
 *
 * `PUT /api/agent-prompts/:slug` wrote greeting / personality /
 * customInstructions / closingScript into `agent_prompts`, returned 200 with
 * the saved row, and recorded a version history entry. Nothing on the call
 * path has ever read that table: the only importers of `agentPrompts` are
 * `server/storage.ts` and this API. `src/` — every agent, every greeting
 * resolver, the whole live pipeline — does not mention it.
 *
 * WHAT IS ACTUALLY LIVE, so an operator has somewhere to go:
 *
 *   - The GREETING comes from `agents.welcome_greeting` when that column is
 *     set, via `src/services/greetingResolver.ts`. It outranks the greeting in
 *     code. That is how the no-IVR recording disclosure went missing without
 *     anyone editing code.
 *   - Everything else — personality, instructions, closing — is in the agent
 *     module in `src/agents/`, and changing it is a deploy.
 *
 * A CORRECTION TO THE RECORD, because I wrote the opposite in the survey and
 * it would have sent someone hunting: this endpoint does NOT explain "I fixed
 * this before and it came back". `agent_prompts` is EMPTY — zero rows, checked
 * 2026-09-01 — and no page in `client/src` calls the endpoint. Nobody has ever
 * lost an edit here, because nobody has ever made one. It is a loaded gun on
 * the table rather than a shot already fired.
 *
 * So this refuses instead of writing. A 200 that does nothing is worse than a
 * 501 that says why: the write it used to perform was unreachable by the call
 * path and unread by any UI, so refusing cannot break a workflow that exists.
 * If the table is ever wired to the live path, delete this and let the write
 * through.
 */
export interface DeadSurfaceResponse {
  message: string;
  liveOnCalls: false;
  writeSurface: 'agent_prompts (not read by the call path)';
  where: {
    greeting: string;
    everythingElse: string;
  };
}

export function agentPromptWriteRefusal(slug: string): DeadSurfaceResponse {
  return {
    message:
      `Refused: editing agent_prompts does not change what agent "${slug}" says on a call. ` +
      'Nothing on the call path reads this table, so a success here would be a lie.',
    liveOnCalls: false,
    writeSurface: 'agent_prompts (not read by the call path)',
    where: {
      greeting:
        'agents.welcome_greeting for this slug — read live by src/services/greetingResolver.ts, ' +
        'and it outranks the greeting in code.',
      everythingElse:
        'the agent module in src/agents/ — personality, instructions and closing are code, ' +
        'so changing them is a deploy.',
    },
  };
}

/** 501: the endpoint is implemented, the effect it advertises is not. */
export const AGENT_PROMPT_WRITE_STATUS = 501;
