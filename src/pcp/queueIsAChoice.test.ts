/**
 * THE QUEUE IS A CHOICE THE CALLER MAKES, NOT A DESTINATION WE PICK.
 *
 * Operator ruling, 2026-09-13:
 *
 *   "For anyone that requests to speak to a representative, that should
 *    trigger the warning, we would be glad to transfer you to our live queue,
 *    but just so you are aware, none of the information gathered will transfer
 *    over and I cannot tell you how long your wait will be, if any... We Will
 *    Not create tickets for anyone that chooses to be transferred. if they
 *    drop off, their record is lost. Their choice. If they accept, we transfer
 *    them to the queue, if they want to continue, we create a ticket with all
 *    the information needed."
 *
 * This overrides Rosa's 2026-09-08 design, which said a ticket should be filed
 * even on a transfer. The reason is on the record: the live queue answers at
 * 36% and nobody works the voicemails, so a ticket filed behind a transfer is
 * a record nobody reads.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS DEFENDING, and why each test is not decoration.
 *
 * The dangerous half of this change is not the transfer — it is that ONE path
 * now dials a caller whose request is written down NOWHERE. That is the exact
 * shape of CAa37f1a42 (2026-09-04): "give me one moment while I connect you",
 * connected to nobody, nothing filed. `requestIsOnRecord` was built to make it
 * unreachable, and this change reaches around it on purpose.
 *
 * So the safety argument is structural, and these tests are what hold it up:
 *
 *   1. the warning is ALWAYS spoken before any acceptance is read, so consent
 *      cannot be asserted by a model on behalf of a caller who never heard it;
 *   2. only an explicit yes suppresses the ticket — vague, absent and
 *      wandered-off all fall through to today's proven file-then-dial;
 *   3. a failed dial re-arms the filing, because "their record is lost, their
 *      choice" is about a caller who LEFT, not one still on the line;
 *   4. the teardown sweep does not undo the promise a second after it is made.
 *
 * Every one of these was mutation-checked against a scratch copy of the source
 * rather than against git HEAD, so a test that merely restates the code cannot
 * pass as proof.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * PIN THE CLOCK. `eligibleByAsk` is false between 12:00 and 12:59 Pacific on a
 * weekday (lunch closure), which turns every transfer here into a CREATE_TASK
 * and makes this file red for exactly one hour a day. Same trap, same fix, as
 * blindTransferTicket.test.ts. Only Date is faked; timers stay real.
 */
const NOT_LUNCH = new Date('2026-09-09T17:00:00Z'); // Wed 10:00 PDT
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOT_LUNCH);
});
afterAll(() => {
  vi.useRealTimers();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-58001' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-1' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall, markPcpCallEnded } = await import('../agents/pcpAgent');
const { QUEUE_CHOICE_WARNING } = await import('./queueChoice');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall(handoff: () => Promise<unknown>) {
  const callId = `CAchoice${++n}`;
  return { agent: createPcpAgent(handoff as never, { callId } as never), callId };
}

/** A complete professional intake, so nothing else can be what blocks. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerRole: 'referral coordinator',
  callerOrganization: 'Optum',
  callerFacilityType: 'ipa_medical_group',
  // Synthetic. No real caller's number enters the repo.
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};
const ASKED = 'Caller asked to speak to a representative about a mutual patient.';
const QUEUE_OK = async () => ({ ok: true, destination: '+17149564300', handedToQueue: true });

/**
 * Walk to the point where the choice has been put and answered. Returns the
 * result of the SECOND handoff call — the one that can actually dial.
 */
async function askThenAnswer(agent: any, answer: boolean | undefined) {
  await call(agent, 'record_pcp_intake', INTAKE);
  const offered = await call(agent, 'handoff_to_pcp', { narrative: ASKED });
  expect(offered.success, 'the first attempt must not dial — it asks').toBe(false);
  ticketing.createPcpTicket.mockClear();
  return call(agent, 'handoff_to_pcp', {
    narrative: 'Caller answered the transfer question.',
    ...(answer === undefined ? {} : { callerAcceptedQueue: answer }),
  });
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createTicket.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({
    success: true,
    ticketNumber: 'PCP-58001',
  }));
});

