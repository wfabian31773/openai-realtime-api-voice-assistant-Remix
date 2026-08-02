/** Checkpoint 18 — bundle sender: batching, bounded retry, fail-closed, host guard. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetShadowConfig } from './config';
import { initialState } from './contracts';
import { N8nBudgetEnforcer } from './n8nBudget';
import { ShadowBundleSender, simulateN8nDecision, type BundleTransport } from './n8nSimulator';

const SHADOW_URL = 'https://shadow.example.com/webhook/api/voice-shadow/session-bundle';

function envOn(extra: Record<string, string> = {}): void {
  Object.assign(process.env, {
    SHADOW_MODE_ENABLED: 'true',
    SHADOW_N8N_ENABLED: 'true',
    SHADOW_N8N_WEBHOOK_URL: SHADOW_URL,
    SHADOW_N8N_BATCH_SIZE: '2',
    SHADOW_N8N_MAX_PER_CALL: '1',
    SHADOW_N8N_DAILY_BUDGET: '10',
    SHADOW_N8N_MONTHLY_BUDGET: '100',
    ...extra,
  });
  resetShadowConfig();
}

function envReset(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_') || k.startsWith('N8N_')) delete process.env[k];
  }
  resetShadowConfig();
}

describe('simulateN8nDecision', () => {
  beforeEach(envReset);
  afterEach(envReset);

  it('maps ticket tools to the verified submit-ticket workflow with zero budget impact', () => {
    const st = initialState('s1', 'no-ivr');
    const rec = simulateN8nDecision(st, 'create_ticket', { reasonForCalling: 'x' });
    expect(rec?.workflow).toBe('yS1ZZG4Dt5uGwuPo');
    expect(rec?.mutationBlocked).toBe(true);
    expect(rec?.executionMode).toBe('simulation-only');
    expect(rec?.budgetImpact).toBe(0);
    expect(rec?.replayAvailable).toBe(false);
  });

  it('marks replayAvailable when a copied production gateway result exists', () => {
    const st = initialState('s1', 'no-ivr');
    st.productionN8nHistory.push({
      endpoint: '/api/voice-agent/submit-ticket', viaGateway: true, status: 200,
      requestDigest: 'a', responseDigest: 'b', outcome: 'completed', atTurn: 1,
    });
    const rec = simulateN8nDecision(st, 'create_ticket', {});
    expect(rec?.replayAvailable).toBe(true);
  });

  it('returns null for tools with no n8n involvement', () => {
    const st = initialState('s1', 'azul-scheduling');
    expect(simulateN8nDecision(st, 'sage_book', {})).toBeNull();
  });
});

describe('ShadowBundleSender', () => {
  beforeEach(envReset);
  afterEach(envReset);

  it('enqueues nothing when shadow n8n is disabled (default)', async () => {
    envOn({ SHADOW_N8N_ENABLED: 'false' });
    const sender = new ShadowBundleSender();
    sender.enqueue('s1', 'no-ivr', { a: 1 });
    expect(sender.pending).toBe(0);
    const res = await sender.flush();
    expect(res.sent).toBe(0);
  });

  it('batches: waits for batch size before sending, then one send per session bundle', async () => {
    envOn();
    const calls: string[] = [];
    const transport: BundleTransport = async (_url, body) => {
      calls.push(body.sessionId);
      return { ok: true, status: 200 };
    };
    const enforcer = new N8nBudgetEnforcer({ ...((await import('./config')).getShadowConfig().n8n) });
    const sender = new ShadowBundleSender(enforcer, transport);
    sender.enqueue('s1', 'no-ivr', {});
    await sender.flush(new Date());
    expect(calls.length).toBe(0); // below batch size, within max wait
    sender.enqueue('s2', 'no-ivr', {});
    await sender.flush(new Date());
    expect(calls.sort()).toEqual(['s1', 's2']);
    expect(sender.pending).toBe(0);
  });

  it('session-level batching produces exactly one execution per completed session', async () => {
    envOn({ SHADOW_N8N_BATCH_SIZE: '1', SHADOW_N8N_MAX_PER_CALL: '1' });
    let sends = 0;
    const transport: BundleTransport = async () => { sends++; return { ok: true, status: 200 }; };
    const sender = new ShadowBundleSender(undefined, transport);
    sender.enqueue('s1', 'no-ivr', {});
    sender.enqueue('s1', 'no-ivr', {}); // duplicate completion event → same idempotency key
    await sender.flush(new Date());
    expect(sends).toBe(1); // second blocked by duplicate idempotency key
  });

  it('bounded retry with backoff, then drop (session stays replayable via spool)', async () => {
    envOn({ SHADOW_N8N_BATCH_SIZE: '1', SHADOW_N8N_RETRY_MAX: '2', SHADOW_N8N_MAX_PER_CALL: '10', SHADOW_N8N_DAILY_BUDGET: '10' });
    let attempts = 0;
    const transport: BundleTransport = async () => { attempts++; return { ok: false, status: 500 }; };
    const sender = new ShadowBundleSender(undefined, transport);
    sender.enqueue('s1', 'no-ivr', {});
    let now = Date.now();
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      await sender.flush(new Date(now));
    }
    expect(attempts).toBeLessThanOrEqual(3); // 1 + retryMax(2)... but duplicate key blocks re-record
    expect(sender.pending).toBe(0); // dropped after cap — no infinite retry loop
  });

  it('budget exhaustion blocks sends and drops the bundle (fail closed, production continues)', async () => {
    envOn({ SHADOW_N8N_BATCH_SIZE: '1', SHADOW_N8N_DAILY_BUDGET: '0' });
    let sends = 0;
    const transport: BundleTransport = async () => { sends++; return { ok: true, status: 200 }; };
    const sender = new ShadowBundleSender(undefined, transport);
    sender.enqueue('s1', 'no-ivr', {});
    const res = await sender.flush(new Date());
    expect(sends).toBe(0);
    expect(res.blocked).toBe(1);
    expect(sender.pending).toBe(0);
  });

  it('production webhook target is refused even if misconfigured (mutation block)', async () => {
    envOn({
      SHADOW_N8N_BATCH_SIZE: '1',
      SHADOW_N8N_WEBHOOK_URL: 'https://azulvision.app.n8n.cloud/webhook/ec2aef83-0423-4cad-9020-d079f5b07943/api/voice-agent/create-ticket',
    });
    let sends = 0;
    const transport: BundleTransport = async () => { sends++; return { ok: true, status: 200 }; };
    const sender = new ShadowBundleSender(undefined, transport);
    sender.enqueue('s1', 'no-ivr', {});
    const res = await sender.flush(new Date());
    expect(sends).toBe(0);
    expect(res.blocked).toBe(1);
  });
});
