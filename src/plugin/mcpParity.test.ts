import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceFleetMcp } from "../../connectors/voice-fleet-mcp/core.mjs";
import { parseOperatorPayload } from "./operatorLine";

const baseUrl = "https://fleet.example.test";
const confirmToken = "a".repeat(64);
const phone = "+19095550113";
type Args = Record<string, unknown>;
type OriginalTool = { name: string; inputSchema: { properties: Args; required: string[] }; run(args: Args): Promise<{ ok: boolean }> };

// Exact `git show b7f9b822:connectors/voice-fleet-mcp/server.mjs` fixture.
// Evaluate the original handlers unchanged, excluding only imports/exports and
// the stdio listener. No token files, sockets, network, or git history needed.
const source = readFileSync(new URL("../../connectors/voice-fleet-mcp/fixtures/server-b7f9b822.txt", import.meta.url), "utf8");
const originalTools: OriginalTool[] = runInNewContext(
  source.slice(0, source.indexOf("const send ="))
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "") + "\nTOOLS;",
  {
    process: { env: { VOICE_FLEET_BASE_URL: baseUrl } },
    readFileSync: () => `si.${"b".repeat(32)}.${"c".repeat(64)}`,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    AbortController, setTimeout, clearTimeout,
  },
);
const toolName = (name: string) => `voice_fleet_${name}`;
const original = (name: string) => originalTools.find((tool) => tool.name === toolName(name))!;
const core = createVoiceFleetMcp({ baseUrl, getToken: () => "synthetic-bearer" });
async function invoke(name: string, args: Args) {
  const reply = await core.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName(name), arguments: args } });
  if (!reply || !("result" in reply)) throw new Error("Expected a tool result");
  return reply.result;
}

async function invokeOriginal(name: string, args: Args) {
  // Mirror the original stdio tools/call result formatting, including local errors.
  try {
    const result = await original(name).run(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.ok };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

const inputs: Record<string, Args> = {
  health: {}, list_agents: {}, agent_health: {},
  fleet_today: { day: "2026-11-23" }, recent_outcomes: { limit: 5 },
  outbound_status: {}, approval_status: { id: "approval_1" }, email_replies: {},
  prepare_call: { phone, purpose: "Synthetic purpose" },
  prepare_text: { phone, body: "Synthetic text" },
  prepare_email: { email: "synthetic@example.test", subject: "Synthetic subject", body: "Synthetic email" },
  commit: { id: "approval_1" }, cancel: { id: "approval_1" }, capabilities: {},
  commit_call_live: { id: "approval_1" },
  live_call_status: { sessionId: "session_1", after: 0 },
  live_call_instruct: { sessionId: "session_1", text: "Synthetic guidance" },
  call_direct: { phone, purpose: "Synthetic purpose", name: "Synthetic Person" },
  operator_prepare_call: { phone, purpose: "Synthetic purpose", callerScript: "Synthetic script", openingLine: "Synthetic opening", scenario_id: "A1", initiated_by: "owner_request", language: "en", maxDurationSec: 120 },
  operator_commit_call: { id: "approval_1" }, get_transcript: { sessionId: "session_1" },
  live_call_end: { sessionId: "session_1" },
  operator_inbound_get: { callSid: "CA" + "a".repeat(32), includeContent: true },
  operator_sms_get: { messageSid: "SM" + "a".repeat(32), includeContent: true },
  operator_voicemail_get: { recordingSid: "RE" + "a".repeat(32), includeContent: true },
  operator_sms_send: { to: phone, body: "Synthetic text", idempotency_key: "synthetic:key", initiated_by: "owner_request" },
};

type WireRequest = { method?: string; path: string; body?: string | null };
async function capture(run: () => Promise<unknown>, reply: unknown = { confirmToken, status: "synthetic" }, status = 200) {
  const requests: WireRequest[] = [];
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    requests.push({ method: options?.method, path: String(url).slice(baseUrl.length), body: options?.body as string | undefined });
    return Response.json(reply, { status });
  });
  try {
    return { requests, result: await run() };
  } finally {
    mock.mockRestore();
  }
}

async function parity(name: string, args: Args, reply?: unknown, status?: number) {
  const expected = await capture(() => invokeOriginal(name, structuredClone(args)), reply, status);
  const actual = await capture(() => invoke(name, structuredClone(args)), reply, status);
  expect(actual, `${name}: ${JSON.stringify(args)}`).toEqual(expected);
  return actual.requests;
}

afterEach(() => vi.restoreAllMocks());

