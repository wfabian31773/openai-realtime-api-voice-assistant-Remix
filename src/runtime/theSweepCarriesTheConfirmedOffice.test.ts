/**
 * THE TEARDOWN SWEEP CARRIES THE OFFICE THE CALLER CONFIRMED — v257.
 *
 * When the caller names an office, `resolve_location` verifies it and keeps it
 * for the call (`rememberConfirmedClinic`), and every in-call filing tool
 * carries it first, as the caller's own office, ahead of the record's history
 * (`prepareTicketIdentity`; v12: "an office the caller names still always
 * wins"). The teardown sweep never read it. A caller who confirmed Montebello
 * and hung up before the agent filed got a ticket with no office, or with the
 * office on their record.
 *
 * THE CORPUS: every swept ticket, 2026-11-14..21, on a call whose
 * `resolve_location` verified an office (16). What the sweep sent, read from
 * `voice_agent_api_logs`: the confirmed office on 1 (VA-87644, where the
 * record's office happened to be the same one), no office on 8, and another
 * office on 7. The office below is the LAST one each call verified, read from
 * `tool_call_payloads`; office names are clinics, not patient data. Every
 * name, request and date below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: vi.fn() },
}));

const OFFICES = new Set([
  'Montebello', 'Glendora', 'Mission Hills', 'Santa Ana', 'Anaheim', 'Redlands',
  'Fullerton', 'Northridge', 'Huntington Beach', 'Laguna Hills',
]);
const directory = vi.hoisted(() => ({ up: true, failing: false as false | 'miss' | 'throw' }));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => directory.up,
  lookupLocation: async (name: string) => {
    if (directory.failing === 'throw') throw new Error('directory unreachable');
    if (directory.failing === 'miss') return null;
    const bare = name.replace(/^azul vision\s+/i, '').trim();
    if (/surgery center/i.test(bare)) return { canonical: bare, facilityKind: 'surgery_center' };
    const hit = [...OFFICES].find((o) => o.toLowerCase() === bare.toLowerCase());
    return hit ? { canonical: `Azul Vision ${hit}`, facilityKind: 'clinic' } : null;
  },
  lookupProvider: async () => null,
}));

const { createTicketDurable } = vi.hoisted(() => ({ createTicketDurable: vi.fn() }));
vi.mock('../services/durableTicketFiling', () => ({ createTicketDurable }));

const { runTool } = await import('../tools/registry');
// Registers resolve_location (and lookup_patient) with the registry.
await import('../tools/sharedPatientTools');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { resetStatedNames, noteStatedNameFromArgs } = await import('../tools/statedName');
const { rememberVerifiedIdentity, resetVerifiedIdentities, confirmedClinicFor, verifiedClinicFor } = await import('../tools/verifiedIdentity');
const { resetDraftedRequests, noteDraftedRequestFromArgs } = await import('../tools/draftedRequest');
const { runRequestSweep } = await import('./sweepRunner');
import type { SweepFiler } from './sweepRunner';
import type { VoiceCallRecord } from './mediaStreamBridge';

type Lane = 'optical' | 'surgery' | 'tech';

interface Row {
  sid: string; ticket: string; lane: Lane;
  /** The last office `resolve_location` verified on the call. */
  confirmed: string;
  /** What the sweep sent on main: the record's office, or nothing. */
  mainSent: string | null;
  /** Whether the call held a certain identity at teardown (validatedPatient on the POST). */
  certain: boolean;
}

