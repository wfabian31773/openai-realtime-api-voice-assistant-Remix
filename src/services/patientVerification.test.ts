/**
 * Verification against the person mirror.
 *
 * The matching rules are tested against a real Postgres wire protocol would
 * be ideal, but the value here is in the DECISIONS: what counts as a match,
 * what must never count as one, and what happens when the mirror is down
 * while a caller is on the line. Those are pure logic over rows, so the query
 * layer is stubbed and every rule is asserted directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('pg', () => ({
  default: { Pool: class { query = (...a: unknown[]) => query(...a); on() {} end() { return Promise.resolve(); } } },
}));

import {
  verifyPatient,
  normalizeDob,
  phoneDigits,
  describeForLog,
  __resetPoolForTests,
} from './patientVerification';

const ROW = {
  person_id: '11111111-1111-1111-1111-111111111111',
  person_nbr: 'P-1',
  first_name: 'Wayne',
  last_name: 'Fabian',
  date_of_birth: '1973-03-17',
  has_medical_record: true,
  language: 'Spanish',
  phones: ['(845) 531-7471', null, null, null, null],
};

beforeEach(() => {
  query.mockReset();
  __resetPoolForTests();
  process.env.OBS_CONSOLE_DATABASE_URL = 'postgres://fake/console';
});

afterEach(() => {
  delete process.env.OBS_CONSOLE_DATABASE_URL;
});

describe('reading a spoken date of birth', () => {
  it('accepts the shapes callers actually say', () => {
    for (const said of ['1973-03-17', '03/17/1973', '3/17/1973', '3-17-73', 'March 17 1973', 'Mar 17, 1973']) {
      expect(normalizeDob(said)).toBe('1973-03-17');
    }
  });

  it('refuses a date that is not real rather than searching on nonsense', () => {
    // A malformed date matches nobody, which reads to the caller as "we can't
    // find you" — a very different thing from "say that again".
    for (const bad of ['', '02/30/1973', '13/01/1973', 'next Tuesday', '1973', '17/03/1973']) {
      expect(normalizeDob(bad)).toBe('');
    }
  });

  it('windows a two-digit year the way a patient population runs', () => {
    expect(normalizeDob('3/17/73')).toBe('1973-03-17');
    expect(normalizeDob('3/17/05')).toBe('2005-03-17');
  });
});

describe('phone comparison', () => {
  it('ignores formatting and the US country code', () => {
    expect(phoneDigits('+1 (845) 531-7471')).toBe('8455317471');
    expect(phoneDigits('845.531.7471')).toBe('8455317471');
  });
});

describe('verifying against the mirror', () => {
  it('verifies one exact person and carries the association', async () => {
    query.mockResolvedValue({ rows: [ROW] });
    const r = await verifyPatient({ firstName: 'Wayne', lastName: 'Fabian', dob: '03/17/1973' });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('match');
    // person_id is what puts the ticket on the right chart.
    expect(r.patient?.personId).toBe(ROW.person_id);
    expect(r.patient?.personNbr).toBe('P-1');
    expect(r.patient?.hasMedicalRecord).toBe(true);
  });

  it('searches the person base by surname and DOB — never the appointment book', async () => {
    query.mockResolvedValue({ rows: [ROW] });
    await verifyPatient({ firstName: 'Wayne', lastName: 'Fabian', dob: '1973-03-17' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('patients_master');
    // The old path queried `schedule`, so a real patient with no upcoming
    // appointment could never verify. That is the bug this file replaces.
    expect(String(sql)).not.toMatch(/\bschedule\b/);
    expect(params).toEqual(['Fabian', '1973-03-17']);
  });

  it('REFUSES to choose between two people who share a surname and birthday', async () => {
    // Guessing here attaches a patient's request to a stranger's chart.
    const twin = { ...ROW, person_id: '22222222-2222-2222-2222-222222222222', first_name: 'Wanda' };
    query.mockResolvedValue({ rows: [ROW, twin] });
    const r = await verifyPatient({ lastName: 'Fabian', dob: '1973-03-17' });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates).toBe(2);
    expect(r.patient).toBeUndefined();
  });

  it('breaks a tie on the number the caller is actually calling from', async () => {
    const twin = {
      ...ROW,
      person_id: '22222222-2222-2222-2222-222222222222',
      first_name: 'Wayne',
      phones: ['(626) 548-2660', null, null, null, null],
    };
    query.mockResolvedValue({ rows: [ROW, twin] });
    const r = await verifyPatient({
      firstName: 'Wayne',
      lastName: 'Fabian',
      dob: '1973-03-17',
      callerPhone: '+18455317471',
    });
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe(ROW.person_id);
  });

  it('matches a nickname by stem but still refuses a genuine tie', async () => {
    const robert = { ...ROW, first_name: 'Robert', person_id: 'a', last_name: 'Smith' };
    const maria = { ...ROW, first_name: 'Maria', person_id: 'b', last_name: 'Smith' };
    query.mockResolvedValue({ rows: [robert, maria] });
    const r = await verifyPatient({ firstName: 'Rob', lastName: 'Smith', dob: '1973-03-17' });
    expect(r.verified).toBe(true);
    expect(r.patient?.personId).toBe('a');
  });

  it('says no_match when the person base genuinely has nobody', async () => {
    query.mockResolvedValue({ rows: [] });
    const r = await verifyPatient({ firstName: 'Nobody', lastName: 'Here', dob: '1973-03-17' });
    expect(r).toMatchObject({ verified: false, reason: 'no_match', candidates: 0 });
  });

  it('degrades to unverified — never to a hung call — when the mirror is down', async () => {
    query.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await verifyPatient({ firstName: 'Wayne', lastName: 'Fabian', dob: '1973-03-17' });
    expect(r).toMatchObject({ verified: false, reason: 'unavailable' });
  });

  it('gives up on a slow mirror rather than leaving the caller in silence', async () => {
    process.env.PATIENT_VERIFY_TIMEOUT_MS = '60';
    query.mockImplementation(() => new Promise(() => {})); // never settles
    const started = Date.now();
    const r = await verifyPatient({ firstName: 'Wayne', lastName: 'Fabian', dob: '1973-03-17' });
    expect(r.reason).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(2000);
    delete process.env.PATIENT_VERIFY_TIMEOUT_MS;
  });

  it('does not search at all without a surname and a usable date', async () => {
    for (const bad of [{ lastName: 'Fabian' }, { dob: '1973-03-17' }, { lastName: 'Fabian', dob: 'sometime' }]) {
      const r = await verifyPatient(bad);
      expect(r.reason).toBe('bad_input');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('reports the mirror being unconfigured as unavailable, not as a missing patient', async () => {
    // "We can't reach the system" and "you are not our patient" must never be
    // the same answer to a caller.
    delete process.env.OBS_CONSOLE_DATABASE_URL;
    const r = await verifyPatient({ firstName: 'Wayne', lastName: 'Fabian', dob: '1973-03-17' });
    expect(r.reason).toBe('unavailable');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('what reaches the log', () => {
  it('never writes a name or a date of birth', () => {
    const line = describeForLog('CAtest', {
      verified: true,
      reason: 'match',
      candidates: 1,
      patient: {
        personId: 'x', personNbr: 'P-1', firstName: 'Wayne', lastName: 'Fabian',
        dob: '1973-03-17', hasMedicalRecord: true, language: 'Spanish',
      },
    });
    expect(line).toContain('VERIFIED');
    expect(line).not.toMatch(/Wayne|Fabian|1973/);
  });
});