describe("voice fleet request parity with b7f9b822 (socket-free)", () => {
  // Intentional exception: operator_prepare_call now forwards requested_by
  // unchanged and advertises it in tools/list; all other parity stays exact.
  it("covers every tool in the original and current catalogs", async () => {
    const names = Object.keys(inputs).map(toolName).sort();
    expect(names).toEqual(originalTools.map((tool) => tool.name).sort());
    const listed = await core.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((listed as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name).sort()).toEqual(names);
  });

  for (const [name, args] of Object.entries(inputs)) {
    it(`${name}: valid, omitted/empty optional fields, extras and snake/camel fields`, async () => {
      expect((await parity(name, args)).length).toBeGreaterThan(0);
      const { properties, required } = original(name).inputSchema;
      for (const key of Object.keys(properties).filter((key) => !required.includes(key))) {
        for (const value of [undefined, "", null, false, 0]) await parity(name, { ...args, [key]: value });
      }
      // Extra fields must not be schema-validated or affect allowlisted bodies.
      await parity(name, { ...args, extra: { arbitrary: ["", null] }, unused_field: "snake", unusedField: "camel" });
      for (const key of ["id", "sessionId"]) {
        if (key in properties) continue;
        for (const value of ["", null, "../synthetic/path?x=1"]) await parity(name, { ...args, [key]: value });
      }
      const aliases = Object.fromEntries(Object.entries(args).map(([key, value]) => [
        key.includes("_") ? key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value,
      ]));
      await parity(name, { ...args, ...aliases });
      await parity(name, aliases);
    });
  }

  it("normalizes operator empty strings before validation and preserves reference nulls", async () => {
    for (const key of ["language", "initiated_by", "scenario_id", "maxDurationSec"]) {
      for (const value of ["", null]) {
        const requests = await parity("operator_prepare_call", { phone, purpose: "Synthetic purpose", [key]: value });
        expect(requests).toEqual([{ method: "POST", path: "/api/plugin/v1/prepare_operator_call", body: JSON.stringify({ phone, purpose: "Synthetic purpose", ...(value === null ? { [key]: null } : {}) }) }]);
      }
    }
    await parity("operator_prepare_call", { phone, scenario_id: "A3", purpose: " " });
    for (const script of [
      { caller_script: "Synthetic script", opening_line: "Synthetic opening" },
      { callerScript: "Same", caller_script: "Same", openingLine: "Same", opening_line: "Same" },
      { callerScript: "Different", caller_script: "Conflict" },
      { callerScript: undefined, caller_script: "Synthetic script" },
      { openingLine: "", opening_line: "Conflict" },
    ]) await parity("operator_prepare_call", { phone, purpose: "Synthetic purpose", ...script });
  });

  it("intentionally forwards requested_by as-is so the fleet records provenance and rejects conflicts", async () => {
    const cases: Array<[Args, string | null]> = [
      [{ requested_by: "owner_request" }, "owner_request"],
      [{ requested_by: "bot_initiative" }, "bot_initiative"],
      [{ initiated_by: "owner_request", requested_by: "owner_request" }, "owner_request"],
      [{ initiated_by: "bot_initiative", requested_by: "owner_request" }, null],
      [{ initiated_by: "owner_request", requested_by: "bot_initiative" }, null],
      ...["", null, false, 0, {}, [], " owner_request "].map((requested_by): [Args, null] => [{ requested_by }, null]),
    ];
    for (const [fields, initiator] of cases) {
      const args = { phone, purpose: "Synthetic purpose", ...fields };
      const expected = await capture(() => invokeOriginal("operator_prepare_call", args));
      const actual = await capture(() => invoke("operator_prepare_call", args));
      expect(actual).toEqual({ ...expected, requests: expected.requests.map((request) => ({
        ...request, body: JSON.stringify({ ...JSON.parse(request.body!), requested_by: fields.requested_by }),
      })) });
      const parsed = parseOperatorPayload(JSON.parse(actual.requests[0].body!), {});
      if (initiator) expect(parsed).toMatchObject({ ok: true, payload: { initiated_by: initiator } });
      else expect(parsed).toMatchObject({ ok: false, error: "initiated_by/requested_by must be owner_request or bot_initiative and agree when both are supplied" });
    }
  });

  for (const name of ["commit", "commit_call_live", "operator_commit_call"]) {
    it(`${name}: confirmToken takes precedence over any unused hand-off id`, async () => {
      for (const id of [undefined, "", null, 123, false, {}, "../unused/path"]) {
        const requests = await parity(name, { confirmToken, id });
        expect(requests).toEqual([{ method: "POST", path: `/api/plugin/v1/${name === "commit" ? "commit_contact" : "commit_call_live"}`, body: JSON.stringify({ confirmToken }) }]);
      }
      for (const id of ["approval_1", "space / ? & #", "..", 123]) await parity(name, { id });
      await parity(name, {});
      await parity(name, { approvalId: "unsupported-alias" });
      await parity(name, { id: "approval_1" }, { error: "Synthetic refusal" }, 403);
      await parity(name, { id: "approval_1" }, {});
    });
  }

  it("leaves fleet validation of encoded ids, query values and guidance unchanged", async () => {
    for (const name of ["approval_status", "cancel", "live_call_status", "live_call_instruct", "live_call_end", "get_transcript"]) {
      const key = name === "approval_status" || name === "cancel" ? "id" : "sessionId";
      for (const value of ["", null, "space / ? & #", "../synthetic/path", 123]) await parity(name, { ...inputs[name], [key]: value });
    }
    for (const text of ["", " ", "x".repeat(2001)]) await parity("live_call_instruct", { sessionId: "session_1", text });
    await parity("fleet_today", { day: "space / ? & #" });
    await parity("recent_outcomes", { limit: "5" });
    await parity("live_call_status", { sessionId: "session_1", after: "2" });
  });
});
