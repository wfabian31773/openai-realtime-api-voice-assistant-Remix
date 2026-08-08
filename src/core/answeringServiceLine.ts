/**
 * Answering Service — new-core line module (reconstruction-plan.md §3,
 * script-listing.md §1/§2/§6, both operator-approved 2026-08-07/08).
 *
 * The whole call is a state machine. Capabilities are structural: this
 * module's services carry fileTicket and verify — there is no transfer and
 * no scheduling to reach, no matter what is said or how many times.
 *
 * Interceptors run before state parsing on every utterance:
 *   URGENT     → 911-first line, then message flow at urgent priority
 *   HUMAN_REQ  → the busy-team line, verbatim, EVERY time, then resume
 *   SCHEDULE_REQ → the scheduling-team line, then message flow
 *
 * The unparsable ladder never surrenders to a prompt: re-ask once, then
 * advance along the scripted fallback (identity trouble → take the message
 * anyway; callback trouble → file with caller-ID + alert). There is no
 * model to disengage to — that is the point of the new core.
 */
import {
  getLedger,
  updateLedger,
  harvestCallerLine,
  dobMatchesContext,
} from '../services/callFactsLedger';
import type { CoreAction, LineModule, TicketLineServices, ClassifyResult } from './types';

type ASState =
  | 'INTENT'
  | 'CONFIRM_ID'
  | 'CONFIRM_DOB'
  | 'CLASSIFY'
  | 'COLLECT_NAME'
  | 'COLLECT_DOB'
  | 'TAKE_MESSAGE'
  | 'ASK_SURGEON'
  | 'ASK_LOCATION'
  | 'CONFIRM_CALLBACK'
  | 'COLLECT_CALLBACK'
  | 'WRAP_QUERY'
  | 'ENDED';

interface ASStatus {
  state: ASState;
  lang: 'en' | 'es';
  unparsed: number; // per-state; reset on every transition
  verifyFails: number;
  urgent: boolean;
  spanishHits: number;
  message: string | null;
  classification: ClassifyResult | null;
  surgeonAnswer: string | null;
  locationAnswer: string | null;
  unresolvedInfo: string | null;
  ticketsFiled: number;
}

