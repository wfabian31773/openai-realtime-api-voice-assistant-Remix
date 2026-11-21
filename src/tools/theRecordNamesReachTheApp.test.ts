/**
 * THE RECORD'S NAMES REACH THE APP — v258.
 *
 * The 2026-11-21 overnight pass. A filing for a confirmed patient carries a
 * `validatedPatient` with the record's own names (`validatedPatientFor`), and
 * the ticketing app refuses a create-ticket payload whose names differ from
 * that patient's (`applyValidatedPatient`, ticketing-app
 * lib/voice-agent/patient-context.ts: "Invalid or conflicting validated
 * patient context", HTTP 400). The held person answers to more than the
 * record's spelling: a first name the person base accepted with the date of
 * birth (`heardAs`, v199), and the other chart's last name (`alsoKnownAs`,
 * v179). So `prepareTicketIdentity` kept the caller's spelling on the payload,
 * attached the record's spelling beside it, and the app refused the pair.
 *
 * MEASURED, Support Center `voice_agent_api_logs`, 30 days to 2026-11-21:
 * the refusal appears on create-ticket only, 42 POSTs on 17 calls, all
 * between 2026-11-11 and 2026-11-19 (tech 8, optical 4, records 3, surgery 2).
 * The request then filed in-call after up to 3 more tries on 5 calls, at high
 * priority (a recovery or a sweep) on 5, and only at teardown, 3 to 4 s after
 * the caller hung up, on 7.
 *
 * THE SHAPE, read from the Hub's `tool_call_payloads` (booleans and lengths
 * only; it holds rows from 2026-11-15 14:02 UTC, so 9 of the 17 have them):
 * on all 9, `lookup_patient` matched on name and date of birth with the
 * caller's spelling of the first name, the filing tool sent that same
 * spelling, the record's first name shared its first three letters and
 * differed after them, and the last name was the record's. On the 3 calls
 * where a later filing succeeded in the call, that filing sent the record's
 * first name. The other 8 calls are from before the payload store; the app's
 * refusal is the same, and on the tool path the date of birth is the record's
 * (`prepareTicketIdentity`) and the CallSid is the call's own, so the name is
 * the reachable conflict. Their shape is not recorded and is not claimed.
 *
 * PHI: the SIDs and ticket numbers are real; every name and date below is
 * SYNTHETIC, chosen to reproduce each recorded shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: { lookupPatient: lookup } }));
vi.mock('../services/consoleDirectory', () => ({ isDirectoryConfigured: () => false, lookupLocation: async () => null }));

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./techTools');
await import('./opticalTools');
await import('./surgeryTools');
await import('./medicalRecordsTools');
const { resetGateAttempts } = await import('./gateAttempts');
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import('./verifiedIdentity');
const { prepareTicketIdentity, recordNamesFor, validatedPatientFor } = await import('./ticketIdentity');
const { ticketingApiClient, TicketingApiClient } = await import('../../server/services/ticketingApiClient');
const { TicketOutboxService } = await import('../services/ticketOutboxService');

/**
 * The app's name rule, copied from ticketing-app lib/services/patient-name-match.ts
 * (`normalizeName`) and lib/voice-agent/patient-context.ts (`unknownName`,
 * `applyValidatedPatient`), read 2026-11-21.
 */
function appNormalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC').toLowerCase()
    .replace(/['’.]/g, '').replace(/[^\p{L}\p{M}]+/gu, ' ').trim();
}
const appUnknownName = (first?: string, last?: string) =>
  !first?.trim() && !last?.trim() || /^unknown(?: caller)?$/i.test([first, last].filter(Boolean).join(' ').trim());
interface Payload {
  patientFirstName?: string; patientLastName?: string; callData?: { callSid?: string };
  patientBirthYear?: string; patientBirthMonth?: string; patientBirthDay?: string; departmentId?: number;
  validatedPatient?: { callSid: string; firstName: string; lastName: string; dateOfBirth?: string };
}
/** Throws what the app answers; returns null when it would accept the payload. */
function appRefusal(p: Payload): string | null {
  const m = p.validatedPatient;
  if (!m) return null;
  if (m.callSid !== p.callData?.callSid) return 'different call';
  if (!appUnknownName(p.patientFirstName, p.patientLastName) &&
    ((p.patientFirstName?.trim() && appNormalizeName(p.patientFirstName) !== appNormalizeName(m.firstName)) ||
      (p.patientLastName?.trim() && appNormalizeName(p.patientLastName) !== appNormalizeName(m.lastName)))) return 'name';
  const dob = [p.patientBirthYear, p.patientBirthMonth?.padStart(2, '0'), p.patientBirthDay?.padStart(2, '0')].join('-');
  if (p.patientBirthYear && p.patientBirthMonth && p.patientBirthDay && m.dateOfBirth && dob !== m.dateOfBirth) return 'date of birth';
  return null;
}

type Internals = { ensureInitialized: () => void; warmUpIfStale: () => Promise<boolean>; makeRequest: (...a: unknown[]) => Promise<unknown> };
let posted: Array<{ body: Payload; refused: string | null }> = [];
let ticket = 0;
function fakeApp(api: object) {
  const internals = api as unknown as Internals;
  vi.spyOn(internals, 'ensureInitialized').mockImplementation(() => {});
  vi.spyOn(internals, 'warmUpIfStale').mockResolvedValue(true);
  return vi.spyOn(internals, 'makeRequest').mockImplementation(async (path, _method, body) => {
    if (path === '/api/voice-agent/lookup') return { success: true, locationId: 31, providerId: 77 };
    if (path !== '/api/voice-agent/create-ticket') return { success: true };
    const refused = appRefusal(body as Payload);
    posted.push({ body: body as Payload, refused });
    if (refused) {
      const e = new Error('Invalid or conflicting validated patient context') as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    }
    ticket += 1;
    return { success: true, ticketNumber: `VA-SYN${ticket}`, ticketId: ticket };
  });
}

const PERSON = '00000000-0000-4000-8000-000000000258';
const DOB = '1961-04-05';
function contextFor(firstName: string, lastName: string) {
  return {
    patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true, candidateCount: 1, candidates: [] },
    patientData: { firstName, lastName, dateOfBirth: DOB, personId: PERSON },
    upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Synthetic Clinic', status: 'Active' }],
    pastAppointments: [{ isoDate: '2026-01-01', location: 'Synthetic Clinic', status: 'Active', provider: 'Synthetic Surgeon' }],
    lastPhysicianSeen: 'Synthetic Surgeon',
    totalAppointmentsFound: 2,
  };
}

type Lane = 'tech' | 'optical' | 'surgery' | 'records';
const FILING: Record<Lane, { tool: string; args: Record<string, unknown> }> = {
  tech: { tool: 'file_tech_ticket', args: { request_description: 'Question about my eye drop refill' } },
  optical: { tool: 'file_optical_ticket', args: { request_description: 'Checking on the status of my glasses order' } },
  surgery: { tool: 'file_surgery_ticket', args: { request_description: 'Question about my surgery date', surgeon: 'Synthetic Surgeon' } },
  records: { tool: 'file_records_ticket', args: { request_description: 'I need a copy of my records', requester: 'I am the patient',
    form_channel: 'declined', delivery_method: 'mail', deliver_to: 'to me', date_range: 'everything' } },
};

