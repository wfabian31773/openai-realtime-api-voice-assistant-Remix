// Shared, zero-dependency MCP implementation. Transports own I/O and credentials.
const V1 = "/api/plugin/v1";
class InputError extends Error {}

const enc = encodeURIComponent;
const obj = (props = {}, required = []) => ({ type: "object", properties: props, required, additionalProperties: true });
// Mirrors Remix src/plugin/operatorLine.ts; snake_case script aliases are normalized.
export const OPERATOR_PREPARE_FIELDS = ["callKind", "phone", "purpose", "callerScript", "openingLine", "scenario_id", "initiated_by", "requested_by", "language", "maxDurationSec"];
export function operatorPrepareBody(a = {}) {
  const hasPurpose = typeof a.purpose === "string" && a.purpose.trim() !== "";
  if (!hasPurpose && !a.scenario_id) throw new InputError("purpose (1-4000 chars) or scenario_id is required");
  if (hasPurpose && a.purpose.length > 4000) throw new InputError("purpose must contain 1 to 4000 characters");
  const body = { phone: a.phone };
  if (hasPurpose) body.purpose = a.purpose;
  for (const k of ["scenario_id", "initiated_by", "language", "maxDurationSec"]) if (a[k] !== undefined && a[k] !== "") body[k] = a[k];
  // Remix v158+ (operatorLine.ts parseOperatorPayload) reads callerScript (<=8000) and openingLine (<=500), camelCase.
  // Accept snake_case aliases from callers; never drop them silently.
  for (const [k, alias, max] of [["callerScript", "caller_script", 8000], ["openingLine", "opening_line", 500]]) {
    const has = (x) => Object.prototype.hasOwnProperty.call(a, x) && a[x] !== undefined;
    if (has(k) && has(alias) && a[k] !== a[alias]) throw new InputError(`${k} and ${alias} differ; send one`);
    if (!has(k) && !has(alias)) continue;
    const v = has(k) ? a[k] : a[alias];
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new InputError(`${k} must contain 1 to ${max} characters`);
    body[k] = v;
  }
  return body;
}
const str = (d) => ({ type: "string", description: d });

const SID = { call: /^CA[0-9a-f]{32}$/, sms: /^(SM|MM)[0-9a-f]{32}$/, rec: /^RE[0-9a-f]{32}$/ };
const CONTENT_KEYS = /^(body|text|transcript|transcription|transcriptionText|content|turns|messages|purpose|callerScript|openingLine)$/i;
const PHI_KEYS = /^(.*name|dob|date_?of_?birth|birth(Month|Day|Year)|email|subject|.*token|secret|authorization)$/i;
const URL_KEYS = /^(mediaUrl|mediaUrls|recordingUrl|url|uri|mediaUri)$/i;

export function maskString(value) {
  return value
    .replace(/\bsi\.[a-f0-9]{32}\.[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(?<![\w+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})(?!\w)/g, "***-***-$1");
}

// The legacy includeContent argument is accepted but cannot bypass redaction.
export function mask(value, key = "", _includeContent = false) {
  if (URL_KEYS.test(key)) return undefined;
  if (PHI_KEYS.test(key) || CONTENT_KEYS.test(key)) {
    return value == null || value === "" ? value : "[redacted]";
  }
  if (Array.isArray(value)) return value.map((item) => mask(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !URL_KEYS.test(k))
      .map(([k, v]) => [k, mask(v, k)]));
  }
  return typeof value === "string" ? maskString(value) : value;
}

// Informational helper; the fleet API remains authoritative for hours/holidays.
export function inCallingWindow(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
  }).format(now));
  return hour >= 9 && hour < 20;
}

