/**
 * THE CONVERSATION, read by a model with tools — the way the working agent
 * does it.
 *
 * Operator, 2026-08-10: "Give the mouthpiece the tools like the working agent
 * does… someone can say, well, I was thinking and, you know, and then you know
 * what happened and then… oh, my… yeah. My name is Wayne Fabian. How would you
 * be able to parse that?"
 *
 * You cannot, and azulSchedulingAgent never tries. Its tool is
 *
 *   verify_patient_identity(lastName, firstName?, dateOfBirth: YYYY-MM-DD)
 *
 * and the MODEL fills those arguments out of the whole conversation. No regex
 * ever sees a sentence. That is the mechanism this file restores.
 *
 * WHY IT IS NOT ON THE MOUTHPIECE. The realtime session that speaks for us is
 * deaf on purpose: it receives no caller audio, because its transcriber
 * fabricated whole passages of fiction out of silence and the agent read them
 * to patients ("I just got promoted at work today", 2026-04-22). Giving it
 * tools means giving it ears, and the arguments would come from the same
 * audio. So the tools go where the conversation already is — on Deepgram's
 * transcript, which is the text a human would read.
 *
 * Three properties, the same ones every model call on this line has:
 *  1. It cannot hang a call — hard timeout, and a caller never waits on it.
 *  2. It cannot fail a call — every error path returns nothing and the
 *     existing parsers still run.
 *  3. It cannot invent. A name or a date the caller never said is refused
 *     before it reaches a patient record, however confident the model is.
 */
import type { FieldKey } from './ticketAgent';

const MODEL = process.env.INTENT_MODEL ?? 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.INTENT_TIMEOUT_MS ?? 2000);

/** One call's conversation, oldest first. Dies with the call. */
const conversations = new Map<string, string[]>();

export function noteAgent(callId: string, line: string): void {
  if (!callId || !line.trim()) return;
  const c = conversations.get(callId) ?? [];
  c.push(`AGENT: ${line.trim()}`);
  conversations.set(callId, c.slice(-40));
}

export function noteCaller(callId: string, line: string): void {
  if (!callId || !line.trim()) return;
  const c = conversations.get(callId) ?? [];
  c.push(`CALLER: ${line.trim()}`);
  conversations.set(callId, c.slice(-40));
}

export function forgetConversation(callId: string): void {
  conversations.delete(callId);
}

/** Everything the CALLER has said, for the grounding check. */
function callerSpeech(callId: string): string {
  return (conversations.get(callId) ?? [])
    .filter((l) => l.startsWith('CALLER: '))
    .map((l) => l.slice(8))
    .join(' ')
    .toLowerCase();
}

/**
 * The tool. Every field optional, because the model reports only what the
 * caller actually said — a partial answer is normal and a made-up one is not.
 */
const RECORD_FACTS = {
  type: 'function' as const,
  function: {
    name: 'record_facts',
    description:
      'Record the facts the caller has stated so far in this conversation. Include a field ONLY if the caller actually said it. Omit anything you are guessing at, reconstructing from digits, or completing from a partial answer. Omitting a field is always safe; a wrong value goes onto a patient record.',
    parameters: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: "The patient's full name, first and last, capitalised, no titles." },
        patient_dob: { type: 'string', description: "The patient's date of birth as YYYY-MM-DD. Omit if no year was stated." },
        callback_number: { type: 'string', description: 'Phone number to call them back on, digits only.' },
        fax_number: { type: 'string', description: 'Fax number for sending records, digits only.' },
        email_address: { type: 'string', description: 'Email address for sending records.' },
        medication: { type: 'string', description: 'The medication to be refilled.' },
        provider_name: { type: 'string', description: 'The doctor this concerns.' },
        office_location: { type: 'string', description: 'The office or city this concerns.' },
        delivery_method: { type: 'string', enum: ['fax', 'email', 'phone'], description: 'How they want the answer sent.' },
        details: { type: 'string', description: 'One sentence on what they want the team to know, in their own words.' },
      },
      additionalProperties: false,
    },
  },
};

const SYSTEM =
  'You are reading a live phone call at a Southern California eye-care practice. ' +
  'Call record_facts with everything the CALLER has stated. ' +
  'The caller may state something in passing, mid-sentence, or long before it was asked for — take it wherever it appears. ' +
  'Never include a value the caller did not say. Never assemble a date of birth out of loose digits. ' +
  'Never repeat back a value the AGENT said unless the caller confirmed it. ' +
  'If nothing has been stated, call record_facts with no arguments.';

/**
 * A name or a date the caller never said does not go on a chart.
 *
 * The working agent has exactly this guard (checkIdentityGrounding), and it
 * exists because of a real call where a model reassembled a date of birth out
 * of digits the caller had said separately. Downstream cannot catch it: the
 * service only ever sees a name and a date that look perfectly well formed.
 */
function grounded(field: FieldKey, value: string, speech: string): boolean {
  if (field === 'patient_name') {
    // Every part of the name must be traceable to something the caller said.
    return value
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .every((w) => speech.includes(w.toLowerCase()));
  }
  if (field === 'patient_dob') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const [, y, mo, d] = m;
    // The YEAR is the piece a model invents when a caller gives none, and a
    // wrong year is the difference between two real patients. It has to be
    // audible in the call, in full or as the last two digits.
    return speech.includes(y) || speech.includes(y.slice(2)) || speech.includes(`${+mo}/${+d}`);
  }
  if (field === 'callback_number' || field === 'fax_number') {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 10) return false;
    // The last four are what a human checks, and what a caller repeats.
    return speech.replace(/\D/g, '').includes(digits.slice(-4));
  }
  return true;
}

export interface ReadFacts {
  values: Partial<Record<FieldKey, string>>;
  /** Fields the model returned that were refused as ungrounded. */
  refused: FieldKey[];
}

/**
 * Read the conversation. Returns only what the caller demonstrably said.
 * Never throws; an empty result simply means the parsers decide.
 */
export async function readConversation(callId: string): Promise<ReadFacts> {
  const empty: ReadFacts = { values: {}, refused: [] };
  const apiKey = process.env.OPENAI_API_KEY;
  const lines = conversations.get(callId);
  if (!apiKey || !lines?.length) return empty;

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
        tools: [RECORD_FACTS],
        tool_choice: { type: 'function', function: { name: 'record_facts' } },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: lines.join('\n').slice(-4000) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[READER] ${MODEL} returned ${res.status} — the parsers decide`);
      return empty;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return empty;

    const raw = JSON.parse(args) as Record<string, unknown>;
    const speech = callerSpeech(callId);
    const out: ReadFacts = { values: {}, refused: [] };
    for (const [k, v] of Object.entries(raw)) {
      const key = k as FieldKey;
      if (typeof v !== 'string' || !v.trim() || v.length > 200) continue;
      const value = v.trim();
      if (!grounded(key, value, speech)) {
        out.refused.push(key);
        continue;
      }
      out.values[key] = value;
    }
    if (out.refused.length) {
      console.warn(`[READER] ${callId.slice(-6)} refused ungrounded ${out.refused.join(',')} — the caller never said it`);
    }
    return out;
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    console.warn(`[READER] ${aborted ? `timed out after ${TIMEOUT_MS}ms` : 'failed'} — the parsers decide`);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}
