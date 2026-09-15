/**
 * A CALL NOBODY CLASSIFIED IS STILL A CALL SOMEBODY MADE.
 *
 * Operator, 2026-09-15, three questions and his own answer to them:
 *
 *   "are we capturing the transcripts for these calls? … if we're capturing
 *    the transcripts then why are we not reading the transcripts for the call
 *    purpose … actually now that I think about it, why don't we just leave it
 *    in the PCP queue and let the PCP agents route it manually to where it
 *    needs to go — rather safe than sorry rather than dump it into medical
 *    records and create a case unnecessarily."
 *
 * and, on the slug: *"anything we dont classify we log as a new slug."*
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT. PCP's first 2h23m on the current build, 2026-09-15: 32
 * real conversations that did not transfer, **18 with no ticket of ANY
 * provenance** (`created_by_id IS NULL AND agent_used IS NOT NULL`, canonical
 * SIDs, anchored on the call's own day).
 *
 * Every existing exit in `sweepPcpUnfiledCall` turned them away, and the gate
 * is why: `toldUsSomething` demands a `callPurpose` AND an identity field,
 * and on these calls the model never recorded a purpose at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THE TRANSCRIPT, DO NOT CLASSIFY FROM IT — and that is his third
 * sentence superseding his second, not a liberty taken with it.
 *
 * The caller's words go ON the ticket so a human can route it. The SLUG is
 * `unclassified_call`, which lands in PCP Support (department 18) where a
 * person already looks. A machine guess at the department would be the
 * `'surgery center'` mistake of 2026-09-08 with worse consequences: an
 * `mr_cases` row opened on a guess starts a statutory clock on a request
 * nobody has read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PHI: every transcript below is SYNTHETIC. The shapes are real and the
 * sentences are not, which is the pattern `replay20260914.test.ts`
 * established and what RULE THREE requires — real SIDs and failure shapes in
 * the repo, real words only on disk and in `call_logs`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const NOT_LUNCH = new Date('2026-09-15T17:00:00Z');
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOT_LUNCH);
});
afterAll(() => vi.useRealTimers());

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(
    async (_p?: unknown): Promise<{ success: boolean; ticketNumber?: string; error?: string }> => ({
      success: true,
      ticketNumber: 'PCP-59001',
    }),
  ),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall, markPcpCallEnded } = await import('../agents/pcpAgent');
const { PCP_CALL_PURPOSE_SLUGS } = await import('./policy');

let n = 0;

/**
 * A caller the model never classified. No `record_pcp_intake`, so
 * `state.callPurpose` is undefined — which is the shape of all 18.
 */
function unclassifiedCall(transcript: string) {
  const callId = `CAunclassified${++n}`;
  const agent = createPcpAgent((async () => ({ status: 'CONNECTED' })) as never, {
    callId,
    callSid: callId,
    callerPhone: '+16265550142',
    getTranscript: () => transcript,
  } as never);
  return { agent, callId };
}

async function sweep(callId: string) {
  markPcpCallEnded(callId);
  await sweepPcpUnfiledCall(callId);
}

const A_REQUEST = [
  'AGENT: Thank you for calling Azul Vision PCP Support.',
  "CALLER: I need to check on a referral that was sent over last week.",
  'AGENT: May I have your name?',
  'CALLER: It is about the authorization, nobody has called us back.',
].join('\n');

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({
    success: true,
    ticketNumber: 'PCP-59001',
  }));
});

describe('the 18 that filed nowhere', () => {
  it('files a caller the model never classified', async () => {
    const { callId } = unclassifiedCall(A_REQUEST);

    await sweep(callId);

    expect(
      ticketing.createPcpTicket,
      'no purpose recorded is why all 18 were skipped — the caller still rang',
    ).toHaveBeenCalledTimes(1);
  });

  it('files it as unclassified_call, for a person to route', async () => {
    const { callId } = unclassifiedCall(A_REQUEST);

    await sweep(callId);

    const payload = ticketing.createPcpTicket.mock.calls[0][0] as any;
    expect(payload.callPurpose).toBe('unclassified_call');
    /**
     * CREATE_TASK, never HAND_OFF. We could not establish what the call was
     * about, so we certainly cannot establish it came from an entity who
     * asked for a person — the 2026-09-04 transfer rule.
     */
    expect(payload.disposition).toBe('CREATE_TASK');
  });

  /**
   * NOT MEDICAL RECORDS, NOT THE HVA HUB. This is the operator's ruling in
   * its own words, and the reason it is a test rather than a comment:
   * `unclassified_call` resolves to `General / Other` -> `Other - See
   * Description` in department 18 on the app side, and the slug is the only
   * thing this repo controls about where it lands.
   */
  it('never routes an unclassified call to a specialist queue by guessing', async () => {
    const { callId } = unclassifiedCall(
      // Contains a records cue AND a surgery cue. A classifier would bite.
      [
        'AGENT: Thank you for calling Azul Vision PCP Support.',
        'CALLER: I am calling from the surgery center about medical records.',
      ].join('\n'),
    );

    await sweep(callId);

    const payload = ticketing.createPcpTicket.mock.calls[0][0] as any;
    expect(
      payload.callPurpose,
      'reading the transcript for ROUTING is the mistake the operator declined',
    ).toBe('unclassified_call');
  });

  it("puts the caller's own words on the ticket, because a human has to route it", async () => {
    const { callId } = unclassifiedCall(A_REQUEST);

    await sweep(callId);

    const payload = ticketing.createPcpTicket.mock.calls[0][0] as any;
    expect(payload.narrative).toMatch(/NOT CLASSIFIED/i);
    expect(payload.narrative).toMatch(/referral that was sent over last week/);
    expect(payload.narrative).toMatch(/nobody has called us back/);
    expect(
      payload.narrative,
      "the agent's own questions are not the request — strip them",
    ).not.toMatch(/May I have your name/);
  });

  it('uses caller ID as the callback number, so the ticket is workable', async () => {
    const { callId } = unclassifiedCall(A_REQUEST);

    await sweep(callId);

    const payload = ticketing.createPcpTicket.mock.calls[0][0] as any;
    expect(payload.callerCallbackNumber).toBe('+16265550142');
  });
});

