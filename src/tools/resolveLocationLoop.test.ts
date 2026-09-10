/**
 * THE SUCCESS ENVELOPE THAT KEPT THE MODEL RETRYING — optical and surgery.
 *
 * `resolve_location` looped 30-35 times, ALL SUCCEEDING, on ten runtime calls
 * between 2026-09-03 and 2026-09-10, every one of which reached the tool
 * ceiling at 40 dispatches and filed NO ticket. Measured on the grok runtime
 * over that window: 144 `spoken_location` refusals across 66 calls, and on the
 * eleven optical calls carrying two or more `location` refusals the tool
 * averaged 19-25 successes and filed nothing at all (0 of 11), against 53 of 61
 * on the calls that took the gate's escape after one refusal.
 *
 * This file's own history says why. The `!hit` branch used to return
 * `success: true` with an advisory message and it was "the worst loop we had" —
 * the envelope said the call had WORKED, so the model had no reason to change
 * anything and every reason to try again. That was fixed. The branch below it,
 * where an office IS found but is the wrong KIND of facility for the queue,
 * still returns `success: true` with an advisory message.
 *
 * Same envelope, same trap, one branch further down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from './registry';
import './sharedPatientTools';
import { resetGateAttempts } from './gateAttempts';

const SID = 'CAebcb3ffe096d0bf024139cc416797a89';

async function directory() {
  return await import('../services/consoleDirectory');
}

/** A real surgery centre, named by a caller on the OPTICAL line. */
const SURGERY_CENTRE = {
  canonical: 'Azul Vision Loma Linda Surgery Center',
  fileAs: 'Loma Linda Surgery Center LLC',
  facilityKind: 'surgery_center' as const,
};

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
});

describe('an office of the wrong KIND refuses, it does not succeed', () => {
  it('optical: a surgery centre comes back as a refusal, not success', async () => {
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue(SURGERY_CENTRE as never);

    const r = (await runTool('resolve_location', {
      spoken_location: 'Loma Linda Surgery Center',
      queue: 'optical',
      call_sid: SID,
    })) as Record<string, unknown>;

    // THE ENVELOPE IS THE FIX. `success: true` is what made the model retry.
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['spoken_location']);
    // And it still hands the agent something to SAY to the caller.
    expect(String(r.message)).toMatch(/optical office/i);
  });

  it('surgery: the same surgery centre is USABLE and still succeeds', async () => {
    // The narrowness that matters. Surgery coordinates AT surgery centres, so
    // this must not become a refusal for that queue — that would break the
    // lane the fix is also meant to protect.
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue(SURGERY_CENTRE as never);

    const r = (await runTool('resolve_location', {
      spoken_location: 'Loma Linda Surgery Center',
      queue: 'surgery',
      call_sid: SID,
    })) as Record<string, unknown>;

    expect(r.success).toBe(true);
    expect(r.location).toBe('Loma Linda Surgery Center LLC');
  });

  it('a clinic on the optical line is unaffected', async () => {
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue({
      canonical: 'Azul Vision Eastvale', fileAs: 'Eastvale', facilityKind: 'clinic',
    } as never);

    const r = (await runTool('resolve_location', {
      spoken_location: 'Eastvale', queue: 'optical', call_sid: SID,
    })) as Record<string, unknown>;

    expect(r.success).toBe(true);
    expect(r.location).toBe('Eastvale');
  });
});

describe('the ask is bounded, so a refusal cannot become a well', () => {
  it('stops refusing after the caller has been asked twice on one call', async () => {
    // The refusal is right the first time and the second. By the third it has
    // stopped being a question and become a loop: the ten ceiling calls show
    // the model answering a refusal by re-running the same tool, not by
    // speaking to the caller. Hand the words back so the FILING tool's own
    // escape (gateAttempts, 2026-09-01) can take the request unassigned.
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue(null as never);

    const args = { spoken_location: 'Downtown LA', queue: 'optical', call_sid: SID };
    const first = (await runTool('resolve_location', args)) as Record<string, unknown>;
    const second = (await runTool('resolve_location', args)) as Record<string, unknown>;
    const third = (await runTool('resolve_location', args)) as Record<string, unknown>;

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    // The exit: the caller's own words travel on, unverified and clearly so.
    expect(third.success).toBe(true);
    expect(third.resolved).toBe(false);
    expect(third.verified).toBe(false);
    expect(third.location).toBe('Downtown LA');
  });

  it('counts per call, so another caller still gets asked', async () => {
    const dir = await directory();
    vi.spyOn(dir, 'isDirectoryConfigured').mockReturnValue(true);
    vi.spyOn(dir, 'lookupLocation').mockResolvedValue(null as never);

    const args = { spoken_location: 'Downtown LA', queue: 'optical', call_sid: SID };
    await runTool('resolve_location', args);
    await runTool('resolve_location', args);

    const other = (await runTool('resolve_location', {
      ...args, call_sid: 'CA747908b5d46b7ed25cffe733fb792738',
    })) as Record<string, unknown>;

    expect(other.success).toBe(false);
  });
});
