/**
 * THE ACCEPTANCE INSTRUMENT: THE PCP LINE'S FIRST FULL DAY, REPLAYED.
 *
 * Wayne, 2026-09-15: *"If we run the same transcripts through our process,
 * they must pass our tests to clear them."*
 *
 * This is that test. The corpus below is the calls that FAILED on 2026-09-14
 * — every one identified by its real `call_sid`, every caller line taken from
 * `call_logs.transcript` rather than invented — and each case asserts the
 * outcome the caller should have got. It goes green only with all six fixes
 * of 2026-09-15 present (#300, #301, #302, #303, #304, #306), which is why it
 * lives on the branch that carries all six.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT. It does not run the model, so it is not a claim about
 * what the model will SAY.
 *
 * AND IT CANNOT USE THE MODEL'S OWN WORDS, which is worth knowing before
 * trusting it further than it goes: `voice_agent_api_logs.request_body`
 * stores every `narrative` as the literal string `[REDACTED - stored
 * securely]`, so the sentences the model actually sent on 2026-09-14 are not
 * recoverable. The `callPurpose` column is NOT redacted, and it is what
 * grounds the replay — `patient_caller` on all 17, `service_inquiry` on
 * CAd77ba25e, `outside_referral_status` on CA7a268e03, read from the table.
 * The narrative wording below is therefore MINE, and a case that turns on
 * narrative PHRASING is a fact about my phrasing (see the two known misses at
 * the end of this file, left unfixed for exactly that reason).
 *
 * So what this replays is the caller's own words, the purpose the model
 * actually recorded, and the tool sequence those produced — against today's
 * code. It catches a regression in the gate, the copy, the routing or the
 * floor, and it cannot catch a regression in the prompt. The prompt has its own pinning
 * suites (`intakeScript.test.ts`, `queueIsAChoice.test.ts`,
 * `recordingDisclosure.test.ts`).
 *
 * THE HEADLINE NUMBER IS THE LAST TEST IN THE FILE: of the 17 calls that
 * produced no record of any kind, zero may still do so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PHI. Caller NAMES and PHONE NUMBERS spoken on these calls are replaced with
 * synthetic ones; `call_sid`s and the callers' request wording are real. That
 * is not a loss of fidelity for what this file tests — every code path here
 * reads the SHAPE of an utterance (is there a name at all, is this an ask for
 * a person, does a date parse) and never its content. Where a real name
 * mattered to a case, the case says so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TICKETING MOCK VALIDATES LIKE THE DEPLOYED APP, and that is the part
 * that earns this file its name. The 17 were not lost in this repo: the
 * agent POSTed correctly and the ticketing app answered HTTP 400
 * ["Validation failed"] because its `PCP_CALL_PURPOSE_SLUGS` held 18 of the
 * agent's 19 — `patient_caller` was missing. A mock that accepts everything
 * would have been green on 2026-09-14 while 17 callers got nothing. So the
 * mock below carries the app's real slug list, and the pair is tested rather
 * than our half of it.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/** Weekday morning Pacific — `isLunchClosure()` would otherwise turn
 *  `eligibleByAsk` off for one hour a day and make this file flaky. */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T20:30:00Z'));
});
afterAll(() => vi.useRealTimers());

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

/**
 * The ticketing app's accepted call purposes.
 *
 * Copied from `ticketing-app/lib/pcp/call-purposes.ts` (`PCP_CALL_PURPOSE_SLUGS`)
 * after ticketing-app #267 added `patient_caller`. It is a copy across a repo
 * boundary and there is no way to import it — so the drift check below
 * re-derives the agent's own list and fails if the two disagree, which is the
 * check that would have caught 2026-09-14 the morning it shipped.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `unclassified_call` IS A SHIP-ORDER DEPENDENCY, NOT A FREE ADDITION.
 *
 * It is on this list because ticketing-app #270 adds it. That PR MUST BE
 * DEPLOYED BEFORE this repo's `unclassified_call` reaches production: the
 * app's list is a `z.enum`, and a slug the agent sends that the app does not
 * declare is refused with HTTP 400 — which is the precise mechanism that
 * turned 17 requests into nothing on 2026-09-14.
 *
 * The exposure is bounded and worth stating exactly: the calls that would
 * carry this slug file NOWHERE today, because the sweep's `callPurpose` gate
 * turns them away before any POST. So shipping out of order costs those calls
 * nothing they are not already losing — but it silently buys nothing either,
 * and a green suite here would say otherwise. Hence this paragraph rather
 * than a bare list entry.
 */
