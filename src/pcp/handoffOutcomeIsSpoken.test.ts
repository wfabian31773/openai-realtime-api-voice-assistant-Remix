/**
 * CAa2a3a1c1, 2026-09-08 12:28 — WE DIALLED, NOBODY ANSWERED, AND THE AGENT
 * WENT BACK TO THE INTAKE SCRIPT.
 *
 * The transfer mechanism itself worked for the first time that day: three
 * HAND_OFF POSTs carrying `dispositionGrantedByExplicitAsk` returned 200,
 * PCP-57920 recorded `pcp_handoff_attempted = true`, destination
 * `+17149564300`, and `pcp_handoff_human_answer_status = NO_ANSWER` at
 * 12:30:08. Everything up to and including the dial did what it should.
 *
 * What the caller heard:
 *
 *   agent   "Give me one moment while I connect you with our PCP team —
 *            I'll stay right here with you."
 *   ...     the dial, 30 seconds of ringing, NO_ANSWER
 *   caller  "You still there?"
 *   agent   "Still with you — one moment."
 *   caller  "Still there? You still there?"
 *   agent   "I'm still here."
 *   caller  "Did you try to connect?"
 *   agent   "What is the patient's first name?"
 *   caller  "No. I'm trying to talk to a representative."
 *
 * He asked, in words, whether we had tried. He was asked for a first name.
 *
 * THE CAUSE IS A RETURN VALUE, NOT THE PROMPT. The prompt has said "if it does
 * not connect, say exactly that and confirm their request is already recorded"
 * since 2026-08-13, and the model ignored it — because `handoff_to_pcp`
 * answered a failed dial with `{success:false, handoffStatus:'NO_ANSWER',
 * ticketNumber, fallbackRecorded}` and not one word of copy. That is the exact
 * bare-failure shape `src/pcp/refusals.ts` was built to eliminate after
 * CA1de3229a, and this call site was never routed through it, because a dial
 * that rang out is not a "refusal" — it is an action that ran and did not work.
 * A rule stated only in a prompt loses to a return value that says nothing.
 *
 * TWO THINGS ARE PINNED HERE and they fail differently:
 *
 *   1. a failed dial comes back with `say` and `guidance` (this file)
 *   2. the copy never speculates about who is available — #265, the ruling
 *      the four queue lines already carry in queuePromptRulings.test.ts
 *
 * NOT pinned here, because it is not this module's to enforce: whether the
 * model then obeys the guidance. What is testable offline is that the words
 * exist and are correct. The live check is the next call Wayne makes.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * PIN THE CLOCK — this file was red for exactly one hour every weekday.
 *
 * `PcpDirector` reads the Pacific wall clock: `isLunchClosure()` is true when
 * the local hour is 12 on a weekday, and `eligibleByAsk` is
 * `askedForAPerson && !handoffFailed && !lunchClosure`. So between 12:00 and
 * 12:59 Pacific an explicit ask stops being eligible, the agent files a
 * CREATE_TASK instead of dialling, and every test here that expects a transfer
 * fails. Measured 2026-09-09: green at 11:54 PDT, all 33 tests across the six
 * affected files red from 12:01 PDT, green again with `isLunchClosure` forced
 * off.
 *
 * The director is a module singleton, so its `lunchClosure` injection seam is
 * not reachable from here. Pinning the clock to a weekday MORNING keeps the
 * real closure logic in the path — it is exercised, and correctly returns
 * false — rather than mocking it away. Lunch closure itself is covered by
 * `lunchClosure.test.ts`.
 *
 * Only `Date` is faked; timers stay real, so anything awaiting a timeout still
 * resolves. Same trap as `.agents/memory/measurement-traps.md`: "a test that
 * reads the wall clock is wrong at a predictable time."
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
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-57920' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
/** `dial` is the HandoffCallback — the runtime's warm transfer, faked. */
function freshCall(dial: () => Promise<unknown>) {
  const callId = `CAspoken${++n}`;
  const agent = createPcpAgent(dial as never, { callId } as never);
  return { agent, callId };
}

/** The intake CAa2a3a1c1 had completed by the time it reached the handoff.
 *  Deliberately short of the patient fields — the live ticket carried
 *  "[Intake incomplete — not captured on the call: ...]" and still filed. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerRole: 'referral coordinator',
  callerOrganization: 'Optum',
  callerFacilityType: 'ipa_medical_group',
  callbackNumber: '6265550100',
  callPurpose: 'outside_referral_status',
};

const ASKED = 'Caller asked to speak to a representative about a mutual patient referral status.';

/**
 * Reach the dial the way CAa2a3a1c1 reached it: intake, then handoff_to_pcp,
 * whose OWN HAND_OFF write is what filed PCP-57920 at 12:29:26. The gate added
 * on PR #273 refuses to dial before the request is on record, and `initial`
 * satisfies it here.
 *
 * Deliberately NOT create_pcp_task first: that tool runs `ticketReadiness` and
 * would block on the patient's name, which this intake does not have and the
 * live call never captured — the live ticket carries "[Intake incomplete —
 * not captured on the call: ... patient first name, patient last name ...]".
 * Routing round the gap would test a call that did not happen.
 */
