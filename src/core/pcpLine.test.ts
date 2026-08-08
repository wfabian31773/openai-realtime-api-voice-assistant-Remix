/**
 * Gate A — PCP professional line vs script-listing §3 and the capability
 * matrix. The line that is "our face to real doctors and medical groups":
 * say-and-act transfers, contact method matches the request, silent patient
 * attach, professionals never trapped or interrogated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createPcpLine, type ProfessionalLineServices } from './pcpLine';
import type { CoreAction } from './types';

function fakeServices(opts: { connected?: boolean; fileOk?: boolean[] } = {}) {
  const routed: Array<Record<string, unknown>> = [];
  const filed: Array<Record<string, unknown>> = [];
  const fileQueue = [...(opts.fileOk ?? [])];
  const svc: ProfessionalLineServices = {
    routeToQueue: vi.fn(async (_callId: string, input: Record<string, unknown>) => {
      routed.push(input);
      return { connected: opts.connected ?? true, ticketNumber: 'PCP-1' };
    }),
    fileTask: vi.fn(async (_callId: string, input: Record<string, unknown>) => {
      filed.push(input);
      const ok = fileQueue.length ? fileQueue.shift()! : true;
      return ok ? { ok: true, ticketNumber: 'PCP-2' } : { ok: false };
    }),
  };
  return { svc, routed, filed };
}

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

const C = 'pcp-call-1';

describe('pcp new core — Gate A', () => {
  beforeEach(() => clearAllLedgers());

  it('schedule request: the promise and the dial are ONE unit', async () => {
    const { svc, routed } = fakeServices({ connected: true });
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'I need to schedule an eye exam for one of our members');
    const a = await line.onUtterance(C, 'This is Dana from HealthFirst Medical Group');
    expect(a.say).toContain("I'll get that over to our PCP scheduling queue right away");
    const spoken = await speak(a);
    // The dial happened inside the same action as the promise.
    expect(routed).toHaveLength(1);
    expect(routed[0].organization).toContain('HealthFirst');
    // Connected: the queue owns the call — no further agent lines.
    expect(spoken.lines).toHaveLength(1);
  });

  it('transfer no-answer: the scripted fallback line, never dead air', async () => {
    const { svc, routed } = fakeServices({ connected: false });
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'we need to book an appointment for a patient');
    const a = await line.onUtterance(C, 'Marcus at Vista Community Clinic');
    const spoken = await speak(a);
    expect(routed).toHaveLength(1);
    expect(spoken.lines.join(' ')).toContain("The team isn't picking up right now");
  });

  it('records request: fax number collected and read back — never a callback ask', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'we need medical records faxed over for a referral');
    let a = await line.onUtterance(C, 'Priya from Coastal Family Medicine');
    expect(a.say).toContain('best fax number');
    a = await line.onUtterance(C, 'it is 562 555 0134');
    expect(a.say).toContain('correct?');
    a = await line.onUtterance(C, 'yes that is right');
    const spoken = await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].contactMethod).toBe('fax');
    expect(filed[0].faxNumber).toBe('5625550134');
    expect(spoken.lines.join(' ')).toContain('the team will follow up with your office');
    const all = spoken.lines.join(' ');
    expect(all).not.toContain('best callback number');
  });

  it('email request: email collected and confirmed, filed with email', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'could you email us the clinical summary please');
    let a = await line.onUtterance(C, 'Jordan at Summit Health Partners');
    expect(a.say).toContain('best email address');
    a = await line.onUtterance(C, 'records at summithealth dot com — sorry, records@summithealth.com');
    expect(a.say).toContain('records@summithealth.com');
    a = await line.onUtterance(C, 'correct');
    await speak(a);
    expect(filed[0].contactMethod).toBe('email');
    expect(filed[0].email).toBe('records@summithealth.com');
  });

  it('other request: callback confirmed from caller-ID by last four, then filed', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'I have a question about a prior authorization status');
    let a = await line.onUtterance(C, 'Sam from Harbor Medical Associates');
    expect(a.say).toContain('ending in 1000');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed[0].contactMethod).toBe('callback');
    expect(filed[0].callbackNumber).toBe('5622001000');
  });

  it('patient reference is attached SILENTLY — never spoken about, never blocks', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    const heard: string[] = [];
    const say = async (txt: string) => {
      const a = await line.onUtterance(C, txt);
      const spoken = await speak(a);
      heard.push(...spoken.lines);
      return spoken;
    };
    await say('we need records for our patient Maria Gonzalez, she was seen there last month');
    await say('Alex from Pacific Care Medical Group');
    await say('562 555 0134');
    await say('yes');
    expect(filed[0].patientRef).toContain('Maria');
    // The professional is never interrogated about the patient.
    const all = heard.join(' ').toLowerCase();
    expect(all).not.toContain('maria');
    expect(all).not.toContain('date of birth');
    expect(all).not.toContain('verify');
  });

  it('a professional asking for a human gets the QUEUE — this line can transfer', async () => {
    const { svc, routed } = fakeServices({ connected: true });
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    const a = await line.onUtterance(C, 'put me through to a real person please');
    expect(a.say).toContain('PCP scheduling queue');
    await speak(a);
    expect(routed).toHaveLength(1);
  });

  it('fax unparsable twice: filed via callback with the gap flagged — professionals are never trapped', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'requesting chart notes to be faxed for a referral');
    let a = await line.onUtterance(C, 'Casey from Northside Medical');
    a = await line.onUtterance(C, 'uh let me look it up');
    expect(a.say).toContain('best fax number'); // re-asked once
    a = await line.onUtterance(C, 'I will have to find it');
    const spoken = await speak(a);
    expect(filed).toHaveLength(1);
    expect(filed[0].contactMethod).toBe('callback');
    expect(String(filed[0].narrative)).toContain('fax number not captured');
    expect(spoken.lines.join(' ')).toContain('follow up with your office');
  });

  it('task filing failure: silent retry then the noted line + ALERT — no technical talk', async () => {
    const { svc, filed } = fakeServices({ fileOk: [false, false] });
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'question about a shared patient care plan');
    let a = await line.onUtterance(C, 'Robin from Lakeside Medical Group');
    a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(filed).toHaveLength(2);
    const all = spoken.lines.join(' ').toLowerCase();
    expect(all).toContain("i've noted everything");
    expect(all).not.toContain('technical');
    expect(all).not.toContain('sorry');
    expect(spoken.alerts.some((x) => x.includes('PCP TASK FILING FAILED'))).toBe(true);
  });

  it('urgent language routes at urgent priority', async () => {
    const { svc, routed } = fakeServices({ connected: true });
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'we need this patient seen today, stat referral for an appointment');
    const a = await line.onUtterance(C, 'Dr. Ellis office, Grandview Medical');
    await speak(a);
    expect(routed[0].urgency).toBe('urgent');
  });

  it('second request after filing: dispatched fresh, callback never re-asked', async () => {
    const { svc, filed } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'status question on a referral we sent');
    let a = await line.onUtterance(C, 'Toni from Bayview Medical Group');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    expect(filed).toHaveLength(1);
    expect(getLedger(C)!.callbackConfirmed).toBe(true);

    a = await line.onUtterance(C, 'also we have another patient that needs their prescription history sent');
    const spoken = await speak(a);
    expect(filed).toHaveLength(2);
    expect(spoken.lines.join(' ')).not.toContain('best callback number');
  });

  it('wrap: a plain no ends the call cleanly', async () => {
    const { svc } = fakeServices();
    const line = createPcpLine(svc);
    seedLedger(C, { callerPhone: '5622001000' });
    line.start(C);

    await line.onUtterance(C, 'billing question about a claim for services');
    let a = await line.onUtterance(C, 'Lee from Cedar Medical Partners');
    a = await line.onUtterance(C, 'yes');
    await speak(a);
    a = await line.onUtterance(C, 'no that is everything thanks');
    expect(a.say).toContain('Thanks for calling Azul Vision');
    expect(a.endCall).toBe(true);
  });
});
