import { describe, it, expect, vi } from 'vitest';

// The module imports server/db at load time for the flush path; these tests
// exercise the pure recording/redaction/classification surface only.
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));

const mod = await import('./toolTimeline');
const { recordToolEvent, getAzulTimeline, classifyFleetCall, recordingExecute } = mod;

let n = 0;
const freshCall = () => `tt-test-${++n}`;

/**
 * D11 (2026-08-01). Until this change only azul recorded tool events, so on
 * 07-31 sixty answering-service calls promised the caller a callback with no
 * ticket behind it and nothing could say whether create_ticket had even been
 * attempted. These tests pin the two things that make fleet recording safe to
 * turn on: it must never persist PHI, and it must never change or break the
 * tool it wraps.
 */

const TICKET_ARGS = {
  department_id: 2,
  request_type_id: 7,
  request_reason_id: 3,
  priority: 'high',
  first_name: 'Paula',
  last_name: 'Kolterman',
  middle_initial: 'J',
  date_of_birth: '1952-08-29',
  callback_number: '+17605551234',
  email: 'paula@example.com',
  subject: 'Needs a refill on her drops',
  description: 'Caller says she is out of her glaucoma drops and her surgeon is Dr. Logan.',
  unresolved_info: 'caller does not know which office she was seen at',
};

