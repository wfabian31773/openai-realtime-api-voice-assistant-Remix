/**
 * Hangup StatusCallback — the 2026-09-15 PCP 15003.
 *
 * Twilio POSTed `/api/voice/status` on every completed PCP inbound and got
 * HTTP 500. call_logs kept the runtime's local duration (stream length)
 * because this webhook never wrote CallDuration. These tests pin the
 * failure modes the inline handler had, and fail if they come back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyTwilioStatusCallback,
  buildStatusCallbackUpdate,
  parseStatusCallbackBody,
  sanitizeInt,
  sanitizeTimestamp,
  twilioDurationFrom,
  type StatusCallbackCallLog,
  type StatusCallbackStorage,
} from "./twilioStatusCallback";

const GROK_ROW: StatusCallbackCallLog = {
  id: "log-pcp-1",
  duration: 40,
  twilioCostCents: null,
  openaiCostCents: 6,
  inputAudioTokens: null,
  voiceProvider: "grok",
  costReconciledAt: null,
  transferredToHuman: false,
};

function completedBody(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: "CA8c66a3d8aaaaaaaaaaaaaaaaaaaaaaaa",
    CallStatus: "completed",
    CallDuration: "347",
    Timestamp: "Tue, 15 Sep 2026 16:33:00 +0000",
    ...over,
  };
}

function storage(over: Partial<StatusCallbackStorage> = {}): StatusCallbackStorage & {
  updates: unknown[];
  hangups: unknown[];
} {
  const updates: unknown[] = [];
  const hangups: unknown[] = [];
  return {
    updates,
    hangups,
    getCallLogBySid: async () => GROK_ROW,
    updateCallLogPreservingReconciledCost: async (_id, update) => {
      updates.push(update);
    },
    updateCallLogHangup: async (_id, update) => {
      hangups.push(update);
    },
    ...over,
  };
}

describe("parseStatusCallbackBody — the 500 that needed no database", () => {
  it("a raw Buffer (what src/server.ts actually delivers) parses", () => {
    const raw = Buffer.from("CallSid=CAabc&CallStatus=completed&CallDuration=347");
    const parsed = parseStatusCallbackBody(raw);
    expect(parsed).toMatchObject({
      CallSid: "CAabc",
      CallStatus: "completed",
      CallDuration: "347",
    });
  });

  it("null is not a parsed body — typeof null is object, and destructuring it 500'd", () => {
    expect(parseStatusCallbackBody(null)).toEqual({ error: "invalid_format" });
  });

  it("undefined is not a parsed body", () => {
    expect(parseStatusCallbackBody(undefined)).toEqual({ error: "invalid_format" });
  });
});

describe("sanitize — Invalid Date and NaN are the cheapest proven 500", () => {
  it("RFC 2822 (Twilio's documented Timestamp) stays a real Date", () => {
    const d = sanitizeTimestamp("Tue, 15 Sep 2026 16:33:00 +0000");
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe("2026-09-15T16:33:00.000Z");
  });

  it("a unix-seconds Timestamp is not Invalid Date", () => {
    // new Date("1694793600") is Invalid Date. The inline handler wrote that.
    expect(Number.isNaN(new Date("1694793600").getTime())).toBe(true);
    const d = sanitizeTimestamp("1694793600");
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe("2023-09-15T16:00:00.000Z");
  });

  it("garbage Timestamp is now(), never Invalid Date", () => {
    const d = sanitizeTimestamp("not-a-date");
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it("parseInt garbage is null, not NaN", () => {
    expect(Number.isNaN(parseInt("abc", 10))).toBe(true);
    expect(sanitizeInt("abc")).toBeNull();
    expect(sanitizeInt("347")).toBe(347);
    expect(sanitizeInt(undefined)).toBeNull();
  });

  it("CallDuration '0' or unreadable is not a Twilio duration", () => {
    expect(twilioDurationFrom("0")).toBeNull();
    expect(twilioDurationFrom("")).toBeNull();
    expect(twilioDurationFrom("abc")).toBeNull();
    expect(twilioDurationFrom("347")).toBe(347);
  });
});

describe("buildStatusCallbackUpdate — a grok PCP hangup after a blind Dial", () => {
  it("Twilio's 347s overwrites the runtime's 40s local duration", () => {
    const { update, twilioDuration } = buildStatusCallbackUpdate({
      parsed: completedBody(),
      callLog: GROK_ROW,
    });
    expect(twilioDuration).toBe(347);
    expect(update.duration).toBe(347);
    expect(update.status).toBe("completed");
    expect(update.twilioStatus).toBe("completed");
    expect(Number.isNaN(update.endTime.getTime())).toBe(false);
    expect(Number.isFinite(update.openaiCostCents)).toBe(true);
    expect(Number.isFinite(update.totalCostCents)).toBe(true);
  });

  it("prices a grok row at the Grok rate, not OpenAI's", () => {
    const { update } = buildStatusCallbackUpdate({
      parsed: completedBody(),
      callLog: GROK_ROW,
    });
    // ceil(347 * 8/60) = ceil(46.266…) = 47
    expect(update.openaiCostCents).toBe(47);
    expect(update.costIsEstimated).toBe(true);
  });

  it("a reconciled grok row keeps the invoice and still takes Twilio's duration", () => {
    const { update } = buildStatusCallbackUpdate({
      parsed: completedBody(),
      callLog: { ...GROK_ROW, costReconciledAt: new Date("2026-09-15T06:00:00Z"), openaiCostCents: 53 },
    });
    expect(update.duration).toBe(347);
    expect(update.openaiCostCents).toBe(53);
    expect(update.costIsEstimated).toBe(false);
  });

  it("MachineDetectionDuration garbage does not become NaN on the update", () => {
    const { update } = buildStatusCallbackUpdate({
      parsed: completedBody({ MachineDetectionDuration: "beep" }),
      callLog: GROK_ROW,
    });
    expect(update.machineDetectionDuration).toBeNull();
  });

  it("in-progress is not silently completed — the default used to be completed", () => {
    const { update } = buildStatusCallbackUpdate({
      parsed: completedBody({ CallStatus: "in-progress", CallDuration: "" }),
      callLog: GROK_ROW,
    });
    expect(update.status).toBe("in_progress");
    expect(update.duration).toBeUndefined();
  });
});

describe("applyTwilioStatusCallback — HTTP 500 is the defect", () => {
  it("a completed grok hangup writes Twilio's duration and returns 200", async () => {
    const s = storage();
    const res = await applyTwilioStatusCallback(completedBody(), { storage: s });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(s.updates[0]).toMatchObject({ duration: 347, twilioStatus: "completed" });
    expect(s.hangups).toEqual([]);
  });

  it("a child-leg SID with no call_logs row is 200, not 500", async () => {
    const s = storage({ getCallLogBySid: async () => undefined });
    const res = await applyTwilioStatusCallback(completedBody({ CallSid: "CAchild" }), {
      storage: s,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Call log not found");
    expect(s.updates).toEqual([]);
  });

  it("when the cost write throws, hangup bookkeeping still lands and the HTTP is 200", async () => {
    const s = storage({
      updateCallLogPreservingReconciledCost: async () => {
        throw new Error('invalid input syntax for type timestamp: "NaN"');
      },
    });
    const res = await applyTwilioStatusCallback(completedBody(), { storage: s });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("status_callback_write_failed");
    expect(s.hangups[0]).toMatchObject({
      duration: 347,
      twilioStatus: "completed",
      status: "completed",
    });
  });

  it("when both writes throw, still 200 — Twilio 15003 is worse than a logged miss", async () => {
    const s = storage({
      updateCallLogPreservingReconciledCost: async () => {
        throw new Error("cost write failed");
      },
      updateCallLogHangup: async () => {
        throw new Error("hangup write failed");
      },
    });
    const res = await applyTwilioStatusCallback(completedBody(), { storage: s });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  it("a lookup throw is 200 with the exception named, not an unhandled 500", async () => {
    const lines: string[] = [];
    const s = storage({
      getCallLogBySid: async () => {
        throw new Error('column "runtime_outcome" does not exist');
      },
    });
    const res = await applyTwilioStatusCallback(completedBody(), {
      storage: s,
      log: (line) => lines.push(line),
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBe("status_callback_failed");
    expect(lines.some((l) => l.includes("runtime_outcome"))).toBe(true);
  });

  it("null body is 400, not a thrown destructure", async () => {
    const res = await applyTwilioStatusCallback(null, { storage: storage() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request format");
  });

  it("the fetch-Twilio-cost failure does not block the duration write", async () => {
    const s = storage();
    const res = await applyTwilioStatusCallback(completedBody(), {
      storage: s,
      fetchTwilioCostCents: async () => {
        throw new Error("twilio 20404");
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(s.updates[0]).toMatchObject({ duration: 347 });
  });
});

describe("the route must not reintroduce HTTP 500", () => {
  const route = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");
  const handler = route.slice(
    route.indexOf("const statusCallbackHandler"),
    route.indexOf("app.post(\"/api/voice/status-callback\""),
  );

  it("the catch answers 200 — 500 is Twilio 15003", () => {
    expect(handler).toMatch(/res\.status\(200\)\.json\(\{ success: false, error: "status_callback_failed" \}\)/);
    expect(handler).not.toMatch(/res\.status\(500\)/);
  });

  it("both URL aliases go through applyTwilioStatusCallback", () => {
    expect(handler).toMatch(/applyTwilioStatusCallback/);
    expect(route).toMatch(/app\.post\("\/api\/voice\/status-callback", statusCallbackHandler\)/);
    expect(route).toMatch(/app\.post\("\/api\/voice\/status", statusCallbackHandler\)/);
  });

  it("the runtime still has no /voice/:slug/status alias — parent hangup is this webhook", () => {
    const runtime = readFileSync(new URL("../runtime/voiceRuntime.ts", import.meta.url), "utf8");
    expect(runtime).not.toMatch(/\/voice\/:slug\/status/);
  });
});
