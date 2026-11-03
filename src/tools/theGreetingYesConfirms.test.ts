/**
 * THE CALLER'S YES TO THE GREETING CONFIRMS A PHONE MATCH THAT IS ONE PERSON — v170.
 *
 * Operator, 2026-11-03: a yes to "Am I speaking with <name>?" confirms the
 * caller when only one person on file has that number. #384 had made
 * `lookup_patient` certain only on a unique name-and-date-of-birth match, so
 * the named greeting alone (theNamedGreetingIsAHardRule.test.ts) would have
 * left every recognised caller a candidate and the filing tools refusing the
 * chart date of birth — the 2026-10-30 shape (Codex P2 on #423).
 *
 * Driven through `runTool`, the entry point the model calls, then through
 * `prepareTicketIdentity`, which every live filing tool reads. Names, numbers
 * and dates are synthetic; the SIDs are the real 2026-10-30 calls whose
 * recognised caller was refused for a date of birth the record held.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
const { verifiedIdentityFor, verifiedDobFor, resetVerifiedIdentities } = await import('./verifiedIdentity');
const { resetGateAttempts } = await import('./gateAttempts');
const { prepareTicketIdentity } = await import('./ticketIdentity');
const { callerAffirmedThePhoneMatch } = await import('./greetingAffirmation');
const { recognisedCallerBlock } = await import('../runtime/recognisedCallerBlock');

const PHONE = '555-555-0170';
const ALEX = { firstName: 'Alex', lastName: 'Rivera', dateOfBirth: '1962-04-09' };

/** What the person base answers for a number that is one person (#384: identityUnconfirmed on every phone hit). */
const onePersonOnTheNumber = (who = ALEX) => ({
  patientFound: true,
  patientName: `${who.firstName} ${who.lastName}`,
  matchedBy: 'phone' as const,
  identityUnconfirmed: true,
  identity: { unique: true, candidateCount: 1, candidates: [{ ...who, appointmentCount: 3 }] },
  patientData: { ...who, personId: 'p-synthetic' },
  upcomingAppointments: [],
  pastAppointments: [],
  totalAppointmentsFound: 3,
});

type Out = Record<string, unknown>;
const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Out>;

beforeEach(() => {
  lookupSpy.mockReset();
  lookupSpy.mockImplementation(async () => onePersonOnTheNumber());
  resetGateAttempts();
  resetVerifiedIdentities();
});

const CORPUS_20261030 = [
  ['CA69a3b6d8274ede8cee7cb1a818e7ef06', 'optical'],
  ['CAadf2e34d5723ae1e50fa3183a9a192c5', 'optical'],
  ['CA06f261bcdd3b95fda0710954c3989889', 'surgery'],
  ['CA46bb10afc41dcc81ba05c1cfe4c50b14', 'surgery'],
  ['CA216c743df359cdf8d00a90bff0aa3e07', 'surgery'],
  ['CAdead5c981d5a7038d3d951c6846675bf', 'surgery'],
  ['CAe5324707f3d06bcf60e6116335de5bac', 'surgery'],
  ['CAaf72d99aa4ca3145cbab4a941872d20f', 'surgery'],
  ['CA492ab9e883d80fefb45749419c0f8728', 'tech'],
  ['CA0226907f3f824dc60d5420223759acc2', 'tech'],
  ['CAf2d83f16cb84e1c2c6acafda10b89da1', 'tech'],
  ['CA0a9a4941ca32abe630e89abf44932699', 'tech'],
  ['CA8917a5807762e95cfd02835caa6ef23e', 'tech'],
  ['CA3262a8fddc4641f837eba5685d7e6247', 'tech'],
  ['CAbf3db22d5eb977172fda4f4c82a02ae4', 'tech'],
  ['CAcbb298032d596f39d38b855f7a274e94', 'tech'],
  ['CAa9121ab28ac023f1cb8b7dfd48beda96', 'tech'],
  ['CAfbb68e46b4c89e179030f201127e51c3', 'tech'],
  ['CA183e9e7fc9501090d57f28d35a8f3336', 'tech'],
  ['CA990dfa0a0fcee7086a2f492232203e22', 'tech'],
  ['CA8f964c4be5ece3447387fa4b5e895972', 'tech'],
  ['CA538d6903d9ccee6f36361e58b7ec578c', 'tech'],
  ['CA3f643b5193d5b0f4796103402d4c23e0', 'tech'],
  ['CAc48d9b2c80adde146312070ca1d5f680', 'tech'],
  ['CA66738dfbeba847b3de62e18fcfe62aeb', 'tech'],
  ['CA7571eb971727523d747cedc556e9fae0', 'tech'],
  ['CA48a8641a6ffcdf6590a0ffc1bbd88b27', 'tech'],
  ['CA1c78861f98e25c6403641da3208ed4f7', 'tech'],
  ['CA1ecb4216b73ca6200159b130232094eb', 'tech'],
  ['CA04c23871f54f7024393b7126c298473a', 'tech'],
] as const;

