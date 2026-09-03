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
    const y =
      mdy[3].length === 2
        ? String(expandTwoDigitYear(Number(mdy[3]), Number(mdy[1]), Number(mdy[2])))
        : mdy[3];
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

/**
 * A two-digit year — and NOBODY HAS A BIRTHDAY IN THE FUTURE.
 *
 * The pivot has always been "over 30 means 19xx", which quietly breaks for the
 * oldest patients on the line. On 2026-09-03 a caller rang tech about
 * prescriptions for a relative in a care centre and gave "11 24 26": born
 * November 1926, ninety-nine years old. The pivot read it as 2026, a date
 * eleven weeks from now, and the year check let it through because 2026 is
 * this year.
 *
 * A wrong date of birth silently matches the wrong patient, which every
 * comment in this file says is worse than no date at all — and this one is
 * wrong by a century, on exactly the patients least able to ring back and
 * correct it.
 *
 * So the pivot is a first guess and the calendar is the arbiter: a two-digit
 * year that lands in the future is the other century. Nothing else changes —
 * "5 8 39" was already 1939 and stays 1939.
 */
function expandTwoDigitYear(y: number, month: number, day: number, now = new Date()): number {
  const guess = y > 30 ? 1900 + y : 2000 + y;
  // Month is 1-based here, 0-based in Date.
  const asDate = new Date(guess, month - 1, day);
  return asDate.getTime() > now.getTime() ? guess - 100 : guess;
}

/** Words that may sit between a day and its month: "17 DE febrero", "17 OF March". */
const LINKING_WORDS = new Set(['de', 'of', 'del']);

/**
 * Is the day next to the month word, give or take a linking word?
 *
 * The day is whichever number sits nearest the month name — either side, since
 * both "August 10" and "10 August" are ordinary. Anything further away, or
 * separated by a real word, means the month word is part of a sentence rather
 * than part of a date.
 */
function dayTouchesMonth(words: string[], monthAt: number, nums: { at: number }[]): boolean {
  if (monthAt < 0 || nums.length === 0) return false;
  return nums.some((n) => {
    const lo = Math.min(n.at, monthAt);
    const hi = Math.max(n.at, monthAt);
    if (hi - lo === 1) return true;
    for (let i = lo + 1; i < hi; i += 1) {
      if (!LINKING_WORDS.has(words[i]!)) return false;
    }
    return hi - lo > 0;
  });
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

  if (monthFromName !== null && !dayTouchesMonth(words, monthNameAt, nums)) {
    /**
     * A MONTH WORD FAR FROM ITS DAY IS NOT A DATE — it is an English sentence
     * that happens to contain one.
     *
     * Codex, on this PR: adding `ago` (agosto) and `set` (setiembre) as month
     * abbreviations broke English utterances. Verified exactly as reported:
     *
     *   "birthdate 5 13 45 a long time ago"  ->  nothing, a real date lost
     *   "he was born 10 years ago in 2016"   ->  2016-08-10, INVENTED
     *
     * The second is the outcome this file exists to prevent: a wrong birthday
     * on a real ticket, quietly matching the wrong patient.
     *
     * Dropping those two abbreviations would have closed exactly those two
     * examples and left the class open — "may" is an English word too, and
     * "he may have been born 10 years ago in 2016" fabricates the same way.
     * So the rule is structural instead: the DAY has to sit beside its month,
     * with nothing between them but a linking word. Every real form still
     * passes — "August 10, 1962", "17 de febrero 1958", "17 March 1973" — and
     * a month word loose in a sentence stops being read as a month at all,
     * which lets the numeric path have the date it was always going to find.
     */
    monthFromName = null;
    monthNameAt = -1;
  }

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

  if (year < 100) year = expandTwoDigitYear(year, month, day);
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
  const full = FULL_MONTHS[w];
  if (full) return full;
  // Abbreviations, exactly as written — never a prefix of a longer word, which
  // is how "Marcus" used to become March.
  if ((w.length === 3 || w === 'sept') && ABBREVIATED_MONTHS[w]) return ABBREVIATED_MONTHS[w];
  return undefined;
}

/**
 * ENGLISH AND SPANISH.
 *
 * Southern California, and the practice takes Spanish calls every day: 285 of
 * them on the queue lines in the fortnight to 2026-09-03, filing at a HIGHER
 * rate than English. The month table was English-only until a patient rang
 * tech at 22:23 that day, gave her whole request in Spanish including
 * "mi fecha de nacimiento es 17 de febrero 1958", and had it refused — her
 * insurance had stopped covering her eye drops and she needed the prescription
 * changed. Nothing was filed.
 *
 * I had rewritten this parser an hour earlier and never asked what language
 * the month would be in.
 *
 * The stray "de" costs nothing: the reader takes month words and numbers and
 * ignores everything else, so "17 de febrero 1958" is a day, a month and a
 * year with a preposition in the middle.
 *
 * NOT YET HERE, and they are real callers on these lines: Tagalog, Korean,
 * Armenian, Farsi, Vietnamese, Russian and Arabic all appear in the runtime's
 * own language table. A caller giving a date in any of them is still refused.
 * That is a known gap rather than an oversight, and it needs the same evidence
 * these two have before it is filled — which months actually arrive, spelled
 * how, in real transcripts.
 */
const FULL_MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',

  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};

/** Three letters, plus the one four-letter form people actually write. */
const ABBREVIATED_MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
  /**
   * Spanish abbreviations that differ from the English ones, `ago` (agosto)
   * and `set` (setiembre) INCLUDED even though both are English words.
   *
   * They were dropped for one round as a second lock after Codex found them
   * fabricating dates. A mutation then showed the lock was redundant: with the
   * adjacency rule above, putting them back kills no test, because a month word
   * loose in an English sentence is no longer read as a month at all. And they
   * are not free to drop — "5 ago 1945" is a real Spanish date, and refusing
   * it would trade a fixed bug for a new one.
   *
   * Two rules for one hazard is one place for them to drift apart. The
   * structural rule stays; the blocklist goes. The rest — feb, mar, may, jun,
   * jul, oct, nov — are already the same three letters in both languages.
   */
  ene: '01', abr: '04', ago: '08', set: '09', dic: '12',
};

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function valid(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > DAYS_IN_MONTH[mo]) return false;
  // A birth year before living memory is a mis-hear — and a birthday in the
  // FUTURE is one however plausible its year looks. 2026-11-24 passed the year
  // check on 2026-09-03 and was eleven weeks away.
  if (y < 1900) return false;
  return new Date(y, mo - 1, d).getTime() <= Date.now();
}
