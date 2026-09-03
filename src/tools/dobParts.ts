/**
 * A spoken date of birth, split into the three parts create-ticket wants.
 *
 * `/api/voice-agent/create-ticket` takes patientBirthMonth / Day / Year as
 * separate strings, while everything a caller says arrives as one utterance.
 * The parsing itself is already solved — `normalizeDOB` in the schedule lookup
 * service handles "March 17th 1973", "03/17/1973", "3-17-73" and the rest, and
 * has a regression history behind it. This only splits its output, so the two
 * cannot drift apart.
 *
 * Returns null when the date cannot be parsed, which is a refusal the tool
 * turns into a re-ask rather than filing a ticket with a wrong birthday on it.
 */
export function normalizeDobParts(
  spoken: string,
): { month: string; day: string; year: string } | null {
  const iso = normalize(spoken);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  /**
   * DEPLOY MARKER AND LIVE COUNTER, 2026-09-03. Prints only for the form that
   * used to be refused, so its first appearance in the logs is proof the build
   * carrying this fix is live, and its rate afterwards is how often the gap was
   * actually costing a ticket. Never the value: a date of birth is PHI.
   */
  if (/^\d{1,2}\s+\d{1,2}\s+\d{2,4}$/.test(String(spoken ?? '').trim())) {
    console.info('[DOB] parsed a date of birth the caller said as bare digits — no separator');
  }
  return { year: m[1], month: m[2], day: m[3] };
}

/**
 * Reaches the same parser the agents use. Imported lazily and defensively: this
 * module is small and gets pulled into tool handlers, and the schedule service
 * opens a database pool at import time.
 */
function normalize(spoken: string): string {
  const raw = String(spoken ?? '').trim();
  if (!raw) return '';

  // Already ISO — the commonest case once an agent has read it back.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) {
    const y = iso[1];
    const mo = iso[2].padStart(2, '0');
    const d = iso[3].padStart(2, '0');
    return valid(y, mo, d) ? `${y}-${mo}-${d}` : '';
  }

  // m/d/y and m-d-y, including two-digit years. Anchored, because an
  // unanchored month/day/year pattern once matched the TAIL of an ISO date and
  // put 73/03/2017 on a ticket.
  //
  // SPACE IS A SEPARATOR TOO. A caller does not say "nine slash two slash
  // forty-eight" — they say "nine two forty-eight", and that is what lands in
  // the argument, because every filing tool describes this field as "any
  // spoken format". Until 2026-09-03 the separator class was punctuation only,
  // so "9 2 48" parsed as nothing: on CA60c32bb3 (tech, 20:40 UTC) the model
  // read the date back correctly as September 2nd 1948, called
  // file_tech_ticket five times, was refused for a missing date of birth every
  // time, and the call ended in dead air with no ticket filed.
  //
  // This widens the SEPARATOR only. The two-digit-year pivot below is
  // untouched, so nothing that was rejected for being an ambiguous YEAR starts
  // being accepted here — "9/2/48" and "9 2 48" now resolve the same way,
  // which is the whole point.
  const mdy = /^(\d{1,2})[\/\-.\s]+(\d{1,2})[\/\-.\s]+(\d{2}|\d{4})$/.exec(raw);
  if (mdy) {
    const mo = mdy[1].padStart(2, '0');
    const d = mdy[2].padStart(2, '0');
    const y = mdy[3].length === 2 ? (Number(mdy[3]) > 30 ? `19${mdy[3]}` : `20${mdy[3]}`) : mdy[3];
    return valid(y, mo, d) ? `${y}-${mo}-${d}` : '';
  }

  // "March 17, 1973" / "March 17th 1973" / "Mar 17 1973"
  const spokenMonth = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(raw);
  if (spokenMonth) {
    const mo = MONTHS[spokenMonth[1].toLowerCase().slice(0, 3)];
    if (!mo) return '';
    const d = spokenMonth[2].padStart(2, '0');
    return valid(spokenMonth[3], mo, d) ? `${spokenMonth[3]}-${mo}-${d}` : '';
  }

  // "17 March 1973"
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(raw);
  if (dayFirst) {
    const mo = MONTHS[dayFirst[2].toLowerCase().slice(0, 3)];
    if (!mo) return '';
    const d = dayFirst[1].padStart(2, '0');
    return valid(dayFirst[3], mo, d) ? `${dayFirst[3]}-${mo}-${d}` : '';
  }

  return '';
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function valid(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > DAYS_IN_MONTH[mo]) return false;
  // A birth year in the future, or before living memory, is a mis-hear.
  return y >= 1900 && y <= new Date().getFullYear();
}
