/**
 * SD Pilot / azul-scheduling — new-core line module (script-listing §4).
 *
 * The scheduling line differs from the ticket lines in one way that matters:
 * the SERVER already owns the offer. sage_availability returns a `say`
 * directive built from live openings, and sage_book books BY OPTION NUMBER
 * against that live offer. So this module never phrases an offer and never
 * invents a time — it speaks the server's sentence verbatim, maps the
 * caller's choice to an option number, and reads back the exact time it is
 * booking. The server refuses a mismatch; the state machine makes a mismatch
 * unreachable.
 *
 * Capability matrix: this line SCHEDULES and may transfer (second human ask,
 * new patients, booking failure). It never files answering-service tickets.
 */
import { getLedger, updateLedger, harvestCallerLine, dobMatchesContext } from '../services/callFactsLedger';
import type { CoreAction, LineModule } from './types';
import { looksLikeName, DOB_PATTERN, normalizeSpokenDob } from './parsing';

export interface AvailabilityOffer {
  /** The server's speakable offer — spoken WORD-FOR-WORD, never rephrased. */
  say: string;
  /** Clock times per option number (1-based), 24h HH:MM, for the read-back. */
  optionTimes: string[];
  empty?: boolean;
}

export interface SchedulingLineServices {
  verifyIdentity(callId: string, first: string, last: string, dob: string): Promise<boolean>;
  availability(callId: string, pref: { preferredDate?: string; timeOfDay?: 'AM' | 'PM' | 'ALL'; preferredTime?: string; providerName?: string; locationName?: string }): Promise<AvailabilityOffer>;
  book(callId: string, input: { optionNumber: number; confirmedTimeSpoken: string }): Promise<{ status: 'confirmed' | 'unknown' | 'failed'; say?: string; patientScript?: string }>;
  /** Transfer to the office queue; also used for new patients and book failures. */
  transfer(callId: string, reason: string): Promise<{ ok: boolean }>;
}

type SdState =
  | 'INTENT'
  | 'CONFIRM_ID'
  | 'CONFIRM_DOB'
  | 'CLASSIFY'
  | 'COLLECT_NAME'
  | 'COLLECT_DOB'
  | 'ASK_PREFERENCE'
  | 'OFFER'
  | 'CONFIRM_TIME'
  | 'WRAP_QUERY'
  | 'ENDED';

interface SdStatus {
  state: SdState;
  lang: 'en' | 'es';
  unparsed: number;
  verifyFails: number;
  humanAsks: number;
  offer: AvailabilityOffer | null;
  chosenOption: number | null;
  retriedAvailability: boolean;
  /** One "soonest available" attempt before handing a verified patient off. */
  triedEarliest: boolean;
  pref: { preferredDate?: string; timeOfDay?: 'AM' | 'PM' | 'ALL'; preferredTime?: string; providerName?: string; locationName?: string };
}

