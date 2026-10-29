import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOperatorInboundNotifier, operatorInboundPayload, operatorInboundSignature } from "./operatorInboundNotifier";
import { MemoryPluginStore, type OperatorInboundCallRecord } from "./store";

const record: OperatorInboundCallRecord = {
  callId: "d02a4484-a48c-4076-9770-1293b3141973", callSid: `CA${"a".repeat(32)}`,
  direction: "inbound", laneSlug: "wayne-operator", callerNumber: "+15555550123", status: "completed",
  startedAt: new Date("2026-10-29T15:00:00Z"), endedAt: new Date("2026-10-29T15:01:12Z"),
  turns: [{ role: "caller", text: "PRIVATE REQUEST TEXT", atMs: 1 }], queuedRequests: [],
  optedOut: true, transcriptUrl: `https://fleet.example/api/plugin/v1/operator-line/inbound/CA${"a".repeat(32)}`,
};
const webhookEnv = { OPERATOR_INBOUND_NOTIFIER: "webhook", OPERATOR_INBOUND_WEBHOOK_URL: "https://bot.example/handoff", OPERATOR_INBOUND_WEBHOOK_SECRET: "synthetic-signing-key" };

describe("operator inbound notifier", () => {
  it.each([undefined, "hmac", "bearer", "both"])("supports webhook auth mode %s without logging secrets", async (mode) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const log = vi.fn();
    await createOperatorInboundNotifier({ ...webhookEnv, ...(mode ? { OPERATOR_INBOUND_WEBHOOK_AUTH: mode } : {}) }, { fetch: request, log })(record);
    const headers = request.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(mode === "hmac" ? undefined : `Bearer ${webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET}`);
    if (mode === "bearer") {
      expect(headers["X-Operator-Signature"]).toBeUndefined();
      expect(headers["X-Operator-Timestamp"]).toBeUndefined();
    } else expect(headers["X-Operator-Signature"]).toBe(operatorInboundSignature(webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET, headers["X-Operator-Timestamp"], request.mock.calls[0][1]!.body as string));
    expect(JSON.stringify(log.mock.calls)).not.toContain(webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET);
  });

  it("never sends SMS bodies, voicemail text, recording URLs or full numbers to a notifier", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const notify = createOperatorInboundNotifier(webhookEnv, { fetch: request, log: vi.fn() });
    await notify({ messageSid: `SM${"a".repeat(32)}`, body: "PRIVATE SMS CONTENT", callerNumber: record.callerNumber,
      receivedAt: record.startedAt, fetchUrl: "https://fleet.example/api/plugin/v1/operator-line/sms/SMabc" });
    await notify({ recordingSid: `RE${"b".repeat(32)}`, callSid: record.callSid, recordingUrl: "https://recording.example/PRIVATE", transcript: "PRIVATE VOICEMAIL CONTENT",
      transcriptionStatus: "completed", receivedAt: record.startedAt, fetchUrl: "https://fleet.example/api/plugin/v1/operator-line/voicemail/REabc" });
    const payloads = request.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads[0]).toEqual({ event: "operator_line.sms_received", event_id: `opline:sms:SM${"a".repeat(32)}`, delivery_attempt: 1, message_sid: `SM${"a".repeat(32)}`,
      message_url: "https://fleet.example/api/plugin/v1/operator-line/sms/SMabc", caller_last4: "0123" });
    expect(payloads[1]).toEqual({ event: "operator_line.voicemail_received", event_id: `opline:vm:RE${"b".repeat(32)}:transcript`, delivery_attempt: 1, call_sid: record.callSid, recording_sid: `RE${"b".repeat(32)}`,
      voicemail_url: "https://fleet.example/api/plugin/v1/operator-line/voicemail/REabc" });
    expect(JSON.stringify(payloads)).not.toMatch(/PRIVATE|15555550123|recording\.example/);
  });

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
      event: "operator_line.inbound_completed", event_id: `opline:${record.callSid}:completed`, delivery_attempt: 1, queued_requests: [], call_id: record.callId, call_sid: record.callSid,
      started_at: "2026-10-29T15:00:00.000Z", ended_at: "2026-10-29T15:01:12.000Z", duration_seconds: 72,
      caller_last4: "0123", opted_out: true, transcript_url: record.transcriptUrl,
    });
    expect(JSON.stringify(operatorInboundPayload(record))).not.toMatch(/PRIVATE|15555550123|requestSummary|turns/);
    const anonymous = operatorInboundPayload({ ...record, callerNumber: null });
    expect("caller_last4" in anonymous && anonymous.caller_last4).toBeNull();
  });

  it("sends signed mid-call request references and the final request list without private content", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const queuedRequests = [
      { id: "11111111-1111-4111-8111-111111111111", text: "PRIVATE patient Jane DOB 1950-01-01 has a diagnosis", createdAt: record.startedAt.toISOString() },
      { id: "22222222-2222-4222-8222-222222222222", text: `PRIVATE call ${record.callerNumber}`, createdAt: record.startedAt.toISOString() },
    ];
    const notify = createOperatorInboundNotifier(webhookEnv, { fetch: request, log: vi.fn() });
    await notify({ ...record, endedAt: null, queuedRequests }, queuedRequests[0].id);
    await notify({ ...record, queuedRequests });
    const payloads = request.mock.calls.map(([, init]) => {
      const raw = init!.body as string;
      const headers = init!.headers as Record<string, string>;
      expect(headers["X-Operator-Signature"]).toBe(operatorInboundSignature(webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET, headers["X-Operator-Timestamp"], raw));
      expect(raw).not.toMatch(/PRIVATE|patient|Jane|1950|diagnosis|15555550123|transcript_text/);
      const payload = JSON.parse(raw);
      expect(payload.caller_last4).toBe("0123");
      return payload;
    });
    expect(payloads[0]).toMatchObject({ event: "operator_line.request_queued", request_id: queuedRequests[0].id, ended_at: null,
      queued_requests: [{ request_id: queuedRequests[0].id, request_url: `${record.transcriptUrl}#request-${queuedRequests[0].id}` }] });
    expect(payloads[1]).toMatchObject({ event: "operator_line.inbound_completed", transcript_url: record.transcriptUrl,
      queued_requests: queuedRequests.map((item) => ({ request_id: item.id, request_url: `${record.transcriptUrl}#request-${item.id}` })) });
  });

  it.each([{}, { OPERATOR_INBOUND_NOTIFIER: "none" }, { OPERATOR_INBOUND_NOTIFIER: "unknown" },
    { OPERATOR_INBOUND_NOTIFIER: "webhook" }, { OPERATOR_INBOUND_NOTIFIER: "github" },
    { ...webhookEnv, OPERATOR_INBOUND_WEBHOOK_SECRET: "" },
    { ...webhookEnv, OPERATOR_INBOUND_WEBHOOK_AUTH: "unknown" },
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
    expect(comment.split("\n")).toEqual([`<!-- operator_line.inbound_completed event_id=opline:${record.callSid}:completed delivery_attempt=1 -->`, record.callId, record.transcriptUrl]);
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

  it("reuses the event ID and claim on timeout retry, signs both attempt numbers and suppresses later deliveries", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryPluginStore();
      const claim = vi.spyOn(store, "claimOperatorNotification");
      const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const notify = createOperatorInboundNotifier(webhookEnv, { fetch: request, store: () => store, timeoutMs: 20, log: vi.fn() });
      const work = notify(record);
      await vi.advanceTimersByTimeAsync(20);
      await work;
      expect(request).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenCalledOnce();
      for (const [index, [, init]] of request.mock.calls.entries()) {
        const payload = JSON.parse(init!.body as string);
        const headers = init!.headers as Record<string, string>;
        expect(payload).toMatchObject({ event_id: `opline:${record.callSid}:completed`, delivery_attempt: index + 1 });
        expect(headers["X-Operator-Event-Id"]).toBe(payload.event_id);
        expect(headers["X-Operator-Signature"]).toBe(operatorInboundSignature(webhookEnv.OPERATOR_INBOUND_WEBHOOK_SECRET, headers["X-Operator-Timestamp"], init!.body as string));
      }
      expect((request.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
      // Even a fresh notifier instance must observe the durable claim.
      const log = vi.fn();
      await createOperatorInboundNotifier(webhookEnv, { fetch: request, store: () => store, log })(record);
      expect(request).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith("[operator-inbound] duplicate suppressed");
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|15555550123/);
    } finally { vi.useRealTimers(); }
  });

  it("claims once across concurrent notify calls", async () => {
    const store = new MemoryPluginStore();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const notify = createOperatorInboundNotifier(webhookEnv, { fetch: request, store: () => store, log: vi.fn() });
    await Promise.all([notify(record), notify(record)]);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["missing", "throw"])("fails open with stable IDs when claim storage is %s", async (mode) => {
    const store = new MemoryPluginStore();
    vi.spyOn(store, "claimOperatorNotification").mockRejectedValue(new Error("PRIVATE database error"));
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const log = vi.fn();
    await createOperatorInboundNotifier(webhookEnv, { fetch: request, store: () => mode === "missing" ? null : store, log })(record);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).event_id).toBe(`opline:${record.callSid}:completed`);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|15555550123/);
  });

  it("uses separate stable IDs for queued requests, completion, SMS and voicemail phases", async () => {
    const store = new MemoryPluginStore();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const notify = createOperatorInboundNotifier(webhookEnv, { fetch: request, store: () => store, log: vi.fn() });
    await notify(record, "request-a");
    await notify(record, "request-a");
    await notify(record, "request-b");
    await notify(record);
    const sms = { messageSid: "SM-synthetic", callerNumber: record.callerNumber, body: "PRIVATE", receivedAt: record.startedAt, fetchUrl: "https://fleet.example/sms" };
    await notify(sms);
    await notify(sms);
    const voicemail = { recordingSid: "RE-synthetic", callSid: record.callSid, recordingUrl: "https://private.example/recording",
      transcript: null, transcriptionStatus: null, receivedAt: record.startedAt, fetchUrl: "https://fleet.example/vm" };
    await notify(voicemail);
    await notify({ ...voicemail, transcript: "PRIVATE", transcriptionStatus: "completed" });
    await notify({ ...voicemail, transcript: "PRIVATE", transcriptionStatus: "completed" });
    expect(request.mock.calls.map(([, init]) => JSON.parse(init!.body as string).event_id)).toEqual([
      `opline:${record.callSid}:request:request-a`, `opline:${record.callSid}:request:request-b`,
      `opline:${record.callSid}:completed`, "opline:sms:SM-synthetic", "opline:vm:RE-synthetic:recording", "opline:vm:RE-synthetic:transcript",
    ]);
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