describe('PHI discipline — the allow-list is the safety mechanism', () => {
  it('persists routing fields and NOT one identifier or free-text field', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, JSON.stringify({ success: true, ticket_number: 'T-1234' }), 12, {
      agentSlug: 'answering-service',
    });
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args).toMatchObject({ department_id: 2, request_type_id: 7, request_reason_id: 3, priority: 'high' });
    for (const banned of [
      'first_name', 'last_name', 'middle_initial', 'date_of_birth',
      'callback_number', 'email', 'subject', 'description', 'unresolved_info',
    ]) {
      expect(ev.args).not.toHaveProperty(banned);
    }
    // and nothing leaks through stringification either
    const blob = JSON.stringify(ev);
    for (const secret of ['Paula', 'Kolterman', '1952-08-29', '7605551234', 'glaucoma', 'Logan', 'paula@example.com']) {
      expect(blob).not.toContain(secret);
    }
  });

  /**
   * THE THREE SHAPES OF `identity_is_certain: false` ARE SEPARABLE (CLAUDE.md,
   * the v28 row): found nobody, found one unconfirmed person, found SEVERAL.
   * Only the last carries `candidate_count`, and `found` splits the first
   * from the other two. Without both the 2026-09-16 worksheet could not say
   * how many of 33 date-of-birth refusals behind a matched lookup came from
   * the ambiguous branch, and a fix was reverted for want of the number.
   */
  it('keeps found and candidate_count on a lookup outcome, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'lookup_patient',
      { first_name: 'Paula', last_name: 'Kolterman' },
      JSON.stringify({
        success: true,
        found: false,
        identity_is_certain: false,
        candidate_count: 3,
        message: 'Ask for their full name and date of birth',
        candidates: [{ first_name: 'Paula', last_name: 'Kolterman', date_of_birth: '1952-08-29' }],
      }),
      40,
      { agentSlug: 'optical' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ found: false, identity_is_certain: false, candidate_count: 3 });
    expect(ev.outcome).not.toHaveProperty('candidates');
    expect(ev.outcome).not.toHaveProperty('message');
    expect(JSON.stringify(ev)).not.toContain('1952-08-29');
  });

  /**
   * AND WHAT THE CARRY-FORWARD WRITE DID (W1, docs/observatory/SPEC-20260923.md).
   *
   * All three of `rememberVerifiedIdentity`'s early returns leave the store
   * EMPTY, so `identityStoreProbe` reporting `storeSize: 0` cannot tell a
   * refused write from one that never ran — 623 consecutive calls on 09-22 read
   * exactly that. Without this key the question stays unanswerable from SQL,
   * which is the v28/v48 mistake one more time.
   */
  it('keeps identity_write on a lookup outcome, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'lookup_patient',
      { first_name: 'Paula', last_name: 'Kolterman' },
      JSON.stringify({
        success: true,
        found: true,
        identity_is_certain: true,
        identity_write: 'refused_sid',
        patient_name: 'Paula Kolterman',
      }),
      40,
      { agentSlug: 'optical' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ identity_write: 'refused_sid' });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v87: the one-call-one-ticket guard is countable. A second filing on a call
   * already filed through create-ticket answers `alreadyFiled: true` and posts
   * nothing — without this key that is a console line no query can find.
   */
  it('keeps alreadyFiled on a filing outcome, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'create_pcp_task',
      { narrative: 'Patient Paula Kolterman asking about a refill.' },
      JSON.stringify({ success: true, alreadyFiled: true, ticketNumber: 'VA-1', guidance: 'already filed' }),
      5,
      { agentSlug: 'pcp' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ alreadyFiled: true });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v204: a PCP filing refused because the caller asked only for a person is
   * countable — which step it was, and whether the ask had latched.
   */
  it('keeps noRequestAsk and askLatched on a refused PCP filing, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'handoff_to_pcp',
      { narrative: 'Caller Paula Kolterman asked to speak with the staff.' },
      JSON.stringify({ success: false, error: 'handoff_not_eligible_no_request', refused: 'no_request_stated', noRequestAsk: 'ask', askLatched: false }),
      5,
      { agentSlug: 'pcp' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ refused: 'no_request_stated', noRequestAsk: 'ask', askLatched: false });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v103: a records filing routed out of Medical Records is countable. Without
   * the key the only trace is a transcript line naming another team.
   */
  /**
   * v232: how often the call's own words, not the model, carried the records
   * method or destination to the ticket is a count, and nothing else rides.
   */
  it('keeps method_heard and send_to_heard on a records filing, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'file_records_ticket',
      { description: 'Paula Kolterman wants her chart faxed.' },
      JSON.stringify({ success: true, ticket_number: 'VA-1', method_heard: true, send_to_heard: 'stated' }),
      5,
      { agentSlug: 'records' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ method_heard: true, send_to_heard: 'stated' });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  it('keeps form_applies on a records filing, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'file_records_ticket',
      { description: 'Paula Kolterman wants to confirm tomorrow.' },
      JSON.stringify({ success: true, ticket_number: 'VA-1', routed_to: 'HVA Hub', form_applies: false }),
      5,
      { agentSlug: 'records' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ form_applies: false });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v153: a repeat filing on a call that already filed is countable, and so
   * is whether what it carried reached the ticket.
   */
  it('keeps already_filed and details_added on a repeat filing, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'file_tech_ticket',
      { description: 'Paula Kolterman also wants a text when it is ready.' },
      JSON.stringify({ success: true, ticket_number: 'VA-1', already_filed: true, details_added: true }),
      5,
      { agentSlug: 'tech' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ already_filed: true, details_added: true });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v127: a records filing the app refused and the tool logged as a recovery
   * ticket is countable. Without the key it reads as an ordinary filing.
   */
  it('keeps recovered_after_refusal on a records filing, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'file_records_ticket',
      { description: 'Paula Kolterman wants her chart.' },
      JSON.stringify({ success: true, ticket_number: 'VA-1', recovered_after_refusal: true, form_applies: false }),
      5,
      { agentSlug: 'records' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ recovered_after_refusal: true, form_applies: false });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v218: how a booking picked its slot, and whether the pre-v218 rule (the
   * option in the last list) would have booked another, are countable.
   */
  it('keeps booked_by and option_disagreed on a booking, and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'book_sooner_exam',
      { date: '2041-02-05', time: '10:00', option: '2' },
      JSON.stringify({ success: true, booked: true, booked_by: 'date_time', option_disagreed: true, patient: 'Paula Kolterman' }),
      5,
      { agentSlug: 'npx-outreach' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ booked_by: 'date_time', option_disagreed: true });
    expect(JSON.stringify(ev)).not.toContain('Kolterman');
  });

  /**
   * v229: what book_sooner_exam received is countable (fixed words, never
   * the values), and the choices a refusal writes out are not kept.
   */
  it('keeps the received_* words on a booking refusal, and not the choices it wrote out', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'book_sooner_exam',
      { option: '1' },
      JSON.stringify({
        success: false,
        error: 'which_list',
        received_date: 'none',
        received_time: 'none',
        received_option: true,
        choices: [{ date: '2041-02-13', time: '09:00', city: 'Beaumont' }],
      }),
      5,
      { agentSlug: 'npx-outreach' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ error: 'which_list', received_date: 'none', received_time: 'none', received_option: true });
    expect(ev.outcome).not.toHaveProperty('choices');
  });

  it('keeps records_work on a records filing (v225), and still nothing about who', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'file_records_ticket',
      { request_description: 'I need to correct my medical records', first_name: 'Testpatient', last_name: 'Example' },
      JSON.stringify({ success: true, ticket_number: 'VA-1', records_work: 'amendment', form_applies: false, patient: 'Testpatient Example' }),
      5,
      { agentSlug: 'records' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ records_work: 'amendment', form_applies: false });
    expect(JSON.stringify(ev)).not.toContain('Testpatient');
  });

  /**
   * v75: WHICH language a switch went TO is countable. 574 switch events in
   * the fourteen days to 2026-09-27 and not one said; 76 of them were on
   * calls with no Spanish cue — the worst filing arm — and nothing could say
   * what they were. The tag is the normaliser's output, never the caller's
   * word for it (which is the argument, and stays dropped).
   */
  it('keeps the language a set_spoken_language switch went to, not the word the caller used', () => {
    const callId = freshCall();
    recordToolEvent(
      callId,
      'set_spoken_language',
      { language: 'Spanish, please, my mother does not speak English' },
      JSON.stringify({ success: true, language: 'es', message: 'Now speaking es. Continue in that language.' }),
      1,
      { agentSlug: 'no-ivr' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome).toMatchObject({ language: 'es' });
    expect(JSON.stringify(ev)).not.toContain('my mother');
  });

  it('keeps the diagnostic signal as booleans instead of the caller\'s words', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, '{}', 1, { agentSlug: 'answering-service' });
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args.hasUnresolvedInfo).toBe(true);
    expect(ev.args.hasPatientName).toBe(true);
    expect(ev.args.hasCallbackNumber).toBe(true);
  });

  it('drops unknown argument keys by default, so a new tool leaks nothing', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'some_future_tool', { ssn: '123-45-6789', freeText: 'anything' }, '{}', 1, {
      agentSlug: 'answering-service',
    });
    expect(JSON.stringify(getAzulTimeline(callId))).not.toContain('123-45-6789');
  });

  it('records the ticket number — the field D11 actually turns on', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, JSON.stringify({ success: true, ticket_number: 'T-9001' }), 5, {
      agentSlug: 'answering-service',
    });
    expect(getAzulTimeline(callId)![0].outcome).toMatchObject({ success: true, ticket_number: 'T-9001' });
  });

  /**
   * WHICH refusal it was, without the birthday.
   *
   * `missingFields: ["date_of_birth"]` names two opposite failures: the model
   * sent no date, or it sent one the parser would not take. On 2026-09-03 that
   * ambiguity cost the diagnosis of a live surgery call refused four times for
   * a date the caller had confirmed back to the agent — the timeline recorded
   * `"args": {}` because date_of_birth is (correctly) not on the allow-list.
   */
  it('records the SHAPE of a refused date of birth, and never the date', () => {
    const callId = freshCall();
    recordToolEvent(
      callId, 'file_surgery_ticket', { ...TICKET_ARGS, date_of_birth: '5 8 39' },
      JSON.stringify({ success: false, missingFields: ['date_of_birth'] }), 5,
      { agentSlug: 'surgery' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args.dobShape).toBe('# # ##');
    expect(JSON.stringify(ev)).not.toContain('5 8 39');
  });

  it('tells "the model sent nothing" apart from "the parser refused it"', () => {
    const noDate = freshCall();
    recordToolEvent(noDate, 'file_tech_ticket', { ...TICKET_ARGS, date_of_birth: '' }, '{}', 1, {
      agentSlug: 'tech',
    });
    expect(getAzulTimeline(noDate)![0].args.dobShape).toBe('(none)');

    const structured = freshCall();
    recordToolEvent(
      structured, 'file_optical_ticket', { ...TICKET_ARGS, date_of_birth: { month: 5, day: 8, year: 1939 } },
      '{}', 1, { agentSlug: 'optical' },
    );
    expect(getAzulTimeline(structured)![0].args.dobShape).toBe('(not a string)');
  });

  it('shapes the date on every filing tool, and on none of the others', () => {
    for (const tool of ['create_ticket', 'file_surgery_ticket', 'file_optical_ticket',
                        'file_tech_ticket', 'file_medical_records_ticket']) {
      const callId = freshCall();
      recordToolEvent(callId, tool, TICKET_ARGS, '{}', 1, { agentSlug: 'surgery' });
      expect(getAzulTimeline(callId)![0].args.dobShape, tool).toBe('####-##-##');
    }
    // lookup_patient takes a date of birth too, but it is not where filing is
    // refused, and every extra place a shape is written is another place to
    // check for a leak.
    const lookup = freshCall();
    recordToolEvent(lookup, 'lookup_patient', TICKET_ARGS, '{}', 1, { agentSlug: 'surgery' });
    expect(getAzulTimeline(lookup)![0].args).not.toHaveProperty('dobShape');
  });

  /**
   * v127. CA63467308b45e3e7f9118cde1b67be7bf: the caller gave both halves of
   * the name and the POST carried neither, and this table could not say
   * whether the model ever passed them. Two booleans answer it; no name.
   */
  it('says whether each half of the name reached a filing tool, and never the name', () => {
    const half = freshCall();
    recordToolEvent(
      half, 'file_records_ticket', { ...TICKET_ARGS, first_name: '  ' }, '{}', 1, { agentSlug: 'records' },
    );
    const [ev] = getAzulTimeline(half)!;
    expect(ev.args.hasFirstName).toBe(false);
    expect(ev.args.hasLastName).toBe(true);
    expect(JSON.stringify(ev)).not.toContain('Kolterman');

    const none = freshCall();
    recordToolEvent(none, 'file_optical_ticket', { request_reason_id: 3 }, '{}', 1, { agentSlug: 'optical' });
    expect(getAzulTimeline(none)![0].args).toMatchObject({ hasFirstName: false, hasLastName: false });

    // create_ticket keeps its own combined flag and does not grow these.
    const fleet = freshCall();
    recordToolEvent(fleet, 'create_ticket', TICKET_ARGS, '{}', 1, { agentSlug: 'answering-service' });
    expect(getAzulTimeline(fleet)![0].args).not.toHaveProperty('hasFirstName');
  });

  /**
   * v198. Which fields each filing tool RECEIVED, as names. The daily ticket
   * review turns on it: a field the caller said and the ticket lacks is a
   * different defect when the tool never got it than when the tool dropped it.
   */
  it('records the argument NAMES each filing tool received, and never a value', () => {
    for (const tool of [
      'create_ticket', 'create_pcp_task', 'handle_patient_medical_records_request',
      'handoff_to_pcp', 'record_automated_resolution', 'escalate_to_human', 'file_records_ticket',
    ]) {
      const callId = freshCall();
      recordToolEvent(
        callId, tool,
        { ...TICKET_ARGS, call_sid: 'CA' + '0'.repeat(32), caller_phone: '+17605550000', email: '', narrative: 'Paula Kolterman wants her chart' },
        '{}', 1, { agentSlug: 'pcp' },
      );
      const [ev] = getAzulTimeline(callId)!;
      const supplied = ev.args.supplied as string[];
      expect(supplied).toEqual(expect.arrayContaining(['first_name', 'last_name', 'date_of_birth', 'narrative']));
      // A blank value was not supplied; injected keys say nothing about the model.
      expect(supplied).not.toContain('email');
      expect(supplied).not.toContain('call_sid');
      expect(supplied).not.toContain('caller_phone');
      const blob = JSON.stringify(ev);
      for (const secret of ['Paula', 'Kolterman', '1952-08-29', '7605551234', 'chart']) {
        expect(blob).not.toContain(secret);
      }
    }
  });

  it('records no supplied names on a tool that is not a filing tool', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'lookup_patient', TICKET_ARGS, '{}', 1, { agentSlug: 'surgery' });
    expect(getAzulTimeline(callId)![0].args).not.toHaveProperty('supplied');
  });

  it('records the supplied names through recordingExecute, the path the hand-built tools take', async () => {
    const callId = freshCall();
    const run = recordingExecute({ callId, agentSlug: 'pcp' }, 'create_pcp_task', async () => ({ success: true }));
    await run({ narrative: 'something', patientFirstName: 'Paula', patientLastName: '', urgency: 'routine' });
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args.supplied).toEqual(['narrative', 'patientFirstName', 'urgency']);
    expect(JSON.stringify(ev)).not.toContain('Paula');
  });

  it('records missing FIELD NAMES on a validation failure, not their values', () => {
    const callId = freshCall();
    recordToolEvent(
      callId, 'create_ticket', TICKET_ARGS,
      JSON.stringify({ success: false, validationError: true, missingFields: ['surgeon name'] }), 5,
      { agentSlug: 'answering-service' },
    );
    expect(getAzulTimeline(callId)![0].outcome.missingFields).toEqual(['surgeon name']);
  });

  /**
   * WHY inherit failed, without the birthday. The five arms are the
   * diagnosis in PR #307. A string that is not one of them is dropped —
   * the allow-list is the safety mechanism, same as every other outcome key.
   */
  it('records carry on a date-of-birth refusal, and never a date', () => {
    const callId = freshCall();
    recordToolEvent(
      callId, 'file_surgery_ticket', TICKET_ARGS,
      JSON.stringify({
        success: false,
        missingFields: ['date_of_birth'],
        carry: 'name_mismatch',
        dateOfBirth: '03/17/1973',
        firstName: 'Wayne',
      }),
      5,
      { agentSlug: 'surgery' },
    );
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.outcome.carry).toBe('name_mismatch');
    expect(ev.outcome.missingFields).toEqual(['date_of_birth']);
    const blob = JSON.stringify(ev);
    expect(blob).not.toContain('03/17/1973');
    expect(blob).not.toContain('Wayne');
  });

  it('records the uncertain identity carry outcome', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'file_tech_ticket', TICKET_ARGS,
      JSON.stringify({ success: false, missingFields: ['date_of_birth'], carry: 'uncertain_identity' }),
      1, { agentSlug: 'tech' });
    expect(getAzulTimeline(callId)![0].outcome.carry).toBe('uncertain_identity');
  });

  it('drops a carry value outside the closed enum', () => {
    const callId = freshCall();
    recordToolEvent(
      callId, 'file_tech_ticket', TICKET_ARGS,
      JSON.stringify({ success: false, missingFields: ['date_of_birth'], carry: 'Wayne Fabian 03/17/1973' }),
      1,
      { agentSlug: 'tech' },
    );
    expect(getAzulTimeline(callId)![0].outcome).not.toHaveProperty('carry');
    expect(JSON.stringify(getAzulTimeline(callId))).not.toContain('Wayne');
  });
});

