/**
 * WHAT THE TICKET SAYS AFTER A BLIND TRANSFER — and the retry storm that lost
 * CAbf717457 entirely.
 *
 * Two defects from 2026-09-08, both proved here before either was fixed.
 *
 * ── 1. THE TICKET MUST NOT SAY CONNECTED ─────────────────────────────────
 *
 * Rosa's design (approved the same day) hands a PCP caller into the call
 * centre's own queue and keeps the ticket "so it's searchable by phone
 * number". The whole value of that ticket is to the staffer who reads it AFTER
 * the caller gave up in hold music. `CONNECTED` tells them the conversation
 * already happened, and the callback they were meant to make does not.
 *
 * Nothing on this path proves a human answered — that is what the keypress did
 * on the warm path, and it is exactly what was traded away.
 *
 * ── 2. A 4xx RETRIED IS A 4xx REPEATED ───────────────────────────────────
 *
 * CAbf717457, 14:47:40 UTC. "I am calling from Loma Linda Surgery Center and I
 * need to speak to a representative." The model read that as a patient call,
 * `detectCrossQueue` matched `surgery center` in SURGERY_CUES and routed the
 * ticket to department 2, and department 2 demands a surgeon:
 *
 *   14:48:06  create-ticket -> 400 "Missing required information: surgeon..."
 *   14:48:19  create-ticket -> 400   (same)
 *   14:48:20  create-ticket -> 400   (same)
 *   14:48:21  create-ticket -> 400   (same)
 *   14:48:22  create-ticket -> 400   (same)
 *   14:48:24  create-ticket -> 400   (same)
 *
 * Six doomed POSTs in eighteen seconds, because this call site answered every
 * failure with `retryable: true`. The agent asked the caller who the surgeon
 * was, on a PCP call, and the caller hung up at 82 seconds with NO ticket and
 * NO transfer. `CreateTicketResponse.statusCode` was added on 2026-09-01 for
 * precisely this distinction — after the same shape cost 602 POSTs across 181
 * surgery calls — and this path never read it.
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
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-1' })),
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
function freshCall(handoff: () => Promise<unknown>) {
  const callId = `CAblind${++n}`;
  return { agent: createPcpAgent(handoff as never, { callId } as never), callId };
}

/** The intake the live 2026-09-08 caller had given by the time he asked. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerRole: 'referral coordinator',
  callerOrganization: 'Optum',
  callerFacilityType: 'ipa_medical_group',
  // Synthetic. The live call's own number never enters the repo.
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};
const ASKED = 'Caller asked to speak to a representative about a mutual patient.';

/** The handoff payload of the LAST createPcpTicket POST. */
function lastHandoff() {
  const calls = ticketing.createPcpTicket.mock.calls as unknown as Array<[any]>;
  const last = calls[calls.length - 1];
  expect(last, 'no PCP ticket was POSTed at all').toBeTruthy();
  return last[0]?.handoff;
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createTicket.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({
    success: true,
    ticketNumber: 'PCP-57920',
  }));
});

