/**
 * PCP SCHEDULING STOPS DIALLING, AND REACHES THE TEAM THAT SCHEDULES.
 *
 * Two operator rulings meet on this lane and neither was being followed.
 *
 *   2026-09-04: "Default is to take the request and file the ticket. Never
 *   auto-transfer. Transfer only when BOTH the caller asks for a
 *   representative AND the caller is an entity."
 *
 *   2026-08-13 (standing instruction 10): "anything that's schedule related
 *   that comes through any of these should go to the HVA hub" — except a
 *   surgery date, asked and answered the same day.
 *
 * MEASURED BEFORE THIS, all 217 PCP tickets, 2026-09-14: 75 carry one of the
 * three scheduling slugs. **56 attempted a transfer and 10 connected — 17.9%.
 * ZERO ever reached department 9.** So the caller was neither connected to a
 * scheduler nor filed with the schedulers.
 *
 * WHAT EACH TEST IS FOR. The disposition tests prove the dial stops without
 * taking the caller's own ask away with it. The intake test is the one that
 * would be easy to omit: flipping the default without decoupling
 * `connectsToHuman` would have pushed the four-field PATIENT_FIELDS block back
 * onto a scheduling caller, whose first question is "What is your professional
 * relationship to this patient?" — the bd89b226 interrogation, arriving as a
 * side effect of a routing change.
 *
 * FIXTURES ARE SYNTHETIC. No real patient, clinic, number or date of birth —
 * see task #106.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

type TicketResult = { success: boolean; ticketNumber?: string; error?: string; statusCode?: number };
const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-59000' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-59100' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { PCP_CALL_PURPOSES, getPcpCallPurpose } = await import('./policy');
const { schedulingRedirectForStatedIntent, OPERATION_CUES } = await import('../tools/queueRouting');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAschedhub${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callerPhone: '+15005550006',
  } as never);
  return { agent, callId };
}

/** A referral coordinator ringing to book a mutual patient in. Synthetic. */
const COORDINATOR = {
  callerName: 'Test Coordinator',
  callerRole: 'referral coordinator',
  callerOrganization: 'Example Family Practice',
  callerFacilityType: 'pcp_office' as const,
  callPurpose: 'schedule_appointment' as const,
  callbackNumber: '5005550006',
  // `ticketReadiness` asks who the call is about whenever the purpose carries
  // `patientContextRequired`, which these do. That gate is older than this
  // change and bounded by the shared three-strike floor — but it is a question
  // an auto-transferred caller never reached, so it belongs in the fixture
  // rather than being discovered on a live call.
  patientFirstName: 'Test',
  patientLastName: 'Patient',
};

const SCHEDULING_SLUGS = ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment'] as const;

/**
 * `handoff_to_pcp` reads the ask out of the NARRATIVE via `asksForAPerson` —
 * there is no boolean argument for it. A first draft of these tests passed
 * `{ askedForAPerson: true }`, which the schema rejected, and the thrown error
 * surfaced as a JSON parse failure rather than as "no transfer was requested".
 */
const ASKS_FOR_A_PERSON = 'Caller would like to speak to a representative.';

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-59000' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-59100' });
});

const hubPayload = () => (ticketing.createTicket.mock.calls as any[])[0][0];

describe('the policy no longer defaults these purposes to a transfer', () => {
  it.each([...SCHEDULING_SLUGS, 'grievance_follow_up' as const])(
    '%s takes the request by default',
    (slug) => {
      expect(getPcpCallPurpose(slug).defaultDisposition).toBe('CREATE_TASK');
    },
  );

  it.each([...SCHEDULING_SLUGS, 'grievance_follow_up' as const])(
    '%s still PERMITS a transfer, so an explicit ask is not taken away',
    (slug) => {
      // Load-bearing in three places: `eligibleByAsk`, handoffPolicy's derived
      // PCP_CALLER_TYPES, and `connectsToHuman`. Removing HAND_OFF from the
      // list would refuse a caller who asked for a person at the dial.
      expect(getPcpCallPurpose(slug).allowedDispositions).toContain('HAND_OFF');
    },
  );

  it('leaves peer_to_peer and health_plan_visit_inquiry alone — they were not in scope', () => {
    expect(getPcpCallPurpose('peer_to_peer').defaultDisposition).toBe('HAND_OFF');
    expect(getPcpCallPurpose('health_plan_visit_inquiry').defaultDisposition).toBe('HAND_OFF');
  });
});

