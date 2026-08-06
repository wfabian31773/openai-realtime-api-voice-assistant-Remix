/**
 * Where an URGENT call gets transferred.
 *
 * Until 2026-08-03 every urgent escalation on the after-hours line dialled one
 * global number — HUMAN_AGENT_NUMBER, the operator's mobile — regardless of
 * hour, location, or who was actually on duty. Operator directive: urgent
 * calls should reach the OFFICE directly, with an urgent ticket as the
 * fallback, and keep falling back to on-call outside business hours.
 *
 * Resolution order:
 *
 *   1. Outside business hours (Mon-Fri 08:00-17:00 Pacific) → on-call.
 *      The office phones are not answered, so routing there would put a
 *      patient with vision loss into a voicemail box. Explicit operator
 *      decision, not an oversight.
 *   2. Inside business hours → ask the rules engine (sage_handoff) for the
 *      office queue that owns this caller's location, exactly as azul's
 *      tier-2 transfer does. THE NUMBER IS NEVER MODEL-SUPPLIED: it comes
 *      back from the service, so the agent can only connect callers to
 *      numbers the routing rules chose.
 *   3. Rules engine returns nothing usable → on-call.
 *      This is the important one. `sage_handoff` may be pilot-fenced for
 *      locations outside the AI-enabled set, in which case it returns no
 *      transfer number at all. Degrading to today's behaviour is always
 *      correct; degrading to a dead transfer would strand an urgent caller.
 *
 * Whatever happens, the caller ends up with a human or an urgent ticket —
 * the ticket fallback lives in the handoff path, not here.
 */

import { isBusinessHours } from '../utils/timeAware';

export type UrgentTransferSource =
  | 'office_queue'          // the rules engine routed us to an office
  | 'on_call_after_hours'   // outside business hours, by design
  | 'on_call_no_route'      // in hours, but the rules engine gave us nothing
  | 'on_call_error';        // in hours, but the lookup failed

export interface UrgentTransferTarget {
  number: string;
  source: UrgentTransferSource;
  /** Office/queue label, when the rules engine named one. Logging only. */
  queueLabel?: string;
}

const LOOKUP_TIMEOUT_MS = 6_000;

/** Read lazily, not at module load. This module is imported dynamically from
 *  the handoff path, and capturing env at import time makes the resolver
 *  depend on WHEN it was first pulled in — which is exactly the kind of
 *  ordering bug that only shows up on the one deploy where it matters. */
const eyecareBaseUrl = () =>
  process.env.EYECARE_BASE_URL || process.env.EYECARE_AGENT_BASE_URL || '';

/**
 * Ask the rules engine which office owns this caller.
 *
 * Deliberately NOT reusing azul's callEyecareTool: that one sends
 * `X-Pilot-Fence: 1`, which strips every location outside the SD pilot set.
 * Correct for azul, wrong here — answering-service and no-ivr cover the whole
 * practice, and a fenced response would silently look like "no route" for the
 * majority of offices.
 */
async function askRulesEngineForOffice(
  input: { callerPhone?: string; location?: string; reason: string },
): Promise<{ number: string; queueLabel?: string } | null> {
  const apiKey = process.env.EYECARE_AGENT_API_KEY;
  const baseUrl = eyecareBaseUrl();
  if (!apiKey || !baseUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch(`${baseUrl}/api/tools/sage_handoff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Zero-Id': '1',
      },
      body: JSON.stringify({
        handoffReason: 'urgent_symptom',
        callContext: {
          reasonForCall: input.reason,
          requestedLocation: input.location,
        },
        patient: { phone: input.callerPhone },
      }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    // The service wraps every response as {tool, result:{...}} — the same
    // envelope that cost azul a pilot call on 2026-07-22 when it was read
    // one level too shallow.
    const env: any = await r.json().catch(() => null);
    const parsed = env?.result ?? env;
    const number = parsed?.transferNumberE164 ?? parsed?.transfer_number ?? null;
    if (parsed?.method !== 'cold_transfer' || !number) return null;
    return {
      number: String(number),
      queueLabel: parsed?.queueTeam ? String(parsed.queueTeam) : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * WHICH AGENTS MAY RING THE ON-CALL PERSON'S PHONE.
 *
 * Operator directive 2026-08-06: "The only agent that is authorized to call me
 * is the no ivr agent that is used for after hours triage."
 *
 * Everything else resolves to an office queue or it does not transfer at all.
 * This is an allow-list, not a deny-list: a new agent gets no access to that
 * phone until someone deliberately adds it here.
 */
const ON_CALL_AUTHORIZED_AGENTS: ReadonlySet<string> = new Set(['no-ivr']);

export async function resolveUrgentTransferTarget(input: {
  reason: string;
  callerPhone?: string;
  location?: string;
  /** Injected in tests; defaults to the real clock. */
  businessHours?: boolean;
  onCallNumber?: string;
  /** Which agent is asking. Absent = not authorized for the on-call phone. */
  agentSlug?: string;
}): Promise<UrgentTransferTarget | null> {
  const configuredOnCall = input.onCallNumber ?? process.env.HUMAN_AGENT_NUMBER ?? '';
  // The on-call number exists for THIS agent only if it is allowed to use it.
  //
  // Before this gate, azul-scheduling rang the on-call phone 7 times between
  // 07-22 and 08-06 — every one of them DURING business hours Pacific (Thu
  // 12:03, Thu 11:24, Mon 08:38, Mon 08:10, Fri 09:22, Wed 16:17, Wed 14:32),
  // so none came from the after-hours branch. They came from the in-hours
  // fallback below: the rules engine returned no office, and the code handed
  // the caller to the on-call phone instead. None of those callers was even
  // urgent — they were asking to schedule an appointment and whether we take
  // Blue Shield Medi-Cal.
  const onCall = ON_CALL_AUTHORIZED_AGENTS.has(input.agentSlug ?? '') ? configuredOnCall : '';
  const inHours = input.businessHours ?? isBusinessHours();

  if (!inHours) {
    return onCall ? { number: onCall, source: 'on_call_after_hours' } : null;
  }

  let office: { number: string; queueLabel?: string } | null = null;
  let errored = false;
  try {
    office = await askRulesEngineForOffice(input);
  } catch {
    errored = true;
  }

  if (office?.number) {
    return { number: office.number, source: 'office_queue', queueLabel: office.queueLabel };
  }
  if (!onCall) return null;
  return { number: onCall, source: errored ? 'on_call_error' : 'on_call_no_route' };
}
