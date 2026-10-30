/**
 * PCP NEVER SAYS A WAITING LINE WITH NOTHING TO WAIT FOR — v151.
 *
 * The prompt told the model: "If you have been quiet for more than a few
 * seconds for any reason, say 'Still with you — one moment.'" The model said
 * it in place of acting. On 2026-10-29 it was the agent's last line on 7 PCP
 * calls, 4 of them with no ticket: CA066d1483875fdc58b760ddcb4b447f58,
 * CA2bb4de0d901405fa60cc95f6bc8ea578, CA6f22688980fafd85a463d9250fc62a92,
 * CA9b039511066658d903c86ec5a0a0b095 (39 to 80 seconds of silence after the
 * caller gave their name). Before v131 the silence ladder broke that silence;
 * now the runtime asks the agent to carry on (silenceLadder.test.ts), and the
 * prompt no longer asks for the line at all.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildPcpPrompt } from './pcpAgent';

describe('the PCP prompt and waiting lines', () => {
  const prompt = buildPcpPrompt({ callerPhone: '+17605551234' } as never);

  it('does not tell the model to say a holding line because it has been quiet', () => {
    expect(prompt).not.toMatch(/Still with you/i);
    expect(prompt).not.toMatch(/quiet for\s+more than a few seconds/i);
  });

  it('ties every waiting line to the tool call it is waiting for', () => {
    expect(prompt).toMatch(/never say a waiting\s+line without the tool call that it is waiting for/i);
    // The line-then-tool table survives.
    expect(prompt).toMatch(/Let me get this logged for you — one moment\./);
  });
});
