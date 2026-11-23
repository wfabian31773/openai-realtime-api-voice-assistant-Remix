#!/usr/bin/env node
// voice-fleet-mcp: zero-dependency stdio MCP server wrapping the voice fleet
// plugin API (/api/plugin/v1/*). Token is read per call and never logged.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const TOKEN_FILE = process.env.VOICE_FLEET_TOKEN_FILE || "/home/box/.secrets/voice-fleet-bot.token";
const BASE = (process.env.VOICE_FLEET_BASE_URL || "https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app").replace(/\/+$/, "");
const TIMEOUT = Number(process.env.VOICE_FLEET_TIMEOUT_MS || 30000);
const V1 = "/api/plugin/v1";

function token() {
  if (/approve/i.test(TOKEN_FILE)) throw new Error("Refusing token file: approve tokens are not allowed in this connector");
  const t = readFileSync(TOKEN_FILE, "utf8").trim();
  if (!/^si\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(t)) throw new Error("Token file does not hold a valid si.<jti>.<secret> token");
  return t;
}

async function call(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(BASE + V1 + path, {
      method,
      headers: { Authorization: `Bearer ${token()}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
    return { status: res.status, ok: res.ok, data };
  } finally { clearTimeout(timer); }
}

const enc = encodeURIComponent;
const obj = (props = {}, required = []) => ({ type: "object", properties: props, required, additionalProperties: true });
// Mirrors Remix src/plugin/operatorLine.ts parseOperatorPayload allowlist. Never send callerScript.
export const OPERATOR_PREPARE_FIELDS = ["callKind", "phone", "purpose", "scenario_id", "initiated_by", "requested_by", "language", "maxDurationSec"];
export function operatorPrepareBody(a = {}) {
  const hasPurpose = typeof a.purpose === "string" && a.purpose.trim() !== "";
  if (!hasPurpose && !a.scenario_id) throw new Error("purpose (1-4000 chars) or scenario_id is required");
  if (hasPurpose && a.purpose.length > 4000) throw new Error("purpose must contain 1 to 4000 characters");
  const body = { phone: a.phone };
  if (hasPurpose) body.purpose = a.purpose;
  for (const k of ["scenario_id", "initiated_by", "language", "maxDurationSec"]) if (a[k] !== undefined && a[k] !== "") body[k] = a[k];
  // Remix v158+ (operatorLine.ts parseOperatorPayload) reads callerScript (<=8000) and openingLine (<=500), camelCase.
  // Accept snake_case aliases from callers; never drop them silently.
  for (const [k, alias, max] of [["callerScript", "caller_script", 8000], ["openingLine", "opening_line", 500]]) {
    const has = (x) => Object.prototype.hasOwnProperty.call(a, x) && a[x] !== undefined;
    if (has(k) && has(alias) && a[k] !== a[alias]) throw new Error(`${k} and ${alias} differ; send one`);
    if (!has(k) && !has(alias)) continue;
    const v = has(k) ? a[k] : a[alias];
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${k} must contain 1 to ${max} characters`);
    body[k] = v;
  }
  return body;
}
const str = (d) => ({ type: "string", description: d });

async function confirmFor(a) {
  if (a.confirmToken) return { token: a.confirmToken };
  if (!a.id) return { error: { status: 400, ok: false, data: { error: "Provide confirmToken or id" } } };
  const r = await call("GET", `/contact_requests/${enc(a.id)}/confirm_token`);
  if (!r.ok) return { error: r };
  return { token: r.data.confirmToken };
}


// Operator-line reads (Remix #402, scope operator:call): SID-validated, PHI-masked output.
const SID = { call: /^CA[0-9a-f]{32}$/, sms: /^(SM|MM)[0-9a-f]{32}$/, rec: /^RE[0-9a-f]{32}$/ };
const CONTENT_KEYS = /^(body|text|transcript|transcription|transcriptionText|content|turns|messages)$/i;
const PHI_KEYS = /^(name|callerName|fromName|firstName|lastName|dob|dateOfBirth|email|subject)$/i;
const URL_KEYS = /^(mediaUrl|mediaUrls|recordingUrl|url|uri|mediaUri)$/i;
const maskPhone = (v) => v.replace(/(?<![\w+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})(?!\w)/g, "***-***-$1");
// includeContent: content fields (and everything nested in them) returned as-is except phone masking.
function mask(v, k = "", inc = false, inContent = false) {
  const isContent = inContent || (inc && CONTENT_KEYS.test(k));
  if (Array.isArray(v)) return v.map((x) => mask(x, k, inc, isContent));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([kk]) => !URL_KEYS.test(kk)).map(([kk, vv]) => [kk, mask(vv, kk, inc, isContent)]));
  if (typeof v !== "string") return v;
  if (isContent) return maskPhone(v);
  if (PHI_KEYS.test(k) || CONTENT_KEYS.test(k)) return v ? `[redacted ${v.length} chars]` : v;
  return maskPhone(v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"));
}
async function sidGet(re, label, sid, path, inc) {
  if (typeof sid !== "string" || !re.test(sid)) return { status: 400, ok: false, data: { error: `Invalid ${label} format` } };
  const r = await call("GET", path + enc(sid));
  return { ...r, data: mask(r.data, "", inc === true) };
}

