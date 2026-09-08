/**
 * WHAT THE STAFFER HEARS WHEN THEY PICK UP — end to end, through the real
 * agent, not the builder in isolation.
 *
 * Operator, 2026-09-08, on yielding to an explicit ask: "if someone just says,
 * you know, representative, you don't know, you... how can you warm transfer?
 * You would need to have, like, say, okay, before you transfer, make sure you
 * have these required fields. And that would be obviously the name of the
 * person who's calling, the reason they're calling... and who they are,
 * basically, like, what's your role, what's your title."
 *
 * He was right, and it was worse than he thought. Two defects, both live:
 *
 *   1. `callerName` was not on `PcpBriefingDetails` AT ALL. The first field he
 *      named is the one field the office was never told, under any
 *      circumstances, on either pipeline.
 *
 *   2. `pcpAgent` built `providerInfo` as
 *      `` `${state.callerRole}, ${state.callerOrganization}` ``. A template
 *      literal stringifies `undefined`, so a caller who said only
 *      "representative" produced the string "undefined, undefined" — non-empty,
 *      therefore truthy, therefore past every `details.x ? ... : null` guard in
 *      warmTransferBriefing.ts. Verified before fixing:
 *
 *        providerInfo = "undefined, undefined" | truthy: true
 *        briefing     = "Caller organization and role: undefined, undefined."
 *
 * These tests go through `createPcpAgent` and read the side channel the
 * transfer actually reads (`escalationDetailsMap`), because the bug was in the
 * WIRING between the agent and the builder. A builder-only test cannot see it —
 * `warmTransferBriefing.test.ts` was green throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-57920' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { escalationDetailsMap } = await import('../services/escalationStore');
const { briefingFor } = await import('../runtime/runtimeTransfer');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAbrief${++n}`;
  const dialled = vi.fn(async () => ({ ok: true as const }));
  const agent = createPcpAgent(dialled as never, { callId, callSid: callId } as never);
  return { agent, callId, dialled };
}

/** Exactly what the runtime does with the side channel at dial time. */
function officeHears(callId: string): string {
  return briefingFor('pcp', { callId, callSid: callId } as never, escalationDetailsMap.get(callId));
}

const ASKED = 'Caller asked to speak to a representative about a mutual patient referral.';

/**
 * THE BARE ASK, AND WHY IT REACHES A DIAL WITH NOTHING BEHIND IT.
 *
 * `eligibleByAsk = askedForAPerson && !handoffFailed && !lunchClosure` — there
 * is no field requirement on that branch at all. It is the operator's
 * 2026-08-14 directive, deliberately: an explicit ask from a professional
 * grants HAND_OFF whatever the purpose, because "the staffer who picks up
 * collects what they need." So a caller whose FIRST words are "can I speak to
 * a representative" is dialled through with an empty intake, which is exactly
 * the case that produced "undefined, undefined".
 *
 * The first draft of these tests used "Caller asked for a representative",
 * which matches NEITHER alternative of `askedForAPerson` — it wants
 * "speak/talk to" or "connect/transfer/get me". So the director refused the
 * handoff, no side-channel entry was written, and the assertions passed
 * against an empty briefing rather than a clean one. Vacuously green, on the
 * one case they existed to cover.
 */
const BARE_ASK = 'Caller asked to speak to a representative.';

/**
 * A BARE ASK NOW COSTS ONE TURN BEFORE IT DIALS — and these tests have to pay
 * it, or they stop testing anything.
 *
 * The one-round intake (src/pcp/preTransferIntake.ts, operator ruling
 * 2026-09-08) refuses the FIRST handoff on a caller with no name, role or
 * purpose, asks once, and dials on the next attempt whatever they said. So a
 * single `handoff_to_pcp` call no longer reaches `escalationDetailsMap.set`
 * at all.
 *
 * That silently made two of these tests VACUOUS — again. They read the side
 * channel, found it empty, and passed against a briefing that was never built
 * rather than one built correctly, which is precisely the failure recorded at
 * the top of this file the first time. Only the third test noticed, because it
 * asserts the entry EXISTS.
 *
 * Hence a helper: the caller is asked, says nothing useful, and is transferred
 * anyway. That is the shape the ruling describes, and it is what these
 * assertions need to be about.
 */
