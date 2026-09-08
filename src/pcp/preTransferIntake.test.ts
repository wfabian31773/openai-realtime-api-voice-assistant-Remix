/**
 * "THE ASK WINS, ONE ROUND THEN TRANSFER ANYWAY." Operator ruling, 2026-09-08.
 *
 * He asked the question that produced this: *"if someone just says, you know,
 * representative, you don't know, you... how can you warm transfer? You would
 * need to have, like, say, okay, before you transfer, make sure you have these
 * required fields... the name of the person who's calling, the reason they're
 * calling... and who they are, basically, what's your role, what's your
 * title."*
 *
 * He was right that it was reachable. `eligibleByAsk = askedForAPerson &&
 * !handoffFailed && !lunchClosure` carries NO field requirement at all — the
 * 2026-08-14 directive, deliberately — so a caller whose first words were "can
 * I speak to a representative" was dialled through on an empty intake and the
 * staffer picked up to a stranger.
 *
 * THE TWO FAILURES THIS SITS BETWEEN, and both have happened on this line:
 *
 *   dial blind       CAa2a3a1c1 — the office would have been briefed
 *                    "Caller organization and role: undefined, undefined"
 *   interrogate      CAdc07bca1 — nine questions before the caller could say
 *                    what they wanted; and 2026-08-06, when blocking on
 *                    missing fields destroyed 21 records requests in a day
 *
 * One round is the line between them: ask once, in one turn, for what is
 * missing; then dial, whatever they said. The latch is spent on being ASKED,
 * not on being answered — which is what makes it impossible to loop, and what
 * makes "the ask wins" true rather than aspirational.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { preTransferGaps, preTransferQuestion } from './preTransferIntake';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-57920' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { escalationDetailsMap } = await import('../services/escalationStore');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CApretx${++n}`;
  const dialled = vi.fn(async () => ({ ok: true as const, destination: '+17149564300' }));
  const agent = createPcpAgent(dialled as never, { callId, callSid: callId } as never);
  return { agent, callId, dialled };
}

/** His opening line on CAa2a3a1c1, in the shape the model writes it. */
const BARE_ASK = 'Caller asked: can I speak to the team please?';

/**
 * WHAT THE MODEL ACTUALLY SENDS ON THE RETRY — and the reason this constant
 * exists at all.
 *
 * Codex P1, PR #273: every test here originally passed `BARE_ASK` again on the
 * second `handoff_to_pcp`, which is a shape no real call produces. The model
 * summarises WHAT JUST HAPPENED, so after the one round the narrative
 * describes the ANSWER — "caller declined to give their name" — and matches
 * `asksForAPerson` not at all.
 *
 * That concealed a defect in the ruling this file is named for: the local
 * `askedForAPerson` read only the current turn, so the purpose gate refused
 * with `call_purpose_required` and `escalationDetailsMap` recorded
 * `callerRequestedHuman: false`, which makes `resolveHandoffDestination`
 * withhold the number. "One round then transfer anyway" would have been "one
 * round then nothing" for precisely the caller the round exists to serve.
 *
 * Sixth instance on this PR of a test passing because it exercised a shape the
 * production path does not produce. These constants are the fix.
 */
const DECLINED = 'Caller declined to give their name or say what it is regarding.';
const GAVE_A_PURPOSE = 'Caller is following up on a prior authorisation for a mutual patient.';

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  escalationDetailsMap.clear();
});

describe('the question itself', () => {
  it('names only what is missing — never re-asks what was given', () => {
    /**
     * Being asked your name again after you have said it is the specific
     * complaint that produced the intake script (operator, 2026-08-14: "the
     * sequencing is off"). A fixed sentence would do exactly that.
     */
    expect(preTransferQuestion(preTransferGaps({ callerName: 'Wayne Fabian' } as never))).toBe(
      'Of course — before I connect you, may I take your role there and what this is regarding?',
    );
    expect(
      preTransferQuestion(
        preTransferGaps({ callerName: 'Wayne Fabian', callerRole: 'referral coordinator' } as never),
      ),
    ).toBe('Of course — before I connect you, may I take what this is regarding?');
  });

  it('asks for all three in ONE turn when nothing is known', () => {
    // One turn, not one field — the deliberate exception. Three rounds before
    // a transfer is the interrogation this exists to avoid.
    expect(preTransferQuestion(preTransferGaps({} as never))).toBe(
      'Of course — before I connect you, may I take your name, your role there and what this is regarding?',
    );
  });

  it('asks nothing at all when the intake is complete', () => {
    const complete = {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    } as never;

    expect(preTransferGaps(complete)).toEqual([]);
    expect(preTransferQuestion(preTransferGaps(complete)), 'no delay for a caller we know').toBeNull();
  });

  it('does not require the organisation or the patient', () => {
    /**
     * Both were considered and left off. The patient's name is the field that
     * turned CAdc07bca1 into an interrogation — seven questions before anyone
     * reached the patient — and whoever picks up has the caller on the line
     * and can ask. The organisation comes free with the role.
     */
    const noOrgNoPatient = {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    } as never;

    expect(preTransferGaps(noOrgNoPatient)).toEqual([]);
  });
});

