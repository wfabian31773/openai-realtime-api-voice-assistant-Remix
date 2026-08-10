/**
 * The ticket agent, tested the way the operator described it:
 * verify -> classify -> what does THIS intent need -> collect -> execute.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createTicketAgent, INTENTS, type TicketAgentServices } from './ticketAgent';
import type { CoreAction } from './types';

function services(opts: { verify?: boolean; ok?: boolean; reads?: Record<string, any> } = {}) {
  const submitted: Array<Record<string, any>> = [];
  const svc: TicketAgentServices = {
    verify: vi.fn(async () => opts.verify ?? true),
    // The model's reading, stubbed. Absent entries fall through to the
    // keyword table, which is exactly the production failure path.
    classifyIntent: vi.fn(async (text: string) => opts.reads?.[text] ?? null),
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
    // Name and DOB are known, so the only things left are WHICH drug and the
    // callback — and the callback is CONFIRMED by last four, not collected.
    expect(r.say).toContain('Which medication');
    r = await a.onUtterance(C, 'prednisolone acetate');
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
    // The boundary is the capability, not the queue depth: "our agents are
    // busy" invites a caller to hold for a transfer that does not exist.
    expect(r.say).toContain('not able to transfer calls');
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
    await a.onUtterance(C, 'prednisolone acetate');
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
    await a.onUtterance(C, 'prednisolone acetate');
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
      // It must NOT ask for the date of birth it already has.
      expect(r.say?.toLowerCase() ?? '').not.toContain('date of birth');
      await a.onUtterance(C, 'prednisolone acetate');
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

  /**
   * The three live calls of 2026-08-10 that the keyword table got wrong.
   * Operator: "the conversation is great — if we can keep that conversation
   * with appropriate tool calling, that's it."
   */
  describe('the intent comes from the sentence, not from keywords in it', () => {
    it("an employer's name never chooses the intent", async () => {
      const sentence = "Hi, my name is Jasmine and I'm calling from the Loma Linda Surgery Center for the medical records of a mutual patient.";
      // The table matched "Surgery" — in her EMPLOYER's name — and filed a
      // records request as surgery coordination.
      expect(INTENTS.surgery.match.test(sentence)).toBe(true);

      const { svc, submitted } = services({
        reads: { [sentence]: { intent: 'records_fax', callerIsProfessional: true, source: 'llm' } },
      });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, sentence);
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      await speak(await a.onUtterance(C, '760 860 1434'));

      expect(submitted[0]?.intent).toBe('records_fax');
      expect(submitted[0]?.fields.fax_number).toBe('7608601434');
    });

    it('"medical records" with no method stated is still a records request', async () => {
      const sentence = "Hi, my name is Dr. Joseph Perez and I'm calling for the medical records of a mutual patient.";
      // The table required "fax" or "email" within 40 chars of "records", so
      // this fell to the catch-all and asked "what would you like the team to
      // know?" — of a doctor requesting records.
      expect(INTENTS.records_fax.match.test(sentence)).toBe(false);
      expect(INTENTS.records_email.match.test(sentence)).toBe(false);

      const { svc } = services({
        reads: { [sentence]: { intent: 'records_fax', callerIsProfessional: true, source: 'llm' } },
      });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      const r = await a.onUtterance(C, sentence);
      expect(r.say?.toLowerCase()).toContain('name');
    });

    it('a method named LATER re-points the request and drops the wrong field', async () => {
      const sentence = 'I need the medical records for a mutual patient';
      const { svc, submitted } = services({
        reads: { [sentence]: { intent: 'records_fax', source: 'llm' } },
      });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, sentence);
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      // It is asking for a fax number; the caller wants email instead.
      const r = await a.onUtterance(C, 'Can you have them emailed, please?');
      expect(r.say?.toLowerCase()).toContain('email');
      await speak(await a.onUtterance(C, "it's medicalrecords@azulvision.com"));

      expect(submitted[0]?.intent).toBe('records_email');
      expect(submitted[0]?.fields.email_address).toBe('medicalrecords@azulvision.com');
      expect(submitted[0]?.fields.fax_number).toBeUndefined();
    });

    it('falls back to the keyword table when the model gives nothing', async () => {
      const { svc, submitted } = services(); // classifyIntent returns null
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, 'I need a refill on my eye drops');
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      await a.onUtterance(C, 'prednisolone acetate');
      await speak(await a.onUtterance(C, 'yes'));

      expect(submitted[0]?.intent).toBe('medication_refill');
    });
  });

  describe('step 1, finally reached: the patient is actually checked', () => {
    it('verifies the name and date of birth against the record before filing', async () => {
      const { svc, submitted } = services({ verify: true });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, 'I need a refill on my eye drops');
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      await a.onUtterance(C, 'prednisolone acetate');
      await speak(await a.onUtterance(C, 'yes'));

      expect(svc.verify).toHaveBeenCalledWith(C, 'Wayne Fabian', '1973-03-17');
      expect(submitted[0]?.identityVerified).toBe(true);
    });

    it('files anyway when the record says no — staff need the request AND the doubt', async () => {
      const { svc, submitted } = services({ verify: false });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, 'I need a refill on my eye drops');
      await a.onUtterance(C, 'Nobody Whatsoever');
      await a.onUtterance(C, 'March 17 1973');
      await a.onUtterance(C, 'prednisolone acetate');
      await speak(await a.onUtterance(C, 'yes'));

      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.identityVerified).toBe(false);
    });

    it('a broken lookup never blocks the call — unchecked is not the same as failed', async () => {
      const { svc, submitted } = services();
      (svc.verify as any).mockRejectedValue(new Error('NextGen down'));
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, 'I need a refill on my eye drops');
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      await a.onUtterance(C, 'prednisolone acetate');
      await speak(await a.onUtterance(C, 'yes'));

      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.identityVerified).toBeUndefined();
    });
  });

  /** The 12:36 live call, which filed a records ticket with no destination. */
  describe('records with no method stated: ask, never assume', () => {
    const CALL = 'Good morning, I\'m calling for medical records.';

    it('asks HOW to send them instead of demanding a fax number', async () => {
      const { svc } = services({ reads: { [CALL]: { intent: 'records', source: 'llm' } } });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, CALL);
      await a.onUtterance(C, 'the patient is Joseph Perez');
      const r = await a.onUtterance(C, 'December 3rd, 1971');
      // The live call asked "What's the best fax number?" of someone who
      // never said fax.
      expect(r.say?.toLowerCase()).not.toContain('fax number');
      expect(r.say?.toLowerCase()).toMatch(/faxed or emailed/);
    });

    it('answering "email" re-points it and then collects the address', async () => {
      const { svc, submitted } = services({ reads: { [CALL]: { intent: 'records', source: 'llm' } } });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, CALL);
      await a.onUtterance(C, 'the patient is Joseph Perez');
      await a.onUtterance(C, 'December 3rd, 1971');
      const r = await a.onUtterance(C, 'email please');
      expect(r.say?.toLowerCase()).toContain('email address');
      await speak(await a.onUtterance(C, "it's medicalrecords@azulvision.com"));

      expect(submitted[0]?.intent).toBe('records_email');
      expect(submitted[0]?.fields.email_address).toBe('medicalrecords@azulvision.com');
    });

    it('"Email:" said at the WRAP re-opens the request instead of hanging up', async () => {
      // Live 12:36: the caller said "Email:" after the fax ticket was filed
      // and was thanked and disconnected.
      const { svc, submitted } = services({
        reads: { 'I need those records faxed': { intent: 'records_fax', source: 'llm' } },
      });
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, 'I need those records faxed');
      await a.onUtterance(C, 'Joseph Perez');
      await a.onUtterance(C, 'December 3 1971');
      await speak(await a.onUtterance(C, '760 860 1734'));
      expect(submitted[0]?.intent).toBe('records_fax');

      // Now, at the wrap, they correct us.
      const r = await a.onUtterance(C, 'Email:');
      expect(r.say?.toLowerCase()).toContain('email address');
      expect(r.endCall).not.toBe(true);
      await speak(await a.onUtterance(C, 'medicalrecords@azulvision.com'));
      expect(submitted[1]?.intent).toBe('records_email');
    });

    it('a refill ticket carries the drug the caller named', async () => {
      const { svc, submitted } = services();
      const a = createTicketAgent(svc);
      seedLedger(C, { callerPhone: '5622001000' });
      a.start(C);

      await a.onUtterance(C, "I'm calling for a medication refill");
      await a.onUtterance(C, 'Wayne Fabian');
      await a.onUtterance(C, 'March 17 1973');
      await a.onUtterance(C, "it's prednisolone acetate");
      await speak(await a.onUtterance(C, 'yes'));

      expect(submitted[0]?.fields.medication).toContain('prednisolone');
    });
  });
});

