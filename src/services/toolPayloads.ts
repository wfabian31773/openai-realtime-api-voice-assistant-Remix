/**
 * THE FULL ARGUMENTS AND RESULT OF EVERY TOOL CALL, kept apart from the
 * timeline (v238).
 *
 * Operator, 2026-11-14: "Dont' you think we should be tracking the tools
 * arguments? Seems like this is the only way to pinpoint what is happening
 * behind the scenes on some of these calls" — and, approving the design, 30
 * days and admins only.
 *
 * `call_logs.tool_timeline` keeps an ALLOW-LISTED subset of each tool call's
 * arguments and result (`toolTimeline.ts`, `SAFE_ARG_KEYS`), because every
 * report, the Daybook and the graders read it and it was built to hold no
 * patient data. Measured over the seven days to 2026-11-14: 15,998 runtime
 * tool calls, and on 9,028 of them (56%) the timeline kept NO argument at all.
 * The defects that could not be read back because of it: the date form the
 * model sent to `book_sooner_exam` (#476), the name it sent to
 * `identify_callback_caller` and what the tool answered
 * (CAd9bc221aa5b4eb90f43a16745849a4fb), which `record_pcp_intake` field it got
 * wrong (CAa36ae68ef6d5654594fe11253d30a942, v177), and whether a filing tool
 * ever received a patient name the caller gave (#482).
 *
 * So this is a SECOND store, beside the timeline and never instead of it:
 *
 *   - one row per tool call in `tool_call_payloads`, the call's own arguments
 *     and result as the tool received and returned them, keyed on the CallSid
 *     and the event's place in the timeline;
 *   - secrets are removed before anything is written (`scrubForStorage`): a
 *     key that names a token, secret, password, key, signature or cookie, a
 *     URL's query string and any long opaque path segment, a bearer token or a
 *     JWT — the store is for reading what the model did, never for replaying a
 *     link or a credential;
 *   - each half is capped (16 KB arguments, 32 KB result) so one oversized
 *     lookup cannot grow a row without bound;
 *   - rows older than `TOOL_PAYLOAD_RETENTION_DAYS` (30) are deleted, at most
 *     once an hour, by the writer itself;
 *   - the table has row-level security on and no policy, so only the server's
 *     own role reads it, and the one route that serves it is admin-only
 *     (`/api/call-logs/:id/tool-payloads`).
 *
 * The timeline is UNCHANGED: what it keeps, and what the reports read, is
 * exactly what it was. This writes telemetry and nothing else — no gate, no
 * tool answer and no spoken line reads it — and like every recorder here it
 * never throws into a tool and never delays one: the insert is fired and
 * forgotten. `TOOL_PAYLOADS_DISABLED=1` switches it off without a deploy.
 */
import { db } from '../../server/db';
import { sql } from 'drizzle-orm';

/** Operator, 2026-11-14. A policy number, not a tuning knob. */
export const TOOL_PAYLOAD_RETENTION_DAYS = 30;
/** Each half's cap, in characters of its JSON. */
export const ARGS_CHAR_CAP = 16_000;
export const RESULT_CHAR_CAP = 32_000;
/** How often the writer deletes expired rows. */
export const PURGE_EVERY_MS = 60 * 60 * 1000;
/** How deep `scrubForStorage` walks before it stops. */
const MAX_DEPTH = 12;

export interface ToolPayloadRow {
  callId: string;
  callSid: string | null;
  callLogId: string | null;
  agentSlug: string | null;
  /** The event's index in the in-memory timeline at the moment it was recorded. */
  seq: number;
  tool: string;
  /** The timeline event's own `at`, byte for byte, so the page can pair them. */
  eventAt: string;
  ms: number | null;
  args: unknown;
  result: unknown;
}

// ------------------------------------------------------------------- scrubbing

const SECRET_WORDS = /(token|secret|password|passwd|apikey|signature|cookie|bearer|credential)/;

/**
 * A key whose VALUE is a credential. Read on the key with case, digits and
 * separators removed, so `confirm_token`, `apiKey`, `X-Signature` and
 * `accessToken` all match, and `confirmation_type`, `key_phrases` and
 * `idempotencyKey` do not (an idempotency key identifies a request, it opens
 * nothing).
 */
export function isSecretKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_WORDS.test(flat) || flat === 'authorization' || flat === 'auth';
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
/** A path segment that is an opaque id rather than a word: 20+ base64url characters. */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;

/**
 * A URL with nothing in it that would open anything: the query string and the
 * fragment are dropped and every opaque path segment (a booking-link token, a
 * signed id) is replaced, so `https://host/book/<token>?sig=…` becomes
 * `https://host/book/[removed]?[removed]`.
 */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  const tail = cut === -1 ? '' : '?[removed]';
  const m = base.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  if (!m) return base + tail;
  const path = (m[2] ?? '')
    .split('/')
    .map((seg) => (OPAQUE_SEGMENT.test(seg) ? '[removed]' : seg))
    .join('/');
  return m[1] + path + tail;
}

export function scrubString(s: string): string {
  return s
    .replace(URL_RE, (u) => {
      // A sentence's own punctuation after a URL is not part of it.
      const trail = u.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
      return scrubUrl(u.slice(0, u.length - trail.length)) + trail;
    })
    .replace(BEARER_RE, 'Bearer [removed]')
    .replace(JWT_RE, '[removed]');
}

/**
 * A copy of `value` with every credential removed. Never mutates what it is
 * given (the tool's own arguments and result are still in use by the call).
 */