describe('the intake did not lengthen when the default moved', () => {
  /**
   * THE CLAIM THE `connectsToHuman` COMMENT MAKES, ASSERTED RATHER THAN
   * TRUSTED. Reading `allowedDispositions` instead of `defaultDisposition` is
   * only inert while every purpose where the two disagree has
   * `patientContextRequired: false` — that flag is the guard on the one clause
   * `connectsToHuman` gates. If a future purpose breaks this, the two readings
   * stop being interchangeable and this fails rather than silently adding four
   * questions to a live intake.
   */
  it.each([...SCHEDULING_SLUGS, 'grievance_follow_up' as const])(
    'reading the DEFAULT instead of the allowed list would have lengthened %s',
    (slug) => {
      const p = getPcpCallPurpose(slug);
      // The three facts that make the decoupling load-bearing rather than
      // cosmetic, asserted separately so a failure names which one moved:
      expect(p.patientContextRequired, 'so the PATIENT_FIELDS clause is reachable at all').toBe(true);
      expect(p.defaultDisposition === 'HAND_OFF', 'the OLD reading is now false').toBe(false);
      expect(p.allowedDispositions.includes('HAND_OFF'), 'the NEW reading is still true').toBe(true);
    },
  );

  it('and the decoupling changes nothing anywhere else', () => {
    // Every OTHER purpose reads the same under both rules, or cannot reach the
    // clause. `pharmaceutical_representative` is the one that reads
    // differently and it carries no patient context, so nothing follows from
    // it. This is what makes the edit safe to land beside a policy change —
    // if a future purpose breaks it, that is a decision, not a side effect.
    const others = PCP_CALL_PURPOSES.filter(
      (p) => !([...SCHEDULING_SLUGS, 'grievance_follow_up'] as string[]).includes(p.slug),
    );
    for (const p of others) {
      const differs = p.allowedDispositions.includes('HAND_OFF') !== (p.defaultDisposition === 'HAND_OFF');
      if (differs) expect(p.patientContextRequired, `${p.slug} would change intake length`).toBe(false);
    }
  });

  it('a scheduling caller is never asked their professional relationship to the patient', () => {
    const callId = 'CAschedintake1';
    pcpDirector.update(callId, { ...COORDINATOR, verificationStatus: 'pending' });
    const next = pcpDirector.next(callId);
    expect(next.nextQuestion, `still asking: ${JSON.stringify(next.nextQuestion)}`).toBeUndefined();
  });
});

describe('the transfer is no longer granted to a caller who did not ask', () => {
  it('a complete scheduling intake alone does NOT make the call handoff-eligible', () => {
    const callId = 'CAscheddisp1';
    pcpDirector.update(callId, { ...COORDINATOR, verificationStatus: 'pending' });
    const next = pcpDirector.next(callId);
    expect(next.disposition).toBe('CREATE_TASK');
    expect(next.handoffEligible).toBe(false);
  });

  it('but the same caller ASKING for a person still is — the ask was never the problem', () => {
    const callId = 'CAscheddisp2';
    pcpDirector.update(callId, {
      ...COORDINATOR,
      verificationStatus: 'pending',
      callerRequestedHuman: true,
    });
    const next = pcpDirector.next(callId);
    expect(next.disposition).toBe('HAND_OFF');
    expect(next.handoffEligible).toBe(true);
  });
});

describe('schedulingRedirectForStatedIntent', () => {
  it.each([
    ['new', 146],
    ['reschedule', 147],
    ['cancel', 148],
  ] as const)('routes a stated %s to the Hub on reason %i', (intent, reasonId) => {
    const r = schedulingRedirectForStatedIntent(intent, 'Caller would like to be seen.', 18);
    expect(r?.departmentId).toBe(9);
    expect(r?.requestReasonId).toBe(reasonId);
    expect(r?.requestTypeId).toBe(32);
  });

  it('routes on the STATED intent when the narrative names no scheduling cue at all', () => {
    // 25 of the 75 measured tickets are this shape — the enum carried the
    // purpose and the summary never used a cue word. `detectCrossQueue` on the
    // same sentence returns null, which is the whole reason this exists.
    const prose = 'Caller would like the patient seen before the referral expires.';
    expect(schedulingRedirectForStatedIntent('new', prose, 18)?.departmentId).toBe(9);
  });

  it('DECLINES a surgery date — the operator stated exception', () => {
    expect(schedulingRedirectForStatedIntent('reschedule', 'needs to move the surgery date', 18)).toBeNull();
    expect(schedulingRedirectForStatedIntent('cancel', 'cancelling her cataract surgery', 18)).toBeNull();
  });

  it('declines when the Hub is already the home queue', () => {
    expect(schedulingRedirectForStatedIntent('new', 'wants an appointment', 9)).toBeNull();
  });

  it('does not refine the reason on a specialist mention — see round 2 below', () => {
    // This asserted 152 when it was written. Codex round 2 showed the same
    // cue fires on an EMPLOYER name on this path, so the refinement is gone
    // and the plain stated-intent reason stands.
    const r = schedulingRedirectForStatedIntent('new', 'was referred to a retina specialist', 18);
    expect(r?.requestReasonId).toBe(146);
  });
});

