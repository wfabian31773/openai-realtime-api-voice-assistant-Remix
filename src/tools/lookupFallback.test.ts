/**
 * The number the call arrived on is the one field nobody mishears.
 *
 * Live on 2026-08-13: the agent recognised the caller by phone before he spoke,
 * then the transcriber heard "Thanks." and "No. March 17th, 1973." for a date
 * of birth. The model looked up that trio, and the tool answered "no record
 * found" for a patient it had matched seconds earlier. The ticket filed with no
 * provider and no location attached.
 *
 * Two causes, both fixed here:
 *   - `caller_phone` is injected as call context on every tool, but this tool's
 *     schema field is `phone`, so the caller's own number never reached it
 *     unless the model chose to type it out.
 *   - a name+DOB miss ended the lookup, when it is usually one mis-transcribed
 *     field rather than a stranger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';

// Mocked, not spied: importing the real service pulls in the database, and a
// test that only runs where the database is configured is not a test.
const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const FOUND = {
  patientFound: true,
  patientName: 'Wayne Fabian',
  matchedBy: 'phone',
  pastAppointments: [{ location: 'Eastvale', provider: 'Dwayne Logan, MD' }],
  lastLocationSeen: 'Eastvale',
  lastProviderSeen: 'Dwayne Logan, MD',
  lastVisitDate: '2026-07-09',
  totalAppointmentsFound: 34,
  identity: { unique: true, candidateCount: 1, candidates: [] },
};

const MISS = { patientFound: false, pastAppointments: [], totalAppointmentsFound: 0 };

beforeEach(() => {
  lookupSpy.mockReset();
});

describe('the caller phone reaches the lookup without the model passing it', () => {
  it('uses injected caller_phone when the model supplies no phone', async () => {
    const spy = lookupSpy.mockResolvedValue(FOUND as never);

    // `caller_phone` is call context, exactly as realtimeToolsFor injects it.
    const out = (await runTool('lookup_patient', {
      caller_phone: '+18455317471',
      queue: 'surgery',
    })) as Record<string, unknown>;

    expect(out.found).toBe(true);
    expect(spy.mock.calls[0][0].phone).toBe('+18455317471');
  });

  it('prefers a phone the model actually supplied', async () => {
    const spy = lookupSpy.mockResolvedValue(FOUND as never);

    await runTool('lookup_patient', {
      phone: '555-000-1111',
      caller_phone: '+18455317471',
    });

    expect(spy.mock.calls[0][0].phone).toBe('555-000-1111');
  });
});

describe('a mis-transcribed date of birth does not lose a known patient', () => {
  it('falls back to the caller phone when name and DOB miss', async () => {
    const spy = lookupSpy
      .mockResolvedValueOnce(MISS as never) // the mangled trio
      .mockResolvedValueOnce(FOUND as never); // the number they called from

    const out = (await runTool('lookup_patient', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: 'No. March 17th, 1973.',
      caller_phone: '+18455317471',
    })) as Record<string, unknown>;

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toEqual({ phone: '+18455317471' });
    expect(out.found, 'a known patient was reported as unknown').toBe(true);
    expect(out.patient_name).toBe('Wayne Fabian');
  });

  it('does not retry when there was no name or DOB to miss on', async () => {
    // A bare phone lookup that misses is a real miss, not a transcription
    // problem. Retrying it would be the same query twice.
    const spy = lookupSpy.mockResolvedValue(MISS as never);

    const out = (await runTool('lookup_patient', {
      caller_phone: '+18455317471',
    })) as Record<string, unknown>;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.found).toBe(false);
  });

  it('still reports not-found when the number is unknown too', async () => {
    lookupSpy.mockResolvedValue(MISS as never);

    const out = (await runTool('lookup_patient', {
      first_name: 'Nobody',
      last_name: 'Atall',
      date_of_birth: '01/01/1900',
      caller_phone: '+15550000000',
    })) as Record<string, unknown>;

    expect(out.found).toBe(false);
    expect(String(out.message)).toMatch(/No record found/i);
  });
});
