/**
 * THE 17 CALLERS OF 2026-09-14 WHO WERE TOLD IT WAS DONE AND HAD NOTHING FILED.
 *
 * Every one of them is the same call, and it is thirty seconds long:
 *
 *   agent   "Thank you for calling Azul Vision PCP Support. How can I help
 *            you today?"
 *   caller  "Speak to representative."
 *   agent   "I've taken this down and I'm making sure it reaches the right
 *            team."
 *
 * Nothing was taken down. Zero tickets of any provenance carry those 17 call
 * SIDs, re-checked at 00:40 UTC the following morning, well past the outbox's
 * twelve retries.
 *
 * THE CHAIN, every link read from production rather than inferred:
 *
 *   1. The director classifies a caller who states no organisation as a
 *      patient, so `askedForAPerson = callerRequestedHuman && !isPatient` is
 *      false and `handoffEligible` with it. That rule is CORRECT and stays —
 *      "a patient is never dialled into the PCP queue", which is staffed to
 *      talk to clinics. The honest answer is to take a message.
 *   2. pcpAgent takes the documented fallback and POSTs a CREATE_TASK to
 *      /api/voice-agent/pcp-ticket carrying callPurpose `patient_caller`.
 *   3. The ticketing app's PCP_CALL_PURPOSE_SLUGS did not contain
 *      `patient_caller` — 18 slugs against the 19 the agent sends. Every one
 *      of those POSTs came back HTTP 400 ["Validation failed"].
 *   4. `fallback.success` is false, so the agent returns the
 *      `handoff_not_eligible` refusal, whose own comment reads "Transfer
 *      refused AND the fallback filing failed. The only genuinely bad one."
 *   5. That refusal's copy said "I've taken this down and I'm making sure it
 *      reaches the right team."
 *
 * **The branch DEFINED by the filing having failed spoke the sentence that
 * claims it succeeded.** Step 3 is fixed and deployed (ticketing-app #267).
 * Steps 4 and 5 are what this file pins, because they are what turns any
 * future filing failure — a timeout, an outage, a schema drift — from a loss
 * we can count into a loss nobody can see.
 *
 * TWO THINGS ARE PINNED, and they fail for different reasons:
 *
 *   1. THE WORDS. A refusal raised because the filing failed must not tell the
 *      caller the request is recorded.
 *   2. THE FLOOR. A caller who asked for a person, was refused one, and whose
 *      ticket did not file must still leave a record at teardown. The sweep
 *      skipped all 17 because `toldUsSomething` demands a NAME and these
 *      callers never gave one — the identity rule selecting against exactly
 *      the population it exists to serve, which CLAUDE.md records as an open
 *      question. It is answerable now for this one narrow case: we are on the
 *      phone with them, so their callback number is never missing, and "call
 *      this number back, they asked for a person and did not get one" is a
 *      complete and workable ticket.
 *
 * WHY THE FLOOR IS NARROW. Filing on every unidentified call would recreate
 * azul's 2026-07-28 sweep, where 9 of 12 spurious tickets were callbacks for
 * patients already helped. The admission here is gated on
 * `callerRequestedHuman` — an explicit, latched ask for a person that we did
 * not honour. That is not an absence of information; it is a request.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/** Weekday morning Pacific — `isLunchClosure()` turns `eligibleByAsk` off
 *  between 12:00 and 12:59 and would make this file red for one hour a day. */
const NOT_LUNCH = new Date('2026-09-09T17:00:00Z');
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

/** The ticketing app as it behaved all afternoon: 400 on `patient_caller`.
 *  Typed on the real response shape so a test can swap in a success without
 *  `vi.hoisted` narrowing the mock to the failure branch it started on. */
const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(
    async (_payload?: unknown): Promise<{ success: boolean; ticketNumber?: string; error?: string }> => ({
      success: false,
      error: 'http_400: Validation failed',
    }),
  ),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
