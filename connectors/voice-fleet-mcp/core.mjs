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
// Preserve established identifiers, not arbitrary values assigned to an id key.
const TYPED_KEY = /^(?:id|[a-z][\w]*Id|sid|[a-z][\w]*Sid|created_?at|updated_?at|(?:[a-z][\w]*)?timestamp)$/i;
const TIME_KEY = /^(?:created_?at|updated_?at|(?:[a-z][\w]*)?timestamp)$/i;
function isTypedId(value, key) {
  if (!TYPED_KEY.test(key)) return false;
  if (TIME_KEY.test(key)) return /^\d{13}$/.test(value); // Millisecond epochs.
  if (/^\d{16,}$/.test(value) || /^-\d{12,}$/.test(value)) return true;
  if (/_id$/i.test(key) && /^\d{12,}$/.test(value)) return true;
  const stem = key.replace(/_?(?:sid|id)$/i, "");
  return !!stem && value.toLowerCase().startsWith(stem.toLowerCase()) &&
    new RegExp(`^${stem}[-_][a-z0-9_]+(?:[-.:][a-z0-9_]+)*$`, "i").test(value);
}

// Nd and compatibility digits are handled algorithmically. These ordered runs
// cover the remaining Unicode single-digit numerals (including enclosed digits).
const OTHER_DIGITS = new Map();
for (const [first, last, initial] of [
  [0xc78, 0xc7b, 0], [0xc7c, 0xc7e, 1], [0x1369, 0x1371, 1],
  [0x17f0, 0x17f9, 0], [0x19da, 0x19da, 1], [0x24f5, 0x24fd, 1],
  [0x24ff, 0x24ff, 0], [0x2776, 0x277e, 1], [0x2780, 0x2788, 1],
  [0x278a, 0x2792, 1], [0x10107, 0x1010f, 1], [0x1018a, 0x1018a, 0],
  [0x102e1, 0x102e9, 1], [0x10320, 0x10320, 1], [0x10321, 0x10321, 5],
  [0x10858, 0x1085a, 1], [0x10879, 0x1087d, 1], [0x108a7, 0x108aa, 1],
  [0x108ab, 0x108ac, 4], [0x108fb, 0x108fb, 1], [0x108fc, 0x108fc, 5],
  [0x10916, 0x10916, 1], [0x1091a, 0x1091b, 2], [0x109c0, 0x109c8, 1],
  [0x10a40, 0x10a43, 1], [0x10a7d, 0x10a7d, 1], [0x10a9d, 0x10a9d, 1],
  [0x10aeb, 0x10aeb, 1], [0x10aec, 0x10aec, 5], [0x10b58, 0x10b5b, 1],
  [0x10b78, 0x10b7b, 1], [0x10ba9, 0x10bac, 1], [0x10cfa, 0x10cfa, 1],
  [0x10cfb, 0x10cfb, 5], [0x10e60, 0x10e68, 1], [0x10f1d, 0x10f21, 1],
  [0x10f51, 0x10f51, 1], [0x10fc5, 0x10fc8, 1], [0x11052, 0x1105a, 1],
  [0x111e1, 0x111e9, 1], [0x11c5a, 0x11c62, 1], [0x16e80, 0x16e89, 0],
  [0x16e94, 0x16e96, 1], [0x1d2c0, 0x1d2c9, 0], [0x1d2e0, 0x1d2e9, 0],
  [0x1d360, 0x1d368, 1], [0x1d372, 0x1d376, 1], [0x1d377, 0x1d377, 1],
  [0x1d378, 0x1d378, 5], [0x1e8c7, 0x1e8cf, 1], [0x1ec71, 0x1ec79, 1],
  [0x1eca3, 0x1ecab, 1], [0x1ecb1, 0x1ecb2, 1], [0x1ed01, 0x1ed09, 1],
  [0x1ed2f, 0x1ed36, 2], [0x1f10b, 0x1f10b, 0], [0x1f10c, 0x1f10c, 0]
]) for (let code = first; code <= last; code++) OTHER_DIGITS.set(code, String(initial + code - first));
for (const [first, last, initial] of [[0x24eb, 0x24f4, 11], [0x24fe, 0x24fe, 10], [0x277f, 0x277f, 10], [0x2789, 0x2789, 10], [0x2793, 0x2793, 10]]) {
  for (let code = first; code <= last; code++) OTHER_DIGITS.set(code, String(initial + code - first));
}
const DIGIT_VALUES = new Map();
function normalizePhonePoint(point) {
  const other = OTHER_DIGITS.get(point.codePointAt(0));
  if (other !== undefined) return other;
  return point.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => {
    if (!DIGIT_VALUES.has(digit)) {
      const code = digit.codePointAt(0);
      let first = code;
      while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--;
      DIGIT_VALUES.set(digit, String((code - first) % 10));
    }
    return DIGIT_VALUES.get(digit);
  }).replace(/[\p{M}\p{Cf}\p{Cc}\p{Co}]/gu, "");
}