const APP_ACCEPTS = new Set([
  'schedule_appointment', 'reschedule_appointment', 'cancel_appointment',
  'notify_referral_approval', 'check_patient_scheduled', 'check_patient_kept_appointment',
  'outside_referral_status', 'accessibility_survey', 'new_patient_survey',
  'service_inquiry', 'disability_accommodation', 'provider_information',
  'plan_participation', 'health_plan_visit_inquiry', 'grievance_follow_up',
  'peer_to_peer', 'patient_medical_records_request', 'pharmaceutical_representative',
  'patient_caller',
  'unclassified_call', // ticketing-app #270 — deploy that FIRST. See above.
]);

let filed: Array<Record<string, unknown>> = [];
let seq = 0;

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(
    async (_p?: unknown): Promise<{ success: boolean; ticketNumber?: string; error?: string }> => ({
      success: true,
      ticketNumber: 'PCP-00000',
    }),
  ),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
const { PCP_REFUSALS } = await import('./refusals');
const { asksForAPerson } = await import('./explicitAsk');
const { PCP_CALL_PURPOSES } = await import('./policy');
const { pcpDirector } = await import('./director');

beforeEach(() => {
  filed = [];
  ticketing.createPcpTicket.mockReset();
  ticketing.createPcpTicket.mockImplementation(async (p: any) => {
    // The deployed app's z.enum, reproduced. An unknown slug is HTTP 400.
    if (!APP_ACCEPTS.has(p?.callPurpose)) {
      return { success: false, error: 'http_400: Validation failed' };
    }
    filed.push(p);
    return { success: true, ticketNumber: `PCP-6${String(++seq).padStart(4, '0')}` };
  });
});

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function agentFor(sid: string, callerPhone = '+16265550142') {
  return createPcpAgent((async () => ({ status: 'CONNECTED' })) as never, {
    callId: sid,
    callSid: sid,
    callerPhone,
  } as never);
}

/**
 * THE 17. Real SIDs, real caller lines, from `call_logs` on 2026-09-14.
 *
 * Every one heard "I've taken this down and I'm making sure it reaches the
 * right team" and left no ticket of any provenance — re-checked at 00:40 and
 * again at 02:15 the next morning, well past the outbox's twelve retries.
 *
 * `said` is their FIRST substantive line, which is the one the model turned
 * into a narrative. Names are synthetic (see the PHI note above); requests
 * are verbatim.
 */
const THE_SEVENTEEN: Array<{ sid: string; secs: number; said: string; note?: string }> = [
  { sid: 'CA6d7f7e0c02c3059bea9b45a94e72432a', secs: 56, said: 'Speak to representative.' },
  { sid: 'CA05443baab99c3c3d05eaa6b627fffb35', secs: 146, said: 'Speak to representative.', note: 'later gave a doctor name' },
  { sid: 'CA716aec9aee72bd405e612dda354827a3', secs: 46, said: 'Speak to representative.' },
  { sid: 'CA11230c90a231bb54c6b6d5baa8b4c4c7', secs: 51, said: 'Can you please transfer the call for the live agent?' },
  { sid: 'CAa68f46a58025c42f0d066dcc0a991d82', secs: 176, said: 'I need to speak to a representative.', note: 'health plan; said "Yes. Connect me."' },
  { sid: 'CA44303c56c265948b27cfe9590925d618', secs: 396, said: 'Speak to representative.' },
  { sid: 'CAe55e15752efb5792083b227076c0a06a', secs: 59, said: 'Speak with representative.' },
  { sid: 'CA614d9bd4647958286ca7165bb01c8e5b', secs: 77, said: 'Make an appointment.', note: 'said "Patient." — the one that is not an ask for a person' },
  { sid: 'CAc57f3082a1904bba6c8a07b423c07b09', secs: 75, said: 'Can you speak to an agent?' },
  { sid: 'CAd99ae19b5d57c6adb6e20bc0f997109b', secs: 88, said: 'Speak with representative.', note: 'then "Hurry up."' },
  { sid: 'CA357e3f34cca1b860018bcb01ce7d98b8', secs: 191, said: 'Speak to representative.' },
  { sid: 'CAdbd769dff7c58d16ecc5819fdb101c8d', secs: 54, said: 'Hi, I need to make an appointment.', note: 'gave a patient name' },
  { sid: 'CAf85c17a5c2353a45ab2ab97d777c76f2', secs: 225, said: 'Speak to someone.' },
  { sid: 'CAf09a6d36ece3b709d7437baee5587cc7', secs: 362, said: 'Speak to a operator.', note: 'the call that made `operator` a measured addition to HUMAN_NOUNS' },
  { sid: 'CA0cecc9296e4d69f7a25ad037b4e983e5', secs: 368, said: 'Live representative.' },
  { sid: 'CA35e0c8f9f427973b679180a6d692d49f', secs: 38, said: 'Speak to agent.' },
  { sid: 'CA87f18e6bb7e5de46eefe359b1ca81b4c', secs: 54, said: 'Um, can I speak to somebody please?', note: 'gave a name and a callback number' },
];

