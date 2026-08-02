/**
 * Shadow configuration. Every flag defaults to OFF/zero: with an empty
 * environment the shadow system captures nothing, spends nothing, and adds a
 * single boolean check to each production tap site.
 *
 * The production call path must never depend on any of these values
 * (Checkpoint 22) — they are read only inside src/shadow/**.
 */

export interface ShadowN8nBudgetConfig {
  /** Master switch for shadow-related n8n sends. Default false. */
  enabled: boolean;
  /** % of completed sessions eligible for a bundle send. Default 0. */
  capturePct: number;
  /** Hard cap of shadow n8n executions attributable to one call. Default 1. */
  maxExecutionsPerCall: number;
  dailyBudget: number;
  monthlyBudget: number;
  batchingEnabled: boolean;
  batchSize: number;
  batchMaxWaitMin: number;
  /** Fail closed: stop shadow sends, keep production untouched. Default true. */
  failClosed: boolean;
  monthlyAbsoluteLimit: number; // account-wide, 10,000
  monthlyPlannedLimit: number; // 8,000
  safetyReserve: number; // 2,000
  warnThreshold: number; // 5,600
  criticalThreshold: number; // 6,800
  stopThreshold: number; // 8,000
  /** Verified current production usage baseline (doc 13). */
  currentProductionMonthlyEstimate: number;
  /** Shadow-only webhook target; must never be a production gateway. */
  webhookUrl: string;
  /** Hosts/paths that can never be targeted by shadow sends. */
  productionHostBlocklist: string[];
  retryMax: number;
}

export interface ShadowConfig {
  enabled: boolean;
  agentAllowlist: string[];
  capturePct: number;
  storeTranscripts: boolean;
  spoolDir: string;
  spoolEnabled: boolean;
  retentionDays: number;
  queueMax: number;
  sessionTimeoutMin: number;
  comparisonEnabled: boolean;
  modelRoutingEnabled: boolean;
  modelLow: string;
  modelMid: string;
  modelHigh: string;
  modelMaxCallsPerSession: number;
  modelDailyCostCapUsd: number;
  duplicateReadonlyEnabled: boolean;
  n8n: ShadowN8nBudgetConfig;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}
function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : dflt;
}
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadShadowConfig(env: NodeJS.ProcessEnv = process.env): ShadowConfig {
  return {
    enabled: bool(env.SHADOW_MODE_ENABLED, false),
    agentAllowlist: list(env.SHADOW_AGENT_ALLOWLIST),
    capturePct: Math.min(100, Math.max(0, num(env.SHADOW_CAPTURE_PCT, 0))),
    storeTranscripts: bool(env.SHADOW_STORE_TRANSCRIPTS, false),
    spoolDir: env.SHADOW_SPOOL_DIR || '.shadow-spool',
    spoolEnabled: bool(env.SHADOW_SPOOL_ENABLED, true),
    retentionDays: num(env.SHADOW_RETENTION_DAYS, 14),
    queueMax: num(env.SHADOW_QUEUE_MAX, 5000),
    sessionTimeoutMin: num(env.SHADOW_SESSION_TIMEOUT_MIN, 30),
    comparisonEnabled: bool(env.SHADOW_COMPARISON_ENABLED, true),
    modelRoutingEnabled: bool(env.SHADOW_MODEL_ROUTING_ENABLED, false),
    modelLow: env.SHADOW_MODEL_LOW || 'gpt-4o-mini',
    modelMid: env.SHADOW_MODEL_MID || 'gpt-4o',
    // No stronger chat model is configured in this repo (doc 05 §2); the high
    // tier maps to the mid model until one is.
    modelHigh: env.SHADOW_MODEL_HIGH || 'gpt-4o',
    modelMaxCallsPerSession: num(env.SHADOW_MODEL_MAX_CALLS_PER_SESSION, 6),
    modelDailyCostCapUsd: num(env.SHADOW_MODEL_DAILY_COST_CAP_USD, 5),
    duplicateReadonlyEnabled: bool(env.SHADOW_DUPLICATE_READONLY_ENABLED, false),
    n8n: {
      enabled: bool(env.SHADOW_N8N_ENABLED, false),
      capturePct: Math.min(100, Math.max(0, num(env.SHADOW_N8N_CAPTURE_PCT, 0))),
      maxExecutionsPerCall: num(env.SHADOW_N8N_MAX_PER_CALL, 1),
      dailyBudget: num(env.SHADOW_N8N_DAILY_BUDGET, 10),
      monthlyBudget: num(env.SHADOW_N8N_MONTHLY_BUDGET, 300),
      batchingEnabled: bool(env.SHADOW_N8N_BATCHING_ENABLED, true),
      batchSize: num(env.SHADOW_N8N_BATCH_SIZE, 10),
      batchMaxWaitMin: num(env.SHADOW_N8N_BATCH_MAX_WAIT_MIN, 15),
      failClosed: bool(env.SHADOW_N8N_FAIL_CLOSED, true),
      monthlyAbsoluteLimit: num(env.N8N_MONTHLY_ABSOLUTE_LIMIT, 10000),
      monthlyPlannedLimit: num(env.N8N_MONTHLY_PLANNED_LIMIT, 8000),
      safetyReserve: num(env.N8N_SAFETY_RESERVE, 2000),
      warnThreshold: num(env.N8N_WARN_THRESHOLD, 5600),
      criticalThreshold: num(env.N8N_CRITICAL_THRESHOLD, 6800),
      stopThreshold: num(env.N8N_STOP_THRESHOLD, 8000),
      currentProductionMonthlyEstimate: num(env.N8N_CURRENT_PRODUCTION_MONTHLY_ESTIMATE, 6700),
      webhookUrl: env.SHADOW_N8N_WEBHOOK_URL || '',
      productionHostBlocklist: list(
        env.SHADOW_N8N_PRODUCTION_BLOCKLIST ||
          // Verified production surfaces (docs 13 & 01) — never shadow targets.
          'azulvision.app.n8n.cloud/webhook/,ticketing-n8n.onrender.com/webhook/,ticketing-app--fabianwayne1.replit.app',
      ),
      retryMax: num(env.SHADOW_N8N_RETRY_MAX, 3),
    },
  };
}

let cached: ShadowConfig | null = null;
export function getShadowConfig(): ShadowConfig {
  if (!cached) cached = loadShadowConfig();
  return cached;
}
/** Test/ops hook: force a re-read of the environment. */
export function resetShadowConfig(): void {
  cached = null;
}
