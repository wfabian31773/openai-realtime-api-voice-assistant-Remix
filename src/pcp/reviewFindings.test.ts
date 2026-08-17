/**
 * EIGHT DEFECTS FOUND BY AN INDEPENDENT REVIEW OF ONE DAY'S WORK.
 *
 * Operator, 2026-08-17: *"you are not asking codex to review your merges, you
 * should ask codex for a review so you can see the mistakes you are making."*
 *
 * He was right. Seven PRs shipped that day on my own judgement, and he found
 * every real problem by telephone. A review pass over the same diff found
 * eight more before they took a call — two of which would have produced the
 * exact complaint he had been making all day.
 *
 * These tests pin the ones that live in the PCP module. The azul ladder, the
 * hold ladder and the ticketing warm-up have their own files.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const { ticketReadiness } = await import('./ticketRequirements');
const { PcpDirector } = await import('./director');
const agentSrc = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');

const base = (over: Record<string, unknown> = {}) =>
  ({ verificationStatus: 'pending', toolFailures: {}, completedTools: [], ...over }) as never;

describe('1 — a call with no patient is not asked for one', () => {
  /**
   * `policy.ts` marks seven purposes `patientContextRequired: false`. The
   * first version of ticketReadiness ignored that and demanded a patient name
   * on every purpose except patient_caller — so a drug rep would be asked
   * "who is the call about?" three times and then handed a ticket annotated
   * "the caller was asked and did not provide it". A false statement about the
   * caller, on a durable record.
   */
  const noPatientPurposes = [
    'pharmaceutical_representative',
    'service_inquiry',
    'provider_information',
    'plan_participation',
    'accessibility_survey',
    'new_patient_survey',
    'disability_accommodation',
  ] as const;

  it('files without a patient name when the purpose has no patient', () => {
    for (const purpose of noPatientPurposes) {
      const r = ticketReadiness(base({ callPurpose: purpose, callerName: 'Alex Kim', callbackNumber: '+18455317471' }));
      expect(r.ready, `${purpose} should not require a patient`).toBe(true);
      expect(r.blocking, `${purpose} blocked on a patient`).not.toContain('patientName');
    }
  });

  it('still requires one when the purpose IS about a patient', () => {
    const r = ticketReadiness(base({ callPurpose: 'peer_to_peer', callerName: 'Dr Chen office', callbackNumber: '+1845' }));
    expect(r.blocking).toContain('patientName');
  });

  it('reads it from policy rather than re-encoding the list', () => {
    // Two copies of this rule is how they drift. One source: policy.ts.
    const src = readFileSync(new URL('./ticketRequirements.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/getPcpCallPurpose\(state\.callPurpose\)\.patientContextRequired/);
  });
});

