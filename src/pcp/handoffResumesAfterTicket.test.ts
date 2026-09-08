/**
 * CAa37f1a42, 2026-09-04 16:11 — THE TRANSFER THAT WAS ANNOUNCED AND NEVER MADE.
 *
 * A referral coordinator from a surgery center asked for a representative. The
 * agent said "Give me one moment while I connect you with our PCP team — I'll
 * stay right here with you", and then connected nobody. Its own timeline:
 *
 *   handoff_to_pcp  -> durable_ticket_required_before_handoff
 *   create_pcp_task -> Validation failed
 *   handoff_to_pcp  -> durable_ticket_required_before_handoff
 *   create_pcp_task -> Validation failed
 *   handoff_to_pcp  -> durable_ticket_required_before_handoff
 *   create_pcp_task -> Validation failed
 *   create_pcp_task -> PCP-57486          <- the request IS on record here
 *   create_pcp_task -> PCP-57486
 *   terminate_call
 *
 * The ticket landed and the handoff was never tried again. Two independent
 * causes, and this file is about the second:
 *
 *   1. The ticket API rejected every HAND_OFF payload — a strict schema on the
 *      receiving end did not declare `dispositionGrantedByExplicitAsk`, the
 *      field the agent attaches ONLY when a caller explicitly asks for a
 *      person. Measured: 19 of 19 POSTs carrying it were rejected, 10 of 10
 *      without it were accepted. Fixed on the ticketing app.
 *   2. handoff_to_pcp gated the dial on ITS OWN ticket write succeeding rather
 *      than on the request being on record. Once PCP-57486 existed the
 *      precondition was satisfied and the gate still said no.
 *
 * Fixing cause 1 makes this path rare, which is exactly why cause 2 is pinned
 * here rather than left to be re-found. The invariant is "nobody is dialled
 * before the request is durable" — not "this particular write returned 200".
 * A caller must not lose a sanctioned transfer because one write failed after
 * another had already succeeded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

/**
 * The live failure, reproduced at the boundary: the ticket API takes a
 * CREATE_TASK and refuses a HAND_OFF. That asymmetry is the whole bug — it is
 * what let a durable ticket exist while the handoff's own write kept failing.
 */
const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async (payload: any) => (
    payload.disposition === 'HAND_OFF'
      ? { success: false, error: 'Validation failed' }
      : { success: true, ticketNumber: 'PCP-57486' }
  )),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

/** The SDK hands tools `(context, argsJson)` and may return an object or a
 *  JSON string depending on version — normalise both. */