describe('create_pcp_task routes a professional scheduling request to the Hub', () => {
  it('files to department 9 and not into PCP Support', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Referral coordinator asking to get their patient booked in.',
    });

    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
    expect(filed.routed_to).toBe('HVA Hub');
    const payload = hubPayload();
    expect(payload.departmentId).toBe(9);
    expect(payload.requestReasonId).toBe(146);
    expect(ticketing.createPcpTicket, 'and does not also sit in PCP Support').not.toHaveBeenCalled();
  });

  it("carries the requesting office's callback number and says whose it is", async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);
    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });

    const payload = hubPayload();
    // Measured: all 75 carry a caller callback number, only 35 a real patient
    // first name. The Hub rings the office, so the field has to hold the
    // office's line and the description has to say so.
    expect(payload.patientPhone).toBe('5005550006');
    expect(payload.description).toMatch(/reaches the requesting office, not the patient/i);
    expect(payload.description).toContain('Example Family Practice');
  });

  it('a surgery date is NOT routed — it stays on the PCP ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...COORDINATOR, callPurpose: 'reschedule_appointment' });

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Needs to move the surgery date for their patient.',
    });

    expect(filed.success).toBe(true);
    expect(ticketing.createTicket, 'the Hub must not take a surgery date').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalled();
  });

  it('a caller being transferred keeps their own ticket, with the transfer telemetry on it', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);
    // Two halves, and both are needed. The ask is latched on the DIRECTOR —
    // `handoff_to_pcp` sets it, not the intake schema — and `create_pcp_task`
    // takes the disposition as a MODEL ARGUMENT which the director then has to
    // agree with. Without the update the tool's own gate would refuse
    // `director_disposition_mismatch` and this would pass for the wrong reason.
    pcpDirector.update(callId, { callerRequestedHuman: true });

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Wants their patient booked in.',
      disposition: 'HAND_OFF',
    });
    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);

    // HAND_OFF here is the director's grant on the explicit ask. That ticket
    // is what the dial is gated on — it carries dispositionGrantedByExplicitAsk
    // and the pcp_handoff_* columns, none of which exist on a create-ticket
    // payload. Routing it away would take the sanction off the transfer.
    expect(ticketing.createTicket, 'must not be routed').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalled();
    expect((ticketing.createPcpTicket.mock.calls as any[])[0][0].disposition).toBe('HAND_OFF');
  });

  it('THE FLOOR: a refused Hub POST files the PCP ticket rather than losing the request', async () => {
    ticketing.createTicket.mockResolvedValue({ success: false, error: 'Validation failed', statusCode: 400 } satisfies TicketResult);
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    const filed = await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });

    expect(ticketing.createTicket).toHaveBeenCalled();
    expect(ticketing.createPcpTicket, 'the request must still land somewhere').toHaveBeenCalled();
    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
  });

  it('a patient on this line is untouched — they route through detectCrossQueue as before', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_caller',
      callerName: 'Test Patient',
      callbackNumber: '5005550006',
    });

    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'I need to reschedule my eye exam.',
    });

    expect(filed.routed_to).toBe('HVA Hub');
    expect(hubPayload().departmentId).toBe(9);
  });
});

/**
 * CODEX REVIEW, PR #298. Four findings, all verified against the code before
 * anything was changed. Each test below is the finding stated as a call.
 */