describe('a blind transfer is recorded as a hand-off, not a connection', () => {
  it('files DIALING and names the queue, so nobody reads it as a finished conversation', async () => {
    const { agent } = freshCall(async () => ({
      ok: true,
      destination: '+17149564300',
      handedToQueue: true,
    }));
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: ASKED });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.success).toBe(true);
    expect(r.handoffStatus).toBe('DIALING');
    const handoff = lastHandoff();
    expect(handoff.finalStatus).toBe('DIALING');
    expect(handoff.attempted).toBe(true);
    expect(handoff.destination).toBe('+17149564300');
    // Free text on the ticketing app's side, so the unambiguous word costs
    // nothing from that team — unlike a new enum value.
    expect(handoff.humanAnswerStatus).toBe('TRANSFERRED_TO_QUEUE');
    /**
     * There is no instant at which a human answered, so there is no timestamp
     * to put here. Inventing one would date an event nobody observed.
     */
    expect(handoff.connectedAt).toBeUndefined();
  });

  it('a WARM success is still CONNECTED, with the moment it happened', async () => {
    // The other lanes keep the keypress, and the keypress is real proof.
    // If this ever reads DIALING, the blind change has leaked off PCP.
    const { agent } = freshCall(async () => ({ ok: true, destination: '+18185551234' }));
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', { narrative: ASKED });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.handoffStatus).toBe('CONNECTED');
    const handoff = lastHandoff();
    expect(handoff.finalStatus).toBe('CONNECTED');
    expect(handoff.humanAnswerStatus).toBe('CONNECTED');
    expect(handoff.connectedAt).toBeTruthy();
  });

  /**
   * `DIALING` and `CONNECTED` are both in the ticketing app's own
   * `PCP_HANDOFF_STATUSES` (lib/pcp/pcp-ticket.ts), whose schema is
   * `.strict()`. That strictness is not hypothetical: on 2026-09-08 an
   * undeclared FIELD refused 19 of 19 HAND_OFF payloads and killed the PCP
   * transfer outright. An undeclared enum VALUE would do the same.
   */
  it('sends only a status that side already declares', async () => {
    const declared = [
      'NOT_REQUESTED', 'REQUESTED', 'HANDOFF_UNAVAILABLE',
      'DIALING', 'CONNECTED', 'NO_ANSWER', 'FAILED',
    ];
    for (const outcome of [
      { ok: true, destination: '+1714', handedToQueue: true },
      { ok: true, destination: '+1714' },
      { ok: false, status: 'NO_ANSWER', reason: 'office_no_answer', destination: '+1714' },
      { ok: false, status: 'FAILED', reason: 'caller_redirect_failed', destination: '+1714' },
    ]) {
      ticketing.createPcpTicket.mockClear();
      const { agent } = freshCall(async () => outcome);
      await call(agent, 'record_pcp_intake', INTAKE);
      await call(agent, 'create_pcp_task', { narrative: ASKED });
      await call(agent, 'handoff_to_pcp', { narrative: ASKED });
      expect(declared).toContain(lastHandoff().finalStatus);
    }
  });
});

describe('CAbf717457 — the refusal that was retried six times', () => {
  /**
   * The exact 400 the live call got, six times. The department-2 surgeon gate
   * is reached because the caller said "Loma Linda Surgery Center" and
   * `detectCrossQueue` reads `surgery center` as a subject cue.
   */
  const SURGEON_400 = {
    success: false,
    statusCode: 400,
    error:
      'Missing required information: surgeon. Surgery tickets are assigned by ' +
      'surgeon — ask who their surgeon is, or who performed their consult.',
  };

  async function patientCallHitting(response: Record<string, unknown>) {
    ticketing.createTicket.mockImplementation(async () => response as never);
    const { agent } = freshCall(async () => ({ ok: false, status: 'FAILED' }));
    await call(agent, 'record_pcp_intake', {
      callerName: 'Test Caller',
      callbackNumber: '9515550100',
      callPurpose: 'patient_caller',
    });
    return call(agent, 'create_pcp_task', {
      narrative: 'Caller from Loma Linda Surgery Center needs to speak to a representative.',
    });
  }

  it('does NOT tell the model to try again when the server refused the payload', async () => {
    const r = await patientCallHitting(SURGEON_400);
    expect(r.success).toBe(false);
    // The flag the model obliged six times in eighteen seconds.
    expect(r.retryable).toBeUndefined();
  });

  it("hands the server's own words back as something to ASK, not as an error", async () => {
    const r = await patientCallHitting(SURGEON_400);
    expect(r.guidance).toContain('will refuse it again unchanged');
    expect(r.guidance).toContain('Missing required information: surgeon');
    // And an exit that does not depend on the caller answering it, because on
    // a PCP call they may have no surgeon to name.
    expect(r.guidance).toContain('take the rest of their request');
  });

  /**
   * The distinction is the whole fix, so the OTHER side of it is pinned too:
   * a timeout or a socket reset carries no status and may well work next time.
   * Losing this half would trade a retry storm for a silently dropped request.
   */
  it('still retries when the request never reached a server', async () => {
    const r = await patientCallHitting({
      success: false,
      error: 'Network error - ticketing system unreachable',
    });
    expect(r.retryable).toBe(true);
  });

  it('still retries a 5xx, which is the server failing rather than refusing', async () => {
    const r = await patientCallHitting({
      success: false,
      statusCode: 503,
      error: 'Service Unavailable',
    });
    expect(r.retryable).toBe(true);
  });
});