describe('the caller is asked before anything is filed or dialled', () => {
  /**
   * THE LATCH IS THE CONSENT MECHANISM. Without it, `callerAcceptedQueue:true`
   * on the FIRST invocation would let a model assert consent from a caller who
   * never heard the warning — and this is the one place where consent buys the
   * caller a WORSE outcome, their request filed nowhere. So the first attempt
   * must always ask, whatever the model sends with it.
   */
  it('speaks the warning on the first attempt and dials nobody, even if the model already claims a yes', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);
    await call(agent, 'record_pcp_intake', INTAKE);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED, callerAcceptedQueue: true });

    expect(r.success).toBe(false);
    expect(r.say).toBe(QUEUE_CHOICE_WARNING);
    expect(dial, 'a caller who has not heard the warning must not be transferred').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket, 'nothing is filed while the question is open').not.toHaveBeenCalled();
  });

  /** The content the operator asked for, checked as content and not as a string. */
  it('the warning says what does not carry over and that the wait is unknown', () => {
    expect(QUEUE_CHOICE_WARNING).toMatch(/transfers with you/i);
    expect(QUEUE_CHOICE_WARNING).toMatch(/how long the wait/i);
    expect(QUEUE_CHOICE_WARNING).toMatch(/take it (from here|here)/i);
    expect(QUEUE_CHOICE_WARNING).toMatch(/\?$/);
  });
});

/**
 * THE v14 REVERSAL — operator, 2026-09-15: "yes to the v14 reversal."
 *
 * These assertions used to pin the OPPOSITE: `createPcpTicket` NOT called at
 * all on an accepted transfer. That was the 2026-09-13 ruling, and the
 * operator withdrew its filing half on 09-15 in favour of Rosa's 09-08
 * design. They are REWRITTEN rather than loosened, because a test that merely
 * stopped asserting "no ticket" would pass whether or not the ticket carries
 * a status that lies about reaching a human — which is the whole risk of
 * filing again.
 */
describe('an explicit yes: the queue, AND a ticket that does not claim a human', () => {
  it('transfers and files, at DIALING and never CONNECTED', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    const r = await askThenAnswer(agent, true);

    expect(r.success).toBe(true);
    expect(r.handoffStatus).toBe('DIALING');
    expect(dial).toHaveBeenCalledTimes(1);
    expect(
      ticketing.createPcpTicket,
      'Rosa 2026-09-08, restored 09-15: a ticket is created even when they are transferred',
    ).toHaveBeenCalled();

    /**
     * THE PRE-DIAL WRITE IS THE ONE THAT SURVIVES A CALLER WHO HANGS UP IN
     * hold music, so it has to happen BEFORE the redirect, not only after.
     */
    const payloads = ticketing.createPcpTicket.mock.calls.map((c: any[]) => c[0]);
    const first = payloads[0];
    expect(first.handoff.finalStatus, 'filed before the dial goes out').toBe('REQUESTED');
    expect(first.handoff.attempted).toBe(false);

    const last = payloads[payloads.length - 1];
    expect(last.handoff.finalStatus, 'a queue is not a person').toBe('DIALING');
    expect(last.handoff.humanAnswerStatus).toBe('TRANSFERRED_TO_QUEUE');
    expect(
      last.handoff.connectedAt,
      'nothing on the blind path observes a human answering — v20',
    ).toBeUndefined();

    /**
     * THE APP KEYS ITS UPSERT ON callSid, so both writes must carry the SAME
     * one or the second opens a second ticket instead of updating the first.
     */
    for (const payload of payloads) {
      expect(payload.callSid).toBe(first.callSid);
    }
  });

  /**
   * CONNECTED IS RESERVED FOR THE WARM PATH'S KEYPRESS, and the ticketing app
   * computes `humanHandoffOccurred` from exactly that word. Asserting the
   * absence separately from the presence above, because a future change that
   * "improves" the status to CONNECTED would still satisfy every assertion
   * that only checks DIALING is somewhere in the payload.
   */
  it('no write on this path ever says CONNECTED', async () => {
    const { agent } = freshCall(QUEUE_OK);
    await askThenAnswer(agent, true);

    for (const call of ticketing.createPcpTicket.mock.calls as any[][]) {
      expect(call[0].handoff?.finalStatus).not.toBe('CONNECTED');
      expect(call[0].handoff?.connectedAt).toBeUndefined();
    }
  });

  /**
   * The sweep exit SURVIVES the reversal, and for its original reason.
   *
   * On the blind path the redirect ends the Media Stream, so the sweep runs
   * seconds later on a caller whose status is DIALING, not CONNECTED. Without
   * the exit it would file "CALLER HUNG UP BEFORE THE REQUEST WAS COMPLETE"
   * over somebody sitting in the queue where they asked to be — wrong prose
   * on a ticket that now exists, rather than a ticket that should not.
   */
  it('the teardown sweep does not file AGAIN behind them', async () => {
    const { agent, callId } = freshCall(QUEUE_OK);
    await askThenAnswer(agent, true);
    ticketing.createPcpTicket.mockClear();

    markPcpCallEnded(callId);
    await sweepPcpUnfiledCall(callId);

    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });
});

