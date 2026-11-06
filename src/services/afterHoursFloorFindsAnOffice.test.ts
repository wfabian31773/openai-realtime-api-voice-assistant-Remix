/**
 * v183: the after-hours teardown floor finds an office when none was named
 * (caller-ID history, then the dialled office line) and marks every floor
 * ticket for review. Synthetic call ids and numbers only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

const h = vi.hoisted(() => ({
  getCallLogBySid: vi.fn(),
  submitSimplifiedTicket: vi.fn(),
  lookupPatient: vi.fn(),
  confirmedClinicFor: vi.fn(),
  verifiedIdentityFor: vi.fn(),
  officeTheCallerGave: vi.fn(),
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('./syncAgentService', () => ({
  SyncAgentService: { submitSimplifiedTicket: h.submitSimplifiedTicket },
}));
vi.mock('./scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: h.lookupPatient },
}));
vi.mock('../tools/verifiedIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/verifiedIdentity')>()),
  confirmedClinicFor: h.confirmedClinicFor,
  verifiedIdentityFor: h.verifiedIdentityFor,
}));
vi.mock('./afterHoursCallFacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./afterHoursCallFacts')>()),
  officeTheCallerGave: h.officeTheCallerGave,
}));

const floor = await import('./afterHoursTeardownFloor');
const { AZUL_VISION_LOCATIONS } = await import('../config/azulVisionKnowledge');
const { STAND_IN_FULL_NAME } = await import('./standInName');

const office = AZUL_VISION_LOCATIONS[1];
const officeLine = `+1${office.phone.replace(/\D/g, '')}`;
const UNLISTED_LINE = '+12025550199';
const TRANSCRIPT = 'AGENT: How can I help?\nCALLER: Please have someone call me back about a refill.';

let serial = 0;
async function sweep(opts: { dialedNumber?: string } = {}) {
  const n = ++serial;
  const callSid = `CA${String(n).padStart(32, '0')}`;
  const callId = `synthetic-floor-${n}`;
  floor.registerAfterHoursFloor({
    callId, callSid, callerPhone: '+12025550100', dialedNumber: opts.dialedNumber ?? UNLISTED_LINE,
  }, 'no-ivr');
  await floor.sweepAfterHoursUnfiledCall(callId, { transcript: TRANSCRIPT });
  expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  return h.submitSimplifiedTicket.mock.calls[0][0];
}

beforeEach(() => {
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  h.lookupPatient.mockReset().mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [] });
  h.confirmedClinicFor.mockReset().mockReturnValue(undefined);
  h.verifiedIdentityFor.mockReset().mockReturnValue(undefined);
  h.officeTheCallerGave.mockReset().mockResolvedValue(undefined);
});

describe('after-hours floor with no office named', () => {
  it('(a) takes the office from the caller-ID visit history', async () => {
    h.lookupPatient.mockResolvedValue({
      patientFound: true, identity: { unique: true }, lastLocationSeen: 'Redlands',
      upcomingAppointments: [], pastAppointments: [],
    });
    const p = await sweep({ dialedNumber: officeLine });
    expect(h.lookupPatient).toHaveBeenCalledWith(expect.objectContaining({ phone: '+12025550100' }));
    expect(p).toMatchObject({ locationOfLastVisit: 'Redlands', locationSource: 'history' });
    expect(p.additionalDetails).toContain(floor.FLOOR_NEEDS_REVIEW_NOTE);
    expect(p.additionalDetails).toContain(floor.FLOOR_HISTORY_LOCATION_NOTE);
    expect(p.additionalDetails).not.toContain(floor.FLOOR_DIALED_LOCATION_NOTE);
    expect(p.additionalDetails).not.toContain(floor.FLOOR_MISSING_LOCATION_NOTE);
  });

  it('a number shared by several people gives no history office', async () => {
    h.lookupPatient.mockResolvedValue({
      patientFound: true, identity: { unique: false }, lastLocationSeen: 'Redlands',
      upcomingAppointments: [], pastAppointments: [],
    });
    const p = await sweep();
    expect(p.locationOfLastVisit).toBeUndefined();
    expect(p.additionalDetails).toContain(floor.FLOOR_MISSING_LOCATION_NOTE);
  });

  it('(b) falls back to the office whose line was dialled', async () => {
    const p = await sweep({ dialedNumber: officeLine });
    expect(p).toMatchObject({ locationOfLastVisit: office.name, locationSource: 'history' });
    expect(p.additionalDetails).toContain(floor.FLOOR_DIALED_LOCATION_NOTE);
    expect(p.additionalDetails).toContain(floor.FLOOR_NEEDS_REVIEW_NOTE);
  });

  it('a failed or slow history lookup is swallowed and the dialled line still routes', async () => {
    h.lookupPatient.mockRejectedValue(new Error('synthetic outage'));
    const p = await sweep({ dialedNumber: officeLine });
    expect(p).toMatchObject({ locationOfLastVisit: office.name, locationSource: 'history' });

    vi.useFakeTimers();
    try {
      h.submitSimplifiedTicket.mockClear();
      h.lookupPatient.mockReturnValue(new Promise(() => {}));
      const pending = floor.officeFromCallerHistory('+12025550100', 'CA-synthetic');
      await vi.advanceTimersByTimeAsync(floor.FLOOR_HISTORY_LOOKUP_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) finds nothing: no location, needs review and a missing-location advisory', async () => {
    const p = await sweep();
    expect(p.locationOfLastVisit).toBeUndefined();
    expect(p.locationSource).toBeUndefined();
    expect(p.additionalDetails).toContain(floor.FLOOR_NEEDS_REVIEW_NOTE);
    expect(p.additionalDetails).toContain(floor.FLOOR_MISSING_LOCATION_NOTE);
  });

  it('(d) an unverified identity files a stand-in name with a missing-identity advisory', async () => {
    const p = await sweep();
    expect(p.patientFullName).toBe(STAND_IN_FULL_NAME);
    expect(p.additionalDetails).toContain(floor.FLOOR_MISSING_IDENTITY_NOTE);
  });

  it('a verified identity carries no missing-identity advisory', async () => {
    h.verifiedIdentityFor.mockReturnValue({ firstName: 'Synthetic', lastName: 'Example', dateOfBirth: '1980-01-02' });
    const p = await sweep();
    expect(p.patientFullName).toBe('Synthetic Example');
    expect(p.additionalDetails).not.toContain(floor.FLOOR_MISSING_IDENTITY_NOTE);
  });
});

describe('after-hours floor with an office named', () => {
  it('(e) keeps the named office as caller-sourced, skips both fallbacks, and still needs review', async () => {
    h.officeTheCallerGave.mockResolvedValue('Covina');
    const p = await sweep({ dialedNumber: officeLine });
    expect(p).toMatchObject({ locationOfLastVisit: 'Covina', locationSource: 'caller', departmentId: 8 });
    expect(h.lookupPatient).not.toHaveBeenCalled();
    expect(p.additionalDetails).toContain(floor.FLOOR_NEEDS_REVIEW_NOTE);
    expect(p.additionalDetails).not.toContain(floor.FLOOR_MISSING_LOCATION_NOTE);
    expect(p.additionalDetails).not.toContain(floor.FLOOR_DIALED_LOCATION_NOTE);
  });
});

describe('officeForDialedNumber', () => {
  it('matches an office line by its last ten digits and nothing else', () => {
    expect(floor.officeForDialedNumber(officeLine)).toBe(office.name);
    expect(floor.officeForDialedNumber(UNLISTED_LINE)).toBeUndefined();
    expect(floor.officeForDialedNumber('anonymous')).toBeUndefined();
    expect(floor.officeForDialedNumber(undefined)).toBeUndefined();
  });
});