describe('the narrowness is the point', () => {
  /**
   * Filing on every unidentified call would recreate azul's 2026-07-28 sweep,
   * where 9 of 12 spurious tickets were callbacks for patients already
   * helped. The admission is `saidMoreThanTheirOwnIdentity`, reused from
   * `requestSweep.ts` rather than rewritten.
   */
  it('files nothing when the caller said nothing at all', async () => {
    const { callId } = unclassifiedCall(
      ['AGENT: Thank you for calling Azul Vision PCP Support.'].join('\n'),
    );

    await sweep(callId);

    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('files nothing for filler alone', async () => {
    const { callId } = unclassifiedCall(
      [
        'AGENT: Thank you for calling Azul Vision PCP Support.',
        'CALLER: Hello?',
        'CALLER: Yes.',
        'CALLER: Okay, thanks.',
      ].join('\n'),
    );

    await sweep(callId);

    expect(
      ticketing.createPcpTicket,
      'a caller who only said hello has not made a request',
    ).not.toHaveBeenCalled();
  });

  /**
   * IDENTITY-ONLY SUPPRESSION WORKS ONLY WHEN WE CAPTURED THE NAME, and on
   * this arm we usually did not. Asserted as it really behaves, both ways,
   * because a test that pretended otherwise would be the more expensive lie.
   *
   * `saidMoreThanTheirOwnIdentity` subtracts the caller's own name from their
   * own lines. A call the model never classified is usually one where it
   * never recorded a name either, so there is nothing to subtract and the
   * name tokens read as content.
   *
   * The over-file is accepted and its direction is the predicate's own
   * documented choice. Closing it properly means detecting that two words are
   * a person's name, which standing instruction 3 forbids outright.
   */
  it('suppresses an identity-only call when the name WAS captured', async () => {
    const { agent, callId } = unclassifiedCall(
      [
        'AGENT: May I have your name?',
        'CALLER: This is Jordan Rivers.',
        'AGENT: And your date of birth?',
        'CALLER: March seventeenth nineteen seventy three.',
      ].join('\n'),
    );
    // A name reached the director without a purpose ever being recorded.
    const { pcpDirector } = await import('./director');
    pcpDirector.update(callId, { patientFirstName: 'Jordan', patientLastName: 'Rivers' } as never);
    void agent;

    await sweep(callId);

    expect(
      ticketing.createPcpTicket,
      'identified and hung up is not a request — Codex, PR #268 round 4',
    ).not.toHaveBeenCalled();
  });

  it('over-files an identity-only call when the name was NOT captured, and that is the accepted cost', async () => {
    const { callId } = unclassifiedCall(
      ['AGENT: May I have your name?', 'CALLER: This is Jordan Rivers.'].join('\n'),
    );

    await sweep(callId);

    expect(
      ticketing.createPcpTicket,
      'a department-18 ticket a staffer discards beats a request nobody sees',
    ).toHaveBeenCalledTimes(1);
  });

  /**
   * THE EXIT THAT MUST STILL HOLD IN FRONT OF THIS ONE. A caller who chose
   * the live queue is in the queue where they asked to be, and since the v14
   * reversal their ticket already exists — filing again from teardown would
   * stamp "not classified" over a transfer that was classified fine.
   */
  it('does not reach past the queue-choice exit', async () => {
    const { callId } = unclassifiedCall(A_REQUEST);
    const { pcpDirector } = await import('./director');
    pcpDirector.update(callId, { callerChoseTheQueue: true } as never);
    ticketing.createPcpTicket.mockClear();

    await sweep(callId);

    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });
});

describe('the slug the app has to know', () => {
  /**
   * `PcpTicketPayloadSchema` takes a `z.enum` built from this list, and so
   * does the ticketing app's. A slug missing from EITHER is an HTTP 400 and a
   * request that files nowhere — which is exactly what cost 17 callers their
   * requests on 2026-09-14. `replay20260914.test.ts` holds the cross-repo
   * half of this check; this is the local half.
   */
  it('is declared, so the payload can carry it', () => {
    expect(PCP_CALL_PURPOSE_SLUGS).toContain('unclassified_call');
  });
});
