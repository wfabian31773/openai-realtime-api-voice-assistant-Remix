import { describe, expect, it } from "vitest";
import { onCallHealth, readOnCallConfig, rotationCallerId, testPhoneFor } from "./config";

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

  it("is off, and says why, when a test number is the caller ID itself (review of #514, round 14)", () => {
    // Twilio refuses a call from a number to itself.
    for (const [phones, callerId] of [
      ["+15550000001", undefined],
      ["+15550100001, 555 000 0001", undefined],
      ["+15550100001, +15550000002", "555-000-0002"],
    ] as const) {
      const c = readOnCallConfig({
        ...BASE,
        ON_CALL_ROTATION_MODE: "test",
        ON_CALL_TEST_PHONES: phones,
        ...(callerId ? { ON_CALL_CALLER_ID: callerId } : {}),
      });
      expect(c.mode).toBe("off");
      expect(c.disabledBecause).toBe("ON_CALL_TEST_PHONES holds the rotation's own caller ID");
    }
    // Live mode has no test numbers to compare.
    expect(
      readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", ON_CALL_TEST_PHONES: "+15550000001" }).mode,
    ).toBe("live");
  });

  it("is off, and says why, when every transfer is forced blind (review of #514, round 8)", () => {
    for (const blind of ["blind", " BLIND "]) {
      for (const mode of ["test", "live"]) {
        const c = readOnCallConfig({
          ...BASE,
          ON_CALL_ROTATION_MODE: mode,
          ON_CALL_TEST_PHONES: "+15550100001",
          RUNTIME_TRANSFER_MODE: blind,
        });
        expect(c.mode).toBe("off");
        expect(c.disabledBecause).toMatch(/RUNTIME_TRANSFER_MODE=blind/);
        expect(onCallHealth(c).disabledBecause).toMatch(/warm transfer/);
      }
    }
    // warm, unset or anything else leaves the rotation as asked
    for (const other of ["warm", "", undefined, "blind-ish"]) {
      expect(readOnCallConfig({ ...BASE, ON_CALL_ROTATION_MODE: "live", RUNTIME_TRANSFER_MODE: other }).mode).toBe(
        "live",
      );
    }
    // a switch that is off stays off with no reason given
    expect(readOnCallConfig({ ...BASE, RUNTIME_TRANSFER_MODE: "blind" }).disabledBecause).toBeUndefined();
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

describe("the caller ID a switched-off rotation finishes its chains from", () => {
  it("is ON_CALL_CALLER_ID whatever the mode", () => {
    for (const mode of [undefined, "off", "live", "nonsense"]) {
      expect(
        rotationCallerId({ ON_CALL_ROTATION_MODE: mode, ON_CALL_CALLER_ID: "(555) 000-1111", TWILIO_PHONE_NUMBER: "+15550000000" }),
      ).toBe("+15550001111");
    }
  });

  it("falls back to TWILIO_PHONE_NUMBER when ON_CALL_CALLER_ID is unset", () => {
    expect(rotationCallerId({ TWILIO_PHONE_NUMBER: "+15550000000" })).toBe("+15550000000");
    expect(rotationCallerId({ ON_CALL_CALLER_ID: "  ", TWILIO_PHONE_NUMBER: "+15550000000" })).toBe("+15550000000");
  });

  it("is none when ON_CALL_CALLER_ID is mistyped, rather than another number", () => {
    expect(rotationCallerId({ ON_CALL_CALLER_ID: "on-call", TWILIO_PHONE_NUMBER: "+15550000000" })).toBeNull();
  });

  it("is never the Wayne Operator Line", () => {
    expect(rotationCallerId({ TWILIO_PHONE_NUMBER: "+15550009999", OPERATOR_LINE_FROM_NUMBER: "(555) 000-9999" })).toBeNull();
    expect(rotationCallerId({ ON_CALL_CALLER_ID: "+15550009999", OPERATOR_LINE_FROM_NUMBER: "+15550009999" })).toBeNull();
  });

  it("is none with no number at all", () => {
    expect(rotationCallerId({})).toBeNull();
  });

  it("agrees with the running config's caller ID", () => {
    const env = { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: "+15550001111" };
    expect(rotationCallerId(env)).toBe(readOnCallConfig(env).callerId);
  });
});
