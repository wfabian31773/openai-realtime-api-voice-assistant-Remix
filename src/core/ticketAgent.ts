/**
 * THE TICKET AGENT — one job, five steps, one file.
 *
 * Operator spec, 2026-08-09, verbatim:
 *   "It should be in steps. Very simple, very basic.
 *      1. verify patient
 *      2. classify intent
 *      3. check what data fields are necessary based on the intent
 *      4. collect the fields
 *      5. execute"
 *
 * That is the whole agent. There is no reasoning layer, no director, no
 * guard stack, no prompt that competes with this file. Everything the agent
 * can say is in LINES. Everything it can need is in FIELDS. What each
 * request needs is in INTENTS — one table, editable by a human in one place.
 *
 * If a call goes wrong, exactly one of four things is true and the log says
 * which: the intent was classified wrong, a field was parsed wrong, a field
 * was asked that we already had, or the execute failed. Nothing else can
 * happen, because nothing else is here.
 */
import { getLedger, updateLedger } from '../services/callFactsLedger';
import { looksLikeName, findNameIn, spokenDigitsToNumber, normalizeSpokenDob, looksLikeDob, DOB_PATTERN } from './parsing';
import { deliveryMethodIn } from './intentExtractor';
import { cachedConfig, refreshConfig } from './ticketAgentConfig';
import type { CoreAction, LineModule } from './types';

/* ── What the agent can need ─────────────────────────────────────────── */

export type FieldKey =
  | 'patient_name'
  | 'patient_dob'
  | 'callback_number'
  | 'fax_number'
  | 'email_address'
  | 'office_location'
  | 'provider_name'
  | 'details';

interface FieldDef {
  ask: { en: string; es: string };
  /** Pull the value out of what the caller said. null = not answered yet. */
  parse: (text: string) => string | null;
  /** Already known before we ask? Then we never ask. */
  known?: (callId: string) => string | null;
}

const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;

export const FIELDS: Record<FieldKey, FieldDef> = {
  patient_name: {
    ask: {
      en: "May I have the patient's first and last name?",
      es: '¿Me da el nombre y apellido del paciente?',
    },
    parse: (t) => {
      const n = findNameIn(t);
      return n ? `${n.first} ${n.last}` : null;
    },
    known: (id) => {
      const f = getLedger(id);
      // A caller-ID match is only an identity once it has been CONFIRMED.
      // Before that — and especially after the caller said "no, that's not
      // me" — the matched name is a guess, and filing a ticket against it
      // puts one patient's request on another patient's record.
      const first = f?.firstName ?? (f?.identityVerified ? f?.matchedFirstName : undefined);
      const last = f?.lastName ?? (f?.identityVerified ? f?.matchedLastName : undefined);
      return first && last ? `${first} ${last}` : null;
    },
  },
  patient_dob: {
    ask: {
      en: "And the patient's date of birth?",
      es: '¿Y la fecha de nacimiento del paciente?',
    },
    // Extract the DATE, never the sentence around it. Falling back to the
    // whole utterance put "Sure, the patient's first and last name is Wayne
    // Fabian and the date of birth is March 17th, 1973." into the DOB field
    // of a real ticket — staff would have had to re-read the call to find a
    // date the agent already had.
    parse: (t) => {
      if (!looksLikeDob(t)) return null;
      const normalized = normalizeSpokenDob(t);
      if (normalized) return normalized;
      const matched = t.match(DOB_PATTERN)?.[0]?.trim();
      return matched || null;
    },
    known: (id) => {
      const f = getLedger(id);
      return f?.dateOfBirth ?? (f?.identityVerified ? f?.matchedDob ?? null : null);
    },
  },
  callback_number: {
    ask: {
      en: "What's the best number for the team to reach you?",
      es: '¿Cuál es el mejor número para que el equipo le contacte?',
    },
    parse: (t) => t.match(PHONE)?.[0].replace(/[^\d+]/g, '') ?? spokenDigitsToNumber(t),
    // Caller ID is a CANDIDATE, not an answer: it counts as known only once
    // the caller has confirmed it. Otherwise we would file a ticket against a
    // number nobody agreed to.
    known: (id) => (getLedger(id)?.callbackConfirmed ? getLedger(id)?.callbackNumber ?? null : null),
  },
  fax_number: {
    ask: {
      en: "What's the best fax number to send that to?",
      es: '¿Cuál es el mejor número de fax para enviarlo?',
    },
    parse: (t) => t.match(PHONE)?.[0].replace(/[^\d+]/g, '') ?? spokenDigitsToNumber(t),
  },
  email_address: {
    ask: {
      en: "What's the best email address for that?",
      es: '¿Cuál es el mejor correo electrónico para eso?',
    },
    parse: (t) => t.match(EMAIL)?.[0] ?? null,
  },
  office_location: {
    ask: {
      en: 'Which Azul Vision office is this for?',
      es: '¿Para qué oficina de Azul Vision es?',
    },
    parse: (t) => (t.trim().length >= 3 ? t.trim().slice(0, 60) : null),
  },
  provider_name: {
    ask: {
      en: 'Which doctor is this regarding?',
      es: '¿Con qué doctor es esto?',
    },
    parse: (t) => (t.trim().length >= 3 ? t.trim().slice(0, 60) : null),
  },
  details: {
    ask: {
      en: 'What would you like the team to know?',
      es: '¿Qué le gustaría que supiera el equipo?',
    },
    parse: (t) => (t.trim().split(/\s+/).length >= 2 ? t.trim().slice(0, 300) : null),
  },
};

