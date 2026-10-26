/**
 * The VAD threshold is the most consequential number on this transport and it
 * had never been measured. See grokSession.ts for the 2026-09-03 evidence:
 * "barely heard" calls roughly tripled against the old core, on both lanes
 * that ran both pipelines.
 *
 * These pin the two things that make the knob safe to have: it is reachable
 * without a deploy, and a bad value cannot disable turn detection on a live
 * call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('./grokSession');
};

const ORIGINAL = process.env.RUNTIME_VAD_THRESHOLD;
beforeEach(() => { delete process.env.RUNTIME_VAD_THRESHOLD; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RUNTIME_VAD_THRESHOLD;
  else process.env.RUNTIME_VAD_THRESHOLD = ORIGINAL;
});

const thresholdOf = (mod: any) => {
  const cfg = mod.buildSessionConfig(
    { voiceName: 'x', reasoningEffort: 'low' } as any, 'prompt', [],
  );
  return cfg.turn_detection.threshold;
};

describe('the VAD threshold', () => {
  it('defaults BELOW the vendor default of 0.85, which is what was measured too high', async () => {
    expect(thresholdOf(await load())).toBeLessThan(0.85);
  });

  it('is tunable from the environment, so tomorrow does not need a deploy', async () => {
    process.env.RUNTIME_VAD_THRESHOLD = '0.45';
    expect(thresholdOf(await load())).toBe(0.45);
  });

  /**
   * A threshold of 0 would treat silence as speech on every live call, and a
   * typo is the likeliest way to get one. Clamped rather than trusted.
   */
  it('clamps a value outside the documented 0.1–0.9 range', async () => {
    process.env.RUNTIME_VAD_THRESHOLD = '0';
    expect(thresholdOf(await load())).toBe(0.1);
    process.env.RUNTIME_VAD_THRESHOLD = '5';
    expect(thresholdOf(await load())).toBe(0.9);
  });

  it('falls back to the default when the env var is not a number', async () => {
    process.env.RUNTIME_VAD_THRESHOLD = 'aggressive';
    const t = thresholdOf(await load());
    expect(t).toBeGreaterThanOrEqual(0.1);
    expect(t).toBeLessThan(0.85);
  });

  it('still asks for server-side turn detection whatever the threshold', async () => {
    process.env.RUNTIME_VAD_THRESHOLD = '0.2';
    const mod = await load();
    const cfg = mod.buildSessionConfig({ voiceName: 'x', reasoningEffort: 'low' } as any, 'p', []);
    expect(cfg.turn_detection?.type).toBe('server_vad');
    expect(cfg.turn_detection?.silence_duration_ms).toBe(500);
  });
});
