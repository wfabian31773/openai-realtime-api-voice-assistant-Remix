/**
 * Redaction for shadow storage and reports (Checkpoint 21).
 * Philosophy inherited from production (`toolTimeline.redactArgs`, console-repo
 * MULTI_LOCATION_ROLLOUT.md): allowlist, deny by default. Values that look like
 * identifiers are masked even inside allowed fields.
 */
import { digest } from './contracts';

const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const DOB_RE = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b|\b\d{4}-\d{2}-\d{2}\b/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Keys whose values are safe to keep verbatim (structure, not identity). */
const SAFE_KEYS = new Set([
  'endpoint', 'method', 'status', 'statusCode', 'tool', 'workflow', 'agentUsed',
  'agentSlug', 'agentId', 'departmentId', 'requestTypeId', 'requestReasonId',
  'priority', 'urgency', 'preferredContactMethod', 'confirmationType',
  'eventName', 'locationId', 'providerId', 'ordinal', 'idempotencyKey',
  'callSid', 'callId', 'sessionId', 'viaGateway', 'ms', 'ok', 'success',
  'decision', 'rulesFired', 'booking_status', 'handoffReason', 'queueTeam',
  'topic', 'intent', 'step', 'action', 'reasonCategory', 'ticketId',
  'ticketNumber', 'error', 'errorCode',
]);

export function maskText(text: string): string {
  return text
    .replace(SSN_RE, '[ssn]')
    .replace(PHONE_RE, (m) => `[phone…${m.replace(/\D/g, '').slice(-4)}]`)
    .replace(DOB_RE, '[dob]')
    .replace(EMAIL_RE, '[email]');
}

/**
 * Redact an arbitrary payload object for spool/report storage.
 * - allowlisted keys: kept (strings still identifier-masked)
 * - everything else: replaced by a digest so comparisons stay possible
 * - free text fields: masked and truncated, or dropped entirely when
 *   transcript storage is disabled
 */
export function redactPayload(
  payload: Record<string, unknown>,
  opts: { keepText: boolean; maxTextLen?: number } = { keepText: false },
): Record<string, unknown> {
  const maxLen = opts.maxTextLen ?? 500;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>, opts);
      continue;
    }
    if (SAFE_KEYS.has(key)) {
      out[key] = typeof value === 'string' ? maskText(value) : value;
      continue;
    }
    if (typeof value === 'string') {
      if (opts.keepText) {
        out[key] = maskText(value).slice(0, maxLen);
      } else {
        out[key] = `[redacted:${digest(value)}]`;
      }
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    out[key] = `[redacted:${digest(value)}]`;
  }
  return out;
}

/**
 * Sanitize a shadow-proposed caller-facing string (doc 06 §5): no stack traces,
 * no internal URLs, no credentials, and identifier masking. Returns '' when the
 * text looks like leaked internals rather than speech.
 */
export function sanitizeProposedResponse(text: string): string {
  if (!text) return '';
  if (/\b(at\s+\w+\s\(|Error:|EACCES|ENOTFOUND|SELECT\s+.+\sFROM|api[_-]?key|Bearer\s+[A-Za-z0-9._-]{10,})\b/i.test(text)) {
    return '';
  }
  if (/https?:\/\/(?!www\.)[\w.-]+(:\d+)?\//i.test(text)) return '';
  return maskText(text).slice(0, 600);
}