/* ── Step 3, as data: what each request needs ────────────────────────── */

export type IntentKey =
  | 'records_fax'
  | 'records_email'
  | 'medication_refill'
  | 'appointment'
  | 'billing'
  | 'surgery'
  | 'optical'
  | 'message';

interface IntentDef {
  /** Words that mean this request. First match wins, so order matters. */
  match: RegExp;
  /** EXACTLY what a human needs to act on it. Nothing else is collected. */
  needs: FieldKey[];
  department: 1 | 2 | 3;
  label: string;
}

export const INTENTS: Record<IntentKey, IntentDef> = {
  records_fax: {
    match: /\b(records?|charts?|notes?|results?)\b[^.]{0,40}\bfax|fax[^.]{0,40}\b(records?|charts?|notes?|results?)\b/i,
    needs: ['patient_name', 'patient_dob', 'fax_number'],
    department: 3,
    label: 'Medical records — fax',
  },
  records_email: {
    match: /\b(records?|charts?|notes?|results?)\b[^.]{0,40}\be-?mail|e-?mail[^.]{0,40}\b(records?|charts?|notes?|results?)\b/i,
    needs: ['patient_name', 'patient_dob', 'email_address'],
    department: 3,
    label: 'Medical records — email',
  },
  medication_refill: {
    match: /\b(refill|prescription|medication|eye ?drops?|receta|medicamento)\b/i,
    needs: ['patient_name', 'patient_dob', 'callback_number'],
    department: 3,
    label: 'Medication refill',
  },
  surgery: {
    match: /\b(surgery|surgical|cataract|lasik|procedure|cirugía)\b/i,
    needs: ['patient_name', 'patient_dob', 'provider_name', 'callback_number'],
    department: 2,
    label: 'Surgery coordination',
  },
  appointment: {
    match: /\b(appointment|schedule|reschedul\w*|cancel|book|cita|agendar)\b/i,
    needs: ['patient_name', 'patient_dob', 'callback_number'],
    department: 3,
    label: 'Appointment request',
  },
  optical: {
    match: /\b(glasses|lenses|contacts?|frames?|optical|lentes)\b/i,
    needs: ['patient_name', 'patient_dob', 'office_location', 'callback_number'],
    department: 1,
    label: 'Optical',
  },
  billing: {
    match: /\b(bill|billing|invoice|insurance|copay|statement|factura|seguro)\b/i,
    needs: ['patient_name', 'patient_dob', 'callback_number'],
    department: 3,
    label: 'Billing / insurance',
  },
  // Last resort: we could not tell what they want, so we take a message.
  message: {
    match: /.*/,
    needs: ['patient_name', 'patient_dob', 'details', 'callback_number'],
    department: 3,
    label: 'Message for the team',
  },
};

/* ── Everything the agent can say ────────────────────────────────────── */

