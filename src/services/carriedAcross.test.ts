/**
 * WHAT THE ANSWERING SERVICE HAS THAT THE SINGLE AGENTS DID NOT.
 *
 * Operator, 2026-08-15: *"You did not create the answering service — that is
 * what we are trying to break down into single agents. So something in the
 * answering service works but when you built individual agents, it stopped
 * working."*
 *
 * He was right, and the audit found the shape of it: the fleet gated behaviour
 * on agent slug in four scattered literal lists, every one written when the
 * answering service was the only tenant. Splitting it into department queues
 * meant each list had to be revisited by hand. Several never were, and the ones
 * that were, I got wrong.
 *
 * Those lists are now gone — `config/agentCapabilities.ts` owns the answer and
 * `agentCapabilities.test.ts` proves the registry matches the agent sources.
 * What stays HERE is the other half: that each consumer, given the registry's
 * answer, then does the right thing with it. Each case below is a real defect
 * from 2026-08-15.
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

  it('a queue nobody has registered yet still gets the honest answer first', async () => {
    // The payoff of resolving by capability: a new department line is correct
    // on the day it is created, with nothing added anywhere.
    const { humanRequestCapFor, HUMAN_REQUEST_CAP_NO_TRANSFER } = await import('./conversationLoopGuard');
    expect(humanRequestCapFor('glaucoma-clinic')).toBe(HUMAN_REQUEST_CAP_NO_TRANSFER);
  });
});

describe('the grader reads escalation language against what the line can DO', () => {
  const grade = async (agentSlug: string, over: Record<string, unknown> = {}) => {
    const { callGradingService } = await import('./callGradingService');
    const results = callGradingService.runDeterministicGraders({
      callLogId: 'test', transcript: 'AGENT: Thanks for calling.\nCALLER: Can you transfer me to someone?',
      transferredToHuman: false, ticketNumber: 'VA-1', agentSlug, totalTurns: 6,
      interruptionCount: 0, truncationCount: 0, toolCallCount: 2, durationSeconds: 120,
      firstTranscriptDelayMs: 800, postTranscriptTailMs: 0, localDurationSeconds: 120,
      transcriptWindowSeconds: 120, durationMismatchRatio: null, durationMismatchFlag: false,
      ...over,
    } as never);
    return (results as Array<{ grader: string; pass: boolean; reason: string }>);
  };

  it('a department line that filed a ticket has met its whole obligation', async () => {
    for (const slug of DEPARTMENT_LINES) {
      const g = (await grade(slug)).find((x) => x.grader === 'handoff_expected_vs_actual')!;
      expect(g.pass, `${slug}: ${g.reason}`).toBe(true);
      expect(g.reason).toMatch(/no-transfer line/);
    }
  });

  it('a department line that filed NOTHING still fails — the caller left with nothing', async () => {
    // The check has to keep biting. This is the 38 real no-ticket escalations.
    const g = (await grade('tech', { ticketNumber: null })).find(
      (x) => x.grader === 'handoff_expected_vs_actual',
    )!;
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/NO ticket filed/);
  });

  it('does NOT excuse no-ivr, which can actually transfer', async () => {
    /**
     * The error I made on 08-13. With no-ivr treated as a no-transfer line, a
     * hospital ringing about a patient and getting a ticket instead of a
     * transfer scored 1.0 — "the whole obligation for this agent". On this line
     * it is not.
     */
    const g = (await grade('no-ivr')).find((x) => x.grader === 'handoff_expected_vs_actual')!;
    expect(g.reason).not.toMatch(/no-transfer line/);
    expect(g.pass, 'a transfer was asked for on a line that can transfer, and did not happen').toBe(false);
  });
});

describe('the director never hands a ticket-only line a transfer script', () => {
  /**
   * The department lines used to fall through to the `default` ceiling action,
   * which says "hand off with sage_handoff" — a tool none of them has — and to
   * a default exit line promising "someone who can help directly", which is
   * precisely what human_request_deflection grades as a CRITICAL failure on a
   * ticket-only line. The safety net would have caused the injury.
   *
   * Latent rather than live: DIRECTOR_AGENTS is empty in production and the
   * timeline shows zero director actions on any agent. It would have bitten the
   * day the director was switched on.
   */
  const src = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../director/director.ts', import.meta.url), 'utf8'),
    );

  it('resolves the ceiling by capability, so a new queue is right on day one', async () => {
    const s = await src();
    expect(s).toMatch(/isTicketOnly\(agentSlug\)\s*\?\s*TICKET_ONLY_CEILING/);
    const block = s.slice(s.indexOf('const TICKET_ONLY_CEILING'), s.indexOf('const CEILING_ACTION'));
    expect(block, 'the ticket-only ceiling must not name a transfer tool').not.toMatch(/sage_handoff/);
  });

  it('the ticket-only exit line does not promise a person', async () => {
    const s = await src();
    const line = s.match(/const TICKET_ONLY_EXIT_LINE\s*=\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
    expect(line, 'exit line not found').toBeTruthy();
    expect(line).not.toMatch(/get you to someone|connect you|transfer/i);
    expect(line).toMatch(/calls? you back/i);
  });
});

describe('every ticket-filing line gets its call data attached at hangup', () => {
  it('asks the registry at both enrichment sites', async () => {
    /**
     * Both sites listed five slugs inline and neither included the department
     * queues, so their tickets only got recording/transcript/duration on a
     * later sweep cycle. Not lost — ticketingSyncService has no slug filter —
     * but late, on lines that already wait 120s to finalize.
     */
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8'),
    );
    const uses = src.match(/filesTickets\(agentSlug\)/g) ?? [];
    expect(uses.length, 'both enrichment sites must ask the registry').toBe(2);
  });

  it('covers the department queues and the transferring lines alike', async () => {
    const { filesTickets } = await import('../config/agentCapabilities');
    for (const slug of [...DEPARTMENT_LINES, 'answering-service', 'no-ivr', 'pcp', 'azul-scheduling', 'after-hours']) {
      expect(filesTickets(slug), `${slug} files tickets and needs its call data`).toBe(true);
    }
  });
});
