/**
 * Gate A — answering-service line vs the approved script listing (§1/§2/§6).
 * Pass bar is 100%: every scenario asserts the exact lines, the ledger at
 * each step, and that tools fire (or are structurally absent) per the
 * capability matrix. reconstruction-plan.md §5.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createAnsweringServiceLine } from './answeringServiceLine';
import type { CoreAction, ClassifyResult, TicketInput, TicketLineServices } from './types';

const TECH: ClassifyResult = { departmentId: 3, requestTypeId: 9, requestReasonId: 1, priority: 'medium', locationId: null, providerId: null };
const SURGERY: ClassifyResult = { ...TECH, departmentId: 2 };
const OPTICAL: ClassifyResult = { ...TECH, departmentId: 1 };

function fakeServices(opts: { verify?: boolean; classify?: ClassifyResult; fileOk?: boolean[] } = {}) {
  const filed: TicketInput[] = [];
  const lookups: Array<[string, string, string]> = [];
  const fileQueue = [...(opts.fileOk ?? [])];
  const svc: TicketLineServices = {
    verifyByLookup: vi.fn(async (f: string, l: string, d: string) => {
      lookups.push([f, l, d]);
      return opts.verify ?? false;
    }),
    classify: vi.fn(async () => opts.classify ?? TECH),
    fileTicket: vi.fn(async (input: TicketInput) => {
      filed.push(input);
      const ok = fileQueue.length ? fileQueue.shift()! : true;
      return ok ? { ok: true, ticketNumber: 'AS-1001' } : { ok: false, error: 'gateway 500' };
    }),
  };
  return { svc, filed, lookups };
}

/** Resolve the followUp chain the way the transport does: one spoken line per action. */
async function speak(action: CoreAction): Promise<{ lines: string[]; end: boolean; alerts: string[] }> {
  const lines: string[] = [];
  const alerts: string[] = [];
  let end = false;
  let a: CoreAction | null = action;
  while (a) {
    if (a.say) lines.push(a.say);
    if (a.alert) alerts.push(a.alert);
    if (a.endCall) end = true;
    a = a.followUp ? await a.followUp() : null;
  }
  return { lines, end, alerts };
}

const C = 'call-1';