const YES = /\b(yes|yeah|yep|ok|okay|correct|right|perfect|of course|sounds good|that works|that's (me|fine|good)|this is|speaking|sure|si|sí|claro|correcto|está bien|así es)\b/i;
const NO = /\b(no|nope|not|isn't|wrong|different|nothing|that's (all|it)|nada|eso es todo)\b/i;
const NEW_PAT = /\b(new|nuevo|nueva)\b/i;
const EXISTING = /\b(existing|current|already|been (there|seen)|existente|actual)\b/i;
const URGENT_RX = /\b(emergency|911|chest pain|can't see|sudden vision|bleeding|severe pain|emergencia|sangrando)\b/i;
const HUMAN_RX = /\b(representative|operator|receptionist|(real|actual|live) (person|human)|(talk|speak|connect me|transfer me).{0,20}\b(human|agent|person|somebody|someone)\b|human being)\b/i;
const SCHEDULE_RX = /\b(schedule|reschedule|cancel|book|appointment|make an? appt|cita|agendar|reagendar|cancelar)\b/i;
const PHONE_RX = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const DOB_RX = /\b(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b.*\b(19|20)\d{2}\b/i;
const DONT_KNOW = /\b(don'?t know|not sure|no idea|can'?t remember|no s[eé]|no estoy segur)/i;
const SPANISH_WORDS = /\b(hola|gracias|necesito|quiero|por favor|buenos|buenas|español|cita|ayuda|hablar|llamo|receta|lentes|doctora?)\b/gi;

/** Every line the caller can hear, EN + ES, from the approved listing. */
const L = {
  confirmId: (f: string) => ({
    en: `Am I speaking with ${f}?`,
    es: `¿Hablo con ${f}?`,
  }),
  confirmDob: {
    en: 'Great — just to confirm your identity, may I have your date of birth?',
    es: 'Perfecto — para confirmar su identidad, ¿me da su fecha de nacimiento?',
  },
  verified: (f: string) => ({
    en: `Thanks, ${f}.`,
    es: `Gracias, ${f}.`,
  }),
  thanks: {
    en: 'Thank you.',
    es: 'Gracias.',
  },
  verifyFail1: {
    en: "Hmm — that doesn't match what I have. Could you give me your last name one more time?",
    es: 'Mmm — eso no coincide con lo que tengo. ¿Me repite su apellido una vez más?',
  },
  verifyFail2: {
    en: "I'm not finding a match on my end — I'll take your information and have the team contact you.",
    es: 'No encuentro una coincidencia — tomaré su información para que el equipo le contacte.',
  },
  classify: {
    en: 'Are you calling for a new patient or an existing patient?',
    es: '¿Llama por un paciente nuevo o un paciente existente?',
  },
  newPatient: {
    en: "I'll take your details so our team can get you set up. May I have the patient's first and last name?",
    es: 'Tomaré sus datos para que nuestro equipo le registre. ¿Me da el nombre y apellido del paciente?',
  },
  collectName: {
    en: "May I have the patient's first and last name?",
    es: '¿Me da el nombre y apellido del paciente?',
  },
  collectDob: {
    en: "And the patient's date of birth?",
    es: '¿Y la fecha de nacimiento del paciente?',
  },
  takeMessage: {
    en: 'What would you like the team to know?',
    es: '¿Qué le gustaría que supiera el equipo?',
  },
  humanBusy: {
    en: 'All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available.',
    es: 'Todos nuestros agentes están ocupados en este momento — puedo tomar un mensaje para que el equipo le contacte tan pronto estén disponibles.',
  },
  scheduleReq: {
    en: "I can take down all the details and have our scheduling team take care of that for you — they'll call you back to confirm.",
    es: 'Puedo tomar todos los detalles para que nuestro equipo de citas se encargue — le llamarán para confirmar.',
  },
  urgent: {
    en: "If this is a medical emergency, please hang up and dial nine one one right away. Otherwise, I'll take your information and flag it urgent so the team gets to you first.",
    es: 'Si es una emergencia médica, cuelgue y marque nueve uno uno de inmediato. Si no, tomaré su información y la marcaré como urgente para que el equipo le atienda primero.',
  },
  askSurgeon: {
    en: 'Are you currently scheduled for surgery with us, and if so, who is your surgeon?',
    es: '¿Tiene una cirugía programada con nosotros? Si es así, ¿quién es su cirujano?',
  },
  askLocation: {
    en: 'Which Azul Vision office do you usually visit?',
    es: '¿Qué oficina de Azul Vision visita normalmente?',
  },
  confirmCallback: (last4: string) => ({
    en: `Is this number ending in ${last4} the best one to reach you?`,
    es: `¿Este número que termina en ${last4} es el mejor para contactarle?`,
  }),
  collectCallback: {
    en: "What's the best number to reach you?",
    es: '¿Cuál es el mejor número para contactarle?',
  },
  filing: {
    en: 'Give me one moment while I get this submitted for you.',
    es: 'Deme un momento mientras envío su solicitud.',
  },
  filed: {
    en: "You're all set — I've passed that to the team and they'll contact you as soon as they're available. Is there anything else?",
    es: 'Listo — le pasé su mensaje al equipo y le contactarán tan pronto estén disponibles. ¿Algo más?',
  },
  filedFallback: {
    en: "I've noted everything and the team will follow up with you. Is there anything else?",
    es: 'He anotado todo y el equipo le dará seguimiento. ¿Algo más?',
  },
  declined: {
    en: "No problem — the team is available during business hours if you'd like to call back. Is there anything else I can note for them?",
    es: 'No hay problema — el equipo está disponible en horario de oficina si desea volver a llamar. ¿Algo más que pueda anotar?',
  },
  anythingElse: {
    en: 'Is there anything else I can help you with?',
    es: '¿Hay algo más en que pueda ayudarle?',
  },
  wrap: {
    en: 'Thanks for calling Azul Vision — take care.',
    es: 'Gracias por llamar a Azul Vision — que esté bien.',
  },
} as const;

type Localized = { en: string; es: string };

/** Ticket-only line variants: same machine, different deflection script. */
export interface TicketLineConfig {
  slug?: string;
  /** The human-request deflection line (after-hours: "Our offices are closed…"). */
  humanBusy?: Localized;
}

export function createAnsweringServiceLine(services: TicketLineServices, cfg: TicketLineConfig = {}): LineModule {
  const calls = new Map<string, ASStatus>();
  const humanBusyLine: Localized = cfg.humanBusy ?? L.humanBusy;

  const t = (s: ASStatus, line: Localized): string => line[s.lang];

  const go = (s: ASStatus, state: ASState): void => {
    s.state = state;
    s.unparsed = 0;
  };

  /** The question the current state is waiting on — the re-ask ladder's rung. */
  const question = (callId: string, s: ASStatus): string => {
    const f = getLedger(callId);
    switch (s.state) {
      case 'CONFIRM_ID': return f?.matchedFirstName ? t(s, L.confirmId(f.matchedFirstName)) : t(s, L.classify);
      case 'CONFIRM_DOB': return t(s, L.confirmDob);
      case 'CLASSIFY': return t(s, L.classify);
      case 'COLLECT_NAME': return t(s, L.collectName);
      case 'COLLECT_DOB': return t(s, L.collectDob);
      case 'TAKE_MESSAGE': return t(s, L.takeMessage);
      case 'ASK_SURGEON': return t(s, L.askSurgeon);
      case 'ASK_LOCATION': return t(s, L.askLocation);
      case 'CONFIRM_CALLBACK': {
        const cb = f?.callbackNumber;
        return cb ? t(s, L.confirmCallback(cb.slice(-4))) : t(s, L.collectCallback);
      }
      case 'COLLECT_CALLBACK': return t(s, L.collectCallback);
      case 'WRAP_QUERY': return t(s, L.anythingElse);
      default: return t(s, L.takeMessage);
    }
  };

  /**
   * Scripted advance when a state fails to parse twice: never dead air,
   * never a prompt handoff — the call moves toward taking the message.
   */
  const fallForward = async (callId: string, s: ASStatus): Promise<CoreAction> => {
    switch (s.state) {
      case 'INTENT':
      case 'CONFIRM_ID':
      case 'CONFIRM_DOB':
      case 'CLASSIFY':
      case 'COLLECT_NAME':
      case 'COLLECT_DOB':
        return afterIdentity(callId, s, t(s, L.verifyFail2));
      case 'TAKE_MESSAGE':
        go(s, 'WRAP_QUERY');
        return { say: t(s, L.declined) };
      case 'ASK_SURGEON':
        s.unresolvedInfo = 'caller could not name their surgeon';
        return proceedToCallback(callId, s);
      case 'ASK_LOCATION':
        s.unresolvedInfo = 'caller could not name their office';
        return proceedToCallback(callId, s);
      case 'CONFIRM_CALLBACK':
      case 'COLLECT_CALLBACK': {
        // File with what we have — the caller-ID number — rather than loop.
        const cb = getLedger(callId)?.callbackNumber;
        if (cb) return fileNow(callId, s, 'callback unconfirmed — used caller ID');
        s.unresolvedInfo = 'no callback number captured';
        return fileNow(callId, s, 'no callback number captured');
      }
      case 'WRAP_QUERY':
        go(s, 'ENDED');
        return { say: t(s, L.wrap), endCall: true };
      default:
        go(s, 'ENDED');
        return { say: t(s, L.wrap), endCall: true };
    }
  };

  const unparsable = async (callId: string, s: ASStatus): Promise<CoreAction> => {
    s.unparsed += 1;
    if (s.unparsed >= 2) return fallForward(callId, s);
    return { say: question(callId, s) };
  };

  /**
   * Identity settled (verified or given up). The constants principle: if the
   * reason was already stated at INTENT, it is NEVER re-asked — the call
   * flows straight into department requirements and the callback confirm,
   * with the identity line prefixed onto the next question.
   */
  const afterIdentity = async (callId: string, s: ASStatus, prefix: string): Promise<CoreAction> => {
    if (s.message && s.message.trim().split(/\s+/).length >= 3) {
      const next = await afterMessage(callId, s);
      return { ...next, say: next.say ? `${prefix} ${next.say}` : prefix };
    }
    go(s, 'TAKE_MESSAGE');
    return { say: `${prefix} ${t(s, L.takeMessage)}` };
  };

  const proceedToCallback = (callId: string, s: ASStatus): CoreAction => {
    const f = getLedger(callId);
    if (f?.callbackNumber && !f.callbackConfirmed) {
      go(s, 'CONFIRM_CALLBACK');
      return { say: t(s, L.confirmCallback(f.callbackNumber.slice(-4))) };
    }
    if (!f?.callbackNumber) {
      go(s, 'COLLECT_CALLBACK');
      return { say: t(s, L.collectCallback) };
    }
    return fileNow(callId, s);
  };

  /**
   * Say-and-act: the wait line and the filing are one unit. The ticket is
   * classified and filed IN CODE; the confirmation line rides the result
   * (create_ticket=error → one silent retry → noted-line + ALERT, §6).
   */
  const fileNow = (callId: string, s: ASStatus, note?: string): CoreAction => {
    go(s, 'WRAP_QUERY');
    return {
      say: t(s, L.filing),
      followUp: async () => {
        const f = getLedger(callId);
        const description = [
          s.message ?? f?.intent ?? 'Caller request (details in transcript)',
          s.surgeonAnswer ? `Surgeon: ${s.surgeonAnswer}` : null,
          s.locationAnswer ? `Office: ${s.locationAnswer}` : null,
          note ? `NOTE: ${note}` : null,
        ].filter(Boolean).join(' — ');
        const c = s.classification ?? (await services.classify(description).catch(() => null));
        const input = {
          firstName: f?.firstName ?? f?.matchedFirstName ?? 'Unknown',
          lastName: f?.lastName ?? f?.matchedLastName ?? 'Caller',
          dateOfBirth: f?.dateOfBirth ?? f?.matchedDob ?? '',
          callbackNumber: f?.callbackNumber ?? f?.callerPhone ?? '',
          subject: (f?.intent ?? description).slice(0, 120),
          description,
          departmentId: c?.departmentId ?? 3,
          requestTypeId: c?.requestTypeId ?? 0,
          requestReasonId: c?.requestReasonId ?? 0,
          priority: s.urgent ? ('urgent' as const) : c?.priority ?? ('medium' as const),
          locationId: c?.locationId ?? null,
          providerId: c?.providerId ?? null,
          locationName: s.locationAnswer,
          providerName: s.surgeonAnswer,
          unresolvedInfo: s.unresolvedInfo,
        };
        let result = await services.fileTicket(input).catch(() => ({ ok: false }));
        if (!result.ok) result = await services.fileTicket(input).catch(() => ({ ok: false }));
        if (result.ok) {
          s.ticketsFiled += 1;
          return { say: t(s, L.filed) };
        }
        return {
          say: t(s, L.filedFallback),
          alert: `TICKET FILING FAILED after retry for ${callId} — sweep must recover: ${input.subject}`,
        };
      },
    };
  };

  /** Message captured → identity if still unknown → classify in code → surgery/optical requirements as scripted states. */
  const afterMessage = async (callId: string, s: ASStatus): Promise<CoreAction> => {
    const f0 = getLedger(callId);
    if (!f0?.firstName && !f0?.matchedFirstName) {
      // The human-request and urgent intercepts arrive here without the
      // identity chain — a ticket without a name never gets a callback.
      go(s, 'COLLECT_NAME');
      return { say: t(s, L.collectName) };
    }
    const c = await services.classify(s.message ?? '').catch(() => null);
    s.classification = c;
    if (c?.departmentId === 2 && !c.providerId && !s.surgeonAnswer) {
      go(s, 'ASK_SURGEON');
      return { say: t(s, L.askSurgeon) };
    }
    if (c?.departmentId === 1 && !c.locationId && !s.locationAnswer) {
      go(s, 'ASK_LOCATION');
      return { say: t(s, L.askLocation) };
    }
    return proceedToCallback(callId, s);
  };

  return {
    slug: cfg.slug ?? 'answering-service',

    start(callId: string): void {
      calls.set(callId, {
        state: 'INTENT',
        lang: 'en',
        unparsed: 0,
        verifyFails: 0,
        urgent: false,
        spanishHits: 0,
        message: null,
        classification: null,
        surgeonAnswer: null,
        locationAnswer: null,
        unresolvedInfo: null,
        ticketsFiled: 0,
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
      if (!s || s.state === 'ENDED') return { say: null };
      try {
        harvestCallerLine(callId, text);

        // Language follows the caller: two clear Spanish signals switch the
        // scripts (and the ledger) — never a refusal, never a shrug.
        s.spanishHits += (text.match(SPANISH_WORDS) ?? []).length;
        if (s.lang === 'en' && (s.spanishHits >= 2 || /\b(en español|spanish|habla español)\b/i.test(text))) {
          s.lang = 'es';
          updateLedger(callId, { language: 'Spanish' });
        }

        // Interceptors — before any state parsing, at every state.
        if (URGENT_RX.test(text) && !s.urgent) {
          s.urgent = true;
          if (s.message === null) {
            go(s, 'TAKE_MESSAGE');
            return { say: t(s, L.urgent) };
          }
          return { say: t(s, L.urgent) };
        }
        if (HUMAN_RX.test(text)) {
          // Same line, verbatim, EVERY time; then the call resumes where it was.
          const resume = s.state === 'INTENT' ? (go(s, 'TAKE_MESSAGE'), t(s, L.takeMessage)) : question(callId, s);
          return { say: `${t(s, humanBusyLine)} ${resume}` };
        }
        if (s.state === 'INTENT' && SCHEDULE_RX.test(text)) {
          updateLedger(callId, { intent: text.trim().slice(0, 200) });
          s.message = text.trim().slice(0, 300);
          const f = getLedger(callId);
          if (f?.matchedFirstName) {
            go(s, 'CONFIRM_ID');
            return { say: `${t(s, L.scheduleReq)} ${t(s, L.confirmId(f.matchedFirstName))}` };
          }
          go(s, 'CLASSIFY');
          return { say: `${t(s, L.scheduleReq)} ${t(s, L.classify)}` };
        }

        switch (s.state) {
          case 'INTENT': {
            if (text.trim().split(/\s+/).length < 2) return unparsable(callId, s);
            updateLedger(callId, { intent: text.trim().slice(0, 200) });
            s.message = text.trim().slice(0, 300);
            const f = getLedger(callId);
            if (f?.matchedFirstName) {
              go(s, 'CONFIRM_ID');
              return { say: t(s, L.confirmId(f.matchedFirstName)) };
            }
            go(s, 'CLASSIFY');
            return { say: t(s, L.classify) };
          }

          case 'CONFIRM_ID': {
            if (YES.test(text) && !NO.test(text)) {
              go(s, 'CONFIRM_DOB');
              return { say: t(s, L.confirmDob) };
            }
            if (NO.test(text)) {
              // Recognized number, different person: existing-patient family
              // path — collect who the patient is; never the new/existing
              // interview for a recognized household (ledger rule).
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'CONFIRM_DOB': {
            if (!DOB_RX.test(text)) return unparsable(callId, s);
            updateLedger(callId, { dateOfBirth: text.trim() });
            // Compare against the record we ALREADY pulled — no fresh lookup
            // for an ASR spelling to miss (operator 2026-08-07). Lookup only
            // when the matched record carries no DOB to compare against.
            let match = dobMatchesContext(callId, text.trim());
            const f = getLedger(callId);
            if (match === null) {
              match = await services
                .verifyByLookup(f?.matchedFirstName ?? '', f?.matchedLastName ?? '', text.trim())
                .catch(() => false);
            }
            if (match === true) {
              updateLedger(callId, {
                firstName: f?.matchedFirstName,
                lastName: f?.matchedLastName,
                identityVerified: true,
              });
              return afterIdentity(callId, s, t(s, L.verified(f?.matchedFirstName ?? '')));
            }
            s.verifyFails += 1;
            if (s.verifyFails >= 2) return afterIdentity(callId, s, t(s, L.verifyFail2));
            go(s, 'COLLECT_NAME');
            return { say: t(s, L.verifyFail1) };
          }

          case 'CLASSIFY': {
            if (NEW_PAT.test(text) && !EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'new' });
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.newPatient) };
            }
            if (EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'existing' });
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'COLLECT_NAME': {
            const words = text.trim().split(/\s+/).filter((w) => /^[a-záéíóúñ'-]+$/i.test(w));
            if (words.length < 2) return unparsable(callId, s);
            updateLedger(callId, { firstName: words[0], lastName: words.slice(1).join(' ') });
            go(s, 'COLLECT_DOB');
            return { say: t(s, L.collectDob) };
          }

          case 'COLLECT_DOB': {
            if (!DOB_RX.test(text)) return unparsable(callId, s);
            updateLedger(callId, { dateOfBirth: text.trim() });
            const f = getLedger(callId);
            if (f?.newOrExisting === 'new') {
              // New patients don't verify — straight on with the request.
              return afterIdentity(callId, s, t(s, L.thanks));
            }
            const ctx = dobMatchesContext(callId, text.trim());
            let ok = ctx === true;
            if (ctx === null) {
              ok = await services
                .verifyByLookup(f?.firstName ?? '', f?.lastName ?? '', text.trim())
                .catch(() => false);
            }
            if (ok) {
              updateLedger(callId, { identityVerified: true });
              return afterIdentity(callId, s, t(s, L.verified(f?.firstName ?? '')));
            }
            s.verifyFails += 1;
            if (s.verifyFails >= 2) return afterIdentity(callId, s, t(s, L.verifyFail2));
            go(s, 'COLLECT_NAME');
            return { say: t(s, L.verifyFail1) };
          }

          case 'TAKE_MESSAGE': {
            if (NO.test(text) && text.trim().split(/\s+/).length <= 4) {
              go(s, 'WRAP_QUERY');
              return { say: t(s, L.declined) };
            }
            if (text.trim().split(/\s+/).length < 2) return unparsable(callId, s);
            s.message = s.message && s.message !== text.trim().slice(0, 300)
              ? `${s.message} — ${text.trim().slice(0, 300)}`
              : text.trim().slice(0, 300);
            const prior = getLedger(callId)?.intent;
            updateLedger(callId, { intent: prior ? `${prior} — ${text.trim().slice(0, 200)}` : text.trim().slice(0, 200) });
            return afterMessage(callId, s);
          }

          case 'ASK_SURGEON': {
            if (DONT_KNOW.test(text) || NO.test(text)) {
              s.unresolvedInfo = 'caller does not know their surgeon';
              return proceedToCallback(callId, s);
            }
            const words = text.trim().split(/\s+/).filter((w) => /^(dr\.?|doctor|[a-záéíóúñ'-]+)$/i.test(w));
            if (!words.length) return unparsable(callId, s);
            s.surgeonAnswer = text.trim().slice(0, 80);
            return proceedToCallback(callId, s);
          }

          case 'ASK_LOCATION': {
            if (DONT_KNOW.test(text)) {
              s.unresolvedInfo = 'caller does not know their office';
              return proceedToCallback(callId, s);
            }
            if (!text.trim()) return unparsable(callId, s);
            s.locationAnswer = text.trim().slice(0, 80);
            return proceedToCallback(callId, s);
          }

          case 'CONFIRM_CALLBACK': {
            if (YES.test(text) && !NO.test(text)) {
              updateLedger(callId, { callbackConfirmed: true });
              return fileNow(callId, s);
            }
            if (NO.test(text) || PHONE_RX.test(text)) {
              const num = text.match(PHONE_RX);
              if (num) {
                updateLedger(callId, { callbackNumber: num[0].replace(/[^\d+]/g, ''), callbackConfirmed: true });
                return fileNow(callId, s);
              }
              go(s, 'COLLECT_CALLBACK');
              return { say: t(s, L.collectCallback) };
            }
            return unparsable(callId, s);
          }

          case 'COLLECT_CALLBACK': {
            const num = text.match(PHONE_RX);
            if (!num) return unparsable(callId, s);
            updateLedger(callId, { callbackNumber: num[0].replace(/[^\d+]/g, ''), callbackConfirmed: true });
            return fileNow(callId, s);
          }

          case 'WRAP_QUERY': {
            if (NO.test(text) && !YES.test(text)) {
              go(s, 'ENDED');
              return { say: t(s, L.wrap), endCall: true };
            }
            // Substance beyond a bare "yes" IS the second message — never make
            // the caller say it twice (the constants principle).
            const stripped = text.replace(/\b(actually|yes|yeah|yep|sure|please|also|sí|si|claro)\b/gi, ' ').trim();
            if (stripped.split(/\s+/).filter(Boolean).length >= 4 || YES.test(text)) {
              s.message = null;
              s.classification = null;
              s.surgeonAnswer = null;
              s.locationAnswer = null;
              s.unresolvedInfo = null;
              go(s, 'TAKE_MESSAGE');
              if (stripped.split(/\s+/).filter(Boolean).length >= 4) {
                s.message = text.trim().slice(0, 300);
                return afterMessage(callId, s);
              }
              return { say: t(s, L.takeMessage) };
            }
            return unparsable(callId, s);
          }

          default:
            return { say: null };
        }
      } catch (err) {
        // A line module must never take a call down: scripted recovery.
        console.warn(`[NEW-CORE][answering-service] error for ${callId}:`, err);
        return { say: t(s, L.filedFallback), alert: `core error for ${callId}: ${String(err)}` };
      }
    },
  };
}
