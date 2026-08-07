/**
 * CP-4 — The Ramp Engine (docs/ramp/script-listing.md §1–§2, approved).
 *
 * A coordinated state machine that does not fail or time out: greeting →
 * classification → identity → intent as PURE CODE. Transitions are if/else
 * on the call-facts ledger; utterances are the operator's exact lines;
 * answers are parsed deterministically. The voice model renders speech and
 * hears answers — it chooses nothing until the ramp exits.
 *
 * Exit paths: VERIFIED (hand to model with locked identity), TAKE_MESSAGE
 * (ticket flow with CP-3 direction), DISENGAGED (two unparsable answers or
 * urgency → current prompt-driven behavior with facts intact — the ramp
 * never traps a caller).
 */
import { getLedger, updateLedger } from './callFactsLedger';

export type RampState =
  | 'CAPTURE_INTENT'
  | 'COLLECT_CALLER'
  | 'CONFIRM_ID'
  | 'DOB_HANDOFF'
  | 'TAKE_MESSAGE'
  | 'CONFIRM_CALLBACK'
  | 'COLLECT_CALLBACK'
  | 'COLLECT_FAX'
  | 'CLASSIFY'
  | 'COLLECT_NAME'
  | 'COLLECT_DOB'
  | 'CONFIRM_DOB_READBACK'
  | 'DONE_VERIFIED'
  | 'DONE_MESSAGE'
  | 'DISENGAGED';

export type RampMode = 'patient' | 'professional' | 'sd_front' | 'full_rails';

export interface RampStatus {
  state: RampState;
  mode: RampMode;
  unparsedCount: number;
  verifyFails: number;
  active: boolean;
}

export interface RampStep {
  /** The exact line to force next (null = no forced line; model proceeds). */
  line: string | null;
  status: RampStatus;
}

