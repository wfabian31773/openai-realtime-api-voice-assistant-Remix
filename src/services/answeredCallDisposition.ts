/** A PHI-free, explicit no-IVR disposition; absence or ambiguity is not proof. */
export function answeredWithoutTicket(timeline: unknown): boolean {
  if (!timeline || typeof timeline !== 'object') return false;
  const events = (timeline as { events?: unknown }).events;
  if (!Array.isArray(events)) return false;
  let answered = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') return false;
    const { tool, outcome } = event as { tool?: unknown; outcome?: unknown };
    if (tool === 'escalate_to_human') return false;
    if (tool !== 'create_ticket' && tool !== 'record_answered_question') {
      // Later tool activity may concern a new request; do not waive it.
      if (answered) return false;
      continue;
    }
    if (!outcome || typeof outcome !== 'object') return false;
    const result = outcome as Record<string, unknown>;
    // A failed or ambiguous filing attempt may represent separate staff work.
    if (result.success !== true || result.ticketCreated !== false || result.callbackRequired !== false) return false;
    answered = true;
  }
  return answered;
}
