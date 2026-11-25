/**
 * v273: what xAI puts on `response.done` is kept.
 *
 * Operator, 2026-11-25: "Makes me wonder what else we are not tracking
 * appropriately that is made available from xai." The shapes below are the
 * ones read off a test socket the same day, with synthetic text, and the
 * key names are the ones every `[TOKENS] usage reported` line in the
 * deployment log of 2026-11-24..25 printed: `input_tokens, output_tokens,
 * total_tokens`. Before v273 the reader looked for a text/audio breakdown
 * that never arrives and logged "in 0 ... out 0" on every call, and the
 * top-level `usage` with the audio seconds was never read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { WebSocketGrokTransport, isPingFrame } from "./grokSession";
import {
  CallUsage,
  providerUsageMarker,
  readResponseFacts,
  readUsage,
} from "./tokenUsage";
import { providerUsageEvent } from "./providerUsageTelemetry";
import { toCallLogRow, toConflictUpdate } from "./callRecord";
import { VoiceCallBridge, type BridgeSessionHandlers, type VoiceCallRecord } from "./mediaStreamBridge";

/** The probed shape, verbatim but for the ids. */
function xaiDone(over: { id?: string; status?: string; details?: unknown; input?: number; output?: number; total?: number; audio?: number; billable?: number } = {}) {
  return {
    type: "response.done",
    event_id: "evt_1",
    response_id: over.id ?? "resp_1",
    response: {
      id: over.id ?? "resp_1",
      object: "realtime.response",
      status: over.status ?? "completed",
      status_details: over.details ?? null,
      output: [{ type: "message", id: "item_1", status: "completed" }],
      usage: {
        input_tokens: over.input ?? 0,
        output_tokens: over.output ?? 0,
        total_tokens: over.total ?? 0,
      },
    },
    usage: { output_audio_seconds: over.audio ?? 2.54, billable_audio_seconds: over.billable ?? 1 },
  };
}

describe("reading xAI's response.done", () => {
  it("reads the flat token totals, the audio seconds, the status and the id", () => {
    expect(readResponseFacts(xaiDone({ input: 812, output: 64, total: 876 }))).toEqual({
      responseId: "resp_1",
      status: "completed",
      statusReason: null,
      inputTokens: 812,
      outputTokens: 64,
      totalTokens: 876,
      outputAudioSeconds: 2.54,
      billableAudioSeconds: 1,
    });
  });

  it("reports no text/audio split when xAI sends none, instead of zeros", () => {
    // The defect: this returned all zeros, and the summary line read
    // "in 0 (text 0, audio 0), cached 0 = 0%, out 0" on every call.
    expect(readUsage(xaiDone({ input: 812 }))).toBeNull();
  });

  it("still reads a split when one is sent", () => {
    const u = readUsage({ response: { usage: { input_tokens_details: { text_tokens: 5 } } } });
    expect(u?.inputTextTokens).toBe(5);
  });

  it("reads why a response did not complete", () => {
    expect(
      readResponseFacts(xaiDone({ status: "cancelled", details: { type: "cancelled", reason: "turn_detected" } }))
        .statusReason,
    ).toBe("turn_detected");
    expect(
      readResponseFacts(xaiDone({ status: "failed", details: { type: "failed", error: { code: "server_error" } } }))
        .statusReason,
    ).toBe("server_error");
    expect(readResponseFacts(xaiDone({ status: "incomplete", details: { type: "incomplete" } })).statusReason).toBe(
      "incomplete",
    );
  });

  it("takes the response id from the top level when the response carries none", () => {
    const e = xaiDone();
    delete (e.response as { id?: string }).id;
    expect(readResponseFacts(e).responseId).toBe("resp_1");
  });

  it("reads nothing into a value that is not a count", () => {
    const f = readResponseFacts({
      response: { status: 7, usage: { input_tokens: "lots", output_tokens: -3 } },
      usage: { output_audio_seconds: Number.NaN },
    });
    expect(f).toMatchObject({ status: null, inputTokens: null, outputTokens: null, outputAudioSeconds: null });
  });

  it("reads nothing from an event that is not an object", () => {
    expect(readResponseFacts(undefined)).toMatchObject({ responseId: null, status: null, inputTokens: null });
    expect(readResponseFacts("response.done")).toMatchObject({ status: null });
  });

  it("caps a long provider string", () => {
    expect(readResponseFacts(xaiDone({ id: "r".repeat(500) })).responseId).toHaveLength(100);
  });
});

