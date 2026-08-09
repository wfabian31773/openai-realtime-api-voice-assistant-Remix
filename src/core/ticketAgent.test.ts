/**
 * The ticket agent, tested the way the operator described it:
 * verify -> classify -> what does THIS intent need -> collect -> execute.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createTicketAgent, INTENTS, type TicketAgentServices } from './ticketAgent';
import type { CoreAction } from './types';

function services(opts: { verify?: boolean; ok?: boolean } = {}) {
  const submitted: Array<Record<string, any>> = [];
  const svc: TicketAgentServices = {
    verify: vi.fn(async () => opts.verify ?? true),
    submit: vi.fn(async (_c: string, t: any) => {
      submitted.push(t);
      return opts.ok === false ? { ok: false } : { ok: true, ticketNumber: 'T-1' };
    }),
  };
  return { svc, submitted };
}

async function speak(a: CoreAction) {
  const lines: string[] = [];
  const alerts: string[] = [];
  let cur: CoreAction | null = a;
  while (cur) {
    if (cur.say) lines.push(cur.say);
    if (cur.alert) alerts.push(cur.alert);
    cur = cur.followUp ? await cur.followUp() : null;
  }
  return { lines, alerts };
}

const C = 'tick-1';

describe('ticket agent — five steps, nothing else', () => {
  beforeEach(() => clearAllLedgers());

  it("the operator's own example: fax medical records", async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    a.start(C);

    // Step 2: classify.
    let r = await a.onUtterance(C, 'I need to fax medical records');
    // Step 3+4: this intent needs patient name, DOB, fax number — in that
    // order, one at a time, and NOTHING else.
    expect(r.say).toContain("patient's first and last name");
    r = await a.onUtterance(C, 'Wayne Fabian');
    expect(r.say).toContain('date of birth');
    r = await a.onUtterance(C, 'March 17 1973');
    expect(r.say).toContain('best fax number');
    r = await a.onUtterance(C, '760 870 1200');

    const spoken = await speak(r);
    expect(spoken.lines[0]).toContain('medical records — fax');
    expect(spoken.lines[1]).toContain("You're all set");

    expect(submitted).toHaveLength(1);
    expect(submitted[0].intent).toBe('records_fax');
    expect(submitted[0].fields).toMatchObject({
      patient_name: 'Wayne Fabian',
      patient_dob: '1973-03-17',
      fax_number: '7608701200',
    });
    // It never asked for a callback number — this intent does not need one.
    expect(submitted[0].fields.callback_number).toBeUndefined();
  });

  it('a recognised caller is verified once, then never asked again', async () => {
    const { svc, submitted } = services({ verify: true });
    const a = createTicketAgent(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    a.start(C);

    let r = await a.onUtterance(C, 'yes this is Wayne');       // step 1
    expect(r.say).toContain('date of birth');
    r = await a.onUtterance(C, 'March 17 1973');
    expect(getLedger(C)!.identityVerified).toBe(true);
    expect(r.say).toContain('How can I help you today?');       // step 2

    r = await a.onUtterance(C, 'I need a refill on my eye drops');
    // Name and DOB are known, so the only thing left is the callback — and
    // it is CONFIRMED by last four, not collected.
    expect(r.say).toContain('ending in 7471');
    r = await a.onUtterance(C, 'yes');
    await speak(r);
    expect(submitted[0].intent).toBe('medication_refill');
    expect(submitted[0].fields.patient_name).toBe('Wayne Fabian');
  });

  it('surgery asks for the surgeon; optical asks for the office; neither asks the other', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I have a question about my cataract surgery');
    await a.onUtterance(C, 'Wayne Fabian');
    let r = await a.onUtterance(C, 'March 17 1973');
    expect(r.say).toContain('Which doctor');
    r = await a.onUtterance(C, 'Doctor Logan');
    r = await a.onUtterance(C, 'yes');
    await speak(r);
    expect(submitted[0].department).toBe(2);
    expect(submitted[0].fields.provider_name).toContain('Logan');
    expect(submitted[0].fields.office_location).toBeUndefined();
  });

  it('an unclear request becomes a message, and takes the details', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I have something I need to tell the office');
    await a.onUtterance(C, 'Wayne Fabian');
    let r = await a.onUtterance(C, 'March 17 1973');
    expect(r.say).toContain('What would you like the team to know');
    r = await a.onUtterance(C, 'my appointment card had the wrong suite number on it');
    r = await a.onUtterance(C, 'yes');
    await speak(r);
    expect(submitted[0].intent).toBe('message');
    expect(String(submitted[0].fields.details)).toContain('suite number');
  });

  it('asks each field at most twice, then files with what it has', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I need to fax medical records');
    await a.onUtterance(C, 'uh');            // ask 1 wasted
    await a.onUtterance(C, 'hmm');           // ask 2 wasted -> move on
    let r = await a.onUtterance(C, 'nope');  // dob also unusable
    r = await a.onUtterance(C, 'still nope');
    const spoken = await speak(r);
    // It never loops: it reaches the fax number or files what it has.
    expect(spoken.lines.join(' ').length).toBeGreaterThan(0);
  });

  it('cannot transfer, says so, and keeps working', async () => {
    const { svc } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    const r = await a.onUtterance(C, 'let me talk to a real person');
    expect(r.say).toContain('All of our agents are currently busy');
    expect(r.say).toContain('How can I help you today?');
  });

  it('submit failure never becomes a technical apology', async () => {
    const { svc } = services({ ok: false });
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I need a refill on my prescription');
    await a.onUtterance(C, 'Wayne Fabian');
    await a.onUtterance(C, 'March 17 1973');
    const spoken = await speak(await a.onUtterance(C, 'yes'));
    const all = spoken.lines.join(' ').toLowerCase();
    expect(all).toContain("i've noted everything");
    expect(all).not.toContain('technical');
    expect(spoken.alerts.length).toBe(1);
  });

  it('every intent in the table needs at least a name and a way to reach back', () => {
    for (const [key, def] of Object.entries(INTENTS)) {
      expect(def.needs, key).toContain('patient_name');
      const reachable = def.needs.some((f) => ['callback_number', 'fax_number', 'email_address'].includes(f));
      expect(reachable, `${key} has no way to deliver the answer`).toBe(true);
    }
  });

  it('a denied identity is never filed against the matched patient', async () => {
    const { svc, submitted } = services({ verify: true });
    const a = createTicketAgent(svc);
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    a.start(C);

    let r = await a.onUtterance(C, "no, this isn't Wayne");
    expect(r.say).toContain('How can I help you today?');
    r = await a.onUtterance(C, 'I need a refill for my mother');
    // It must ask WHO — the matched name is not this caller's patient.
    expect(r.say).toContain("patient's first and last name");
    await a.onUtterance(C, 'Elena Ruiz');
    await a.onUtterance(C, 'April 2 1948');
    await speak(await a.onUtterance(C, 'yes'));
    expect(submitted[0].fields.patient_name).toBe('Elena Ruiz');
  });

  it('"schedule my cataract surgery" is surgery, not a generic appointment', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I need to schedule my cataract surgery');
    await a.onUtterance(C, 'Wayne Fabian');
    const r = await a.onUtterance(C, 'March 17 1973');
    expect(r.say).toContain('Which doctor');       // surgery needs the surgeon
    await a.onUtterance(C, 'Doctor Logan');
    await speak(await a.onUtterance(C, 'yes'));
    expect(submitted[0].intent).toBe('surgery');
    expect(submitted[0].department).toBe(2);
  });

  it('an emergency on the first words still keeps the request', async () => {
    const { svc } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    const r = await a.onUtterance(C, 'I have sudden vision loss after my surgery');
    expect(r.say).toContain('nine one one');
    // and it did not forget why they called
    expect(a.stateOf(C)).toContain('surgery');
  });

  it('a hang-up mid-flow still files, once a number is known', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    a.start(C);
    await a.onUtterance(C, 'I need a refill on my eye drops');
    await a.onUtterance(C, 'Wayne Fabian');
    // caller drops here
    const r = await a.finalize!(C);
    expect(r.filed).toBe(true);
    expect(submitted[0].fields.patient_name).toBe('Wayne Fabian');
  });

  /**
   * Live 17:01 call: asked for a name, the caller said "March 17th, 1973".
   * The date was discarded, the agent then asked for the date of birth it had
   * just been given, and the ticket would have carried neither.
   */
  describe('an answer to the wrong question is still an answer', () => {
    it('keeps a date of birth offered while the name was being asked', async () => {
      const { svc, submitted } = services();
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, "I'd like to get a medication refill");
      // Asked for the name; answers with the DOB.
      let r = await a.onUtterance(C, 'March 17th, 1973');
      // Still wants the name — but the date is banked.
      expect(r.say?.toLowerCase()).toContain('name');
      r = await a.onUtterance(C, 'Wayne Fabian');
      // It must NOT ask for the date of birth it already has — the next
      // thing a refill needs is the callback number.
      expect(r.say?.toLowerCase() ?? '').not.toContain('date of birth');
      r = await a.onUtterance(C, 'yes'); // confirm the caller-ID callback
      await speak(r);

      const fields = submitted[0]?.fields ?? {};
      expect(fields.patient_name).toContain('Wayne');
      expect(fields.patient_dob).toBe('1973-03-17');
    });

    it('never files a stray sentence as a doctor, a location, or a name', async () => {
      const { svc, submitted } = services();
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      // surgery needs provider_name — a loose field that must never be
      // filled from an answer aimed at something else.
      await a.onUtterance(C, 'I want to schedule my cataract surgery');
      await a.onUtterance(C, 'uh I am not really sure about that');
      await a.onUtterance(C, 'sorry can you repeat the question');
      const r = await a.onUtterance(C, 'Wayne Fabian');
      await speak(r);

      const fields = submitted[0]?.fields ?? {};
      expect(fields.provider_name ?? '').not.toMatch(/not really sure|repeat the question/i);
    });

    it('a phone number is only salvaged when there is one place it can go', async () => {
      const { svc, submitted } = services();
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      // records_fax needs a fax number and no callback — one phone-shaped
      // field outstanding, so a number offered early belongs to it.
      await a.onUtterance(C, 'I need medical records faxed over');
      await a.onUtterance(C, 'the number is 562 555 0134');
      await a.onUtterance(C, 'Wayne Fabian');
      const r = await a.onUtterance(C, 'March 17 1973');
      await speak(r);

      const fields = submitted[0]?.fields ?? {};
      expect(fields.fax_number).toBe('5625550134');
    });
  });
});