interface Case { sid: string; ticket: string; lane: Lane; shape: string; record?: string; said?: string }
/** The 17 calls, oldest first. A `said` is the synthetic stand-in for the recorded shape. */
const CORPUS: Case[] = [
  { sid: 'CA596749623650c3e75c4fce5ef07e9d71', ticket: 'VA-83920', lane: 'optical', shape: 'not recorded (before the payload store)' },
  { sid: 'CAacbb5cc29aa687a1c2d49f491418e9d6', ticket: 'VA-83990', lane: 'optical', shape: 'not recorded (before the payload store)' },
  { sid: 'CA091eeaf4979fe60739a16480ffb37fbc', ticket: 'VA-84023', lane: 'records', shape: 'not recorded (before the payload store)' },
  { sid: 'CA41e3c8292620ae0c511810200f2765c8', ticket: 'VA-84271', lane: 'surgery', shape: 'not recorded (before the payload store)' },
  { sid: 'CAa3c56c35b7ed9a2090896d942cde18c7', ticket: 'VA-84354', lane: 'tech', shape: 'not recorded (before the payload store)' },
  { sid: 'CA855487156f252030c8a8c7df9e34e765', ticket: 'VA-84467', lane: 'tech', shape: 'not recorded (before the payload store)' },
  { sid: 'CA0dc9b4aee88c820be0fd557f0b08505e', ticket: 'VA-84669', lane: 'tech', shape: 'not recorded (before the payload store)' },
  { sid: 'CA00594486ac33f5faab022520fc909831', ticket: 'VA-85306', lane: 'surgery', shape: 'not recorded (before the payload store)' },
  { sid: 'CA5bc760209d8cf6c6e223990e08393c69', ticket: 'VA-85688', lane: 'records', shape: 'three letters added', record: 'Dan', said: 'Daniel' },
  { sid: 'CAd3d967cd72228ccfb46b22719c25d0a9', ticket: 'VA-85962', lane: 'tech', shape: 'one letter dropped', record: 'Jennifer', said: 'Jenifer' },
  { sid: 'CA93c1a6563bff7d072b7fe6dfc28d7f27', ticket: 'VA-86263', lane: 'records', shape: 'one letter changed', record: 'Erica', said: 'Erika' },
  { sid: 'CA87fa37b771796adfeae0739fa3001892', ticket: 'VA-86417', lane: 'tech', shape: 'a compound name said as two', record: 'Maryann', said: 'Mary Ann' },
  { sid: 'CA1d3f5c4dc1bd8219ab26fd3fbd60b0ac', ticket: 'VA-86536', lane: 'optical', shape: 'one letter added', record: 'Alana', said: 'Alanna' },
  { sid: 'CA8c953aa34b9eb354d8c6ae52494e6d54', ticket: 'VA-86895', lane: 'optical', shape: 'one letter added', record: 'Carol', said: 'Caroll' },
  { sid: 'CAc3ee3610e48a65d45e0d6fe757941db7', ticket: 'VA-87136', lane: 'tech', shape: 'one letter changed', record: 'Kaitlyn', said: 'Kaitlin' },
  { sid: 'CA371a3e70e7b642c7551d5e06f4417f07', ticket: 'VA-87420', lane: 'tech', shape: 'a middle name added', record: 'Rosa', said: 'Rosa Elena' },
  { sid: 'CA9891836cd161a48666483acb150058c9', ticket: 'VA-87686', lane: 'tech', shape: 'a short form', record: 'Christopher', said: 'Chris' },
];
const LAST = 'Synthetica';

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  lookup.mockReset();
  posted = [];
});

describe('the corpus: the record is matched on the caller\'s spelling, and the filing carries the record\'s names', () => {
  it('holds the 17 calls of the measurement, by lane', () => {
    expect(CORPUS).toHaveLength(17);
    const lanes = CORPUS.reduce<Record<string, number>>((n, c) => ({ ...n, [c.lane]: (n[c.lane] ?? 0) + 1 }), {});
    expect(lanes).toEqual({ tech: 8, optical: 4, records: 3, surgery: 2 });
    expect(CORPUS.filter((c) => c.said)).toHaveLength(9);
  });

  for (const c of CORPUS.filter((x) => x.said && x.record)) {
    it(`${c.sid} (${c.ticket}, ${c.lane}): ${c.shape} — the first create-ticket POST is accepted`, async () => {
      fakeApp(ticketingApiClient);
      lookup.mockResolvedValue(contextFor(c.record!, LAST));
      const looked = await runTool('lookup_patient', { call_sid: c.sid, first_name: c.said, last_name: LAST, date_of_birth: '04/05/1961' });
      expect(looked).toMatchObject({ success: true, identity_is_certain: true });

      const { tool, args } = FILING[c.lane];
      const out = await runTool(tool, { call_sid: c.sid, first_name: c.said, last_name: LAST, date_of_birth: '04/05/1961',
        callback_number: '5555550100', location: 'Synthetic Clinic', ...args }) as Record<string, unknown>;

      expect(posted.length).toBeGreaterThan(0);
      expect(posted[0].refused).toBeNull();
      expect(posted[0].body).toMatchObject({ patientFirstName: c.record, patientLastName: LAST,
        validatedPatient: { callSid: c.sid, firstName: c.record, lastName: LAST } });
      expect(posted.every((p) => p.refused === null)).toBe(true);
      expect(out.success).toBe(true);

      // The outbox keeps what was filed, and a replay may run in a process that
      // no longer holds the identity: the stored payload alone must be accepted.
      const calls = vi.mocked(TicketOutboxService.writeToOutbox).mock.calls;
      const stored = calls[calls.length - 1]?.[0] as unknown as { params: Payload } | undefined;
      expect(stored?.params).toMatchObject({ patientFirstName: c.record, validatedPatient: { firstName: c.record } });
      resetVerifiedIdentities();
      posted = [];
      await ticketingApiClient.createTicket(stored!.params as never);
      expect(posted[0].refused).toBeNull();
    });
  }
});

