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

function toolResult(raw: unknown): Record<string, unknown> | undefined {
  try {
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** No phone callback alone says nothing about whether staff work remains. */
export function answeredWithoutFollowup(args: unknown): boolean {
  const request = toolResult(args);
  return request?.question_fully_answered === true && request.requires_callback === false;
}

/** `${callId}:${tool}` → error attempts this call (drives retry-once). */
const errorAttempts = new Map<string, number>();

export function releaseDirectionState(callId: string | undefined): void {
  if (!callId) return;
  for (const key of errorAttempts.keys()) if (key.startsWith(`${callId}:`)) errorAttempts.delete(key);
  medicationAsks.delete(callId);
}

/**
 * THE MEDICATION ASK IS BOUNDED AT ONE PER CALL (v112).
 *
 * The refill gate below refused `create_ticket` whenever the arguments said
 * "refill" or "medication" and no drug name in its list matched — with no
 * count, so it refused the same request on every attempt for the life of the
 * call. And its list is a dozen names and five suffixes, so a caller who NAMED
 * their drug was refused anyway. Measured 2026-10-22 over the 30 days before,
 * after-hours line: 14 calls asked for the medication name and ended with no
 * ticket of any provenance, 9 of them told the team would call back. In 11 of
 * the 14 the caller had said the name — Betoptic, Lumigan, Alphagan, Cosopt,
 * cyclosporine, fluorometholone, prednisone, doxycycline, sodium chloride
 * drops — and the worst call was asked 19 times. In the other 3 the caller did
 * not know the name, one of them about contact lenses.
 *
 * So the gate asks ONCE and the next attempt files, whatever it carries — the
 * operator's 2026-09-04 ruling on the date of birth ("ask once, then file")
 * applied to the one gate that never got it. A name the list does not know is
 * not a missing name; a list of names is not how a name is recognised
 * (standing instruction 3), and growing this one would only move the loop to
 * the next drug.
 *
 * Keyed on the call. A call with no id cannot be counted, so it is never
 * refused: a request must not be lost to a gate that cannot bound itself.
 * Capped, oldest first, because nothing on the runtime releases this module's
 * state at hangup and a map that only grows is a leak.
 */
const medicationAsks = new Map<string, number>();
export const MEDICATION_ASK_LIMIT = 1;
const MEDICATION_ASKS_CAP = 1000;

/** What the model reads when the gate refuses. Model-facing, never spoken. */
export const MEDICATION_GATE_REFUSAL =
  'ONE DETAIL NEEDED BEFORE FILING (this is NOT a system error — do not apologize, do not mention technical issues, do not end the call). ' +
  'If the caller has ALREADY said the name of the medication, do not ask again: put that name in the request and call create_ticket again now. ' +
  'Otherwise ask once: "Which medication do you need refilled?" — then call create_ticket again with the name, or, if they do not know it, ' +
  'call create_ticket again anyway; it will file without it. Never ask for the medication name a second time.';

/** What the call's tool timeline records when the gate refuses — countable, no PHI. */
export const MEDICATION_GATE_OUTCOME = {
  success: false,
  refused: 'medication_name',
  missingFields: ['medication'],
} as const;

/** A contact lens is not a medication, and asking which drug it is answers nothing. */
const CONTACT_LENSES = /contact ?lens|lentes de contacto|\bcontacts\b/;

function medicationGate(callId: string | undefined, argText: string): string | null {
  if (!/refill|medication/.test(argText)) return null;
  // A post-op prescription problem is exempt (operator ruling 2026-10-02, v89):
  // it files URGENT to After Hours, and the corpus caller did not know the
  // drug's name ("we don't know the name", CAa2e451aba415a1deb97a72374e3e1784)
  // — blocking that ticket for a name is the request lost.
  if (/"post_op_prescription":true/.test(argText)) return null;
  if (CONTACT_LENSES.test(argText)) return null;
  const namedMed = /\b(latanoprost|timolol|brimonidine|dorzolamide|prednisolone|atropine|restasis|xiidra|[a-z]{6,}(ol|ide|pine|mycin|floxacin|prost|zolamide))\b/.test(argText);
  if (namedMed) return null;
  if (!callId) return null;
  const asked = medicationAsks.get(callId) ?? 0;
  if (asked >= MEDICATION_ASK_LIMIT) {
    console.warn(`[TOOL-GATE] create_ticket medication ask already spent on call ${callId} — filing without a recognised name`);
    return null;
  }
  medicationAsks.delete(callId);
  medicationAsks.set(callId, asked + 1);
  while (medicationAsks.size > MEDICATION_ASKS_CAP) {
    const oldest = medicationAsks.keys().next().value;
    if (oldest === undefined) break;
    medicationAsks.delete(oldest);
  }
  return MEDICATION_GATE_REFUSAL;
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
    const result = toolResult(raw);
    if (result?.success === true && result.ticketCreated === false) {
      errorAttempts.delete(`${callId}:${toolName}`);
      return 'No ticket was created because the caller’s question was fully answered and no callback was requested. Do not say the request was submitted or promise a callback; ask whether the caller needs anything else.';
    }
    if (outcome === 'success') {
      errorAttempts.delete(`${callId}:${toolName}`);
      if (result?.success === true && result.ticketCreated === true && result.callbackRequired === false) {
        return 'Your request has been submitted. Do not promise a phone callback; ask whether the caller needs anything else.';
      }
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
  opts: {
    /**
     * Called when the medication gate refuses, with the arguments and the
     * outcome to record. The refusal returns before `execute`, so the
     * recorder the agent wrapped around `execute` never sees it — without
     * this, a refused filing is invisible in `tool_timeline` (v112).
     */
    recordRefusal?: (args: unknown, outcome: Record<string, unknown>) => void;
  } = {},
): (...args: A) => Promise<unknown> {
  return async (...args: A) => {
    // Ledger auto-fill (2026-08-07 afternoon watch: callback_fields was
    // still the top AS critical because the MODEL had to remember to copy
    // the number into the ticket). The constants fill the form directly:
    // an empty/missing callback field on any ticket tool gets the ledger's
    // callback number — deterministic, never overwrites a provided value.
    try {
      if (callId && /ticket/i.test(toolName) && args[0] && typeof args[0] === 'object') {
        const { getLedger } = await import('./callFactsLedger');
        const lf = getLedger(callId);
        const a0 = args[0] as Record<string, unknown>;
        if (lf?.callbackNumber) {
          for (const key of ['callback_number', 'patientPhone', 'callbackNumber', 'phone']) {
            if (key in a0 && (!a0[key] || String(a0[key]).replace(/\D/g, '').length < 10)) a0[key] = lf.callbackNumber;
          }
        }
        // Name and reason fill from the constants too (live hour 2026-08-07:
        // tickets graded critical for missing NAME and REASON the ledger held).
        const ledgerName = `${lf?.firstName ?? lf?.matchedFirstName ?? ''} ${lf?.lastName ?? lf?.matchedLastName ?? ''}`.trim();
        if (ledgerName) {
          for (const key of ['patientName', 'patient_name', 'name', 'callerName']) {
            if (key in a0 && (!a0[key] || String(a0[key]).trim().length < 2)) a0[key] = ledgerName;
          }
        }
        if (lf?.intent) {
          for (const key of ['reason', 'description', 'callReason']) {
            if (key in a0 && (!a0[key] || String(a0[key]).trim().length < 5)) a0[key] = lf.intent;
          }
        }
      }
    } catch { /* auto-fill must never affect the call */ }
    const refusal = await gateDecision(agentSlug, callId, toolName, args[0]);
    if (refusal) {
      if (refusal.code === 'medication_name') {
        try {
          opts.recordRefusal?.(args[0], { ...MEDICATION_GATE_OUTCOME });
        } catch { /* telemetry must never change what the caller hears */ }
      }
      return refusal.text;
    }
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
  toolArgs?: unknown,
): Promise<string | null> {
  return (await gateDecision(agentSlug, callId, toolName, toolArgs))?.text ?? null;
}

type GateRefusal = { text: string; code: 'medication_name' | 'call_not_finished' };

async function gateDecision(
  agentSlug: string,
  callId: string | undefined,
  toolName: string,
  toolArgs?: unknown,
): Promise<GateRefusal | null> {
  const argText = JSON.stringify(toolArgs ?? '').toLowerCase();
  // Request-type requirements (live retest 2026-08-07): a refill ticket
  // without the medication name is a message worth less — ask for it, ONCE
  // (v112, medicationGate above).
  if (toolName === 'create_ticket' && !(agentSlug === 'no-ivr' && answeredWithoutFollowup(toolArgs))) {
    const text = medicationGate(callId, argText);
    if (text) {
      console.warn(`[TOOL-GATE] create_ticket BLOCKED on ${agentSlug} — refill request without a recognised medication name (asked once)`);
      return { text, code: 'medication_name' };
    }
  }
  if (!callId || !/^(terminate_call|end_call|handle_patient_medical_records_request)$/.test(toolName)) return null;
  try {
    const { getLedger, updateLedger } = await import('./callFactsLedger');
    const f = getLedger(callId);
    if (!f) return null;
    // A records request implies delivery: default the contact method to fax
    // so the fax-number requirement engages (operator rule 2026-08-07).
    if (agentSlug === 'pcp' && (toolName === 'handle_patient_medical_records_request' || /record/.test(argText)) && !f.contactMethod) {
      updateLedger(callId, { contactMethod: 'fax' });
      f.contactMethod = 'fax';
    }
    const missing: string[] = [];
    if (agentSlug === 'pcp') {
      if (!f.medicalGroup) missing.push('the caller\'s name and office/medical group');
      if (f.contactMethod === 'fax' && !f.faxNumber) missing.push('the FAX number for this records request');
      if (f.contactMethod === 'email' && !f.email) missing.push('the email address for this request');
    }
    if (missing.length) {
      console.warn(`[TOOL-GATE] terminate_call BLOCKED on ${agentSlug} call ${callId} — missing: ${missing.join('; ')}`);
      return {
        text: `NOT DONE YET (this is NOT a system error — do not apologize or mention technical issues): you still need to collect ${missing.join('; ')}. Ask for it now, then wrap up with "Anything else I can help with?" before ending.`,
        code: 'call_not_finished',
      };
    }
  } catch {
    /* gate must never break a call */
  }
  return null;
}
