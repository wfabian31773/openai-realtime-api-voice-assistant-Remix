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
  /** Stated/confirmed by the caller. */
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  identityVerified: boolean;
  callbackNumber?: string;
  callbackConfirmed: boolean;
  language?: string;
  newOrExisting?: 'new' | 'existing';
  intent?: string;
  priorCallsSameIssue?: number;
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
  if (f.intent) lines.push(`Stated reason for calling: ${f.intent} (do not re-ask why they called).`);
  if (f.language) lines.push(`Preferred language: ${f.language}.`);
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