describe('the rule at the filing step (prepareTicketIdentity)', () => {
  const sid = 'CA' + '5'.repeat(32);
  function hold(extra: Record<string, unknown> = {}) {
    rememberVerifiedIdentity(sid, { firstName: 'Christopher', lastName: LAST, dateOfBirth: DOB, certain: true,
      personId: PERSON, heardAs: ['Chris'], ...extra });
  }

  it('the queue lanes\' gate files a validated patient under the record\'s names', () => {
    hold();
    const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST }, { recordNames: true });
    expect(input).toMatchObject({ first_name: 'Christopher', last_name: LAST, date_of_birth: DOB });
  });

  it('the other chart\'s last name files under the held chart\'s', () => {
    hold({ alsoKnownAs: ['Maidenname'] });
    const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Christopher', last_name: 'Maidenname' }, { recordNames: true });
    expect(input).toMatchObject({ first_name: 'Christopher', last_name: LAST });
  });

  it('a name the held person does not answer to is left as given, and carries nothing of the record', () => {
    hold();
    const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Morgan', last_name: LAST, date_of_birth: '02/03/1990' }, { recordNames: true });
    expect(input).toMatchObject({ first_name: 'Morgan', last_name: LAST, date_of_birth: '02/03/1990' });
  });

  it('without the option (the after-hours and answering-service gates) the caller\'s spelling is kept, as before', () => {
    hold();
    const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST });
    expect(input).toMatchObject({ first_name: 'Chris', last_name: LAST });
  });

  describe('a date of birth that does not read stops the rename at the gate (github-actions review of #506, round 2)', () => {
    it('a name the person answers to beside a date that does not read is not renamed, and the date is not replaced', () => {
      hold();
      const out = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST, date_of_birth: 'not a date' }, { recordNames: true });
      expect(out.input).toMatchObject({ first_name: 'Chris', last_name: LAST, date_of_birth: 'not a date' });
      // With no spoken date to fall back on, the gate asks for it rather than filing the record's date beside an alias.
      expect(out.missing).toBe('date_of_birth');
    });

    it('a partial date beside a name the person answers to is not renamed', () => {
      hold();
      const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST, date_of_birth: '1961' }, { recordNames: true });
      expect(input).toMatchObject({ first_name: 'Chris' });
      expect(input.date_of_birth).not.toBe(DOB);
    });

    it('the record\'s own spelling beside a date that does not read still takes the record\'s date, as before', () => {
      hold();
      const out = prepareTicketIdentity({ call_sid: sid, first_name: 'Christopher', last_name: LAST, date_of_birth: 'not a date' }, { recordNames: true });
      expect(out.input).toMatchObject({ first_name: 'Christopher', last_name: LAST, date_of_birth: DOB });
      expect(out.missing).toBeUndefined();
    });

    it('a date that reads and is the record\'s, in another form, still renames', () => {
      hold();
      const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST, date_of_birth: '04/05/1961' }, { recordNames: true });
      expect(input).toMatchObject({ first_name: 'Christopher', last_name: LAST, date_of_birth: DOB });
    });

    it('a held person with no date of birth, beside a date the caller gave, is not renamed', () => {
      hold({ dateOfBirth: undefined });
      const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST, date_of_birth: '04/05/1961' }, { recordNames: true });
      expect(input).toMatchObject({ first_name: 'Chris', last_name: LAST, date_of_birth: '04/05/1961' });
    });

    it('without the option nothing changes: a date that does not read is still replaced by the record\'s', () => {
      hold();
      const { input } = prepareTicketIdentity({ call_sid: sid, first_name: 'Chris', last_name: LAST, date_of_birth: 'not a date' });
      expect(input).toMatchObject({ first_name: 'Chris', last_name: LAST, date_of_birth: DOB });
    });
  });

  it('the registry passes the option for the four queue filing tools', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./registry.ts', import.meta.url), 'utf8');
    expect(src).toContain('prepareTicketIdentity(input, { recordNames: true })');
  });
});