async function askedThenDialled(agent: any, narrative = BARE_ASK) {
  const first = await call(agent, 'handoff_to_pcp', { narrative });
  expect(first.error, 'the one round must fire on a caller we know nothing about').toBe(
    'pre_transfer_intake',
  );
  /**
   * THE RETRY NARRATIVE IS NOT THE ASK. Codex P1, PR #273: the model
   * summarises what just happened, so after the round it says the caller
   * declined — a shape that matches `asksForAPerson` not at all. Passing the
   * bare ask again is what hid a defect in the round itself.
   */
  return call(agent, 'handoff_to_pcp', {
    narrative: 'Caller declined to give their name or say what it is regarding.',
  });
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  escalationDetailsMap.clear();
});

describe('the office is told who is on the phone', () => {
  it("carries the caller's name, role and organisation", async () => {
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Dr Joseph Perez',
      callerRole: 'primary care provider',
      callerOrganization: 'De La Pena Family Medicine',
      callerFacilityType: 'pcp_office',
      callbackNumber: '9095550123',
      callPurpose: 'outside_referral_status',
      patientFirstName: 'A',
      patientLastName: 'B',
    });

    await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    expect(dialled).toHaveBeenCalledTimes(1);

    const briefing = officeHears(callId);
    expect(briefing, 'the name was never sent before 2026-09-08').toContain('Caller: Dr Joseph Perez.');
    expect(briefing).toContain('primary care provider');
    expect(briefing).toContain('De La Pena Family Medicine');
  });

  it('THE SOURCE, not just the floor: the side channel carries no placeholder', async () => {
    /**
     * DEFENCE IN DEPTH HAS TO BE TESTED IN DEPTH, and mutation testing is what
     * showed this was missing. Restoring the old template literal in pcpAgent
     * — the actual live defect — failed NOTHING, because
     * `cleanBriefingValue` catches "undefined, undefined" at the mouth. A
     * suite that cannot tell the source fix from the floor lets the source
     * regress silently and only notices when someone also weakens the floor.
     *
     * So this reads `escalationDetailsMap` directly, which is where the source
     * fix lives, and asserts the ABSENCE of a value rather than the shape of a
     * sentence: nothing known means the field is genuinely not set.
     */
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });

    await askedThenDialled(agent);

    const details = escalationDetailsMap.get(callId);
    expect(details, 'the side channel must exist — the transfer reads it').toBeTruthy();
    expect(details?.providerInfo, 'a template literal made this "undefined, undefined"').toBeUndefined();
  });

  it('THE LIVE DEFECT: a caller who said only "representative" is not read out as "undefined"', async () => {
    /**
     * CAa2a3a1c1's opening line was "can I speak to the team please?" — before
     * any intake at all. Nothing is known, and this is the shape the operator
     * was worried about.
     */
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });

    await askedThenDialled(agent);

    const briefing = officeHears(callId);
    expect(
      escalationDetailsMap.get(callId),
      'the dial must have happened — an empty side channel would pass vacuously',
    ).toBeTruthy();
    expect(briefing.toLowerCase(), 'a staffer heard this word out loud').not.toContain('undefined');
    expect(briefing).not.toContain('Caller organization and role:');
  });

  it('and is handed over honestly instead — say we have nothing, do not go quiet', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });

    await askedThenDialled(agent);

    const briefing = officeHears(callId);
    expect(
      escalationDetailsMap.get(callId),
      'the dial must have happened — an empty side channel would pass vacuously',
    ).toBeTruthy();
    expect(briefing).toContain('did not give a name');
    expect(briefing, 'the staffer needs to know to start from the top').toMatch(
      /asking who they are and what they need/,
    );
  });

  it('a half-known caller keeps the half we have', async () => {
    // Role given, organisation not. The old template literal produced
    // "referral coordinator, undefined" — the real half plus a lie.
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callPurpose: 'outside_referral_status',
    });

    await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    const briefing = officeHears(callId);
    expect(briefing).toContain('Caller: Wayne Fabian.');
    expect(briefing).toContain('Caller organization and role: referral coordinator.');
    expect(briefing.toLowerCase()).not.toContain('undefined');
  });

  it('the reason is the narrative, so the caller does not repeat themselves', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callerName: 'Wayne Fabian',
      callerRole: 'referral coordinator',
      callerOrganization: 'Optum',
      callPurpose: 'outside_referral_status',
    });

    await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(officeHears(callId)).toContain('mutual patient referral');
  });
});
