/**
 * A failed PCP handoff has to say where it dialled.
 *
 * THE MEASUREMENT THAT PROMPTED THIS, department 18 over the 90 days to
 * 2026-08-13:
 *
 *   handoffs requested   58
 *   attempted            57
 *   connected            11   — 19%
 *
 * Wayne took the PCP line off Twilio over exactly this: "I just cannot see the
 * disasters that I was seeing on Friday on that line." 46 professional callers
 * asked for a person, were told to hold, and got nobody.
 *
 * The question that decides whether the line can go back on is WHY, and it has
 * two very different answers:
 *
 *   the queue DID is not staffed        — an operations problem
 *   we dialled the retired agent roster — a config problem with a known fix
 *
 * The data cannot tell them apart, because `destination` was recorded on
 * success only. All 46 failures have pcp_handoff_destination NULL. The 11 that
 * DID record one all went to +17149564300, and 9 of those connected — which
 * hints at the second answer without proving it.
 *
 * These tests pin the reporting, not the dialling. They are about never being
 * unable to answer that question again.
 *
 * HONEST LIMITATION: these are SOURCE-SCANNING tests, which prove a line exists
 * rather than that it behaves — the trap written up in
 * `.agents/memory/measurement-traps.md`. They are that way because the code
 * under test lives inside a route handler that dials Twilio mid-function, and
 * `agentWiring.test.ts` already scans this same file for the same reason. Do
 * not read a green run here as proof that a real failed handoff writes a
 * destination. The proof is the next live PCP call that does not connect: its
 * ticket should carry pcp_handoff_destination, and until one does, this is
 * only evidence that the code says the right thing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = readFileSync(join(__dirname, '../voiceAgentRoutes.ts'), 'utf8');
const PCP_AGENT = readFileSync(join(__dirname, './pcpAgent.ts'), 'utf8');

describe('the handoff outcome can carry a destination when it fails', () => {
  it('the failure variant declares one in both type definitions', () => {
    // Two separate declarations of HandoffOutcome — the route's own and the
    // agent's. They are structurally matched by hand, so both have to change.
    expect(ROUTES).toMatch(/ok: false; status: string; reason: string; destination\?: string/);

    // Slice the agent's own HandoffOutcome rather than regexing across it —
    // the failure variant carries a long comment, and a bounded [\s\S]{0,600}
    // silently stopped matching when that comment grew.
    const start = PCP_AGENT.indexOf('type HandoffOutcome =');
    expect(start, 'HandoffOutcome has moved or been renamed').toBeGreaterThan(-1);
    const block = PCP_AGENT.slice(start, PCP_AGENT.indexOf('} | void;', start));
    expect(block).toMatch(/destination\?: string;/);
  });

  it('the no-answer return reports where it dialled', () => {
    // pcp_sequence_no_answer is 46 of the 57 attempts. This is the one that
    // matters most.
    const line = ROUTES.split('\n').find((l) => l.includes("reason: 'pcp_sequence_no_answer'"));
    expect(line, 'the no-answer return is gone or renamed').toBeTruthy();
    expect(line).toMatch(/destination: handoffDestination/);
  });

  it('every no-answer and dial-failure return reports one', () => {
    const shouldReport = ["reason: 'human_no_answer'", "reason: 'dial_failed'", "reason: 'pcp_sequence_no_answer'"];
    for (const marker of shouldReport) {
      const lines = ROUTES.split('\n').filter((l) => l.includes(marker) && l.includes('return {'));
      expect(lines.length, `no return found for ${marker}`).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l, `${marker} does not report a destination`).toMatch(/destination: handoffDestination/);
      }
    }
  });
});

describe('the sequential path records the number before it rings, not after', () => {
  it('assigns handoffDestination ahead of the dial', () => {
    // It used to be assigned only inside `if (outcome.ok)`, which is precisely
    // why a failure recorded nothing.
    const start = ROUTES.indexOf('const destination = pcpDialSequence[index];');
    expect(start, 'the sequential loop has moved').toBeGreaterThan(-1);
    const dialAt = ROUTES.indexOf('await transferConferenceToNumber(openAiCallId, destination', start);
    const assignAt = ROUTES.indexOf('handoffDestination = destination;', start);
    expect(assignAt).toBeGreaterThan(-1);
    expect(assignAt, 'the destination is still recorded after the dial').toBeLessThan(dialAt);
  });
});

describe('the ticket records it whether or not the call connected', () => {
  it('does not gate the destination on outcome.ok', () => {
    // The one-line cause of the whole blind spot:
    //   destination: outcome && outcome.ok ? outcome.destination : undefined
    expect(PCP_AGENT).not.toMatch(/destination: outcome && outcome\.ok \? outcome\.destination/);
    expect(PCP_AGENT).toMatch(/destination: outcome \? outcome\.destination : undefined/);
  });
});
