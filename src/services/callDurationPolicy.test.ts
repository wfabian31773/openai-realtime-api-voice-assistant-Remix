import { describe, it, expect } from 'vitest';
import {
  AGENT_MAX_DURATION_MS,
  DEFAULT_MAX_DURATION_MS,
  ABSOLUTE_MAX_CALL_DURATION_MS,
  getMaxDurationMs,
} from './callDurationPolicy';

// p0Hardening.test.ts asserts some of this too, but it reaches these values
// through callLifecycleCoordinator and so pulls in the database — it cannot
// collect without DATABASE_URL and does not run in a bare checkout. Reading
// them from the pure module means the ceilings are actually covered.
describe('call duration ceilings', () => {
  it('gives every conversational agent more than the old 10-minute ceiling', () => {
    // The ceiling that was cutting real callers off mid-sentence at ~602s.
    for (const [slug, ms] of Object.entries(AGENT_MAX_DURATION_MS)) {
      if (slug === 'appointment-confirmation') continue; // outbound, finishes in 60-90s
      expect(ms, slug).toBeGreaterThan(10 * 60 * 1000);
    }
  });

  it('falls back to a sane ceiling for an unknown slug', () => {
    // The original bug was not a wrong per-agent value but agentSlug never
    // arriving, so every agent silently ran on DEFAULT. DEFAULT must be safe.
    expect(getMaxDurationMs(undefined)).toBe(DEFAULT_MAX_DURATION_MS);
    expect(getMaxDurationMs('an-agent-that-does-not-exist')).toBe(DEFAULT_MAX_DURATION_MS);
    expect(DEFAULT_MAX_DURATION_MS).toBeGreaterThan(10 * 60 * 1000);
  });

  it('returns the explicit value for a known slug', () => {
    expect(getMaxDurationMs('azul-scheduling')).toBe(20 * 60 * 1000);
    expect(getMaxDurationMs('appointment-confirmation')).toBe(3 * 60 * 1000);
  });

  it('gives azul-scheduling at least as long as no-ivr', () => {
    expect(getMaxDurationMs('azul-scheduling')).toBeGreaterThanOrEqual(getMaxDurationMs('no-ivr'));
  });

  it('keeps the absolute ceiling above every per-agent cap', () => {
    // The invariant the derivation exists to hold: the startup sweep and DB
    // reconciler force-terminate past this, so if it ever dropped below a
    // per-agent cap they would cut calls the agent was still entitled to run.
    for (const [slug, ms] of Object.entries(AGENT_MAX_DURATION_MS)) {
      expect(ABSOLUTE_MAX_CALL_DURATION_MS, slug).toBeGreaterThan(ms);
    }
    expect(ABSOLUTE_MAX_CALL_DURATION_MS).toBeGreaterThan(DEFAULT_MAX_DURATION_MS);
  });
});
