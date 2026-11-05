/**
 * THE PATIENT'S NAME, TAKEN FROM THE RECORDING — v180.
 *
 * Operator, 2026-10-29: "we should not be filing nameless tickets but we also
 * need to make sure that we did not get the name in transcripts nor did we
 * match the phone number to a patient on lookup." And 2026-11-05, on being
 * reminded that only the narrower halves were built (v142 reads the name a
 * TOOL received; v171 reads the calling number's record when the caller said
 * that name): "thought we had agreed to do that".
 *
 * Why a model and not a pattern. Standing instruction 3 — "why are you trying
 * to determine what a first name is? You'll never ever get it to work like
 * that" — is about regexing for names; the same instruction says extraction
 * is the model's job. And the corpus needs a reader that understands who the
 * call is ABOUT: of the 17 one-breath messages from numbers that match no
 * record (queue lanes, 2026-10-22..11-04, none with a ticket of any
 * provenance), 6 were a pharmacy, a clinic or a relative calling about
 * somebody else. The ticket needs the patient's name, not the caller's.
 *
 * What makes it safe enough to put on a ticket nobody watched being filed:
 *   1. It runs only where the sweep would otherwise skip as `no-name`.
 *   2. The model's answer is CHECKED: every word of both names must appear in
 *      the CALLER's own lines (spelled letters count). A name the model made
 *      up, or took from the agent, never reaches a ticket.
 *   3. Both halves, two letters at least, and not a word the ticketing app
 *      refuses as a placeholder. A first name alone files nothing.
 *   4. The ticket says where the name came from (see the sweep's staff note).
 *
 * It uses the model and account the grader already uses on every call
 * (`callGradingService.ts`, gpt-4o-mini on OPENAI_API_KEY), so the transcript
 * goes nowhere it does not already go. No key, a timeout or an error answers
 * null, and the sweep behaves exactly as before.
 */
import OpenAI from "openai";
import { APP_PLACEHOLDER_NAME_WORDS } from "../services/standInName";

export interface HeardName {
  firstName: string;
  lastName: string;
}

/** What the model was asked, answered as it answered. Injected in tests. */
export type NameAsker = (transcript: string) => Promise<{ firstName?: string | null; lastName?: string | null } | null>;

/** Teardown waits on this; the caller has already gone. */
export const NAME_REQUEST_TIMEOUT_MS = 6_000;
export const NAME_MODEL = "gpt-4o-mini";

export const NAME_INSTRUCTIONS =
  "You read a phone call transcript from an eye-care practice. Lines start with AGENT: or CALLER:. " +
  "Return the first and last name of the PATIENT the call is about, as the CALLER said or spelled it. " +
  "If the caller is calling about someone else (a relative, or a pharmacy or doctor's office calling about a patient), " +
  "return that patient's name, not the caller's. If the caller is the patient, return their own name. " +
  "Use only names the CALLER said. Never use a name only the AGENT said. " +
  "If the first name or the last name was not said, return null for it. Do not guess. " +
  'Answer with JSON only: {"first_name": string or null, "last_name": string or null}.';

let client: OpenAI | null = null;

/** The production asker. Null when there is no key, or on any failure. */
export const askModelForThePatientName: NameAsker = async (transcript) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !transcript.trim()) return null;
  client ??= new OpenAI({ apiKey: key, timeout: NAME_REQUEST_TIMEOUT_MS, maxRetries: 0 });
  const res = await client.chat.completions.create({
    model: NAME_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: NAME_INSTRUCTIONS },
      { role: "user", content: transcript },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  const parsed = JSON.parse(text) as { first_name?: unknown; last_name?: unknown };
  return {
    firstName: typeof parsed.first_name === "string" ? parsed.first_name : null,
    lastName: typeof parsed.last_name === "string" ? parsed.last_name : null,
  };
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** The caller's words as tokens, plus runs of spelled letters joined ("L A K E" -> "lake"). */
function callerTokens(transcript: string): Set<string> {
  const lines = transcript
    .split(/\r?\n/)
    .filter((l) => /^\s*CALLER\s*:/i.test(l))
    .map((l) => l.replace(/^\s*CALLER\s*:/i, ""));
  const tokens = new Set<string>();
  for (const line of lines) {
    const words = fold(line).split(" ").filter(Boolean);
    let run = "";
    for (const w of words) {
      tokens.add(w);
      if (w.length === 1) run += w;
      else {
        if (run.length >= 2) tokens.add(run);
        run = "";
      }
    }
    if (run.length >= 2) tokens.add(run);
  }
  return tokens;
}

/** Every word of both names is in the caller's own lines. */
export function nameWasSaidByTheCaller(transcript: string, name: HeardName): boolean {
  const tokens = callerTokens(transcript);
  const words = [...fold(name.firstName).split(" "), ...fold(name.lastName).split(" ")].filter(Boolean);
  return words.length >= 2 && words.every((w) => tokens.has(w));
}

function usable(part: string | null | undefined): string | undefined {
  const cleaned = String(part ?? "").trim().replace(/\s+/g, " ");
  if (!cleaned || /\d/.test(cleaned)) return undefined;
  const folded = fold(cleaned);
  if (folded.replace(/ /g, "").length < 2) return undefined;
  if (folded.split(" ").every((w) => APP_PLACEHOLDER_NAME_WORDS.includes(w))) return undefined;
  return cleaned;
}

/**
 * The patient's name from the recording, or null. Never throws; the caller
 * of this is a teardown filer with nobody watching.
 */
export async function nameFromTheRecording(
  transcript: string,
  ask: NameAsker = askModelForThePatientName,
): Promise<HeardName | null> {
  let answer: Awaited<ReturnType<NameAsker>> = null;
  try {
    answer = await ask(transcript);
  } catch (e) {
    // The message only: an error body could carry the transcript.
    console.warn(`[NAME FROM RECORDING] the model did not answer (${(e as Error).name})`);
    return null;
  }
  const firstName = usable(answer?.firstName);
  const lastName = usable(answer?.lastName);
  if (!firstName || !lastName) return null;
  const name = { firstName, lastName };
  if (!nameWasSaidByTheCaller(transcript, name)) {
    // PHI-free: that it happened, never what the name was.
    console.warn("[NAME FROM RECORDING] the model named someone the caller did not say — not used");
    return null;
  }
  return name;
}
