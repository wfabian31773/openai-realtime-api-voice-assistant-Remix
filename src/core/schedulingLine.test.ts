/**
 * Gate A — SD / azul-scheduling line vs script-listing §4.
 * The line that books: server owns the offer, the module never invents a
 * time, the read-back always matches what is booked, and every dead end
 * lands on a human instead of a loop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createSchedulingLine, type SchedulingLineServices, type AvailabilityOffer } from './schedulingLine';
import type { CoreAction } from './types';

const OFFER: AvailabilityOffer = {
  say: 'I have Tuesday the 12th at 9:00 AM, or Wednesday the 13th at 2:30 PM — which works better for you?',
  optionTimes: ['09:00', '14:30'],
};

function fakeServices(opts: {
  verify?: boolean;
  offers?: (AvailabilityOffer | null)[];
  book?: Array<{ status: 'confirmed' | 'unknown' | 'failed'; say?: string; patientScript?: string }>;
  transferOk?: boolean;
} = {}) {
  const availabilityCalls: Array<Record<string, unknown>> = [];
  const bookCalls: Array<{ optionNumber: number; confirmedTimeSpoken: string }> = [];
  const transfers: string[] = [];
  const offerQueue = [...(opts.offers ?? [])];
  const bookQueue = [...(opts.book ?? [])];
  const svc: SchedulingLineServices = {
    verifyIdentity: vi.fn(async () => opts.verify ?? false),
    availability: vi.fn(async (_c: string, pref: Record<string, unknown>) => {
      availabilityCalls.push(pref);
      const next = offerQueue.length ? offerQueue.shift()! : OFFER;
      if (!next) throw new Error('availability down');
      return next;
    }),
    book: vi.fn(async (_c: string, input: { optionNumber: number; confirmedTimeSpoken: string }) => {
      bookCalls.push(input);
      return bookQueue.length ? bookQueue.shift()! : { status: 'confirmed' as const, say: "You're booked for Tuesday the 12th at 9:00 AM at our Oceanside office. You'll get a text confirmation shortly. Anything else?" };
    }),
    transfer: vi.fn(async (_c: string, reason: string) => {
      transfers.push(reason);
      return { ok: opts.transferOk ?? true };
    }),
  };
  return { svc, availabilityCalls, bookCalls, transfers };
}

async function speak(action: CoreAction) {
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
  return { lines, alerts, end };
}

const C = 'sd-call-1';

describe('azul-scheduling new core — Gate A', () => {
  beforeEach(() => clearAllLedgers());

  it('happy path: verify from context → preference → server offer verbatim → book by option', async () => {
    const { svc, availabilityCalls, bookCalls } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    let a = await line.onUtterance(C, 'I need to book my annual eye exam');
    expect(a.say).toBe('Am I speaking with Maria?');
    a = await line.onUtterance(C, 'yes');
    a = await line.onUtterance(C, 'May 10 1983');
    expect(getLedger(C)!.identityVerified).toBe(true);
    expect(a.say).toContain('What day and times work best for you?');

    a = await line.onUtterance(C, 'Tuesday morning would be great');
    let spoken = await speak(a);
    // The server's sentence, word for word — never rephrased.
    expect(spoken.lines).toEqual([OFFER.say]);
    expect(availabilityCalls[0]).toMatchObject({ preferredDate: 'tuesday', timeOfDay: 'AM' });

    a = await line.onUtterance(C, 'the first one works');
    spoken = await speak(a);
    // Read-back matches EXACTLY what is booked — mismatch is unreachable.
    expect(spoken.lines[0]).toContain('9 AM');
    expect(bookCalls).toEqual([{ optionNumber: 1, confirmedTimeSpoken: '09:00' }]);
    expect(spoken.lines[1]).toContain("You're booked");
  });

  it('second option chosen books option 2 with ITS time, not the first', async () => {
    const { svc, bookCalls } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'need an appointment please');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    await speak(await line.onUtterance(C, 'any day is fine'));
    const spoken = await speak(await line.onUtterance(C, 'the second one'));
    expect(bookCalls).toEqual([{ optionNumber: 2, confirmedTimeSpoken: '14:30' }]);
    expect(spoken.lines[0]).toContain('2:30 PM');
  });

  it('neither time works: the ONLY route to another slot is asking the server again', async () => {
    const secondOffer: AvailabilityOffer = { say: 'I have Thursday the 14th at 11:00 AM, or Friday the 15th at 3:00 PM — which works better?', optionTimes: ['11:00', '15:00'] };
    const { svc, availabilityCalls, bookCalls } = fakeServices({ offers: [OFFER, secondOffer] });
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'I want to come in');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    await speak(await line.onUtterance(C, 'Tuesday morning'));
    let a = await line.onUtterance(C, 'no, neither of those work');
    expect(a.say).toContain('What other day or time');
    const spoken = await speak(await line.onUtterance(C, 'how about Thursday afternoon'));
    expect(availabilityCalls).toHaveLength(2);
    expect(spoken.lines).toEqual([secondOffer.say]);
    expect(bookCalls).toHaveLength(0); // nothing booked without a choice
  });

  it('empty availability: the server admission is spoken, then the preference is re-asked', async () => {
    const empty: AvailabilityOffer = { say: "I don't have anything on Tuesday — the closest I have is Thursday the 14th. Would that work?", optionTimes: [], empty: true };
    const { svc } = fakeServices({ offers: [empty] });
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'looking for an appointment');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    const spoken = await speak(await line.onUtterance(C, 'Tuesday please'));
    expect(spoken.lines[0]).toContain("I don't have anything on Tuesday");
    expect(line.stateOf(C)).toBe('ASK_PREFERENCE');
  });

  it("booking 'unknown' NEVER claims booked — it reads the server's script", async () => {
    const { svc } = fakeServices({ book: [{ status: 'unknown', patientScript: 'I have your request in with our scheduling team and they will confirm shortly.' }] });
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'book me in');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    await speak(await line.onUtterance(C, 'any time'));
    const spoken = await speak(await line.onUtterance(C, 'first one'));
    const all = spoken.lines.join(' ');
    expect(all).toContain('will confirm shortly');
    expect(all).not.toContain("You're booked");
  });

  it('booking failure: the scripted line and the transfer are one unit', async () => {
    const { svc, transfers } = fakeServices({ book: [{ status: 'failed' }] });
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'need to schedule');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    await speak(await line.onUtterance(C, 'any time'));
    const spoken = await speak(await line.onUtterance(C, 'first'));
    expect(spoken.lines.join(' ')).toContain('let me get you over to our team');
    expect(transfers).toContain('booking failed');
  });

  it('new patient: the approved line, then the transfer — never an attempted booking', async () => {
    const { svc, transfers, bookCalls } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { callerPhone: '5559998888' });
    line.start(C);

    await line.onUtterance(C, 'I would like to become a patient and get an appointment');
    const a = await line.onUtterance(C, 'I am a new patient');
    expect(a.say).toContain("I'm unable to schedule new patients");
    await speak(a);
    expect(transfers).toContain('new patient');
    expect(bookCalls).toHaveLength(0);
  });

  it('human request: helped once, transferred on the second ask', async () => {
    const { svc, transfers } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    let a = await line.onUtterance(C, 'can I talk to a real person');
    expect(a.say).toContain('may I ask what');
    a = await line.onUtterance(C, 'no I want a representative');
    expect(a.say).toContain('one moment while I connect you');
    await speak(a);
    expect(transfers).toHaveLength(1);
  });

  it('verify fails twice: transferred, never an endless identity loop', async () => {
    const { svc, transfers } = fakeServices({ verify: false });
    const line = createSchedulingLine(svc);
    seedLedger(C, { callerPhone: '5551112222' });
    line.start(C);

    await line.onUtterance(C, 'I need to move my appointment');
    await line.onUtterance(C, 'existing patient');
    await line.onUtterance(C, 'John Smith');
    let a = await line.onUtterance(C, 'January 5 1960');
    expect(a.say).toContain("doesn't match");
    await line.onUtterance(C, 'John Smith');
    a = await line.onUtterance(C, 'January 5 1960');
    expect(a.say).toContain('let me get you over to our team');
    await speak(a);
    expect(transfers).toContain('identity not verified');
  });

  it('urgent symptoms: 911 first, then straight to a human', async () => {
    const { svc, transfers } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    const a = await line.onUtterance(C, 'I have sudden vision loss and severe pain');
    expect(a.say).toContain('nine one one');
    await speak(a);
    expect(transfers).toContain('urgent symptoms');
  });

  it('availability outage: one silent retry, then the team — never a technical excuse', async () => {
    const { svc, transfers } = fakeServices({ offers: [null, null] });
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Maria', matchedLastName: 'Lopez', matchedDob: '1983-05-10', callerPhone: '5551234567' });
    line.start(C);

    await line.onUtterance(C, 'need an appointment');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'May 10 1983');
    const spoken = await speak(await line.onUtterance(C, 'Tuesday morning'));
    const all = spoken.lines.join(' ').toLowerCase();
    expect(all).toContain('let me get you over to our team');
    expect(all).not.toContain('technical');
    expect(all).not.toContain('error');
    expect(transfers).toContain('availability unavailable');
  });

  it('Spanish caller: scripts switch and the ledger records it', async () => {
    const { svc } = fakeServices();
    const line = createSchedulingLine(svc);
    seedLedger(C, { matchedFirstName: 'Luis', matchedLastName: 'Marin', matchedDob: '1970-02-01', callerPhone: '5552223333' });
    line.start(C);

    const a = await line.onUtterance(C, 'hola necesito una cita por favor');
    expect(a.say).toBe('¿Hablo con Luis?');
    expect(getLedger(C)!.language).toBe('Spanish');
  });
});
