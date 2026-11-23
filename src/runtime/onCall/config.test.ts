import { describe, expect, it } from "vitest";
import { onCallHealth, readOnCallConfig, testPhoneFor } from "./config";

const BASE = { TWILIO_PHONE_NUMBER: "+15550000001" };

describe("the on-call switch", () => {
  it("is off unless it is asked for", () => {
    expect(readOnCallConfig({ ...BASE }).mode).toBe("off");
    expect(readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "off" })).toMatchObject({ mode: "off" });
    expect(readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "off" }).disabledBecause).toBeUndefined();
  });

  it("is off, and says why, for a value it does not know", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "production" });
    expect(c.mode).toBe("off");
    expect(c.disabledBecause).toMatch(/not off, test or live/);
  });

  it("reads live with the default caller ID", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: " LIVE " });
    expect(c).toMatchObject({ mode: "live", callerId: "+15550000001", testPhones: [] });
  });

  it("prefers ON_CALL_CALLER_ID and normalises ten digits", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: "555 000 0002" });
    expect(c.callerId).toBe("+15550000002");
  });

  it("is off, and says why, when ON_CALL_CALLER_ID is set and is not a phone number", () => {
    // Review of #514, round 6: falling back to TWILIO_PHONE_NUMBER would ring
    // providers from a number nobody chose for them.
    for (const bad of ["on-call line", "12345", "+1 (555) 000"]) {
      const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: bad });
      expect(c.mode).toBe("off");
      expect(c.disabledBecause).toBe("ON_CALL_CALLER_ID is not a phone number");
    }
    // Blank is unset, and the default stands.
    expect(readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: "  " }).callerId).toBe(
      "+15550000001",
    );
  });

  it("is off with no caller ID at all", () => {
    const c = readOnCallConfig({ ON_CALL_ROTATION_MODE: "live" });
    expect(c.mode).toBe("off");
    expect(c.disabledBecause).toMatch(/caller ID/);
  });

  it("never calls a provider from the Wayne Operator Line, however it is written", () => {
    const c = readOnCallConfig({
      ON_CALL_ROTATION_MODE: "live",
      ON_CALL_CALLER_ID: "+15550000009",
      OPERATOR_LINE_FROM_NUMBER: "(555) 000-0009",
    });
    expect(c.mode).toBe("off");
    expect(c.disabledBecause).toMatch(/Operator Line/);
    const viaDefault = readOnCallConfig({
      ON_CALL_ROTATION_MODE: "test",
      ON_CALL_TEST_PHONES: "+15550100001",
      TWILIO_PHONE_NUMBER: "+15550000009",
      OPERATOR_LINE_FROM_NUMBER: "5550000009",
    });
    expect(viaDefault.mode).toBe("off");
  });

  it("allows a caller ID that is not the operator line", () => {
    const c = readOnCallConfig({
      ...BASE,
      ON_CALL_ROTATION_MODE: "live",
      OPERATOR_LINE_FROM_NUMBER: "+15550000009",
    });
    expect(c.mode).toBe("live");
  });

  it("needs test numbers in test mode, and every one must be a phone number", () => {
    expect(readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "test" }).disabledBecause).toMatch(
      /ON_CALL_TEST_PHONES/,
    );
    expect(
      readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "test", ON_CALL_TEST_PHONES: "+15550100001, 12" }).mode,
    ).toBe("off");
    const c = readOnCallConfig({
      ...BASE,
      ON_CALL_ROTATION_MODE: "test",
      ON_CALL_TEST_PHONES: " 555-010-0001 , +15550100002 ,",
    });
    expect(c).toMatchObject({ mode: "test", testPhones: ["+15550100001", "+15550100002"] });
  });

  it("reads the kept lever only as 1", () => {
    expect(readOnCallConfig({ ...BASE, ON_CALL_POST_OP_REQUIRE_KEPT: "1" }).requireKept).toBe(true);
    expect(readOnCallConfig({ ...BASE, ON_CALL_POST_OP_REQUIRE_KEPT: "true" }).requireKept).toBe(false);
  });
});

describe("test numbers and health", () => {
  it("reuses the last test number for levels past the end of the list", () => {
    const c = { testPhones: ["+15550100001", "+15550100002"] };
    expect([0, 1, 2, 5].map((i) => testPhoneFor(c, i))).toEqual([
      "+15550100001",
      "+15550100002",
      "+15550100002",
      "+15550100002",
    ]);
  });

  it("never puts a phone number on /voice/health", () => {
    const c = readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "test", ON_CALL_TEST_PHONES: "+15550100001" });
    const h = onCallHealth(c);
    expect(h).toEqual({ mode: "test", testPhones: 1, requireKept: false });
    expect(JSON.stringify(h)).not.toMatch(/555/);
  });
});
