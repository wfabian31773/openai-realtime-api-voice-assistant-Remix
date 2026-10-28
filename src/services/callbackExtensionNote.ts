import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

// Held only until the call transcript is finalized. The transcript then carries
// the note across process restarts and post-call sync retries.
const notes = new Map<string, { note?: string; expires: number }>();
const TTL_MS = 2 * 60 * 60 * 1000;

export function rememberCallbackExtension(params: CreateTicketParams): void {
  const sid = params.callData?.callSid;
  if (!sid || !/^CA[0-9a-f]{32}$/i.test(sid)) return;
  const note = params.callData?.transcript?.split('\n').find(line => /^Callback extension: \d+$/.test(line));
  const now = Date.now();
  for (const [key, entry] of notes) if (entry.expires <= now) notes.delete(key);
  // Filing is idempotent per call; a later retry must not replace the note
  // for the payload that was actually accepted first.
  if (!notes.has(sid)) notes.set(sid, { note, expires: now + TTL_MS });
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
