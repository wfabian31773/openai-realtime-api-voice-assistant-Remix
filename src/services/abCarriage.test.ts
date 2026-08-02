import { describe, expect, it } from 'vitest';
import { hashSid, resolveAbAssignment } from './abCarriage';

const CONTROL = 'gpt-realtime';

describe('resolveAbAssignment', () => {
  it('no experiment when no challenger is configured', () => {
    expect(resolveAbAssignment('no-ivr', 'CA1', CONTROL, {} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('legacy AZUL_AB_MODEL_B alone keeps azul-only behavior', () => {
    const env = { AZUL_AB_MODEL_B: 'gpt-realtime-2.1' } as NodeJS.ProcessEnv;
    expect(resolveAbAssignment('no-ivr', 'CA1', CONTROL, env)).toEqual({});
    const azul = resolveAbAssignment('azul-scheduling', 'CA1', CONTROL, env);
    expect(azul.armLabel).toMatch(/^[AB]:/);
  });

  it('AB_MODEL_B + AB_MODEL_B_AGENTS gates by allowlist', () => {
    const env = {
      AB_MODEL_B: 'gpt-realtime-2.1',
      AB_MODEL_B_AGENTS: 'azul-scheduling,answering-service,no-ivr',
    } as NodeJS.ProcessEnv;
    for (const slug of ['azul-scheduling', 'answering-service', 'no-ivr']) {
      expect(resolveAbAssignment(slug, 'CAabc', CONTROL, env).armLabel).toMatch(/^[AB]:/);
    }
    expect(resolveAbAssignment('after-hours', 'CAabc', CONTROL, env)).toEqual({});
    expect(resolveAbAssignment('appointment-confirmation', 'CAabc', CONTROL, env)).toEqual({});
  });

  it('assignment is deterministic per sid and ~50/50 across sids', () => {
    const env = { AB_MODEL_B: 'gpt-realtime-2.1', AB_MODEL_B_AGENTS: 'no-ivr' } as NodeJS.ProcessEnv;
    const a = resolveAbAssignment('no-ivr', 'CAsame', CONTROL, env);
    const b = resolveAbAssignment('no-ivr', 'CAsame', CONTROL, env);
    expect(a).toEqual(b);
    let armB = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (resolveAbAssignment('no-ivr', `CA${i}`, CONTROL, env).challengerModel) armB++;
    }
    expect(armB).toBeGreaterThan(N * 0.4);
    expect(armB).toBeLessThan(N * 0.6);
  });

  it('arm B carries the challenger; arm A keeps the control model in the label', () => {
    const env = { AB_MODEL_B: 'gpt-realtime-2.1', AB_MODEL_B_AGENTS: 'no-ivr' } as NodeJS.ProcessEnv;
    // find one sid per arm
    let sidA = '', sidB = '';
    for (let i = 0; i < 100 && (!sidA || !sidB); i++) {
      const sid = `CA${i}`;
      if (hashSid(sid) % 2 === 0) sidA = sidA || sid;
      else sidB = sidB || sid;
    }
    const armA = resolveAbAssignment('no-ivr', sidA, CONTROL, env);
    expect(armA.challengerModel).toBeUndefined();
    expect(armA.armLabel).toBe(`A:${CONTROL}`);
    const armB = resolveAbAssignment('no-ivr', sidB, CONTROL, env);
    expect(armB.challengerModel).toBe('gpt-realtime-2.1');
    expect(armB.armLabel).toBe('B:gpt-realtime-2.1');
  });

  it('empty sid means no assignment (never randomize)', () => {
    const env = { AB_MODEL_B: 'x', AB_MODEL_B_AGENTS: 'no-ivr' } as NodeJS.ProcessEnv;
    expect(resolveAbAssignment('no-ivr', '', CONTROL, env)).toEqual({});
  });
});
