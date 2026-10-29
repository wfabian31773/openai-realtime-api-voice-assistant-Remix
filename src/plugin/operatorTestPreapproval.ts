import { operatorFromProblem, parseOperatorPayload, E164 } from "./operatorLine";
import { COMMITTED_OPERATOR_SCENARIOS, scenarioScriptHash } from "./operatorScenarios";
import { hashPayload } from "./tokens";
import type { ContactApprovalRow, OperatorTestRule, PluginStore } from "./store";

type Env = Record<string, string | undefined>;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function minuteOfDay(value: string): number | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Invalid configuration disables the rule; it never widens the lane. */
export function operatorTestConfig(env: Env) {
  if (env.OPERATOR_TEST_PREAPPROVAL_ENABLED !== "true" || operatorFromProblem(env)) return null;
  const maxApprovals = Number(env.OPERATOR_TEST_MAX_AUTO_APPROVALS ?? "10");
  const windowMs = Number(env.OPERATOR_TEST_WINDOW_HOURS ?? "24") * 60 * 60 * 1000;
  const peakStart = minuteOfDay(env.OPERATOR_TEST_PEAK_START ?? "08:00");
  const peakEnd = minuteOfDay(env.OPERATOR_TEST_PEAK_END ?? "17:00");
  const peakDays = (env.OPERATOR_TEST_PEAK_DAYS ?? "Mon,Tue,Wed,Thu,Fri").split(",").map((day) => day.trim());
  const allowlist = ["+19094795435", ...(env.OPERATOR_TEST_ALLOWLIST?.split(",").map((phone) => phone.trim()) ?? [])].filter(Boolean);
  if (!Number.isSafeInteger(maxApprovals) || maxApprovals < 1 || maxApprovals > 2147483647 ||
      !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 365 * 24 * 60 * 60 * 1000 ||
      peakStart === null || peakEnd === null || peakStart === peakEnd ||
      !peakDays.every((day) => DAYS.includes(day)) || !allowlist.every((phone) => E164.test(phone))) return null;
  return { maxApprovals, windowMs, peakStart, peakEnd, peakDays, allowlist, fromNumber: env.OPERATOR_LINE_FROM_NUMBER!.trim() };
}

/** Start inclusive, end exclusive; overnight windows belong to their starting day. */
export function operatorTestPeakBlocked(now: Date, config: NonNullable<ReturnType<typeof operatorTestConfig>>): boolean {
  const parts = Object.fromEntries(pacific.formatToParts(now).map((part) => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const day = DAYS.indexOf(parts.weekday);
  if (config.peakStart < config.peakEnd) {
    return config.peakDays.includes(DAYS[day]) && minute >= config.peakStart && minute < config.peakEnd;
  }
  return (minute >= config.peakStart && config.peakDays.includes(DAYS[day])) ||
    (minute < config.peakEnd && config.peakDays.includes(DAYS[(day + 6) % 7]));
}

export function operatorTestEligibility(payload: Record<string, unknown>, env: Env, now: Date):
  { rule: OperatorTestRule; config: NonNullable<ReturnType<typeof operatorTestConfig>> } | null {
  const config = operatorTestConfig(env);
  if (!config || !Number.isFinite(now.getTime()) || operatorTestPeakBlocked(now, config)) return null;
  const parsed = parseOperatorPayload(payload);
  const scenarios = COMMITTED_OPERATOR_SCENARIOS;
  if (!parsed.ok || !config.allowlist.includes(parsed.payload.phone) || !scenarios) return null;
  const scriptHash = scenarioScriptHash(parsed.payload.callerScript);
  const scenarioId = parsed.payload.scenarioId ?? Object.keys(scenarios).find((id) => scenarios[id] === scriptHash);
  if (!scenarioId || scenarios[scenarioId] !== scriptHash) return null;
  return { config, rule: { scenarioId, scriptHash, fromNumber: config.fromNumber, reason: "committed-scenario-test" } };
}

export async function preapproveOperatorTest(store: PluginStore, row: ContactApprovalRow, env: Env, now: Date): Promise<ContactApprovalRow> {
  const eligible = operatorTestEligibility(row.payload, env, now);
  if (!eligible || row.channel !== "call" || row.status !== "pending" || row.payload.callKind !== "operator" || hashPayload(row.payload) !== row.payloadHash) return row;
  try {
    return await store.tryApproveOperatorTest(row, eligible.rule, eligible.config.maxApprovals,
      new Date(now.getTime() - eligible.config.windowMs), now) ?? row;
  } catch {
    // Includes a missing migration: retain per-call human approval. No error text/PHI.
    console.error("[operator-test-preapproval] rule storage unavailable; human approval required");
    return row;
  }
}

/** Recheck standing authority before consuming an outstanding auto-approved token. */
export function operatorTestCommitProblem(row: ContactApprovalRow, env: Env, now: Date): string | null {
  if (row.approvedBy !== "test-preapproval-rule") return null;
  const eligible = operatorTestEligibility(row.payload, env, now);
  if (!eligible || !row.preapprovalRule || eligible.rule.fromNumber !== row.preapprovalRule.fromNumber ||
      eligible.rule.scenarioId !== row.preapprovalRule.scenarioId || eligible.rule.scriptHash !== row.preapprovalRule.scriptHash) {
    return "Operator test pre-approval no longer applies; prepare a new request for approval";
  }
  return null;
}
