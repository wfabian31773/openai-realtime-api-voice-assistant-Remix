/** Checkpoint 18 — n8n budget enforcement proofs (CP 15–17). */
import { describe, expect, it } from 'vitest';
import type { ShadowN8nBudgetConfig } from './config';
import { N8nBudgetEnforcer } from './n8nBudget';

function cfg(partial: Partial<ShadowN8nBudgetConfig> = {}): ShadowN8nBudgetConfig {
  return {
    enabled: true,
    capturePct: 100,
    maxExecutionsPerCall: 1,
    dailyBudget: 10,
    monthlyBudget: 300,
    batchingEnabled: true,
    batchSize: 10,
    batchMaxWaitMin: 15,
    failClosed: true,
    monthlyAbsoluteLimit: 10000,
    monthlyPlannedLimit: 8000,
    safetyReserve: 2000,
    warnThreshold: 5600,
    criticalThreshold: 6800,
    stopThreshold: 8000,
    currentProductionMonthlyEstimate: 6700,
    webhookUrl: 'https://shadow.example.com/webhook/api/voice-shadow/session-bundle',
    productionHostBlocklist: ['azulvision.app.n8n.cloud/webhook/', 'ticketing-n8n.onrender.com/webhook/', 'ticketing-app--fabianwayne1.replit.app'],
    retryMax: 3,
    ...partial,
  };
}

const T0 = new Date('2026-08-10T12:00:00Z');

describe('N8nBudgetEnforcer', () => {
  it('disabled by default config refuses everything', () => {
    const e = new N8nBudgetEnforcer(cfg({ enabled: false }));
    expect(e.decide('s1', 'k1', { now: T0 }).allowed).toBe(false);
  });

  it('refuses production gateway targets — mutating production workflows unreachable', () => {
    const e = new N8nBudgetEnforcer(cfg({
      webhookUrl: 'https://azulvision.app.n8n.cloud/webhook/c02059a6-2058-496b-993e-c439918aa878/api/voice-agent/submit-ticket',
    }));
    const d = e.decide('s1', 'k1', { now: T0 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('production blocklist');
  });

  it('refuses the direct ticketing-app host too', () => {
    const e = new N8nBudgetEnforcer(cfg({ webhookUrl: 'https://ticketing-app--fabianwayne1.replit.app/api/voice-agent/create-ticket' }));
    expect(e.decide('s1', 'k1', { now: T0 }).allowed).toBe(false);
  });

  it('enforces the per-call execution cap (one call cannot exceed it)', () => {
    const e = new N8nBudgetEnforcer(cfg());
    expect(e.decide('call-A', 'k1', { now: T0 }).allowed).toBe(true);
    e.record('call-A', 'k1', { now: T0 });
    const second = e.decide('call-A', 'k2', { now: T0 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('per-call');
  });

  it('duplicate idempotency keys are blocked (duplicate events ⇒ no duplicate executions)', () => {
    const e = new N8nBudgetEnforcer(cfg({ maxExecutionsPerCall: 5 }));
    e.record('call-A', 'k1', { now: T0 });
    const d = e.decide('call-A', 'k1', { now: T0 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('duplicate');
    expect(e.snapshot(T0).duplicatesBlocked).toBe(1);
  });

  it('daily budget stops additional shadow executions; production untouched', () => {
    const e = new N8nBudgetEnforcer(cfg({ dailyBudget: 2, maxExecutionsPerCall: 5 }));
    e.record('c1', 'k1', { now: T0 });
    e.record('c2', 'k2', { now: T0 });
    const d = e.decide('c3', 'k3', { now: T0 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('daily');
    // next day rolls over
    const T1 = new Date('2026-08-11T12:00:00Z');
    expect(e.decide('c3', 'k3', { now: T1 }).allowed).toBe(true);
  });

  it('monthly budget stops additional shadow executions', () => {
    const e = new N8nBudgetEnforcer(cfg({ monthlyBudget: 2, dailyBudget: 100, maxExecutionsPerCall: 5 }));
    e.record('c1', 'k1', { now: T0 });
    e.record('c2', 'k2', { now: T0 });
    const d = e.decide('c3', 'k3', { now: T0 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('monthly');
  });

  it('missing idempotency key fails closed', () => {
    const e = new N8nBudgetEnforcer(cfg());
    expect(e.decide('c1', '', { now: T0 }).allowed).toBe(false);
  });

  it('missing webhook URL fails closed', () => {
    const e = new N8nBudgetEnforcer(cfg({ webhookUrl: '' }));
    expect(e.decide('c1', 'k1', { now: T0 }).allowed).toBe(false);
  });

  it('account stop threshold blocks sends given production baseline', () => {
    const e = new N8nBudgetEnforcer(cfg({ currentProductionMonthlyEstimate: 8000 }));
    const d = e.decide('c1', 'k1', { now: T0 });
    expect(d.allowed).toBe(false);
    expect(d.level).toBe('stopped');
  });

  it('threshold ladder: ok → warning → critical → stopped', () => {
    expect(new N8nBudgetEnforcer(cfg({ currentProductionMonthlyEstimate: 1000 })).level(T0)).toBe('ok');
    expect(new N8nBudgetEnforcer(cfg({ currentProductionMonthlyEstimate: 5700 })).level(T0)).toBe('warning');
    expect(new N8nBudgetEnforcer(cfg({ currentProductionMonthlyEstimate: 6900 })).level(T0)).toBe('critical');
    expect(new N8nBudgetEnforcer(cfg({ currentProductionMonthlyEstimate: 8100 })).level(T0)).toBe('stopped');
  });

  it('retries count against the budget and are reported', () => {
    const e = new N8nBudgetEnforcer(cfg({ maxExecutionsPerCall: 5, dailyBudget: 5 }));
    e.record('c1', 'k1', { now: T0 });
    e.record('c1', 'k1-retry', { now: T0, isRetry: true });
    const snap = e.snapshot(T0);
    expect(snap.retries).toBe(1);
    expect(snap.today).toBe(2);
  });

  it('snapshot exposes operational fields incl. projected month-end and cap date', () => {
    const e = new N8nBudgetEnforcer(cfg());
    e.record('c1', 'k1', { now: T0 });
    const snap = e.snapshot(T0);
    expect(snap.month).toBe(1);
    expect(snap.remainingPlanned).toBe(8000 - 6700 - 1);
    expect(snap.remainingAbsolute).toBe(10000 - 6700 - 1);
    expect(snap.projectedMonthEndTotal).toBeGreaterThan(6700);
    expect(snap.level).toBe('warning'); // 6700 baseline > 5600 warn threshold
  });
});
