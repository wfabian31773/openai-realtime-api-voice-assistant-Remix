/**
 * AN OFFICE `resolve_location` VERIFIED ON THE CALL REACHES THE FILING TOOL
 * (v148, `verifiedOffice.ts`).
 *
 * Found on the operator's pack-01 A1 test call, 2026-10-29
 * (`CAe121c3c176d626e8a679536788e58d63`, optical): the caller named Covina,
 * `resolve_location` answered `verified: true`, and two tool calls later
 * `file_optical_ticket` refused for `location` and the agent asked "Which of
 * our offices do you usually visit?" again. The model had left the office out
 * of its filing call, and the filing tool reads only its own argument and the
 * patient's record.
 *
 * THE CORPUS, `tool_timeline`, optical on the runtime, 2026-10-20..28: every
 * call where a `file_optical_ticket` refused for `location` AFTER a
 * `resolve_location` on the same call had answered `verified: true`. 27 calls,
 * 37 such refusals. All 27 filed in the end (the gate asks once, then files),
 * so no request was lost; what each one cost was a caller asked a question
 * they had just answered. Under v148 none of those 37 refusals is reachable:
 * the verified office fills the field the model left out.
 *
 * Synthetic patient throughout. The SIDs are the real calls; no transcript,
 * name, date of birth or number from them is in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from './registry';
import './sharedPatientTools';
import './opticalTools';
import { resetGateAttempts } from './gateAttempts';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';
import {
  rememberVerifiedOffice,
  resetVerifiedOffices,
  verifiedOfficeFor,
} from './verifiedOffice';

const A1 = 'CAe121c3c176d626e8a679536788e58d63';

/** Optical, 2026-10-20..28: a `location` refusal after a verified office. */
const CORPUS = [
  'CA07871b49ebc01307b8f7e71d4eff99d9', 'CA0a429ff3419b7f8bee2dcf41aaacd72b',
  'CA1316dac1ce71593df8813c68348c4bf4', 'CA269002480ef78e04d6d9b3096b32e6b5',
  'CA2a63a83cfea7bb40a3ba0700bdb8bec1', 'CA3615eaae3829889efc51991d2a2281ea',
  'CA3b555d79d8c0a0b157797f858b52510d', 'CA3be34b25a1a8448cb90eccf63df7be94',
  'CA4a84412a60fc3758d1f14593f8dc09f8', 'CA4c3e15d608d757c258a3a7b292e35bfa',
  'CA63deda61d1d98b58c256ec6f4682b0a9', 'CA753aecd089c59cb994259cd24ded580c',
  'CA75e9b74959eecd8a8be3811d2e4d114e', 'CA79f7b235f221441277107b1908111d9a',
  'CA89b570753f15735fa4eb31d57839be7b', 'CAa24024dee064317f46896feef806fd96',
  'CAae29fb315a7060debb309f42276538bf', 'CAb11c61f173ca3f159e5ab40fa770e799',
  'CAb15729341a4d1b6c1327375a295969d3', 'CAb532dbe682257916a79ef3e3ec760b32',
  'CAbe32c31d2c23b2188d2370125f73383e', 'CAbfc765f1f309a2113eb8b5c4d87b5da3',
  'CAc2bd7f791f7ed0d2c998e32be7015618', 'CAcdd87f969009b07143d0dd2f1c85c2eb',
  'CAced2b5f13ecdb41d60e2b9432fe33524', 'CAdcd918a4eeb97fa6caeec4e47dfee0d6',
  'CAe96c51473288bdc03c2faa66fe312b0f',
] as const;

const CONFIRMED = 'Covina';
const CONFIRMED_ID = 4401;
const OTHER = 'Glendora';
const OTHER_ID = 4402;

/** A complete optical filing in which the model sent no office. */
const filing = (callSid: string, extra: Record<string, unknown> = {}) => ({
  first_name: 'Testcaller',
  last_name: 'Optical',
  date_of_birth: '01/01/1950',
  callback_number: '555-555-0147',
  request_description: 'Order new glasses',
  call_sid: callSid,
  ...extra,
});

async function directory() {
  return await import('../services/consoleDirectory');
}
async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

/** The caller names an office and `resolve_location` verifies it. */
async function verify(callSid: string, office: string) {
  const dir = await directory();
  vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
  vi.spyOn(dir, 'lookupLocation').mockResolvedValue({
    canonical: `Azul Vision ${office}`, fileAs: office, facilityKind: 'clinic',
  } as never);
  return (await runTool('resolve_location', {
    spoken_location: office, queue: 'optical', call_sid: callSid,
  })) as Record<string, unknown>;
}