// Matching-only text and UTF-16 offsets. Only internally generated placeholders
// become barriers; literal private-use delimiters are ordinary obfuscation.
function phoneView(text, protectedValues = new Map()) {
  const starts = [], ends = [], parts = [];
  for (let offset = 0; offset < text.length;) {
    const start = offset;
    const placeholder = /^\uE000[a-p]{8}\uE001/.exec(text.slice(offset, offset + 10));
    let normalized;
    if (text.startsWith("\uE000\uE000", offset)) {
      offset += 2;
      normalized = "";
    } else if (placeholder && protectedValues.has(placeholder[0])) {
      offset += placeholder[0].length;
      normalized = "\0";
    } else {
      const escape = /^\\(?:u\{([a-f\d]{1,6})\}|u([a-f\d]{4})|([tnrfvb]))/i.exec(text.slice(offset, offset + 12));
      let point = String.fromCodePoint(text.codePointAt(offset));
      offset += point.length;
      if (escape) {
        offset = start + escape[0].length;
        const code = parseInt(escape[1] || escape[2], 16);
        if (escape[3]) point = " ";
        else if (code <= 0x10ffff) {
          point = String.fromCodePoint(code);
          const low = /^\\u([dD][c-fC-F][a-f\d]{2})/.exec(text.slice(offset, offset + 6));
          if (code >= 0xd800 && code <= 0xdbff && low) {
            point += String.fromCharCode(parseInt(low[1], 16));
            offset += low[0].length;
          }
        }
      }
      normalized = normalizePhonePoint(point);
    }
    parts.push(normalized);
    for (let i = 0; i < normalized.length; i++) { starts.push(start); ends.push(offset); }
  }
  return { normalized: parts.join(""), starts, ends };
}

