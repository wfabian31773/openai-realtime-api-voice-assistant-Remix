/**
 * WHAT THE AFTER-HOURS CALLER ALREADY SAID, FOR THE TICKET (v163).
 *
 * Tickets 70148/70149, 70150, 70157, 70160, 70162 and 70170 (2026-10-31..11-01)
 * reached staff with no date of birth and no request type. On 70150 the
 * caller answered the date-of-birth question twice before hanging up, and the
 * ticket still read `Unknown`: the teardown floor read the date of birth only
 * from a CERTAIN lookup match, and the live `create_ticket` filed an omitted
 * `date_of_birth` as a B2B "no DOB" without looking at what the caller said.
 *
 * The bridge already keeps the caller's answer to a date-of-birth ASK per call
 * (`spokenDob.ts`, the queue lanes' backstop since 2026-09-10). This module
 * reads it for the after-hours line, and classifies a floor-filed request with
 * department 8's own taxonomy so the ticket carries a request type.
 *
 * Static imports only: a dynamic import of a per-call store is a second empty
 * copy on Node 20 (v141).
 */
import { dobFromCallerAnswer, spokenDobFor } from '../tools/spokenDob';
import { classifyAfterHoursRequest, type AfterHoursClassification } from '../tools/afterHoursTaxonomy';
import { lookupLocation } from './consoleDirectory';
import { sanitizeLocationName } from './ticketFieldSanitizers';

/** `YYYY-MM-DD` -> `MM/DD/YYYY`, the shape every after-hours DOB parser reads. */
export function isoDobToUs(iso: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso?.trim() ?? '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : undefined;
}

/**
 * The date of birth the caller gave when asked, or undefined.
 *
 * The bridge's store first (it tracks corrections and refused attempts), then
 * the transcript itself, read by the same window rule — a date counts only in
 * the turn that answered a date-of-birth ask, never a mere mention.
 */
export function dobTheCallerGave(callSid: string | undefined, transcript?: string): string | undefined {
  const stored = isoDobToUs(spokenDobFor(callSid));
  if (stored) return stored;
  if (!transcript?.trim()) return undefined;
  return isoDobToUs(dobFromCallerAnswer(transcript.split('\n')));
}