async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAresume${++n}`;
  const dialled = vi.fn(async () => ({ ok: true as const }));
  const agent = createPcpAgent(dialled as never, { callId } as never);
  return { agent, callId, dialled };
}

/** The intake the live call actually completed before it reached the handoff. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerRole: 'referral coordinator',
  callerOrganization: 'Loma Linda Surgery Center',
  callerFacilityType: 'hospital_medical_facility',
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};

/** The words that make this a sanctioned transfer: the caller asked. */
const ASKED = 'Caller asked to speak to a representative about a mutual patient.';

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
});

describe('the dial waits for the request to be on record — not for one write', () => {
  it('still refuses when NOTHING is on record', async () => {
    // The floor this gate exists for is intact. Losing it would be worse than
    // the bug: a caller dialled into a queue with no record of why they rang.
    const { agent, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.success).toBe(false);
    expect(r.error).toBe('durable_ticket_required_before_handoff');
    expect(dialled, 'nobody may be dialled before the request is durable').not.toHaveBeenCalled();
  });

  it('dials once the ticket has landed, even though the handoff write still fails', async () => {
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    // 1. The live sequence: the handoff is refused because its own write fails.
    const first = await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    expect(first.success).toBe(false);
    expect(first.error).toBe('durable_ticket_required_before_handoff');
    expect(dialled).not.toHaveBeenCalled();

    // 2. The agent does as it was told and files. PCP-57486 exists from here on.
    const filed = await call(agent, 'create_pcp_task', { narrative: ASKED });
    expect(filed.success, `the task must file: ${JSON.stringify(filed)}`).toBe(true);
    expect(pcpDirector.get(callId).dispositionRecorded).toBe('CREATE_TASK');

    // 3. THE FIX. The request is on record, so the precondition is met — the
    //    HAND_OFF write failing again must no longer hold the caller back.
    const second = await call(agent, 'handoff_to_pcp', { narrative: ASKED });
    expect(dialled, 'the request is durable, so the transfer must be attempted').toHaveBeenCalledTimes(1);
    expect(second.success).toBe(true);
  });

  it('an AUTOMATE resolution is not a durable ticket', async () => {
    // record_automated_resolution records a disposition but files nothing —
    // the ticket API returns early without inserting. Reading "a disposition
    // was recorded" as "a ticket exists" would dial on an empty record.
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    pcpDirector.recordDisposition(callId, 'AUTOMATE');

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(r.success).toBe(false);
    expect(r.error).toBe('durable_ticket_required_before_handoff');
    expect(dialled).not.toHaveBeenCalled();
  });
});

describe('the refusal tells the agent to come back to the transfer', () => {
  it('names handoff_to_pcp, because the live call filed and then moved on', async () => {
    const { PCP_REFUSALS } = await import('./refusals');
    const guidance = PCP_REFUSALS.durable_ticket_required_before_handoff.guidance;

    expect(guidance).toMatch(/create_pcp_task/);
    // The words that were missing. "Carry on with the call normally" is what
    // the model was told, and carrying on is exactly what it did.
    expect(guidance, 'the model must be told to resume the transfer').toMatch(/handoff_to_pcp/);
  });
});

/**
 * THE RACE THIS FIX OPENED, and why the invariant read is not enough on its own.
 * Codex P1 on PR #273.
 *
 * `sweepPcpUnfiledCall` runs at teardown when the caller hangs up. It reads the
 * SAME live director state this tool holds — `pcpDirector.get()` returns the
 * stored object, not a copy — files "CALLER HUNG UP BEFORE THE REQUEST WAS
 * COMPLETE", records CREATE_TASK on it, and clears the director.
 *
 * So a caller who drops while the handoff's ticket write is in flight leaves a
 * recorded disposition behind. Reading it AFTER the await would see a request
 * "on record", proceed, and dial the PCP team for someone who is no longer on
 * the line — a staffer picking up to silence. Worse than the bug being fixed.
 *
 * The handoff callback's own disconnect check does not save us: on the
 * sequential PCP path `voiceAgentRoutes.ts:1501` clears `abortedPcpHandoffs`
 * before the dial loop, wiping the evidence of the disconnect it is meant to
 * detect. The dial has to be prevented here, before the callback is reached.
 *
 * Two guards, because they fail differently:
 *   - the disposition is SNAPSHOT before the write, so a record created by
 *     teardown during the await cannot satisfy the gate;
 *   - the call must still be live, so a caller who drops during a legitimate
 *     retry (the record predates the await) is not dialled either.
 */
describe('a caller who hangs up mid-write is never dialled', () => {
  it('does not dial when teardown records the disposition during the ticket write', async () => {
    const { sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    // The interleaving, made deterministic: the caller drops while the
    // HAND_OFF write is in flight, so the sweep runs before it resolves.
    ticketing.createPcpTicket.mockImplementation(async (payload: any) => {
      if (payload.disposition === 'HAND_OFF') {
        await sweepPcpUnfiledCall(callId);
        return { success: false, error: 'Validation failed' };
      }
      return { success: true, ticketNumber: 'PCP-57486' };
    });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    // The sweep really did record a disposition on the live state object —
    // otherwise this test would pass for the wrong reason.
    expect(ticketing.createPcpTicket).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'CREATE_TASK' }),
    );
    expect(dialled, 'the caller is gone — nobody may be dialled').not.toHaveBeenCalled();
    expect(r.success).toBe(false);
  });

  it('does not dial when the caller drops mid-write on a LEGITIMATE retry', async () => {
    /**
     * The interleaving the snapshot alone does not close, and the reason
     * liveness is a second guard rather than a belt-and-braces flourish.
     *
     * Here the record is genuine and predates the write — create_pcp_task
     * filed on an earlier turn — so the snapshot says "on record" quite
     * correctly. The caller then drops while the handoff write is in flight.
     * Without a liveness check the gate is satisfied by a true fact about a
     * call that is over, and the PCP team is dialled for nobody.
     */
    const { sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    const filed = await call(agent, 'create_pcp_task', { narrative: ASKED });
    expect(filed.success).toBe(true);
    expect(pcpDirector.get(callId).dispositionRecorded).toBe('CREATE_TASK');

    // The caller hangs up DURING the handoff's write, after the snapshot was
    // taken. The sweep files nothing (a disposition is already recorded) but
    // still drops the call's metadata, which is what marks the call as over.
    ticketing.createPcpTicket.mockImplementation(async (payload: any) => {
      if (payload.disposition === 'HAND_OFF') {
        await sweepPcpUnfiledCall(callId);
        return { success: false, error: 'Validation failed' };
      }
      return { success: true, ticketNumber: 'PCP-57486' };
    });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(dialled, 'the call has ended — nobody may be dialled').not.toHaveBeenCalled();
    expect(r.success).toBe(false);
  });
});

/**
 * THE TEARDOWN WINDOW. Codex round 2 on PR #273.
 *
 * The sweep is not the start of teardown, it is nearly the end of it.
 * Production order in `voiceAgentRoutes.ts`:
 *
 *   abortedPcpHandoffs.add(callId)        <- synchronous, teardown begins
 *   await cancelActiveOfficeLegs(callId)  <- an await
 *   ... unregister hooks, timeline work ...
 *   import('./agents/pcpAgent')           <- a dynamic import
 *     .then(sweepPcpUnfiledCall)          <- only NOW is the metadata dropped
 *
 * Across that entire window `pcpCallMetadata` still holds the call, so a
 * handoff write that fails inside it reads the call as live. With a genuinely
 * pre-existing disposition the gate is satisfied and the PCP team is dialled
 * for a caller who has already gone — and the sequential path then clears the
 * abort marker, so nothing downstream stops it either.
 *
 * The earlier race tests drove the sweep directly and so jumped over this
 * window entirely. That is what makes this a separate case rather than a
 * variation: the signal has to be set when teardown STARTS, not when it ends.
 */
describe('the window between teardown starting and the sweep running', () => {
  it('does not dial once teardown has begun, even before the sweep runs', async () => {
    const { markPcpCallEnded } = await import('../agents/pcpAgent');
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    // A genuine, pre-existing record: this is the legitimate retry shape.
    const filed = await call(agent, 'create_pcp_task', { narrative: ASKED });
    expect(filed.success).toBe(true);

    // The caller drops mid-write. Teardown starts — but the sweep has NOT run,
    // so the metadata is deliberately left in place, exactly as in production.
    ticketing.createPcpTicket.mockImplementation(async (payload: any) => {
      if (payload.disposition === 'HAND_OFF') {
        markPcpCallEnded(callId);   // synchronous, first thing in the finally
        await Promise.resolve();    // cancelActiveOfficeLegs
        return { success: false, error: 'Validation failed' };
      }
      return { success: true, ticketNumber: 'PCP-57486' };
    });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(dialled, 'teardown has begun — nobody may be dialled').not.toHaveBeenCalled();
    expect(r.success).toBe(false);
  });
});

/**
 * CODEX ROUND 4 — the liveness check guarded one branch, not the dial.
 *
 * `if (!initial.success && !(requestIsOnRecord && callStillLive))` skips the
 * whole condition when the write SUCCEEDS, so a caller who hung up during a
 * successful ticket write still reached handoffCallback(). The asymmetry was
 * mine: refusing on failure and not on success has no justification, and every
 * race test I wrote covered only the failure side.
 */
describe('a successful ticket write is not a licence to dial', () => {
  it('does not dial when the call ended during a SUCCESSFUL write', async () => {
    const { markPcpCallEnded } = await import('../agents/pcpAgent');
    const { agent, callId, dialled } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);

    // The write succeeds — and the caller drops while it is in flight.
    ticketing.createPcpTicket.mockImplementation(async (payload: any) => {
      if (payload.disposition === 'HAND_OFF') {
        markPcpCallEnded(callId);
        await Promise.resolve();
        return { success: true, ticketNumber: 'PCP-57920' };
      }
      return { success: true, ticketNumber: 'PCP-57920' };
    });

    const r = await call(agent, 'handoff_to_pcp', { narrative: ASKED });

    expect(dialled, 'the caller is gone — a 200 does not change that').not.toHaveBeenCalled();
    expect(r.success).toBe(false);
  });
});
