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
    const mo = monthNumberFromWord(spokenMonth[1]!);
    if (!mo) return '';
    const d = spokenMonth[2].padStart(2, '0');
    return valid(spokenMonth[3], mo, d) ? `${spokenMonth[3]}-${mo}-${d}` : '';
  }

  // "17 March 1973"
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(raw);
  if (dayFirst) {
    const mo = monthNumberFromWord(dayFirst[2]!);
    if (!mo) return '';
    const d = dayFirst[1].padStart(2, '0');
    return valid(dayFirst[3], mo, d) ? `${dayFirst[3]}-${mo}-${d}` : '';
  }

  /**
   * THE CALLER SAID A SENTENCE, NOT A DATE — SO READ THE DATE OUT OF IT.
   *
   * Every pattern above is anchored ^...$, so one surrounding word threw the
   * date away. On 2026-09-03 that was the direct cause of EIGHT calls where
   * the agent told the caller their request had been filed and nothing was:
   *
   *   "our date of birth is August 10, 1962"   a rescheduling team, 21:51
   *   "date of birth April 17, 1951"           a corneal graft, 21:50
   *   "My date of birth is June 17th, 1984"    glasses to collect, 21:40
   *   "birthdate 5 13 45"                      21:07
   *   "T O C C O 10 7 63"                      20:55
   *   "Date of birth is 7 26, 19 29"           antibiotics, 22:10
   *   "Stanley Morrell, 5 31, 19 44"           a surgery schedule, 22:12
   *   "March 17, 1973."                        a full stop is enough
   *
   * The bare date in most of them parsed perfectly. The tool's own schema
   * invites the sentence — date_of_birth is described to the model as "Any
   * spoken format" — so the model passing the utterance verbatim was the model
   * doing exactly as it was told.
   *
   * WHY THIS IS TOKENS AND NOT MORE REGEXES.
   *
   * The first attempt at this searched for the same anchored shapes inside the
   * string and defended itself with a rule that no digits could be left over,
   * so that a spoken phone number could never become a birthday. It cost two
   * more patients within the hour: "7 26, 19 29" is a caller saying "nineteen
   * twenty-nine", and the leftover rule threw the whole date away over the
   * stray "29".
   *
   * The operator settled it: *"if you are asking for a dob, you should treat
   * whatever they give you as a dob, not a phone number. Who will give you a
   * phone number when you ask for a dob? We should parse the date no matter
   * how they give it to us."*
   *
   * He is right, and the guard was defending against something that does not
   * happen. This function is only ever handed the `date_of_birth` ARGUMENT,
   * which the model fills after asking for a birthday. So the question stops
   * being "might this be a phone number" and becomes "what date did they say".
   *
   * WHAT STILL REFUSES, because these protect the patient rather than the
   * parser: a date that is not real (13/45, 30 February), a year outside
   * 1900..now, and a set of numbers that does not form ONE date. The shape
   * rule replaces the leftover rule and does the same work more honestly — a
   * phone number is six numeric groups and assembles into nothing.
   */
  return readDateFromAnything(raw);
}

/** Ordinals, separators and punctuation gone; month names left in place. */
function flatten(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[\/\-.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two spoken halves of a year — "nineteen twenty-nine" reaches us as "19 29".
 *
 * No century check here, deliberately. An earlier version rejected anything
 * but 19xx and 20xx, and a mutation showed the check was dead: valid() already
 * bounds the year to 1900..today, and every pair inside that range has 19 or
 * 20 as its first half by arithmetic. Two rules saying the same thing is one
 * rule and one place for them to drift apart, so this keeps the one that also
 * catches every other way a year can be wrong.
 */
function joinSplitYear(hi: number, lo: number): number | null {
  if (lo < 0 || lo > 99) return null;
  return hi * 100 + lo;
}

/** A two-digit year, on the same pivot the anchored branch has always used. */
function expandTwoDigitYear(y: number): number {
  return y > 30 ? 1900 + y : 2000 + y;
}

function readDateFromAnything(raw: string): string {
  const flat = flatten(raw);
  if (!flat) return '';

  // Where the month name sits decides month-first from day-first.
  let monthFromName: number | null = null;
  let monthNameAt = -1;
  const words = flat.split(' ');
  words.forEach((w, i) => {
    const m = monthNumberFromWord(w);
    if (m && monthFromName === null) {
      monthFromName = Number(m);
      monthNameAt = i;
    }
  });

  const nums: { value: number; at: number; digits: number }[] = [];
  words.forEach((w, i) => {
    if (/^\d+$/.test(w)) nums.push({ value: Number(w), at: i, digits: w.length });
  });

  /**
   * A YEAR IS TWO DIGITS OR FOUR, NEVER ONE. "9 2 4" is somebody being cut off
   * mid-word, not the year 2004, and reading it as a date would put a wrong
   * birthday on a ticket. Enforced on the token rather than the number so a
   * leading zero cannot smuggle one through.
   */
  const yearDigitsOk = (n: { digits: number }) => n.digits === 2 || n.digits === 4;

  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;

  if (monthFromName !== null) {
    // "August 10 1962" / "10 August 1962" / "26 July 19 29"
    month = monthFromName;
    if (nums.length === 2) {
      if (!yearDigitsOk(nums[1]!)) return '';
      day = nums[0]!.value;
      year = nums[1]!.value;
    } else if (nums.length === 3) {
      // The day, then a year said in two halves.
      day = nums[0]!.value;
      const joined = joinSplitYear(nums[1]!.value, nums[2]!.value);
      if (joined === null) return '';
      year = joined;
    } else {
      return '';
    }
    // A day written AFTER the year reads wrong; the month's position tells us
    // nothing about that, so only accept the day before the year.
    if (nums[0]!.at > nums[nums.length - 1]!.at) return '';
  } else if (nums.length === 3) {
    if (!yearDigitsOk(nums[2]!)) return '';
    month = nums[0]!.value;
    day = nums[1]!.value;
    year = nums[2]!.value;
  } else if (nums.length === 4) {
    // "7 26 19 29" — month, day, and a year in two halves.
    month = nums[0]!.value;
    day = nums[1]!.value;
    const joined = joinSplitYear(nums[2]!.value, nums[3]!.value);
    if (joined === null) return '';
    year = joined;
  } else {
    // Anything else is not one date. Six numeric groups is a phone number and
    // assembles into nothing, which is the honest reason to refuse it.
    return '';
  }

  if (year < 100) year = expandTwoDigitYear(year);
  const mo = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  const y = String(year);
  if (!valid(y, mo, d)) return '';
  console.info(
    '[DOB] read a date of birth out of what the caller actually said — the words around it used to lose it',
  );
  return `${y}-${mo}-${d}`;
}

/**
 * A word that IS a month, not one that merely begins like one.
 *
 * The anchored branches read `MONTHS[word.slice(0, 3)]`, so "Marcus 17 1973"
 * has always parsed as March 17th — a WRONG date of birth on a real ticket,
 * which is the one outcome worse than no date at all. Found on 2026-09-03 by a
 * test written for the new reader; the bug predates it.
 */
export function monthNumberFromWord(word: string): string | undefined {
  const w = word.toLowerCase();
  if (FULL_MONTHS.has(w)) return MONTHS[w.slice(0, 3)];
  // Abbreviations only, exactly as written: "mar", "sept", "mar." handled by
  // the caller stripping the stop.
  if (w.length <= 4 && MONTHS[w.slice(0, 3)] && (w.length === 3 || w === 'sept')) {
    return MONTHS[w.slice(0, 3)];
  }
  return undefined;
}

const FULL_MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

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