const PHONE_GAP = /^[\p{White_Space}\p{P}\p{S}]*$/u;
const LETTER_GAP = /^[\p{L}\p{White_Space}\p{P}\p{S}]*$/u;
const digitText = (value) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : String(value);
function arrayDigits(value, key) {
  if (Array.isArray(value)) {
    const parts = value.map((item) => arrayDigits(item, key));
    return parts.every((part) => part !== null) ? parts.join("") : null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = digitText(value);
  if (isTypedId(text, key)) return null;
  const { normalized } = phoneView(text);
  return /^\d+$/.test(normalized) ? normalized : PHONE_GAP.test(normalized) ? "" : null;
}
function maskDigitArray(value, key) {
  let result = null, first = 0, count = 0;
  const redact = (item) => Array.isArray(item) ? item.map(redact) : "[redacted digits]";
  for (let i = 0; i <= value.length; i++) {
    const digits = i < value.length ? arrayDigits(value[i], key) : null;
    if (digits === null) {
      if (count >= 7 && (i - first > 1 || Array.isArray(value[first]))) {
        result ??= value.slice();
        for (let j = first; j < i; j++) result[j] = redact(value[j]);
      }
      first = i + 1; count = 0;
    } else count += digits.length;
  }
  return result;
}
function maskPhoneData(value, key = "") {
  if (Array.isArray(value)) return (maskDigitArray(value, key) ?? value).map((item) => maskPhoneData(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [maskPhone(k), maskPhoneData(v, k)]));
  if (typeof value === "string") return maskPhone(value, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = digitText(value), masked = maskPhone(text, key);
    return masked === text ? value : masked;
  }
  return value;
}

function maskPhone(value, key = "") {
  if (isTypedId(value, key)) return value;
  // Decode complete JSON, including nested serialized JSON, before treating it
  // as text. Escaped digits and split array elements must share the same rules.
  if (/^\s*[\[{"]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const masked = maskPhoneData(parsed, key);
      return JSON.stringify(masked) === JSON.stringify(parsed) ? value : JSON.stringify(masked);
    } catch { /* Free text can contain JSON-like punctuation. */ }
  }
  const protectedValues = new Map();
  const delimiter = "\uE000";
  const protect = (token) => {
    const index = protectedValues.size.toString(16).padStart(8, "0")
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
    const placeholder = `${delimiter}${index}\uE001`;
    protectedValues.set(placeholder, token.replace(/\uE000\uE000/g, delimiter));
    return placeholder;
  };
  let text = value.replace(/\uE000/g, delimiter + delimiter);
  // Inline JSON still needs typed-value protection. Consume each quoted token
  // once, including malformed/unterminated tokens, to avoid repeated rescans.
  text = text.replace(/("(?:[^"\\]|\\[\s\S])*(?:"|\\?$))(?:([ \t\r\n]*:[ \t\r\n]*)("(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|-?\d+(?:\.\d+)?)(?=[ \t\r\n]*[,}]))?/g,
    (field, fieldName, colon, raw) => {
      if (raw === undefined) return field;
      try {
        return isTypedId(String(JSON.parse(raw)), JSON.parse(fieldName)) ? fieldName + colon + protect(raw) : field;
      } catch { return field; }
    });
  const tokens = Array.from(text.matchAll(/(?<![\w])(?:(?:CA|PN|SM|MM|RE|AC)[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T[0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?)(?![\w])/gi));
  const tokenPieces = [];
  let tokenEnd = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0], index = tokens[i].index, end = index + token.length;
    // Check disjoint gaps between candidate tokens, so adjacent standalone dates
    // survive while a token inside a phone cannot shield its surrounding groups.
    const before = phoneView(text.slice(tokenEnd, index), protectedValues).normalized;
    const after = phoneView(text.slice(end, tokens[i + 1]?.index ?? text.length), protectedValues).normalized;
    const left = /(\d+)([\p{White_Space}\p{P}\p{S}]*)$/u.exec(before);
    const right = /^([\p{White_Space}\p{P}\p{S}]*)(\d+)/u.exec(after);
    const embedded = (left && (left[1].length < 7 || !/\p{White_Space}/u.test(left[2]))) ||
      (right && (right[2].length < 7 || !/\p{White_Space}/u.test(right[1])));
    const oversizedFraction = /^\d{4}-/.test(token) && /\.\d{7}/.test(token);
    tokenPieces.push(text.slice(tokenEnd, index), embedded || oversizedFraction ? token : protect(token));
    tokenEnd = end;
  }
  tokenPieces.push(text.slice(tokenEnd));
  text = tokenPieces.join("");
  const { normalized, starts, ends } = phoneView(text, protectedValues);
  const groups = Array.from(normalized.matchAll(/\d+/g));
  const gaps = groups.map((group, i) => i ? normalized.slice(groups[i - 1].index + groups[i - 1][0].length, group.index) : "\0");
  const joins = gaps.map((gap) => LETTER_GAP.test(gap));
  const following = new Array(groups.length).fill(0);
  for (let i = groups.length - 1; i >= 0; i--) following[i] = groups[i][0].length +
    (i + 1 < groups.length && joins[i + 1] && !/[,;]/.test(gaps[i + 1]) ? following[i + 1] : 0);
  const pieces = [];
  let previousEnd = 0, first = 0, count = 0, hasExtension = false;
  const emit = (last) => {
    if (count < 7) return;
    let start = groups[first].index;
    while (start > 0 && /[+(]/.test(normalized[start - 1])) start--;
    let end = groups[last].index + groups[last][0].length;
    if (normalized[end] === ")") end++;
    const run = normalized.slice(start, end);
    let phone = run;
    const marker = /(?:extension|ext\.?|x|#)[\p{White_Space}\p{P}\p{S}]*(?=\d)/iu.exec(run);
    if (marker && run.slice(0, marker.index).replace(/\D/g, "").length >= 7) phone = run.slice(0, marker.index);
    // Parenthesized suffixes, like explicit extensions, must not expose digits
    // alongside the phone's last four. A short prefix is part of the number.
    for (const parens of phone.matchAll(/\(\d+\)/g)) {
      if (phone.slice(0, parens.index).replace(/\D/g, "").length >= 7 &&
        /^(?:\(\d+\)[\p{White_Space}\p{P}\p{S}]*)+$/u.test(phone.slice(parens.index))) {
        phone = phone.slice(0, parens.index);
        break;
      }
    }
    const originalStart = starts[start], originalEnd = ends[end - 1];
    pieces.push(text.slice(previousEnd, originalStart), `***-***-${phone.replace(/\D/g, "").slice(-4)}`);
    previousEnd = originalEnd;
  };
  for (let i = 0; i < groups.length; i++) {
    if (i && count >= 7 && /(?:extension|ext\.?|x|#|\()/iu.test(gaps[i])) hasExtension = true;
    if (i && (!joins[i] || (!hasExtension && count >= 7 && /[,;]|\p{L}.*\p{White_Space}|\p{White_Space}.*\p{L}/u.test(gaps[i]) && following[i] >= 7))) {
      emit(i - 1); first = i; count = 0; hasExtension = false;
    }
    count += groups[i][0].length;
  }
  if (groups.length) emit(groups.length - 1);
  pieces.push(text.slice(previousEnd));
  text = pieces.join("");
  return text.replace(/\uE000(?:\uE000|[a-p]{8}\uE001)/g,
    (placeholder) => placeholder === delimiter + delimiter ? delimiter : protectedValues.get(placeholder));
}

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
  if (Array.isArray(value)) return (maskDigitArray(value, key) ?? value).map((item) => mask(item, key, includeContent, isContent));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !URL_KEYS.test(k))
      .map(([k, v]) => [maskPhone(k), mask(v, k, includeContent, isContent)]));
  }
  if (typeof value === "number") return maskPhoneData(value, key);
  if (typeof value !== "string") return value;
  if (isContent) return maskPhone(value, key);
  if (PHI_KEYS.test(key) || CONTENT_KEYS.test(key)) return value ? `[redacted ${value.length} chars]` : value;
  return maskPhone(value.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"), key);
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