const { PCP_REFUSALS } = await import('./refusals');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
/** A caller on the PCP line who is read as a patient: no organisation, no
 *  role, just an ask. `patient_caller` is what the live POSTs carried. */
function patientAskingForAPerson() {
  const callId = `CAlost${++n}`;
  const agent = createPcpAgent(
    (async () => ({ status: 'CONNECTED' })) as never,
    { callId, callSid: callId, callerPhone: '+16265550142' } as never,
  );
  return { agent, callId };
}

const THE_ASK = 'Caller asked to speak to a representative.';

/**
 * The same caller with no number of ours to refer to. Twilio sends a
 * non-E.164 string for a withheld or blocked caller ID ("anonymous",
 * "unavailable", "restricted"), which is exactly what the seeding regex at
 * `pcpAgent.ts:510` is there to reject — so `callbackNumber` stays empty.
 */
function withheldCallerIdAskingForAPerson() {
  const callId = `CAlost${++n}`;
  const agent = createPcpAgent(
    (async () => ({ status: 'CONNECTED' })) as never,
    { callId, callSid: callId, callerPhone: 'anonymous' } as never,
  );
  return { agent, callId };
}

/**
 * Reach the live state the way the live calls reached it.
 *
 * `isPatient` is `callPurpose === 'patient_caller' || callerIsThePatient`, and
 * `patient_caller` is exactly what every one of the 17 POSTs carried — the
 * model classified a caller who named no organisation as a patient and
 * recorded it. Without this the fixture is handoff-ELIGIBLE and gets the queue
 * choice, which is a different call from the one that was lost.
 */
async function reachTheLiveState(agent: any) {
  await call(agent, 'record_pcp_intake', { callPurpose: 'patient_caller' });
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({
    success: false,
    error: 'http_400: Validation failed',
  }));
});

describe('the words: a failed filing is never reported as a filed one', () => {
  it('handoff_not_eligible does not claim the request was taken down', () => {
    const said = PCP_REFUSALS.handoff_not_eligible.say ?? '';
    expect(said, 'this refusal means the filing FAILED').not.toMatch(/taken this down/i);
    expect(said).not.toMatch(/reaches the right team/i);
    expect(said).not.toMatch(/\bi have your request recorded\b/i);
    expect(said).not.toMatch(/will follow up/i);
  });

  it('it still owes the caller words, and they ask for a number', () => {
    const said = PCP_REFUSALS.handoff_not_eligible.say ?? '';
    expect(said.length, 'silence is what made the model improvise').toBeGreaterThan(20);
    expect(said).toMatch(/number/i);
  });

  /** The sibling refusal fires when the filing SUCCEEDED, so it may promise
   *  the record — and must keep doing so, or this fix has traded one wrong
   *  sentence for another. */
  it('the success sibling still confirms the record', () => {
    const said = PCP_REFUSALS.handoff_not_eligible_task_created.say ?? '';
    expect(said).toMatch(/taken this down|follow up/i);
  });

  it('the live shape reaches the caller with honest words, not a false promise', async () => {
    const { agent } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    const r = await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    expect(r.success).toBe(false);
    expect(r.error).toBe('handoff_not_eligible');
    expect(String(r.say ?? ''), 'CA716aec9a heard this and nothing was filed').not.toMatch(
      /taken this down/i,
    );
  });
});

