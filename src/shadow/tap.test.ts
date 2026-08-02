/**
 * Checkpoint 18 — tap isolation proofs:
 *  - disabled shadow ⇒ tap is a counted no-op (production output unchanged)
 *  - a sabotaged consumer/queue can never throw into the emitter
 *  - overflow drops oldest, never blocks
 *  - session-sticky sampling
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetShadowConfig } from './config';
import { sampleBucket, ShadowTap } from './tap';

const ENV_KEYS = [
  'SHADOW_MODE_ENABLED', 'SHADOW_AGENT_ALLOWLIST', 'SHADOW_CAPTURE_PCT', 'SHADOW_QUEUE_MAX',
];

function setEnv(vars: Record<string, string>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  resetShadowConfig();
}

describe('ShadowTap production isolation', () => {
  beforeEach(() => setEnv({}));
  afterEach(() => setEnv({}));

  it('is a no-op when shadow is disabled (default environment)', () => {
    const tap = new ShadowTap();
    let consumed = 0;
    tap.subscribe(() => { consumed++; });
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'hello' });
    tap.drainNow();
    expect(consumed).toBe(0);
    expect(tap.counters.emitted).toBe(0);
    expect(tap.counters.sampledOut).toBe(1);
  });

  it('is a no-op when enabled but allowlist is empty (default)', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'hello' });
    expect(tap.counters.emitted).toBe(0);
  });

  it('is a no-op when capture percentage is zero (default)', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr' });
    const tap = new ShadowTap();
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'hello' });
    expect(tap.counters.emitted).toBe(0);
  });

  it('captures only allowlisted agents', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'a' });
    tap.emit('user_transcript', 'call-2', 'azul-scheduling', { text: 'b' });
    expect(tap.counters.emitted).toBe(1);
    expect(tap.counters.sampledOut).toBe(1);
  });

  it('NEVER throws even when a consumer throws synchronously or rejects', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    tap.subscribe(() => { throw new Error('sabotage'); });
    tap.subscribe(() => Promise.reject(new Error('async sabotage')));
    expect(() => {
      tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'x' });
      tap.drainNow();
    }).not.toThrow();
    expect(tap.counters.consumerErrors).toBeGreaterThan(0);
  });

  it('NEVER throws even when internal state is sabotaged', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    // Sabotage the queue so push explodes — the emit contract must hold anyway.
    (tap as unknown as { queue: unknown }).queue = { length: 0, push: () => { throw new Error('boom'); }, shift: () => undefined, splice: () => [] };
    expect(() => tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'x' })).not.toThrow();
    expect(tap.counters.consumerErrors).toBeGreaterThan(0);
  });

  it('drops oldest on overflow instead of blocking (backpressure)', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100', SHADOW_QUEUE_MAX: '3' });
    const tap = new ShadowTap();
    for (let i = 0; i < 10; i++) tap.emit('user_transcript', 'call-1', 'no-ivr', { text: `t${i}` });
    expect(tap.counters.dropped).toBe(7);
    let seen = 0;
    tap.subscribe((events) => { seen = events.length; });
    tap.drainNow();
    expect(seen).toBe(3);
  });

  it('sampling is session-sticky and respects the percentage', () => {
    const bucket = sampleBucket('some-session');
    expect(bucket).toBe(sampleBucket('some-session'));
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    expect(tap.isCaptured('any-session', 'no-ivr')).toBe(true);
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '0' });
    expect(tap.isCaptured('any-session', 'no-ivr')).toBe(false);
  });

  it('assigns increasing turn ids on user transcripts', () => {
    setEnv({ SHADOW_MODE_ENABLED: 'true', SHADOW_AGENT_ALLOWLIST: 'no-ivr', SHADOW_CAPTURE_PCT: '100' });
    const tap = new ShadowTap();
    const turns: Array<number | undefined> = [];
    tap.subscribe((events) => { for (const e of events) turns.push(e.turnId); });
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'one' });
    tap.emit('assistant_transcript', 'call-1', 'no-ivr', { text: 'reply' });
    tap.emit('user_transcript', 'call-1', 'no-ivr', { text: 'two' });
    tap.drainNow();
    expect(turns).toEqual([1, 1, 2]);
  });
});