/**
 * How the model narrated each of these on the day: a patient (no organisation
 * stated) who asked for a person. `patient_caller` is the purpose every one of
 * the 17 POSTs actually carried — read from `voice_agent_api_logs`, not
 * assumed.
 */
async function replayAsItHappened(sid: string, said: string) {
  /**
   * EACH REPLAY IS A FRESH CALL, and this line is here because leaving it out
   * made the suite lie to me.
   *
   * `pcpDirector` is module-level state keyed on the call id, and the sweep is
   * the only thing that clears it. So replaying the same SID in two arms — the
   * app accepting, then the app refusing — carried `dispositionRecorded: true`
   * from the first into the second, and `sweepPcpUnfiledCall` exited on its
   * very first line, silently. Fourteen assertions about the teardown floor
   * were measuring a sweep that never ran.
   *
   * Reusing the real SID is the point of this file, so the state gets reset
   * rather than the identifier changed.
   */
  pcpDirector.clear(sid);
  const agent = agentFor(sid);
  await call(agent, 'record_pcp_intake', { callPurpose: 'patient_caller' });
  const r = await call(agent, 'handoff_to_pcp', { narrative: `Caller said: ${said}` });
  return { agent, r };
}

describe('the 17 lost requests, replayed call by call', () => {
  for (const c of THE_SEVENTEEN) {
    it(`${c.sid.slice(0, 12)} (${c.secs}s) leaves a record: "${c.said}"`, async () => {
      const { agent, r } = await replayAsItHappened(c.sid, c.said);

      // The rule is not "never say it was taken down" — the sibling refusal
      // reached when the filing SUCCEEDS may say exactly that, and should.
      // The rule is that the sentence must be TRUE. My first version of this
      // assertion forbade the phrase outright and went red against correct
      // behaviour, which is the shape this whole file exists to catch.
      const spoken = String(r?.say ?? '');
      if (/taken this down|reaches the right team|will follow up/i.test(spoken)) {
        expect(filed.length, 'told the caller it was recorded, and it was not').toBeGreaterThan(0);
      }

      // And the request exists somewhere: filed in the turn, or filed by the
      // teardown floor. `sweepPcpUnfiledCall` is the backstop, so run it the
      // way the runtime does — after the call.
      if (filed.length === 0) await sweepPcpUnfiledCall(c.sid);
      expect(filed.length, 'the request left no record at all — this is 2026-09-14').toBeGreaterThan(0);
    });
  }
});

describe('what the ticketing app answers is part of the test', () => {
  it('accepts patient_caller — the slug whose absence cost the 17', async () => {
    await replayAsItHappened('CA6d7f7e0c02c3059bea9b45a94e72432a', 'Speak to representative.');
    expect(filed.map((f) => f.callPurpose)).toContain('patient_caller');
  });

  /**
   * THE DRIFT CHECK. The 400s were not a bug in either codebase — they were
   * the two lists disagreeing, and nothing compared them. This does.
   */
  it('the app takes every purpose the agent can send', () => {
    const agentSends = PCP_CALL_PURPOSES.map((p: { slug: string }) => p.slug);
    const rejected = agentSends.filter((s: string) => !APP_ACCEPTS.has(s));
    expect(rejected, 'the agent can send a purpose the ticketing app will 400').toEqual([]);
  });

  it('and an unknown purpose is still refused, so the mock is not a rubber stamp', async () => {
    const r = await ticketing.createPcpTicket({ callPurpose: 'not_a_real_purpose' } as never);
    expect(r.success).toBe(false);
  });
});

/**
 * The four calls that failed in their own distinct ways. Each is named in
 * CLAUDE.md's marker table; each is pinned here against its own SID so the
 * table and the suite cannot drift apart.
 */
