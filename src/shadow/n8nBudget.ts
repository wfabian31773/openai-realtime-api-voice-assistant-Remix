/**
 * n8n execution-budget enforcement (Checkpoints 15–17).
 * Model: docs 14 & 16. Fail-closed = shadow sends stop; production continues
 * (production is not even reachable from this module — see the host guard).
 */
import type { ShadowN8nBudgetConfig } from './config';

export type BudgetLevel = 'ok' | 'warning' | 'critical' | 'stopped';

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  level: BudgetLevel;
}

export interface BudgetSnapshot {
  today: number;
  month: number;
  monthKey: string;
  perCall: Record<string, number>;
  duplicatesBlocked: number;
  rejected: number;
  retries: number;
  level: BudgetLevel;
  projectedMonthEndTotal: number;
  remainingPlanned: number;
  remainingAbsolute: number;
  estCapReachedDate: string | null;
}

export class N8nBudgetEnforcer {
  private dayKey = '';
  private monthKey = '';
  private today = 0;
  private month = 0;
  private perCall = new Map<string, number>();
  private sentKeys = new Set<string>();
  private duplicatesBlocked = 0;
  private rejected = 0;
  private retries = 0;

  constructor(private cfg: ShadowN8nBudgetConfig) {}

  private roll(now: Date): void {
    const d = now.toISOString().slice(0, 10);
    const m = now.toISOString().slice(0, 7);
    if (d !== this.dayKey) {
      this.dayKey = d;
      this.today = 0;
    }
    if (m !== this.monthKey) {
      this.monthKey = m;
      this.month = 0;
      this.perCall.clear();
      this.sentKeys.clear();
    }
  }

  /** Combined production estimate + shadow actuals vs thresholds. */
  level(now: Date = new Date()): BudgetLevel {
    this.roll(now);
    const total = this.cfg.currentProductionMonthlyEstimate + this.month;
    if (total >= this.cfg.stopThreshold) return 'stopped';
    if (total >= this.cfg.criticalThreshold) return 'critical';
    if (total >= this.cfg.warnThreshold) return 'warning';
    return 'ok';
  }

  /**
   * Application-level gate (Checkpoint 16): run before ANY shadow n8n send.
   * Checks: enabled → target-host safety → capture → per-call cap → daily →
   * monthly → thresholds → idempotency.
   */
  decide(
    sessionId: string,
    idempotencyKey: string,
    opts: { isRetry?: boolean; now?: Date } = {},
  ): BudgetDecision {
    const now = opts.now ?? new Date();
    this.roll(now);

    if (!this.cfg.enabled) {
      return { allowed: false, reason: 'shadow n8n disabled', level: this.level(now) };
    }
    if (!this.cfg.webhookUrl) {
      this.rejected++;
      return { allowed: false, reason: 'no shadow webhook configured (fail closed)', level: this.level(now) };
    }
    const target = this.cfg.webhookUrl.toLowerCase();
    if (this.cfg.productionHostBlocklist.some((h) => h && target.includes(h.toLowerCase()))) {
      this.rejected++;
      return { allowed: false, reason: 'target matches production blocklist — refusing', level: this.level(now) };
    }
    if (!idempotencyKey) {
      this.rejected++;
      return { allowed: false, reason: 'missing idempotency key (fail closed)', level: this.level(now) };
    }
    if (this.sentKeys.has(idempotencyKey)) {
      this.duplicatesBlocked++;
      return { allowed: false, reason: 'duplicate idempotency key', level: this.level(now) };
    }
    if ((this.perCall.get(sessionId) ?? 0) >= this.cfg.maxExecutionsPerCall) {
      this.rejected++;
      return { allowed: false, reason: 'per-call execution cap reached', level: this.level(now) };
    }
    if (this.today >= this.cfg.dailyBudget) {
      this.rejected++;
      return { allowed: false, reason: 'daily shadow budget exhausted (fail closed)', level: this.level(now) };
    }
    if (this.month >= this.cfg.monthlyBudget) {
      this.rejected++;
      return { allowed: false, reason: 'monthly shadow budget exhausted (fail closed)', level: this.level(now) };
    }
    const lvl = this.level(now);
    if (lvl === 'stopped') {
      this.rejected++;
      return { allowed: false, reason: 'account stop threshold reached (fail closed)', level: lvl };
    }
    return { allowed: true, reason: 'ok', level: lvl };
  }

  /** Record an actual send attempt (success or retry). Retries count (CP17). */
  record(sessionId: string, idempotencyKey: string, opts: { isRetry?: boolean; now?: Date } = {}): void {
    const now = opts.now ?? new Date();
    this.roll(now);
    this.today++;
    this.month++;
    this.perCall.set(sessionId, (this.perCall.get(sessionId) ?? 0) + 1);
    this.sentKeys.add(idempotencyKey);
    if (opts.isRetry) this.retries++;
  }

  snapshot(now: Date = new Date()): BudgetSnapshot {
    this.roll(now);
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const shadowProjected = dayOfMonth > 0 ? Math.round((this.month / dayOfMonth) * daysInMonth) : this.month;
    const projectedTotal = this.cfg.currentProductionMonthlyEstimate + shadowProjected;
    const combined = this.cfg.currentProductionMonthlyEstimate + this.month;
    const remainingPlanned = Math.max(0, this.cfg.monthlyPlannedLimit - combined);
    const dailyRate = combined / Math.max(1, dayOfMonth);
    let estCapReachedDate: string | null = null;
    if (dailyRate > 0 && combined < this.cfg.monthlyAbsoluteLimit) {
      const daysToCap = (this.cfg.monthlyAbsoluteLimit - combined) / dailyRate;
      if (daysToCap <= daysInMonth - dayOfMonth) {
        const d = new Date(now.getTime() + daysToCap * 86400_000);
        estCapReachedDate = d.toISOString().slice(0, 10);
      }
    }
    return {
      today: this.today,
      month: this.month,
      monthKey: this.monthKey,
      perCall: Object.fromEntries(this.perCall),
      duplicatesBlocked: this.duplicatesBlocked,
      rejected: this.rejected,
      retries: this.retries,
      level: this.level(now),
      projectedMonthEndTotal: projectedTotal,
      remainingPlanned,
      remainingAbsolute: Math.max(0, this.cfg.monthlyAbsoluteLimit - combined),
      estCapReachedDate,
    };
  }
}
