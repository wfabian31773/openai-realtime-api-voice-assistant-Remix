/**
 * A PCP CALLER WHO HANGS UP GETS NO TICKET — AND ONE WHO GOES TO THE QUEUE
 * LEAVES NONE THAT CANNOT SAY WHO IT IS ABOUT.
 *
 * Operator, 2026-10-19:
 *
 *   "we are still receiving tickets for callers that hang up or are
 *    transferred to the q with a ticket that has no identifying information,
 *    any caller that hangs up will not get their ticket submitted, plain and
 *    simple."
 *
 * Measured over 2026-10-12..16, PCP Support, agent tickets: of 147 on calls
 * the caller hung up on, 110 named no patient — 33 filed by the teardown floor
 * after the caller had gone, 35 by a refused transfer on the spot, the rest by
 * the intake filing early. Transfers added about 30 more, 4 of them floor
 * tickets saying "caller hung up" on a call that was in the queue.
 *
 * Pinned here, in the order a call ends:
 *   1. the floor files nothing on a hang-up or a transfer, and still files on
 *      an ending WE caused, and on the old core (no context) exactly as before;
 *   2. every hang-up asks the ticketing app to withdraw — the app keeps
 *      anything that names a patient (its own test file pins that), and a
 *      filing whose response never arrived may still have committed there;
 *   3. a transfer does not withdraw at teardown: the queue is still ringing;
 *   4. a withdrawal that fails costs nothing but the withdrawal;
 *   5. what counts as naming a patient, on this side, for the spoken warning.
 *
 * The queue half — withdrawal at the dial result — lives in
 * queueIsAChoice.test.ts beside the settle tests it extends.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

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
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-60001' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-1' })),
  withdrawPcpTickets: vi.fn(async () => ({ success: true, withdrawn: ['PCP-60001'], kept: [] })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall, markPcpCallEnded } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { namesAPatient, submitPcpWithdrawal } = await import('./pcpTicketing');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAleaves${++n}`;
  const agent = createPcpAgent((async () => ({ ok: true })) as never, { callId } as never);
  return { agent, callId };
}

/** A caller who said who they are and why, and gave no patient. Synthetic. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerOrganization: 'Northside Primary Care',
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createTicket.mockClear();
  ticketing.withdrawPcpTickets.mockClear();
  ticketing.withdrawPcpTickets.mockImplementation(async () => ({ success: true, withdrawn: ['PCP-60001'], kept: [] }));
});

async function endedWith(callId: string, outcome?: string) {
  markPcpCallEnded(callId);
  await sweepPcpUnfiledCall(callId, outcome === undefined ? undefined : { outcome });
}

describe('1 — the floor files nothing behind a caller who left', () => {
  it('a caller who hung up mid-intake gets no ticket', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await endedWith(callId, 'caller_hangup');
    expect(ticketing.createPcpTicket, '"any caller that hangs up will not get their ticket submitted"').not.toHaveBeenCalled();
    expect(
      ticketing.withdrawPcpTickets,
      'the app is asked anyway: it decides from its own rows, and has nothing to do on a call with no ticket',
    ).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('a call that went to the queue gets no "caller hung up" ticket behind it', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await endedWith(callId, 'transferred');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it.each(['dead_air', 'max_duration'])('an ending WE caused (%s) still files what the caller gave', async (outcome) => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await endedWith(callId, outcome);
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createPcpTicket.mock.calls[0] as any[])[0];
    expect(payload.failureInformation).toBe('caller_hung_up_before_completion');
  });

  it('the old core, which passes no ending, keeps its behaviour exactly', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await endedWith(callId, undefined);
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });
});

describe('2 — a hang-up after the call filed puts the filing up for withdrawal', () => {
  it('after create_pcp_task', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    const filed = await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants to speak with someone about a referral.' });
    expect(filed.success).toBe(true);
    ticketing.createPcpTicket.mockClear();

    await endedWith(callId, 'caller_hangup');
    expect(ticketing.createPcpTicket, 'nothing new is filed').not.toHaveBeenCalled();
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledTimes(1);
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('after a refused transfer filed its task on the spot', async () => {
    const { agent, callId } = freshCall();
    // A caller the director reads as a patient is never dialled into the
    // professional queue, so asking for a person files a task instead.
    await call(agent, 'record_pcp_intake', { callPurpose: 'patient_caller' });
    const r = await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked to speak to a representative.' });
    expect(r.success).toBe(false);
    expect(ticketing.createPcpTicket, 'the refusal filed its fallback task').toHaveBeenCalled();
    ticketing.createPcpTicket.mockClear();

    await endedWith(callId, 'caller_hangup');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('a filing whose response never came back is still put up for withdrawal (Codex P2, #353)', async () => {
    // The POST can commit on the app while the agent sees a timeout, so
    // nothing on this side records the filing. Asking only when this side
    // believes it filed would leave that ticket standing.
    ticketing.createPcpTicket.mockImplementationOnce(async () => ({ success: false, error: 'timeout' }) as never);
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants to speak with someone about a referral.' });
    ticketing.createPcpTicket.mockClear();

    await endedWith(callId, 'caller_hangup');
    expect(ticketing.createPcpTicket, 'and nothing new is filed behind the caller').not.toHaveBeenCalled();
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('a call that ended because the AGENT closed it is left alone', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants to speak with someone about a referral.' });
    await endedWith(callId, 'agent_ended');
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
  });
});

describe('3 — a transfer is not withdrawn at teardown', () => {
  it('the queue is still ringing, and a queue that never answers owes the caller their ticket', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants to speak with someone about a referral.' });
    await endedWith(callId, 'transferred');
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
  });
});

describe('4 — a withdrawal that fails costs only the withdrawal', () => {
  it('a client that throws neither throws the sweep nor leaves the call state behind', async () => {
    ticketing.withdrawPcpTickets.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants to speak with someone about a referral.' });
    await expect(endedWith(callId, 'caller_hangup')).resolves.toBeUndefined();
    expect(pcpDirector.get(callId).dispositionRecorded, 'teardown still cleared the director').toBeUndefined();
  });

  it('submitPcpWithdrawal answers a failure instead of throwing', async () => {
    const client = { withdrawPcpTickets: vi.fn(async () => { throw new Error('timeout'); }) };
    await expect(submitPcpWithdrawal('CA00000000000000000000000000001019', 'caller_hung_up', client)).resolves
      .toMatchObject({ success: false });
  });

  it('submitPcpWithdrawal sends the CallSid and the reason, and nothing else', async () => {
    const client = { withdrawPcpTickets: vi.fn(async () => ({ success: true, withdrawn: [], kept: [] })) };
    await submitPcpWithdrawal('CA00000000000000000000000000001019', 'sent_to_queue', client);
    expect(client.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: 'CA00000000000000000000000000001019', reason: 'sent_to_queue' });
  });
});

describe('6 — a filing still in flight at the hang-up cannot outlive the withdrawal (review P2, #353)', () => {
  const NARRATIVE = { narrative: 'Coordinator wants to speak with someone about a referral.' };

  /** The next PCP POST hangs until `release()` is called. */
  function holdTheNextFiling() {
    let release!: () => void;
    ticketing.createPcpTicket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true, ticketNumber: 'PCP-60002' });
        }) as never,
    );
    return () => release();
  }

  it('the sweep waits for it, then withdraws once it has landed', async () => {
    const release = holdTheNextFiling();
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    const filing = call(agent, 'create_pcp_task', NARRATIVE);
    await vi.waitFor(() => expect(ticketing.createPcpTicket).toHaveBeenCalled());

    const swept = endedWith(callId, 'caller_hangup');
    await new Promise((r) => setTimeout(r, 50));
    expect(ticketing.withdrawPcpTickets, 'not while the POST is still out').not.toHaveBeenCalled();

    release();
    await filing;
    await swept;
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledTimes(1);
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('one that outlasts the bound asks again itself when it lands', async () => {
    const release = holdTheNextFiling();
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    const filing = call(agent, 'create_pcp_task', NARRATIVE);
    await vi.waitFor(() => expect(ticketing.createPcpTicket).toHaveBeenCalled());

    await endedWith(callId, 'caller_hangup'); // returns at the bound
    expect(ticketing.withdrawPcpTickets, 'the sweep did not wait for ever').toHaveBeenCalledTimes(1);

    release();
    await filing;
    await vi.waitFor(() => expect(ticketing.withdrawPcpTickets).toHaveBeenCalledTimes(2));
    expect(ticketing.withdrawPcpTickets).toHaveBeenLastCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  }, 15_000);

  it('a filing that lands while the call is live asks for nothing', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', NARRATIVE);
    await new Promise((r) => setTimeout(r, 20));
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
    await endedWith(callId, 'agent_ended');
    expect(ticketing.withdrawPcpTickets, 'nor does an ending the agent chose').not.toHaveBeenCalled();
  });

  it('a transfer neither waits for nor withdraws an in-flight filing at teardown', async () => {
    const release = holdTheNextFiling();
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    const filing = call(agent, 'create_pcp_task', NARRATIVE);
    await vi.waitFor(() => expect(ticketing.createPcpTicket).toHaveBeenCalled());
    await endedWith(callId, 'transferred');
    release();
    await filing;
    await new Promise((r) => setTimeout(r, 20));
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
  });

  it('the bound is a few seconds, well inside the floor budget', async () => {
    const { PCP_INFLIGHT_FILING_WAIT_MS } = await import('../agents/pcpAgent');
    const { PCP_FLOOR_BUDGET_MS } = await import('../runtime/pcpFloor');
    expect(PCP_INFLIGHT_FILING_WAIT_MS).toBeGreaterThanOrEqual(3_000);
    expect(PCP_INFLIGHT_FILING_WAIT_MS).toBeLessThan(PCP_FLOOR_BUDGET_MS / 2);
  });
});

describe('5 — naming a patient, for what the caller is told on the way to the queue', () => {
  it.each([
    [{ patientFirstName: 'Robin' }, true],
    [{ patientLastName: 'Ortega' }, true],
    [{ patientDob: '1961-04-02' }, true],
    [{ patientFirstName: 'Unknown', patientLastName: 'Patient' }, false],
    [{ patientFirstName: 'patient' }, false],
    [{ patientFirstName: '  ' }, false],
    [{ patientDob: 'unknown' }, false],
    [{ patientDob: 'Not provided' }, false],
    [{ patientDob: 'N/A' }, false],
    [{}, false],
  ])('%j → %s', (state, expected) => {
    expect(namesAPatient(state)).toBe(expected);
  });
});