describe('the named calls of 2026-09-14', () => {
  /**
   * A VP of Partnerships at an ambulatory surgery centre, 86 seconds, a
   * COMPLETE professional intake, filed as `service_inquiry` — and refused a
   * transfer, to an entity who asked, which the operator's 2026-09-04 rule
   * entitles to a person. He asked twice.
   */
  it('CAd77ba25e — his second ask, "Representative?", is now an ask', () => {
    expect(asksForAPerson('Caller asked for a representative.')).toBe(true);
  });

  /**
   * HIS FIRST ASK IS STILL NOT ONE, ON PURPOSE. "Speak to your surgery
   * coordinator" reaches `coordinator`, which is deliberately absent from
   * HUMAN_NOUNS: over the same 170 calls, `coordinator` appears 24 times and
   * 23 of them are the caller's own job title, answering "What is your role?"
   * — the #99 shape, where a caller's EMPLOYER misrouted their ticket. Adding
   * it would buy one call in 170 and put a job title one step from a dial.
   * Pinned so a future widening is a decision rather than an accident.
   */
  it('CAd77ba25e — and "surgery coordinator" is still not one, by measurement', () => {
    expect(asksForAPerson('Caller asked to speak to your surgery coordinator.')).toBe(false);
  });

  it('CA7a268e03 — a doctor asking for the operator is an ask', () => {
    expect(asksForAPerson('Caller asked for the operator.')).toBe(true);
    expect(asksForAPerson('Caller asked us to put them through to the operator.')).toBe(true);
  });

  /**
   * TWO NARRATIONS THIS FILE FOUND AND DELIBERATELY DOES NOT FIX.
   *
   * Both reach a human noun by a verb frame `asksForAPerson` does not carry:
   *
   *     "Caller asked to be put through to the operator."   <- passive, no pronoun
   *     "Caller said: Let me have the operator."            <- verbatim quotation
   *
   * They surfaced because MY harness invents the narrative (see the header —
   * the real ones are redacted at rest), so they are facts about my phrasing,
   * not about production. Widening the rule on that evidence would be adding
   * a verb frame, on a guess, to the boolean that ends in a real dial into a
   * queue staffed by three or four people — and the passive form is the
   * `transferred` case the module already declines by name, because "records
   * were put through to the office" narrates something that HAPPENED.
   *
   * Recorded here so the next reader finds the analysis rather than the gap.
   */
  it('two narration shapes are known misses, and stay misses until measured', () => {
    expect(asksForAPerson('Caller asked to be put through to the operator.')).toBe(false);
    expect(asksForAPerson('Caller said: Let me have the operator.')).toBe(false);
  });

  it('CA02f7febc — the queue choice ends on one proposition, so "Me." cannot happen', async () => {
    const { QUEUE_CHOICE_WARNING } = await import('./queueChoice');
    const closing = QUEUE_CHOICE_WARNING.trim().split(/(?<=[.?])\s+/).pop() ?? '';
    // One question, and it is answerable yes or no — the field behind it is a
    // boolean. The old wording offered two verb phrases and got a pronoun.
    expect(closing).toMatch(/\?$/);
    expect(closing, 'an either/or cannot fill a boolean').not.toMatch(/\bor\b/i);
  });

  it('CA02f7febc — and silence is still not consent', async () => {
    const { readQueueChoice } = await import('./queueChoice');
    expect(readQueueChoice(undefined)).toBe('not_established');
  });
});

/**
 * THE SECOND ARM: THE SAME 17, WITH THE FILING FAILING.
 *
 * MUTATION TESTING PUT THIS BLOCK HERE, and the reason is worth more than the
 * block. The first version of this file replayed the corpus only against a
 * ticketing app that ACCEPTS `patient_caller` — the post-#267 world. Three
 * mutations survived it: reverting the refusal copy to the sentence that cost
 * us the 17, and reverting the teardown floor to "no name, no ticket", and
 * both survived for the same reason. When the POST succeeds, the failure arm
 * is never entered, so the file was green on a code path it never ran.
 *
 * That is the sink-versus-source trap this repo logs as failure mode 10,
 * committed inside the suite written to prove the fixes. The suite had to be
 * mutated to find it.
 *
 * THE CAUSE OF THE NEXT FAILURE WILL NOT BE #267. It is closed. It will be a
 * timeout, an outage, or a schema that drifts again — and the point of the
 * copy fix and the floor is that the caller is not lied to and the request is
 * not lost WHATEVER the cause. So this arm fails the POST without saying why,
 * which is the honest shape of an unknown future failure.
 */
