import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOperatorInboundNotifier, operatorInboundPayload, operatorInboundSignature } from "./operatorInboundNotifier";
import type { OperatorInboundCallRecord } from "./store";

const record: OperatorInboundCallRecord = {
  callId: "d02a4484-a48c-4076-9770-1293b3141973", callSid: `CA${"a".repeat(32)}`,
  direction: "inbound", laneSlug: "wayne-operator", callerNumber: "+15555550123", status: "completed",
  startedAt: new Date("2026-10-29T15:00:00Z"), endedAt: new Date("2026-10-29T15:01:12Z"),
  turns: [{ role: "caller", text: "PRIVATE REQUEST TEXT", atMs: 1 }], requestSummary: "PRIVATE SUMMARY",
  optedOut: true, transcriptUrl: `https://fleet.example/api/plugin/v1/operator-line/inbound/CA${"a".repeat(32)}`,
};
const webhookEnv = { OPERATOR_INBOUND_NOTIFIER: "webhook", OPERATOR_INBOUND_WEBHOOK_URL: "https://bot.example/handoff", OPERATOR_INBOUND_WEBHOOK_SECRET: "synthetic-signing-key" };

describe("operator inbound notifier", () => {
  it("signs the exact timestamp and raw JSON bytes with HMAC-SHA256", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await createOperatorInboundNotifier(webhookEnv, { fetch: request, now: () => new Date("2026-10-29T15:01:13Z"), log: vi.fn() })(record);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(webhookEnv.OPERATOR_INBOUND_WEBHOOK_URL);
    const timestamp = "1793286073";
    const raw = init!.body as string;
    const expected = `sha256=${createHmac("sha256", webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex")}`;
    expect(init!.headers).toMatchObject({ "X-Operator-Timestamp": timestamp, "X-Operator-Signature": expected });
    expect(operatorInboundSignature("synthetic-signing-key", timestamp, raw + " ")).not.toBe(expected);
    expect(JSON.parse(raw)).toEqual(operatorInboundPayload(record));
  });

  it("uses a strict payload allowlist and sends only the caller's last four digits", () => {
    expect(operatorInboundPayload(record)).toEqual({
      event: "operator_line.inbound_completed", call_id: record.callId, call_sid: record.callSid,
      started_at: "2026-10-29T15:00:00.000Z", ended_at: "2026-10-29T15:01:12.000Z", duration_seconds: 72,
      caller_last4: "0123", opted_out: true, transcript_url: record.transcriptUrl,
    });
    expect(JSON.stringify(operatorInboundPayload(record))).not.toMatch(/PRIVATE|15555550123|requestSummary|turns/);
    expect(operatorInboundPayload({ ...record, callerNumber: null }).caller_last4).toBeNull();
  });

  it.each([{}, { OPERATOR_INBOUND_NOTIFIER: "none" }, { OPERATOR_INBOUND_NOTIFIER: "unknown" },
    { OPERATOR_INBOUND_NOTIFIER: "webhook" }, { OPERATOR_INBOUND_NOTIFIER: "github" },
    { ...webhookEnv, OPERATOR_INBOUND_WEBHOOK_SECRET: "" },
    { ...webhookEnv, OPERATOR_INBOUND_WEBHOOK_URL: "http://bot.example/handoff" },
  ])("defaults to a no-op when disabled or unconfigured (%#)", async (env) => {
    const request = vi.fn<typeof fetch>();
    await createOperatorInboundNotifier(env, { fetch: request })(record);
    expect(request).not.toHaveBeenCalled();
  });

  it("posts a GitHub comment containing exactly the fixed marker, call id and authenticated URL", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    await createOperatorInboundNotifier({ OPERATOR_INBOUND_NOTIFIER: "github", OPERATOR_INBOUND_GITHUB_REPO: "example/bot",
      OPERATOR_INBOUND_GITHUB_ISSUE: "12", OPERATOR_INBOUND_GITHUB_TOKEN: "synthetic-github-token" }, { fetch: request, log: vi.fn() })(record);
    expect(request.mock.calls[0][0]).toBe("https://api.github.com/repos/example/bot/issues/12/comments");
    const comment = JSON.parse(request.mock.calls[0][1]!.body as string).body;
    expect(comment.split("\n")).toEqual(["<!-- operator_line.inbound_completed -->", record.callId, record.transcriptUrl]);
    expect(comment).not.toMatch(/PRIVATE|0123/);
  });

  it("retries once on failure and logs no provider error, transcript or phone", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private: ${record.callerNumber} PRIVATE`));
    const log = vi.fn();
    await expect(createOperatorInboundNotifier(webhookEnv, { fetch: request, log })(record)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("[operator-inbound] notifier=webhook failed after two attempts");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|15555550123/);
  });

  it("recovers on the one retry", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const log = vi.fn();
    await createOperatorInboundNotifier(webhookEnv, { fetch: request, log })(record);
    expect(request).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("[operator-inbound] notifier=webhook delivered");
  });

  it("bounds both attempts even if the transport ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
      const work = createOperatorInboundNotifier(webhookEnv, { fetch: request, timeoutMs: 20, log: vi.fn() })(record);
      await vi.advanceTimersByTimeAsync(40);
      await expect(work).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
      expect((request.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("does not notify an unfinished call", async () => {
    const request = vi.fn<typeof fetch>();
    await createOperatorInboundNotifier(webhookEnv, { fetch: request })({ ...record, endedAt: null });
    expect(request).not.toHaveBeenCalled();
  });
});
