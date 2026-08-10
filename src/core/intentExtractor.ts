/**
 * STEP 2, done properly: ask what they want, then let a model read the answer.
 *
 * Operator design, 2026-08-10: "You ask for the intent, then you pass the
 * transcription over to the LLM and have the LLM extract the intent and pass
 * it back. Now you already know what the intent is, and the intent drives the
 * conversation the rest of the way."
 *
 * That is right, and the keyword table it replaces was measurably wrong on
 * three consecutive live calls:
 *
 *   "calling from the Loma Linda SURGERY Center for the medical records of a
 *    mutual patient"        -> filed as surgery coordination. Her EMPLOYER'S
 *                              NAME chose the intent.
 *   "calling for the medical records of a mutual patient"
 *                           -> matched nothing and fell to the catch-all,
 *                              because records_fax demanded the word "fax"
 *                              within 40 characters of "records".
 *   "...can you have them emailed?"  (turn 5)
 *                           -> ignored; the table had already decided on
 *                              turn 1 and never reconsidered.
 *
 * A regex cannot tell a request from the letterhead it arrived on. A model
 * can. So the model reads ONE sentence and returns structured data — it never
 * writes a word the caller hears, and it never chooses what happens next.
 * The intent it returns indexes the same INTENTS table as before, so the
 * downstream flow stays exactly as deterministic as it was.
 *
 * Three properties this must have, because it sits in a live call:
 *  1. It cannot hang the call — hard timeout, and the caller is never waiting
 *     on a vendor.
 *  2. It cannot fail the call — any error falls back to the keyword table,
 *     which is still there and still tested.
 *  3. It cannot invent — anything outside the known intent list is rejected
 *     and treated as a miss.
 */
import type { FieldKey, IntentKey } from './ticketAgent';

/** What one sentence told us. Everything except `intent` is optional. */
export interface ExtractedIntent {
  intent: IntentKey;
  /** How the caller wants the ANSWER delivered, when they said. */
  deliveryMethod?: 'fax' | 'email' | 'phone';
  /** Fields the caller volunteered in the same breath. */
  fields?: Partial<Record<FieldKey, string>>;
  /** The caller is staff at another practice, not the patient. */
  callerIsProfessional?: boolean;
  source: 'llm' | 'rules';
}

const VALID_INTENTS: IntentKey[] = [
  'records',
  'records_fax',
  'records_email',
  'medication_refill',
  'appointment_info',
  'appointment',
  'billing',
  'surgery',
  'optical',
  'message',
];

const MODEL = process.env.INTENT_MODEL ?? 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.INTENT_TIMEOUT_MS ?? 2000);

const SYSTEM = `You classify ONE sentence from a caller to a Southern California eye-care practice's phone line. You return JSON only. You never write anything the caller hears.

Return this shape:
{"intent": "...", "delivery_method": "fax"|"email"|"phone"|null, "caller_is_professional": true|false,
 "patient_name": string|null, "patient_dob": string|null, "provider_name": string|null, "office_location": string|null}

intent must be exactly one of:
- records            medical records / charts / notes / results, WITHOUT saying how to send them
- records_fax        medical records / charts / notes / results, explicitly to be FAXED
- records_email      medical records / charts / notes / results, explicitly to be EMAILED
- medication_refill  a prescription or eye drops refilled
- appointment_info   ASKING about an existing appointment: when was my last one, when is my next one, what time, which office, which doctor. A QUESTION, not a change.
- appointment        ASKING TO CHANGE something: book, reschedule, cancel, or confirm an appointment
- billing            a bill, invoice, insurance, copay, or statement
- surgery            cataract/LASIK/procedure scheduling or surgical coordination FOR THIS PATIENT
- optical            glasses, frames, lenses, contacts
- message            anything else, or too vague to tell

Rules that matter:
- appointment_info versus appointment is the difference between a question and an instruction. "When was my last appointment?" is appointment_info. "I need to move my appointment" is appointment. If they ask when it is AND want to change it, that is appointment.
- Judge the REQUEST, never the caller's employer. "Loma Linda Surgery Center" is where someone works; it does not make the call about surgery. "Vision Center", "Eye Institute", "Medical Group" are likewise names, not requests.
- If they want records but did NOT say how to send them, use "records" and set delivery_method to null. Do NOT guess fax — downstream asks them which.
- caller_is_professional is true when they identify as staff, a doctor, or another practice calling about a mutual patient.
- Only fill patient_name / patient_dob / provider_name if the caller actually said them in THIS sentence. Never guess. A caller giving their own name as a professional is not the patient.
- Output JSON and nothing else.`;

interface RawExtraction {
  intent?: string;
  delivery_method?: string | null;
  caller_is_professional?: boolean;
  patient_name?: string | null;
  patient_dob?: string | null;
  provider_name?: string | null;
  office_location?: string | null;
}

/**
 * Ask the model. Returns null on ANY problem — no key, timeout, bad JSON, an
 * intent we do not recognise — and the caller never learns that a vendor was
 * involved. The keyword table is the floor, not the ceiling.
 */
