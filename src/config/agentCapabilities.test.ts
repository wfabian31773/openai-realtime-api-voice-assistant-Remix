/**
 * THE REGISTRY MUST NOT BE ABLE TO LIE.
 *
 * Operator, 2026-08-15: *"do the refactor, capability based not slug lists."*
 *
 * Replacing four scattered slug lists with one registry is only an improvement
 * if the registry is TRUE. A capability table that can drift from the code is
 * just a fifth list — and a more dangerous one, because everything now trusts
 * it.
 *
 * So these tests read the agent sources. `canTransfer: true` must be backed by
 * the named tool actually existing in that agent's module, and `canTransfer:
 * false` must be backed by no transfer tool existing at all. That check is
 * exactly what would have caught my 08-13 error, when I put `no-ivr` — the one
 * agent in the fleet that CAN transfer — into a no-transfer set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  AGENT_CAPABILITIES,
  capabilitiesOf,
  canTransfer,
  filesTickets,
  isTicketOnly,
} from './agentCapabilities';

/** slug → agent module, for the slugs whose source we can check directly. */
const AGENT_SOURCE: Record<string, string> = {
  'answering-service': 'answeringServiceAgent',
  'after-hours': 'afterHoursAgent',
  tech: 'techAgent',
  surgery: 'surgeryAgent',
  optical: 'opticalAgent',
  records: 'recordsAgent',
  'no-ivr': 'noIvrAgent',
  'dev-no-ivr': 'noIvrAgentV2',
  'no-ivr-v2': 'noIvrAgentV2',
  pcp: 'pcpAgent',
  'azul-scheduling': 'azulSchedulingAgent',
  'appointment-confirmation': 'appointmentConfirmationAgent',
};

/** Every model-callable transfer tool in the fleet. */
const TRANSFER_TOOLS = ['escalate_to_human', 'handoff_to_pcp', 'sage_handoff'];

const sourceFor = (slug: string): string | null => {
  const mod = AGENT_SOURCE[slug];
  if (!mod) return null;
  const path = new URL(`../agents/${mod}.ts`, import.meta.url);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

/**
 * Does this source expose the tool to the MODEL?
 *
 * `name: "escalate_to_human"` in a tool definition — not a mention in a comment
 * and not an import. The distinction matters: techAgent contains the string
 * `_handoffToHuman` as a deliberate `undefined` no-op placeholder, and
 * answeringServiceAgent declares a `handoffToHuman` PARAMETER it never invokes.
 * A naive substring search calls both of those agents transfer-capable, and
 * both would be wrong.
 */
const exposesTool = (src: string, tool: string) =>
  new RegExp(`name:\\s*["'\`]${tool}["'\`]`).test(src);

describe('the registry matches the code', () => {
  for (const [slug, cap] of Object.entries(AGENT_CAPABILITIES)) {
    it(`${slug}: canTransfer=${cap.canTransfer} is backed by the source`, () => {
      const src = sourceFor(slug);
      if (!src) return; // slug with no single owning module; covered elsewhere

      if (cap.canTransfer) {
        expect(cap.transferTool, `${slug} claims canTransfer but names no tool`).toBeTruthy();
        expect(
          exposesTool(src, cap.transferTool!),
          `${slug} declares canTransfer via ${cap.transferTool}, but that tool is not defined in ${AGENT_SOURCE[slug]}.ts`,
        ).toBe(true);
      } else {
        expect(cap.transferTool, `${slug} cannot transfer, so transferTool must be null`).toBeNull();
        for (const tool of TRANSFER_TOOLS) {
          expect(
            exposesTool(src, tool),
            `${slug} is declared no-transfer but ${AGENT_SOURCE[slug]}.ts defines ${tool}`,
          ).toBe(false);
        }
      }
    });
  }

  it('no-ivr is transfer-capable — the error this whole file exists to prevent', () => {
    /**
     * I put `no-ivr` in a no-transfer set on 08-13, assuming the after-hours
     * line only takes messages. It is the practice's real after-hours triage
     * agent and holds the ONLY transfer tool in the fleet. The cost was a blind
     * spot on the behaviour the operator cares most about: a hospital ringing
     * about a patient, getting a ticket instead of a transfer, scoring 1.0.
     */
    expect(canTransfer('no-ivr')).toBe(true);
    expect(isTicketOnly('no-ivr')).toBe(false);
  });

  it('the department queues are ticket-only', () => {
    for (const slug of ['tech', 'surgery', 'optical', 'records', 'answering-service']) {
      expect(canTransfer(slug), `${slug} must not be able to transfer`).toBe(false);
      expect(isTicketOnly(slug), `${slug} must be ticket-only`).toBe(true);
    }
  });
});

describe('an unknown agent fails safe', () => {
  /**
   * The direction matters. Assuming a strange slug CANNOT transfer means the
   * worst case is taking a message when we could have connected someone.
   * Assuming it CAN means promising a caller a person we cannot reach — the
   * more expensive mistake on a medical line.
   */
  it('assumes no transfer', () => {
    expect(canTransfer('some-new-queue')).toBe(false);
    expect(canTransfer(undefined)).toBe(false);
    expect(canTransfer(null)).toBe(false);
    expect(canTransfer('')).toBe(false);
  });

  it('assumes it DOES file tickets, so call data is never withheld', () => {
    expect(filesTickets('some-new-queue')).toBe(true);
    expect(isTicketOnly('some-new-queue')).toBe(true);
  });

  it('never throws — this sits in the live call path', () => {
    expect(() => capabilitiesOf('¯\\_(ツ)_/¯')).not.toThrow();
    expect(() => capabilitiesOf(null)).not.toThrow();
  });
});

describe('nothing keeps its own copy of these lists any more', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('the loop guard asks the registry', () => {
    const src = read('../services/conversationLoopGuard.ts');
    expect(src).toMatch(/canTransfer\(agentSlug\)/);
    expect(src, 'loop guard still declares a local slug list').not.toMatch(/const NO_TRANSFER_AGENTS/);
  });

  it('the grader asks the registry', () => {
    const src = read('../services/callGradingService.ts');
    expect(src).toMatch(/!canTransfer\(input\.agentSlug\)/);
    expect(src).toMatch(/isTicketOnly\(input\.agentSlug\)/);
    expect(src, 'grader still declares a local slug list').not.toMatch(/const NO_TRANSFER_AGENTS|const TICKET_ONLY_AGENTS/);
  });

  it('the post-call enrichment asks the registry, at both sites', () => {
    const src = read('../voiceAgentRoutes.ts');
    const uses = src.match(/filesTickets\(agentSlug\)/g) ?? [];
    expect(uses.length, 'both enrichment sites must ask the registry').toBe(2);
    expect(src, 'routes still declares a local slug list').not.toMatch(/const TICKET_FILING_AGENTS/);
  });

  it('the director resolves its script by capability, not by membership', () => {
    /**
     * The tables there hold per-agent WORDING, which is genuinely per-agent.
     * What must not be per-agent is the CHOICE OF SHAPE — a ticket-only line
     * must never fall through to a default that says "hand off with
     * sage_handoff" and promises the caller a person.
     */
    const src = read('../director/director.ts');
    expect(src).toMatch(/isTicketOnly\(agentSlug\)\s*\?\s*TICKET_ONLY_CEILING/);
    expect(src).toMatch(/isTicketOnly\(agentSlug\)\s*\?\s*TICKET_ONLY_EXIT_LINE/);
    // And the per-slug entries that the fallback replaced are gone, so a new
    // ticket-only queue is correct on the day it is created.
    expect(src).not.toMatch(/\btech: TICKET_ONLY_CEILING/);
  });
});