const YES = /\b(yes|yeah|yep|correct|that's me|this is|speaking|si|sí|claro|correcto)\b/i;
const NO = /\b(no|nope|not|isn't|wrong|different person|someone else)\b/i;
const NEW_PAT = /\bnew\b/i;
const EXISTING = /\b(existing|current|already|been (there|seen)|paciente existente)\b/i;
const URGENT = /\b(emergency|911|chest pain|can't see|sudden|bleeding|urgent)\b/i;
const DOB = /\b(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b.*\b(19|20)\d{2}\b/i;

export const RAMP_LINES = {
  confirmId: (first: string) => `Am I speaking with ${first}?`,
  confirmDob: 'Great — just to confirm your identity, may I have your date of birth?',
  classify: 'Are you calling for a new patient or an existing patient?',
  collectName: "May I have the patient's first and last name?",
  collectDob: "And the patient's date of birth?",
  verified: (first: string) => `Thanks, ${first} — how can I help you today?`,
  verifyFail1: "Hmm — that doesn't match what I have. Could you give me your last name one more time?",
  verifyFail2Tickets:
    "I'm not finding a match on my end — I'll take your information and have the team contact you.",
  newPatientTickets: "I'll take your details so our team can get you set up. May I have the patient's first and last name?",
  collectCaller: 'Of course — may I have your name and the office or medical group you\'re calling from?',
  confirmCallback: (last4: string) => `Is this number ending in ${last4} the best one to reach you?`,
  collectCallback: "What's the best number to reach you?",
  collectFax: "What's the best fax number to send that to?",
  routeSchedule: 'Say: "I\'ll get that over to our PCP scheduling queue right away — one moment." Then, in this same turn, call handoff_to_pcp with reason "scheduling request". Do not ask anything else first.',
  fileDirectivePcp: (message: string) =>
    `Say: "I'll make sure that gets to the right team." Then, in this same turn, file this request with the appropriate ticket tool: ${message}. Do not ask the caller anything else first.`,
  fileDirective: (message: string) =>
    `Say: "Give me one moment while I get this submitted for you." Then, in this same turn, call create_ticket for this request: ${message}. Do not ask the caller anything else first.`,
} as const;

const sessions = new Map<string, RampStatus>();

export function startRamp(callId: string, mode: RampMode = 'patient'): RampStep {
  const facts = getLedger(callId);
  const matched = Boolean(facts?.matchedFirstName);
  const status: RampStatus = {
    // ALL modes open intent-first (live finding 2026-08-07: greetings ask
    // "how may I help", so the first utterance is the REASON — parsing it
    // as yes/no killed the ramp silently). The ramp asks the identity
    // question itself as a forced line, so greeting personalization races
    // no longer matter.
    state: mode === 'sd_front' ? (matched ? 'CONFIRM_ID' : 'CLASSIFY') : 'CAPTURE_INTENT',
    mode,
    unparsedCount: 0,
    verifyFails: 0,
    active: true,
  };
  sessions.set(callId, status);
  // The greeting (enforced separately) already plays; the ramp's first
  // forced line follows the caller's first response, so no line here for
  // matched callers (the greeting asks "Am I speaking with X?").
  return { line: null, status };
}

export function rampActive(callId: string): boolean {
  return sessions.get(callId)?.active === true;
}

export function releaseRamp(callId: string): void {
  sessions.delete(callId);
}

function disengage(status: RampStatus): RampStep {
  status.state = 'DISENGAGED';
  status.active = false;
  return { line: null, status };
}

/**
 * Feed one caller utterance; returns the exact next line to force (or null
 * when the ramp exits/disengages and the model proceeds normally).
 * verifyFn is injected (schedule lookup) — the only external call, a DB read.
 */
export async function onCallerUtterance(
  callId: string,
  text: string,
  verifyFn: (first: string, last: string, dob: string) => Promise<boolean>,
): Promise<RampStep> {
  const status = sessions.get(callId);
  if (!status || !status.active) return { line: null, status: status ?? { state: 'DISENGAGED', mode: 'patient', unparsedCount: 0, verifyFails: 0, active: false } };
  const facts = getLedger(callId);

  if (URGENT.test(text)) return disengage(status); // safety: model + guardrails own urgency

  const reask = (): string | null => {
    const f = getLedger(callId);
    switch (status.state) {
      case 'CONFIRM_ID': return f?.matchedFirstName ? RAMP_LINES.confirmId(f.matchedFirstName) : RAMP_LINES.classify;
      case 'CLASSIFY': return RAMP_LINES.classify;
      case 'COLLECT_NAME': return RAMP_LINES.collectName;
      case 'COLLECT_DOB': return RAMP_LINES.collectDob;
      case 'COLLECT_CALLER': return RAMP_LINES.collectCaller;
      case 'TAKE_MESSAGE': return 'What would you like the team to know?';
      case 'CONFIRM_CALLBACK': {
        const cb = getLedger(callId)?.callbackNumber;
        return cb ? RAMP_LINES.confirmCallback(cb.slice(-4)) : RAMP_LINES.collectCallback;
      }
      case 'COLLECT_CALLBACK': return RAMP_LINES.collectCallback;
      case 'COLLECT_FAX': return RAMP_LINES.collectFax;
      default: return null;
    }
  };
  const unparsable = (): RampStep => {
    status.unparsedCount += 1;
    if (status.unparsedCount >= 2) {
      console.warn(`[RAMP] DISENGAGED (unparsable x2) at ${status.state} for ${callId}`);
      return disengage(status);
    }
    // Rigidity: re-ask the SAME question as a forced line, never silent surrender.
    return { line: reask(), status };
  };

  switch (status.state) {
    case 'CAPTURE_INTENT': {
      if (text.trim().split(/\s+/).length >= 2) {
        updateLedger(callId, { intent: text.trim().slice(0, 200) });
        if (status.mode === 'professional') {
          status.state = 'COLLECT_CALLER';
          return { line: RAMP_LINES.collectCaller, status };
        }
        const known = getLedger(callId);
        if (known?.matchedFirstName) {
          status.state = 'CONFIRM_ID';
          return { line: RAMP_LINES.confirmId(known.matchedFirstName), status };
        }
        status.state = 'CLASSIFY';
        return { line: RAMP_LINES.classify, status };
      }
      return unparsable();
    }
    case 'COLLECT_CALLER': {
      if (text.trim().split(/\s+/).length >= 2) {
        updateLedger(callId, { medicalGroup: text.trim().slice(0, 160), callerRole: 'healthcare professional' });
        const intent = getLedger(callId)?.intent ?? '';
        // Route by request type (playbook §3): schedule -> PCP queue transfer;
        // records -> fax number; everything else -> callback confirm -> file.
        if (/schedul|appointment|book/i.test(intent)) {
          status.state = 'DONE_MESSAGE';
          status.active = false;
          return { line: RAMP_LINES.routeSchedule, status };
        }
        if (/record|fax|chart|notes|results/i.test(intent)) {
          updateLedger(callId, { contactMethod: 'fax' });
          status.state = 'COLLECT_FAX';
          return { line: RAMP_LINES.collectFax, status };
        }
        const cb = getLedger(callId)?.callbackNumber;
        if (cb) {
          status.state = 'CONFIRM_CALLBACK';
          return { line: RAMP_LINES.confirmCallback(cb.slice(-4)), status };
        }
        status.state = 'COLLECT_CALLBACK';
        return { line: RAMP_LINES.collectCallback, status };
      }
      return unparsable();
    }
    case 'COLLECT_FAX': {
      const fax = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (fax) {
        updateLedger(callId, { faxNumber: fax[0].replace(/[^\d+]/g, '') });
        status.state = 'DONE_MESSAGE';
        status.active = false;
        return { line: RAMP_LINES.fileDirectivePcp(getLedger(callId)?.intent ?? 'the records request'), status };
      }
      return unparsable();
    }
    case 'CONFIRM_ID': {
      if (YES.test(text) && !NO.test(text)) {
        if (status.mode === 'sd_front') {
          // SD: force the DOB ask, then hand the answer to the existing
          // verify_patient_identity tool flow (guards, director marks,
          // server-side personId) — the ramp never bypasses it.
          status.state = 'DOB_HANDOFF';
          return { line: RAMP_LINES.confirmDob, status };
        }
        status.state = 'COLLECT_DOB';
        return { line: RAMP_LINES.confirmDob, status };
      }
      if (NO.test(text)) {
        status.state = 'CLASSIFY';
        return { line: RAMP_LINES.classify, status };
      }
      return unparsable();
    }
    case 'TAKE_MESSAGE': {
      if (text.trim().split(/\s+/).length >= 2) {
        const prior = getLedger(callId)?.intent;
        updateLedger(callId, { intent: `${prior ? prior + ' — ' : ''}${text.trim().slice(0, 300)}` });
        const cb = getLedger(callId)?.callbackNumber;
        if (cb && !getLedger(callId)?.callbackConfirmed) {
          status.state = 'CONFIRM_CALLBACK';
          return { line: RAMP_LINES.confirmCallback(cb.slice(-4)), status };
        }
        if (!cb) {
          status.state = 'COLLECT_CALLBACK';
          return { line: RAMP_LINES.collectCallback, status };
        }
        status.state = 'DONE_MESSAGE';
        status.active = false;
        return { line: RAMP_LINES.fileDirective(getLedger(callId)?.intent ?? text.trim()), status };
      }
      return unparsable();
    }
    case 'CONFIRM_CALLBACK': {
      if (YES.test(text) && !NO.test(text)) {
        updateLedger(callId, { callbackConfirmed: true });
        status.state = 'DONE_MESSAGE';
        status.active = false;
        const mk = status.mode === 'professional' ? RAMP_LINES.fileDirectivePcp : RAMP_LINES.fileDirective;
        return { line: mk(getLedger(callId)?.intent ?? 'the caller request'), status };
      }
      if (NO.test(text)) {
        status.state = 'COLLECT_CALLBACK';
        return { line: RAMP_LINES.collectCallback, status };
      }
      return unparsable();
    }
    case 'COLLECT_CALLBACK': {
      const num = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (num) {
        updateLedger(callId, { callbackNumber: num[0].replace(/[^\d+]/g, ''), callbackConfirmed: true });
        status.state = 'DONE_MESSAGE';
        status.active = false;
        const mk = status.mode === 'professional' ? RAMP_LINES.fileDirectivePcp : RAMP_LINES.fileDirective;
        return { line: mk(getLedger(callId)?.intent ?? 'the caller request'), status };
      }
      return unparsable();
    }
    case 'DOB_HANDOFF': {
      status.state = 'DONE_VERIFIED';
      status.active = false;
      return { line: null, status }; // model + verify tool own it from here
    }
    case 'CLASSIFY': {
      if (NEW_PAT.test(text) && !EXISTING.test(text) && status.mode === 'sd_front') {
        updateLedger(callId, { newOrExisting: 'new' });
        status.state = 'DONE_MESSAGE';
        status.active = false;
        return { line: "I'm unable to schedule new patients, but our team can take care of that for you — one moment while I connect you.", status };
      }
      if (NEW_PAT.test(text) && !EXISTING.test(text)) {
        updateLedger(callId, { newOrExisting: 'new' });
        status.state = 'COLLECT_NAME';
        return { line: RAMP_LINES.newPatientTickets, status };
      }
      if (EXISTING.test(text)) {
        updateLedger(callId, { newOrExisting: 'existing' });
        status.state = 'COLLECT_NAME';
        return { line: RAMP_LINES.collectName, status };
      }
      return unparsable();
    }
    case 'COLLECT_NAME': {
      const words = text.trim().split(/\s+/).filter((w) => /^[a-záéíóúñ'-]+$/i.test(w));
      if (words.length >= 2) {
        updateLedger(callId, { firstName: words[0], lastName: words.slice(1).join(' ') });
        status.state = 'COLLECT_DOB';
        return { line: RAMP_LINES.collectDob, status };
      }
      return unparsable();
    }
    case 'COLLECT_DOB': {
      if (DOB.test(text)) {
        updateLedger(callId, { dateOfBirth: text.trim() });
        if (status.mode === 'sd_front') {
          status.state = 'DONE_VERIFIED';
          status.active = false;
          return { line: null, status }; // model calls verify with collected facts
        }
        // New patients on ticket lines don't verify — straight to message flow.
        if (facts?.newOrExisting === 'new') {
          if (status.mode === 'full_rails') {
            status.state = 'TAKE_MESSAGE';
            return { line: 'Thank you. And what would you like the team to know?', status };
          }
          status.state = 'DONE_MESSAGE';
          status.active = false;
          return { line: null, status };
        }
        const f = getLedger(callId);
        const first = f?.firstName ?? f?.matchedFirstName ?? '';
        const last = f?.lastName ?? f?.matchedLastName ?? '';
        let ok = false;
        try {
          ok = await verifyFn(first, last, text.trim());
        } catch {
          ok = false; // lookup error → treated as no-match; fail ladder applies
        }
        if (ok) {
          updateLedger(callId, { firstName: first, lastName: last, identityVerified: true });
          if (status.mode === 'full_rails') {
            // Rails continue: the verified greeting invites the message.
            status.state = 'TAKE_MESSAGE';
            return { line: RAMP_LINES.verified(first), status };
          }
          status.state = 'DONE_VERIFIED';
          status.active = false;
          return { line: RAMP_LINES.verified(first), status };
        }
        status.verifyFails += 1;
        if (status.verifyFails >= 2) {
          if (status.mode === 'full_rails') {
            status.state = 'TAKE_MESSAGE';
            return { line: RAMP_LINES.verifyFail2Tickets, status };
          }
          status.state = 'DONE_MESSAGE';
          status.active = false;
          return { line: RAMP_LINES.verifyFail2Tickets, status };
        }
        status.state = 'COLLECT_NAME';
        return { line: RAMP_LINES.verifyFail1, status };
      }
      return unparsable();
    }
    default:
      return disengage(status);
  }
}
