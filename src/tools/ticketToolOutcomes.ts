/**
 * WHY EACH TICKET-TOOL CALL DID OR DID NOT FILE — v166.
 *
 * Tracing the six "reason not captured" tickets of 2026-10-28..11-01, the only
 * `call_events` rows on those calls were `identity_summary`. Nothing durable
 * said a filing tool had run, let alone that `file_records_ticket` refused the
 * `requester` field four times on 70298 — that came from the transcript alone.
 *
 * So every call to a ticket tool through `runTool` is noted here (the tool,
 * a verdict, the NAMES of the fields it refused for, and the names of the
 * arguments the model supplied), and at teardown the runtime writes ONE
 * `call_events` row, `category = 'tool'`, `message = 'ticket_tool_summary'`,
 * with the list. Only on calls that ran a ticket tool.
 *
 *   SELECT e->>'tool', e->>'verdict', e->'fields', count(*)
 *   FROM call_events, jsonb_array_elements(data->'calls') e
 *   WHERE category = 'tool' AND message = 'ticket_tool_summary'
 *   GROUP BY 1, 2, 3 ORDER BY 4 DESC;
 *
 * PHI-FREE BY CONSTRUCTION: field and argument NAMES, a verdict word, a
 * boolean for "a ticket number came back", and the moment. Never a value,
 * never a message, never an error text (the app's error text can echo what
 * the caller said).
 */
import { isTwilioCallSid } from './callSid';

/** The tools that file (or recover) a ticket on the registry path. */
export const TICKET_TOOLS: ReadonlySet<string> = new Set([
  'file_optical_ticket',
  'file_surgery_ticket',
  'file_tech_ticket',
  'file_records_ticket',
  'send_records_form',
]);

export type TicketToolVerdict = 'ok' | 'filed_pending' | 'validation_error' | 'failed' | 'timeout';

export interface TicketToolOutcome {
  tool: string;
  verdict: TicketToolVerdict;
  /** Field names the tool or app refused for. Names only. */
  fields?: string[];
  /** Argument names the model supplied with a non-empty value. Names only. */
  args: string[];
  ticket: boolean;
  recovered?: true;
  at: string;
}

const MAX_PER_CALL = 30;
const TTL_MS = 30 * 60_000;
const MAX_CALLS = 2_000;
const outcomes = new Map<string, { list: TicketToolOutcome[]; at: number }>();

/** Argument keys the runtime injects; they say nothing about what the model sent. */
const INJECTED = new Set(['call_sid', 'caller_phone', 'dialed_number', 'queue', 'lane', 'patient_scope', 'locationSource']);

const SAFE_NAME = /^[a-z][a-z0-9_]{0,40}$/i;

function argNames(input: Record<string, unknown>): string[] {
  return Object.keys(input)
    .filter((k) => !INJECTED.has(k) && SAFE_NAME.test(k))
    .filter((k) => {
      const v = input[k];
      if (v === undefined || v === null) return false;
      if (typeof v === 'string') return v.trim() !== '';
      return true;
    })
    .sort();
}

export function verdictFor(
  result: Record<string, unknown>,
  timedOut = false,
): { verdict: TicketToolVerdict; fields?: string[] } {
  if (timedOut) return { verdict: 'timeout' };
  const missing = Array.isArray(result.missingFields)
    ? (result.missingFields as unknown[]).filter((f): f is string => typeof f === 'string' && SAFE_NAME.test(f))
    : undefined;
  if (missing && missing.length) return { verdict: 'validation_error', fields: missing };
  if (result.success === true) {
    return { verdict: result.ticket_number || result.ticketNumber ? 'ok' : result.filed_pending ? 'filed_pending' : 'ok' };
  }
  return { verdict: 'failed' };
}

export function noteTicketToolOutcome(
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  opts: { timedOut?: boolean; now?: number } = {},
): void {
  try {
    if (!TICKET_TOOLS.has(tool)) return;
    const callSid = typeof input.call_sid === 'string' ? input.call_sid : undefined;
    if (!isTwilioCallSid(callSid)) return;
    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const now = opts.now ?? Date.now();
    for (const [k, v] of outcomes) if (now - v.at > TTL_MS) outcomes.delete(k);
    if (outcomes.size > MAX_CALLS) outcomes.delete(outcomes.keys().next().value as string);
    const entry = outcomes.get(callSid!) ?? { list: [], at: now };
    if (entry.list.length >= MAX_PER_CALL) return;
    const { verdict, fields } = verdictFor(r, opts.timedOut);
    entry.list.push({
      tool,
      verdict,
      ...(fields ? { fields } : {}),
      args: argNames(input),
      ticket: Boolean(r.ticket_number || r.ticketNumber),
      ...(r.recovered_after_refusal === true ? { recovered: true as const } : {}),
      at: new Date(now).toISOString(),
    });
    entry.at = now;
    outcomes.set(callSid!, entry);
  } catch {
    // Telemetry never breaks a tool call.
  }
}

/** Read and forget this call's outcomes. */
export function takeTicketToolOutcomes(callSid: string | undefined): TicketToolOutcome[] {
  if (!isTwilioCallSid(callSid)) return [];
  const entry = outcomes.get(callSid!);
  outcomes.delete(callSid!);
  return entry ? entry.list : [];
}

export const TICKET_TOOL_EVENT = 'ticket_tool_summary';

export function ticketToolEvent(list: readonly TicketToolOutcome[]): {
  level: 'info' | 'warn';
  data: Record<string, unknown>;
} {
  const filed = list.some((o) => o.ticket || o.verdict === 'filed_pending');
  const refusals = list.filter((o) => o.verdict === 'validation_error').length;
  return {
    // A call whose ticket tool never filed is the population worth reading.
    level: filed ? 'info' : 'warn',
    data: { calls: list, filed, refusals, failures: list.filter((o) => o.verdict === 'failed' || o.verdict === 'timeout').length },
  };
}

/** Tests only. */
export function resetTicketToolOutcomes(): void {
  outcomes.clear();
}
