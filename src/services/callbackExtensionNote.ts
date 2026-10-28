import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

// Held only until the call transcript is finalized. The transcript then carries
// the note across process restarts and post-call sync retries.
interface ExtensionEntry { note?: string; expires: number; outboxId?: string }
const notes = new Map<string, ExtensionEntry>();
const TTL_MS = 2 * 60 * 60 * 1000;

export function callbackExtensionOutboxEntry(params: CreateTicketParams): ExtensionEntry | undefined {
  const sid = params.callData?.callSid;
  const entry = sid ? notes.get(sid) : undefined;
  if (!entry || entry.expires <= Date.now() || !entry.outboxId) return undefined;
  return entry;
}

export function rememberCallbackExtension(
  params: CreateTicketParams,
  options: { outboxId?: string; replace?: boolean; expected?: ExtensionEntry } = {},
): void {
  const sid = params.callData?.callSid;
  if (!sid || !/^CA[0-9a-f]{32}$/i.test(sid)) return;
  const note = params.callData?.transcript?.split('\n').find(line => /^Callback extension: \d+$/.test(line));
  const now = Date.now();
  for (const [key, entry] of notes) if (entry.expires <= now) notes.delete(key);
  // An ordinary idempotent retry keeps the first payload's note. A reopened
  // dead letter replaces it; a direct retry may do so only if the entry we
  // checked has not changed while the outbox status was being read.
  if (options.expected && notes.get(sid) !== options.expected) return;
  if (options.replace || !notes.has(sid)) {
    notes.set(sid, { note, expires: now + TTL_MS, outboxId: options.outboxId });
  }
}

export function transcriptWithCallbackExtension(transcript: string, sid?: string | null): string {
  const entry = sid ? notes.get(sid) : undefined;
  if (!entry) return transcript;
  if (entry.expires <= Date.now()) {
    notes.delete(sid!);
    return transcript;
  }
  if (!entry.note) return transcript;
  return transcript.split('\n').includes(entry.note)
    ? transcript
    : [transcript, entry.note].filter(Boolean).join('\n');
}
