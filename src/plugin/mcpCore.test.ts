import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createVoiceFleetMcp, mask, maskString, inCallingWindow } from "../../connectors/voice-fleet-mcp/core.mjs";
import { startStdio } from "../../connectors/voice-fleet-mcp/server.mjs";

const call = (name: string, args?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `voice_fleet_${name}`, arguments: args } });
const create = (getToken = () => "synthetic-bearer") => createVoiceFleetMcp({ baseUrl: "http://127.0.0.1:5000/", getToken });

afterEach(() => vi.restoreAllMocks());

describe("voice fleet MCP core", () => {
  it("retains the masking and calling-window exports used by manual tests", () => {
    expect(maskString("call +1 (909) 555-0113 now")).toBe("call ***-***-0113 now");
    expect(mask({ phone: "9095550113", firstName: "Synthetic", nested: [{ dateOfBirth: "synthetic-dob", note: "synthetic@example.test" }], confirmToken: "synthetic" })).toEqual({ phone: "***-***-0113", firstName: "[redacted]", nested: [{ dateOfBirth: "[redacted]", note: "[email]" }], confirmToken: "[redacted]" });
    expect(mask({ body: "Synthetic private body", name: "Synthetic Person", email: "synthetic@example.test" }, "", true)).toEqual({ body: "[redacted]", name: "[redacted]", email: "[redacted]" });
    expect(maskString(`si.${"a".repeat(32)}.${"b".repeat(64)} ${"c".repeat(64)}`)).toBe("[redacted] [redacted]");
    for (const [time, allowed] of [["2026-10-27T16:00:00Z", true], ["2026-10-27T15:59:00Z", false], ["2026-10-28T03:00:00Z", false], ["2026-11-23T17:00:00Z", true]] as const) expect(inCallingWindow(new Date(time))).toBe(allowed);
  });

  it("returns JSON-RPC validation errors and never sends invalid tool arguments", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const core = create();
    for (const value of [null, [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }]) expect(await core.handleMessage(value)).toMatchObject({ error: { code: -32600 } });
    expect(await core.handleMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: [] })).toMatchObject({ error: { code: -32602 } });
    for (const message of [call("commit"), call("commit_call_live", { approvalId: "synthetic" }), call("live_call_status", { sessionId: "../x" }), call("live_call_instruct", { sessionId: "s1", text: "x".repeat(2001) }), call("health", []), call("health", null)]) expect(await core.handleMessage(message)).toMatchObject({ result: { isError: true } });
    expect(await core.handleMessage(call("unknown"))).toMatchObject({ error: { code: -32602 } });
    expect(await core.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not disclose thrown credentials, upstream bodies, or non-JSON error pages", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Synthetic private body and bearer"));
    const core = create();
    const failed = await core.handleMessage(call("health"));
    expect(JSON.stringify(failed)).not.toContain("Synthetic private");
    expect(failed).toMatchObject({ result: { isError: true } });
    fetch.mockResolvedValueOnce(new Response("Synthetic private HTML", { status: 200 }));
    const nonJson = await core.handleMessage(call("health"));
    expect(nonJson).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(nonJson)).not.toContain("Synthetic private");
  });

  it("reloads the stdio token file for each call, with the original env settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-fleet-mcp-"));
    const tokenFile = join(directory, "bot.token");
    const input = new PassThrough();
    const output = new PassThrough();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"ok":true}'));
    const shell = startStdio(input, output, { VOICE_FLEET_TOKEN_FILE: tokenFile, VOICE_FLEET_BASE_URL: "http://127.0.0.1:54321/", VOICE_FLEET_TIMEOUT_MS: "1000" });
    try {
      for (const digit of ["b", "c"]) {
        const bearer = `si.${"a".repeat(32)}.${digit.repeat(64)}`;
        writeFileSync(tokenFile, bearer);
        const reply = once(output, "data");
        input.write(JSON.stringify(call("health")) + "\n");
        const [line] = await reply;
        expect(JSON.parse(line.toString()).result.isError).toBe(false);
        expect(fetch.mock.lastCall).toMatchObject(["http://127.0.0.1:54321/api/plugin/v1/health", { headers: { Authorization: `Bearer ${bearer}` } }]);
      }
    } finally {
      input.end();
      shell.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