describe('Codex #298 — the surgery exception must not fire on an employer', () => {
  /**
   * THE FINDING I HAD ALREADY CLAIMED TO HAVE AVOIDED, in the one line where
   * this route reads prose. `SURGERY_CUES` contains the literal
   * `'surgery center'` — that is #99 — so a referral coordinator AT a surgery
   * centre, ringing to book an ordinary eye exam, hit the exception and stayed
   * in department 18. The PR body said "it cannot fire on an employer"; the
   * surgery guard is exactly where it could.
   *
   * The operator's exception is the OPERATION, not the word: *"The exception
   * is the OPERATION, not the word 'reschedule'"* (queueRouting.ts, 2026-08-13).
   * A place that performs surgery is not a surgery being performed.
   */
  it('routes a caller AT a surgery center who is booking an ordinary exam', () => {
    const r = schedulingRedirectForStatedIntent(
      'new',
      'Referral coordinator at Example Surgery Center asking to book an eye exam.',
      18,
    );
    expect(r?.departmentId, 'the employer is not the subject of the request').toBe(9);
  });

  it.each([
    'needs to move the surgery date',
    'cancelling her cataract surgery',
    'asking about the pre-op appointment',
    'rescheduling after the operation',
  ])('still declines when the request itself is about an operation: %s', (prose) => {
    expect(schedulingRedirectForStatedIntent('reschedule', prose, 18)).toBeNull();
  });
});

describe('Codex #298 — a transfer in flight keeps its ticket on the PCP endpoint', () => {
  /**
   * THE P1, AND MY GUARD READ THE WRONG THING.
   *
   * `create_pcp_task`'s `disposition` is a MODEL argument with
   * `.default('CREATE_TASK')`. So when `handoff_to_pcp`'s own ticket write
   * fails, it refuses `durable_ticket_required_before_handoff`, the model is
   * told to file first, and the filing it makes is indistinguishable from an
   * ordinary one. The Hub route fired, `recordDisposition('CREATE_TASK')` made
   * `requestIsOnRecord` true, and the retried dial then rested on a
   * department-9 scheduling ticket carrying none of the `pcp_handoff_*`
   * columns and no `dispositionGrantedByExplicitAsk`.
   *
   * The dial itself is not new — the pre-change code recorded the same
   * disposition from the same fallback. What this change moved is WHERE that
   * durable record lives, and a transfer must not rest on a ticket filed to
   * another department's queue.
   *
   * Fixed with a SERVER-OWNED latch, which is what Codex asked for: the model
   * cannot set or clear it.
   */
  it('does NOT route to the Hub while a transfer is waiting on a durable ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    // The caller asks. First handoff_to_pcp offers the queue choice (v14).
    const offered = await call(agent, 'handoff_to_pcp', { narrative: ASKS_FOR_A_PERSON });
    expect(offered.success).toBe(false);
    // They do not answer it, so the pre-ruling path applies: file, then dial.
    // Make that filing fail, which is what puts the tool in the state this
    // test is about.
    ticketing.createPcpTicket.mockResolvedValue({ success: false, error: 'upstream 500' });
    const blocked = await call(agent, 'handoff_to_pcp', { narrative: ASKS_FOR_A_PERSON });
    expect(blocked.error).toBe('durable_ticket_required_before_handoff');

    // The model does as the refusal says and files — with the DEFAULT
    // disposition, because it is not asked to supply one.
    ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-59001' });
    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });

    expect(
      ticketing.createTicket,
      'the durable ticket a transfer rests on must stay on the PCP endpoint',
    ).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalled();
  });

  it('but routes normally once the caller DECLINES the queue — they chose the ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    await call(agent, 'handoff_to_pcp', { narrative: ASKS_FOR_A_PERSON });
    ticketing.createPcpTicket.mockResolvedValue({ success: false, error: 'upstream 500' });
    await call(agent, 'handoff_to_pcp', { narrative: ASKS_FOR_A_PERSON });
    ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-59002' });

    // "No, just take the request." No transfer is in flight any more.
    const declined = await call(agent, 'handoff_to_pcp', {
      narrative: ASKS_FOR_A_PERSON,
      callerAcceptedQueue: false,
    });
    expect(declined.success).toBe(false);

    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });
    expect(ticketing.createTicket, 'a declined queue is an ordinary filing').toHaveBeenCalled();
    expect(hubPayload().departmentId).toBe(9);
  });
});