describe('the floor: an unhonoured ask for a person always leaves a record', () => {
  it('the teardown sweep files for a caller who asked and gave no name', async () => {
    const { agent, callId } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    expect(ticketing.createPcpTicket, 'the in-call attempt was refused 400').toHaveBeenCalled();

    // The ticketing app recovers (#267 is deployed) before teardown runs.
    ticketing.createPcpTicket.mockImplementation(async () => ({
      success: true,
      ticketNumber: 'PCP-RECOVERED',
    }));
    ticketing.createPcpTicket.mockClear();

    await sweepPcpUnfiledCall(callId);
    expect(
      ticketing.createPcpTicket,
      'all 17 were skipped here: "no purpose or no identity"',
    ).toHaveBeenCalledTimes(1);
  });

  it('the filed record carries the ask and the number to call back', async () => {
    const { agent, callId } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    ticketing.createPcpTicket.mockImplementation(async () => ({ success: true, ticketNumber: 'PCP-R2' }));
    ticketing.createPcpTicket.mockClear();

    await sweepPcpUnfiledCall(callId);
    const [payload] = (ticketing.createPcpTicket.mock.calls[0] ?? []) as any[];
    expect(payload, 'nothing was filed').toBeTruthy();
    expect(payload.callerCallbackNumber, 'we are ON THE PHONE with them').toBe('+16265550142');
    expect(String(payload.narrative)).toMatch(/asked to speak to a (person|representative)/i);
    expect(payload.urgency, 'a person asked for a person and did not get one').toMatch(/high|urgent/);
  });

  /** The narrow gate. A call where nobody asked for anything must stay out of
   *  the queue — azul filed 9 spurious callbacks in one day by not checking. */
  it('a caller who asked for nothing is still not filed', async () => {
    const callId = `CAquiet${++n}`;
    createPcpAgent((async () => ({})) as never, {
      callId,
      callSid: callId,
      callerPhone: '+16265550143',
    } as never);
    ticketing.createPcpTicket.mockClear();
    await sweepPcpUnfiledCall(callId);
    expect(ticketing.createPcpTicket, 'a silent call is not a request').not.toHaveBeenCalled();
  });

  /**
   * THE GATE ON THE GATE. `buildPayload` reads `state.callPurpose!` and the
   * payload schema takes an enum, so admitting a caller with no purpose would
   * send a POST that `submitPcpTicket` refuses before the wire — reinstating
   * the silent loss one layer down, which is the whole shape being closed here.
   * Skipping is honest; a doomed POST is not.
   */
  it('an ask with no purpose recorded does not produce a doomed POST', async () => {
    const callId = `CAnopurpose${++n}`;
    const agent = createPcpAgent((async () => ({})) as never, {
      callId,
      callSid: callId,
      callerPhone: '+16265550144',
    } as never);
    // The ask is latched, but nothing was ever classified.
    await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    const { pcpDirector } = await import('./director');
    pcpDirector.markCallerRequestedHuman(callId);
    pcpDirector.update(callId, { callPurpose: undefined } as never);
    ticketing.createPcpTicket.mockClear();

    /**
     * ASSERT ON THE SKIP, NOT ON THE HTTP MOCK. `submitPcpTicket` safeParses
     * before it reaches the client, so an admitted-but-unfilable call calls
     * `createPcpTicket` ZERO times — identical to a correct skip. Watching the
     * mock here passes whether the gate exists or not, which is the
     * "testing the sink instead of the source" trap in CLAUDE.md; mutation
     * testing is what caught it.
     */
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await sweepPcpUnfiledCall(callId);
      const said = info.mock.calls.flat().join(' ');
      expect(said, 'it must decline up front, not attempt a doomed POST').toMatch(/nothing to file/i);
      expect(
        error.mock.calls.flat().join(' '),
        'a payload refused by the schema means the gate was bypassed',
      ).not.toMatch(/invalid_payload/i);
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  /**
   * A CONNECTED TRANSFER IS NOT AN UNFILED CALL. Pre-existing behaviour that
   * the new admission runs directly alongside: `callerRequestedHuman` is TRUE
   * for everybody who reached a person, so without this exit holding, the
   * widened floor would file "they asked and did not get a person" for someone
   * who is on the line with a staffer right now.
   */
  it('a caller who reached a person is still not filed', async () => {
    const { agent, callId } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    const { pcpDirector } = await import('./director');
    pcpDirector.update(callId, { handoffStatus: 'CONNECTED' } as never);
    ticketing.createPcpTicket.mockClear();
    await sweepPcpUnfiledCall(callId);
    expect(
      ticketing.createPcpTicket,
      'they are talking to a human — filing would be the azul 2026-07-28 error',
    ).not.toHaveBeenCalled();
  });

  /** Operator ruling 2026-09-13 — a caller who chose the queue gets no ticket
   *  by design, and the new admission must not reach past that exit. */
  it('a caller who chose the live queue is still not filed', async () => {
    const { agent, callId } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    const { pcpDirector } = await import('./director');
    pcpDirector.update(callId, { callerChoseTheQueue: true } as never);
    ticketing.createPcpTicket.mockClear();
    await sweepPcpUnfiledCall(callId);
    expect(ticketing.createPcpTicket, 'their choice, their record — 2026-09-13').not.toHaveBeenCalled();
  });
});


/**
 * "IS THIS THE BEST NUMBER TO REACH YOU ON?" PRESUPPOSES A NUMBER.
 *
 * Codex P2, #300. The refusal above asks the caller to confirm the number we
 * are holding — standing instruction 12, and right for the common case, since
 * `pcpAgent.ts:510` seeds `callbackNumber` from caller ID on every call whose
 * ANI is E.164. It is NOT right when there is nothing to confirm: a withheld
 * or blocked caller ID arrives as a non-E.164 string, the seeding regex
 * correctly rejects it, and the caller is then asked to confirm a number
 * nobody has. Confirming a number we do not hold is how a request comes back
 * un-callable, which is the one thing this whole branch exists to prevent.
 *
 * The branch is the house pattern, not a new one: `knowledgeBase.ts:283`
 * already writes exactly this fork — "I have your callback number as ending
 * in ####. Is that correct?" against "What is the best number to reach you?"
 * — and the sibling pair `handoff_not_eligible` /
 * `handoff_not_eligible_task_created` already picks its copy with a ternary at
 * the call site. This follows both.
 */
describe('the question matches what we actually hold', () => {
  it('the no-number copy asks for a number instead of confirming one', () => {
    const said = PCP_REFUSALS.handoff_not_eligible_no_callback?.say ?? '';
    expect(said, 'the caller is owed words here too').not.toBe('');
    expect(said, 'there is no "this number" to point at').not.toMatch(/\bthis (?:the )?number\b/i);
    expect(said, 'still standing instruction 12').toMatch(/number/i);
  });

  it('the no-number copy makes the same two promises and no more', () => {
    const said = PCP_REFUSALS.handoff_not_eligible_no_callback?.say ?? '';
    // It must not claim the record — that is the defect this file is about.
    expect(said).not.toMatch(/taken this down|reaches the right team|will follow up/i);
    // And it must still refuse the transfer plainly, as its sibling does.
    expect(said).toMatch(/not able to|can't|cannot/i);
  });

  it('a caller we DO have a number for is still asked to confirm it', () => {
    expect(PCP_REFUSALS.handoff_not_eligible.say ?? '').toMatch(/is this the best number/i);
  });

  it('a withheld caller ID gets the no-number words, live', async () => {
    const { agent } = withheldCallerIdAskingForAPerson();
    await reachTheLiveState(agent);
    const r = await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    expect(r.success).toBe(false);
    expect(r.error).toBe('handoff_not_eligible_no_callback');
    expect(String(r.say ?? '')).not.toMatch(/is this the best number/i);
  });

  it('a caller with an E.164 caller ID still gets the confirm-it words, live', async () => {
    const { agent } = patientAskingForAPerson();
    await reachTheLiveState(agent);
    const r = await call(agent, 'handoff_to_pcp', { narrative: THE_ASK });
    expect(r.error).toBe('handoff_not_eligible');
    expect(String(r.say ?? '')).toMatch(/is this the best number/i);
  });
});
