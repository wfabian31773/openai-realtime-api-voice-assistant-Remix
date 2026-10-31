/**
 * TEST CALLS FILE NOTHING (v159).
 *
 * Live test 2026-10-31: the operator line dialled one of our own inbound
 * lines, the inbound agent treated it as a caller, and VA-79092 landed in the
 * real queue under "Unnamed", with a text back to the operator number. A call
 * whose far end or near end is the operator line or a configured test line is
 * a test: it is tagged on its call row and nothing it does may reach the
 * ticketing app, which is what files tickets and texts callers.
 *
 * Only OPERATOR_LINE_FROM_NUMBER and VOICE_TEST_LINE_NUMBERS (comma-separated)
 * count. Both are numbers we own, compared as whole E.164 values, so a patient
 * can never match by accident. A ticket's callback number is deliberately NOT
 * read: a real caller may leave any number.
 *
 * The marks live on globalThis because a dynamic import can evaluate a module
 * twice on Node 20 (the v78/v90/v141 class), and an empty second copy here
 * would file a real ticket for a test call.
 */

type Env = Record<string, string | undefined>;

export const TEST_TICKET_PREFIX = "TEST-";
const MAX_MARKS = 2000;
const MARKS = Symbol.for("azul.voice.testCalls");

function marks(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (holder[MARKS] ??= new Set<string>());
}

function e164(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function isTestLineNumber(phone: string | null | undefined, env: Env = process.env): boolean {
  const target = e164(phone);
  if (!target) return false;
  return [env.OPERATOR_LINE_FROM_NUMBER, ...(env.VOICE_TEST_LINE_NUMBERS ?? "").split(",")]
    .some((line) => e164(line) === target);
}

export function markTestCall(callSid: string): void {
  const set = marks();
  set.add(callSid);
  // Oldest first. Not released at hangup: the post-call sync runs minutes later.
  if (set.size > MAX_MARKS) set.delete(set.values().next().value as string);
}

export function isTestCall(
  call: { callSid?: string | null; callerPhone?: string | null; dialedNumber?: string | null },
  env: Env = process.env,
): boolean {
  return (Boolean(call.callSid) && marks().has(call.callSid!))
    || isTestLineNumber(call.callerPhone, env) || isTestLineNumber(call.dialedNumber, env);
}

/** The number a suppressed filing answers with, so the agent carries on as it would. */
export function testTicketNumber(callSid?: string | null): string {
  return `${TEST_TICKET_PREFIX}${(callSid ?? "").slice(-6).toUpperCase() || "CALL"}`;
}

export function clearTestCallsForTests(): void {
  marks().clear();
}
