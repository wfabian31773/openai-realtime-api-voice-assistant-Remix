/**
 * THE PCP LINE'S CENTRAL TOOL WAS INVISIBLE.
 *
 * Operator, 2026-08-14: "still bad, pull the last two calls to the pcp line."
 * I pulled them, and on CAf00cfcb4 the timeline said this, nine times:
 *
 *     {"tool":"record_pcp_intake","args":{},"outcome":{}}
 *
 * Not because the model called it empty — because every argument
 * record_pcp_intake takes is an identifier, so the allow-list dropped all of
 * them, and the PcpDirectorDecision it returns had none of its keys in the
 * outcome list either. Nine empty records is indistinguishable from nine
 * useless calls, and I could not tell the operator which he had.
 *
 * That is the whole diagnosis on a line where the complaint is "it asked me my
 * name twice". Answering it needs three things per call, and no more:
 *
 *   - the NAMES of the fields the model recorded  (not the values)
 *   - the field the director asked for next        (not the wording)
 *   - the policy verdict                           (disposition, may it end)
 *
 * These tests pin that, and pin just as hard what must never appear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));

const { recordToolEvent, getAzulTimeline } = await import('./toolTimeline');

const ctx = { agentSlug: 'pcp' };
let n = 0;
const freshCall = () => `CAtelemetry${++n}`;

const eventFor = (callId: string) => getAzulTimeline(callId)![0];

describe('what record_pcp_intake was told', () => {
  it('records the field NAMES and never the values', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      {
        callerName: 'Dr Joseph Perez',
        callerOrganization: 'De La Pena Medicine Group',
        callbackNumber: '+18455317471',
        patientFirstName: 'Wayne',
        patientLastName: 'Fabian',
        patientDob: '1973-03-17',
      },
      JSON.stringify({}),
      12,
      ctx,
    );

    const { args } = eventFor(callId);
    expect(args.recorded).toEqual([
      'callerName', 'callerOrganization', 'callbackNumber',
      'patientFirstName', 'patientLastName', 'patientDob',
    ]);
    expect(args.recordedCount).toBe(6);
    expect(args.empty).toBe(false);

    // The values themselves must be nowhere in the record. Serialize the whole
    // thing and look: a substring check catches a value that slipped into a
    // key we did not think about.
    const serialized = JSON.stringify(args);
    for (const secret of ['Perez', 'De La Pena', '8455317471', 'Wayne', 'Fabian', '1973-03-17']) {
      expect(serialized, `LEAKED: ${secret}`).not.toContain(secret);
    }
  });

  it('says so, unambiguously, when it was called with nothing', () => {
    // The question I could not answer from CAf00cfcb4's nine `{}` events.
    const callId = freshCall();
    recordToolEvent(callId, 'record_pcp_intake', {}, JSON.stringify({}), 3, ctx);

    const { args } = eventFor(callId);
    expect(args.empty).toBe(true);
    expect(args.recorded).toEqual([]);
    expect(args.recordedCount).toBe(0);
  });

  it('does not count a field the model sent as empty string or null', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      { callerName: '', callerRole: null, callPurpose: 'peer_to_peer' } as never,
      JSON.stringify({}),
      3,
      ctx,
    );
    expect(eventFor(callId).args.recorded).toEqual(['callPurpose']);
  });

  it('keeps callPurpose and callerFacilityType in full — they name a desk, not a person', () => {
    // Closed enums, and the two values that decide where the request lands.
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      { callPurpose: 'peer_to_peer', callerFacilityType: 'referring_provider', callerName: 'Dr Chen' },
      JSON.stringify({}),
      5,
      ctx,
    );
    const { args } = eventFor(callId);
    expect(args.callPurpose).toBe('peer_to_peer');
    expect(args.callerFacilityType).toBe('referring_provider');
    expect(args.callerName).toBeUndefined();
  });

  it('leaves every other tool’s arguments exactly as they were', () => {
    // The allow-list is the safety mechanism for the whole fleet. Widening it
    // for PCP must not widen it for anyone else.
    const callId = freshCall();
    recordToolEvent(
      callId,
      'create_ticket',
      { first_name: 'Wayne', last_name: 'Fabian', callback_number: '8455317471' },
      JSON.stringify({ success: true }),
      8,
      { agentSlug: 'answering-service' },
    );
    const { args } = eventFor(callId);
    expect(args.hasPatientName).toBe(true);
    expect(args.hasCallbackNumber).toBe(true);
    expect(args.recorded).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain('Fabian');
  });
});

describe('what the director answered', () => {
  it('records the field asked for next, and the policy verdict', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      { callerName: 'Dr Perez' },
      JSON.stringify({
        nextQuestion: { field: 'callerRole', prompt: 'What is your role?' },
        disposition: 'CREATE_TASK',
        phiDisclosureAllowed: true,
        authoritativeToolAllowed: false,
        handoffEligible: false,
        mustCreateFallbackTicket: false,
        mayTerminate: false,
      }),
      9,
      ctx,
    );

    const { outcome } = eventFor(callId);
    expect(outcome.nextField).toBe('callerRole');
    expect(outcome.disposition).toBe('CREATE_TASK');
    expect(outcome.handoffEligible).toBe(false);
    expect(outcome.mayTerminate).toBe(false);
  });

  it('never stores the WORDING of the question', () => {
    /**
     * `prompt` is fixed text from PROMPTS today. It is also the one field a
     * later change could make quote the caller back to themselves — "you said
     * Riverside, is that right?" — and by then nobody would revisit this file.
     * The field NAME is the diagnostic. Store only that.
     */
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      {},
      JSON.stringify({ nextQuestion: { field: 'patientDob', prompt: "What is the patient's date of birth?" }, mayTerminate: false }),
      4,
      ctx,
    );
    const { outcome } = eventFor(callId);
    expect(outcome.nextField).toBe('patientDob');
    expect(JSON.stringify(outcome)).not.toContain('date of birth');
  });

  it('marks the intake COMPLETE distinguishably from a missing verdict', () => {
    // nextField null means "the director stopped asking" — the moment the
    // agent is supposed to stop interviewing and act. It has to be a value,
    // not an absence, or it reads the same as a tool that returned nothing.
    const callId = freshCall();
    recordToolEvent(
      callId,
      'record_pcp_intake',
      { callPurpose: 'peer_to_peer' },
      JSON.stringify({ disposition: 'HAND_OFF', handoffEligible: true, mayTerminate: false, phiDisclosureAllowed: true, authoritativeToolAllowed: true, mustCreateFallbackTicket: false }),
      6,
      ctx,
    );
    const { outcome } = eventFor(callId);
    expect(outcome).toHaveProperty('nextField', null);
    expect(outcome.handoffEligible).toBe(true);
  });

  it('leaves an unrelated tool result untouched', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', {}, JSON.stringify({ success: true, ticket_number: 'VA-51559' }), 7, ctx);
    const { outcome } = eventFor(callId);
    expect(outcome.ticket_number).toBe('VA-51559');
    expect(outcome).not.toHaveProperty('nextField');
  });
});

describe('the whole point: the sequence is now readable', () => {
  it('shows an agent re-asking a field the director had already been given', () => {
    /**
     * CAf00cfcb4, reconstructed. Turn 2 the caller gave his name; turn 3 the
     * agent asked for it again. With the old telemetry both events were `{}`
     * and this was unprovable from the data. Now it is a two-line read.
     */
    const callId = freshCall();
    recordToolEvent(callId, 'record_pcp_intake', { callerName: 'Wayne Fabian' },
      JSON.stringify({ nextQuestion: { field: 'callerRole', prompt: 'What is your role?' }, mayTerminate: false }), 5, ctx);
    recordToolEvent(callId, 'record_pcp_intake', { callerName: 'Wayne Fabian' },
      JSON.stringify({ nextQuestion: { field: 'callerRole', prompt: 'What is your role?' }, mayTerminate: false }), 5, ctx);

    const events = getAzulTimeline(callId)!;
    // Same field recorded twice, director asking for the same thing twice —
    // the agent never asked what it was told to ask.
    expect(events.map((e) => (e.args as any).recorded)).toEqual([['callerName'], ['callerName']]);
    expect(events.map((e) => (e.outcome as any).nextField)).toEqual(['callerRole', 'callerRole']);
  });
});
