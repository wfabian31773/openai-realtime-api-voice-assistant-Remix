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
 *   2. The model's answer is CHECKED: the caller must have said it as ONE
 *      name, in one of their own turns — the first and last name together,
 *      either order, with nothing between but spelled letters, an initial or
 *      words like "my last name is". A name the model made up, took from the
 *      agent, or put together from two people the caller named, never reaches
 *      a ticket.
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
import { NAME_SCAFFOLDING } from "./nameScaffolding";

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

/**
 * Words that may stand between the two halves of ONE spoken name. A word not
 * on this list between them means two names, or a name and something else.
 * The request sweep reads the same list (`nameScaffolding.ts`).
 */
const BETWEEN_ONE_NAME = new Set(NAME_SCAFFOLDING);

/** One place in a caller's turn: the words it can stand for, and whether it may sit inside one name. */
interface Spot {
  words: Set<string>;
  between: boolean;
  /** Spelled letters or an initial, not a word the caller said whole. */
  spelled?: true;
  /** v195: a spelled run's pieces between full stops, in order ("T E S T A. L A K E." -> testa, lake). */
  parts?: string[];
  /** v195: a full stop outside a spelled run — a sentence ended here. */
  stop?: true;
  /** v195: what a spelled run reads as when it is the whole name (Codex round 5 on #442). */
  runs?: string[];
}

/**
 * A caller's turn as places. A run of single letters is ONE place standing for
 * the letters joined ("L A K E" -> "lake"); a full stop inside the run also
 * ends a word, so "L A K E. I need" stands for "lake" as well as "lakei"
 * (Codex P2 on #431), while "L. A. K. E." still reads "lake". A single letter
 * alone is an initial. Spelled letters and initials may sit inside a name.
 *
 * v195 (review of #431): a full stop outside a run is kept as a place of its
 * own, so a sentence break between two whole words can end a name (see
 * `saidTogether`). A run with no full stop after its last letter is NOT also
 * read without that letter: "L A K E, I need" stays "lakei", because reading
 * "V O R L I" as "vorl" too would validate a surname the caller never spelled
 * (Codex P2 on #442), and the shape refused no measured correct name.
 */
/** One-letter words a sentence can start with straight after a spelled run ("… L A K E. I need"). */
const SENTENCE_START: ReadonlySet<string> = new Set(["i", "a", "y"]);