describe("one call's responses", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("counts a reason only for a response that did not complete", () => {
    const u = new CallUsage();
    u.add(xaiDone({ status: "completed", details: { type: "completed", reason: "done" } }));
    u.add(xaiDone({ status: "incomplete", details: { type: "incomplete", reason: "max_output_tokens" } }));
    expect(u.summary()!.statusReasons).toEqual({ max_output_tokens: 1 });
  });

  it("sums every response, counts the statuses and keeps the last id", () => {
    const u = new CallUsage();
    // billable_audio_seconds is the session's running total (probed
    // 2026-11-25), so three responses ending 1, 8 and 14 seconds in report
    // 1, 8 and 14, and the call was billed 14, not 23.
    u.add(xaiDone({ id: "resp_a", input: 100, output: 10, total: 110, audio: 2.54, billable: 1 }));
    u.add(xaiDone({ id: "resp_b", input: 140, output: 12, total: 152, audio: 1.21, billable: 8 }));
    u.add(
      xaiDone({ id: "resp_c", status: "cancelled", details: { type: "cancelled", reason: "turn_detected" }, audio: 0.3, billable: 14 }),
    );
    expect(u.summary()).toEqual({
      responses: 3,
      statuses: { completed: 2, cancelled: 1 },
      statusReasons: { turn_detected: 1 },
      inputTokens: 240,
      outputTokens: 22,
      totalTokens: 262,
      outputAudioSeconds: 4.05,
      billableAudioSeconds: 14,
      lastResponseId: "resp_c",
    });
    // And the split stays unknown: xAI sent none.
    expect(u.result()).toBeUndefined();
  });

  it("bills each session's running total once, and adds sessions across a reconnect (Codex P1, #522)", () => {
    const u = new CallUsage();
    u.add(xaiDone({ billable: 1 }));
    u.add(xaiDone({ billable: 3 }));
    // The bridge is told of the drop; the new session's total starts again,
    // and its first report is higher than the old session's last.
    u.newSession();
    u.add(xaiDone({ billable: 10 }));
    u.add(xaiDone({ billable: 12 }));
    expect(u.summary()!.billableAudioSeconds).toBe(15);
  });

  it("banks a running total that went down, a new session nobody announced", () => {
    const u = new CallUsage();
    u.add(xaiDone({ billable: 8 }));
    u.add(xaiDone({ billable: 3 }));
    expect(u.summary()!.billableAudioSeconds).toBe(11);
  });

  it("does not count a session twice when it is announced twice", () => {
    const u = new CallUsage();
    u.add(xaiDone({ billable: 5 }));
    u.newSession();
    u.newSession();
    u.add(xaiDone({ billable: 2 }));
    expect(u.summary()!.billableAudioSeconds).toBe(7);
  });

  it("keeps billable null when no session reported it, even after a reconnect", () => {
    const u = new CallUsage();
    u.add({ type: "response.done", response: { id: "r", status: "completed" } });
    u.newSession();
    expect(u.summary()!.billableAudioSeconds).toBeNull();
  });

  it("counts a status whose name is an inherited property like any other (#522 review)", () => {
    const u = new CallUsage();
    u.add(xaiDone({ status: "constructor", details: { reason: "toString" } }));
    u.add(xaiDone({ status: "constructor", details: { reason: "toString" } }));
    u.add(xaiDone({ status: "__proto__", details: { reason: "hasOwnProperty" } }));
    const s = u.summary()!;
    expect(s.statuses.constructor).toBe(2);
    expect(s.statusReasons.toString).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(s.statuses, "__proto__")).toBe(true);
    // As written to the row (an object literal cannot spell an own __proto__).
    expect(JSON.stringify(s.statuses)).toBe('{"constructor":2,"__proto__":1}');
    expect(s.statusReasons.hasOwnProperty).toBe(1);
  });

  it("is undefined when no response finished", () => {
    expect(new CallUsage().summary()).toBeUndefined();
  });

  it("keeps a number never reported as null, not zero", () => {
    const u = new CallUsage();
    u.add({ type: "response.done", response: { id: "r", status: "completed" } });
    expect(u.summary()).toMatchObject({
      responses: 1,
      inputTokens: null,
      outputAudioSeconds: null,
      billableAudioSeconds: null,
    });
  });

  it("counts a response with no status as unknown", () => {
    const u = new CallUsage();
    u.add({ type: "response.done" });
    expect(u.summary()?.statuses).toEqual({ unknown: 1 });
  });

  it("bounds the status keys a call can collect", () => {
    const u = new CallUsage();
    for (let i = 0; i < 40; i += 1) u.add(xaiDone({ status: `odd_${i}`, details: { reason: `why_${i}` } }));
    expect(Object.keys(u.summary()!.statuses)).toHaveLength(12);
    expect(Object.keys(u.summary()!.statusReasons)).toHaveLength(12);
    expect(u.summary()!.responses).toBe(40);
  });

  it("keeps a call's earlier keys counting once the bound is reached", () => {
    const u = new CallUsage();
    for (let i = 0; i < 12; i += 1) u.add(xaiDone({ status: `odd_${i}` }));
    u.add(xaiDone({ status: "odd_0" }));
    expect(u.summary()!.statuses.odd_0).toBe(2);
  });

  it("hands back a copy, so a later response does not change a summary already taken", () => {
    const u = new CallUsage();
    u.add(xaiDone());
    const first = u.summary()!;
    u.add(xaiDone());
    expect(first.responses).toBe(1);
    expect(first.statuses.completed).toBe(1);
  });

  it("prints the whole call on one line", () => {
    const u = new CallUsage();
    u.add(xaiDone({ input: 40, output: 9, total: 49 }));
    const line = providerUsageMarker(u.summary()!);
    expect(line).toContain("1 response(s)");
    expect(line).toContain("in 40 out 9 total 49");
    expect(line).toContain("audio out 2.54s billable 1s");
  });
});

