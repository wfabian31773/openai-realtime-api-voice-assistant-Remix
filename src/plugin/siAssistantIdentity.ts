/**
 * Per-call identity for SI Assistant ticket attach. A dial is not a
 * confirmation (P2-B). An explicit yes to "Am I speaking with <A>?"
 * plus a date-of-birth match is. wrong_person never attaches.
 */
export type SiAssistantIdentity = {
  greetingAffirmed: boolean;
  dobMatched: boolean;
  wrongPerson: boolean;
};

const sessions = new Map<string, SiAssistantIdentity>();
const MAX = 500;
const TTL_MS = 2 * 60 * 60 * 1000;
const opened = new Map<string, number>();

function prune(now = Date.now()): void {
  for (const [sid, at] of opened) {
    if (now - at > TTL_MS) {
      sessions.delete(sid);
      opened.delete(sid);
    }
  }
  while (sessions.size >= MAX) {
    const oldest = opened.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
    opened.delete(oldest);
  }
}

function row(callSid: string): SiAssistantIdentity {
  prune();
  let current = sessions.get(callSid);
  if (!current) {
    current = { greetingAffirmed: false, dobMatched: false, wrongPerson: false };
    sessions.set(callSid, current);
    opened.set(callSid, Date.now());
  }
  return current;
}

export function noteSiAssistantIdentity(callSid: string, patch: Partial<SiAssistantIdentity>): SiAssistantIdentity {
  const current = row(callSid);
  Object.assign(current, patch);
  return { ...current };
}

export function siAssistantIdentityFor(callSid: string | null | undefined): SiAssistantIdentity | null {
  if (!callSid) return null;
  const current = sessions.get(callSid);
  return current ? { ...current } : null;
}

export function closeSiAssistantIdentity(callSid: string): void {
  sessions.delete(callSid);
  opened.delete(callSid);
}

export function resetSiAssistantIdentityForTests(): void {
  sessions.clear();
  opened.clear();
}