async function reachTheDial(agent: any) {
  await call(agent, 'record_pcp_intake', INTAKE);
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
});

describe('a dial that failed comes back with words', () => {
  it('NO_ANSWER — the live shape — carries a sentence for the caller', async () => {
    const dial = vi.fn(async () => ({
      ok: false as const,
      status: 'NO_ANSWER' as const,
      reason: 'office_no_answer',
      destination: '+17149564300',
    }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(dial, 'the dial must actually have been attempted').toHaveBeenCalledTimes(1);
    expect(r.success).toBe(false);
    expect(r.handoffStatus).toBe('NO_ANSWER');
    expect(r.error).toBe('handoff_no_answer');
    // The two fields that were missing on 2026-09-08.
    expect(r.say, 'the caller is owed a sentence').toBeTruthy();
    expect(r.guidance, 'the model is owed an instruction').toBeTruthy();
  });

  it('the sentence says we did not reach anyone AND that the request is recorded', async () => {
    const dial = vi.fn(async () => ({ ok: false as const, status: 'NO_ANSWER' as const }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const { say } = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    // Both halves matter. "I couldn't reach anyone" alone leaves the caller
    // thinking the request went with it, which is the thing that makes people
    // ring back. The recording half is safe to promise because the dial is
    // only reached once the request is durable (requestIsOnRecord).
    expect(say).toMatch(/wasn't able to get someone on the line/i);
    expect(say).toMatch(/recorded/i);
    expect(say).toMatch(/follow up/i);
  });

  it('never speculates about who is available — #265', async () => {
    const dial = vi.fn(async () => ({ ok: false as const, status: 'NO_ANSWER' as const }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    const spoken = String(r.say);

    /**
     * On 2026-09-03 23:54 the records line improvised "all of our agents are
     * currently busy — I can have the team contact you as soon as they become
     * available", which #265 forbids. PCP is the one line that CAN transfer,
     * which makes it the likeliest place for that language to come back
     * wearing a justification. It may report what THIS attempt did; it may not
     * describe the queue or forecast the next one.
     */
    for (const banned of ['currently busy', 'become available', 'as soon as', 'all of our agents']) {
      expect(spoken.toLowerCase(), `the caller must not be told "${banned}"`).not.toContain(banned);
    }
    // And the guidance has to say so out loud, or the model fills the gap.
    expect(String(r.guidance)).toMatch(/do not say the team is busy/i);
  });

  it('a dial that never got off the ground says the same thing to the caller', async () => {
    const dial = vi.fn(async () => ({ ok: false as const, status: 'FAILED' as const, reason: 'dial_failed' }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.error).toBe('handoff_failed');
    // The difference between "rang out" and "never dialled" is ours, not
    // theirs. What they must never hear is that something broke.
    expect(String(r.say)).toMatch(/wasn't able to get someone on the line/i);
    expect(String(r.say).toLowerCase()).not.toMatch(/error|system|technical|problem/);
  });

  it('policy refusing at dial time reuses the line already written for it', async () => {
    const dial = vi.fn(async () => ({ ok: false as const, status: 'HANDOFF_UNAVAILABLE' as const }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    // handoff_not_eligible_task_created exists and is right for this: the
    // request is filed and we are not putting them through. Writing a third
    // near-identical copy would be the drift, not the fix.
    expect(r.error).toBe('handoff_not_eligible_task_created');
    expect(String(r.say)).toMatch(/taken this down/i);
  });

  it('a connected transfer stays silent — nothing is owed and nobody may narrate', async () => {
    const dial = vi.fn(async () => ({ ok: true as const, destination: '+17149564300' }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.success).toBe(true);
    expect(r.handoffStatus).toBe('CONNECTED');
    // The staff member is on the line. A `say` here would be the agent talking
    // over a live human, and an `error` would be a lie.
    expect(r.say).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('the ticket number survives the failure — it is what staff work from', async () => {
    const dial = vi.fn(async () => ({ ok: false as const, status: 'NO_ANSWER' as const }));
    const { agent } = freshCall(dial);
    await reachTheDial(agent);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.ticketNumber).toBe('PCP-57920');
    expect(r.fallbackRecorded).toBe(true);
  });
});