const CORPUS: Row[] = [
  { sid: 'CA8f4f27e8ac6169073026544ba682f514', ticket: 'VA-85525', lane: 'optical', confirmed: 'Montebello', mainSent: null, certain: false },
  { sid: 'CA5c4e37204b2f8de7b366920f39dab819', ticket: 'VA-85844', lane: 'tech', confirmed: 'Glendora', mainSent: null, certain: true },
  { sid: 'CAd64e18176644067d73bea1e49764acb0', ticket: 'VA-85965', lane: 'optical', confirmed: 'Mission Hills', mainSent: 'Northridge', certain: true },
  { sid: 'CA02055d0d78fa7fac6a9d04d0684ee0cf', ticket: 'VA-86024', lane: 'optical', confirmed: 'Santa Ana', mainSent: 'Anaheim', certain: true },
  { sid: 'CAd47b6d51da008c93f179fcb0e4a2a815', ticket: 'VA-86208', lane: 'optical', confirmed: 'Anaheim', mainSent: 'Huntington Beach', certain: true },
  { sid: 'CA3f16d9d33f60055b730697c70b3d1a77', ticket: 'VA-86437', lane: 'optical', confirmed: 'Redlands', mainSent: null, certain: true },
  { sid: 'CAd7c8667796ead2c79ab9f112675fa600', ticket: 'VA-86601', lane: 'optical', confirmed: 'Anaheim', mainSent: null, certain: true },
  { sid: 'CAb36a92dcf905a35e733e7f71ae192420', ticket: 'VA-86714', lane: 'optical', confirmed: 'Anaheim', mainSent: 'Fullerton', certain: true },
  { sid: 'CA49fa690896f9db6830523f8aa0f54742', ticket: 'VA-87037', lane: 'optical', confirmed: 'Mission Hills', mainSent: null, certain: true },
  { sid: 'CAdf34672239ef8b9b864ec2cc8d3bb124', ticket: 'VA-87459', lane: 'optical', confirmed: 'Mission Hills', mainSent: 'Northridge', certain: true },
  { sid: 'CAfb749f78f08d068fe55390becfddf3e9', ticket: 'VA-87571', lane: 'optical', confirmed: 'Anaheim', mainSent: 'Santa Ana', certain: true },
  { sid: 'CA5791f42de2c99d753d7dfc5012bf7563', ticket: 'VA-87588', lane: 'optical', confirmed: 'Santa Ana', mainSent: 'Laguna Hills', certain: true },
  { sid: 'CA6bfdffc8fc0bb7ae1c9cb4b8d546269b', ticket: 'VA-87642', lane: 'surgery', confirmed: 'Redlands', mainSent: null, certain: true },
  { sid: 'CA861284f1441acb9ef70c141c3861c9cc', ticket: 'VA-87644', lane: 'optical', confirmed: 'Montebello', mainSent: 'Montebello', certain: true },
  { sid: 'CA78b01ae029bc0d0052a8025d2b62bead', ticket: 'VA-88247', lane: 'optical', confirmed: 'Santa Ana', mainSent: null, certain: true },
  { sid: 'CA591cd26bbf623a6db39af6959edd0d8a', ticket: 'VA-88260', lane: 'optical', confirmed: 'Mission Hills', mainSent: null, certain: true },
];

const GREETING = 'AGENT: Thank you for calling Azul Vision. I can take a message and they will follow up with you. Am I speaking with Testa?';

function record(callSid: string, slug: Lane): VoiceCallRecord {
  const lines = [
    GREETING,
    'CALLER: Yes.',
    'AGENT: How can I help you today?',
    'CALLER: I need to check on the order I placed last week, it was supposed to be ready.',
    'AGENT: Which of our offices do you usually visit?',
    'CALLER: The one by me.',
    'AGENT: Thank you. Let me get this logged for you, one moment. [interrupted]',
  ];
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents: [
      { name: 'lookup_patient', ok: true, succeeded: true },
      { name: 'resolve_location', ok: true, succeeded: true },
    ],
    agentTurns: 4,
    interruptions: 1,
    startedAtMs: 1_000,
    endedAtMs: 91_000,
  } as VoiceCallRecord;
}

function filer(): SweepFiler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = (async (ticket: unknown) => {
    calls.push(ticket as Record<string, unknown>);
    return { success: true, ticketNumber: 'VA-SWEEP-1' };
  }) as SweepFiler & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

