/**
 * TWO DELIVERY SYSTEMS, ONE CALL — Codex P1/P2 on PR #273, 2026-09-08.
 *
 * `gateBeforeExecution` (src/services/toolDirection.ts) has enforced a PCP
 * records-delivery rule since 2026-08-07, out of the call-facts ledger. On
 * 2026-09-08 I added a richer one in the director without looking for it, and
 * asserted in a commit message that its `'unspecified'` escape bounded the
 * refusal loop. Wherever a ledger exists it does not: the legacy gate runs
 * BEFORE the tool body, defaults the method to fax, and refuses for want of a
 * fax number — so the handler never executes, `ticketBlocksUsed` never
 * increments, and a caller who chose MAIL, or who declined to choose at all,
 * is asked for a fax number for the rest of the call.
 *
 * WHY MY TESTS WERE GREEN, which matters more than the bug. `getLedger`
 * returns nothing in a unit test, and the legacy gate opens with
 * `if (!f) return null`. The suite was exercising a code path that does not
 * exist in production, and passing.
 *
 * HOW LIVE IT IS, MEASURED: the ledger is seeded in exactly one place —
 * `voiceAgentRoutes.ts`, the old-core SIP path. Nothing under `src/runtime/`
 * seeds one. PCP moved to the Grok runtime on 2026-09-04, so the legacy gate
 * no-ops on this lane today, which is why CAdc07bca1 was never asked for a fax
 * number at all. Latent here, live the moment PCP touches the old core.
 *
 * THE FIX HAD A WORSE BUG INSIDE IT, and this file exists mostly for that.
 * `updateLedger` falls back to `seedLedger`, so writing the delivery method
 * into the ledger CREATES one — which switches the entire legacy gate on for
 * every runtime records call, and its first requirement is `medicalGroup`,
 * which nothing under `src/runtime/` populates. Trading a blocked-on-fax loop
 * for a blocked-on-organisation loop, on the lane that is actually live.
 *
 * `recordsDeliveryIntake.test.ts` caught it within a minute of the sync
 * landing: three tests failed carrying the legacy gate's own refusal text.
 * The same blind spot that hid the original bug fired in the other direction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-57918' })),
  /**
   * The records library files through `createTicket`, and this fixture needed
   * it from 2026-09-14: a PROFESSIONAL records request now reaches Medical
   * Records rather than PCP Support, so the tool runs and an absent mock makes
   * it throw — the SDK then hands back a plain-text error this harness cannot
   * parse, which reads like a source defect and is not one.
   */
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-58300' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { getLedger, seedLedger, clearAllLedgers } = await import('../services/callFactsLedger');
const { gateBeforeExecution } = await import('../services/toolDirection');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAonesys${++n}`;
  const agent = createPcpAgent((async () => ({ ok: true as const })) as never, { callId } as never);
  return { agent, callId };
}

/** Dr Perez's call, CAdc07bca1 — a professional asking for a mutual patient's records. */
const PROFESSIONAL = {
  callerName: 'Dr Joseph Perez',
  callerRole: 'primary care provider',
  callerOrganization: 'De La Pena Family Medicine',
  callerFacilityType: 'pcp_office',
  callbackNumber: '9095550123',
  statedRelationship: 'primary care provider',
  callPurpose: 'patient_medical_records_request',
  patientFirstName: 'A',
  patientLastName: 'B',
  patientDob: '1973-03-17',
};

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  clearAllLedgers();
});

describe('the sync never switches the legacy gate on', () => {
  it('creates no ledger where none existed — the runtime must stay as it is', async () => {
    const { agent, callId } = freshCall();

    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'mail', recordsDeliveryDestination: '1 Main St' });

    /**
     * THE ASSERTION THIS FILE IS FOR. A ledger here means `gateBeforeExecution`
     * stops being dormant for this call and starts demanding `medicalGroup` —
     * on the lane PCP actually runs on, where nothing ever sets it.
     */
    expect(getLedger(callId), 'the sync must not bring a ledger into existence').toBeUndefined();
  });

  it('and the records filing still goes through with no ledger', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'mail', recordsDeliveryDestination: '1 Main St' });

    const filed = await call(agent, 'handle_patient_medical_records_request', { narrative: 'Records please.' });

    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
  });
});

describe('where a ledger DOES exist, the two systems agree', () => {
  /** The old core seeds one before the first word. Reproduce that, exactly. */
  function oldCore(callId: string) {
    seedLedger(callId, { callerPhone: '+19095550123' });
  }

  it('a MAIL request is not asked for a fax number', async () => {
    const { agent, callId } = freshCall();
    oldCore(callId);

    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'mail', recordsDeliveryDestination: '1 Main St' });

    // The legacy gate, asked the same question it asks in production.
    const refusal = await gateBeforeExecution('pcp', callId, 'handle_patient_medical_records_request', {});

    expect(refusal, `the legacy gate still refuses: ${refusal}`).toBeNull();
    expect(getLedger(callId)?.contactMethod, 'the ledger learned the real method').toBe('mail');
  });

  it("'unspecified' is not asked for a fax number either — the escape has to reach the handler", async () => {
    const { agent, callId } = freshCall();
    oldCore(callId);

    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'unspecified' });

    const refusal = await gateBeforeExecution('pcp', callId, 'handle_patient_medical_records_request', {});

    expect(refusal, `the escape value is still blocked: ${refusal}`).toBeNull();
  });

  it('a FAX request carries its number across, so the gate is satisfied by the answer we already have', async () => {
    const { agent, callId } = freshCall();
    oldCore(callId);

    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'fax', recordsDeliveryDestination: '760-555-1234' });

    expect(getLedger(callId)?.faxNumber).toBe('760-555-1234');
    expect(await gateBeforeExecution('pcp', callId, 'handle_patient_medical_records_request', {})).toBeNull();
  });

  it('the organisation rides along — fixing half a disagreement is not fixing it', async () => {
    // The gate's FIRST requirement is medicalGroup. Syncing only the delivery
    // fields would clear the fax refusal and leave this one, on the same call,
    // with the director holding the answer the whole time.
    const { agent, callId } = freshCall();
    oldCore(callId);

    await call(agent, 'record_pcp_intake', PROFESSIONAL);

    expect(getLedger(callId)?.medicalGroup).toBe('De La Pena Family Medicine');
  });
});

describe('every door to a records filing asks where they go', () => {
  it('create_pcp_task is the third door, and it is now gated', async () => {
    /**
     * Codex P1: a professional call already classified
     * `patient_medical_records_request` can reach `create_pcp_task` instead of
     * the records tool. It checks only `ticketReadiness`, which deliberately
     * excludes the delivery fields, and then files. The prompt preferring the
     * records tool is not a structural guard.
     */
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PROFESSIONAL);

    const r = await call(agent, 'create_pcp_task', { narrative: 'Wants the records.' });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/recordsDeliveryMethod/);
    expect(ticketing.createPcpTicket, 'nothing may file without a destination').not.toHaveBeenCalled();
  });

  /**
   * THE DOOR MOVED, THE PROPERTY DID NOT — operator ruling, 2026-09-14.
   *
   * This caller is `callerFacilityType: 'pcp_office'`, which is precisely the
   * population that ruling sends to Medical Records off the clock: of 41 live
   * PCP records tickets in department 18, 16 came from a provider
   * organisation. So the destination this test asserts changed, and the
   * assertion moved with it rather than being relaxed — what it exists to
   * prove is that whichever door the request leaves by, it carries the place
   * the records have to be sent. That is asserted here exactly as before.
   */
  it('and files through that door once the answer is in, carrying the instruction', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'fax', recordsDeliveryDestination: '760-555-1234' });

    const r = await call(agent, 'create_pcp_task', { narrative: 'Wants the records.' });

    expect(r.success, `must file: ${JSON.stringify(r)}`).toBe(true);
    expect(r.routed_to, 'a provider records request belongs with Medical Records').toBe('Medical Records');
    const blob = JSON.stringify((ticketing.createTicket.mock.calls as any[])[0][0]);
    expect(blob, 'the clerk cannot send anything without this').toMatch(/760-555-1234/i);
    expect(blob, 'and it is off the patient clock').toMatch(/"capClockApplies":false/);
    expect(ticketing.createPcpTicket, 'it must not also file a PCP ticket').not.toHaveBeenCalled();
  });

  it('a NON-records call through create_pcp_task is not asked about delivery', async () => {
    // The gate must key on the purpose, not fire on every task. A referral
    // notification has no records to send.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...PROFESSIONAL, callPurpose: 'notify_referral_approval' });

    const r = await call(agent, 'create_pcp_task', { narrative: 'Referral approved.' });

    expect(r.success, `must file untroubled: ${JSON.stringify(r)}`).toBe(true);
  });
});

describe('the caller never hears an enum', () => {
  it("'unspecified' is not read out as a delivery route", async () => {
    /**
     * Codex P2. The truthy check built "Confirm we will send them by
     * unspecified." — an instruction to confirm a route nobody chose, in a
     * word no caller uses.
     */
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'unspecified' });

    const filed = await call(agent, 'handle_patient_medical_records_request', { narrative: 'Records.' });

    expect(filed.success).toBe(true);
    expect(String(filed.message)).not.toMatch(/unspecified/i);
    expect(String(filed.message), 'say what actually happens next instead').toMatch(/records team will be in touch/i);
  });

  it('a real route IS read back, because that is the confirmation', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PROFESSIONAL);
    await call(agent, 'record_pcp_intake', { recordsDeliveryMethod: 'fax', recordsDeliveryDestination: '760-555-1234' });

    const filed = await call(agent, 'handle_patient_medical_records_request', { narrative: 'Records.' });

    expect(String(filed.message)).toMatch(/send them by fax to 760-555-1234/i);
  });
});