describe("the call_events row", () => {
  it("is not written when no response finished", () => {
    expect(providerUsageEvent(undefined, "caller_hangup")).toBeNull();
  });

  it("carries the summary and the outcome, and warns only on an unusual status", () => {
    const base = {
      responses: 2,
      statuses: { completed: 1, cancelled: 1 },
      statusReasons: { turn_detected: 1 },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      outputAudioSeconds: 3.1,
      billableAudioSeconds: 2,
      lastResponseId: "resp_z",
    };
    const ok = providerUsageEvent(base, "caller_hangup")!;
    expect(ok.level).toBe("info");
    expect(ok.data).toMatchObject({ responses: 2, billableAudioSeconds: 2, lastResponseId: "resp_z", outcome: "caller_hangup" });
    expect(providerUsageEvent({ ...base, statuses: { failed: 1 } }, "provider_failure")!.level).toBe("warn");
  });
});

describe("the call row", () => {
  function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
    return {
      callSid: "CA-x1",
      streamSid: "MZ1",
      slug: "optical",
      callerPhone: "+15550000000",
      dialedNumber: "+15550000001",
      outcome: "caller_hangup",
      transcript: "",
      toolEvents: [],
      agentTurns: 0,
      interruptions: 0,
      startedAtMs: 0,
      endedAtMs: 1000,
      ...over,
    } as VoiceCallRecord;
  }

  it("the teardown write carries the token columns when a split was reported", () => {
    // The row is opened when the call starts, so the teardown write is this
    // update; the token columns were not in it.
    const usage = {
      inputTextTokens: 9,
      inputAudioTokens: 8,
      outputTextTokens: 7,
      outputAudioTokens: 6,
      inputCachedTokens: 5,
      inputCachedTextTokens: 4,
      inputCachedAudioTokens: 1,
    };
    expect(toConflictUpdate(toCallLogRow(record({ usage }), {}))).toMatchObject(usage);
  });

  it("writes only the counters a partial split reported (#522 review)", () => {
    const u = new CallUsage();
    vi.spyOn(console, "info").mockImplementation(() => {});
    u.add({ type: "response.done", response: { usage: { input_token_details: { text_tokens: 7 } } } });
    u.add({ type: "response.done", response: { usage: { output_token_details: { audio_tokens: 3 } } } });
    const usage = u.result()!;
    expect(usage).toEqual({
      inputTextTokens: 7,
      inputAudioTokens: null,
      outputTextTokens: null,
      outputAudioTokens: 3,
      inputCachedTokens: null,
      inputCachedTextTokens: null,
      inputCachedAudioTokens: null,
    });
    const row = toCallLogRow(record({ usage }), {}) as unknown as Record<string, unknown>;
    const update = toConflictUpdate(toCallLogRow(record({ usage }), {})) as Record<string, unknown>;
    for (const written of [row, update]) {
      expect(written.inputTextTokens).toBe(7);
      expect(written.outputAudioTokens).toBe(3);
      for (const key of ["inputAudioTokens", "outputTextTokens", "inputCachedTokens", "inputCachedTextTokens", "inputCachedAudioTokens"]) {
        expect(key in written).toBe(false);
      }
    }
    vi.restoreAllMocks();
  });

  it("reads an empty breakdown as no usage at all (#522 review)", () => {
    expect(readUsage({ response: { usage: { input_token_details: {}, output_token_details: {} } } })).toBeNull();
    expect(readUsage({ response: { usage: { input_token_details: { text_tokens: "lots" } } } })).toBeNull();
  });

  it("the teardown write leaves the token columns alone when no split was reported", () => {
    const update = toConflictUpdate(toCallLogRow(record(), {})) as Record<string, unknown>;
    for (const key of [
      "inputTextTokens",
      "inputAudioTokens",
      "outputTextTokens",
      "outputAudioTokens",
      "inputCachedTokens",
      "inputCachedTextTokens",
      "inputCachedAudioTokens",
    ]) {
      expect(key in update).toBe(false);
    }
  });
});

