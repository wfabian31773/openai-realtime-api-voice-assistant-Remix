/** Operator requests have no patient identity or ticket fields. */
import { lookupOperatorScenario, operatorScenarioGoal } from "./operatorScenarios";
import { SI_ASSISTANT_NUMBER_DEFAULT, siAssistantNumber } from "./siAssistantConstants";
import { dncKey } from "../runtime/outbound/store";

export const OPERATOR_SLUG = "wayne-operator";
export const OPERATOR_DEFAULT_DURATION = 60 * 60;
export type OperatorInitiator = "owner_request" | "bot_initiative";
type Env = Record<string, string | undefined>;

/** Invalid settings fall back to a long safety maximum; never an unbounded timer. */
export function operatorMaxDurationSec(env: Env = process.env): number {
  const minutes = Number(env.OPERATOR_LINE_MAX_CALL_MINUTES ?? 60);
  return Number.isFinite(minutes) && minutes > 0 && minutes * 60 * 1000 <= 2_147_483_647
    ? Math.max(1, Math.floor(minutes * 60)) : OPERATOR_DEFAULT_DURATION;
}

export function isOperatorOwner(phone: string | null | undefined, env: Env): boolean {
  const owner = env.OPERATOR_OWNER_NUMBER?.trim();
  return Boolean(owner && E164.test(owner) && phone === owner);
}

export function operatorApprovalRequired(input: OperatorCallPayload, env: Env): boolean {
  return input.initiated_by !== "owner_request" && !isOperatorOwner(input.phone, env);
}
export const E164 = /^\+[1-9]\d{7,14}$/;
export const US_E164 = /^\+1\d{10}$/;

export interface OperatorCallPayload {
  callKind: "operator";
  phone: string;
  purpose: string;
  scenario_id?: string;
  initiated_by: OperatorInitiator;
  language?: string;
  maxDurationSec: number;
}

export function operatorFromProblem(env: Record<string, string | undefined>): string | null {
  const from = env.OPERATOR_LINE_FROM_NUMBER?.trim();
  if (!from) return "OPERATOR_LINE_FROM_NUMBER is not configured";
  if (!E164.test(from)) return "OPERATOR_LINE_FROM_NUMBER must be E.164";
  if (from === SI_ASSISTANT_NUMBER_DEFAULT || from === siAssistantNumber(env)) {
    return "OPERATOR_LINE_FROM_NUMBER must differ from the SI Assistant number";
  }
  return null;
}

export function parseOperatorPayload(raw: unknown, env: Env = process.env):
  | { ok: true; payload: OperatorCallPayload }
  | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("An operator call object is required");
  const body = raw as Record<string, unknown>;
  const keys = new Set(["callKind", "phone", "purpose", "scenario_id", "initiated_by", "requested_by", "language", "maxDurationSec"]);
  if (Object.keys(body).some((key) => !keys.has(key))) return fail("Unknown operator field; patient and ticket fields are not accepted");
  if (body.callKind !== undefined && body.callKind !== "operator") return fail("Invalid callKind");
  if (typeof body.phone !== "string" || !E164.test(body.phone.trim())) return fail("phone must be E.164");
  let purpose = body.purpose;
  if (body.scenario_id !== undefined) {
    if (typeof body.scenario_id !== "string") return fail("scenario_id must be A1 through A10");
    const scenario = lookupOperatorScenario(body.scenario_id);
    if (!scenario) return fail("Unknown scenario_id; expected A1 through A10");
    const goal = operatorScenarioGoal(scenario);
    if (purpose !== undefined && purpose !== goal) return fail("Choose purpose or scenario_id");
    purpose = goal;
  }
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 4000) {
    return fail("purpose must contain 1 to 4000 characters");
  }
  if (body.language !== undefined && (typeof body.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(body.language))) {
    return fail("language must be a language code such as en or es");
  }
  const initiatedBy = body.initiated_by !== undefined ? body.initiated_by : body.requested_by !== undefined ? body.requested_by : "bot_initiative";
  if ((initiatedBy !== "owner_request" && initiatedBy !== "bot_initiative") ||
      (body.initiated_by !== undefined && body.requested_by !== undefined && body.initiated_by !== body.requested_by)) {
    return fail("initiated_by/requested_by must be owner_request or bot_initiative and agree when both are supplied");
  }
  const maximum = operatorMaxDurationSec(env);
  const maxDurationSec = body.maxDurationSec ?? maximum;
  if (typeof maxDurationSec !== "number" || !Number.isInteger(maxDurationSec) || maxDurationSec < 30 || maxDurationSec > maximum) {
    return fail(`maxDurationSec must be an integer from 30 to ${maximum}`);
  }
  return { ok: true, payload: {
    callKind: "operator", phone: body.phone.trim(), purpose: purpose.trim(),
    ...(body.scenario_id ? { scenario_id: body.scenario_id as string } : {}),
    initiated_by: initiatedBy as OperatorInitiator, maxDurationSec,
    ...(body.language ? { language: body.language as string } : {}),
  } };
}

export function isOperatorPayload(payload: Record<string, unknown>): boolean {
  return payload.callKind === "operator";
}

export function isOperatorSmsPayload(payload: Record<string, unknown>): boolean {
  return payload.smsKind === "operator";
}

/** Server-owned lane/from fields cannot be supplied by the bot. */
export function parseOperatorSmsPayload(raw: unknown, env: Env):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("An operator SMS object is required");
  const input = raw as Record<string, unknown>;
  const keys = new Set(["to", "body", "idempotency_key", "initiated_by"]);
  if (Object.keys(input).some((key) => !keys.has(key))) return fail("Unknown operator SMS field");
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim() || input.idempotency_key.length > 200) {
    return fail("idempotency_key must contain 1 to 200 characters");
  }
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const key = dncKey(to);
  if (!key || !/^\+?[\d\s().-]+$/.test(to) || (to.startsWith("+") && !US_E164.test(`+${to.replace(/\D/g, "")}`))) {
    return fail("to must be a valid US phone number");
  }
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 4000) {
    return fail("body must contain 1 to 4000 characters");
  }
  const initiatedBy = input.initiated_by === undefined ? "bot_initiative" : input.initiated_by;
  if (initiatedBy !== "owner_request" && initiatedBy !== "bot_initiative") {
    return fail("initiated_by must be owner_request or bot_initiative");
  }
  return { ok: true, payload: {
    smsKind: "operator", laneSlug: OPERATOR_SLUG, fromNumber: env.OPERATOR_LINE_FROM_NUMBER?.trim(),
    phone: `+1${key}`, body: input.body, initiated_by: initiatedBy,
  } };
}
