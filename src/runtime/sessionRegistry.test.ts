import { describe, it, expect } from "vitest";
import { CallSessionRegistry } from "./sessionRegistry";

function registered(registry: CallSessionRegistry, callSid = "CA1", slug = "optical") {
  return registry.register({
    callSid,
    slug,
    callerPhone: "+15551234567",
    dialedNumber: "+15559876543",
  });
}

describe("the stream gate", () => {
  it("accepts only a callSid this registry issued, with its own token", () => {
    const registry = new CallSessionRegistry();
    const entry = registered(registry);
    expect(registry.claimStream("CA1", entry.streamToken)).not.toBeNull();
  });

  it("refuses a stream for a call the webhook never issued", () => {
    const registry = new CallSessionRegistry();
    expect(registry.claimStream("CA-never-seen", "anything")).toBeNull();
  });

  it("refuses the right call with the wrong token", () => {
    const registry = new CallSessionRegistry();
    registered(registry);
    expect(registry.claimStream("CA1", "wrong-token")).toBeNull();
  });

  it("refuses a SECOND stream for a call that already has one", () => {
    const registry = new CallSessionRegistry();
    const entry = registered(registry);
    expect(registry.claimStream("CA1", entry.streamToken)).not.toBeNull();
    expect(registry.claimStream("CA1", entry.streamToken)).toBeNull();
  });

  it("issues an unguessable token, not a derivation of the callSid", () => {
    const registry = new CallSessionRegistry();
    const a = registered(registry, "CA1");
    const b = registered(registry, "CA2");
    expect(a.streamToken).toMatch(/^[0-9a-f]{32}$/);
    expect(a.streamToken).not.toBe(b.streamToken);
    expect(a.streamToken).not.toContain("CA1");
  });
});

describe("call context", () => {
  it("carries the lane and the caller from the webhook to the bridge", () => {
    const registry = new CallSessionRegistry();
    const entry = registered(registry, "CA1", "surgery");
    expect(entry.slug).toBe("surgery");
    expect(entry.callerPhone).toBe("+15551234567");
    expect(entry.dialedNumber).toBe("+15559876543");
  });

  it("marks nobody verified — it holds context, not identity", () => {
    const entry = registered(new CallSessionRegistry());
    expect(Object.keys(entry)).not.toContain("patientId");
    expect(Object.keys(entry)).not.toContain("verified");
  });
});

describe("outcome recording", () => {
  it("first writer wins, so racing teardowns cannot flip a recorded outcome", () => {
    const registry = new CallSessionRegistry();
    registered(registry);
    registry.recordOutcome("CA1", "caller_hangup");
    registry.recordOutcome("CA1", "provider_failure");
    expect(registry.consumeOutcome("CA1")).toBe("caller_hangup");
  });

  it("is read once and removed — the after-redirect runs exactly once", () => {
    const registry = new CallSessionRegistry();
    registered(registry);
    registry.recordOutcome("CA1", "completed");
    expect(registry.consumeOutcome("CA1")).toBe("completed");
    expect(registry.consumeOutcome("CA1")).toBeNull();
  });

  it("returns null for a call that ended before an outcome was recorded", () => {
    const registry = new CallSessionRegistry();
    registered(registry);
    expect(registry.consumeOutcome("CA1")).toBeNull();
  });

  it("ignores an outcome for a call it never issued", () => {
    const registry = new CallSessionRegistry();
    expect(() => registry.recordOutcome("CA-unknown", "completed")).not.toThrow();
  });
});

describe("expiry", () => {
  it("drops an abandoned entry so a caller who hung up before the stream cannot accumulate", () => {
    let now = 1_000_000;
    const registry = new CallSessionRegistry(60_000, () => now);
    const entry = registered(registry);
    expect(registry.activeCount()).toBe(1);
    now += 60_001;
    expect(registry.activeCount()).toBe(0);
    expect(registry.claimStream("CA1", entry.streamToken)).toBeNull();
  });

  it("keeps a live entry for the whole allowed call", () => {
    let now = 1_000_000;
    const registry = new CallSessionRegistry(30 * 60 * 1000, () => now);
    registered(registry);
    now += 29 * 60 * 1000;
    expect(registry.activeCount()).toBe(1);
  });
});