describe('answering-service new core — Gate A', () => {
  beforeEach(() => clearAllLedgers());

  it('S1 recognized happy path: intent kept as a constant, context DOB verify, no re-ask, file, wrap', async () => {
    const { svc, filed, lookups } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    let a = await line.onUtterance(C, 'I never got my eye drop prescription refilled');
    expect(a.say).toBe('Am I speaking with Wayne?');

    a = await line.onUtterance(C, 'yes it is');
    expect(a.say).toContain('may I have your date of birth');

    a = await line.onUtterance(C, 'March 17 1973');
    // Verified against the PULLED record — the lookup service is never touched.
    expect(lookups).toHaveLength(0);
    expect(getLedger(C)!.identityVerified).toBe(true);
    expect(getLedger(C)!.firstName).toBe('Wayne');
    // The stated reason is a constant: no "what would you like the team to know"
    // re-ask — straight to the callback confirm, identity line prefixed.
    expect(a.say).toContain('Thanks, Wayne.');
    expect(a.say).toContain('Is this number ending in 7471');

    a = await line.onUtterance(C, 'yes that works');
    const spoken = await speak(a);
    expect(spoken.lines[0]).toContain('Give me one moment');
    expect(spoken.lines[1]).toContain("You're all set");
    expect(filed).toHaveLength(1);
    expect(filed[0].callbackNumber).toBe('8455317471');
    expect(filed[0].firstName).toBe('Wayne');
    expect(filed[0].description).toContain('prescription');

    a = await line.onUtterance(C, 'no that will be all');
    expect(a.say).toContain('Thanks for calling Azul Vision');
    expect(a.endCall).toBe(true);
  });

  it('S2 human request gets the busy-team line VERBATIM, every time, and never a transfer', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5551234567' });
    line.start(C);

    const busy = 'All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available.';
    let a = await line.onUtterance(C, 'let me talk to a real person');
    expect(a.say).toContain(busy);

    // A million asks, the same answer — and the flow resumes where it was.
    a = await line.onUtterance(C, 'I said I want a representative right now');
    expect(a.say).toContain(busy);
    a = await line.onUtterance(C, 'give me a human being');
    expect(a.say).toContain(busy);

    // Structurally incapable: the services surface carries no transfer at all.
    expect('transfer' in svc).toBe(false);
    expect(filed).toHaveLength(0);
  });

  it('S3 scheduling request: scheduling-team line, ticket filed, nothing booked', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    let a = await line.onUtterance(C, 'I need to schedule an appointment for my eye exam');
    expect(a.say).toContain('I can take down all the details and have our scheduling team take care of that for you');
    expect(a.say).toContain('Am I speaking with Maria?');

    a = await line.onUtterance(C, 'yes');
    a = await line.onUtterance(C, 'May 10 1983');
    a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(spoken.lines.join(' ')).toContain("You're all set");
    expect(filed).toHaveLength(1);
    expect(filed[0].description).toContain('schedule');
  });

  it('S4 new patient: details taken, verify NEVER attempted, ticket filed', async () => {
    const { svc, filed, lookups } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5559876543' });
    line.start(C);

    let a = await line.onUtterance(C, 'I want to become a patient there');
    expect(a.say).toBe('Are you calling for a new patient or an existing patient?');
    a = await line.onUtterance(C, 'a new patient');
    expect(a.say).toContain("I'll take your details");
    a = await line.onUtterance(C, 'Carlos Rivera');
    expect(a.say).toContain('date of birth');
    a = await line.onUtterance(C, 'June 2 1990');
    expect(lookups).toHaveLength(0);
    expect(a.say).toContain('ending in 6543');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].firstName).toBe('Carlos');
    expect(getLedger(C)!.newOrExisting).toBe('new');
  });

  it('S5 verify-fail ladder (unmatched caller): one retry, then the message is taken anyway', async () => {
    const { svc, filed } = fakeServices({ verify: false });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    line.start(C);

    await line.onUtterance(C, 'checking on my surgery date');
    await line.onUtterance(C, 'existing patient');
    await line.onUtterance(C, 'John Smith');
    let a = await line.onUtterance(C, 'January 5 1960');
    expect(a.say).toContain("that doesn't match what I have");
    await line.onUtterance(C, 'John Smith');
    a = await line.onUtterance(C, 'January 5 1960');
    // Second miss: never an interrogation loop — information taken, team follows up.
    expect(a.say).toContain("I'm not finding a match on my end");
    expect(getLedger(C)!.identityVerified).toBe(false);
    // Surgery intent → the surgeon question rides the same turn.
    expect(svc.classify).toHaveBeenCalled();
  });

  it('S6 recognized caller, DOB mismatch: fail ladder, NEVER the new/existing interview', async () => {
    const { svc } = fakeServices({ verify: false });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    const heard: string[] = [];
    const say = async (txt: string) => {
      const a = await line.onUtterance(C, txt);
      if (a.say) heard.push(a.say);
      return a;
    };
    await say('calling about my medication refill');
    await say('yes');
    let a = await say('March 3 1972'); // ASR-garbled date — no match
    expect(a.say).toContain("doesn't match");
    await say('Fabian');
    a = await say('March 3 1972');
    expect(a.say).toContain("not finding a match");
    // The prohibition: a recognized caller is an existing patient by definition.
    expect(heard.join(' ')).not.toContain('new patient or an existing patient');
  });

  it('S7 surgery message without a surgeon: the surgeon question, then filed with the name', async () => {
    const { svc, filed } = fakeServices({ classify: SURGERY });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Rita', matchedLastName: 'Cole', matchedDob: '1955-01-05', callerPhone: '5553334444' });
    line.start(C);

    await line.onUtterance(C, 'my cataract surgery follow up got lost');
    await line.onUtterance(C, 'yes');
    let a = await line.onUtterance(C, 'January 5 1955');
    expect(a.say).toContain('who is your surgeon');
    a = await line.onUtterance(C, 'Doctor Logan');
    expect(a.say).toContain('ending in 4444');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed[0].providerName).toContain('Logan');
    expect(filed[0].unresolvedInfo ?? null).toBeNull();
  });

  it('S7b surgeon unknown: filed anyway with the gap flagged — the request is never lost', async () => {
    const { svc, filed } = fakeServices({ classify: SURGERY });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Rita', matchedLastName: 'Cole', matchedDob: '1955-01-05', callerPhone: '5553334444' });
    line.start(C);

    await line.onUtterance(C, 'my cataract surgery follow up got lost');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'January 5 1955');
    let a = await line.onUtterance(C, "I don't know the name");
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].unresolvedInfo).toContain('surgeon');
  });

  it('S8 optical message without a location: the office question, then filed with it', async () => {
    const { svc, filed } = fakeServices({ classify: OPTICAL });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Ana', matchedLastName: 'Ruiz', matchedDob: '1990-06-02', callerPhone: '5556667777' });
    line.start(C);

    await line.onUtterance(C, 'my glasses came back with the wrong lenses');
    await line.onUtterance(C, 'yes');
    let a = await line.onUtterance(C, 'June 2 1990');
    expect(a.say).toContain('Which Azul Vision office');
    a = await line.onUtterance(C, 'West Covina');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed[0].locationName).toBe('West Covina');
  });

  it('S9 create_ticket failure: one silent retry, then the noted-line + ALERT — never a technical apology', async () => {
    const { svc, filed } = fakeServices({ fileOk: [false, false] });
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'I need my records sent over');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'March 17 1973');
    const a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(filed).toHaveLength(2); // the retry happened, silently
    const all = spoken.lines.join(' ');
    expect(all).toContain("I've noted everything and the team will follow up");
    expect(all.toLowerCase()).not.toContain('technical');
    expect(all.toLowerCase()).not.toContain('sorry');
    expect(spoken.alerts.some((x) => x.includes('TICKET FILING FAILED'))).toBe(true);
  });

  it('S10 unparsable ladder: re-ask once, then the scripted advance — never dead air, never a prompt handoff', async () => {
    const { svc } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'calling about my prescription being wrong');
    await line.onUtterance(C, 'yes');
    let a = await line.onUtterance(C, 'um');
    expect(a.say).toContain('date of birth'); // same question, re-asked once
    a = await line.onUtterance(C, 'uh what');
    // Second miss: identity abandoned, the request still moves forward.
    expect(a.say).toContain("not finding a match");
    expect(a.say).toContain('ending in 7471');
    expect(line.stateOf(C)).toBe('CONFIRM_CALLBACK');
  });

  it('S11 urgency: the 911-first line, message flow at urgent priority', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5550001111' });
    line.start(C);

    let a = await line.onUtterance(C, 'something is wrong there is bleeding around my eye');
    expect(a.say).toContain('nine one one');
    a = await line.onUtterance(C, 'my eye is bleeding after the procedure yesterday');
    // Unknown caller: identity is still collected — a ticket without a name
    // never gets a callback.
    expect(a.say).toContain('first and last name');
    a = await line.onUtterance(C, 'Pat Doe');
    a = await line.onUtterance(C, 'April 2 1980');
    expect(a.say).toContain("doesn't match"); // lookup miss → one retry
    a = await line.onUtterance(C, 'Pat Doe');
    a = await line.onUtterance(C, 'April 2 1980');
    expect(a.say).toContain('ending in 1111'); // second miss → forward anyway
    a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(spoken.lines.join(' ')).toContain("You're all set");
    expect(filed[0]?.priority).toBe('urgent');
  });

  it('Spanish caller: the scripts switch to Spanish and the ledger records it', async () => {
    const { svc } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Luis', matchedLastName: 'Marin', matchedDob: '1970-02-01', callerPhone: '5552223333' });
    line.start(C);

    let a = await line.onUtterance(C, 'hola necesito ayuda con mi receta por favor');
    expect(a.say).toBe('¿Hablo con Luis?');
    expect(getLedger(C)!.language).toBe('Spanish');
    a = await line.onUtterance(C, 'sí claro');
    expect(a.say).toContain('fecha de nacimiento');
  });

  it('declined message: the scripted decline, then a clean wrap', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5554445555' });
    line.start(C);

    await line.onUtterance(C, 'let me speak with somebody in billing');
    let a = await line.onUtterance(C, 'no never mind');
    expect(a.say).toContain('the team is available during business hours');
    a = await line.onUtterance(C, 'no');
    expect(a.endCall).toBe(true);
    expect(filed).toHaveLength(0);
  });

  it('second request after filing: a second ticket, callback never re-asked', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'my contact lens order never arrived');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'March 17 1973');
    let a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed).toHaveLength(1);

    a = await line.onUtterance(C, 'actually yes can you also tell them my eye drops ran out');
    const spoken = await speak(a);
    expect(filed).toHaveLength(2);
    expect(filed[1].description).toContain('eye drops');
    // Callback was settled the first time — a constant, never re-asked.
    expect(spoken.lines.join(' ')).not.toContain('best one to reach you');
  });

  it('callback unparsable twice: files with caller-ID and flags it, instead of looping', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'my eye drops prescription needs a refill');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'March 17 1973');
    let a = await line.onUtterance(C, 'the one you have I guess maybe');
    expect(a.say).toContain('ending in 7471'); // re-asked once
    a = await line.onUtterance(C, 'hmm whichever');
    const spoken = await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].callbackNumber).toBe('8455317471');
    expect(filed[0].description).toContain('callback unconfirmed');
    expect(spoken.lines.join(' ')).toContain("You're all set");
  });

  it('a courtesy word does not disqualify a real request ("refill please")', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    // Two tokens, one of them courtesy — this IS the reason for calling.
    let a = await line.onUtterance(C, 'refill please');
    expect(a.say).toBe('Am I speaking with Wayne?');
    a = await line.onUtterance(C, 'yes');
    a = await line.onUtterance(C, 'March 17 1973');
    a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].description.toLowerCase()).toContain('refill');
    expect(spoken.lines.join(' ')).toContain("You're all set");
  });

  it('a bare greeting is still not a request', async () => {
    const { svc } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5551239999' });
    line.start(C);

    const a = await line.onUtterance(C, 'okay hello');
    expect(a.say).not.toContain('new patient or an existing patient');
    expect(getLedger(C)?.intent ?? null).toBeNull();
  });

  it('an emergency AFTER the call has wrapped still gets the 911 line', async () => {
    const { svc } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'my contact lens order never arrived');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'March 17 1973');
    await speak(await line.onUtterance(C, 'yes'));
    const wrap = await line.onUtterance(C, 'no that is all');
    expect(wrap.endCall).toBe(true);

    // The caller speaks again, describing an emergency, after the wrap.
    const late = await line.onUtterance(C, "wait — I can't see out of my right eye");
    expect(late.say).toContain('nine one one');
  });

  it('an emergency in Spanish is answered in Spanish, first utterance', async () => {
    const { svc } = fakeServices();
    const line = createAnsweringServiceLine(svc);
    seedLedger(C, { callerPhone: '5552223333' });
    line.start(C);

    const a = await line.onUtterance(C, 'hola necesito ayuda, estoy sangrando del ojo');
    expect(a.say).toContain('nueve uno uno');
    expect(getLedger(C)!.language).toBe('Spanish');
  });
});
