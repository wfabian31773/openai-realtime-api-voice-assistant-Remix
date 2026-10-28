/**
 * IDENTITY BEFORE AN ON-CALL TRANSFER.
 *
 * VA-76222: the transfer went out with no name and no date of birth, then
 * failed, then the callback ticket was "Unknown Caller". These cases are the
 * rule, not a prompt: 911 and a clinician skip the ask; everyone else gets
 * one prompt; a decline still transfers; the ANI is never dropped.
 *
 * Synthetic callers only.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { resetGateAttempts } from "../tools/gateAttempts";
import {
  decideOnCallIdentityAsk,
  hasUsableOnCallDob,
  hasUsableOnCallName,
  isNineOneOneLevel,
  ON_CALL_IDENTITY_ASK,
  onCallCallbackNumber,
} from "./onCallIdentityBeforeTransfer";

const SID = "CA0000000000000000000000000000c622";

beforeEach(() => {
  resetGateAttempts();
});

describe("isNineOneOneLevel", () => {
  it("fires on chemical, trauma, sudden vision loss and bleeding", () => {
    expect(isNineOneOneLevel("chemical splash in the left eye")).toBe(true);
    expect(isNineOneOneLevel("trauma to the eye after a fall")).toBe(true);
    expect(isNineOneOneLevel("sudden vision loss")).toBe(true);
    expect(isNineOneOneLevel("bleeding from the eye")).toBe(true);
  });

  it("does not fire on flashes or a curtain — those still get the one ask", () => {
    expect(isNineOneOneLevel("flashes and floaters since this morning")).toBe(false);
    expect(isNineOneOneLevel("a curtain over the left eye")).toBe(false);
  });

  it.each([
    "flashes, but no vision loss or injury",
    "floaters without bleeding, trauma or vision loss",
    "denies any sudden vision loss, injury, or chemical exposure",
    "no chemical splash or burns; flashes since this morning",
    "no chemical exposure or eye injury; reports floaters",
    "no eye injury and no bleeding",
    "not experiencing any vision loss",
    "hasn't lost vision and has floaters",
    "isn’t bleeding; reports flashes",
    "negative for trauma or injury",
    "no signs of injury or blood in the eye",
  ])("keeps explicitly denied emergencies on the one-ask path: %s", (text) => {
    expect(isNineOneOneLevel(text)).toBe(false);
  });

  it.each([
    "no injury, but sudden vision loss",
    "denies trauma; bleeding from the eye",
    "no vision loss. Chemical splash in the eye",
    "no injury and now losing vision",
    "no injury and the eye is bleeding",
    "no vision loss but bleeding, without trauma",
    "no vision loss or injury, but now vision loss",
    "vision loss without injury",
    "not sure whether this is vision loss",
    "not only flashes but bleeding",
  ])("still skips the ask for an affirmative emergency: %s", (text) => {
    expect(isNineOneOneLevel(text)).toBe(true);
  });
});

describe("decideOnCallIdentityAsk", () => {
  const flashes = {
    callSid: SID,
    callerType: "patient_urgent_medical",
    reason: "Caller reports flashes and a curtain over the left eye",
  };

  it("a clinician goes straight through", () => {
    const d = decideOnCallIdentityAsk({
      callSid: SID,
      callerType: "healthcare_provider",
      reason: "Nurse from the hospital calling about a post-op patient",
    });
    expect(d).toEqual({ transferNow: true, skipReason: "provider" });
  });

  it("a 911-level emergency goes straight through", () => {
    const d = decideOnCallIdentityAsk({
      callSid: SID,
      callerType: "patient_urgent_medical",
      reason: "Patient reports sudden vision loss after a chemical splash",
    });
    expect(d).toEqual({ transferNow: true, skipReason: "911" });
  });

  it("asks for identity when the emergency terms are denied", () => {
    expect(decideOnCallIdentityAsk({
      ...flashes,
      symptomsSummary: "flashes, but no vision loss or injury",
    })).toEqual({ transferNow: false, ask: ON_CALL_IDENTITY_ASK });
  });

  it("does not carry a denial from the reason into an affirmative symptom summary", () => {
    expect(decideOnCallIdentityAsk({
      ...flashes,
      reason: "flashes, no injury",
      symptomsSummary: "vision loss",
    })).toEqual({ transferNow: true, skipReason: "911" });
  });

  it("a decline transfers anyway, without a second ask", () => {
    const d = decideOnCallIdentityAsk({ ...flashes, detailsDeclined: true });
    expect(d).toEqual({ transferNow: true, skipReason: "declined" });
  });

  it("name and date of birth already in hand: transfer now", () => {
    const d = decideOnCallIdentityAsk({
      ...flashes,
      firstName: "Dana",
      lastName: "Example",
      dob: "01/04/1958",
    });
    expect(d).toEqual({ transferNow: true, skipReason: "have_identity" });
  });

  it("otherwise asks once, then transfers on a later turn — not a batched sibling", () => {
    vi.useFakeTimers();
    try {
      const first = decideOnCallIdentityAsk(flashes);
      expect(first).toEqual({ transferNow: false, ask: ON_CALL_IDENTITY_ASK });
      const sibling = decideOnCallIdentityAsk(flashes);
      expect(sibling).toEqual({ transferNow: false, ask: ON_CALL_IDENTITY_ASK });
      vi.advanceTimersByTime(2_000);
      const later = decideOnCallIdentityAsk(flashes);
      expect(later).toEqual({ transferNow: true, skipReason: "already_asked" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a first name alone is not identity — still asks", () => {
    const d = decideOnCallIdentityAsk({ ...flashes, firstName: "Dana", dob: "01/04/1958" });
    expect(d).toEqual({ transferNow: false, ask: ON_CALL_IDENTITY_ASK });
  });
});

describe("the ANI is the authoritative callback", () => {
  it("keeps the calling number even when the model supplied another", () => {
    expect(onCallCallbackNumber("+15551112222", "+15551234567")).toBe("+15551234567");
  });

  it("uses what they gave only when there is no ANI", () => {
    expect(onCallCallbackNumber("+15551112222", undefined)).toBe("+15551112222");
    expect(onCallCallbackNumber(undefined, "+15551234567")).toBe("+15551234567");
    expect(onCallCallbackNumber("  ", "+15551234567")).toBe("+15551234567");
  });
});

describe("usable identity", () => {
  it("rejects the placeholder pair the app used to save", () => {
    expect(hasUsableOnCallName("Unknown", "Caller")).toBe(false);
    expect(hasUsableOnCallName("Dana", "Example")).toBe(true);
    expect(hasUsableOnCallName("Dana", undefined)).toBe(false);
    expect(hasUsableOnCallDob("Unknown")).toBe(false);
    expect(hasUsableOnCallDob("01/04/1958")).toBe(true);
  });
});
