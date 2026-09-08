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
