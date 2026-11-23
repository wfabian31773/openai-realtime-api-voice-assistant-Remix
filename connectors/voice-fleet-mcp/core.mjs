// Shared, zero-dependency MCP implementation. Transports own I/O and credentials.
const V1 = "/api/plugin/v1";
export const SUPPORTED = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
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
  // Preserve the provenance alias as-is so the fleet can validate conflicts.
  if (a.requested_by !== undefined) body.requested_by = a.requested_by;
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
const CONTENT_KEYS = /^(body|text|transcript|transcription|transcriptionText|content|turns|messages)$/i;
const PHI_KEYS = /^(name|callerName|fromName|firstName|lastName|dob|dateOfBirth|email|subject)$/i;
const URL_KEYS = /^(mediaUrl|mediaUrls|recordingUrl|url|uri|mediaUri)$/i;
// Prefer the original NANP match so adjacent numeric text keeps its old output.
// Stop at a parenthesized suffix before consuming its digits; otherwise require
// the entire international digit run so overlong numbers retain their output.
const maskPhone = (value) => value.replace(/(?<![\w+])(?:(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})(?=[xX]\d|(?!\w))|\+\d(?:[ ().-]*\d){7,14}?(?=\s*\(\d+\)(?!\w)|[xX]\d|(?!\w|[ ().-]*\d)))/g,
  (phone, lastFour) => `***-***-${lastFour ?? phone.replace(/\D/g, "").slice(-4)}`);

