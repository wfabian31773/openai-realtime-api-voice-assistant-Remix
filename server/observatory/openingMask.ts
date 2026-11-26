/**
 * server/observatory/openingMask.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OPENINGS PANEL SHOWS GREETINGS, NOT PATIENTS.
 *
 * The Observatory's Openings tab lists the agents' actual first lines. Since
 * the named greeting came back (standing instruction 16) those lines carry the
 * caller's first name: "Am I speaking with <name>?" on the queue lanes and
 * "May I speak with <name>?" on NPX outreach. Measured 2026-11-26 over 7 days:
 * 111 of 113 NPX outreach first lines named a patient, and the panel listed 83
 * different ones, each a patient's name sent to the browser. Masked, the same
 * lines are 4 greetings, which is what the panel is for (did the agent open
 * with the configured greeting?).
 *
 * The page also received the first three agent lines of each lane's newest
 * call (names, dates of birth read back, appointments) and never displayed
 * them; that query is removed rather than masked.
 *
 * The mask errs toward masking: anything after "speaking with" up to the next
 * punctuation is replaced, and a one-to-three-word capitalised greeting after
 * "Hello," or "Hi," is too. A masked "Hello, Thanks." costs nothing; a name
 * left on the page is the defect.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const NAME_PLACEHOLDER = '[name]';

/** Asks for a person by name: everything up to the next punctuation is the name. */
const ASKS_FOR_A_PERSON =
  /\b(am i speaking with|am i talking (?:with|to)|may i (?:please )?speak (?:with|to)|can i (?:please )?speak (?:with|to)|is this|hablo con|estoy hablando con|puedo hablar con)\s+(?!\[name\])[^?.!,;\n]{1,60}/gi;

/** A greeting that addresses the person: "Hello, Maria." / "Hi Maria Lopez,". */
// No `i` flag: under /iu, \p{Lu} also matches lower-case letters, and the
// name must be capitalised so "Hello, this is Azul Vision" is left alone.
const ADDRESSES_A_PERSON =
  /\b([Hh]ello|[Hh]i|[Hh]ey|[Hh]ola|[Gg]ood (?:morning|afternoon|evening)|[Bb]uenos días|[Bb]uenas tardes)(,?\s+)(?!\[name\])(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2})(?=\s*[?.!,;]|\s*$)/gu;

/** The opening line with any person's name replaced by [name]. */
export function maskOpening(text: string): string {
  let out = text.replace(ASKS_FOR_A_PERSON, (_m, lead: string) => `${lead} ${NAME_PLACEHOLDER}`);
  out = out.replace(ADDRESSES_A_PERSON, (_m, lead: string, gap: string) => `${lead}${gap}${NAME_PLACEHOLDER}`);
  return out;
}

export interface OpeningRow {
  agent_slug: string;
  opening: string;
  n: number;
}

/**
 * Masks each opening, truncates it to `width` AFTER masking (so a name cut in
 * half by the truncation is still masked), and re-counts identical masked
 * openings. Returns at most `perAgent` openings per agent, most common first.
 */
export function aggregateOpenings(
  rows: OpeningRow[],
  width = 120,
  perAgent = 6,
): Map<string, Array<{ opening: string; n: number }>> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.opening) continue;
    const masked = maskOpening(r.opening).slice(0, width);
    if (masked.length <= 12) continue;
    const byText = counts.get(r.agent_slug) ?? new Map<string, number>();
    byText.set(masked, (byText.get(masked) ?? 0) + Number(r.n));
    counts.set(r.agent_slug, byText);
  }
  const out = new Map<string, Array<{ opening: string; n: number }>>();
  for (const [slug, byText] of counts) {
    const sorted = [...byText.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, perAgent)
      .map(([opening, n]) => ({ opening, n }));
    out.set(slug, sorted);
  }
  return out;
}
