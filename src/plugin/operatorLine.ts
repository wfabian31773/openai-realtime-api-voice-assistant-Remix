/** Operator requests have no patient identity or ticket fields. */
import { SI_ASSISTANT_NUMBER_DEFAULT, siAssistantNumber } from "./siAssistantConstants";

export const OPERATOR_SLUG = "wayne-operator";
export const OPERATOR_DEFAULT_DURATION = 600;
export const E164 = /^\+[1-9]\d{7,14}$/;
export const US_E164 = /^\+1\d{10}$/;

export interface OperatorCallPayload {
  callKind: "operator";
  phone: string;
  purpose: string;
  callerScript: string;
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

export function parseOperatorPayload(raw: unknown):
  | { ok: true; payload: OperatorCallPayload }
  | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("An operator call object is required");
  const body = raw as Record<string, unknown>;
  const keys = new Set(["callKind", "phone", "purpose", "callerScript", "language", "maxDurationSec"]);
  if (Object.keys(body).some((key) => !keys.has(key))) return fail("Unknown operator field; patient and ticket fields are not accepted");
  if (body.callKind !== undefined && body.callKind !== "operator") return fail("Invalid callKind");
  if (typeof body.phone !== "string" || !E164.test(body.phone.trim())) return fail("phone must be E.164");
  for (const key of ["purpose", "callerScript"] as const) {
    if (typeof body[key] !== "string" || !body[key].trim() || body[key].length > 4000) {
      return fail(`${key} must contain 1 to 4000 characters`);
    }
  }
  if (body.language !== undefined && (typeof body.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(body.language))) {
    return fail("language must be a language code such as en or es");
  }
  const maxDurationSec = body.maxDurationSec ?? OPERATOR_DEFAULT_DURATION;
  if (typeof maxDurationSec !== "number" || !Number.isInteger(maxDurationSec) || maxDurationSec < 30 || maxDurationSec > 1800) {
    return fail("maxDurationSec must be an integer from 30 to 1800");
  }
  return { ok: true, payload: {
    callKind: "operator", phone: body.phone.trim(), purpose: (body.purpose as string).trim(),
    callerScript: (body.callerScript as string).trim(), maxDurationSec,
    ...(body.language ? { language: body.language as string } : {}),
  } };
}

export function isOperatorPayload(payload: Record<string, unknown>): boolean {
  return payload.callKind === "operator";
}
