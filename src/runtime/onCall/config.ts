/**
 * The on-call switch and its levers, read from the environment.
 *
 *   ON_CALL_ROTATION_MODE   off (default) | test | live
 *     off:  urgent after-hours transfers ring the fixed HUMAN_AGENT_NUMBER as
 *           before, with no retry and no escalation. Nothing here runs.
 *     test: the rotation, the post-op check, the retries and the escalation all
 *           run, and every call and text goes to a number in ON_CALL_TEST_PHONES
 *           instead of the provider's. Tickets are filed as usual, so the whole
 *           flow is visible on a test call (operator, 2026-11-22: "Test calls
 *           should create real tickets and texts so the full flow is visible.
 *           Use test numbers Wayne gives you, never real providers, until he
 *           approves go-live").
 *     live: the rotation's own numbers. Only Wayne sets this.
 *   ON_CALL_TEST_PHONES      comma list, E.164 or 10 digits. Level 1 rings the
 *                            first, level 2 the second, and so on; a list
 *                            shorter than the chain reuses its last number.
 *   ON_CALL_CALLER_ID        the number provider calls and texts come from.
 *                            Defaults to TWILIO_PHONE_NUMBER. Refused when it
 *                            is the Wayne Operator Line (OPERATOR_LINE_FROM_
 *                            NUMBER): "Never use the Wayne Operator Line
 *                            number as caller ID for provider calls."
 *   ON_CALL_POST_OP_REQUIRE_KEPT=1
 *                            a booked surgery not yet marked kept in NextGen
 *                            routes to on-call instead of the surgeon.
 *
 * Any lever that cannot be honoured turns the whole thing OFF and says why,
 * rather than ringing a number nobody chose.
 */
import { toE164 } from "../../services/handoffPolicy";

export type OnCallRotationMode = "off" | "test" | "live";

export interface OnCallConfig {
  mode: OnCallRotationMode;
  /** E.164; test mode only. */
  testPhones: string[];
  /** E.164, never the operator line. Empty when mode is off. */
  callerId: string;
  requireKept: boolean;
  /** Why mode was forced off, when it was. */
  disabledBecause?: string;
}

type Env = Record<string, string | undefined>;

function e164(raw: string | undefined): string | null {
  const v = toE164(raw);
  if (!v) return null;
  return /^\+\d{10,15}$/.test(v) ? v : null;
}

export function readOnCallConfig(env: Env = process.env): OnCallConfig {
  const asked = (env.ON_CALL_ROTATION_MODE ?? "").trim().toLowerCase();
  const requireKept = (env.ON_CALL_POST_OP_REQUIRE_KEPT ?? "").trim() === "1";
  const off = (disabledBecause?: string): OnCallConfig => ({
    mode: "off",
    testPhones: [],
    callerId: "",
    requireKept,
    ...(disabledBecause ? { disabledBecause } : {}),
  });

  if (asked !== "test" && asked !== "live") {
    return asked === "" || asked === "off" ? off() : off(`ON_CALL_ROTATION_MODE="${asked}" is not off, test or live`);
  }

  const callerId = e164(env.ON_CALL_CALLER_ID) ?? e164(env.TWILIO_PHONE_NUMBER);
  if (!callerId) return off("no caller ID: set ON_CALL_CALLER_ID or TWILIO_PHONE_NUMBER");
  const operator = e164(env.OPERATOR_LINE_FROM_NUMBER);
  if (operator && operator === callerId) {
    return off("the caller ID is the Wayne Operator Line, which is never used for provider calls");
  }

  if (asked === "live") return { mode: "live", testPhones: [], callerId, requireKept };

  const raw = (env.ON_CALL_TEST_PHONES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const testPhones = raw.map(e164);
  if (testPhones.length === 0) return off("test mode needs ON_CALL_TEST_PHONES");
  if (testPhones.some((p) => p === null)) return off("ON_CALL_TEST_PHONES holds a number that is not a phone number");
  return { mode: "test", testPhones: testPhones as string[], callerId, requireKept };
}

/** The number level `index` rings in test mode. */
export function testPhoneFor(config: Pick<OnCallConfig, "testPhones">, index: number): string {
  const list = config.testPhones;
  return list[Math.min(index, list.length - 1)];
}

/** For /voice/health: what is running, never a phone number. */
export function onCallHealth(config: OnCallConfig): {
  mode: OnCallRotationMode;
  testPhones: number;
  requireKept: boolean;
  disabledBecause?: string;
} {
  return {
    mode: config.mode,
    testPhones: config.testPhones.length,
    requireKept: config.requireKept,
    ...(config.disabledBecause ? { disabledBecause: config.disabledBecause } : {}),
  };
}