const YES = /\b(yes|yeah|yep|ok|okay|sure|correct|right|perfect|that works|(the )?(first|second) one|si|sí|claro|correcto|está bien)\b/i;
const NO = /\b(no|nope|not|neither|another|different|else|nothing|that's (all|it)|nada|otro|otra)\b/i;
const NEW_PAT = /\b(new|nuevo|nueva|never been|first time)\b/i;
const EXISTING = /\b(existing|current|already|been (there|seen)|existente)\b/i;
const URGENT_RX = /\b(emergency|911|chest pain|sudden vision|bleeding|severe pain|emergencia)\b/i;
const HUMAN_RX = /\b(representative|operator|receptionist|(real|actual|live) (person|human)|(talk|speak|connect me|transfer me).{0,20}\b(human|agent|person|somebody|someone)\b)\b/i;
const DOB_RX = DOB_PATTERN;
const OPTION_1 = /\b(first|one|1|earlier|primera|primero|uno)\b/i;
const OPTION_2 = /\b(second|two|2|later|segunda|segundo|dos)\b/i;
const SPANISH_WORDS = /\b(hola|gracias|necesito|quiero|por favor|buenos|buenas|español|cita|ayuda|doctora?)\b/gi;
const AM_RX = /\b(morning|a\.?m\.?|mañana)\b/i;
const PM_RX = /\b(afternoon|evening|p\.?m\.?|tarde)\b/i;
const TIME_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?\b/i;
const PROVIDER_RX = /\b(?:dr\.?|doctor)\s+([a-záéíóúñ'-]+)/i;

const L = {
  confirmId: (f: string) => ({ en: `Am I speaking with ${f}?`, es: `¿Hablo con ${f}?` }),
  confirmDob: {
    en: 'Great — just to confirm your identity, may I have your date of birth?',
    es: 'Perfecto — para confirmar su identidad, ¿me da su fecha de nacimiento?',
  },
  classify: { en: 'Are you calling for a new patient or an existing patient?', es: '¿Llama por un paciente nuevo o un paciente existente?' },
  collectName: { en: "May I have the patient's first and last name?", es: '¿Me da el nombre y apellido del paciente?' },
  collectDob: { en: "And the patient's date of birth?", es: '¿Y la fecha de nacimiento del paciente?' },
  verifyFail1: {
    en: "Hmm — that doesn't match what I have. Could you give me your last name one more time?",
    es: 'Mmm — eso no coincide con lo que tengo. ¿Me repite su apellido una vez más?',
  },
  verifyFail2: {
    en: "I'm not finding a match on my end — let me get you over to our team so they can help. One moment.",
    es: 'No encuentro una coincidencia — le comunico con nuestro equipo para que le ayuden. Un momento.',
  },
  newPatient: {
    en: "I'm unable to schedule new patients, but our team can take care of that for you — one moment while I connect you.",
    es: 'No puedo agendar pacientes nuevos, pero nuestro equipo puede ayudarle — un momento mientras le comunico.',
  },
  askPreference: { en: 'What day and times work best for you?', es: '¿Qué día y hora le funcionan mejor?' },
  noneWork: { en: 'What other day or time would work for you?', es: '¿Qué otro día u hora le funcionaría?' },
  bookFail: {
    en: "I'm having trouble finalizing that on my end — let me get you over to our team so they can lock it in. One moment.",
    es: 'Tengo dificultad para finalizar eso — le comunico con nuestro equipo para que lo confirmen. Un momento.',
  },
  human1: { en: 'I can usually help faster — may I ask what it\'s regarding?', es: 'Normalmente puedo ayudarle más rápido — ¿de qué se trata?' },
  human2: { en: 'Of course — one moment while I connect you.', es: 'Por supuesto — un momento mientras le comunico.' },
  urgent: {
    en: 'If this is a medical emergency, please hang up and dial nine one one right away. Otherwise let me get you to our team now — one moment.',
    es: 'Si es una emergencia médica, cuelgue y marque nueve uno uno de inmediato. Si no, le comunico con nuestro equipo ahora — un momento.',
  },
  anythingElse: { en: 'Is there anything else I can help you with?', es: '¿Hay algo más en que pueda ayudarle?' },
  wrap: { en: 'Thanks for calling Azul Vision — take care.', es: 'Gracias por llamar a Azul Vision — que esté bien.' },
} as const;

type Localized = { en: string; es: string };

/** "Tuesday at 9:00" → the option's HH:MM, spoken back exactly as booked. */
function speakTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hr}:${String(m).padStart(2, '0')} ${ampm}` : `${hr} ${ampm}`;
}

export function createSchedulingLine(services: SchedulingLineServices): LineModule {
  const calls = new Map<string, SdStatus>();
  const t = (s: SdStatus, line: Localized): string => line[s.lang];
  const go = (s: SdStatus, state: SdState): void => {
    s.state = state;
    s.unparsed = 0;
  };

  const question = (callId: string, s: SdStatus): string => {
    const f = getLedger(callId);
    switch (s.state) {
      case 'CONFIRM_ID': return f?.matchedFirstName ? t(s, L.confirmId(f.matchedFirstName)) : t(s, L.classify);
      case 'CONFIRM_DOB': return t(s, L.confirmDob);
      case 'CLASSIFY': return t(s, L.classify);
      case 'COLLECT_NAME': return t(s, L.collectName);
      case 'COLLECT_DOB': return t(s, L.collectDob);
      case 'ASK_PREFERENCE': return t(s, L.askPreference);
      case 'OFFER': return s.offer?.say ?? t(s, L.askPreference);
      case 'WRAP_QUERY': return t(s, L.anythingElse);
      default: return t(s, L.askPreference);
    }
  };

  /** Any exit that belongs with a human: say the line, then dial, in one unit. */
  const transferNow = (callId: string, s: SdStatus, line: string, reason: string): CoreAction => {
    go(s, 'ENDED');
    return {
      say: line,
      followUp: async () => {
        const r = await services.transfer(callId, reason).catch(() => ({ ok: false }));
        if (r.ok) return { say: null };
        return {
          say: "The team isn't picking up right now — I'll make sure they get your information and call you back.",
          alert: `SD transfer failed for ${callId} (${reason})`,
        };
      },
    };
  };

  /** Availability is a DIRECTIVE: the server's sentence is spoken verbatim. */
  const offerNow = (callId: string, s: SdStatus): CoreAction => {
    go(s, 'OFFER');
    return {
      say: null,
      followUp: async () => {
        const offer = await services.availability(callId, s.pref).catch(() => null);
        if (!offer) {
          if (!s.retriedAvailability) {
            s.retriedAvailability = true;
            const retry = await services.availability(callId, s.pref).catch(() => null);
            if (retry) {
              s.offer = retry;
              return { say: retry.say };
            }
          }
          return transferNow(callId, s, t(s, L.bookFail), 'availability unavailable');
        }
        s.offer = offer;
        if (offer.empty) {
          // The server's 'say' already leads with the day-mismatch admission
          // (toolDirection.acknowledgeDayMismatch) — never paper over it.
          go(s, 'ASK_PREFERENCE');
          return { say: offer.say };
        }
        return { say: offer.say };
      },
    };
  };

  /** Read back the exact time being booked, then book by option number. */
  const bookNow = (callId: string, s: SdStatus, option: number): CoreAction => {
    const time = s.offer?.optionTimes[option - 1];
    if (!time) {
      go(s, 'ASK_PREFERENCE');
      return { say: t(s, L.noneWork) };
    }
    s.chosenOption = option;
    go(s, 'CONFIRM_TIME');
    return {
      say: `Booking you for ${speakTime(time)} — one moment while I lock that in.`,
      followUp: async () => {
        const r = await services
          .book(callId, { optionNumber: option, confirmedTimeSpoken: time })
          .catch(() => ({ status: 'failed' as const }));
        if (r.status === 'confirmed') {
          go(s, 'WRAP_QUERY');
          // The server's confirmation sentence carries day/time/location.
          return { say: r.say ?? `You're all set for ${speakTime(time)}. You'll get a text confirmation shortly. Is there anything else?` };
        }
        if (r.status === 'unknown') {
          go(s, 'WRAP_QUERY');
          // Never claim booked on 'unknown' — the server already queued a
          // scheduler callback and hands back the exact script.
          return { say: r.patientScript ?? "I've got that request in with our scheduling team and they'll confirm with you shortly. Is there anything else?" };
        }
        return transferNow(callId, s, t(s, L.bookFail), 'booking failed');
      },
    };
  };

  /** Parse a stated preference into the availability arguments. */
  const capturePreference = (s: SdStatus, text: string): void => {
    const day = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes)\b/i);
    if (day) s.pref.preferredDate = day[1].toLowerCase(); // resolved to a date by the service adapter
    const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) s.pref.preferredDate = iso[1];
    if (AM_RX.test(text)) s.pref.timeOfDay = 'AM';
    else if (PM_RX.test(text)) s.pref.timeOfDay = 'PM';
    const time = text.match(TIME_RX);
    if (time && Number(time[1]) <= 12) {
      const h = Number(time[1]);
      const min = time[2] ?? '00';
      const pm = PM_RX.test(text) || /p\.?m\.?/i.test(time[3] ?? '');
      const h24 = pm && h < 12 ? h + 12 : h;
      s.pref.preferredTime = `${String(h24).padStart(2, '0')}:${min}`;
    }
    const prov = text.match(PROVIDER_RX);
    if (prov) s.pref.providerName = prov[0];
  };

  const fallForward = (callId: string, s: SdStatus): CoreAction => {
    // The scheduling line always has somewhere to send a caller: a human.
    switch (s.state) {
      case 'CONFIRM_ID':
      case 'CLASSIFY':
        // An unclear answer to "new or existing" is NOT a reason to hand a
        // patient to staff — just ask who they are. 187 replayed calls were
        // transferred from here (Gate B SD 2026-08-09).
        go(s, 'COLLECT_NAME');
        return { say: t(s, L.collectName) };
      case 'CONFIRM_DOB':
      case 'COLLECT_NAME':
      case 'COLLECT_DOB':
        return transferNow(callId, s, t(s, L.verifyFail2), 'identity not established');
      case 'ASK_PREFERENCE':
      case 'OFFER':
        // Before giving up on a verified patient who wants an appointment,
        // ask the server for the soonest opening — a scheduler's move.
        if (!s.triedEarliest) {
          s.triedEarliest = true;
          s.pref = {};
          s.retriedAvailability = false;
          return offerNow(callId, s);
        }
        return transferNow(callId, s, t(s, L.human2), 'preference not captured');
      case 'WRAP_QUERY':
        go(s, 'ENDED');
        return { say: t(s, L.wrap), endCall: true };
      default:
        return transferNow(callId, s, t(s, L.human2), 'unparsable');
    }
  };

  const unparsable = (callId: string, s: SdStatus): CoreAction => {
    s.unparsed += 1;
    if (s.unparsed >= 2) return fallForward(callId, s);
    return { say: question(callId, s) };
  };

  /** DOB in hand → verify against the pulled record, then the preference ask. */
  const handleDob = async (callId: string, s: SdStatus, text: string): Promise<CoreAction> => {

            // Verification needs YYYY-MM-DD; the caller said "August
            // twenty-seven, forty-five". Normalize before comparing, or the
            // recognised date fails anyway (review 2026-08-09).
            const spokenDob = normalizeSpokenDob(text) ?? text.trim();
            updateLedger(callId, { dateOfBirth: spokenDob });
            const f = getLedger(callId);
            if (f?.newOrExisting === 'new') {
              return transferNow(callId, s, t(s, L.newPatient), 'new patient');
            }
            const first = f?.firstName ?? f?.matchedFirstName ?? '';
            const last = f?.lastName ?? f?.matchedLastName ?? '';
            // Context first: compare to the record already pulled.
            let ok = dobMatchesContext(callId, spokenDob) === true;
            if (!ok) {
              ok = await services.verifyIdentity(callId, first, last, spokenDob).catch(() => false);
            }
            if (ok) {
              updateLedger(callId, { firstName: first, lastName: last, identityVerified: true });
              return afterVerified(callId, s, `Thanks, ${first}.`);
            }
            s.verifyFails += 1;
            if (s.verifyFails >= 2) return transferNow(callId, s, t(s, L.verifyFail2), 'identity not verified');
            go(s, 'COLLECT_NAME');
            return { say: t(s, L.verifyFail1) };
  };

  const afterVerified = (callId: string, s: SdStatus, prefix: string): CoreAction => {
    go(s, 'ASK_PREFERENCE');
    return { say: `${prefix} ${t(s, L.askPreference)}` };
  };

  return {
    slug: 'azul-scheduling',

    start(callId: string): void {
      // The SD greeting for a RECOGNIZED caller already asks "Am I speaking
      // with {first}?" — so the caller's first words answer that question,
      // not "why are you calling". Starting at INTENT here is what killed
      // ramp v1 live on 2026-08-07; the replay caught the same shape.
      const seeded = getLedger(callId);
      calls.set(callId, {
        state: seeded?.matchedFirstName ? 'CONFIRM_ID' : 'INTENT',
        lang: 'en',
        unparsed: 0,
        verifyFails: 0,
        humanAsks: 0,
        offer: null,
        chosenOption: null,
        retriedAvailability: false,
        triedEarliest: false,
        pref: {},
      });
    },

    stateOf(callId: string): string | null {
      return calls.get(callId)?.state ?? null;
    },

    release(callId: string): void {
      calls.delete(callId);
    },

    async onUtterance(callId: string, text: string): Promise<CoreAction> {
      const s = calls.get(callId);
      if (!s) return { say: null };
      // Safety outranks state here too. And the line PROMISES a human, so
      // it hands off for real — returning only the script left late
      // emergency callers promised a person and given none (review
      // 2026-08-09).
      if (URGENT_RX.test(text) && s.state === 'ENDED') {
        s.state = 'CONFIRM_TIME'; // leave ENDED so transferNow can run
        return transferNow(callId, s, t(s, L.urgent), 'urgent symptoms after wrap');
      }
      if (s.state === 'ENDED') return { say: null };
      try {
        harvestCallerLine(callId, text);

        const spanishHits = (text.match(SPANISH_WORDS) ?? []).length;
        if (s.lang === 'en' && (spanishHits >= 2 || /\b(en español|habla español)\b/i.test(text))) {
          s.lang = 'es';
          updateLedger(callId, { language: 'Spanish' });
        }

        if (URGENT_RX.test(text)) {
          return transferNow(callId, s, t(s, L.urgent), 'urgent symptoms');
        }
        if (HUMAN_RX.test(text)) {
          s.humanAsks += 1;
          if (s.humanAsks === 1) return { say: t(s, L.human1) };
          return transferNow(callId, s, t(s, L.human2), 'caller asked for a person twice');
        }

        switch (s.state) {
          case 'INTENT': {
            if (text.trim().split(/\s+/).length < 2) return unparsable(callId, s);
            updateLedger(callId, { intent: text.trim().slice(0, 200) });
            capturePreference(s, text);
            const f = getLedger(callId);
            if (f?.matchedFirstName) {
              go(s, 'CONFIRM_ID');
              return { say: t(s, L.confirmId(f.matchedFirstName)) };
            }
            go(s, 'CLASSIFY');
            return { say: t(s, L.classify) };
          }

          case 'CONFIRM_ID': {
            // A caller who answers with their date of birth has confirmed
            // identity and answered the next question at once — take both.
            if (DOB_RX.test(text) && !NO.test(text)) {
              go(s, 'CONFIRM_DOB');
              return handleDob(callId, s, text);
            }
            if (YES.test(text) && !NO.test(text)) {
              go(s, 'CONFIRM_DOB');
              return { say: t(s, L.confirmDob) };
            }
            if (NO.test(text)) {
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'CONFIRM_DOB':
          case 'COLLECT_DOB': {
            if (!DOB_RX.test(text)) return unparsable(callId, s);
            return handleDob(callId, s, text);
          }

          case 'CLASSIFY': {
            if (NEW_PAT.test(text) && !EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'new' });
              return transferNow(callId, s, t(s, L.newPatient), 'new patient');
            }
            if (EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'existing' });
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'COLLECT_NAME': {
            const name = looksLikeName(text);
            if (!name) return unparsable(callId, s);
            updateLedger(callId, { firstName: name.first, lastName: name.last });
            go(s, 'COLLECT_DOB');
            return { say: t(s, L.collectDob) };
          }

          case 'ASK_PREFERENCE': {
            if (text.trim().split(/\s+/).length < 1) return unparsable(callId, s);
            const before = JSON.stringify(s.pref);
            capturePreference(s, text);
            if (JSON.stringify(s.pref) === before && !/\b(any|whatever|soonest|earliest|cualquier)\b/i.test(text)) {
              return unparsable(callId, s);
            }
            s.retriedAvailability = false;
            return offerNow(callId, s);
          }

          case 'OFFER': {
            // "the second one" contains both ordinals — the LAST one stated
            // wins ("not the first, the second"), which is how people correct
            // themselves out loud.
            // "the second one": here "one" is a noun, not the ordinal — drop
            // it before matching, or every "second one" books option 1.
            const ord = text.replace(/\b(first|second|1st|2nd|primer[oa]|segund[oa])\s+one\b/gi, '$1');
            const i1 = ord.search(OPTION_1);
            const i2 = ord.search(OPTION_2);
            if (i2 >= 0 && (i1 < 0 || i2 > i1)) return bookNow(callId, s, 2);
            if (i1 >= 0) return bookNow(callId, s, 1);
            if (YES.test(text) && !NO.test(text)) return bookNow(callId, s, 1);
            if (NO.test(text)) {
              // A different day/time is reachable ONLY by asking the server again.
              go(s, 'ASK_PREFERENCE');
              return { say: t(s, L.noneWork) };
            }
            // A restated preference re-runs availability rather than guessing.
            const before = JSON.stringify(s.pref);
            capturePreference(s, text);
            if (JSON.stringify(s.pref) !== before) {
              s.retriedAvailability = false;
              return offerNow(callId, s);
            }
            return unparsable(callId, s);
          }

          case 'WRAP_QUERY': {
            if (NO.test(text) && !YES.test(text)) {
              go(s, 'ENDED');
              return { say: t(s, L.wrap), endCall: true };
            }
            const stripped = text.replace(/\b(actually|yes|yeah|yep|sure|please|also|sí|si|claro)\b/gi, ' ').trim();
            if (stripped.split(/\s+/).filter(Boolean).length >= 4 || YES.test(text)) {
              s.offer = null;
              s.chosenOption = null;
              s.pref = {};
              go(s, 'ASK_PREFERENCE');
              if (stripped.split(/\s+/).filter(Boolean).length >= 4) {
                capturePreference(s, text);
                if (Object.keys(s.pref).length) return offerNow(callId, s);
              }
              return { say: t(s, L.askPreference) };
            }
            return unparsable(callId, s);
          }

          default:
            return { say: null };
        }
      } catch (err) {
        console.warn(`[NEW-CORE][azul-scheduling] error for ${callId}:`, err);
        return transferNow(callId, s, t(s, L.human2), `core error: ${String(err)}`);
      }
    },
  };
}
