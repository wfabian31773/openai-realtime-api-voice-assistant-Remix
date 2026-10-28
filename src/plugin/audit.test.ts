import { describe, expect, it } from "vitest";
import { directCallAuditDetails, sanitizeAuditEntry } from "./audit";

describe("direct-call audit purpose", () => {
  it.each([
    ["Call Will about office hours", "call [redacted] about office hours"],
    ["Ask Price about pickup", "ask [redacted] about pickup"],
    ["Call will about office hours", "call [redacted] about office hours"],
    ["Ask price about pickup", "ask [redacted] about pickup"],
    ["Will Price Hope May", "[redacted] [redacted] [redacted] [redacted]"],
    ["will price hope may", "[redacted] [redacted] [redacted] [redacted]"],
    ["Call Office about Hours", "call [redacted] about [redacted]"],
    ["Call asK about pickup", "call [redacted] about pickup"],
    ["  Ask about office hours  ", "ask about office hours"],
  ])("redacts potential names in %j at both audit boundaries", (purpose, expected) => {
    const details = directCallAuditDetails({ purpose }, "placed");
    expect(details.purpose).toBe(expected);
    // The store boundary must also sanitize entries built without the helper.
    const clean = sanitizeAuditEntry({
      tokenJti: "test-jti", tool: "direct_call", route: "/api/plugin/v1/calls/direct",
      method: "POST", outcome: "committed", httpStatus: 200,
      details: { maskedNumber: "***0111", purpose, reason: "placed" },
    });
    expect(clean.details!.purpose).toBe(expected);
    expect(sanitizeAuditEntry(clean)).toEqual(clean);
  });
});
