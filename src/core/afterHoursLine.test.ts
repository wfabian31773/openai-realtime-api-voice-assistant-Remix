/**
 * Gate A — after-hours/no-ivr variant of the ticket-only machine (§5):
 * closed-office deflection, tickets only, and NEVER a technical-issue
 * apology (the 2026-08-07 regression class).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger } from '../services/callFactsLedger';
import { createAnsweringServiceLine } from './answeringServiceLine';
import type { CoreAction, TicketInput, TicketLineServices } from './types';

const CLOSED = {
  en: "Our offices are closed right now — I'll take your information and make sure the right team member calls you back first thing.",
  es: 'Nuestras oficinas están cerradas en este momento — tomaré su información y me aseguraré de que el equipo le devuelva la llamada a primera hora.',
};

function fakeServices(fileOk: boolean[] = []) {
  const filed: TicketInput[] = [];
  const queue = [...fileOk];
  const svc: TicketLineServices = {
    verifyByLookup: vi.fn(async () => false),
    classify: vi.fn(async () => ({ departmentId: 3, requestTypeId: 9, requestReasonId: 1, priority: 'medium' as const, locationId: null, providerId: null })),
    fileTicket: vi.fn(async (input: TicketInput) => {
      filed.push(input);
      const ok = queue.length ? queue.shift()! : true;
      return ok ? { ok: true, ticketNumber: 'AH-1' } : { ok: false };
    }),
  };
  return { svc, filed };
}

async function speak(action: CoreAction) {
  const lines: string[] = [];
  const alerts: string[] = [];
  let a: CoreAction | null = action;
  while (a) {
    if (a.say) lines.push(a.say);
    if (a.alert) alerts.push(a.alert);
    a = a.followUp ? await a.followUp() : null;
  }
  return { lines, alerts };
}

const C = 'ah-call-1';

describe('after-hours new core — Gate A', () => {
  beforeEach(() => clearAllLedgers());

  it('human request gets the closed-office line, every time, then the message flow', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc, { slug: 'no-ivr', humanBusy: CLOSED });
    expect(line.slug).toBe('no-ivr');
    seedLedger(C, { callerPhone: '5551239999' });
    line.start(C);

    let a = await line.onUtterance(C, 'I need to speak to a person right now');
    expect(a.say).toContain('Our offices are closed right now');
    a = await line.onUtterance(C, 'connect me with somebody, anyone');
    expect(a.say).toContain('Our offices are closed right now');
    expect(filed).toHaveLength(0);
  });

  it('a ticket failure NEVER becomes a technical apology or a hangup excuse', async () => {
    const { svc, filed } = fakeServices([false, false]);
    const line = createAnsweringServiceLine(svc, { slug: 'no-ivr', humanBusy: CLOSED });
    seedLedger(C, { matchedFirstName: 'Wayne', matchedLastName: 'Fabian', matchedDob: '1973-03-17', callerPhone: '8455317471' });
    line.start(C);

    await line.onUtterance(C, 'my medication refill did not go through tonight');
    await line.onUtterance(C, 'yes');
    await line.onUtterance(C, 'March 17 1973');
    const a = await line.onUtterance(C, 'yes');
    const spoken = await speak(a);
    expect(filed).toHaveLength(2); // silent retry happened
    const all = spoken.lines.join(' ').toLowerCase();
    expect(all).toContain("i've noted everything");
    expect(all).not.toContain('technical');
    expect(all).not.toContain('difficult');
    expect(all).not.toContain('sorry');
    expect(all).not.toContain('call back during business hours');
    expect(spoken.alerts.length).toBeGreaterThan(0);
  });

  it('urgency still leads with 911 and files urgent', async () => {
    const { svc, filed } = fakeServices();
    const line = createAnsweringServiceLine(svc, { slug: 'no-ivr', humanBusy: CLOSED });
    seedLedger(C, { matchedFirstName: 'Rita', matchedLastName: 'Cole', matchedDob: '1955-01-05', callerPhone: '5553334444' });
    line.start(C);

    let a = await line.onUtterance(C, 'there is sudden vision loss in my left eye since tonight');
    expect(a.say).toContain('nine one one');
    a = await line.onUtterance(C, 'I can wait for a callback but it feels urgent, my vision is blurry');
    expect(a.say).toContain('ending in 4444'); // recognized caller: no re-interview
    const spoken = await speak(await line.onUtterance(C, 'yes'));
    expect(filed[0]?.priority).toBe('urgent');
    expect(spoken.lines.join(' ')).toContain("You're all set");
  });
});
