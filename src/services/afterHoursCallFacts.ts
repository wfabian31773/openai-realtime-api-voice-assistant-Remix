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
const NOT_OFFICE_TOPIC = /\b(?:pharmacy|farmacia|send|sent|records|fax|enviar|expediente|number|phone|callback|telefono|numero|birth|nacimiento|date|fecha|name|nombre)\b/;
/** A readback that names an office: a proper noun past the first word, or "<Name> office". */
function namesAnOffice(text: string): boolean {
  const clause = (text.split('?')[0].split(/[.!]/).pop() ?? '').trim();
  return /\p{Lu}/u.test(clause.replace(/^\S+/, '').replace(/\bI\b/g, ''))
    || /^\p{Lu}\p{L}+(?:\s*,|\s+(?:office|location|clinic)\b)/u.test(clause);
}
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
  for (const m of folded.matchAll(CORRECTION_ALL)) {
    const e = m.index! + m[0].length;
    // A later apology that names nothing ("Actually, Downey. Sorry, the connection is bad.")
    // does not undo the earlier correction.
    const clause = line.slice(e).split(/[.!;?]/)[0];
    if (end >= 0 && !/\p{Lu}\p{L}{3,}/u.test(clause)) continue;
    end = e;
  }
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
  let lastAnswerWords: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('AGENT: ') && !line.includes('?')
      && /\b(?:tell me|give me|provide|dime|deme|digame)\b/.test(foldAccents(line))) {
      // A statement request ("Tell me which pharmacy you use.") sets the topic like a question.
      lastQuestionWasOffice = false;
      lastQuestionWasPharmacy = /\b(?:pharmacy|farmacia)\b/.test(foldAccents(line));
      return;
    }
    if (!line.startsWith('AGENT: ') || !line.includes('?')) return;
    const folded = foldAccents(line);
    const prevWasOffice = lastQuestionWasOffice;
    // A pharmacy question ("which pharmacy should the office send it to?") is not an office ask.
    // "Which office should we send your records to?" asks for a destination, not the office visited.
    // The caller answers the LAST question on the line: "Which office…? Where should we deliver…?" is about delivery.
    const lastQuestion = ((folded.match(/[^?]*\?/g) ?? []).pop() ?? folded).split(/[.!]/).pop() ?? folded;
    const matches = OFFICE_ASK.test(lastQuestion) && !/\b(?:pharmacy|farmacia)\b/.test(lastQuestion)
      && !/\b(?:send|sent|fax|forward|transfer|mail|enviar|enviamos|mandar)\b/.test(lastQuestion);
    const words = folded.slice('agent: '.length).split('?')[0].replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    // "Location" borrows its subject from the question before it: after a
    // pharmacy question it is the pharmacy's; bare, it needs an office ask before it.
    const ambiguous = AMBIGUOUS_ASK.test(folded);
    const bare = words.length <= 3;
    // A readback of the office ("Covina, correct?") keeps the office context for a re-ask.
    if (!matches && prevWasOffice && (line.match(/\?/g) ?? []).length === 1 && CONFIRM_ASK.test(folded) && (lastAnswerWords.some((w) => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(folded)) || /\b(?:office|location|clinic|oficina|clinica|ubicacion)\b/.test(folded)) && !NOT_OFFICE_TOPIC.test(folded)) return;
    // A longer "location" question counts on its own only when it asks where the caller is seen.
    const visitWords = /\b(?:visit|usually|go|seen|normally|visita|va)\b/.test(folded);
    const isOffice = matches && (!ambiguous || prevWasOffice || (!bare && visitWords && !lastQuestionWasPharmacy));
    lastQuestionWasOffice = isOffice;
    lastQuestionWasPharmacy = /\b(?:pharmacy|farmacia)\b/.test(folded) || (ambiguous && !isOffice && lastQuestionWasPharmacy);
    if (!isOffice) return;
    const said: string[] = [];
    let j = i + 1;
    // An acknowledgment ("Take your time.") can sit between the ask and the answer.
    // A request for another fact ("Tell me which pharmacy you use.") closes the window.
    while (lines[j]?.startsWith('AGENT: ') && !lines[j].includes('?')) {
      if (NOT_OFFICE_TOPIC.test(foldAccents(lines[j])) || /\b(?:tell me|give me|provide|dime|deme|digame)\b/.test(foldAccents(lines[j]))) return;
      j += 1;
    }
    for (; lines[j]?.startsWith('CALLER: '); j += 1) said.push(lines[j].slice('CALLER: '.length));
    if (!said.length) return;
    lastAnswerWords = foldAccents(said.join(' ').split(/[,.;]/)[0] ?? '').split(/[^a-z]+/).filter((w) => !['usually','the','office','that','this'].includes(w));
    // A later caller turn corrects the office only until the agent asks
    // something else: "Sorry, I need a refill" after the next question is
    // not about the office.
    const corrections: string[] = [];
    let pendingReadback = false;
    // Every office the caller has named so far, for a later cue-less denial.
    // The office currently on the table: the latest correction, else the answer.
    const namedWords = () => [corrections.length ? corrections[corrections.length - 1] : said.join(' ')].flatMap((a) => foldAccents(corrected(a)).split(/[^a-z]+/))
      .filter((w) => w.length >= 4 && !['usually', 'normally', 'office', 'oficina', 'that', 'this', 'there', 'visit', 'visita', 'clinic', 'location', 'always'].includes(w));
    let pendingLine = '';
    // One reading of a reply to an office readback, prompt or delayed.
    const answerReadback = (reply: string, readback: string) => {
      const fr = foldAccents(reply);
      const fl = foldAccents(readback);
      const clause = (readback.slice('AGENT: '.length).split('?')[0].split(/[.!]/).pop() ?? '').trim();
      // "Yes, but my office is Downey" names a different office.
      const butTail = reply.split(/\b(?:but|pero)\b/i)[1];
      if (AFFIRM.test(fr) && butTail && /\b(?:office|oficina|clinic|clinica|go to|voy a|visit)\b/.test(foldAccents(butTail))
        && !DENIAL.test(foldAccents(butTail.replace(NOT_THAT, '')).trim())) { corrections.push(butTail.replace(NOT_THAT, '').trim()); return; }
      // "Yes, Covina or Downey" is still a guess between offices.
      if (/\b(?:or|o|either|both|ambos)\b/.test(fr)) { corrections.push(reply); return; }
      if (!AFFIRM.test(fr) || CORRECTION.test(fr) || (DENIAL.test(fr.replace(AFFIRM, ''))
        // "Yes, I do not go to Covina anymore" after "The Downey office, correct?" denies the OLD office.
        && !namedWords().some((w) => new RegExp(`\\b${w}\\b`).test(fr) && !new RegExp(`\\b${w}\\b`).test(fl)))) corrections.push(reply);
      // "Yes" confirms the office the readback named; a generic "Is that the correct office?" leaves the answer.
      else if (namesAnOffice(clause)) corrections.push(clause);
    };
    for (let k = j; k < lines.length; k += 1) {
      const l = lines[k];
      // Any agent question closes the window, wherever its "?" falls.
      if (l.startsWith('AGENT: ')) {
        if (!l.includes('?')) {
          if (/\b(?:tell me|give me|provide|dime|deme|digame)\b/.test(foldAccents(l)) || NOT_OFFICE_TOPIC.test(foldAccents(l))) break;
          continue;
        }
        // A readback of the office keeps the window open: "No, Downey" corrects it.
        // Only a readback OF THE OFFICE: it names an office word or what the
        // caller answered, and is not about the pharmacy.
        const fl = foldAccents(l);
        const STOP = new Set(['usually', 'normally', 'that', 'this', 'there', 'office', 'the', 'one', 'yes', 'actually', 'sorry']);
        // Only a proper noun the caller said (an office name is capitalized), never "a refill".
        // A short answer ("covina") is all name; a sentence offers only its proper nouns.
        const nameWords = (a: string) => { const c = corrected(a).replace(/^[\s,.;:!-]+/, '').replace(/^(?:no|yes|si|sí)\b[\s,.]*/i, ''); return c.trim().split(/\s+/).length <= 3 ? (c.split(/[,.;]/)[0] ?? '').split(/[^\p{L}]+/u) : (c.match(/\p{Lu}[\p{L}]+/gu) ?? []); };
        const echoes = [...said, ...corrections].some((a) => nameWords(a)
          .map(foldAccents).some((w) => w.length >= 4 && !STOP.has(w) && new RegExp(`\\b${w}\\b`).test(fl)));
        if ((l.match(/\?/g) ?? []).length > 1 || !CONFIRM_ASK.test(fl) || NOT_OFFICE_TOPIC.test(fl)
          || !(echoes || /\b(?:office|location|clinic|oficina|clinica|consultorio|ubicacion)\b/.test(fl))) break;
        const turn: string[] = [];
        while (lines[k + 1]?.startsWith('CALLER: ')) { k += 1; turn.push(lines[k].slice('CALLER: '.length)); }
        const reply = turn.join(' ').trim();
        // An acknowledgment can sit between the readback and its reply.
        pendingReadback = !reply;
        pendingLine = l;
        if (reply) answerReadback(reply, l);
        continue;
      }
      if (!l.startsWith('CALLER: ')) continue;
      // A later denial of the office named ("No voy a Covina") clears it, cue or not.
      const fl0 = foldAccents(l.slice('CALLER: '.length));
      if (pendingReadback) {
        pendingReadback = false;
        const turn: string[] = [l.slice('CALLER: '.length)];
        while (lines[k + 1]?.startsWith('CALLER: ')) { k += 1; turn.push(lines[k].slice('CALLER: '.length)); }
        const reply = turn.join(' ').trim();
        answerReadback(reply, pendingLine);
        continue;
      }
      if (!CORRECTION.test(fl0)) {
        if (DENIAL.test(fl0.trim()) && (namedWords().some((w) => new RegExp(`\\b${w}\\b`).test(fl0)) || /\b(?:there|that office|that one|esa oficina|ahi|alli|ese lugar)\b/.test(fl0))) corrections.push('No.');
        continue;
      }
      // The whole correcting turn: transcription may split "Actually," and "Downey."
      const turn: string[] = [l.slice('CALLER: '.length)];
      while (lines[k + 1]?.startsWith('CALLER: ')) { k += 1; turn.push(lines[k].slice('CALLER: '.length)); }
      // "Sorry, the pharmacy is in Downey" corrects the pharmacy, not the office.
      // and a long sentence after the cue is a new topic ("Actually, my doctor in Downey needs the records").
      // "Actually, Covina is my pharmacy, not my office" rejects the office first.
      if (/\b(?:not my office|not the office|no es mi oficina|no es la oficina)\b/.test(foldAccents(turn.join(' ')))) { corrections.push('No.'); continue; }
      const noPharmacy = turn.join(' ').split(/(?<=[.!;])\s+/).map((x) => {
        // "My office is Downey and my pharmacy is Covina": keep the office clause.
        if (!/\b(?:pharmacy|farmacia)\b/.test(foldAccents(x))) return x;
        if (!/\b(?:office|oficina|clinic|clinica|visit|go to|voy a)\b/.test(foldAccents(x))) return '';
        return x.split(/,\s*|\s+(?:and|y|but|pero)\s+/).filter((c) => !/\b(?:pharmacy|farmacia)\b/.test(foldAccents(c))).join(', ');
      }).filter(Boolean).join(' ');
      const after = corrected(noPharmacy).trim();
      if (noPharmacy.trim() && CORRECTION.test(foldAccents(noPharmacy))
        && (after.split(/\s+/).length <= 4 || /\b(?:office|oficina|clinic|clinica|location|go to|went to|visit|voy a|va a)\b/.test(foldAccents(after)))) corrections.push(noPharmacy);
    }
    // The first answer turn, then each in-window line after it that corrects
    // it, then each later correcting line: the last one decides.
    // The whole answer turn (an in-window correction is resolved by `corrected`,
    // which keeps everything after the last cue), then each later correcting turn.
    answers = [said.join(' '), ...corrections];
    // A readback of the corrected office keeps context too ("No, Downey" -> "Downey, correct?").
    for (const c of corrections) {
      lastAnswerWords.push(...foldAccents(corrected(c).replace(/^[\s,.]*(?:no|yes|si|sí)\b[\s,.]*/i, '').split(/[,.;]/)[0] ?? '').split(/[^a-z]+/));
    }
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
// ", not Downey" / ", no a Downey" after the office named.
const NOT_THAT = /,?\s*(?:not|no)\s+(?:a\s+|en\s+|the\s+)?\p{Lu}[\p{L}]+.*$/u;