/** The call as it happened: who the caller is, then the office they confirmed. */
async function theCall(row: Row, opts: { confirm?: boolean } = {}) {
  if (row.certain) {
    rememberVerifiedIdentity(row.sid, {
      firstName: 'Testa', lastName: 'Lake', dateOfBirth: '1960-01-01', certain: true,
      ...(row.mainSent ? { usualOffice: row.mainSent, lastVisit: { date: '2026-06-01', location: row.mainSent } } : {}),
    });
  } else {
    noteStatedNameFromArgs('lookup_patient', { call_sid: row.sid, first_name: 'Testa', last_name: 'Lake' });
  }
  noteDraftedRequestFromArgs(`file_${row.lane}_ticket`, {
    call_sid: row.sid, request_description: 'Checking on an order placed last week.',
  });
  if (opts.confirm !== false) {
    const out = await runTool('resolve_location', { queue: row.lane === 'tech' ? undefined : row.lane, spoken_location: row.confirmed, call_sid: row.sid });
    expect(out).toMatchObject({ success: true, verified: true, location: row.confirmed });
  }
}

beforeEach(() => {
  directory.up = true;
  directory.failing = false;
  resetGateAttempts();
  resetStatedNames();
  resetVerifiedIdentities();
  resetDraftedRequests();
  createTicketDurable.mockReset();
});

describe('the corpus: every swept ticket on a call that verified an office, 2026-11-14..21', () => {
  it('is the 16 measured, and main sent the confirmed office on 1 of them', () => {
    expect(CORPUS).toHaveLength(16);
    expect(CORPUS.filter((r) => r.mainSent === r.confirmed).map((r) => r.ticket)).toEqual(['VA-87644']);
    expect(CORPUS.filter((r) => r.mainSent === null)).toHaveLength(8);
    expect(CORPUS.filter((r) => r.mainSent !== null && r.mainSent !== r.confirmed)).toHaveLength(7);
  });

  for (const row of CORPUS) {
    it(`${row.ticket} (${row.sid}) files with the office the caller confirmed, ${row.confirmed}`, async () => {
      await theCall(row);
      const f = filer();
      const out = await runRequestSweep(record(row.sid, row.lane), f);
      expect(out.filed).toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].locationOfLastVisit).toBe(row.confirmed);
      expect(f.calls[0].locationSource).toBe('caller');
    });
  }
});

describe('what the sweep did before is unchanged when nothing was confirmed', () => {
  const recordOffice = CORPUS.find((r) => r.ticket === 'VA-86024')!;
  const noOffice = CORPUS.find((r) => r.ticket === 'VA-85525')!;

  it('a certain identity with no confirmed office still files the record\'s office as history', async () => {
    await theCall(recordOffice, { confirm: false });
    const f = filer();
    await runRequestSweep(record(recordOffice.sid, recordOffice.lane), f);
    expect(f.calls[0].locationOfLastVisit).toBe('Anaheim');
    expect(f.calls[0].locationSource).toBe('history');
  });

  it('no identity and no confirmed office files no office', async () => {
    await theCall(noOffice, { confirm: false });
    const f = filer();
    await runRequestSweep(record(noOffice.sid, noOffice.lane), f);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
    expect(f.calls[0].locationSource).toBeUndefined();
  });
});

