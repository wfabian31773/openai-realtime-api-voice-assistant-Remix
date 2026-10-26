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
import { describe, expect, it, beforeEach } from "vitest";
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

  it("otherwise asks once, then transfers on the next call", () => {
    const first = decideOnCallIdentityAsk(flashes);
    expect(first).toEqual({ transferNow: false, ask: ON_CALL_IDENTITY_ASK });
    const second = decideOnCallIdentityAsk(flashes);
    expect(second).toEqual({ transferNow: true, skipReason: "already_asked" });
  });
});

describe("the ANI is the callback when they gave none", () => {
  it("keeps what they gave", () => {
    expect(onCallCallbackNumber("+15551112222", "+15551234567")).toBe("+15551112222");
  });

  it("falls back to the calling number", () => {
    expect(onCallCallbackNumber(undefined, "+15551234567")).toBe("+15551234567");
    expect(onCallCallbackNumber("  ", "+15551234567")).toBe("+15551234567");
  });
});

describe("usable identity", () => {
  it("rejects the placeholder pair the app used to save", () => {
    expect(hasUsableOnCallName("Unknown", "Caller")).toBe(false);
    expect(hasUsableOnCallName("Dana", "Example")).toBe(true);
    expect(hasUsableOnCallDob("Unknown")).toBe(false);
    expect(hasUsableOnCallDob("01/04/1958")).toBe(true);
  });
});