describe('a caller who said yes is asked nothing else', () => {
  /**
   * Operator, 2026-09-13: *"they asked for a person, get them to a person."*
   *
   * THE SETUP IS THE WHOLE TEST. `INTAKE` above fills callerName, callerRole
   * and callPurpose, which are exactly `preTransferGaps`' three fields — so
   * with it the pre-transfer question never fires and this passes whatever
   * the code does. It has to be a BARE ask with no intake at all, which
   * `eligibleByAsk` permits (it carries no field requirement), so all three
   * gaps are open and the question WOULD fire on any other path.
   *
   * That is not hypothetical: the first version of the accept test above used
   * INTAKE and was green before this behaviour existed and after it. The
   * distinguishing case is here.
   */
  it('skips the pre-transfer intake and dials on the answer', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    const offered = await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    expect(offered.say).toBe(QUEUE_CHOICE_WARNING);

    const r = await call(agent, 'handoff_to_pcp', {
      narrative: 'Caller said to connect them.',
      callerAcceptedQueue: true,
    });

    expect(
      r.error,
      'the warning just told them nothing carries over — asking for their name next contradicts it',
    ).not.toBe('pre_transfer_intake');
    expect(r.success).toBe(true);
    expect(dial).toHaveBeenCalledTimes(1);
    /**
     * AND THE SKIPPED ROUND DOES NOT SKIP THE RECORD. This line asserted the
     * opposite until the 2026-09-15 reversal, which put v14's FILING rule
     * inside a test about what we ASK — the two questions this file now keeps
     * apart (`choseTheQueue` vs the ticket writes). Asserted positively here
     * so the thin intake and the ticket are pinned together: a caller who was
     * asked nothing is exactly the caller whose ticket is easiest to lose.
     */
    expect(
      ticketing.createPcpTicket,
      'no questions asked is not the same as nothing written down',
    ).toHaveBeenCalled();
  });

  /**
   * THE CONTROL, and it is what stops the test above from being a claim about
   * the intake round in general. Same bare ask, same open gaps, no explicit
   * yes — the round still fires. The 2026-09-08 "one round then transfer
   * anyway" ruling is narrowed to the accept path, not removed.
   */
  it('but an unanswered choice still gets the one round', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    const r = await call(agent, 'handoff_to_pcp', { narrative: 'Caller said something unclear.' });

    expect(r.error).toBe('pre_transfer_intake');
    expect(r.say, 'the one round asks for what the briefing is missing').toBeTruthy();
    expect(dial).not.toHaveBeenCalled();
  });

  /** And a decline never reaches the round either — there is no transfer to prepare. */
  it('and a decline does not get it, because nothing is being prepared', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    const r = await call(agent, 'handoff_to_pcp', {
      narrative: 'Caller said to take it here.',
      callerAcceptedQueue: false,
    });

    expect(r.error).toBe('queue_choice_declined');
    expect(dial).not.toHaveBeenCalled();
  });
});

describe('an explicit no: taken here, and no dial', () => {
  it('does not transfer, and leaves the filing to create_pcp_task', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    const r = await askThenAnswer(agent, false);

    expect(r.success).toBe(false);
    expect(dial, 'they said take it here').not.toHaveBeenCalled();
    /**
     * Deliberately NOT filed from inside handoff_to_pcp. "All the information
     * needed" means the intake finishes first; filing here would file whatever
     * we happen to hold, which is the 27-second ticket of CA7a5f2bfa again.
     */
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(r.guidance).toMatch(/create_pcp_task/);
  });

  /**
   * A DECLINE MUST STILL REACH A TICKET. The sweep is what stands behind the
   * model here, and this is the case it was built for: the request is not lost
   * because the model was told to go back to the intake.
   */
  it('the teardown sweep still files for them if the model never gets there', async () => {
    const { agent, callId } = freshCall(QUEUE_OK);
    await askThenAnswer(agent, false);
    ticketing.createPcpTicket.mockClear();

    markPcpCallEnded(callId);
    await sweepPcpUnfiledCall(callId);

    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });
});