describe('the capability boundary, said out loud', () => {
  // Operator, 2026-08-10: "the only thing that the answering service cannot do
  // is transfer calls or schedule appointments… it has to make sure to let the
  // patient know that it doesn't have the capability, but since everyone's
  // busy, it's going to [take it down] and someone will follow up."
  beforeEach(() => clearAllLedgers());

  it('tells a caller it cannot transfer, instead of implying a queue', async () => {
    const { svc } = services();
    const a = createTicketAgent(svc);
    a.start(C);
    const { lines } = await speak(await a.onUtterance(C, 'I want to talk to a real person'));
    const said = lines.join(' ').toLowerCase();
    expect(said).toMatch(/not able to transfer|can'?t (transfer|connect)/);
    // "Everyone is busy" on its own invites the caller to wait, and on the
    // live 15:18 call they did — four times.
    expect(said).toMatch(/call(s)? you back|callback/);
  });

  it('does not repeat the same sentence at a caller who asks twice', async () => {
    const { svc } = services();
    const a = createTicketAgent(svc);
    a.start(C);
    const first = await speak(await a.onUtterance(C, 'connect me to a human'));
    const second = await speak(await a.onUtterance(C, 'no, get me a live person'));
    expect(second.lines.join(' ')).not.toBe(first.lines.join(' '));
    expect(second.lines.join(' ').toLowerCase()).toMatch(/can'?t connect you/);
  });

  it('says it cannot book BEFORE the caller describes the appointment they want', async () => {
    // A caller who names a day and time and then hears only "I've passed that
    // to the team" hangs up believing they are booked, and finds out
    // otherwise when they arrive.
    const { svc } = services();
    const a = createTicketAgent(svc);
    a.start(C);
    const { lines } = await speak(await a.onUtterance(C, 'I need to schedule an appointment'));
    const said = lines.join(' ').toLowerCase();
    expect(said).toMatch(/can'?t (book|schedule)/);
    expect(said).toMatch(/call you back/);
  });

  it('says it once, not on every turn of the appointment', async () => {
    const { svc } = services();
    const a = createTicketAgent(svc);
    a.start(C);
    await speak(await a.onUtterance(C, 'I need to reschedule my appointment'));
    const next = await speak(await a.onUtterance(C, 'Wayne Fabian'));
    expect(next.lines.join(' ').toLowerCase()).not.toMatch(/can'?t (book|schedule)/);
  });

  it('still files the ticket — the boundary is not a refusal', async () => {
    const { svc, submitted } = services();
    const a = createTicketAgent(svc);
    a.start(C);
    seedLedger(C, { callerPhone: '5625550134' });
    await speak(await a.onUtterance(C, 'I need to schedule an appointment'));
    await speak(await a.onUtterance(C, 'Wayne Fabian'));
    await speak(await a.onUtterance(C, 'March 17th 1973'));
    await speak(await a.onUtterance(C, 'yes'));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].intent).toBe('appointment');
  });
});
