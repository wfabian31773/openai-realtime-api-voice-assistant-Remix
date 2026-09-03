/**
 * src/runtime/keyterms.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The domain vocabulary Grok's transcriber is biased toward, per lane.
 *
 * WHY THIS EXISTS. `audio.input.transcription.keyterms` biases ASR toward
 * terms it would otherwise mangle — proper nouns, drug names, office names.
 * The runtime never sent it. Instead the prompts asked the MODEL to cope with
 * mis-hearing, which is the wrong layer and cannot work: tech's prompt still
 * says "Medication names are hard to hear. If you are not sure you caught one,
 * ask them to say it again" — an instruction that only fires AFTER the word was
 * already lost, and costs the caller a repeat every time.
 *
 * The operator, 2026-09-03: *"use the keyterms, and the other options grok
 * gives you to improve the agent, not the prompts."*
 *
 * THE LIMITS ARE THE API'S: at most 100 terms, each at most 50 characters.
 * Over either and the term is dropped rather than the request refused, so a
 * silent truncation is the failure shape to avoid — hence the ranking below
 * rather than an arbitrary slice.
 *
 * RANKED BY REAL VOLUME. Both directory tables carry `volume90d` — appointments
 * in the last ninety days. A surgeon nobody has seen since spring is not worth
 * one of a hundred slots; the busiest names are the ones callers actually say.
 * Ties break alphabetically so the list is deterministic and two runs of the
 * same snapshot produce the same session config.
 *
 * PER LANE, because the lanes hear different words. Surgery is assigned BY
 * SURGEON, so surgeon names lead there. Optical assigns by LOCATION. Tech is
 * the medication queue, so drug names lead — and that list is the practice's
 * own, lifted from the Medication Requests reason in
 * `config/answeringServiceTicketing.ts`, not one invented here.
 *
 * NOTHING HERE IS PHI. Provider names, office names and drug names are the
 * practice's own reference data — no patient appears in a keyterm, and no
 * caller's words reach this file.
 */

/** The API's hard caps. Exceeding either drops terms silently. */
export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_CHARS = 50;

export interface VocabularyEntry {
  /** As the practice writes it, e.g. "Talin Khachatoor Sarkissian, O.D." */
  canonical: string;
  /** Appointments in the last 90 days; 0 means not currently seeing patients. */
  volume90d: number;
}

export interface Vocabulary {
  providers: readonly VocabularyEntry[];
  locations: readonly VocabularyEntry[];
  /** Practice-authored drug and pharmacy vocabulary. No volume to rank on. */
  medications: readonly string[];
}

/**
 * Credentials help nobody hear a name. "Talin Khachatoor Sarkissian, O.D."
 * biases the transcriber toward a string no caller will ever say; the name
 * without it is what comes out of a patient's mouth.
 *
 * Also drops a leading honorific for the same reason — "Dr" is already the
 * commonest word on these calls and needs no help.
 */
export function speakableName(canonical: string): string {
  return canonical
    .replace(/,\s*(M\.?D|D\.?O|O\.?D|Ph\.?D|F\.?A\.?C\.?S)\.?\b.*$/i, '')
    .replace(/^\s*(Dr|Doctor|Mr|Mrs|Ms|Miss)\.?\s+/i, '')
    .trim();
}

/** Highest volume first; alphabetical within a tie so runs are reproducible. */
function byVolumeThenName(a: VocabularyEntry, b: VocabularyEntry): number {
  if (b.volume90d !== a.volume90d) return b.volume90d - a.volume90d;
  return a.canonical.localeCompare(b.canonical);
}

function namesOf(entries: readonly VocabularyEntry[]): string[] {
  return [...entries].sort(byVolumeThenName).map((e) => speakableName(e.canonical));
}

/**
 * Which vocabulary leads on which lane. The order is the priority order when
 * the hundred slots run out — and with 77 providers and 105 locations on file
 * they always do.
 */
const LANE_ORDER: Record<string, readonly ('providers' | 'locations' | 'medications')[]> = {
  surgery: ['providers', 'locations'],
  optical: ['locations', 'providers'],
  tech: ['medications', 'providers', 'locations'],
  records: ['locations', 'providers'],
  'answering-service': ['locations', 'providers', 'medications'],
};

/** The order used for a lane with no entry of its own. */
const DEFAULT_ORDER = ['locations', 'providers'] as const;

/**
 * Build one lane's keyterm list.
 *
 * Returns `undefined` rather than `[]` when there is nothing to send: the
 * field is then omitted from session.update entirely, which is what an
 * unreachable directory should look like. An empty array is a claim that the
 * practice has no vocabulary.
 */
export function selectKeyterms(vocab: Vocabulary, lane: string): string[] | undefined {
  const order = LANE_ORDER[lane] ?? DEFAULT_ORDER;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const source of order) {
    const candidates =
      source === 'medications' ? [...vocab.medications] : namesOf(vocab[source]);
    for (const raw of candidates) {
      if (out.length >= MAX_KEYTERMS) break;
      const term = raw.trim();
      // Silently-dropped terms are worse than absent ones: skip anything the
      // API would discard, rather than spending a slot on it.
      if (!term || term.length > MAX_KEYTERM_CHARS) continue;
      const dedupe = term.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(term);
    }
    if (out.length >= MAX_KEYTERMS) break;
  }

  return out.length > 0 ? out : undefined;
}