describe('no answer is not a yes — the unchanged path', () => {
  /**
   * THE SAFETY PROPERTY OF THE WHOLE CHANGE. 42 of 75 date-of-birth refusals
   * on 2026-09-08 were the LAST tool event of their call, so a model that
   * wanders off is the normal case on this line, not the edge. If silence read
   * as acceptance the ticket would be suppressed AND the dial never placed,
   * and the request would be gone with nothing anywhere.
   */
  it('files first and then dials, exactly as it did before this change', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);

    const r = await askThenAnswer(agent, undefined);

    expect(r.success).toBe(true);
    expect(dial, 'the ask still wins — they asked for a person').toHaveBeenCalledTimes(1);
    expect(
      ticketing.createPcpTicket.mock.calls.length,
      'an unanswered choice keeps the durable ticket',
    ).toBeGreaterThan(0);
  });
});

describe('a dial that never landed owes them the ticket after all', () => {
  /**
   * "If they drop off, their record is lost — their choice" is about a caller
   * who LEFT. A caller still on the line because the queue did not answer
   * chose the queue and did not get it. `handoff_no_answer` tells them "I have
   * your request recorded", so if nothing files, that sentence is a lie — the
   * broken-promise defect this line keeps being corrected for.
   */
  it('files the fallback when the queue does not answer, so the spoken line is true', async () => {
    const { agent } = freshCall(async () => ({
      ok: false,
      status: 'NO_ANSWER',
      reason: 'office_no_answer',
      destination: '+17149564300',
    }));

    const r = await askThenAnswer(agent, true);

    expect(r.success).toBe(false);
    expect(r.say, 'the caller is owed words after a failed dial').toMatch(/request recorded/i);
    expect(
      ticketing.createPcpTicket,
      'a transfer that never happened must not also lose the request',
    ).toHaveBeenCalled();
  });

  /** And the sweep is re-armed, because the exemption was withdrawn. */
  it('re-arms the teardown sweep after a failed dial', async () => {
    const { agent, callId } = freshCall(async () => ({
      ok: false,
      status: 'FAILED',
      reason: 'caller_redirect_failed',
      destination: '+17149564300',
    }));
    await askThenAnswer(agent, true);
    // The fallback write above already recorded a disposition, which is the
    // sweep's own first exit. Clear it so this asserts the EXEMPTION is gone
    // rather than re-asserting that exit.
    const { pcpDirector } = await import('./director');
    pcpDirector.update(callId, { dispositionRecorded: undefined } as never);
    ticketing.createPcpTicket.mockClear();

    markPcpCallEnded(callId);
    await sweepPcpUnfiledCall(callId);

    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });
});

describe('a transfer the caller never asked for is untouched', () => {
  /**
   * `handoffEligible` is WIDER than the ask: `eligibleByAsk ||` a purpose whose
   * default disposition is HAND_OFF with a complete intake. `peer_to_peer` is
   * that purpose — and because its default IS HAND_OFF, `connectsToHuman` is
   * true, so the director does not add PATIENT_FIELDS and the professional
   * intake above completes it. This caller is dialled without ever asking for
   * a person.
   *
   * The ruling is about "anyone that requests to speak to a representative",
   * so they keep today's path: no choice offered, ticket filed. Honouring a
   * yes here would suppress a ticket the operator never said to suppress.
   *
   * FIRST WRITTEN WITH `pharmaceutical_representative`, WHICH PROVED NOTHING.
   * That purpose defaults to CREATE_TASK, so the call was refused as
   * ineligible long before the choice gate and the test passed under a
   * mutation that leaked the choice onto every caller. It is recorded here
   * because it is failure mode 10 exactly — asserting against the end of a
   * chain proves the chain has an end, not that it is wired — and only the
   * mutation run found it.
   */
  it('dials on the first attempt and files, with no choice offered', async () => {
    const dial = vi.fn(QUEUE_OK);
    const { agent } = freshCall(dial);
    await call(agent, 'record_pcp_intake', { ...INTAKE, callPurpose: 'peer_to_peer' });

    const r = await call(agent, 'handoff_to_pcp', {
      narrative: 'Physician calling for a peer-to-peer review on a shared patient.',
    });

    expect(r.say, 'the queue warning must not reach a caller who did not ask').toBeUndefined();
    expect(r.success).toBe(true);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(ticketing.createPcpTicket, 'their ticket is unchanged').toHaveBeenCalled();
  });
});