describe('the 2026-10-30 corpus: a recognised caller who says yes is not asked for a date of birth the record holds', () => {
  for (const [sid, lane] of CORPUS_20261030) {
    it(`${sid} (${lane}): the YES lookup is certain and the filing inherits the chart date`, async () => {
      const queue = lane === 'surgery' ? 'surgery' : lane === 'optical' ? 'optical' : undefined;
      const out = await lookup({ ...(queue ? { queue } : {}), call_sid: sid, caller_phone: PHONE, first_name: 'Alex' });
      expect(out.identity_is_certain).toBe(true);
      expect(out.matched_by).toBe('phone');
      expect(out.patient_name).toBe('Alex Rivera');
      expect(verifiedDobFor(sid, 'Alex', 'Rivera')).toBe('1962-04-09');
      // The filing tools' own identity step fills what the record holds.
      const filed = prepareTicketIdentity({ call_sid: sid, first_name: 'Alex', last_name: 'Rivera' });
      expect(filed.input.date_of_birth).toBe('1962-04-09');
    });
  }
});

describe('what the yes does NOT confirm', () => {
  const SID = 'CA0000000000000000000000000000a170';

  it('a phone match before anybody has answered (no first name) stays a candidate', async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE });
    expect(out.identity_is_certain).toBe(false);
    expect(out.patient_name).toBeUndefined();
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it("a different first name (\"no, this is his wife Jordan\") stays a candidate", async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Jordan' });
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a first name that only shares a prefix with the record stays a candidate', async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alexis' });
    expect(out.identity_is_certain).toBe(false);
  });

  it('a stated surname that is not the record\'s stays a candidate', async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alex', last_name: 'Morales' });
    expect(out.identity_is_certain).toBe(false);
  });

  it('a stated date of birth that is not the record\'s stays a candidate', async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alex', date_of_birth: '07/01/1990' });
    expect(out.identity_is_certain).toBe(false);
  });

  it('a stated surname and date of birth that agree with the record confirm it', async () => {
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alex', last_name: 'Rivera', date_of_birth: '04/09/1962' });
    expect(out.identity_is_certain).toBe(true);
  });

  it('several people on the number are never confirmed by a first name both could answer to', async () => {
    lookupSpy.mockImplementation(async () => ({
      ...onePersonOnTheNumber(),
      identity: {
        unique: false,
        candidateCount: 2,
        candidates: [{ ...ALEX, appointmentCount: 3 }, { ...ALEX, dateOfBirth: '1990-01-01', appointmentCount: 1 }],
      },
    }));
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alex' });
    expect(out.identity_is_certain).toBe(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a name-only match is still a candidate (#384 kept)', async () => {
    lookupSpy.mockImplementation(async () => ({ ...onePersonOnTheNumber(), matchedBy: 'name' as const }));
    const out = await lookup({ call_sid: SID, caller_phone: PHONE, first_name: 'Alex' });
    expect(out.identity_is_certain).toBe(false);
  });
});

describe('the rule itself', () => {
  const resolved = onePersonOnTheNumber();

  it('accepts the record\'s first name, ignoring case and accents, and a compound name by its first word', () => {
    expect(callerAffirmedThePhoneMatch(resolved, { firstName: 'alex' })).toBe(true);
    expect(callerAffirmedThePhoneMatch(onePersonOnTheNumber({ ...ALEX, firstName: 'José' }), { firstName: 'Jose' })).toBe(true);
    expect(callerAffirmedThePhoneMatch(onePersonOnTheNumber({ ...ALEX, firstName: 'Mary Ann' }), { firstName: 'Mary' })).toBe(true);
  });

  it('refuses a blank name, an unreadable date and a non-phone match', () => {
    expect(callerAffirmedThePhoneMatch(resolved, { firstName: '  ' })).toBe(false);
    expect(callerAffirmedThePhoneMatch(resolved, { firstName: 'Alex', dateOfBirth: 'sometime in April' })).toBe(false);
    expect(callerAffirmedThePhoneMatch({ ...resolved, matchedBy: 'name_and_dob' }, { firstName: 'Alex' })).toBe(false);
    expect(
      callerAffirmedThePhoneMatch({ ...resolved, identity: { unique: false, candidateCount: 2, candidates: [] } }, { firstName: 'Alex' }),
    ).toBe(false);
  });

  it('the recognised-caller block tells the model to pass the affirmed first name to lookup_patient', () => {
    const block = recognisedCallerBlock({ matched: true, firstName: 'Alex' });
    expect(block.slice(block.indexOf('If they said YES'))).toMatch(/Call lookup_patient\s+with first_name "Alex"/);
  });
});
