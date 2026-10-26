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
  'answering-service': ['medications', 'locations', 'providers'],
  /**
   * The after-hours family takes EVERY department's calls — overnight, at
   * weekends, and across the holiday weekends when it is the only line
   * running. Measured over 5,552 substantive calls since 2026-08-01:
   * appointments 1,622 · medications 1,367 · records 896 · surgery 827 ·
   * optical 672. So it needs all three vocabularies, not a specialist's.
   *
   * Medications lead because they are the words ASR can least afford to
   * guess: an office is a place name it can approximate ("Long Beach"), a
   * drug is an invented proper noun it cannot. That ordering is a judgement;
   * the traffic mix behind it is measured.
   */
  'no-ivr': ['medications', 'providers', 'locations'],
  'no-ivr-v2': ['medications', 'providers', 'locations'],
  'dev-no-ivr': ['medications', 'providers', 'locations'],
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
  const seen = new Set<string>();

  /**
   * DRAWN ROUND-ROBIN, NOT SOURCE BY SOURCE.
   *
   * The old loop drained each source completely before starting the next, so
   * a lane whose FIRST source is bigger than MAX_KEYTERMS never reached its
   * second. With 105 locations against 100 slots that was not a corner case:
   * measured 2026-09-05, optical, records and answering-service each sent 100
   * location names and ZERO provider names, and answering-service had never
   * sent one of the medications its order declares. Nothing failed and
   * nothing logged; the lane simply could not hear a surgeon's name.
   *
   * Both directory lists are ranked by real volume and both have long tails,
   * so the marginal value is steeply unequal — the 60th-busiest office is
   * worth much less to a transcriber than the busiest surgeon. Taking one
   * from each source per round spends the hundred slots on the head of every
   * list instead of the whole of one.
   *
   * THE ROUNDS ARE WEIGHTED, because an even split throws away the ordering.
   * Plain round-robin gave surgery 50 providers and 50 locations where it had
   * held 77 providers — and surgery is assigned BY SURGEON, so that is a real
   * loss dressed up as fairness. Each source draws `order.length - index`
   * terms per round: with two sources the leader takes two to the other's one,
   * with three it is 3:2:1. Priority decides how MUCH, never whether.
   *
   * A source that runs dry simply stops contributing and the others take the
   * remaining slots, so a short medication list does not cap the lane.
   */
  const cursors = order.map((source, index) => ({
    /** Ranked candidates for this source, in the order they should be spent. */
    terms: source === 'medications' ? [...vocab.medications] : namesOf(vocab[source]),
    at: 0,
    /** Draws per round. The lane's first source draws the most. */
    weight: order.length - index,
  }));

  const out: string[] = [];
  let drewSomething = true;
  while (out.length < MAX_KEYTERMS && drewSomething) {
    drewSomething = false;
    for (const cursor of cursors) {
      for (let drawn = 0; drawn < cursor.weight; drawn += 1) {
        if (out.length >= MAX_KEYTERMS) break;
        // Advance past anything unusable rather than spending the draw on it:
        // a term the API would silently discard is worse than an absent one.
        let took = false;
        while (cursor.at < cursor.terms.length) {
          const term = (cursor.terms[cursor.at] ?? '').trim();
          cursor.at += 1;
          if (!term || term.length > MAX_KEYTERM_CHARS) continue;
          const dedupe = term.toLowerCase();
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.push(term);
          drewSomething = true;
          took = true;
          break;
        }
        if (!took) break; // this source is exhausted
      }
      if (out.length >= MAX_KEYTERMS) break;
    }
  }

  return out.length > 0 ? out : undefined;
}