describe('2 — a patient asking for their own records is not interrogated', () => {
  /**
   * `handle_patient_medical_records_request` overwrites callPurpose to
   * `patient_medical_records_request` BEFORE the readiness check runs, so a
   * purpose check could never see `patient_caller` — and the caller would be
   * asked separately for "the patient's first and last name". The exact
   * interrogation the module's own header says it prevents, in the one place
   * it was most likely to happen.
   */
  it('the flag survives the records tool reclassifying the purpose', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r1', { callerIsThePatient: true, callerName: 'Bernice Capuano' });
    // The records tool then does exactly this:
    d.update('r1', { callPurpose: 'patient_medical_records_request' });

    const state = d.get('r1');
    expect(state.callerIsThePatient, 'the flag must latch').toBe(true);
    const r = ticketReadiness(state as never);
    expect(r.blocking, 'a patient was asked for the patient name').not.toContain('patientName');
  });

  it('and is never set for a professional', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r2', { callPurpose: 'peer_to_peer', callerName: 'Dr Chen office' });
    expect(d.get('r2').callerIsThePatient).toBeUndefined();
  });

  it('a FAMILY member is not the patient, so the patient still gets named', () => {
    /**
     * `patient_caller` means "a patient OR THEIR FAMILY" — the prompt says so.
     * Latching on that slug would tell the ticket that a daughter calling
     * about her mother IS the patient, and the mother's name would never be
     * asked for. Only the model's explicit signal latches. Third review pass.
     */
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r4', { callPurpose: 'patient_caller', callerName: 'Daughter' });
    expect(d.get('r4').callerIsThePatient).toBeUndefined();
  });

  it('an absent key leaves it alone — that is the whole stickiness', () => {
    // The records tool patches ONLY callPurpose, so the flag must survive it.
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r5', { callerIsThePatient: true, callerName: 'Bernice' });
    d.update('r5', { callPurpose: 'patient_medical_records_request' });
    expect(d.get('r5').callerIsThePatient).toBe(true);
  });

  it('but the model CAN correct itself', () => {
    /**
     * I first made the flag refuse an explicit `false`, on the theory that a
     * latch should never un-latch. The review pointed out the schema actively
     * tells the model to send false for a family member — so one early
     * mis-classification would be unrecoverable for the rest of the call, and
     * the ticket would name the caller as the patient. A wrong answer that
     * cannot be corrected is worse than one that can.
     */
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r7', { callerIsThePatient: true });
    d.update('r7', { callerIsThePatient: false });
    expect(d.get('r7').callerIsThePatient).toBe(false);
  });

  it('the family-member requester gap is recorded as UNSHIPPED, not silently left', () => {
    /**
     * `patient_caller` covers "a patient OR THEIR FAMILY", so the department-16
     * requester names a daughter as the patient. Real defect, deliberately not
     * fixed here.
     *
     * I did fix it, and the sixth review pass caught what the fix actually did:
     * the fallback wording matched SPEAKING_FOR_ANOTHER in the records
     * taxonomy, resolving to requesterType `other` and capClockApplies FALSE.
     * Azul is under an HHS OCR Corrective Action Plan about LATE MEDICAL
     * RECORDS, and `callerIsThePatient` is a new optional flag — so every call
     * where the model omitted it would have moved a patient's own
     * right-of-access request OFF the 15-day statutory clock, and filed with no
     * destination and no date range because that gate only runs on-clock.
     *
     * Trading a naming error for a compliance-clock error is not a trade to
     * make unilaterally. This test exists so the gap stays visible.
     */
    const src = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/LEFT AS IT WAS, AND THAT IS A DECISION/);
    expect(src).toMatch(/capClockApplies FALSE/);
    // The shipped behaviour is the parent commit's: always on-clock.
    expect(src).toMatch(/requester: `the patient themselves\$\{state\.callerName/);
  });
  it('a latched patient is never asked the PROFESSIONAL patient block', () => {
    /**
     * The finding two review passes missed: the base field list was switched
     * but `patientContextRequired` still pushed PATIENT_FIELDS, whose first
     * question is "What is your professional relationship to this patient?"
     * — asked of the patient, about themselves.
     */
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r6', { callerIsThePatient: true, callerName: 'Bernice', callbackNumber: '+16265550857' });
    d.update('r6', { callPurpose: 'patient_medical_records_request' });
    const asked: string[] = [];
    for (let i = 0; i < 10; i++) {
      const f = d.next('r6').nextQuestion?.field;
      if (!f) break;
      asked.push(String(f));
      d.update('r6', { [f]: f === 'callerFacilityType' ? 'pcp_office' : 'provided' } as never);
    }
    for (const professionalOnly of ['statedRelationship', 'patientFirstName', 'patientLastName', 'callerRole']) {
      expect(asked, `a patient was asked ${professionalOnly}`).not.toContain(professionalOnly);
    }
  });

  it('a professional records request still names the patient', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('r3', { callPurpose: 'patient_medical_records_request', callerName: 'Dr Perez', callbackNumber: '+1760' });
    expect(ticketReadiness(d.get('r3') as never).blocking).toContain('patientName');
  });
});

describe('4 — a field declared and never written, and left that way on purpose', () => {
  /**
   * `CallMetadata.twilioCallSid` exists on the type and no code assigns it, so
   * every reader silently gets undefined — including azul's sweep, which files
   * tickets with `callSid: meta?.twilioCallSid`. It also made two fixes
   * earlier in this commit into dead code. Both type-checked; both were no-ops.
   *
   * I populated it, and then took that back out. Writing it for the first time
   * ARMS two paths that have never executed — the post-call
   * updateTicketCallData push and retryTwilioCostFetch — and that push stamps
   * `callDataSynced: true`, the exact column the retry sweeper selects on. A
   * push landing before Twilio's duration and recording callbacks would
   * permanently exclude the row from the sweeper meant to repair it.
   *
   * Turning on untraced dead code as a side effect of a one-line fix, the day
   * this agent goes back on the phone, is not the trade. The two places that
   * needed a callSid take it directly. Fifth review pass, 2026-08-17.
   */
  const routes = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');

  it('the metadata setter still does NOT write it, and says why', () => {
    const at = routes.indexOf('callMetadataForDB.set(callId, {');
    const block = routes.slice(at, at + 2200);
    expect(block).not.toMatch(/^\s*twilioCallSid,$/m);
    expect(routes).toMatch(/NOT WRITING `twilioCallSid` HERE, DELIBERATELY/);
    expect(routes).toMatch(/callDataSynced/);
  });

  it('the transfer outcome carries the caller sid on the dial record instead', () => {
    expect(routes).toMatch(/callerCallSid\?: string/);
    expect(routes).toMatch(/callerCallSid: getTwilioCallSid\(conferenceName\) \?\? undefined/);
  });

  it('and the offer-map release takes the sid that is actually in scope', () => {
    expect(routes).toMatch(/releaseAzulCallState\(callId, twilioCallSid\)/);
  });
});

describe('3 — the sweep does not file over a connected transfer', () => {
  /**
   * handoff_to_pcp files its durable ticket BEFORE dialling and updates it
   * after, so a connected call can reach teardown with the second write still
   * in flight. Checking only `dispositionRecorded` would file "CALLER HUNG UP
   * BEFORE THE REQUEST WAS COMPLETE" for someone sitting with a staffer —
   * the same error azul's sweep made in reverse on 2026-07-28 (9 of 12
   * spurious tickets went to patients who had already been helped).
   */
  it('returns early when the handoff connected', () => {
    const fn = agentSrc.slice(agentSrc.indexOf('export async function sweepPcpUnfiledCall'));
    expect(fn).toMatch(/state\.handoffStatus === 'CONNECTED'/);
    const dispAt = fn.indexOf('dispositionRecorded');
    const connAt = fn.indexOf("handoffStatus === 'CONNECTED'");
    const fileAt = fn.indexOf('submitPcpTicket');
    expect(connAt).toBeGreaterThan(dispAt);
    expect(connAt, 'the check must precede the filing').toBeLessThan(fileAt);
  });
});
