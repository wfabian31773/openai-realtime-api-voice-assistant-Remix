/**
 * THE LANGUAGE EACH LIVE CALL IS SPOKEN IN, BY CALLSID (v261).
 *
 * Operator, 2026-11-22: "Yes to the spanish version of the text." The NPX
 * outreach booking confirmation went out in English to a caller the agent had
 * served in Spanish (CAbc83d5fb3913698181ce23444571fe9f). Measured, every NPX
 * call booking 2026-11-07..22: 23 of 80 were on a call the agent switched to
 * Spanish, and every one got the English text.
 *
 * The bridge (`mediaStreamBridge.ts`) is the one place that knows which
 * language a call is spoken in: it changes the wire only on a successful
 * `set_spoken_language` and drops a switch to the language already in use. So
 * it writes here at that moment, and a tool that writes something the caller
 * will read after the call (the confirmation text, `npxOutreachTools.ts`)
 * reads it by CallSid. A call that never switched has no entry: it is spoken
 * in its lane's own language.
 *
 * ONE IMPORT STYLE. The bridge writes through a static import and the reader
 * must too: on Node 20 a dynamic import evaluated a per-call store a second
 * time with an empty Map (v141). `perCallStoresHaveOneImportStyle.test.ts`
 * guards modules under src/services, which is why this one lives here.
 *
 * Bounded like the other per-call stores: a canonical CallSid only, at most
 * MAX_CALLS calls, an entry older than TTL_MS forgotten, and the runtime
 * releases the call's entry at teardown. A language tag only; nothing a caller
 * said is kept.
 */
import { isTwilioCallSid } from "../tools/callSid";

const MAX_CALLS = 500;
const TTL_MS = 2 * 60 * 60 * 1000;

const languages = new Map<string, { language: string; at: number }>();

/** The bridge: the call is now spoken in `language` (a normalised tag). */
export function noteCallLanguage(callSid: string, language: string, now = Date.now()): void {
  if (!isTwilioCallSid(callSid) || typeof language !== "string" || !language.trim()) return;
  // Oldest first out: with the clock only moving forward, the oldest entry
  // is the first to expire, so no separate sweep is needed; a read forgets
  // an expired entry.
  languages.delete(callSid);
  while (languages.size >= MAX_CALLS) {
    const oldest = languages.keys().next().value;
    if (oldest === undefined) break;
    languages.delete(oldest);
  }
  languages.set(callSid, { language: language.trim(), at: now });
}

/** The language the call was last switched to, or undefined when it never was. */
export function callLanguageFor(callSid: string, now = Date.now()): string | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = languages.get(callSid);
  if (!entry) return undefined;
  if (now - entry.at > TTL_MS) {
    languages.delete(callSid);
    return undefined;
  }
  return entry.language;
}

/** The runtime's teardown. */
export function releaseCallLanguage(callSid: string): void {
  languages.delete(callSid);
}

/** Tests only. */
export function resetCallLanguagesForTests(): void {
  languages.clear();
}