describe('classifyFleetCall — "promised and filed" vs "promised and did not"', () => {
  const ev = (tool: string, outcome: Record<string, unknown> = {}, args: Record<string, unknown> = {}) =>
    ({ at: '', tool, args, outcome, ms: 1 });

  it('records and classifies the explicit answered-without-ticket result', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute({ callId, agentSlug: 'no-ivr' }, 'create_ticket', async () => ({
      success: true, ticketCreated: false, callbackRequired: false,
      message: 'Synthetic private text',
    }));
    await wrapped({});
    const events = getAzulTimeline(callId)!;
    expect(events[0].outcome).toMatchObject({ success: true, ticketCreated: false, callbackRequired: false });
    expect(JSON.stringify(events)).not.toContain('Synthetic private text');
    expect(classifyFleetCall(events)).toEqual({ purpose: 'Answered question', result: 'Answered, no ticket needed' });
    expect(classifyFleetCall([...events, ev('terminate_call', { success: true }, { reason: 'completed' })]))
      .toEqual({ purpose: 'Answered question', result: 'Answered, no ticket needed' });
    expect(classifyFleetCall([...events, ev('create_ticket', { success: true, ticket_number: 'T-2' })]).result).toBe('Ticket filed (T-2)');
    expect(classifyFleetCall([...events, ev('create_ticket', { success: false, validationError: true })]).result).toContain('FAILED');
  });

  it('reports a filed ticket with its number', () => {
    expect(classifyFleetCall([ev('classify_request'), ev('create_ticket', { success: true, ticket_number: 'T-1' })]))
      .toEqual({ purpose: 'Patient request', result: 'Ticket filed (T-1)' });
  });

  it('distinguishes an ATTEMPTED ticket that failed validation', () => {
    const r = classifyFleetCall([ev('create_ticket', { validationError: true, missingFields: ['surgeon name'] })]);
    expect(r.result).toContain('FAILED');
    expect(r.result).toContain('surgeon name');
  });

  it('flags the D11 shape: classified the request, then never filed', () => {
    expect(classifyFleetCall([ev('lookup_schedule'), ev('classify_request')]))
      .toEqual({ purpose: 'Patient request', result: 'Classified but NO ticket created' });
  });

  it('does not call a lookup-only call a failure', () => {
    expect(classifyFleetCall([ev('lookup_schedule')]).result).toBe('Answered from lookup, no ticket');
  });

  it('reports an escalation', () => {
    expect(classifyFleetCall([ev('escalate_to_human')]).purpose).toBe('Escalation');
  });

  it('reports a terminate reason', () => {
    expect(classifyFleetCall([ev('terminate_call', {}, { reason: 'ghost_call' })]).result).toContain('ghost_call');
  });

  it('says "No tools used" for an empty timeline rather than inventing a failure', () => {
    expect(classifyFleetCall([]).result).toBe('No tools used');
  });
});