export function createVoiceFleetMcp({ baseUrl, getToken, timeoutMs = 30000 }) {
  const base = baseUrl.replace(/\/+$/, "");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");

  async function call(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(base + V1 + path, {
        method,
        headers: { Authorization: `Bearer ${await getToken()}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        redirect: "error",
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { return { status: res.status, ok: false, data: { error: "Fleet returned a non-JSON response" } }; }
      return { status: res.status, ok: res.ok, data };
    } finally { clearTimeout(timer); }
  }

  async function confirmFor(a) {
    if (a.confirmToken) return { token: a.confirmToken };
    if (!a.id) throw new InputError("Provide confirmToken or id");
    const r = await call("GET", `/contact_requests/${enc(a.id)}/confirm_token`);
    if (!r.ok) return { error: r };
    if (typeof r.data.confirmToken !== "string" || !r.data.confirmToken) throw new InputError("Confirmation token is unavailable");
    return { token: r.data.confirmToken };
  }

  async function sidGet(re, label, sid, path) {
    if (typeof sid !== "string" || !re.test(sid)) throw new InputError(`Invalid ${label} format`);
    return call("GET", path + enc(sid));
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
    ["operator_inbound_get", "Operator line: inbound call record by Twilio CallSid (CA + 32 hex). Needs operator:call. Sensitive content is always redacted.", obj({ includeContent: { type: "boolean", description: "Legacy flag accepted for compatibility; sensitive content is always redacted" }, callSid: str("Twilio CallSid, CA + 32 hex") }, ["callSid"]),
      (a) => sidGet(SID.call, "callSid", a.callSid, "/operator-line/inbound/")],
    ["operator_sms_get", "Operator line: inbound SMS/MMS record by MessageSid (SM|MM + 32 hex). Needs operator:call. Body is always redacted.", obj({ includeContent: { type: "boolean", description: "Legacy flag accepted for compatibility; sensitive content is always redacted" }, messageSid: str("Twilio MessageSid, SM/MM + 32 hex") }, ["messageSid"]),
      (a) => sidGet(SID.sms, "messageSid", a.messageSid, "/operator-line/sms/")],
    ["operator_voicemail_get", "Operator line: voicemail record by RecordingSid (RE + 32 hex). Needs operator:call. Transcription always redacted; URLs dropped.", obj({ includeContent: { type: "boolean", description: "Legacy flag accepted for compatibility; sensitive content is always redacted" }, recordingSid: str("Twilio RecordingSid, RE + 32 hex") }, ["recordingSid"]),
      (a) => sidGet(SID.rec, "recordingSid", a.recordingSid, "/operator-line/voicemail/")],
    ["operator_sms_send", "Operator line: send an SMS from the operator number (no hours window, no caps). To Wayne's cell (OPERATOR_OWNER_NUMBER) it sends immediately; any other number creates a pending approval. Opt-out always blocks. Same idempotency_key sends once. Needs operator:call (Remix operator-line/sms/send).",
      obj({ to: str("Destination US phone number"), body: str("Message text (never logged or echoed)"), idempotency_key: str("1-200 chars, stable per intended text (e.g. call SID + purpose)"), initiated_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Optional provenance" } }, ["to", "body", "idempotency_key"]),
      async (a) => {
        if (typeof a.to !== "string" || !a.to.trim() || typeof a.body !== "string" || !a.body.trim()) return { status: 400, ok: false, data: { error: "to and body are required" } };
        if (typeof a.idempotency_key !== "string" || !a.idempotency_key.trim() || a.idempotency_key.length > 200) return { status: 400, ok: false, data: { error: "idempotency_key must contain 1 to 200 characters" } };
        return call("POST", "/operator-line/sms/send", { to: a.to, body: a.body, idempotency_key: a.idempotency_key, ...(a.initiated_by ? { initiated_by: a.initiated_by } : {}) });
      }],
  ].map(([n, description, inputSchema, run]) => ({ name: `voice_fleet_${n}`, description, inputSchema, run }));

  function validateArguments(tool, args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new InputError("arguments must be an object");
    for (const key of tool.inputSchema.required) {
      if (args[key] === undefined) throw new InputError(`${key} is required`);
    }
    for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
      const value = args[key];
      if (value === undefined) continue;
      if (spec.type === "integer" ? !Number.isInteger(value) : typeof value !== spec.type) throw new InputError(`Invalid ${key} type`);
      if (spec.enum && !spec.enum.includes(value)) throw new InputError(`Invalid ${key}`);
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new InputError(`Invalid ${key} format`);
      if (spec.minimum !== undefined && value < spec.minimum) throw new InputError(`Invalid ${key} range`);
    }
    for (const key of ["id", "sessionId"]) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(args[key]))) throw new InputError(`Invalid ${key} format`);
    }
    if (tool.name === "voice_fleet_live_call_instruct" && (!args.text.trim() || args.text.length > 2000)) throw new InputError("text must contain 1 to 2000 characters");
    if (["voice_fleet_commit", "voice_fleet_commit_call_live", "voice_fleet_operator_commit_call"].includes(tool.name) && !args.id && !args.confirmToken) throw new InputError("Provide confirmToken or id");
  }

  const liveTools = new Set(["commit_call_live", "operator_commit_call", "live_call_status", "live_call_instruct", "live_call_end"].map((name) => `voice_fleet_${name}`));
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" ||
        (Object.hasOwn(msg, "id") && msg.id !== null && typeof msg.id !== "string" && !(typeof msg.id === "number" && Number.isFinite(msg.id)))) {
      return rpcError(null, -32600, "Invalid Request");
    }
    // MCP notifications never produce a reply or trigger tools.
    if (!Object.hasOwn(msg, "id")) return null;
    const { id, method, params } = msg;
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) return rpcError(id, -32602, "Invalid params");
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return reply({ protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "voice-fleet-mcp", version: "4.0.0" } });
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS.map(({ run, ...tool }) => tool) });
    if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, "Unknown tool");
    try {
      const args = params.arguments === undefined ? {} : params.arguments;
      validateArguments(tool, args);
      if (liveTools.has(tool.name)) {
        const capabilities = await call("GET", "/capabilities");
        if (!capabilities.ok || capabilities.data.liveCalls !== true) throw new InputError("Fleet does not have liveCalls enabled");
      }
      const result = await tool.run(args);
      return reply({ content: [{ type: "text", text: JSON.stringify(mask(result), null, 2) }], isError: !result.ok });
    } catch (error) {
      // Never echo fetch errors: they can contain upstream bodies or credentials.
      return reply({ content: [{ type: "text", text: `Error: ${error instanceof InputError ? error.message : "Fleet request failed"}` }], isError: true });
    }
  }
  return { handleMessage };
}
