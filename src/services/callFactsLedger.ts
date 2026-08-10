/**
 * Call-Facts Ledger — the constants of a call (docs/ramp/playbook.md).
 *
 * "Once the information is gathered, it becomes a constant throughout the
 * conversation and you never forget it." (Wayne 2026-08-07) — the missing
 * component behind question repetition, empty callback fields, and
 * wrong-info-after-verification. One structured store per call:
 *
 *  - SEEDED before the first word from what the system already knows:
 *    caller phone (callback candidate), matched patient name, language.
 *  - FILLED as answers arrive (identity slots, intent, confirmations).
 *  - LOCKED on verification — a locked slot is never re-asked.
 *  - RENDERED each turn as a KNOWN-FACTS block the agent cannot miss.
 *
 * Pure in-memory per call (cleared at teardown); cross-call memory (S8)
 * reads/writes through callerMemoryService separately.
 */

export interface CallFacts {
  callerPhone?: string;
  /** Matched via caller-ID pre-context — a hint until verified. */
  matchedFirstName?: string;
  matchedLastName?: string;
  /** DOB from the matched record — verification compares against THIS. */
  matchedDob?: string;
  /** Stated/confirmed by the caller. */
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  identityVerified: boolean;
  /**
   * The association, straight from patients_master once verification passes.
   *
   * Operator, 2026-08-10: "when you create the ticket, there's an association
   * that's made with the patient indirectly in the ticket for the staff to
   * work with. So that's very important." Without it a ticket is a note about
   * somebody; with it, it opens the right chart.
   */
  personId?: string;
  personNbr?: string;
  hasMedicalRecord?: boolean;
  /** The chart's language — a hint for staff, never an instruction to the voice. */
  chartLanguage?: string;
  callbackNumber?: string;
  callbackConfirmed: boolean;
  language?: string;
  newOrExisting?: 'new' | 'existing';
  intent?: string;
  priorCallsSameIssue?: number;
  /** PCP line (docs/ramp/playbook.md): who is calling and how to respond. */
  callerRole?: string;
  medicalGroup?: string;
  /** Contact method MUST match the request: fax->faxNumber, email->email. */
  contactMethod?: 'callback' | 'fax' | 'email';
  faxNumber?: string;
  email?: string;
  patientReferenced?: string;
}

const ledgers = new Map<string, CallFacts>();

export function seedLedger(callId: string, seed: Partial<CallFacts>): CallFacts {
  const facts: CallFacts = {
    identityVerified: false,
    callbackConfirmed: false,
    ...ledgers.get(callId),
    ...seed,
  };
  // Caller-ID is the default callback candidate from second zero.
  if (!facts.callbackNumber && facts.callerPhone) facts.callbackNumber = facts.callerPhone;
  ledgers.set(callId, facts);
  return facts;
}

export function updateLedger(callId: string, patch: Partial<CallFacts>): CallFacts {
  const facts = ledgers.get(callId) ?? seedLedger(callId, {});
  // Locked identity is immutable: once verified, name/DOB never change.
  if (facts.identityVerified) {
    delete patch.firstName;
    delete patch.lastName;
    delete patch.dateOfBirth;
  }
  Object.assign(facts, patch);
  return facts;
}

export function getLedger(callId: string): CallFacts | undefined {
  return ledgers.get(callId);
}

export function releaseLedger(callId: string): void {
  ledgers.delete(callId);
}

/**
 * The KNOWN-FACTS block injected into forced turn instructions: everything
 * the agent must treat as settled, phrased as prohibitions on re-asking.
 */
