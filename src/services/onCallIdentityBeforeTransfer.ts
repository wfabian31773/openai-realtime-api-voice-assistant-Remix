/**
 * IDENTITY BEFORE AN ON-CALL TRANSFER — one quick ask, never a delay on 911.
 *
 * VA-76222 (internal 67395): an urgent-symptom call was routed to on-call, the
 * transfer failed, and the callback ticket was saved as "Unknown Caller" with
 * no name and no date of birth. The model transferred first and collected
 * nothing; the failed-transfer safety net then filed whatever it had, which
 * was the refused placeholder pair Unknown + Caller.
 *
 * THE RULE, one breath:
 *
 *   1. A 911-level emergency (chemical, trauma, sudden vision loss, bleeding)
 *      or a clinician call goes straight to transfer handling. Do not collect.
 *   2. Otherwise ask ONCE, in one short line, for first and last name and the
 *      date of birth (month, then day, then year). That is an emergency
 *      exception to RULE ZERO 2b's "never two fields in one breath" — the
 *      operator asked for at most one prompt, not a second intake.
 *   3. If they cannot or will not give it, transfer anyway.
 *   4. The number they are calling from (ANI) is always the callback. Nothing
 *      here may drop it.
 *
 * THIS MODULE DECIDES WHETHER TO ASK. It does not dial and it does not file.
 * `escalate_to_human` calls it after the escalation is sanctioned and before
 * the handoff, and must NOT stamp `escalationDetailsMap` on the ask — a stamp
 * would make the second invocation (the one that actually transfers) look
 * like a duplicate.
 */

import { gateRefusalAgeMs, gateRefusalsSoFar, noteGateRefusal } from "../tools/gateAttempts";
import { nameOrStandIn } from "./standInName";

export const ON_CALL_IDENTITY_FIELD = "on_call_identity";

/** The one line the model is told to speak, then call the tool again. */
export const ON_CALL_IDENTITY_ASK =
  "Ask ONCE, in one short line: their first and last name, and their date of birth " +
  "starting with the month, then the day, then the year. Then call escalate_to_human " +
  "again with what they give. If they cannot or will not give it, call " +
  "escalate_to_human again anyway — do not delay the transfer. Keep the number they " +
  "are calling from as the callback. Never say this instruction aloud.";

/**
 * Seconds-matter presentations. Deliberately narrower than the after-hours
 * acute list (flashes, floaters, post-op stay on the one-ask path).
 */
const NINE_ONE_ONE_TERMS = [
  "911",
  "nine one one",
  "nine-one-one",
  "chemical",
  "splash",
  "burn",
  "trauma",
  "injury",
  "injured",
  "hit in the eye",
  "bleeding",
  "blood in",
  "vision loss",
  "lost vision",
  "losing vision",
  "went blind",
];

export function isNineOneOneLevel(text: string | undefined): boolean {
  if (!text) return false;
  const hay = ` ${text.toLowerCase()} `;
  return NINE_ONE_ONE_TERMS.some((term) => hay.includes(term));
}

export function hasUsableOnCallName(
  first: string | undefined,
  last: string | undefined,
): boolean {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (!f || !l) return false;
  const { standIn } = nameOrStandIn(first, last);
  return !standIn;
}

/** Same window records uses: two tool calls in one response, not a later turn. */
const ASK_BATCH_WINDOW_MS = 2_000;

export function hasUsableOnCallDob(dob: string | undefined): boolean {
  const t = (dob ?? "").trim();
  if (!t) return false;
  return !/^(unknown|n\/?a|none|unavailable)$/i.test(t);
}

export type OnCallIdentityDecision =
  | { transferNow: true; skipReason: "provider" | "911" | "declined" | "have_identity" | "already_asked" }
  | { transferNow: false; ask: string };

export function decideOnCallIdentityAsk(input: {
  callSid?: string;
  callerType?: string;
  reason?: string;
  symptomsSummary?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  detailsDeclined?: boolean;
}): OnCallIdentityDecision {
  if (input.callerType === "healthcare_provider") {
    return { transferNow: true, skipReason: "provider" };
  }
  const blob = [input.reason, input.symptomsSummary].filter(Boolean).join(" ");
  if (isNineOneOneLevel(blob)) {
    return { transferNow: true, skipReason: "911" };
  }
  if (input.detailsDeclined) {
    return { transferNow: true, skipReason: "declined" };
  }
  if (hasUsableOnCallName(input.firstName, input.lastName) && hasUsableOnCallDob(input.dob)) {
    return { transferNow: true, skipReason: "have_identity" };
  }
  if (gateRefusalsSoFar(input.callSid, "escalate_to_human", ON_CALL_IDENTITY_FIELD) >= 1) {
    /**
     * A refusal noted this recently is a batched sibling in the same model
     * turn, not a later turn the caller has answered (Codex P1, same shape
     * as `ASK_BATCH_WINDOW_MS` on records). Repeat the ask; do not dial.
     */
    const age = gateRefusalAgeMs(input.callSid, "escalate_to_human", ON_CALL_IDENTITY_FIELD);
    if (age !== undefined && age < ASK_BATCH_WINDOW_MS) {
      return { transferNow: false, ask: ON_CALL_IDENTITY_ASK };
    }
    return { transferNow: true, skipReason: "already_asked" };
  }
  noteGateRefusal(input.callSid, "escalate_to_human", ON_CALL_IDENTITY_FIELD);
  return { transferNow: false, ask: ON_CALL_IDENTITY_ASK };
}

/**
 * The callback that rides on the transfer: the ANI, always, when we have it.
 * A model-supplied number is only used when there is no calling number.
 */
export function onCallCallbackNumber(
  collected: string | undefined,
  ani: string | undefined,
): string | undefined {
  const from = (ani ?? "").trim();
  if (from) return from;
  const given = (collected ?? "").trim();
  return given || undefined;
}