/** The ticketing directory resolves both offices; createTicket is captured. */
async function ticketing() {
  const api = await client();
  vi.spyOn(api, 'lookupProviderAndLocation').mockImplementation(
    async (args: { locationName?: string }) => {
      const id = args?.locationName === CONFIRMED ? CONFIRMED_ID
        : args?.locationName === OTHER ? OTHER_ID : undefined;
      return { success: true, outcome: id ? 'matched' : 'no_match', locationId: id } as never;
    },
  );
  return vi.spyOn(api, 'createTicket')
    .mockResolvedValue({ success: true, ticketNumber: 'VA-99145' } as never);
}

const payloadOf = (create: Awaited<ReturnType<typeof ticketing>>) =>
  create.mock.calls[0][0] as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  resetVerifiedOffices();
});

describe('the corpus: a verified office is not asked for again', () => {
  it.each([A1, ...CORPUS])('%s files under the verified office on the FIRST filing call', async (sid) => {
    const create = await ticketing();
    const resolved = await verify(sid, CONFIRMED);
    expect(resolved.verified).toBe(true);

    // ONE filing call, with no office in it. Before v148 this was the
    // `location` refusal and the caller was asked again.
    const r = (await runTool('file_optical_ticket', filing(sid))) as Record<string, unknown>;

    expect(r.missingFields ?? []).not.toContain('location');
    expect(create).toHaveBeenCalledTimes(1);
    expect(payloadOf(create)).toMatchObject({
      locationId: CONFIRMED_ID,
      locationOfLastVisit: CONFIRMED,
    });
    // Routed, so the unassigned exit is not claimed.
    expect(payloadOf(create).routingAskExhausted).toBeUndefined();
  });
});

describe('the narrowness', () => {
  it('an office the model DOES send wins over the verified one', async () => {
    const create = await ticketing();
    await verify(A1, CONFIRMED);

    await runTool('file_optical_ticket', filing(A1, { location: OTHER }));

    expect(payloadOf(create)).toMatchObject({ locationId: OTHER_ID, locationOfLastVisit: OTHER });
  });

  it('the verified office outranks the record, as an office the caller names always has', async () => {
    const create = await ticketing();
    rememberVerifiedIdentity(A1, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', usualOffice: OTHER, certain: true,
    });
    await verify(A1, CONFIRMED);

    await runTool('file_optical_ticket', filing(A1));

    expect(payloadOf(create)).toMatchObject({ locationId: CONFIRMED_ID, locationOfLastVisit: CONFIRMED });
  });

  it('the latest verified office is the one carried', async () => {
    const create = await ticketing();
    await verify(A1, OTHER);
    await verify(A1, CONFIRMED);

    await runTool('file_optical_ticket', filing(A1));

    expect(payloadOf(create)).toMatchObject({ locationId: CONFIRMED_ID });
  });

  it('an office verified on ANOTHER call is not carried — the gate still asks', async () => {
    const create = await ticketing();
    await verify(CORPUS[0], CONFIRMED);

    const r = (await runTool('file_optical_ticket', filing(A1))) as Record<string, unknown>;

    expect(r.missingFields).toContain('location');
    expect(create).not.toHaveBeenCalled();
  });

  it('a sentinel CallSid carries nothing', async () => {
    await verify('unknown', CONFIRMED);
    expect(verifiedOfficeFor('unknown')).toBeUndefined();
    rememberVerifiedOffice('unknown', CONFIRMED);
    expect(verifiedOfficeFor('unknown')).toBeUndefined();
  });

  it('an office the caller named that the directory could NOT verify is not carried', async () => {
    // The bounded ask (RESOLVE_ASK_LIMIT) hands the caller's words back
    // unverified on the third try. Those words are not a confirmed office.
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue(null as never);
    const args = { spoken_location: 'Somewhere Else', queue: 'optical', call_sid: A1 };
    await runTool('resolve_location', args);
    await runTool('resolve_location', args);
    const third = (await runTool('resolve_location', args)) as Record<string, unknown>;

    expect(third.verified).toBe(false);
    expect(verifiedOfficeFor(A1)).toBeUndefined();
  });

  it('an office of the wrong kind for the queue is not carried', async () => {
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue({
      canonical: 'Azul Vision Loma Linda Surgery Center',
      fileAs: 'Loma Linda Surgery Center LLC',
      facilityKind: 'surgery_center',
    } as never);
    await runTool('resolve_location', {
      spoken_location: 'Loma Linda Surgery Center', queue: 'optical', call_sid: A1,
    });

    expect(verifiedOfficeFor(A1)).toBeUndefined();
  });
});