describe('the rule at the create-ticket transport (recordNamesFor), for every caller of createTicket', () => {
  const sid = 'CA' + '6'.repeat(32);
  const base = { departmentId: 3, requestTypeId: 1, requestReasonId: 1, patientPhone: '5555550100',
    description: 'Synthetic request', callData: { callSid: sid } };
  function hold(extra: Record<string, unknown> = {}) {
    rememberVerifiedIdentity(sid, { firstName: 'Christopher', lastName: LAST, dateOfBirth: DOB, certain: true,
      personId: PERSON, heardAs: ['Chris'], ...extra });
  }

  it('a payload in the caller\'s spelling, with no validated patient attached (the PCP patient path), is sent under the record\'s names', async () => {
    hold();
    const api = new TicketingApiClient();
    fakeApp(api);
    const res = await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST });
    expect(res.success).toBe(true);
    expect(posted[0]).toMatchObject({ refused: null, body: { patientFirstName: 'Christopher', patientLastName: LAST,
      validatedPatient: { firstName: 'Christopher', lastName: LAST, personId: PERSON } } });
  });

  it('an attached validated patient and a payload in the caller\'s spelling are made to agree', async () => {
    hold();
    const api = new TicketingApiClient();
    fakeApp(api);
    const validatedPatient = validatedPatientFor(sid, 'Chris', LAST)!;
    await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST, validatedPatient });
    expect(posted[0]).toMatchObject({ refused: null, body: { patientFirstName: 'Christopher', patientLastName: LAST } });
  });

  it('another person\'s names beside an attached validated patient are never written over', async () => {
    hold();
    const api = new TicketingApiClient();
    fakeApp(api);
    const validatedPatient = validatedPatientFor(sid, 'Christopher', LAST)!;
    await api.createTicket({ ...base, patientFirstName: 'Morgan', patientLastName: LAST, validatedPatient });
    expect(posted[0].body).toMatchObject({ patientFirstName: 'Morgan', patientLastName: LAST });
    expect(posted[0].refused).toBe('name');
  });

  it('a replay in a process that no longer holds the identity sends the payload as stored', async () => {
    hold();
    const validatedPatient = validatedPatientFor(sid, 'Chris', LAST)!;
    resetVerifiedIdentities();
    const api = new TicketingApiClient();
    fakeApp(api);
    await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST, validatedPatient });
    expect(posted[0].body).toMatchObject({ patientFirstName: 'Chris' });
  });

  it('an attached validated patient beside a date of birth that is not the record\'s is not renamed', async () => {
    hold();
    const api = new TicketingApiClient();
    fakeApp(api);
    const validatedPatient = validatedPatientFor(sid, 'Chris', LAST)!;
    await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST, validatedPatient,
      patientBirthYear: '1990', patientBirthMonth: '02', patientBirthDay: '03' });
    expect(posted[0].body).toMatchObject({ patientFirstName: 'Chris' });
  });

  it('"Unknown Caller" is left for the app to fill, as before', async () => {
    hold();
    const api = new TicketingApiClient();
    fakeApp(api);
    await api.createTicket({ ...base, patientFirstName: 'Unknown', patientLastName: 'Caller' });
    expect(posted[0]).toMatchObject({ refused: null, body: { patientFirstName: 'Unknown', patientLastName: 'Caller' } });
  });

  it('recordNamesFor refuses an attached patient that is not the held person', () => {
    hold();
    const held = validatedPatientFor(sid, 'Chris', LAST)!;
    expect(recordNamesFor(sid, 'Chris', LAST, undefined, held)).toEqual({ firstName: 'Christopher', lastName: LAST });
    expect(recordNamesFor(sid, 'Chris', LAST, undefined, { ...held, personId: 'another-person' })).toBeUndefined();
    expect(recordNamesFor(sid, 'Chris', LAST, undefined, { ...held, firstName: 'Christina' })).toBeUndefined();
    expect(recordNamesFor(sid, 'Chris', LAST, undefined, { ...held, callSid: 'CA' + '7'.repeat(32) })).toBeUndefined();
    expect(recordNamesFor(sid, 'Chris', LAST, '1990-02-03', held)).toBeUndefined();
    expect(recordNamesFor(sid, 'Chris', LAST, undefined, undefined)).toBeUndefined();
  });

  describe('a date of birth given in part stops the rename at the transport (github-actions review of #506, round 2)', () => {
    async function send(parts: Record<string, string>) {
      hold();
      const api = new TicketingApiClient();
      fakeApp(api);
      const validatedPatient = validatedPatientFor(sid, 'Chris', LAST)!;
      await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST, validatedPatient, ...parts });
      return posted[0].body;
    }

    it('a lone birth year that is not the record\'s is not renamed', async () => {
      expect(await send({ patientBirthYear: '1990' })).toMatchObject({ patientFirstName: 'Chris' });
    });

    it('a year and a month with no day are not renamed', async () => {
      expect(await send({ patientBirthYear: '1961', patientBirthMonth: '04' })).toMatchObject({ patientFirstName: 'Chris' });
    });

    it('a day alone is not renamed', async () => {
      expect(await send({ patientBirthDay: '05' })).toMatchObject({ patientFirstName: 'Chris' });
    });

    it('blank parts are no date at all, and the person id still renames', async () => {
      expect(await send({ patientBirthYear: ' ', patientBirthMonth: '', patientBirthDay: '' })).toMatchObject({ patientFirstName: 'Christopher' });
    });

    it('a complete date that is the record\'s still renames', async () => {
      expect(await send({ patientBirthYear: '1961', patientBirthMonth: '4', patientBirthDay: '5' })).toMatchObject({ patientFirstName: 'Christopher' });
    });
  });

  describe('a shared record name is not proof of the same person (Codex P1 on #506)', () => {
    it('an attached patient with another date of birth, no person id on either side, is not renamed', () => {
      hold({ personId: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(held.personId).toBeUndefined();
      // The parent and the child share the record name; the attached one is the other person.
      const stale = { ...held, dateOfBirth: '1960-04-05' };
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, stale)).toBeUndefined();
    });

    it('an attached patient with no date of birth, beside a held one that has it, is not renamed', () => {
      hold({ personId: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      const { dateOfBirth: _dropped, ...noDob } = held;
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, noDob)).toBeUndefined();
    });

    it('an attached patient with no person id, beside a held one that has it, is not renamed', () => {
      hold();
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      const { personId: _dropped, ...noPerson } = held;
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, noPerson)).toBeUndefined();
    });

    it('a held person with neither a person id nor a date of birth renames nothing', () => {
      hold({ personId: undefined, dateOfBirth: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(held.personId).toBeUndefined();
      expect(held.dateOfBirth).toBeUndefined();
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, held)).toBeUndefined();
    });

    it('a held person known by date of birth alone still renames the same person', () => {
      hold({ personId: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, held)).toEqual({ firstName: 'Christopher', lastName: LAST });
    });

    it('a held person with no date of birth, beside a payload that carries one, renames nothing (github-actions review of #506)', () => {
      hold({ dateOfBirth: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(held.dateOfBirth).toBeUndefined();
      expect(held.personId).toBe(PERSON);
      // The person id agrees, but nothing establishes that the payload's date is this person's.
      expect(recordNamesFor(sid, 'Chris', LAST, '1960-04-05', held)).toBeUndefined();
      // With no date on the payload either, the person id is the key, as before.
      expect(recordNamesFor(sid, 'Chris', LAST, undefined, held)).toEqual({ firstName: 'Christopher', lastName: LAST });
    });

    it('a date of birth on the payload that does not read renames nothing', () => {
      hold();
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(recordNamesFor(sid, 'Chris', LAST, 'not a date', held)).toBeUndefined();
      expect(recordNamesFor(sid, 'Chris', LAST, '   ', held)).toEqual({ firstName: 'Christopher', lastName: LAST });
    });

    it('a date of birth on the payload that is the held one still renames the same person', () => {
      hold();
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      expect(recordNamesFor(sid, 'Chris', LAST, held.dateOfBirth, held)).toEqual({ firstName: 'Christopher', lastName: LAST });
    });

    it('a stale patient from the other person, sent with no date-of-birth columns, is refused by the app, not accepted', async () => {
      hold({ personId: undefined });
      const held = validatedPatientFor(sid, 'Chris', LAST)!;
      const api = new TicketingApiClient();
      fakeApp(api);
      await api.createTicket({ ...base, patientFirstName: 'Chris', patientLastName: LAST,
        validatedPatient: { ...held, dateOfBirth: '1960-04-05' } });
      expect(posted[0].body).toMatchObject({ patientFirstName: 'Chris' });
      expect(posted[0].refused).toBe('name');
    });
  });
});
