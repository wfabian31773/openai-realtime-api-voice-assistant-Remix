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
 * read: a real caller may leave any number. TWILIO_PHONE_NUMBER never counts,
 * even if listed: the old core writes it in place of a dialled number it could
 * not find, and SIP's own From header carries it, on real patients' calls.
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
  const raw = (phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  // Only a number with no country code is assumed to be US: +45 82 34 56 78 is
  // ten digits too, and is not +1 458 234 5678.
  if (digits.length === 10 && !raw.startsWith("+")) return `1${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function isTestLineNumber(phone: string | null | undefined, env: Env = process.env): boolean {
  const target = e164(phone);
  if (!target || target === e164(env.TWILIO_PHONE_NUMBER)) return false;
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

/**
 * The old core's half. Its SIP filing paths hand the ticket client a CallSid and
 * little else, so the mark is what suppresses them. `xCallerPhone` is our own
 * X-CallerPhone header and `dialedNumber` the conference mapping, the caller's
 * and dialled numbers Twilio gave us. SIP's From and To are not passed: they are
 * Twilio's number and the OpenAI project id.
 */
export function markSipTestCall(
  call: { callSid?: string | null; xCallerPhone?: string | null; dialedNumber?: string | null },
  env: Env = process.env,
): boolean {
  if (!call.callSid || !isTestCall({ callerPhone: call.xCallerPhone, dialedNumber: call.dialedNumber }, env)) return false;
  markTestCall(call.callSid);
  return true;
}

/** The number a suppressed filing answers with, so the agent carries on as it would. */
export function testTicketNumber(callSid?: string | null): string {
  return `${TEST_TICKET_PREFIX}${(callSid ?? "").slice(-6).toUpperCase() || "CALL"}`;
}

export function clearTestCallsForTests(): void {
  marks().clear();
}
