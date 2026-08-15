/**
 * WHAT THE ANSWERING SERVICE HAS THAT THE SINGLE AGENTS DID NOT.
 *
 * Operator, 2026-08-15: *"You did not create the answering service — that is
 * what we are trying to break down into single agents. So something in the
 * answering service works but when you built individual agents, it stopped
 * working."*
 *
 * He was right, and the audit found the shape of it: the fleet gates behaviour
 * on agent slug in a dozen scattered literal lists, every one of them written
 * when the answering service was the only tenant. Splitting it into department
 * queues meant each list had to be revisited, and several never were.
 *
 * These tests exist so membership is asserted rather than remembered. Each one
 * is a list that was wrong on 2026-08-15.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

/** The four queues split out of the answering service. */
const DEPARTMENT_LINES = ['tech', 'surgery', 'optical', 'records'] as const;

describe('a line that cannot transfer owes the truth on the FIRST ask', () => {
  it('caps human requests at 1 for every ticket-only line, not just answering-service', async () => {
    const { humanRequestCapFor, HUMAN_REQUEST_CAP_NO_TRANSFER, HUMAN_REQUEST_CAP } =
      await import('./conversationLoopGuard');

    expect(humanRequestCapFor('answering-service')).toBe(HUMAN_REQUEST_CAP_NO_TRANSFER);
    for (const slug of DEPARTMENT_LINES) {
      expect(
        humanRequestCapFor(slug),
        `${slug} cannot transfer — its callers should not have to ask twice`,
      ).toBe(HUMAN_REQUEST_CAP_NO_TRANSFER);
    }

    /**
     * no-ivr is the real after-hours triage line and it DOES transfer — for a
     * provider, a hospital, or a true emergency. It must keep the ordinary cap.
     */
    expect(humanRequestCapFor('no-ivr')).toBe(HUMAN_REQUEST_CAP);
  });
});

describe('the director never tells an agent to use a tool it does not have', () => {
  /**
   * The department lines were falling through to the `default` ceiling action,
   * which says "hand off with sage_handoff". None of them has sage_handoff or
   * any transfer tool, and the matching exit line promised the caller "someone
   * who can help directly" — exactly what human_request_deflection grades as a
   * CRITICAL failure on a ticket-only line. The safety net would have caused
   * the injury.
   */
  it('gives every ticket-only line a file-the-ticket ceiling, not a handoff', async () => {
    // CEILING_ACTION is module-private, so this asserts on the source: the
    // shared ticket-only entry must not name a transfer tool, and each
    // department slug must be explicitly bound to it rather than falling
    // through to `default`.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../director/director.ts', import.meta.url), 'utf8'),
    );
    const ceilingBlock = src.slice(src.indexOf('const TICKET_ONLY_CEILING'), src.indexOf('const CEILING_ACTION'));
    expect(ceilingBlock).not.toMatch(/sage_handoff/);
    expect(ceilingBlock).toMatch(/cannot|do NOT offer to transfer/i);

    for (const slug of DEPARTMENT_LINES) {
      expect(src, `${slug} must have an explicit ceiling action`).toMatch(
        new RegExp(`\\b${slug}: TICKET_ONLY_CEILING`),
      );
      expect(src, `${slug} must have an explicit exit line`).toMatch(
        new RegExp(`\\b${slug}: TICKET_ONLY_EXIT_LINE`),
      );
    }
  });

  it('the ticket-only exit line does not promise a person', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../director/director.ts', import.meta.url), 'utf8'),
    );
    const line = src.match(/const TICKET_ONLY_EXIT_LINE\s*=\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
    expect(line, 'exit line not found').toBeTruthy();
    expect(line).not.toMatch(/get you to someone|connect you|transfer/i);
    expect(line).toMatch(/calls? you back/i);
  });
});

describe('the grader knows which lines can transfer and which cannot', () => {
  it('protects the department lines running the busy-team script', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./callGradingService.ts', import.meta.url), 'utf8'),
    );
    const block = src.slice(src.indexOf('const TICKET_ONLY_AGENTS'), src.indexOf('const TICKET_ONLY_AGENTS') + 300);
    for (const slug of DEPARTMENT_LINES) {
      expect(block, `${slug} missing from TICKET_ONLY_AGENTS`).toContain(`'${slug}'`);
    }
    // And no-ivr must NOT be there — it transfers, and grading a legitimate
    // transfer promise as a critical failure punishes correct behaviour.
    expect(block).not.toContain("'no-ivr'");
  });

  it('keeps no-ivr out of the no-transfer set too', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./callGradingService.ts', import.meta.url), 'utf8'),
    );
    const block = src.slice(src.indexOf('const NO_TRANSFER_AGENTS'), src.indexOf('const NO_TRANSFER_AGENTS') + 220);
    expect(block).not.toContain("'no-ivr'");
    expect(block).toContain("'answering-service'");
  });
});

describe('every ticket-filing line gets its call data attached at hangup', () => {
  it('includes the department queues in the immediate enrichment push', async () => {
    /**
     * Both enrichment sites listed five slugs inline and neither included the
     * department queues, so their tickets only got call data on a later sweep
     * cycle. Not lost — ticketingSyncService has no slug filter — but late, on
     * lines that already wait 120s to finalize.
     */
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8'),
    );
    const block = src.slice(src.indexOf('const TICKET_FILING_AGENTS'), src.indexOf('const TICKET_FILING_AGENTS') + 400);
    for (const slug of [...DEPARTMENT_LINES, 'answering-service', 'no-ivr', 'pcp', 'azul-scheduling', 'after-hours']) {
      expect(block, `${slug} missing from TICKET_FILING_AGENTS`).toContain(`'${slug}'`);
    }
    // One named set, used at both sites — the duplication is what let them drift.
    const uses = src.match(/TICKET_FILING_AGENTS\.has/g) ?? [];
    expect(uses.length, 'both enrichment sites must use the shared set').toBe(2);
  });
});