const wssList: WebSocketServer[] = [];
afterEach(async () => {
  for (const wss of wssList.splice(0)) {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
});

/** A local socket that answers the upgrade with the probed server-timing header. */
async function xaiLike(onConnect: (socket: WebSocket) => void): Promise<string> {
  const wss = new WebSocketServer({ port: 0 });
  wssList.push(wss);
  wss.on("headers", (headers) => {
    headers.push('server-timing: cfCacheStatus;desc="DYNAMIC", cfEdge;dur=12,cfOrigin;dur=97');
  });
  wss.on("connection", onConnect);
  await new Promise<void>((r) => wss.once("listening", () => r()));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`;
}

const XAI_PING = { type: "ping", event_id: "evt_p", timestamp: 1764060000000 };

describe("xAI's pings and the handshake's server-timing reach the close row (v273)", () => {
  it("reads a ping frame as a ping and nothing else as one", () => {
    expect(isPingFrame(JSON.stringify(XAI_PING))).toBe(true);
    expect(isPingFrame(JSON.stringify({ type: "response.done", response: {} }))).toBe(false);
    // An audio delta is large; it is never scanned, even if it mentions a ping.
    const big = JSON.stringify({ type: "response.output_audio.delta", delta: "A".repeat(400) + '"type":"ping"' });
    expect(isPingFrame(big)).toBe(false);
    // A large frame is never counted, even when an object inside it is typed
    // "ping": only xAI's own ~90-character ping events are.
    const nested = JSON.stringify({ type: "conversation.item.added", item: { type: "ping" }, pad: "A".repeat(400) });
    expect(nested).toContain('"type":"ping"');
    expect(isPingFrame(nested)).toBe(false);
  });

  it("reads the top-level type, whatever the spacing, and not a nested one (#522 review)", () => {
    expect(isPingFrame('{ "type" : "ping", "event_id": "evt_p", "timestamp": 1764060000000 }')).toBe(true);
    // Small, and an object inside it is typed "ping": not a ping.
    const smallNested = JSON.stringify({ type: "conversation.item.added", item: { type: "ping" } });
    expect(smallNested.length).toBeLessThan(300);
    expect(isPingFrame(smallNested)).toBe(false);
    expect(isPingFrame('{"type":"ping"')).toBe(false); // not JSON
    expect(isPingFrame("null")).toBe(false);
    expect(isPingFrame('"ping"')).toBe(false);
  });

  it("counts the pings a socket received and how long before the close the last came", async () => {
    const url = await xaiLike((socket) => {
      socket.send(JSON.stringify(XAI_PING));
      socket.send(JSON.stringify(XAI_PING));
      socket.send(JSON.stringify({ type: "session.created", session: { id: "sess_1" } }));
      setTimeout(() => socket.terminate(), 60);
    });
    const t = new WebSocketGrokTransport("key", "model", url);
    const closed = new Promise<void>((r) => t.onClose(() => r()));
    await t.connect();
    await closed;
    const d = t.closeDiagnostics();
    expect(d.pingsReceived).toBe(2);
    expect(d.msSinceServerPing).not.toBeNull();
    expect(d.msSinceServerPing!).toBeGreaterThanOrEqual(0);
    expect(d.serverTiming).toBe('cfCacheStatus;desc="DYNAMIC", cfEdge;dur=12,cfOrigin;dur=97');
  });

  it("reads no ping and no timing on a socket that had neither", () => {
    const d = new WebSocketGrokTransport("key", "model").closeDiagnostics();
    expect(d.pingsReceived).toBe(0);
    expect(d.msSinceServerPing).toBeNull();
    expect(d.serverTiming).toBeNull();
  });

  it("puts the ping count and the last ping on the [SESSION] closed line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await xaiLike((socket) => {
      socket.send(JSON.stringify(XAI_PING));
      setTimeout(() => socket.terminate(), 40);
    });
    const t = new WebSocketGrokTransport("key", "model", url);
    const closed = new Promise<void>((r) => t.onClose(() => r()));
    await t.connect();
    await closed;
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("[SESSION] closed"));
    expect(line).toBeDefined();
    expect(line).toContain("pings=1");
    expect(line).toMatch(/lastPing=\d+ms/);
    log.mockRestore();
    warn.mockRestore();
  });
});

describe("the bridge tells the usage of a reconnect (#522 review)", () => {
  it("adds the dropped session's billable seconds to the new session's", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let handlers!: BridgeSessionHandlers;
    const records: VoiceCallRecord[] = [];
    const session = {
      appendAudio: vi.fn(), cancelResponse: vi.fn(), sendToolResult: vi.fn(),
      requestResponse: vi.fn(), speakNatural: vi.fn(), speak: vi.fn(), close: vi.fn(),
      getResponseEpoch: () => 0, isResponseActive: () => false, setSpokenLanguage: vi.fn(),
    };
    const bridge = new VoiceCallBridge({
      context: { callSid: "CA00000000000000000000000000000273", streamSid: "MZ-test", slug: "no-ivr", callerPhone: "", dialedNumber: "" },
      agent: { instructions: "", tools: [], guardrails: [], toolNames: [], skipped: [],
        dispatch: vi.fn(async () => ({ ok: true, output: '{"success":true}' })) },
      createSession: (h) => { handlers = h; return session; },
      twilio: { sendFrame: vi.fn(), close: vi.fn() },
      onOutcome: vi.fn(),
      persistCallRecord: async (r) => { records.push(r); },
    });
    handlers.onResponseDone(xaiDone({ billable: 3 }));
    handlers.onProviderDrop!();
    // Higher than the old session's last, so only the bridge's word that a
    // new session began keeps the 3 seconds.
    handlers.onResponseDone(xaiDone({ billable: 10 }));
    bridge.handleTwilioFrame({ event: "stop", streamSid: "MZ-test" });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].providerUsage?.billableAudioSeconds).toBe(13);
    vi.restoreAllMocks();
  });
});