describe('Codex #298 — urgency and an ambiguous Hub response', () => {
  it.each([
    ['urgent', 'high'],
    ['high', 'high'],
    ['normal', 'medium'],
    ['routine', 'medium'],
  ] as const)('carries urgency %s to the Hub as priority %s', async (urgency, priority) => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);
    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.', urgency });
    // Before this, the Hub ticket was hardcoded `medium`, so rerouting
    // silently deprioritised a time-sensitive request that `buildPayload`
    // would have carried through.
    expect(hubPayload().priority).toBe(priority);
  });

  it('sends an idempotency key, so a second invocation cannot open a second Hub ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);
    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });
    expect(hubPayload().idempotencyKey).toBeTruthy();
  });

  /**
   * A STATUSLESS FAILURE IS NOT A PROVEN REFUSAL. `createTicket` reports a
   * timeout, a DNS failure or a socket reset with no `statusCode` — the
   * distinction `CreateTicketResponse.statusCode` was added to carry. So the
   * POST may well have landed and committed.
   *
   * The floor does not change: the request must never file NOWHERE, so the
   * PCP ticket still goes. What changes is that the possible duplicate stops
   * being SILENT — the PCP ticket says so, and a staffer can close one. The
   * PR body claimed "a failed POST creates nothing, so falling through cannot
   * duplicate", and that is false for exactly this case.
   */
  it('files the PCP ticket on an ambiguous failure AND says the Hub may hold one too', async () => {
    ticketing.createTicket.mockResolvedValue({ success: false, error: 'network timeout' });
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    const filed = await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });

    expect(filed.success, 'the request must still land somewhere').toBe(true);
    const pcp = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(pcp.narrative).toMatch(/may already hold a scheduling ticket/i);
  });

  it('says nothing of the sort when the Hub gave a PROVEN refusal', async () => {
    ticketing.createTicket.mockResolvedValue({ success: false, error: 'Validation failed', statusCode: 400 });
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);

    await call(agent, 'create_pcp_task', { narrative: 'Wants their patient booked in.' });

    const pcp = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    // A 4xx is proof the server rejected it before committing, so warning a
    // staffer about a duplicate that cannot exist is noise.
    expect(pcp.narrative).not.toMatch(/may already hold a scheduling ticket/i);
  });
});

/**
 * CODEX ROUND 2, PR #298. Both findings are the SAME CLASS as round 1's
 * surgery-centre one, a level further down: `hit()` is a substring test, and on
 * this path the narrative is dominated by the caller's own organisation and
 * role — because that is precisely what the PCP intake collects.
 */
describe('Codex #298 round 2 — substring cues reading the caller, not the request', () => {
  it.each([
    'Operations coordinator would like to book an eye exam.',
    'Operations manager calling to book the patient in.',
  ])('routes an ordinary booking from an OPERATIONS role: %s', (prose) => {
    // 'operation' is a bare cue and `hit` matches substrings, so 'operations'
    // contained it. The role name withheld the Hub route from a routine
    // booking — the same defect as 'surgery center', surviving its fix.
    expect(schedulingRedirectForStatedIntent('new', prose, 18)?.departmentId).toBe(9);
  });

  it.each([
    ['rescheduling after the operation', 'reschedule'],
    ['needs to move the surgery date', 'reschedule'],
    ['cancelling her cataract surgery', 'cancel'],
    ['asking about the pre-op appointment', 'reschedule'],
  ] as const)('still withholds when the request IS the procedure: %s', (prose, intent) => {
    expect(schedulingRedirectForStatedIntent(intent, prose, 18)).toBeNull();
  });

  it('boundary matching does not silently disarm a cue — every one still fires alone', () => {
    // The guard against fixing the collision by breaking the list: if a future
    // cue is added as a STEM (as SPECIALIST_CUES deliberately has), a trailing
    // boundary would stop it matching and the exception would quietly weaken.
    for (const cue of OPERATION_CUES) {
      expect(
        schedulingRedirectForStatedIntent('new', `the patient asked about ${cue} today`, 18),
        `${cue} no longer withholds the redirect`,
      ).toBeNull();
    }
  });

  it('does NOT read a specialist reason off a professional narrative', () => {
    // 'retina specialist' in an EMPLOYER name graded an ordinary new
    // appointment as reason 152. There is no lexical way to tell that from a
    // patient who needs to see one, so this path stops guessing: reason 152 has
    // been used ONCE in 90 days, and trading it away removes a whole class of
    // mislabelled Hub tickets. detectCrossQueue's own specialist read is
    // untouched — that is the patient path, and #99 territory.
    const r = schedulingRedirectForStatedIntent(
      'new', 'Coordinator at Example Retina Specialist, booking a routine exam.', 18,
    );
    expect(r?.departmentId).toBe(9);
    expect(r?.requestReasonId, 'the plain new-appointment reason').toBe(146);
  });
});