describe('recordingExecute — telemetry must never break a call', () => {
  const ctx = (callId: string) => ({ callId, agentSlug: 'answering-service' });

  it('returns the tool\'s value unchanged and records it', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute(ctx(callId), 'create_ticket', async () => ({ success: true, ticket_number: 'T-7' }));
    await expect(wrapped(TICKET_ARGS)).resolves.toEqual({ success: true, ticket_number: 'T-7' });
    expect(getAzulTimeline(callId)![0].outcome).toMatchObject({ ticket_number: 'T-7' });
  });

  it('passes a string result straight through', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute(ctx(callId), 'classify_request', async () => JSON.stringify({ department: 'Optical' }));
    await expect(wrapped({})).resolves.toBe('{"department":"Optical"}');
  });

  it('re-throws the tool\'s error unchanged, and still records the attempt', async () => {
    const callId = freshCall();
    const boom = new Error('ticketing API 500');
    const wrapped = recordingExecute(ctx(callId), 'create_ticket', async () => { throw boom; });
    await expect(wrapped(TICKET_ARGS)).rejects.toBe(boom);
    // The attempt is the point: a promised callback that died in the API is a
    // different D11 story from one the model never attempted.
    expect(getAzulTimeline(callId)![0].outcome.error).toBe('ticketing API 500');
  });

  it('survives an unserializable result rather than failing the tool', async () => {
    const callId = freshCall();
    const circular: any = {};
    circular.self = circular;
    const wrapped = recordingExecute(ctx(callId), 'lookup_schedule', async () => circular);
    await expect(wrapped({})).resolves.toBe(circular);
  });
});