const OTHER_PLACE = /\b(?:doctor|records|pharmacy|farmacia|live|lives|home|work|send|sent|medico|casa|vivo|trabajo)\b/;

export async function officeTheCallerGave(transcript: string | undefined): Promise<string | undefined> {
  // A sentence about the pharmacy ("Sorry, the pharmacy is in Downey") never names the office.
  const answers = officeAnswers(transcript ?? '')
    .map((a) => a.split(/(?<=[.!;])\s+/)
      // "No, that is my pharmacy" still rejects the office: keep the "No".
      .map((part) => {
        const f = foldAccents(part);
        if (!/\b(?:pharmacy|farmacia)\b/.test(f)) return part;
        // Only a pharmacy sentence rejecting the office answer: "My pharmacy is not open" is not one.
        if (/^\s*no\b/i.test(part) || (DENIAL.test(f) && /\b(?:office|oficina|is my pharmacy|es mi farmacia|that is the pharmacy|go to|voy a)\b/.test(f))) return 'No.';
        // "Actually, my office is Downey and my pharmacy is Covina": keep the office clause.
        if (!/\b(?:office|oficina|clinic|clinica|visit|go to|voy a)\b/.test(f)) return '';
        return part.split(/,\s*|\s+(?:and|y|but|pero)\s+/).filter((c) => !/\b(?:pharmacy|farmacia)\b/.test(foldAccents(c))).join(', ');
      })
      .filter(Boolean).join(' '))
    .filter((a) => a.trim());
  const lastLine = answers.length > 1 ? answers[answers.length - 1] : answers[0];
  // Only the corrected portion counts: "Covina, actually Springfield" is Springfield.
  // A long new topic after the cue ("Covina. Actually, my doctor in Downey needs the records")
  // does not correct the office: keep what came before the cue.
  let last = lastLine === undefined ? undefined : corrected(lastLine).replace(/^[\s,.;:!-]+/, '');
  if (lastLine !== undefined && last !== undefined && last !== lastLine && (last.split(/(?<=[.!;])\s+/)[0].trim().split(/\s+/).length > 4
    || OTHER_PLACE.test(foldAccents(last.split(/(?<=[.!;])\s+/)[0]))) && !/\b(?:office|oficina|clinic|clinica|location|go to|went to|visit|voy a|va a)\b/.test(foldAccents(last))) {
    const folded = foldAccents(lastLine);
    let start = -1;
    const cut = lastLine.length - corrected(lastLine).length;
    for (const m of folded.matchAll(CORRECTION_ALL)) if (m.index! + m[0].length === cut) start = m.index!;
    // Earlier corrections still apply: "Covina. Actually, Springfield. Sorry, I live in Downey." is Springfield.
    const before = lastLine.slice(0, start).replace(/[\s,.;:!-]+$/, '');
    last = corrected(before).replace(/^[\s,.;:!-]+/, '');
  }
  // Only the office sentence can deny it: "Covina. I do not remember the doctor." is Covina.
  const sentences = last?.split(/(?<=[.!;])\s+/) ?? [];
  if (!last || DENIAL.test(foldAccents(sentences[0]).trim()) || sentences.some((x) => /^no[.!]?$/i.test(x.trim()))
    // "Covina. No voy a Covina.": a later sentence denying the office named.
    || sentences.slice(1).some((x) => { const f = foldAccents(x); return DENIAL.test(f.trim())
      && (/\b(?:there|it|that office|that one|esa oficina|ahi|alli|alla)\b/.test(f)
        || foldAccents(sentences[0]).split(/[^a-z]+/).some((w) => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(f))); })) return undefined;
  // The office is the first sentence: "Springfield. My doctor in Covina needs my records." is Springfield.
  const parts = last.split(/(?<=[.!;])\s+/);
  // A filler lead-in ("Let me think.": several words, no proper noun) is not the answer.
  const resolves = async (x: string) => { try { return await lookupLocation(x); } catch { return undefined; } };
  while (parts.length > 1 && parts[0].trim().split(/\s+/).length >= 2 && !/\p{Lu}/u.test(parts[0].trim().slice(1))
    && !(await resolves(parts[0]))) {
    // "The one near my home." describes the office: never promote a later sentence over it.
    if (/\b(?:one|near|by|close|office|oficina|clinic|clinica|cerca|la que|el que)\b/.test(foldAccents(parts[0]))) return undefined;
    parts.shift();
  }
  const [first, ...rest] = parts;
  // "My doctor in Downey needs my records" names another place, not the office.
  if (first.trim().split(/\s+/).length > 3 && OTHER_PLACE.test(foldAccents(first)) && !/\b(?:office|oficina|clinic|clinica|go to|went to|visit|voy a|va a)\b/.test(foldAccents(first))) return undefined;
  // "I live in Covina, this is my first visit.": a residence is not the office.
  if (/\b(?:i live|live in|vivo|my home|mi casa)\b/.test(foldAccents(first))) return undefined;
  // "This is my first visit. I live in Covina.": a promoted sentence naming another place is not the office.
  if (first !== last.split(/(?<=[.!;])\s+/)[0] && OTHER_PLACE.test(foldAccents(first))) return undefined;
  if (DENIAL.test(foldAccents(first).trim())) return undefined;
  // "Covina or Springfield" is a guess between offices, never one office.
  if (/\b(?:or|o|either|both|ambos)\b/.test(foldAccents(first))) return undefined;
  try {
    const office = await lookupLocation(first);
    // A later sentence naming another office ("Or Downey, I go to both") makes it ambiguous.
    if (rest.some((sentence) => /\b(?:or|o|both|ambos|either)\b/.test(foldAccents(sentence)))) return undefined;
    for (const sentence of rest) {
      // "My doctor in Downey needs my records" names another place, not another office answer.
      if (OTHER_PLACE.test(foldAccents(sentence)) || DENIAL.test(foldAccents(sentence).trim())) continue;
      const other = await lookupLocation(sentence);
      if (other && office && other.canonical !== office.canonical) return undefined;
    }
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