describe('the same 17, with the ticketing app refusing', () => {
  beforeEach(() => {
    ticketing.createPcpTicket.mockImplementation(async () => ({
      success: false,
      error: 'http_500: upstream unavailable',
    }));
  });

  /**
   * THE COPY RULE COVERS ALL 17. Whatever the caller said, and whatever the
   * filing did, they are never told it was recorded when it was not.
   */
  for (const c of THE_SEVENTEEN) {
    it(`${c.sid.slice(0, 12)} is not told it was filed`, async () => {
      const { r } = await replayAsItHappened(c.sid, c.said);
      expect(String(r?.say ?? ''), 'the sentence 17 callers heard').not.toMatch(
        /taken this down|reaches the right team|will follow up/i,
      );
    });
  }

  /**
   * THE FLOOR COVERS 14 OF THE 17, AND THE OTHER THREE ARE NAMED HERE RATHER
   * THAN QUIETLY EXCLUDED.
   *
   * `sweepPcpUnfiledCall` admits a call whose explicit, latched ask for a
   * person went unhonoured — deliberately narrow, because filing on every
   * unidentified call is azul's 2026-07-28 sweep, where 9 of 12 spurious
   * tickets were callbacks for patients already helped. So it files for the
   * 14 whose words are an ask for a person and not for the three below, and
   * the honest thing is to list them:
   *
   *   CA614d9bd4  "Make an appointment."           <- a request, but not for a
   *   CAdbd769df  "Hi, I need to make an           <- person; they gave a name,
   *                appointment."                      so `toldUsSomething`
   *                                                   carries them instead
   *   CA0cecc929  "Live representative."           <- WAS a third miss. It is
   *                                                   an ask now: see the
   *                                                   A_REAL_PERSON phrase
   *                                                   family, which this file
   *                                                   is what found.
   *
   * On the happy arm all three file through the tool, so none of them is lost
   * today. This block is about what survives a filing OUTAGE, which is a
   * strictly smaller set — and saying so is the difference between an
   * instrument and a reassurance.
   */
  const NOT_AN_ASK_FOR_A_PERSON = new Set([
    'CA614d9bd4647958286ca7165bb01c8e5b',
    'CAdbd769dff7c58d16ecc5819fdb101c8d',
  ]);

  for (const c of THE_SEVENTEEN.filter((x) => !NOT_AN_ASK_FOR_A_PERSON.has(x.sid))) {
    it(`${c.sid.slice(0, 12)} still reaches the teardown floor`, async () => {
      await replayAsItHappened(c.sid, c.said);
      const before = ticketing.createPcpTicket.mock.calls.length;
      await sweepPcpUnfiledCall(c.sid);
      expect(
        ticketing.createPcpTicket.mock.calls.length,
        'the sweep did not even try — the request is gone',
      ).toBeGreaterThan(before);
    });
  }

  /**
   * And the two that the floor does NOT cover are asserted as not covered, so
   * a future widening of the sweep is a decision someone makes on purpose
   * rather than a line that quietly starts passing.
   */
  for (const sid of NOT_AN_ASK_FOR_A_PERSON) {
    const c = THE_SEVENTEEN.find((x) => x.sid === sid)!;
    it(`${sid.slice(0, 12)} is outside the floor, on purpose: "${c.said}"`, async () => {
      await replayAsItHappened(c.sid, c.said);
      const before = ticketing.createPcpTicket.mock.calls.length;
      await sweepPcpUnfiledCall(c.sid);
      expect(ticketing.createPcpTicket.mock.calls.length).toBe(before);
    });
  }

  it('and the copy it uses asks for a number rather than claiming a record', () => {
    const say = PCP_REFUSALS.handoff_not_eligible.say ?? '';
    expect(say).toMatch(/number/i);
    expect(say).not.toMatch(/taken this down|reaches the right team/i);
  });
});

/**
 * THE NUMBER WAYNE ASKED FOR.
 *
 * Not a per-case assertion — the aggregate, stated the way the defect was:
 * "17 callers, no ticket of any provenance." Re-run the whole corpus and
 * count how many still end with nothing.
 */
describe('the headline', () => {
  it('17 calls produced no record on 2026-09-14; zero may now', async () => {
    const stillLost: string[] = [];
    for (const c of THE_SEVENTEEN) {
      filed = [];
      await replayAsItHappened(c.sid, c.said);
      if (filed.length === 0) await sweepPcpUnfiledCall(c.sid);
      if (filed.length === 0) stillLost.push(c.sid);
    }
    expect(stillLost, `${stillLost.length} of 17 still leave no record`).toEqual([]);
  });

  it('and none of them is told their request was taken down unless it was', async () => {
    const lied: string[] = [];
    for (const c of THE_SEVENTEEN) {
      filed = [];
      const { r } = await replayAsItHappened(c.sid, c.said);
      const said = String(r?.say ?? '');
      if (/taken this down|reaches the right team/i.test(said) && filed.length === 0) lied.push(c.sid);
    }
    expect(lied, 'a caller was told it was filed when nothing was').toEqual([]);
  });
});