describe('one round, then the dial', () => {
  it('asks once on a bare ask, and does NOT dial yet', async () => {
    const { agent, dialled } = freshCall();

    const first = await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    expect(first.success).toBe(false);
    expect(first.error).toBe('pre_transfer_intake');
    expect(first.say).toMatch(/before I connect you/);
    expect(dialled, 'the office is not rung until we have tried once').not.toHaveBeenCalled();
  });

  it('DIALS ANYWAY when the caller DECLINES — the narrative no longer mentions an ask', async () => {
    /**
     * The half that makes it a round and not a gate, tested with the narrative
     * a real retry carries. On 2026-08-06 blocking on missing fields destroyed
     * 21 records requests; on this path what the caller rang for IS the
     * transfer, so trapping them in questions is the failure, not the
     * protection.
     */
    const { agent, dialled } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    const second = await call(agent, 'handoff_to_pcp', { narrative: DECLINED });

    expect(dialled, 'the ask wins even when the retry does not repeat it').toHaveBeenCalledTimes(1);
    expect(second.success, `must dial: ${JSON.stringify(second)}`).toBe(true);
  });

  it('DIALS ANYWAY when the caller answers with a purpose instead', async () => {
    // The other realistic retry: they say why they rang but never re-ask for a
    // person. The latch is what carries the original ask forward.
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });
    await call(agent, 'record_pcp_intake', { callPurpose: 'outside_referral_status' });

    const second = await call(agent, 'handoff_to_pcp', { narrative: GAVE_A_PURPOSE });

    expect(dialled).toHaveBeenCalledTimes(1);
    expect(second.success).toBe(true);
    expect(
      escalationDetailsMap.get(callId)?.callerRequestedHuman,
      'false here makes resolveHandoffDestination withhold the number',
    ).toBe(true);
  });

  it('never asks twice, however many times the handoff is retried', async () => {
    const { agent, dialled } = freshCall();

    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });
    await call(agent, 'handoff_to_pcp', { narrative: DECLINED });
    const third = await call(agent, 'handoff_to_pcp', { narrative: DECLINED });

    expect(third.error, 'the latch is spent on being asked, not on being answered').not.toBe(
      'pre_transfer_intake',
    );
    expect(dialled).toHaveBeenCalledTimes(2);
  });

  it('does not delay a caller who already gave everything', async () => {
    // CAa2a3a1c1 would have passed straight through: he gave his name, his
    // role and his purpose before he asked. The round is for the bare ask.
    const { agent, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callerOrganization: 'Optum',
      callerFacilityType: 'ipa_medical_group',
      callbackNumber: '6265550100',
      callPurpose: 'outside_referral_status',
    });

    const r = await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    expect(r.success, `must dial first time: ${JSON.stringify(r)}`).toBe(true);
    expect(dialled).toHaveBeenCalledTimes(1);
  });

  it('takes the answers onto the briefing when the caller does reply', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    // The model records what it just heard and retries, as the guidance says.
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    });
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    const details = escalationDetailsMap.get(callId);
    expect(details?.callerName).toBe('Wayne Fabian');
    expect(details?.providerInfo).toContain('referral coordinator');
  });
});

describe('the telemetry — "build it and the telemetry"', () => {
  it('records what the office was NOT told, measured after the round', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });
    await call(agent, 'handoff_to_pcp', { narrative: DECLINED });

    const details = escalationDetailsMap.get(callId);
    expect(details?.askedBeforeDial, 'the round fired').toBe(true);
    expect(
      details?.briefingGaps,
      'and the caller answered none of it — this is the pair that says so',
    ).toEqual(['callerName', 'callerRole', 'callPurpose']);
  });

  it('records an EMPTY gap list when the round filled the briefing', async () => {
    /**
     * The measurement the operator asked for is "does one round actually fill
     * the briefing?", so the answered case has to be distinguishable from the
     * unanswered one — not merely from a call that was never asked.
     */
    const { agent, callId } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    });
    await call(agent, 'handoff_to_pcp', { narrative: GAVE_A_PURPOSE });

    const details = escalationDetailsMap.get(callId);
    expect(details?.askedBeforeDial).toBe(true);
    expect(details?.briefingGaps, 'asked, and answered').toEqual([]);
  });

  it('records the gaps as they stand AT THE DIAL, not as they stood at the question', async () => {
    /**
     * Reusing the gap list computed when the question was asked would measure
     * the gate's INPUT and report it as its output — every call would read as
     * unanswered and the round would look useless whatever it achieved.
     *
     * A NOTE ON WHAT THIS TEST CANNOT DO, because the mutation was tried and
     * was a no-op: swapping `preTransferGaps(state)` for
     * `preTransferGaps(pcpDirector.get(callId))` changes nothing, since
     * `state` is derived from that same live object at the top of the same
     * invocation. The shape this guards is a future refactor that HOISTS the
     * gap list so the question and the record share one computation. That is a
     * real hazard and this catches it; the two spellings of "now" are not.
     */
    const { agent, callId } = freshCall();
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });
    await call(agent, 'record_pcp_intake', { callerName: 'Wayne Fabian' });
    await call(agent, 'handoff_to_pcp', { narrative: GAVE_A_PURPOSE });

    expect(
      escalationDetailsMap.get(callId)?.briefingGaps,
      'the name was given between the question and the dial',
    ).toEqual(['callerRole', 'callPurpose']);
  });

  it('says the round did NOT fire on a caller who never needed it', async () => {
    // askedBeforeDial=false with empty gaps is a complete intake; =false with
    // gaps would be a defect in the gate rather than a caller who declined.
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    });
    await call(agent, 'handoff_to_pcp', { narrative: BARE_ASK });

    const details = escalationDetailsMap.get(callId);
    expect(details?.askedBeforeDial).toBe(false);
    expect(details?.briefingGaps).toEqual([]);
  });
});