export function maskString(value) {
  return maskPhone(value
    .replace(/\bsi\.[a-f0-9]{32}\.[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"));
}

// Match the box connector: content and all its descendants retain everything
// except phone digits and media/recording URLs when includeContent is true.
export function mask(value, key = "", includeContent = false, inContent = false) {
  const isContent = inContent || (includeContent && CONTENT_KEYS.test(key));
  if (Array.isArray(value)) return value.map((item) => mask(item, key, includeContent, isContent));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !URL_KEYS.test(k))
      .map(([k, v]) => [k, mask(v, k, includeContent, isContent)]));
  }
  if (typeof value !== "string") return value;
  if (isContent) return maskPhone(value);
  if (PHI_KEYS.test(key) || CONTENT_KEYS.test(key)) return value ? `[redacted ${value.length} chars]` : value;
  return maskPhone(value.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"));
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

  async function call(method, path, body, signal) {
    signal.throwIfAborted();
    const token = await getToken();
    signal.throwIfAborted();
    const res = await fetch(base + V1 + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      redirect: "error",
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return { status: res.status, ok: false, data: { error: "Fleet returned a non-JSON response" } }; }
    return { status: res.status, ok: res.ok, data };
  }

  async function confirmFor(a, call) {
    if (a.confirmToken) return { token: a.confirmToken };
    if (!a.id) return { error: { status: 400, ok: false, data: { error: "Provide confirmToken or id" } } };
    const r = await call("GET", `/contact_requests/${enc(a.id)}/confirm_token`);
    if (!r.ok) return { error: r };
    return { token: r.data.confirmToken };
  }

  async function sidGet(re, label, sid, path, includeContent, call) {
    if (typeof sid !== "string" || !re.test(sid)) return { status: 400, ok: false, data: { error: `Invalid ${label} format` } };
    const result = await call("GET", path + enc(sid));
    return { ...result, data: mask(result.data, "", includeContent === true) };
  }

  const TOOLS = [
    ["health", "Fleet plugin health and switch values.", obj(), (_, call) => call("GET", "/health")],
    ["list_agents", "List fleet voice agents.", obj(), (_, call) => call("GET", "/list_agents")],
    ["agent_health", "Agent switch / env health.", obj(), (_, call) => call("GET", "/agent_health")],
    ["fleet_today", "Per-lane counts for a day (YYYY-MM-DD, default today UTC).", obj({ day: str("YYYY-MM-DD") }), (a, call) => call("GET", `/fleet_today${a.day ? `?day=${enc(a.day)}` : ""}`)],
    ["recent_outcomes", "Recent call outcomes (limit 1-50).", obj({ limit: { type: "integer" } }), (a, call) => call("GET", `/recent_outcomes${a.limit ? `?limit=${enc(a.limit)}` : ""}`)],
    ["outbound_status", "SI Assistant outbound status.", obj(), (_, call) => call("GET", "/outbound_status")],
    ["approval_status", "Status of a prepared contact request by id.", obj({ id: str("Contact request id") }, ["id"]), (a, call) => call("GET", `/get_contact_request?id=${enc(a.id)}`)],
    ["email_replies", "Recent email replies (ids only).", obj(), (_, call) => call("GET", "/email_replies")],
    ["prepare_call", "Prepare an outbound call for human approval (body passed through).", obj(), (a, call) => call("POST", "/prepare_call", a)],
    ["prepare_text", "Prepare an SMS for human approval (body passed through).", obj(), (a, call) => call("POST", "/prepare_sms", a)],
    ["prepare_email", "Prepare an email for human approval (body passed through).", obj(), (a, call) => call("POST", "/prepare_email", a)],
    ["commit", "Commit an approved contact. Give confirmToken, or id to fetch it via the confirm-token hand-off.", obj({ id: str("Contact request id"), confirmToken: str("Confirm token") }),
      async (a, call) => { const c = await confirmFor(a, call); return c.error || call("POST", "/commit_contact", { confirmToken: c.token }); }],
    ["cancel", "Cancel a prepared contact request.", obj({ id: str("Contact request id") }, ["id"]), (a, call) => call("POST", "/cancel_contact", { id: a.id })],
    ["capabilities", "Fleet capability flags.", obj(), (_, call) => call("GET", "/capabilities")],
    ["commit_call_live", "Commit an approved call as a live, steerable call. Give confirmToken or id.", obj({ id: str("Contact request id"), confirmToken: str("Confirm token") }),
      async (a, call) => { const c = await confirmFor(a, call); return c.error || call("POST", "/commit_call_live", { confirmToken: c.token }); }],
    ["live_call_status", "Live call status and transcript turns after index.", obj({ sessionId: str("Session id"), after: { type: "integer" } }, ["sessionId"]),
      (a, call) => call("GET", `/live_calls/${enc(a.sessionId)}${a.after !== undefined ? `?after=${enc(a.after)}` : ""}`)],
    ["live_call_instruct", "Send guidance text (1-2000 chars) to a live call.", obj({ sessionId: str("Session id"), text: str("Guidance") }, ["sessionId", "text"]),
      (a, call) => call("POST", `/live_calls/${enc(a.sessionId)}/instruct`, { text: a.text })],
    ["call_direct", "Open-line call: dial any number now from (909) 555-0113 as a live, steerable call (needs calls:direct). No DOB/approval. Returns sessionId for live_call_status/instruct/end.",
      obj({ phone: str("US 10-digit or +1 E.164 number"), purpose: str("Instructions/persona for the agent (1-4000 chars)"), name: str("Optional recipient name") }, ["phone", "purpose"]),
      (a, call) => call("POST", "/calls/direct", { phone: a.phone, purpose: a.purpose, ...(a.name ? { name: a.name } : {}) })],
    ["operator_prepare_call", "Operator line: prepare a generic outbound agent call (no patient/ticket fields) for Wayne's human approval. Does not dial. Send purpose OR scenario_id (A1-A10; server fills purpose from the scenario pack). Returns approval id.",
      obj({ phone: str("Target E.164, e.g. +1XXXXXXXXXX"), purpose: str("Call purpose/instructions (1-4000 chars). Omit when scenario_id is set (server rejects a purpose that differs from the scenario goal)."), scenario_id: { type: "string", pattern: "^A([1-9]|10)$", description: "Synthetic test scenario A1-A10 (docs/operator-line/scenarios)" }, callerScript: str("Optional caller script/persona the agent follows (1-8000 chars); its first line is spoken as the opening unless openingLine is set"), openingLine: str("Optional exact first line the agent speaks (1-500 chars)"), initiated_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Optional provenance (default bot_initiative)" }, language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$", description: "Optional language code, e.g. en, es" }, maxDurationSec: { type: "integer", minimum: 30, description: "Hard stop in seconds, >=30 and <= server max (OPERATOR_LINE_MAX_CALL_MINUTES, default 3600)" }, requested_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Alias for initiated_by; both must agree when supplied" } }, ["phone"]),
      (a, call) => call("POST", "/prepare_operator_call", operatorPrepareBody(a))],
    ["operator_commit_call", "Operator line: after Wayne approves, place the call live (steerable). Give id (approval id) or confirmToken. Returns sessionId.", obj({ id: str("Approval id"), confirmToken: str("Confirm token") }),
      async (a, call) => { const c = await confirmFor(a, call); return c.error || call("POST", "/commit_call_live", { confirmToken: c.token }); }],
    ["get_transcript", "Full ordered transcript of an operator-line call by sessionId (preparing token only).", obj({ sessionId: str("Session id") }, ["sessionId"]),
      (a, call) => call("GET", `/calls/${enc(a.sessionId)}/transcript`)],
    ["live_call_end", "End a live call.", obj({ sessionId: str("Session id") }, ["sessionId"]), (a, call) => call("POST", `/live_calls/${enc(a.sessionId)}/end`, {})],
    ["operator_inbound_get", "Operator line: inbound call record by Twilio CallSid (CA + 32 hex). Needs operator:call. PHI masked unless includeContent.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, callSid: str("Twilio CallSid, CA + 32 hex") }, ["callSid"]),
      (a, call) => sidGet(SID.call, "callSid", a.callSid, "/operator-line/inbound/", a.includeContent, call)],
    ["operator_sms_get", "Operator line: inbound SMS/MMS record by MessageSid (SM|MM + 32 hex). Needs operator:call. Body redacted unless includeContent.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, messageSid: str("Twilio MessageSid, SM/MM + 32 hex") }, ["messageSid"]),
      (a, call) => sidGet(SID.sms, "messageSid", a.messageSid, "/operator-line/sms/", a.includeContent, call)],
    ["operator_voicemail_get", "Operator line: voicemail record by RecordingSid (RE + 32 hex). Needs operator:call. Transcription redacted unless includeContent; URLs dropped.", obj({ includeContent: { type: "boolean", description: "Default false. true = return transcript turns / message body / voicemail transcription unredacted (phones still last-4; media/recording URLs dropped)" }, recordingSid: str("Twilio RecordingSid, RE + 32 hex") }, ["recordingSid"]),
      (a, call) => sidGet(SID.rec, "recordingSid", a.recordingSid, "/operator-line/voicemail/", a.includeContent, call)],
    ["operator_sms_send", "Operator line: send an SMS from the operator number (no hours window, no caps). To Wayne's cell (OPERATOR_OWNER_NUMBER) it sends immediately; any other number creates a pending approval. Opt-out always blocks. Same idempotency_key sends once. Needs operator:call (Remix operator-line/sms/send).",
      obj({ to: str("Destination US phone number"), body: str("Message text (never logged or echoed)"), idempotency_key: str("1-200 chars, stable per intended text (e.g. call SID + purpose)"), initiated_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Optional provenance" } }, ["to", "body", "idempotency_key"]),
      async (a, call) => {
        if (typeof a.to !== "string" || !a.to.trim() || typeof a.body !== "string" || !a.body.trim()) return { status: 400, ok: false, data: { error: "to and body are required" } };
        if (typeof a.idempotency_key !== "string" || !a.idempotency_key.trim() || a.idempotency_key.length > 200) return { status: 400, ok: false, data: { error: "idempotency_key must contain 1 to 200 characters" } };
        const result = await call("POST", "/operator-line/sms/send", { to: a.to, body: a.body, idempotency_key: a.idempotency_key, ...(a.initiated_by ? { initiated_by: a.initiated_by } : {}) });
        return { ...result, data: mask(result.data) };
      }],
  ].map(([n, description, inputSchema, run]) => ({ name: `voice_fleet_${n}`, description, inputSchema, run }));

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" ||
        (Object.hasOwn(msg, "id") && typeof msg.id !== "string" && !Number.isSafeInteger(msg.id))) {
      return rpcError(null, -32600, "Invalid Request");
    }
    // Client responses are acknowledgements, not requests to dispatch.
    if (!Object.hasOwn(msg, "method")) {
      const validError = msg.error && typeof msg.error === "object" && !Array.isArray(msg.error) &&
        Number.isInteger(msg.error.code) && typeof msg.error.message === "string";
      return Object.hasOwn(msg, "id") && Object.hasOwn(msg, "result") !== Object.hasOwn(msg, "error") &&
        (!Object.hasOwn(msg, "error") || validError) ? null : rpcError(null, -32600, "Invalid Request");
    }
    if (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error")) return rpcError(null, -32600, "Invalid Request");
    if (typeof msg.method !== "string") return rpcError(null, -32600, "Invalid Request");
    if (msg.method.startsWith("notifications/") && Object.hasOwn(msg, "id")) return rpcError(msg.id, -32600, "Invalid Request");
    // MCP notifications never produce a reply or trigger tools.
    if (!Object.hasOwn(msg, "id")) return null;
    const { id, method, params } = msg;
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) return rpcError(id, -32602, "Invalid params");
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return reply({ protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: "voice-fleet-mcp", version: "4.0.0" } });
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS.map(({ run, ...tool }) => tool) });
    if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, "Unknown tool");
    const ctl = new AbortController();
    let timer;
    try {
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new InputError("arguments must be an object");
      // Keep the original handlers' normalization and validation order. Discovery
      // schemas are not preflight validators: optional empties and unused fields
      // must reach the handler, and the fleet validates its request payload.
      // One deadline covers token loading, every upstream request and its body.
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Fleet request timed out"));
          ctl.abort();
        }, timeoutMs);
      });
      const result = await Promise.race([
        expired,
        tool.run(args, (method, path, body) => call(method, path, body, ctl.signal)),
      ]);
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.ok });
    } catch (error) {
      // Never echo fetch errors: they can contain upstream bodies or credentials.
      return reply({ content: [{ type: "text", text: `Error: ${error instanceof InputError ? error.message : "Fleet request failed"}` }], isError: true });
    } finally { clearTimeout(timer); }
  }
  return { handleMessage };
}