describe('only an office resolve_location kept is carried', () => {
  it('a surgery centre refused on the optical line is not the caller\'s office', async () => {
    const row = { ...CORPUS[0], sid: 'CA000000000000000000000000000000b1' };
    await theCall(row, { confirm: false });
    const refused = await runTool('resolve_location', { queue: 'optical', spoken_location: 'Example Surgery Center', call_sid: row.sid });
    expect(refused.success).toBe(false);
    expect(confirmedClinicFor(row.sid)).toBeUndefined();
    const f = filer();
    await runRequestSweep(record(row.sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
  });

  it('a later confirmation replaces an earlier one, as on VA-86601 (Fullerton, then Anaheim)', async () => {
    const row = CORPUS.find((r) => r.ticket === 'VA-86601')!;
    await theCall({ ...row, confirmed: 'Fullerton' });
    await runTool('resolve_location', { queue: 'optical', spoken_location: 'Anaheim', call_sid: row.sid });
    const f = filer();
    await runRequestSweep(record(row.sid, row.lane), f);
    expect(f.calls[0].locationOfLastVisit).toBe('Anaheim');
  });

  it('another call\'s confirmed office is not this call\'s', async () => {
    const [a, b] = [CORPUS[2], CORPUS[3]];
    await theCall(a);
    await theCall(b, { confirm: false });
    const f = filer();
    await runRequestSweep(record(b.sid, b.lane), f);
    expect(f.calls[0].locationOfLastVisit).toBe('Anaheim');
    expect(f.calls[0].locationSource).toBe('history');
  });
});

describe('the real filer sends it on', () => {
  it('createTicketDurable receives the office and its source', async () => {
    const row = CORPUS.find((r) => r.ticket === 'VA-87588')!;
    await theCall(row);
    createTicketDurable.mockResolvedValue({ success: true, ticketNumber: 'VA-SWEEP-2' });
    const out = await runRequestSweep(record(row.sid, row.lane));
    expect(out.filed).toBe(true);
    const payload = createTicketDurable.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.locationOfLastVisit).toBe('Santa Ana');
    expect(payload.locationSource).toBe('caller');
  });

  it('the store is read through a static import (one module copy on Node 20)', () => {
    const src = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bverifiedClinicHitFor\b[^}]*\} from "\.\.\/tools\/verifiedIdentity";/);
    expect(src).not.toMatch(/import\(\s*['"]\.\.\/tools\/verifiedIdentity['"]\s*\)/);
  });
});

/**
 * CODEX P1 ON #505: ONLY AN OFFICE THE DIRECTORY VERIFIED IS CARRIED.
 *
 * The call's office store also keeps the caller's words when
 * `resolve_location` passes them through unverified: the ask is spent
 * (`ask_exhausted`), or the Console directory is not configured. The in-call
 * tools still read those (the ticketing API resolves the office), but the
 * sweep files after the caller has gone and sends its office as the caller's
 * own, which skips the Optical filter. Measured, swept agent tickets
 * 2026-11-07..21 on calls whose `resolve_location` only passed an office
 * through unverified: 3, all optical (below); none on surgery, tech or
 * records. Each now files as it did before v257.
 */
const UNVERIFIED: { sid: string; ticket: string }[] = [
  { sid: 'CAf55e006e8dc4db52ba5b4ce591acee29', ticket: 'VA-82586' },
  { sid: 'CAe491f8bbc8497844c04352e5d4336fbe', ticket: 'VA-87956' },
  { sid: 'CAcc8cf9fa9f711969c59e1d1a9e25d26b', ticket: 'VA-88009' },
];

/** Asks for an office the directory does not know until the ask is spent. */
async function spendTheAsk(sid: string, spoken = 'Example Valley') {
  let out: Record<string, unknown> = {};
  for (let i = 0; i < 3; i++) {
    out = await runTool('resolve_location', { queue: 'optical', spoken_location: spoken, call_sid: sid }) as Record<string, unknown>;
  }
  return out;
}

describe('an office passed through unverified is not carried by the sweep (Codex P1 on #505)', () => {
  for (const row of UNVERIFIED) {
    it(`${row.ticket} (${row.sid}): a spent ask's words stay off the swept ticket`, async () => {
      noteStatedNameFromArgs('lookup_patient', { call_sid: row.sid, first_name: 'Testa', last_name: 'Lake' });
      const out = await spendTheAsk(row.sid);
      expect(out).toMatchObject({ success: true, resolved: false, verified: false, ask_exhausted: true });
      // The in-call tools still get the caller's words; the sweep does not.
      expect(confirmedClinicFor(row.sid)).toBe('Example Valley');
      expect(verifiedClinicFor(row.sid)).toBeUndefined();
      const f = filer();
      const res = await runRequestSweep(record(row.sid, 'optical'), f);
      expect(res.filed).toBe(true);
      expect(f.calls[0].locationOfLastVisit).toBeUndefined();
      expect(f.calls[0].locationSource).toBeUndefined();
    });
  }

  it('with a certain identity, the record\'s office is sent as history, not the unverified words', async () => {
    const row = { ...CORPUS.find((r) => r.ticket === 'VA-86024')!, sid: 'CA000000000000000000000000000000c1' };
    await theCall(row, { confirm: false });
    await spendTheAsk(row.sid);
    const f = filer();
    await runRequestSweep(record(row.sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBe('Anaheim');
    expect(f.calls[0].locationSource).toBe('history');
  });

  it('a surgery centre passed through on a spent ask is not carried either', async () => {
    const sid = 'CA000000000000000000000000000000c2';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    let out: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      out = await runTool('resolve_location', { queue: 'optical', spoken_location: 'Example Surgery Center', call_sid: sid }) as Record<string, unknown>;
    }
    expect(out).toMatchObject({ verified: false, ask_exhausted: true });
    const f = filer();
    await runRequestSweep(record(sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
  });

  it('with no directory configured, the words passed through are not carried', async () => {
    directory.up = false;
    const sid = 'CA000000000000000000000000000000c3';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    const out = await runTool('resolve_location', { queue: 'optical', spoken_location: 'Montebello', call_sid: sid });
    expect(out).toMatchObject({ success: true, resolved: false, verified: false });
    expect(confirmedClinicFor(sid)).toBe('Montebello');
    const f = filer();
    await runRequestSweep(record(sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
  });

  it('a verified office after an unverified one is carried', async () => {
    const sid = 'CA000000000000000000000000000000c4';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    directory.up = false;
    await runTool('resolve_location', { queue: 'optical', spoken_location: 'The one by me', call_sid: sid });
    directory.up = true;
    const out = await runTool('resolve_location', { queue: 'optical', spoken_location: 'Glendora', call_sid: sid });
    expect(out).toMatchObject({ verified: true });
    const f = filer();
    await runRequestSweep(record(sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBe('Glendora');
    expect(f.calls[0].locationSource).toBe('caller');
  });

  it('an unverified office after a verified one replaces it, so the sweep carries neither', async () => {
    const sid = 'CA000000000000000000000000000000c5';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    await runTool('resolve_location', { queue: 'optical', spoken_location: 'Glendora', call_sid: sid });
    expect(verifiedClinicFor(sid)).toBe('Glendora');
    directory.up = false;
    await runTool('resolve_location', { queue: 'optical', spoken_location: 'Actually the other one', call_sid: sid });
    expect(confirmedClinicFor(sid)).toBe('Actually the other one');
    expect(verifiedClinicFor(sid)).toBeUndefined();
    const f = filer();
    await runRequestSweep(record(sid, 'optical'), f);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
  });
});

/**
 * CODEX P1 ON #505 (round 2): THE OFFICE MUST SUIT THE DEPARTMENT THE TICKET
 * FILES IN, NOT ONLY THE LANE THAT VERIFIED IT.
 *
 * `resolve_location` verifies an office for the lane that took the call, and
 * the tech line accepts any facility kind. Since v253 a tech-line eyewear
 * request swept at teardown files in Optical, which routes by office and takes
 * clinics only; `locationSource: 'caller'` skips the client's Optical filter.
 * So a surgery centre verified on the tech line reached an Optical ticket as
 * the caller's own office. Measured, `tool_call_payloads` 2026-11-16..21: the
 * verified offices were clinics on every lane (optical 85, surgery 12, tech 11,
 * records 1, one with no kind), so the shape has occurred 0 times; it is closed
 * because it fails safe and costs no rescue.
 */
describe('a verified office must suit the department the ticket files in (Codex P1 on #505)', () => {
  async function aTechGlassesCall(sid: string, spoken: string, certainOffice?: string) {
    if (certainOffice) {
      rememberVerifiedIdentity(sid, {
        firstName: 'Testa', lastName: 'Lake', dateOfBirth: '1960-01-01', certain: true,
        usualOffice: certainOffice, lastVisit: { date: '2026-06-01', location: certainOffice },
      });
    } else {
      noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    }
    noteDraftedRequestFromArgs('file_tech_ticket', {
      call_sid: sid, request_description: 'Checking on a glasses order placed last week.',
    });
    const out = await runTool('resolve_location', { spoken_location: spoken, call_sid: sid });
    expect(out).toMatchObject({ success: true, verified: true });
    expect(verifiedClinicFor(sid)).toBe(spoken);
  }

  it('a surgery centre verified on the tech line is not carried onto an Optical ticket', async () => {
    const sid = 'CA000000000000000000000000000000d1';
    await aTechGlassesCall(sid, 'Example Surgery Center');
    const f = filer();
    await runRequestSweep(record(sid, 'tech'), f);
    expect(f.calls[0].departmentId).toBe(1);
    expect(f.calls[0].locationOfLastVisit).toBeUndefined();
    expect(f.calls[0].locationSource).toBeUndefined();
  });

  it('with a certain identity, the record\'s clinic is sent as history instead', async () => {
    const sid = 'CA000000000000000000000000000000d2';
    await aTechGlassesCall(sid, 'Example Surgery Center', 'Glendora');
    const f = filer();
    await runRequestSweep(record(sid, 'tech'), f);
    expect(f.calls[0].departmentId).toBe(1);
    expect(f.calls[0].locationOfLastVisit).toBe('Glendora');
    expect(f.calls[0].locationSource).toBe('history');
  });

  it('a clinic verified on the tech line is carried onto the Optical ticket', async () => {
    const sid = 'CA000000000000000000000000000000d3';
    await aTechGlassesCall(sid, 'Montebello');
    const f = filer();
    await runRequestSweep(record(sid, 'tech'), f);
    expect(f.calls[0].departmentId).toBe(1);
    expect(f.calls[0].locationOfLastVisit).toBe('Montebello');
    expect(f.calls[0].locationSource).toBe('caller');
  });

  it('a surgery centre verified on the surgery line is carried onto a Surgery ticket', async () => {
    const sid = 'CA000000000000000000000000000000d4';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    noteDraftedRequestFromArgs('file_surgery_ticket', {
      call_sid: sid, request_description: 'Checking on an order placed last week.',
    });
    const out = await runTool('resolve_location', { queue: 'surgery', spoken_location: 'Example Surgery Center', call_sid: sid });
    expect(out).toMatchObject({ success: true, verified: true });
    const f = filer();
    await runRequestSweep(record(sid, 'surgery'), f);
    expect(f.calls[0].departmentId).toBe(2);
    expect(f.calls[0].locationOfLastVisit).toBe('Example Surgery Center');
    expect(f.calls[0].locationSource).toBe('caller');
  });

  it('a surgery centre verified on the tech line stays on a Technicians ticket', async () => {
    const sid = 'CA000000000000000000000000000000d5';
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    noteDraftedRequestFromArgs('file_tech_ticket', {
      call_sid: sid, request_description: 'Checking on an order placed last week.',
    });
    await runTool('resolve_location', { spoken_location: 'Example Surgery Center', call_sid: sid });
    const f = filer();
    await runRequestSweep(record(sid, 'tech'), f);
    expect(f.calls[0].departmentId).toBe(3);
    expect(f.calls[0].locationOfLastVisit).toBe('Example Surgery Center');
  });
});

/**
 * GITHUB-ACTIONS REVIEW OF #505, ROUND 3: THE KIND IS KEPT AT THE VERIFIED HIT.
 *
 * Round 2 asked the directory again at teardown, and `mostRecentAcceptable`
 * accepts the supplied name when the directory misses or throws, so a surgery
 * centre verified on the tech line reached an Optical ticket whenever the
 * directory failed during the sweep. The store now keeps the facility kind
 * `resolve_location` was given when it verified the office, and the sweep
 * judges it with Optical's own rule, with no second read.
 */
describe('the facility kind is kept from the verified hit (github-actions review of #505, round 3)', () => {
  async function verifiedOnTheTechLine(sid: string, spoken: string) {
    noteStatedNameFromArgs('lookup_patient', { call_sid: sid, first_name: 'Testa', last_name: 'Lake' });
    noteDraftedRequestFromArgs('file_tech_ticket', {
      call_sid: sid, request_description: 'Checking on a glasses order placed last week.',
    });
    const out = await runTool('resolve_location', { spoken_location: spoken, call_sid: sid });
    expect(out).toMatchObject({ success: true, verified: true });
  }

  for (const failing of ['throw', 'miss'] as const) {
    it(`a surgery centre is not carried onto an Optical ticket when the directory ${failing === 'throw' ? 'throws' : 'misses'} at teardown`, async () => {
      const sid = failing === 'throw' ? 'CA000000000000000000000000000000e1' : 'CA000000000000000000000000000000e2';
      await verifiedOnTheTechLine(sid, 'Example Surgery Center');
      directory.failing = failing;
      const f = filer();
      await runRequestSweep(record(sid, 'tech'), f);
      expect(f.calls[0].departmentId).toBe(1);
      expect(f.calls[0].locationOfLastVisit).toBeUndefined();
      expect(f.calls[0].locationSource).toBeUndefined();
    });

    it(`a clinic is still carried onto the Optical ticket when the directory ${failing === 'throw' ? 'throws' : 'misses'} at teardown`, async () => {
      const sid = failing === 'throw' ? 'CA000000000000000000000000000000e3' : 'CA000000000000000000000000000000e4';
      await verifiedOnTheTechLine(sid, 'Montebello');
      directory.failing = failing;
      const f = filer();
      await runRequestSweep(record(sid, 'tech'), f);
      expect(f.calls[0].departmentId).toBe(1);
      expect(f.calls[0].locationOfLastVisit).toBe('Montebello');
      expect(f.calls[0].locationSource).toBe('caller');
    });
  }

  it('the store keeps the kind of a verified office, and none for an office passed through unverified', async () => {
    const { rememberConfirmedClinic, verifiedClinicHitFor } = await import('../tools/verifiedIdentity');
    const verified = 'CA000000000000000000000000000000e5';
    rememberConfirmedClinic(verified, 'Example Surgery Center', { verified: true, facilityKind: 'surgery_center' });
    expect(verifiedClinicHitFor(verified)).toEqual({ clinic: 'Example Surgery Center', facilityKind: 'surgery_center' });
    const passed = 'CA000000000000000000000000000000e6';
    rememberConfirmedClinic(passed, 'Somewhere', { facilityKind: 'clinic' });
    expect(verifiedClinicHitFor(passed)).toBeUndefined();
    expect(confirmedClinicFor(passed)).toBe('Somewhere');
  });

  it('resolve_location stores the kind the directory gave', async () => {
    const { verifiedClinicHitFor } = await import('../tools/verifiedIdentity');
    const sid = 'CA000000000000000000000000000000e7';
    await verifiedOnTheTechLine(sid, 'Example Surgery Center');
    expect(verifiedClinicHitFor(sid)?.facilityKind).toBe('surgery_center');
  });
});
