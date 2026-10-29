/**
 * A CALLER WHO GAVE THEIR NAME IS NOT NAMELESS — operator ruling 2026-10-29.
 *
 * Wayne: "we should not be filing nameless tickets but we also need to make
 * sure that we did not get the name in transcripts nor did we match the phone
 * number to a patient on lookup."
 *
 * The teardown sweep's "no name, no ticket" rule read only `verifiedIdentity`,
 * a CERTAIN lookup match. Measured 2026-10-20..28, optical + surgery + tech,
 * heard calls (2+ caller lines) with no ticket of any provenance: 152, of which
 * 101 had the caller's identity in hand and the sweep filed none. On these 31
 * a name-taking tool had received the name (a filing refused for the date of
 * birth, the office or the surgeon, or a lookup run more than once) — the
 * corpus, by real CallSid. Names below are synthetic; the real ones stay in
 * call_logs.
 *
 *   optical  CA0d492b2f850e5e70b39ee5595605b6a2  CA161d834d1c7589136e326ca0538bee34
 *            CA1652cb98a31d16d0bc4bae4b22e48038  CA2101b596793403a7ac7ee87ff59e292d
 *            CA4be10285d3458cd32617281f223a7781  CA69e68c6b0e17dad497ccb2ddd20af631
 *            CA917a5bdbc6b9c5e3832bf468a3fa1214  CA937d17d03a7999266da13e53a28fb632
 *   surgery  CA149695a7973610ff4ee07c2dd24e079e  CA1da151b7bedf50422f56b4409efbb54e
 *            CA25f87cf5fdc07b7b63a890f27f8ae4e6  CA42cc91024154cbfa600509682a4d73c0
 *            CA4b6d2c04bfcf5a65ff73e33dc7ce74f4  CA81cfc7d65ef4a19911657d0354adc806
 *            CA90bfdd0f61b4126b2dd0f0d0b092530b  CA9844b9f1e3d00b302978ab70f1acc1d1
 *            CAc68886d170ddb4351cce1581449126ff  CAc9455b635cb729ca7d877375ecf5044c
 *   tech     CA02ff3a0a7b6f80a29aca09f2a8c2182a  CA0b9fbeb1c97d9019ab34195a44212f5c
 *            CA18eeecb88bd96203396bef9957f0d060  CA220914eecf01cc6f972ab715e7d34642
 *            CA2880975d616bb1542f6e91a1a80c1814  CA2e8fe22777cbb37565bf2529e3b3b850
 *            CA35d089c15978763c0a5be441bbc97bbb  CA41b64a968b09ab49a973b6f0ff03bc81
 *            CAa7873252a73bd99fc55bdf484cb75152  CAb0b510e52e952f8b4a0bcbc7673ffcdd
 *            CAc00507947ae9fa23fef3dfbf0a826e55  CAe16b734e97494b0f7468988a18854131
 *            CAe60452992cbf1146b2807ed703ff1215
 *
 * The timeline records no name arguments (PHI), so how many of the 21
 * repeat-lookup calls carried BOTH names is not measurable from SQL; the 10
 * filings refused after the name are the floor. The other 70 identified calls
 * never reached a tool with the name (the caller hung up during the interview)
 * and this change does not reach them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from '../tools/registry';
import '../tools/sharedPatientTools';
import '../tools/surgeryTools';
import '../tools/opticalTools';
import '../tools/techTools';
import { resetGateAttempts } from '../tools/gateAttempts';
import { noteStatedNameFromArgs, statedNameFor, resetStatedNames } from '../tools/statedName';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { runRequestSweep, type SweepFiler } from './sweepRunner';
import type { VoiceCallRecord } from './mediaStreamBridge';

const SURGERY_SID = 'CA42cc91024154cbfa600509682a4d73c0';
const OPTICAL_SID = 'CA0d492b2f850e5e70b39ee5595605b6a2';
const TECH_SID = 'CA41b64a968b09ab49a973b6f0ff03bc81';

function record(callSid: string, slug: string, transcript: string): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript,
    toolEvents: [{ name: `file_${slug}_ticket`, ok: true, succeeded: false, atMs: 100 }],
    agentTurns: 4,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 91_000,
  };
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

const GLASSES_CALL =
  'AGENT: How can I help you today?\n' +
  "CALLER: I'm calling to check if my glasses are ready.\n" +
  'AGENT: May I please have your last name?\n' +
  'CALLER: Benchmark.\n' +
  'AGENT: And your first name?\n' +
  'CALLER: Rosa.\n' +
  'AGENT: And may I please have your date of birth, starting with the month, then the day, then the year?';

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetStatedNames();
  resetVerifiedIdentities();
});

describe('the corpus shape: a filing refused after the name, then the caller leaves', () => {
  it('files at teardown under the name the caller gave, and says it is unverified', async () => {
    // CA42cc910's chain: the filing tool is called with the name and no date
    // of birth, and its own gate refuses — no app call, no ticket.
    const refused = await runTool('file_surgery_ticket', {
      call_sid: SURGERY_SID,
      first_name: 'Rosa',
      last_name: 'Benchmark',
      callback_number: '555-555-0100',
      request_description: 'checking whether her glasses are ready',
    });
    expect((refused as { success: boolean }).success).toBe(false);

    const file = filer();
    const out = await runRequestSweep(record(SURGERY_SID, 'surgery', GLASSES_CALL), file);

    expect(out).toEqual({ filed: true, ticketNumber: 'VA-SWEEP-1' });
    expect(file.calls[0].patientFirstName).toBe('Rosa');
    expect(file.calls[0].patientLastName).toBe('Benchmark');
    expect(String(file.calls[0].staffNote)).toMatch(/NAME AS THE CALLER GAVE IT/);
    expect(String(file.calls[0].staffNote)).not.toMatch(/PATIENT NAME NOT CAPTURED/);
  });

  it('a refusal by validation still keeps the name (it is noted before validating)', async () => {
    // file_optical_ticket requires callback_number; without it the registry
    // refuses before the handler runs. The name was still given.
    await runTool('file_optical_ticket', {
      call_sid: OPTICAL_SID,
      first_name: 'Lena',
      last_name: 'Benchmark',
      request_description: 'pick up glasses',
    });
    expect(statedNameFor(OPTICAL_SID)).toEqual({ firstName: 'Lena', lastName: 'Benchmark' });
  });

  it('a caller who never gave a name is still not filed (the 2026-09-03 rule stands)', async () => {
    const file = filer();
    const out = await runRequestSweep(
      record(TECH_SID, 'tech', 'AGENT: How can I help?\nCALLER: My eye is red, can someone call me?'),
      file,
    );
    expect(out).toMatchObject({ filed: false });
    expect(file.calls).toHaveLength(0);
  });
});

describe('a certain lookup match still wins', () => {
  it('files under the verified name, with no unverified note', async () => {
    rememberVerifiedIdentity(SURGERY_SID, {
      firstName: 'Quinn',
      lastName: 'Benchmark',
      dateOfBirth: '1952-08-08',
      certain: true,
    });
    noteStatedNameFromArgs('file_surgery_ticket', {
      call_sid: SURGERY_SID,
      first_name: 'Someone',
      last_name: 'Else',
    });
    const file = filer();
    await runRequestSweep(record(SURGERY_SID, 'surgery', GLASSES_CALL), file);
    expect(file.calls[0].patientFirstName).toBe('Quinn');
    expect(String(file.calls[0].staffNote)).not.toMatch(/NAME AS THE CALLER GAVE IT/);
  });
});

describe('what counts as a stated name', () => {
  it('needs both names; a later call fills the missing half and a correction replaces', () => {
    noteStatedNameFromArgs('lookup_patient', { call_sid: TECH_SID, last_name: 'Benchmark' });
    expect(statedNameFor(TECH_SID)).toBeUndefined();
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: TECH_SID, first_name: 'Owen' });
    expect(statedNameFor(TECH_SID)).toEqual({ firstName: 'Owen', lastName: 'Benchmark' });
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: TECH_SID, first_name: 'Olive' });
    expect(statedNameFor(TECH_SID)).toEqual({ firstName: 'Olive', lastName: 'Benchmark' });
  });

  it('keeps the first name when a later call carries only the last', () => {
    noteStatedNameFromArgs('lookup_patient', { call_sid: OPTICAL_SID, first_name: 'Lena' });
    noteStatedNameFromArgs('file_optical_ticket', { call_sid: OPTICAL_SID, last_name: 'Benchmark' });
    expect(statedNameFor(OPTICAL_SID)).toEqual({ firstName: 'Lena', lastName: 'Benchmark' });
  });

  it('refuses the placeholders the ticketing app refuses, and anything with a digit', () => {
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: TECH_SID, first_name: 'Unknown', last_name: 'Caller' });
    expect(statedNameFor(TECH_SID)).toBeUndefined();
    resetStatedNames();
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: TECH_SID, first_name: 'Owen', last_name: '03/17/1973' });
    expect(statedNameFor(TECH_SID)).toBeUndefined();
  });

  // The write's own CallSid guard is not observable here: the read refuses a
  // sentinel too, so removing the write guard alone changes no answer (it
  // only lets a sentinel key sit in the map until the TTL). Both ends carry
  // the rule, as verifiedIdentity's do.
  it('judges placeholders on the whole name, as the app does (Codex, PR #399)', () => {
    // A placeholder WORD in a real name is still a name: the app refuses only
    // a name whose every word is a placeholder.
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: TECH_SID, first_name: 'Alice', last_name: 'Guest' });
    expect(statedNameFor(TECH_SID)).toEqual({ firstName: 'Alice', lastName: 'Guest' });
  });

  it('only from a name-taking tool, and only on a real CallSid', () => {
    noteStatedNameFromArgs('check_open_tickets', { call_sid: TECH_SID, first_name: 'Owen', last_name: 'Benchmark' });
    expect(statedNameFor(TECH_SID)).toBeUndefined();
    noteStatedNameFromArgs('file_tech_ticket', { call_sid: 'unknown', first_name: 'Owen', last_name: 'Benchmark' });
    expect(statedNameFor('unknown')).toBeUndefined();
  });
});

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the registry notes the name before it validates anything', () => {
    const registry = src('tools/registry.ts');
    const body = registry.slice(registry.indexOf('export async function runTool'));
    const note = body.indexOf('noteStatedNameFromArgs(name, input)');
    const validate = body.indexOf('validateInput(def, input)');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(validate);
  });

  it('the sweep reads the stated name only when no certain match exists', () => {
    const runner = src('runtime/sweepRunner.ts');
    expect(runner).toMatch(/const stated = identity \? undefined : statedNameFor\(record\.callSid\)/);
    expect(runner).toMatch(/import \{ statedNameFor \} from "\.\.\/tools\/statedName"/);
  });
});