/** An agent QUESTION about which office, English or Spanish, accents folded. */
const OFFICE_ASK = /\b(?:which|what|que|cual)\s+(?:[a-z]+\s+)?(?:office|location|clinic|oficina|clinica|consultorio|ubicacion)\b[^.?!]*\?/;
/** "Location" alone is ambiguous (a pharmacy's location); "office"/"clinic" is not. */
const AMBIGUOUS_ASK = /\b(?:which|what|que|cual)\s+(?:[a-z]+\s+)?(?:location|ubicacion)\b/;
/** A readback the caller can reject: "Covina, is that correct?". */
const CONFIRM_ASK = /\b(?:is that (?:correct|right)|correct|right|did you say|confirm|correcto|verdad)\b[^?]*\?/;
/** Readbacks about something other than the office. */
const NOT_OFFICE_TOPIC = /\b(?:pharmacy|farmacia|number|phone|callback|telefono|numero|birth|nacimiento|date|fecha|name|nombre)\b/;
const AFFIRM = /^(?:yes|yeah|yep|correct|right|that'?s right|si|correcto|exacto)\b/;
/** "Not Covina", "I don't go there", "no voy": a denial never names an office. "No, Covina" does. */
const DENIAL = /\b(?:not|never|nunca|anymore)\b|n['’]t\b|(?<!^)\bno\b|^no\b(?!\s*[,.])/;

const foldAccents = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** "Actually", "I mean", "perdón", "mejor dicho": the caller is correcting what they said. */
const CORRECTION = /\b(?:actually|i mean|i meant|sorry|correction|wait|perdon|quise decir|mejor dicho|en realidad)\b/;
const CORRECTION_ALL = new RegExp(CORRECTION.source, 'g');

/** The part of a line after its last correction cue ("Covina, actually Downey" -> " Downey"). */
function corrected(line: string): string {
  const folded = foldAccents(line);
  let end = -1;
  for (const m of folded.matchAll(CORRECTION_ALL)) end = m.index! + m[0].length;
  return end < 0 ? line : line.slice(end);
}

/**
 * The caller's words answering the LAST office ask, then any later caller line
 * that corrects it, in order. A later ask that drew an answer replaces an
 * earlier one; a mention elsewhere is not read.
 */
function officeAnswers(transcript: string): string[] {
  const lines = transcript.split('\n');
  let answers: string[] = [];
  // Whether the agent's previous QUESTION was an office ask: a bare follow-up
  // ("Which location?") borrows its topic from it, so after "Which pharmacy?"
  // it asks about the pharmacy, never the office.
  let lastQuestionWasOffice = false;
  let lastQuestionWasPharmacy = false;
  lines.forEach((line, i) => {
    if (!line.startsWith('AGENT: ') || !line.includes('?')) return;
    const folded = foldAccents(line);
    const prevWasOffice = lastQuestionWasOffice;
    // A pharmacy question ("which pharmacy should the office send it to?") is not an office ask.
    const matches = OFFICE_ASK.test(folded) && !/\b(?:pharmacy|farmacia)\b/.test(folded);
    const words = folded.slice('agent: '.length).split('?')[0].replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    // "Location" borrows its subject from the question before it: after a
    // pharmacy question it is the pharmacy's; bare, it needs an office ask before it.
    const ambiguous = AMBIGUOUS_ASK.test(folded);
    const bare = words.length <= 3;
    // A readback of the office ("Covina, correct?") keeps the office context for a re-ask.
    if (!matches && prevWasOffice && CONFIRM_ASK.test(folded) && !NOT_OFFICE_TOPIC.test(folded)) return;
    const isOffice = matches && (!ambiguous || prevWasOffice || (!bare && !lastQuestionWasPharmacy));
    lastQuestionWasOffice = isOffice;
    lastQuestionWasPharmacy = /\b(?:pharmacy|farmacia)\b/.test(folded) || (ambiguous && !isOffice && lastQuestionWasPharmacy);
    if (!isOffice) return;
    const said: string[] = [];
    let j = i + 1;
    for (; lines[j]?.startsWith('CALLER: '); j += 1) said.push(lines[j].slice('CALLER: '.length));
    if (!said.length) return;
    // A later caller turn corrects the office only until the agent asks
    // something else: "Sorry, I need a refill" after the next question is
    // not about the office.
    const corrections: string[] = [];
    for (let k = j; k < lines.length; k += 1) {
      const l = lines[k];
      // Any agent question closes the window, wherever its "?" falls.
      if (l.startsWith('AGENT: ')) {
        if (!l.includes('?')) continue;
        // A readback of the office keeps the window open: "No, Downey" corrects it.
        // Only a readback OF THE OFFICE: it names an office word or what the
        // caller answered, and is not about the pharmacy.
        const fl = foldAccents(l);
        const STOP = new Set(['usually', 'normally', 'that', 'this', 'there', 'office', 'the', 'one', 'yes', 'actually', 'sorry']);
        // Only a proper noun the caller said (an office name is capitalized), never "a refill".
        const echoes = [...said, ...corrections].some((a) => (corrected(a).match(/\p{Lu}[\p{L}]+/gu) ?? [])
          .map(foldAccents).some((w) => w.length >= 4 && !STOP.has(w) && new RegExp(`\\b${w}\\b`).test(fl)));
        if (!CONFIRM_ASK.test(fl) || NOT_OFFICE_TOPIC.test(fl)
          || !(echoes || /\b(?:office|location|clinic|oficina|clinica|consultorio|ubicacion)\b/.test(fl))) break;
        const turn: string[] = [];
        while (lines[k + 1]?.startsWith('CALLER: ')) { k += 1; turn.push(lines[k].slice('CALLER: '.length)); }
        const reply = turn.join(' ').trim();
        if (reply && (!AFFIRM.test(foldAccents(reply)) || CORRECTION.test(foldAccents(reply)))) corrections.push(reply);
        // "Yes" confirms the office the readback named ("The Downey office, correct?").
        else if (reply) corrections.push(l.slice('AGENT: '.length).split('?')[0]);
        continue;
      }
      if (!l.startsWith('CALLER: ') || !CORRECTION.test(foldAccents(l))) continue;
      // The whole correcting turn: transcription may split "Actually," and "Downey."
      const turn: string[] = [l.slice('CALLER: '.length)];
      while (lines[k + 1]?.startsWith('CALLER: ')) { k += 1; turn.push(lines[k].slice('CALLER: '.length)); }
      // "Sorry, the pharmacy is in Downey" corrects the pharmacy, not the office.
      if (!/\b(?:pharmacy|farmacia)\b/.test(foldAccents(turn.join(' ')))) corrections.push(turn.join(' '));
    }
    // The first answer turn, then each in-window line after it that corrects
    // it, then each later correcting line: the last one decides.
    // The whole answer turn (an in-window correction is resolved by `corrected`,
    // which keeps everything after the last cue), then each later correcting turn.
    answers = [said.join(' '), ...corrections];
  });
  return answers;
}

/**
 * The office the caller named when asked, as the directory files it, or
 * undefined. `lookupLocation` is the guard against a guess: it refuses a phrase
 * naming two offices and a city that only contains an office's name. A
 * correction to an office the directory does not know (or a denial) clears
 * the earlier office: the last answer decides, never a stale one. A directory
 * outage reads as no office and must never cost the floor its ticket.
 */
export async function officeTheCallerGave(transcript: string | undefined): Promise<string | undefined> {
  const answers = officeAnswers(transcript ?? '');
  const lastLine = answers.length > 1 ? answers[answers.length - 1] : answers[0];
  // Only the corrected portion counts: "Covina, actually Springfield" is Springfield.
  const last = lastLine === undefined ? undefined : corrected(lastLine).replace(/^[\s,.;:!-]+/, '');
  if (!last || DENIAL.test(foldAccents(last).trim())) return undefined;
  try {
    const office = await lookupLocation(last);
    return office ? office.fileAs || sanitizeLocationName(office.canonical).value || office.canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Department 8's request-type pair for a floor-filed request. Never null: an
 * unmatched request takes department 8's own "Other - See Description", so the
 * ticket carries a type the department owns instead of none.
 */
export function floorRequestType(callerText: string): AfterHoursClassification {
  return classifyAfterHoursRequest(callerText).classification;
}