const LINES = {
  askIntent: { en: 'How can I help you today?', es: '¿Cómo puedo ayudarle hoy?' },
  confirmId: (f: string) => ({ en: `Am I speaking with ${f}?`, es: `¿Hablo con ${f}?` }),
  askDobToVerify: {
    en: 'Great — just to confirm your identity, may I have your date of birth?',
    es: 'Perfecto — para confirmar su identidad, ¿me da su fecha de nacimiento?',
  },
  confirmCallback: (last4: string) => ({
    en: `Is this number ending in ${last4} the best one to reach you?`,
    es: `¿Este número que termina en ${last4} es el mejor para contactarle?`,
  }),
  human: {
    en: 'All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available.',
    es: 'Todos nuestros agentes están ocupados en este momento — puedo tomar un mensaje para que el equipo le contacte tan pronto estén disponibles.',
  },
  urgent: {
    en: 'If this is a medical emergency, please hang up and dial nine one one right away. Otherwise I\'ll take your information and flag it urgent.',
    es: 'Si es una emergencia médica, cuelgue y marque nueve uno uno de inmediato. Si no, tomaré su información y la marcaré urgente.',
  },
  filing: (what: string) => ({
    en: `I have that down as ${what}. One moment while I submit this for you.`,
    es: `Lo anoté como ${what}. Un momento mientras lo envío.`,
  }),
  filed: {
    en: "You're all set — I've passed that to the team and they'll follow up. Is there anything else?",
    es: 'Listo — se lo pasé al equipo y le darán seguimiento. ¿Algo más?',
  },
  filedFallback: {
    en: "I've noted everything and the team will follow up with you. Is there anything else?",
    es: 'He anotado todo y el equipo le dará seguimiento. ¿Algo más?',
  },
  wrap: { en: 'Thanks for calling Azul Vision — take care.', es: 'Gracias por llamar a Azul Vision — que esté bien.' },
} as const;

type Localized = { en: string; es: string };