export function scrubForStorage(value: unknown, depth = 0): unknown {
  if (value == null) return value ?? null;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null; // functions, symbols
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((v) => scrubForStorage(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? '[removed]' : scrubForStorage(v, depth + 1);
  }
  return out;
}

/**
 * Hold a half of the row to its cap. Over the cap the row keeps the first
 * `cap` characters of the JSON as text, says it was cut, and how long the
 * whole was, so a reader knows what they are not seeing.
 */
export function capped(value: unknown, cap: number): unknown {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return { unserialisable: true };
  }
  if (text.length <= cap) return value ?? null;
  return { truncated: true, chars: text.length, text: text.slice(0, cap) };
}

/** A tool's result as it came back: JSON when it parses, the raw text when not. */
export function parseResult(resultJson: string): unknown {
  try {
    return JSON.parse(resultJson);
  } catch {
    return { text: resultJson };
  }
}

/** What reaches the table for one tool call. Pure; the writer only adds I/O. */
export function payloadFor(input: {
  args: Record<string, unknown> | undefined;
  resultJson: string;
}): { args: unknown; result: unknown } {
  return {
    args: capped(scrubForStorage(input.args ?? {}), ARGS_CHAR_CAP),
    result: capped(scrubForStorage(parseResult(input.resultJson)), RESULT_CHAR_CAP),
  };
}

// --------------------------------------------------------------------- writing

export interface ToolPayloadStore {
  ensure(): Promise<void>;
  insert(row: ToolPayloadRow): Promise<void>;
  /** Delete every row created before `cutoffIso`. */
  purge(cutoffIso: string): Promise<void>;
}

/** A failure named by its code or class, never by its message. */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,12}$/i.test(code)) return `code ${code}`;
  return e instanceof Error ? e.name : typeof e;
}

export function payloadsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TOOL_PAYLOADS_DISABLED === '1';
}

/**
 * The writer, with its store and clock injected so its rules are testable
 * without a database: it never throws, never awaits on the caller's path,
 * ensures the table once, purges at most once per `PURGE_EVERY_MS`, and says
 * so on the console the first time it writes and the first time it fails.
 */
export function createToolPayloadWriter(
  store: ToolPayloadStore,
  opts: { now?: () => number; env?: NodeJS.ProcessEnv; log?: Pick<Console, 'info' | 'warn'> } = {},
) {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const log = opts.log ?? console;
  let ensured: Promise<void> | null = null;
  let lastPurgeAt = 0;
  let wroteOnce = false;
  let failures = 0;

  async function write(row: ToolPayloadRow): Promise<void> {
    if (!ensured) {
      ensured = store.ensure().catch((e) => {
        ensured = null; // try again on the next call
        throw e;
      });
    }
    await ensured;
    await store.insert(row);
    if (!wroteOnce) {
      wroteOnce = true;
      log.info(
        `[TOOL PAYLOADS] storing every tool call's full arguments and result (admin-only, ${TOOL_PAYLOAD_RETENTION_DAYS}-day retention)`,
      );
    }
    const t = now();
    if (t - lastPurgeAt >= PURGE_EVERY_MS) {
      lastPurgeAt = t;
      const cutoff = new Date(t - TOOL_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await store.purge(cutoff);
    }
  }

  return {
    /** Fire and forget. Resolves when the write settles; never rejects. */
    record(row: ToolPayloadRow): Promise<void> {
      if (payloadsDisabled(env)) return Promise.resolve();
      return write(row).catch((e) => {
        failures += 1;
        if (failures === 1 || failures % 100 === 0) {
          log.warn(
            // The code only: a database error's message can quote the value
            // that failed, and the value is what the caller said.
            `[TOOL PAYLOADS] write failed (${failures} so far; the call is unaffected): ${errorCode(e)}`,
          );
        }
      });
    },
  };
}

/** The production store: the Hub, created lazily like `call_events`. */
export const hubToolPayloadStore: ToolPayloadStore = {
  async ensure() {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tool_call_payloads (
        id BIGSERIAL PRIMARY KEY,
        call_id VARCHAR NOT NULL,
        call_sid VARCHAR,
        call_log_id VARCHAR,
        agent_slug VARCHAR,
        seq INTEGER NOT NULL,
        tool VARCHAR(80) NOT NULL,
        event_at TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        ms INTEGER,
        args JSONB,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tool_call_payloads_call_sid_idx ON tool_call_payloads (call_sid)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tool_call_payloads_call_log_id_idx ON tool_call_payloads (call_log_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tool_call_payloads_created_at_idx ON tool_call_payloads (created_at)`);
    await db.execute(sql`ALTER TABLE tool_call_payloads ENABLE ROW LEVEL SECURITY`);
  },
  async insert(row) {
    await db.execute(sql`
      INSERT INTO tool_call_payloads
        (call_id, call_sid, call_log_id, agent_slug, seq, tool, event_at, at, ms, args, result)
      VALUES
        (${row.callId}::text, ${row.callSid}::text, ${row.callLogId}::text, ${row.agentSlug}::text,
         ${row.seq}::integer, ${row.tool}::text, ${row.eventAt}::text, ${row.eventAt}::timestamptz,
         ${row.ms}::integer, ${JSON.stringify(row.args ?? null)}::jsonb, ${JSON.stringify(row.result ?? null)}::jsonb)
    `);
  },
  async purge(cutoffIso) {
    await db.execute(sql`DELETE FROM tool_call_payloads WHERE created_at < ${cutoffIso}::timestamptz`);
  },
};

const productionWriter = createToolPayloadWriter(hubToolPayloadStore);

/** What `recordToolEvent` calls. Never throws, never blocks. */
export function recordToolPayload(row: ToolPayloadRow): void {
  try {
    void productionWriter.record(row);
  } catch {
    /* telemetry must never reach a patient's call */
  }
}