export async function extractIntent(text: string): Promise<ExtractedIntent | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text.trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text.slice(0, 800) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[INTENT] ${MODEL} returned ${res.status} — falling back to keywords`);
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const raw = JSON.parse(content) as RawExtraction;
    const intent = String(raw.intent ?? '') as IntentKey;
    // An intent we do not have a flow for is a miss, not a surprise.
    if (!VALID_INTENTS.includes(intent)) {
      console.warn(`[INTENT] model returned unknown intent "${raw.intent}" — falling back to keywords`);
      return null;
    }

    const fields: Partial<Record<FieldKey, string>> = {};
    if (raw.patient_name) fields.patient_name = String(raw.patient_name).slice(0, 80);
    if (raw.patient_dob) fields.patient_dob = String(raw.patient_dob).slice(0, 40);
    if (raw.provider_name) fields.provider_name = String(raw.provider_name).slice(0, 60);
    if (raw.office_location) fields.office_location = String(raw.office_location).slice(0, 60);

    const method = raw.delivery_method === 'fax' || raw.delivery_method === 'email' || raw.delivery_method === 'phone'
      ? raw.delivery_method
      : undefined;

    return {
      // A records request whose method the caller stated wins over whichever
      // records_* the model picked, so "email them" can never file as a fax.
      intent: method === 'email' && intent === 'records_fax' ? 'records_email'
        : method === 'fax' && intent === 'records_email' ? 'records_fax'
        : intent,
      deliveryMethod: method,
      fields: Object.keys(fields).length ? fields : undefined,
      callerIsProfessional: raw.caller_is_professional === true,
      source: 'llm',
    };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    console.warn(`[INTENT] ${aborted ? `timed out after ${TIMEOUT_MS}ms` : 'failed'} — falling back to keywords`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A delivery method named LATER in the call ("actually, can you email those?").
 * The old table classified once on turn one and never listened again; a caller
 * asked twice to have records emailed and was ignored both times.
 */
export function deliveryMethodIn(text: string): 'fax' | 'email' | 'phone' | null {
  if (/\b(e-?mail(ed|ing)?)\b/i.test(text)) return 'email';
  if (/\bfax(ed|ing)?\b/i.test(text)) return 'fax';
  if (/\b(call|phone|text) (me|us|him|her|them) (back|at)\b/i.test(text)) return 'phone';
  return null;
}

/* ── Reading the ANSWER, not just the request ───────────────────────────── */

/**
 * What the caller just said, in answer to the question we just asked.
 *
 * Operator, 2026-08-10: "Why are you trying to determine what a first name is?
 * Why are you parsing… The code is not catching. It doesn't know Wayne Fabian
 * is a name. It records 'It's'."
 *
 * He is right, and this function is the answer to it. Intent came here from
 * the start; every field after it was read by regular expressions, so the
 * model decided what the call was ABOUT and a pattern read every actual
 * ANSWER. There is no pattern that accepts "Yeah. It's Wayne Fabian" and
 * rejects "uh let me look it up" — four separate special cases were shipped in
 * one evening proving it, and the last one searched the patient mirror for a
 * surname of "Wayne".
 *
 * The model is given the question it asked and the words it heard, and returns
 * the value or null. It is told to return null rather than guess, because a
 * wrong name on a chart is worse than one more question. The regex parsers
 * stay as the floor for when this is slow, down, or unset — the same contract
 * intent has always had.
 */
const FIELD_BRIEF: Record<string, string> = {
  patient_name: "the patient's full name, first and last. Return it Capitalised, with no titles and no lead-in words. \"Yeah. It's Wayne Fabian.\" -> \"Wayne Fabian\". \"uh let me look it up\" -> null.",
  patient_dob: 'the date of birth as yyyy-mm-dd. "March 17th, 1973" -> "1973-03-17". "03/17/1973" -> "1973-03-17". A date with no year -> null.',
  callback_number: 'a phone number, digits only, 10 or 11 digits. Spoken digits count: "seven six zero, eight six zero, one four three four" -> "7608601434". A yes/no answer -> null.',
  fax_number: 'a FAX number, digits only, 10 or 11 digits. A yes/no answer -> null.',
  email_address: 'an email address, exactly as spoken. "wayne at azulvision dot com" -> "wayne@azulvision.com".',
  medication: 'the medication name, as spoken. "It\'s prednisolone acetate" -> "prednisolone acetate".',
  office_location: 'which office or city. "Santa Ana" -> "Santa Ana".',
  provider_name: 'the doctor\'s name. "Dr. Choi" -> "Dr. Choi".',
  delivery_method: 'one of exactly "fax", "email", or "phone" — how they want the answer sent. Anything else -> null.',
  details: 'a one-sentence summary of what they want the team to know, in their own words.',
};

export async function extractField(
  field: string,
  question: string,
  said: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  const brief = FIELD_BRIEF[field];
  if (!apiKey || !brief || !said.trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You read ONE answer from a caller to a Southern California eye-care practice and return JSON only: {"value": string|null}.\n' +
              `The question they were asked: ${question}\n` +
              `Extract: ${brief}\n` +
              'Rules: return ONLY the value, never the sentence around it. If the answer does not contain it — they asked a question back, refused, said something unrelated, or were cut off mid-word — return null. NEVER invent or complete a partial value. A wrong value on a patient record is worse than asking again.',
          },
          { role: 'user', content: said.slice(0, 400) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[FIELD] ${MODEL} returned ${res.status} for ${field} — falling back to the parser`);
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    const value = (JSON.parse(content) as { value?: unknown }).value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    // A model that echoes the whole utterance back has not extracted anything.
    return trimmed && trimmed.length <= 200 ? trimmed : null;
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    console.warn(`[FIELD] ${aborted ? `timed out after ${TIMEOUT_MS}ms` : 'failed'} for ${field} — falling back to the parser`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