const YES = /\b(yes|yeah|yep|correct|right|that's me|speaking|sure|si|sí|claro|correcto)\b/i;
const NO = /\b(no|nope|not|wrong|nothing|that's (all|it)|nada)\b/i;
const HUMAN = /\b(representative|operator|receptionist|(real|actual|live) (person|human)|human being)\b|\b(talk|speak|connect|transfer|get me|put me)\b[^.]{0,25}\b(human|agent|person|somebody|someone|rep)\b/i;
const URGENT = /\b(emergency|911|chest pain|can'?t see|sudden vision|bleeding|severe pain|emergencia|sangrando)\b/i;
const SPANISH = /\b(hola|gracias|necesito|quiero|por favor|buenos|buenas|español|cita|ayuda|receta|lentes)\b/gi;

/* ── The five steps ──────────────────────────────────────────────────── */

type Step = 'VERIFY' | 'CLASSIFY' | 'COLLECT' | 'EXECUTE' | 'WRAP' | 'DONE';

export interface TicketAgentServices {
  /** Step 1. True when this really is the person the record says. */
  verify(callId: string, name: string, dob: string): Promise<boolean>;
  /**
   * Step 2. Read the caller's own sentence and say what they want.
   * Optional: without it the keyword table decides, exactly as before.
   */
  classifyIntent?(text: string): Promise<import('./intentExtractor').ExtractedIntent | null>;
  /** Step 5. Everything collected, in one call. */
  submit(callId: string, ticket: {
    intent: IntentKey;
    label: string;
    department: 1 | 2 | 3;
    fields: Partial<Record<FieldKey, string>>;
    urgent: boolean;
  }): Promise<{ ok: boolean; ticketNumber?: string }>;
}

interface CallState {
  step: Step;
  lang: 'en' | 'es';
  spanishHits: number;
  urgent: boolean;
  intent: IntentKey | null;
  /** Field currently being asked. */
  asking: FieldKey | null;
  /** What the caller said when they told us why they called. */
  rawRequest: string | null;
  values: Partial<Record<FieldKey, string>>;
  /** Two asks per field, per call. Then we move on with what we have. */
  asks: Map<FieldKey, number>;
  verifyTries: number;
  filed: boolean;
}

export function createTicketAgent(services: TicketAgentServices, cfg: { slug?: string; humanLine?: Localized } = {}): LineModule {
  const calls = new Map<string, CallState>();
  const t = (s: CallState, l: Localized) => l[s.lang];

  /** Step 2: which request is this? First match in the table wins. */
  const classify = (text: string): IntentKey => {
    for (const key of Object.keys(INTENTS) as IntentKey[]) {
      if (key !== 'message' && INTENTS[key].match.test(text)) return key;
    }
    return 'message';
  };

  const liveSlug = cfg.slug ?? 'ticket-agent';

  /** The needs list for an intent, with any live override applied. */
  const needsFor = (intent: IntentKey): FieldKey[] => {
    const override = cachedConfig(liveSlug).intents?.[intent]?.needs;
    if (!override?.length) return INTENTS[intent].needs;
    const valid = override.filter((k): k is FieldKey => k in FIELDS);
    return valid.length ? valid : INTENTS[intent].needs;
  };

  /** Step 3+4: the next field this intent needs that we do not already have. */
  const nextMissing = (callId: string, s: CallState): FieldKey | null => {
    const needs = needsFor(s.intent ?? 'message');
    for (const key of needs) {
      if (s.values[key]) continue;
      const known = FIELDS[key].known?.(callId);
      if (known) {
        s.values[key] = known;
        continue;
      }
      if ((s.asks.get(key) ?? 0) >= 2) continue; // asked twice, move on
      return key;
    }
    return null;
  };

  /**
   * The caller answered a DIFFERENT question than the one asked. Keep what
   * they said, in the field it can only belong to.
   *
   * Eligibility is deliberately narrow: a field qualifies only when its
   * format identifies it on sight. patient_name, office_location,
   * provider_name and details all parse almost any string, so admitting them
   * here would file every stray utterance as a doctor's name. Phone numbers
   * qualify only when exactly one phone-shaped field is still outstanding,
   * so a fax number can never be recorded as a callback.
   *
   * Returns true when something was salvaged.
   */
  const salvageMisdirected = (callId: string, s: CallState, asked: FieldKey, text: string): boolean => {
    const needs = needsFor(s.intent ?? 'message');
    const outstanding = needs.filter((k) => k !== asked && !s.values[k] && !FIELDS[k].known?.(callId));

    // Self-identifying formats first.
    for (const k of outstanding) {
      if (k !== 'patient_dob' && k !== 'email_address') continue;
      const v = FIELDS[k].parse(text);
      if (!v) continue;
      s.values[k] = v;
      if (k === 'patient_dob') updateLedger(callId, { dateOfBirth: v });
      console.info(`[TICKET-AGENT] ${callId.slice(-6)} salvaged ${k} from the answer to ${asked}`);
      return true;
    }

    // A phone number, only when there is exactly one place it could go.
    const phoneFields = outstanding.filter((k) => k === 'callback_number' || k === 'fax_number');
    if (phoneFields.length === 1) {
      const k = phoneFields[0];
      const v = FIELDS[k].parse(text);
      if (v) {
        s.values[k] = v;
        if (k === 'callback_number') updateLedger(callId, { callbackNumber: v, callbackConfirmed: true });
        console.info(`[TICKET-AGENT] ${callId.slice(-6)} salvaged ${k} from the answer to ${asked}`);
        return true;
      }
    }
    return false;
  };

  const ask = (callId: string, s: CallState, key: FieldKey): CoreAction => {
    s.step = 'COLLECT';
    s.asking = key;
    s.asks.set(key, (s.asks.get(key) ?? 0) + 1);
    // The callback we already have is CONFIRMED, never re-collected.
    if (key === 'callback_number') {
      const known = getLedger(callId)?.callbackNumber ?? getLedger(callId)?.callerPhone;
      if (known) return { say: t(s, LINES.confirmCallback(known.slice(-4))) };
    }
    const over = cachedConfig(liveSlug).lines?.[`field_${key}`];
    return { say: over?.[s.lang] ?? t(s, FIELDS[key].ask) };
  };

  /** Step 5. */
  const execute = (callId: string, s: CallState): CoreAction => {
    const def = INTENTS[s.intent ?? 'message'];
    s.step = 'EXECUTE';
    return {
      say: t(s, LINES.filing(def.label.toLowerCase())),
      followUp: async () => {
        // A number we can dial makes a request actionable even when the name
        // never came through — staff call it back and ask. Only a call with
        // NO way to reach anyone is unfileable noise.
        const reachable =
          s.values.callback_number ?? s.values.fax_number ?? s.values.email_address ?? getLedger(callId)?.callerPhone;
        if (!reachable) {
          s.step = 'WRAP';
          return {
            say: t(s, LINES.filedFallback),
            alert: `NOT FILED for ${callId}: no way to reach the caller back`,
          };
        }
        if (!s.values.callback_number && reachable === getLedger(callId)?.callerPhone) {
          s.values.callback_number = reachable;
        }
        if (!s.values.patient_name) s.values.patient_name = 'Unknown Caller';
        const r = await services
          .submit(callId, {
            intent: s.intent ?? 'message',
            label: def.label,
            department: def.department,
            fields: { ...s.values, details: s.values.details ?? s.rawRequest ?? undefined },
            urgent: s.urgent,
          })
          .catch(() => ({ ok: false }));
        s.step = 'WRAP';
        if (r.ok) {
          s.filed = true;
          return { say: t(s, LINES.filed) };
        }
        return {
          say: t(s, LINES.filedFallback),
          alert: `TICKET SUBMIT FAILED for ${callId} (${def.label}) — sweep must recover`,
        };
      },
    };
  };

  /** Collect done? Execute. Otherwise ask the next thing. */
  const advance = (callId: string, s: CallState): CoreAction => {
    const missing = nextMissing(callId, s);
    if (missing) return ask(callId, s, missing);
    return execute(callId, s);
  };

  return {
    slug: cfg.slug ?? 'ticket-agent',

    start(callId: string): void {
      refreshConfig(liveSlug); // next call picks up any edit, no deploy
      const f = getLedger(callId);
      calls.set(callId, {
        // Step 1 only exists when we think we know who this is; otherwise the
        // name and DOB are just two of the fields the intent will need.
        step: f?.matchedFirstName ? 'VERIFY' : 'CLASSIFY',
        lang: 'en',
        spanishHits: 0,
        urgent: false,
        intent: null,
        asking: null,
        rawRequest: null,
        values: {},
        asks: new Map(),
        verifyTries: 0,
        filed: false,
      });
    },

    stateOf(callId: string): string | null {
      const s = calls.get(callId);
      return s ? `${s.step}${s.intent ? `:${s.intent}` : ''}${s.asking ? `:${s.asking}` : ''}` : null;
    },

    async finalize(callId: string): Promise<{ filed: boolean; alert?: string }> {
      const s = calls.get(callId);
      if (!s || s.filed || !s.intent) return { filed: false };
      // Caller hung up mid-flow: file it if a human could act on it.
      // Same rule as executing normally: a number we can dial makes the
      // request actionable. Being stricter here loses requests from exactly
      // the callers who hung up because they were in a hurry.
      // A HANG-UP is different from a completed call: we never got to confirm
      // anything, so the bar is a real name. Filing "Unknown Caller" tickets
      // off every dropped call buries the real ones (measured: it tripled the
      // failure rate on the replay corpus).
      const haveName = s.values.patient_name ?? FIELDS.patient_name.known?.(callId);
      if (!haveName) return { filed: false, alert: `unfiled ${s.intent} on ${callId}: no patient name captured` };
      const haveBack =
        s.values.callback_number ??
        s.values.fax_number ??
        s.values.email_address ??
        getLedger(callId)?.callbackNumber ??
        getLedger(callId)?.callerPhone;
      if (!haveBack) return { filed: false, alert: `unfiled ${s.intent} on ${callId}: no way to reach the caller` };
      const def = INTENTS[s.intent];
      const r = await services
        .submit(callId, {
          intent: s.intent,
          label: `${def.label} (caller ended the call early)`,
          department: def.department,
          fields: { ...s.values, patient_name: haveName, callback_number: s.values.callback_number ?? haveBack },
          urgent: s.urgent,
        })
        .catch(() => ({ ok: false }));
      return { filed: Boolean(r.ok), alert: r.ok ? undefined : `hang-up ticket lost for ${callId}` };
    },

    release(callId: string): void {
      calls.delete(callId);
    },

    async onUtterance(callId: string, text: string): Promise<CoreAction> {
      const s = calls.get(callId);
      if (!s) return { say: null };
      try {
        // Language, always first — the emergency line must be understandable.
        s.spanishHits += (text.match(SPANISH) ?? []).length;
        if (s.lang === 'en' && (s.spanishHits >= 2 || /\b(en español|habla español)\b/i.test(text))) {
          s.lang = 'es';
          updateLedger(callId, { language: 'Spanish' });
        }

        // Safety, before anything else, at any step including after the wrap.
        if (URGENT.test(text)) {
          const first = !s.urgent;
          s.urgent = true;
          if (first || s.step === 'DONE' || s.step === 'WRAP') {
            // Classify it too. A distressed caller who hangs up after hearing
            // the 911 line must still leave a request behind (review
            // 2026-08-09) — the safety line is not a reason to forget them.
            if ((s.step === 'CLASSIFY' || s.step === 'VERIFY') && text.trim().split(/\s+/).length >= 2) {
              s.intent = classify(text);
              s.rawRequest = text.trim().slice(0, 300);
              updateLedger(callId, { intent: text.trim().slice(0, 200) });
              const next = advance(callId, s);
              return { ...next, say: `${t(s, LINES.urgent)} ${next.say ?? ''}`.trim() };
            }
            return { say: t(s, LINES.urgent) };
          }
        }

        // This line cannot transfer. Say so, every time, and keep going.
        if (HUMAN.test(text)) {
          const line = t(s, cfg.humanLine ?? LINES.human);
          if (s.step === 'CLASSIFY' || s.step === 'VERIFY') {
            s.step = 'CLASSIFY';
            return { say: `${line} ${t(s, LINES.askIntent)}` };
          }
          return { say: line };
        }

        // "Actually, can you have them emailed?" — said on turn five, after
        // the intent was already set. The old table decided once and never
        // listened again: a caller asked twice to have records emailed and was
        // ignored both times, then the ticket was filed as something else.
        // A records request follows the method the caller names, whenever
        // they name it.
        if (s.intent === 'records_fax' || s.intent === 'records_email') {
          const method = deliveryMethodIn(text);
          const wanted = method === 'email' ? 'records_email' : method === 'fax' ? 'records_fax' : null;
          if (wanted && wanted !== s.intent) {
            const dropped = wanted === 'records_email' ? 'fax_number' : 'email_address';
            delete s.values[dropped];
            s.asks.delete(dropped);
            s.intent = wanted;
            if (s.asking === dropped) s.asking = null;
            console.info(`[TICKET-AGENT] ${callId.slice(-6)} caller asked for ${method} — intent now ${wanted}`);
            if (s.step === 'COLLECT' || s.step === 'EXECUTE') return advance(callId, s);
          }
        }

        switch (s.step) {
          /* STEP 1 — verify the patient we think we recognise. */
          case 'VERIFY': {
            const f = getLedger(callId);
            if (!s.asking) {
              // First turn after the greeting confirmed the name.
              if (YES.test(text) && !NO.test(text)) {
                s.asking = 'patient_dob';
                return { say: t(s, LINES.askDobToVerify) };
              }
              if (NO.test(text)) {
                s.step = 'CLASSIFY';
                return { say: t(s, LINES.askIntent) };
              }
              // They answered with their reason instead — take it and move on.
              s.step = 'CLASSIFY';
              return this.onUtterance(callId, text);
            }
            const dob = FIELDS.patient_dob.parse(text);
            if (!dob) {
              s.verifyTries += 1;
              if (s.verifyTries >= 2) {
                s.step = 'CLASSIFY';
                return { say: t(s, LINES.askIntent) };
              }
              return { say: t(s, LINES.askDobToVerify) };
            }
            const name = `${f?.matchedFirstName ?? ''} ${f?.matchedLastName ?? ''}`.trim();
            const ok = await services.verify(callId, name, dob).catch(() => false);
            if (ok) {
              updateLedger(callId, { firstName: f?.matchedFirstName, lastName: f?.matchedLastName, dateOfBirth: dob, identityVerified: true });
              s.values.patient_name = name;
              s.values.patient_dob = dob;
            } else {
              s.verifyTries += 1;
            }
            s.asking = null;
            s.step = 'CLASSIFY';
            return { say: t(s, LINES.askIntent) };
          }

          /* STEP 2 — classify the intent. */
          case 'CLASSIFY': {
            if (text.trim().split(/\s+/).length < 2) return { say: t(s, LINES.askIntent) };
            s.rawRequest = text.trim().slice(0, 300);
            updateLedger(callId, { intent: text.trim().slice(0, 200) });

            // The model reads the sentence; the TABLE is the floor. A model
            // that is slow, down, or confused costs us nothing but accuracy.
            const read = await services.classifyIntent?.(text).catch(() => null);
            s.intent = read?.intent ?? classify(text);
            if (read?.fields) {
              // Anything they volunteered in the same breath, kept — but only
              // after our own parsers agree it is what the model says it is.
              for (const [k, v] of Object.entries(read.fields) as Array<[FieldKey, string]>) {
                const parsed = FIELDS[k].parse(v);
                if (parsed) s.values[k] = parsed;
              }
            }
            console.info(
              `[TICKET-AGENT] ${callId.slice(-6)} intent=${s.intent} via=${read?.source ?? 'rules'}` +
                `${read?.callerIsProfessional ? ' professional' : ''}` +
                ` needs=${needsFor(s.intent).join(',')}` +
                `${Object.keys(s.values).length ? ` already=${Object.keys(s.values).join(',')}` : ''}`,
            );
            return advance(callId, s);
          }

          /* STEP 4 — collect exactly what this intent needs. */
          case 'COLLECT': {
            const key = s.asking;
            if (!key) return advance(callId, s);
            if (key === 'callback_number' && YES.test(text) && !NO.test(text)) {
              const known = getLedger(callId)?.callbackNumber ?? getLedger(callId)?.callerPhone;
              if (known) {
                s.values.callback_number = known;
                updateLedger(callId, { callbackNumber: known, callbackConfirmed: true });
                s.asking = null;
                return advance(callId, s);
              }
            }
            const value = FIELDS[key].parse(text);
            if (value) {
              s.values[key] = value;
              if (key === 'patient_name') {
                const n = findNameIn(text);
                if (n) updateLedger(callId, { firstName: n.first, lastName: n.last });
              }
              if (key === 'patient_dob') updateLedger(callId, { dateOfBirth: value });
              if (key === 'callback_number') updateLedger(callId, { callbackNumber: value, callbackConfirmed: true });
              s.asking = null;
              // One breath, several answers. "The name is Wayne Fabian and the
              // date of birth is March 17th, 1973" answers TWO fields, and
              // asking for the second one back is what made a caller repeat
              // himself on the live 10:48 call. Salvage runs on success too,
              // not only when the parse failed.
              salvageMisdirected(callId, s, key, text);
              return advance(callId, s);
            }
            // Not an answer to THIS question — but callers answer the
            // question they expected, not the one they got. Live 17:01 call:
            // asked for a name, the caller said "March 17th, 1973", and the
            // date was thrown away; the agent then asked for the date of
            // birth it had just been given, and the ticket ended up with no
            // name AND no DOB.
            //
            // Only fields whose format IDENTIFIES them are eligible. A date
            // and an email can only be one thing. Names, locations, doctors
            // and free-text details are NOT eligible — their parsers accept
            // almost any string and would swallow every stray utterance. A
            // phone number counts only when exactly one phone-shaped field is
            // still missing, so a fax can never be filed as a callback.
            const salvaged = salvageMisdirected(callId, s, key, text);
            if (salvaged && (s.asks.get(key) ?? 0) >= 2) {
              // We got something real out of the turn; don't keep pushing on
              // the field they are plainly not answering.
              s.asking = null;
              return advance(callId, s);
            }

            // Ask once more, then move on without it.
            if ((s.asks.get(key) ?? 0) >= 2) {
              s.asking = null;
              return advance(callId, s);
            }
            return ask(callId, s, key);
          }

          /* Anything after the ticket: another request, or goodbye. */
          case 'EXECUTE':
          case 'WRAP': {
            if (NO.test(text) && !YES.test(text)) {
              s.step = 'DONE';
              return { say: t(s, LINES.wrap), endCall: true };
            }
            const stripped = text.replace(/\b(yes|yeah|sure|also|please|and|sí|si)\b/gi, ' ').trim();
            if (stripped.split(/\s+/).filter(Boolean).length >= 3) {
              s.intent = classify(text);
              s.values = { patient_name: s.values.patient_name, patient_dob: s.values.patient_dob, callback_number: s.values.callback_number };
              s.rawRequest = text.trim().slice(0, 300);
              s.filed = false;
              return advance(callId, s);
            }
            if (YES.test(text)) {
              s.step = 'CLASSIFY';
              return { say: t(s, LINES.askIntent) };
            }
            s.step = 'DONE';
            return { say: t(s, LINES.wrap), endCall: true };
          }

          default:
            return { say: null };
        }
      } catch (err) {
        console.warn(`[TICKET-AGENT] error on ${callId}:`, err);
        return { say: t(s, LINES.filedFallback), alert: `ticket agent error ${callId}: ${String(err)}` };
      }
    },
  };
}