export function renderKnownFacts(callId: string): string | null {
  const f = ledgers.get(callId);
  if (!f) return null;
  const lines: string[] = [];
  const name = f.identityVerified
    ? `${f.firstName ?? f.matchedFirstName ?? ''} ${f.lastName ?? f.matchedLastName ?? ''}`.trim()
    : null;
  if (name) lines.push(`Patient: ${name} — IDENTITY VERIFIED. Never ask for their name or date of birth again.`);
  else if (f.firstName || f.matchedFirstName)
    lines.push(`Caller first name: ${f.firstName ?? f.matchedFirstName} (do not re-ask).`);
  if (f.dateOfBirth && !f.identityVerified) lines.push(`Date of birth already given: ${f.dateOfBirth} (do not re-ask).`);
  if (f.callbackNumber)
    lines.push(
      `Callback number: ${f.callbackNumber}${f.callbackConfirmed ? ' (confirmed)' : ` — confirm ONCE with "Is this number ending in ${f.callbackNumber.slice(-4)} the best one to reach you?", never ask them to read out digits`}.`,
    );
  if (f.newOrExisting) lines.push(`Caller classification: ${f.newOrExisting} patient (do not re-ask).`);
  else if (f.matchedFirstName)
    lines.push(
      'This caller was RECOGNIZED from their phone number — they are an EXISTING patient by definition. NEVER ask whether they are a new or existing patient, and NEVER treat a failed lookup as reason to ask: if details do not match, say so and offer to take a message — do not interview them.',
    );
  if (f.intent) lines.push(`Stated reason for calling: ${f.intent} (do not re-ask why they called).`);
  if (f.language) lines.push(`Preferred language: ${f.language}.`);
  if (f.medicalGroup) lines.push(`Calling from: ${f.medicalGroup}${f.callerRole ? ` (${f.callerRole})` : ''} (do not re-ask).`);
  if (f.contactMethod === 'fax')
    lines.push(f.faxNumber ? `Fax number for this request: ${f.faxNumber} (confirmed — do not re-ask).` : 'A FAX was requested — collect a fax number, NOT a callback number.');
  if (f.contactMethod === 'email')
    lines.push(f.email ? `Email for this request: ${f.email} (confirmed — do not re-ask).` : 'EMAIL was requested — collect an email address, NOT a callback number.');
  if (f.patientReferenced)
    lines.push(`Patient referenced: ${f.patientReferenced} — attach silently if matched; NEVER block or interrogate the professional about it.`);
  if (f.priorCallsSameIssue && f.priorCallsSameIssue >= 3)
    lines.push(
      `This caller has called ${f.priorCallsSameIssue} times about this — acknowledge it and elevate: "I see you've called a few times about this — I'm going to make sure this gets elevated to a senior team member right away."`,
    );
  if (!lines.length) return null;
  return `# KNOWN FACTS (settled — never re-ask)\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Test hook. */
export function clearAllLedgers(): void {
  ledgers.clear();
}

/**
 * Passive harvester — gathering must NOT depend on who is driving the
 * conversation (operator principle 2026-08-07: the morning failure left
 * every slot empty because only the ramp wrote them). Called on EVERY
 * caller line, any agent, ramp alive or dead: fills empty slots from
 * recognizable answers. Never overwrites, never throws.
 */
const H_DOB = /\b(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s]((19|20)\d{2})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((19|20)\d{2})\b/i;
const H_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i;
const H_FAX = /\bfax\b/i;
const H_EMAIL = /\be-?mail\b/i;
const H_FAX_NUM = /\b(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const H_EMAIL_ADDR = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;

export function harvestCallerLine(callId: string, text: string): void {
  try {
    const f = ledgers.get(callId) ?? seedLedger(callId, {});
    const dob = text.match(H_DOB);
    if (dob && !f.dateOfBirth) f.dateOfBirth = dob[0];
    const day = text.match(H_DAY);
    if (day) (f as CallFacts & { requestedDay?: string }).requestedDay = day[1].toLowerCase();
    if (H_FAX.test(text) && !f.contactMethod) f.contactMethod = 'fax';
    if (H_EMAIL.test(text) && !f.contactMethod && !H_FAX.test(text)) f.contactMethod = 'email';
    if (f.contactMethod === 'fax' && !f.faxNumber) {
      const n = text.match(H_FAX_NUM);
      if (n && H_FAX.test(text)) f.faxNumber = n[0];
    }
    if (f.contactMethod === 'email' && !f.email) {
      const e = text.match(H_EMAIL_ADDR);
      if (e) f.email = e[0];
    }
  } catch {
    /* harvesting must never affect a call */
  }
}

const MONTHS: Record<string, number> = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

/** Normalize any spoken/stored DOB form to m-d-y for direct comparison. */
export function dobKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  const named = s.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((19|20)\d{2})/);
  if (named) return `${MONTHS[named[1]]}-${Number(named[2])}-${named[3]}`;
  const iso = s.match(/((19|20)\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${Number(iso[3])}-${Number(iso[4])}-${iso[1]}`;
  const num = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((19|20)\d{2})/);
  if (num) return `${Number(num[1])}-${Number(num[2])}-${num[3]}`;
  return null;
}

/**
 * "Why are we comparing to the system when we should compare to the context
 * we already pulled?" (Wayne 2026-08-07) — recognized callers verify by
 * DIRECT comparison against the matched record's DOB. No lookup, no miss.
 */
export function dobMatchesContext(callId: string, spokenDob: string): boolean | null {
  const f = ledgers.get(callId) as (CallFacts & { matchedDob?: string }) | undefined;
  const known = dobKey(f?.matchedDob);
  if (!known) return null; // no context DOB — caller falls back to lookup
  const spoken = dobKey(spokenDob);
  return spoken !== null && spoken === known;
}