function spots(line: string): Spot[] {
  const raw = line
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.!?]+/g, " . ")
    .replace(/[^a-z.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: Spot[] = [];
  let letters: string[] = [];
  const flush = () => {
    const only = letters.filter((l) => l !== ".");
    if (only.length === 1) out.push({ words: new Set(only), between: true, spelled: true });
    else if (only.length >= 2) {
      const words = new Set([only.join("")]);
      const parts = letters.join("").split(".").filter(Boolean);
      for (const part of parts) if (part.length >= 2) words.add(part);
      // The readings of the run as ONE whole name: every letter, or every
      // letter but a one-letter word that starts the next sentence straight
      // after a piece of two letters or more ("… L A K E. I need").
      const runs = [only.join("")];
      const tail = parts[parts.length - 1];
      if (parts.length >= 2 && tail.length === 1 && SENTENCE_START.has(tail) && parts[parts.length - 2].length >= 2) {
        runs.push(parts.slice(0, -1).join(""));
      }
      out.push({ words, between: true, spelled: true, parts, runs });
    }
    letters = [];
  };
  for (const t of raw) {
    if (t === ".") {
      if (letters.length) letters.push(".");
      else out.push({ words: new Set(), between: true, stop: true });
      continue;
    }
    if (t.length === 1) {
      letters.push(t);
      continue;
    }
    flush();
    out.push({ words: new Set([t]), between: BETWEEN_ONE_NAME.has(t) });
  }
  flush();
  return out;
}

/** Where `seq` (a name half, word by word) ends if it starts at place `i`, else -1. */
function matchAt(sp: Spot[], i: number, seq: string[]): number {
  if (i >= sp.length) return -1;
  if (seq.length > 1 && sp[i].words.has(seq.join(""))) return i + 1; // a multi-word half spelled out
  let j = i;
  for (const w of seq) {
    if (j >= sp.length || !sp[j].words.has(w)) return -1;
    j += 1;
  }
  return j;
}

/**
 * `a` then `b` in this turn, with only what may sit inside one name between them.
 *
 * v195: NOT A BARE FULL STOP BETWEEN TWO WHOLE WORDS. "about Testa. Lake
 * Pharmacy here" is two sentences, not the name Testa Lake (review of #431).
 * A full stop followed by "my last name is" or by a spelling is still one
 * person giving one name: measured on verified callers 2026-10-10..11-09,
 * 28 of 728 said their own name across a full stop, and only 1 of them said
 * it no other way than across a bare one. A spelled half on either side is
 * unchanged.
 */
function saidTogether(sp: Spot[], a: string[], b: string[]): boolean {
  for (let i = 0; i < sp.length; i++) {
    const end = matchAt(sp, i, a);
    if (end < 0) continue;
    let onlyStops = true;
    for (let k = end; k < sp.length; k++) {
      if (matchAt(sp, k, b) >= 0) {
        const bareStop = k > end && onlyStops && !sp[end - 1].spelled && !sp[k].spelled;
        if (!bareStop) return true;
      }
      if (!sp[k].between) break;
      if (!sp[k].stop) onlyStops = false;
    }
  }
  return false;
}

/**
 * v195: both halves spelled in one run ("T E S T A L A K E") are one place
 * standing for the whole name, which matches neither half alone (review of
 * #431: 10 of about 750 verified callers' names came out whole only this way,
 * 2026-10-10..11-09, every one plain letters with no full stop anywhere
 * inside). The model's name must be every letter of the run, in order, and
 * nothing else — no letter dropped or added (that is what refusing the i/a
 * strip keeps true, Codex P2 on #442). Where the first name ends and the last
 * begins is the model's reading.
 *
 * A run with a full stop between two pieces of two letters or more ("T E S T
 * A. L A K E.", "… L A K E. S M I T H.") is NEVER read as a whole name: the
 * stop is a boundary the transcriber wrote, any reading of the pieces either
 * crosses it or leaves a piece out (three Codex P2s on #442), and none of the
 * 10 was that shape. One-letter pieces ("T. E. S. T. A.") mark no boundary.
 *
 * The match is against the WHOLE run, never one of its pieces (Codex round 5
 * on #442: "T E S T A L A K E. S. M. I. T. H." validated "Testa Lake" while
 * the caller spelled more). The one exception is a one-letter word starting
 * the next sentence straight after the run (`runs` in `spots`).
 */
function spelledWhole(sp: Spot[], a: string[], b: string[]): boolean {
  const whole = a.join("") + b.join("");
  return sp.some((s) => {
    if (s.spelled !== true) return false;
    const bounded = (s.parts ?? []).filter((p) => p.length >= 2).length >= 2;
    return !bounded && (s.runs ?? []).includes(whole);
  });
}

/**
 * The caller said this as ONE name, in one of their own turns: first and last
 * together, either order ("Jones, Mary"). Each word appearing somewhere in the
 * caller's lines is not enough (Codex P1 on #431): a clinic caller who gives
 * her own name and the patient's would otherwise validate a model answer that
 * crossed the two. A name given across two turns does not count; that call
 * files nothing, as before.
 */
export function nameWasSaidByTheCaller(transcript: string, name: HeardName): boolean {
  const first = fold(name.firstName).split(" ").filter(Boolean);
  const last = fold(name.lastName).split(" ").filter(Boolean);
  if (!first.length || !last.length) return false;
  return transcript
    .split(/\r?\n/)
    .filter((l) => /^\s*CALLER\s*:/i.test(l))
    .map((l) => spots(l.replace(/^\s*CALLER\s*:/i, "")))
    .some(
      (sp) =>
        saidTogether(sp, first, last) ||
        saidTogether(sp, last, first) ||
        spelledWhole(sp, first, last) ||
        spelledWhole(sp, last, first),
    );
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
