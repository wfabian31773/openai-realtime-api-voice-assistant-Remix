/**
 * CP-3 — Tool-response direction engine (docs/ramp/script-listing.md §6).
 *
 * "Whenever they make a tool call, that's where the director comes in and
 * tells them what to say back based on the response of the tool call."
 * (Wayne 2026-08-07) — generalized as PURE CODE: every tool result is
 * classified and the approved next line rides INSIDE the tool output the
 * model is about to read. No reasoning layer, no timeouts, no response
 * collisions — the directive is part of the result itself.
 *
 * v1 scope: the shared ticket tools on the ticket-only lines and PCP
 * (azul's own tool directives already exist and are unified in CP-6).
 */

type Outcome = 'success' | 'error';

function classify(raw: unknown): Outcome {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return /^\s*error\b|"error"|ERROR:/i.test(s) ? 'error' : 'success';
}

/** `${callId}:${tool}` → error attempts this call (drives retry-once). */
const errorAttempts = new Map<string, number>();

export function releaseDirectionState(callId: string | undefined): void {
  if (!callId) return;
  for (const key of errorAttempts.keys()) if (key.startsWith(`${callId}:`)) errorAttempts.delete(key);
}

const FILED_LINE: Record<string, string> = {
  'answering-service':
    "You're all set — I've passed that to the team and they'll contact you as soon as they're available. Is there anything else?",
  'no-ivr':
    "You're all set — I've passed that to the team and the right team member will call you back first thing. Is there anything else?",
  'after-hours':
    "You're all set — I've passed that to the team and the right team member will call you back first thing. Is there anything else?",
  pcp: 'Done — the team will follow up with your office. Anything else I can help with?',
};

export function directionFor(
  agentSlug: string,
  toolName: string,
  raw: unknown,
  callId: string | undefined,
): string | null {
  const outcome = classify(raw);
  if (toolName === 'create_ticket') {
    if (outcome === 'success') {
      errorAttempts.delete(`${callId}:${toolName}`);
      const line = FILED_LINE[agentSlug];
      return line ? `Say this to the caller now, then stop: "${line}"` : null;
    }
    const key = `${callId}:${toolName}`;
    const attempt = (errorAttempts.get(key) ?? 0) + 1;
    errorAttempts.set(key, attempt);
    if (attempt === 1) {
      return 'Do NOT tell the caller anything about an error. Silently call create_ticket again ONCE with the same parameters right now.';
    }
    console.error(
      `[TOOL-DIRECTION] ALERT create_ticket failed twice on ${agentSlug} call ${callId} — ticket MUST be recovered by the sweep`,
    );
    return 'Say this to the caller now, then stop: "I\'ve noted everything and the team will follow up with you." Do not mention any error.';
  }
  return null;
}

/**
 * Compose over a tool's execute: append the directive to the result the
 * model reads. Never throws; direction failure returns the raw result.
 */
export function withToolDirection<A extends unknown[]>(
  agentSlug: string,
  callId: string | undefined,
  toolName: string,
  execute: (...args: A) => Promise<unknown> | unknown,
): (...args: A) => Promise<unknown> {
  return async (...args: A) => {
    const blocked = await gateBeforeExecution(agentSlug, callId, toolName);
    if (blocked) return blocked;
    const raw = await execute(...args);
    try {
      const directive = directionFor(agentSlug, toolName, raw, callId);
      if (directive && typeof raw === 'string') return `${raw}\n\n[DIRECTION — follow exactly] ${directive}`;
      return raw;
    } catch {
      return raw;
    }
  };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * S6 (approved): when the caller asked for a specific day and availability
 * comes back on a DIFFERENT day, the admission comes FIRST — the offer is
 * rewritten to "I don't have anything on {day} — the closest I have is…"
 * before the model ever reads it (live SD failure 2026-08-07: Tuesday
 * asked, Wednesday offered twice with no acknowledgement).
 */
export function acknowledgeDayMismatch(raw: string, preferredDate?: string): string {
  if (!preferredDate || typeof raw !== 'string') return raw;
  try {
    const reqDay = WEEKDAYS[new Date(`${preferredDate}T12:00:00`).getDay()];
    if (!reqDay) return raw;
    const parsed = JSON.parse(raw);
    const env = parsed?.result ?? parsed;
    if (!env || typeof env.say !== 'string') return raw;
    const sayLower = env.say.toLowerCase();
    if (sayLower.includes(reqDay)) return raw; // offer matches the asked day
    const offersOtherDay = WEEKDAYS.some((d) => d !== reqDay && sayLower.includes(d));
    if (!offersOtherDay) return raw; // no-availability messages pass through
    const cap = reqDay.charAt(0).toUpperCase() + reqDay.slice(1);
    env.say = `I don't have anything on ${cap} — the closest I have is: ${env.say}`;
    if (parsed?.result) {
      parsed.result = env;
      return JSON.stringify(parsed);
    }
    return JSON.stringify(env);
  } catch {
    return raw;
  }
}

/**
 * Pre-execution gate (operator 2026-08-07: "the PCP line died abruptly —
 * can't have that in production"): terminate_call REFUSES to run while
 * required ledger slots for the request are still empty. Deterministic:
 * the tool returns what to collect instead of ending the call.
 */
export async function gateBeforeExecution(
  agentSlug: string,
  callId: string | undefined,
  toolName: string,
): Promise<string | null> {
  if (!callId || !/^(terminate_call|end_call)$/.test(toolName)) return null;
  try {
    const { getLedger } = await import('./callFactsLedger');
    const f = getLedger(callId);
    if (!f) return null;
    const missing: string[] = [];
    if (agentSlug === 'pcp') {
      if (!f.medicalGroup) missing.push('the caller\'s name and office/medical group');
      if (f.contactMethod === 'fax' && !f.faxNumber) missing.push('the FAX number for this records request');
      if (f.contactMethod === 'email' && !f.email) missing.push('the email address for this request');
    }
    if (missing.length) {
      console.warn(`[TOOL-GATE] terminate_call BLOCKED on ${agentSlug} call ${callId} — missing: ${missing.join('; ')}`);
      return `BLOCKED — do NOT end the call yet. You still need to collect: ${missing.join('; ')}. Ask for it now, then wrap up properly with "Anything else I can help with?" before ending.`;
    }
  } catch {
    /* gate must never break a call */
  }
  return null;
}