const TOOLS = [
  ["health", "Fleet plugin health and switch values.", obj(), () => call("GET", "/health")],
  ["list_agents", "List fleet voice agents.", obj(), () => call("GET", "/list_agents")],
  ["agent_health", "Agent switch / env health.", obj(), () => call("GET", "/agent_health")],
  ["fleet_today", "Per-lane counts for a day (YYYY-MM-DD, default today UTC).", obj({ day: str("YYYY-MM-DD") }), (a) => call("GET", `/fleet_today${a.day ? `?day=${enc(a.day)}` : ""}`)],
  ["recent_outcomes", "Recent call outcomes (limit 1-50).", obj({ limit: { type: "integer" } }), (a) => call("GET", `/recent_outcomes${a.limit ? `?limit=${enc(a.limit)}` : ""}`)],
  ["outbound_status", "SI Assistant outbound status.", obj(), () => call("GET", "/outbound_status")],
  ["approval_status", "Status of a prepared contact request by id.", obj({ id: str("Contact request id") }, ["id"]), (a) => call("GET", `/get_contact_request?id=${enc(a.id)}`)],
  ["email_replies", "Recent email replies (ids only).", obj(), () => call("GET", "/email_replies")],
  ["prepare_call", "Prepare an outbound call for human approval (body passed through).", obj(), (a) => call("POST", "/prepare_call", a)],
  ["prepare_text", "Prepare an SMS for human approval (body passed through).", obj(), (a) => call("POST", "/prepare_sms", a)],
  ["prepare_email", "Prepare an email for human approval (body passed through).", obj(), (a) => call("POST", "/prepare_email", a)],
  ["commit", "Commit an approved contact. Give confirmToken, or id to fetch it via the confirm-token hand-off.", obj({ id: str("Contact request id"), confirmToken: str("Confirm token") }),
    async (a) => { const c = await confirmFor(a); return c.error || call("POST", "/commit_contact", { confirmToken: c.token }); }],
  ["cancel", "Cancel a prepared contact request.", obj({ id: str("Contact request id") }, ["id"]), (a) => call("POST", "/cancel_contact", { id: a.id })],
  ["capabilities", "Fleet capability flags.", obj(), () => call("GET", "/capabilities")],
  ["commit_call_live", "Commit an approved call as a live, steerable call. Give confirmToken or id.", obj({ id: str("Contact request id"), confirmToken: str("Confirm token") }),
    async (a) => { const c = await confirmFor(a); return c.error || call("POST", "/commit_call_live", { confirmToken: c.token }); }],
  ["live_call_status", "Live call status and transcript turns after index.", obj({ sessionId: str("Session id"), after: { type: "integer" } }, ["sessionId"]),
    (a) => call("GET", `/live_calls/${enc(a.sessionId)}${a.after !== undefined ? `?after=${enc(a.after)}` : ""}`)],
  ["live_call_instruct", "Send guidance text (1-2000 chars) to a live call.", obj({ sessionId: str("Session id"), text: str("Guidance") }, ["sessionId", "text"]),
    (a) => call("POST", `/live_calls/${enc(a.sessionId)}/instruct`, { text: a.text })],
  ["call_direct", "Open-line call: dial any number now from (909) 555-0113 as a live, steerable call (needs calls:direct). No DOB/approval. Returns sessionId for live_call_status/instruct/end.",
    obj({ phone: str("US 10-digit or +1 E.164 number"), purpose: str("Instructions/persona for the agent (1-4000 chars)"), name: str("Optional recipient name") }, ["phone", "purpose"]),
    (a) => call("POST", "/calls/direct", { phone: a.phone, purpose: a.purpose, ...(a.name ? { name: a.name } : {}) })],
  ["operator_prepare_call", "Operator line: prepare a generic outbound agent call (no patient/ticket fields) for Wayne's human approval. Does not dial. Send purpose OR scenario_id (A1-A10; server fills purpose from the scenario pack). Returns approval id.",
    obj({ phone: str("Target E.164, e.g. +1XXXXXXXXXX"), purpose: str("Call purpose/instructions (1-4000 chars). Omit when scenario_id is set (server rejects a purpose that differs from the scenario goal)."), scenario_id: { type: "string", pattern: "^A([1-9]|10)$", description: "Synthetic test scenario A1-A10 (docs/operator-line/scenarios)" }, callerScript: str("Optional caller script/persona the agent follows (1-8000 chars); its first line is spoken as the opening unless openingLine is set"), openingLine: str("Optional exact first line the agent speaks (1-500 chars)"), initiated_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Optional provenance (default bot_initiative)" }, language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$", description: "Optional language code, e.g. en, es" }, maxDurationSec: { type: "integer", minimum: 30, description: "Hard stop in seconds, >=30 and <= server max (OPERATOR_LINE_MAX_CALL_MINUTES, default 3600)" } }, ["phone"]),
    (a) => call("POST", "/prepare_operator_call", operatorPrepareBody(a))],
  ["operator_commit_call", "Operator line: after Wayne approves, place the call live (steerable). Give id (approval id) or confirmToken. Returns sessionId.", obj({ id: str("Approval id"), confirmToken: str("Confirm token") }),
    async (a) => { const c = await confirmFor(a); return c.error || call("POST", "/commit_call_live", { confirmToken: c.token }); }],
  ["get_transcript", "Full ordered transcript of an operator-line call by sessionId (preparing token only).", obj({ sessionId: str("Session id") }, ["sessionId"]),
    (a) => call("GET", `/calls/${enc(a.sessionId)}/transcript`)],
  ["live_call_end", "End a live call.", obj({ sessionId: str("Session id") }, ["sessionId"]), (a) => call("POST", `/live_calls/${enc(a.sessionId)}/end`, {})],
  ["operator_inbound_get", "Operator line: inbound call record by Twilio CallSid (CA + 32 hex). Needs operator:call. PHI masked unless includeContent.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, callSid: str("Twilio CallSid, CA + 32 hex") }, ["callSid"]),
    (a) => sidGet(SID.call, "callSid", a.callSid, "/operator-line/inbound/", a.includeContent)],
  ["operator_sms_get", "Operator line: inbound SMS/MMS record by MessageSid (SM|MM + 32 hex). Needs operator:call. Body redacted unless includeContent.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, messageSid: str("Twilio MessageSid, SM/MM + 32 hex") }, ["messageSid"]),
    (a) => sidGet(SID.sms, "messageSid", a.messageSid, "/operator-line/sms/", a.includeContent)],
  ["operator_voicemail_get", "Operator line: voicemail record by RecordingSid (RE + 32 hex). Needs operator:call. Transcription redacted unless includeContent; URLs dropped.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, recordingSid: str("Twilio RecordingSid, RE + 32 hex") }, ["recordingSid"]),
    (a) => sidGet(SID.rec, "recordingSid", a.recordingSid, "/operator-line/voicemail/", a.includeContent)],
  ["operator_sms_send", "Operator line: send an SMS from the operator number (no hours window, no caps). To Wayne's cell (OPERATOR_OWNER_NUMBER) it sends immediately; any other number creates a pending approval. Opt-out always blocks. Same idempotency_key sends once. Needs operator:call (Remix operator-line/sms/send).",
    obj({ to: str("Destination US phone number"), body: str("Message text (never logged or echoed)"), idempotency_key: str("1-200 chars, stable per intended text (e.g. call SID + purpose)"), initiated_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Optional provenance" } }, ["to", "body", "idempotency_key"]),
    async (a) => {
      if (typeof a.to !== "string" || !a.to.trim() || typeof a.body !== "string" || !a.body.trim()) return { status: 400, ok: false, data: { error: "to and body are required" } };
      if (typeof a.idempotency_key !== "string" || !a.idempotency_key.trim() || a.idempotency_key.length > 200) return { status: 400, ok: false, data: { error: "idempotency_key must contain 1 to 200 characters" } };
      const r = await call("POST", "/operator-line/sms/send", { to: a.to, body: a.body, idempotency_key: a.idempotency_key, ...(a.initiated_by ? { initiated_by: a.initiated_by } : {}) });
      return { ...r, data: mask(r.data) };
    }],
].map(([n, description, inputSchema, run]) => ({ name: `voice_fleet_${n}`, description, inputSchema, run }));

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "voice-fleet-mcp", version: "3.0.0" } } });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
      try {
        const r = await tool.run(params.arguments || {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: !r.ok } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (e) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message) } }); }
});
