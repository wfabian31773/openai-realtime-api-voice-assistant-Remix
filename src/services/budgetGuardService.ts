import { storage } from '../../server/storage';

/**
 * BudgetGuardService: Per-day spending guardrails.
 *
 * - Tracks rolling daily cost from call logs
 * - Alerts at configurable warning threshold (default 80%)
 * - Blocks outbound calls at budget limit (never blocks inbound)
 * - Thread-safe via single-instance pattern
 */

const DEFAULT_DAILY_BUDGET_CENTS = parseInt(process.env.DAILY_BUDGET_CENTS || '5000', 10); // $50 default
const WARNING_THRESHOLD = parseFloat(process.env.BUDGET_WARNING_THRESHOLD || '0.80'); // 80%

interface BudgetStatus {
  todaySpendCents: number;
  dailyBudgetCents: number;
  percentUsed: number;
  isOverBudget: boolean;
  isWarning: boolean;
  remainingCents: number;
}

class BudgetGuardService {
  private dailyBudgetCents: number;
  private warningThreshold: number;
  private lastWarningDate: string | null = null;

  constructor() {
    this.dailyBudgetCents = DEFAULT_DAILY_BUDGET_CENTS;
    this.warningThreshold = WARNING_THRESHOLD;
    console.info(`[BUDGET GUARD] Initialized: daily budget $${(this.dailyBudgetCents / 100).toFixed(2)}, warning at ${(this.warningThreshold * 100).toFixed(0)}%`);
  }

  /**
   * Get today's date in YYYY-MM-DD format (Pacific Time)
   */
  private getTodayDate(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  /**
   * Get current budget status for today.
   */
  async getStatus(): Promise<BudgetStatus> {
    const today = this.getTodayDate();
    const todaySpendCents = await storage.getEstimatedOpenaiCostForDate(today);
    const percentUsed = this.dailyBudgetCents > 0 ? todaySpendCents / this.dailyBudgetCents : 0;
    const isOverBudget = todaySpendCents >= this.dailyBudgetCents;
    const isWarning = percentUsed >= this.warningThreshold && !isOverBudget;
    const remainingCents = Math.max(0, this.dailyBudgetCents - todaySpendCents);

    // Log warning once per day
    if (isWarning && this.lastWarningDate !== today) {
      this.lastWarningDate = today;
      console.warn(`[BUDGET GUARD] ⚠️ Daily spend at ${(percentUsed * 100).toFixed(1)}% ($${(todaySpendCents / 100).toFixed(2)} / $${(this.dailyBudgetCents / 100).toFixed(2)})`);
    }

    if (isOverBudget) {
      console.warn(`[BUDGET GUARD] 🚫 Daily budget exceeded: $${(todaySpendCents / 100).toFixed(2)} / $${(this.dailyBudgetCents / 100).toFixed(2)}`);
    }

    return {
      todaySpendCents,
      dailyBudgetCents: this.dailyBudgetCents,
      percentUsed,
      isOverBudget,
      isWarning,
      remainingCents,
    };
  }

  /**
   * Check if an outbound call should be allowed based on budget.
   * NEVER blocks inbound calls (patient safety).
   * Returns { allowed: boolean, reason?: string }
   */
  async canMakeOutboundCall(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.getStatus();

    if (status.isOverBudget) {
      return {
        allowed: false,
        reason: `Daily budget exceeded: $${(status.todaySpendCents / 100).toFixed(2)} / $${(status.dailyBudgetCents / 100).toFixed(2)}. Outbound calls paused until tomorrow.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Update the daily budget (in cents). Used by admin API.
   */
  setDailyBudget(cents: number): void {
    this.dailyBudgetCents = cents;
    console.info(`[BUDGET GUARD] Budget updated to $${(cents / 100).toFixed(2)}/day`);
  }

  /**
   * Get configured budget amount.
   */
  getDailyBudgetCents(): number {
    return this.dailyBudgetCents;
  }
}

export const budgetGuardService = new BudgetGuardService();
