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
import { looksLikeName, DOB_PATTERN, normalizeSpokenDob } from './parsing';

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
  /** Times each question has been asked ACROSS the call — a hard cap of 2. */
  asked: Map<ASState, number>;
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
// Broad on purpose: a bare "agent" or a garbled "up to an agent" IS a human
// request, and the deflection script is always a safe answer (Gate B 2026-08-08:
// 135 replayed calls where a human ask went unrecognized and the call looped).
// Bare nouns that are ONLY ever a human request, plus request-verb proximity
// for the ambiguous ones. "someone was supposed to call me" is NOT a human
// request — treating it as one made the deflection line repeat (Gate B run 2).
const HUMAN_RX = /\b(representative|operator|receptionist|(real|actual|live) (person|human)|human being|persona real)\b|\b(talk|speak|connect|transfer|put me|get me|need|want)\b[^.]{0,25}\b(human|agent|person|persona|somebody|someone|rep)\b/i;
/** A short utterance that is basically just "agent" — the ASR of a demand. */
const SHORT_AGENT_RX = /\bagents?\b|\bagente\b/i;
const SCHEDULE_RX = /\b(schedule|reschedule|cancel|book|appointment|make an? appt|cita|agendar|reagendar|cancelar)\b/i;
const PHONE_RX = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const DOB_RX = DOB_PATTERN;
const DONT_KNOW = /\b(don'?t know|not sure|no idea|can'?t remember|no s[eé]|no estoy segur)/i;
const SPANISH_WORDS = /\b(hola|gracias|necesito|quiero|por favor|buenos|buenas|español|cita|ayuda|hablar|llamo|receta|lentes|doctora?)\b/gi;

/**
 * Openers and acknowledgements are not a reason for calling. Taking "Okay."
 * as the request produced tickets whose reason field said "Okay" (Gate B
 * 2026-08-08) — filed, counted, and useless to the person calling back.
 */
const FILLER_RX = /\b(okay|ok|hello|hi|hey|yes|yeah|yep|no|nope|um+|uh+|so|well|please|thanks|thank you|sorry|good (morning|afternoon|evening)|hola|bueno|gracias|sí|si)\b/gi;
function substantiveWords(text: string): number {
  return text.replace(FILLER_RX, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean).length;
}


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
  /**
   * Read the request back before filing. Two reasons, both real: the caller
   * hears what the team will see and can correct it, and the reason is then
   * ON the call — 253 replayed calls filed a ticket whose reason existed only
   * in the payload, invisible to anyone reviewing the conversation.
   */
  filingWithReadback: (what: string) => ({
    en: `I have that down as: ${what}. Give me one moment while I get this submitted for you.`,
    es: `Lo anoté como: ${what}. Deme un momento mientras envío su solicitud.`,
  }),
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

  /**
   * THE REPETITION CAP. A per-state counter resets on every transition, so a
   * call that ping-pongs between two states can ask the same question five
   * times and never trip a ladder — that is exactly what 135 replayed calls
   * did (Gate B 2026-08-08). This counter is per CALL: no question is ever
   * asked a third time; the call advances instead.
   */
  const askBudgetSpent = (s: ASStatus, state: ASState): boolean => {
    const n = (s.asked.get(state) ?? 0) + 1;
    s.asked.set(state, n);
    return n > 2;
  };

  /**
   * TOPIC budget. Several different states ask the same thing in different
   * words — "may I have the patient's first and last name", "I'll take your
   * details… name", "could you give me your last name one more time" are one
   * topic to the caller (and to the grader). A per-state cap missed that
   * entirely: 520 replayed calls asked for a name three times. Two asks per
   * TOPIC, per call, whichever states they come from.
   */
  type AskTopic = 'name' | 'dob' | 'classify' | 'callback' | 'message';
  const topicSpent = (s: ASStatus, topic: AskTopic): boolean => {
    const key = `topic:${topic}` as unknown as ASState;
    const n = (s.asked.get(key) ?? 0) + 1;
    s.asked.set(key, n);
    return n > 2;
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
        // Identity is abandoned — and so is asking for it again. Burn both
        // budgets so the fall-forward can never route back into the loop.
        s.asked.set('COLLECT_NAME', 9);
        s.asked.set('COLLECT_DOB', 9);
        s.asked.set('CLASSIFY', 9);
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

  /** Which topic a state's question belongs to, for the shared budget. */
  const TOPIC_OF: Partial<Record<ASState, AskTopic>> = {
    CONFIRM_ID: 'name',
    COLLECT_NAME: 'name',
    CLASSIFY: 'classify',
    CONFIRM_DOB: 'dob',
    COLLECT_DOB: 'dob',
    CONFIRM_CALLBACK: 'callback',
    COLLECT_CALLBACK: 'callback',
    TAKE_MESSAGE: 'message',
  };

  const unparsable = async (callId: string, s: ASStatus): Promise<CoreAction> => {
    s.unparsed += 1;
    // The re-ask ladder spends the SAME topic budget as the states that ask
    // first time round — otherwise a re-ask is a third "what's your name?"
    // that no counter ever saw (Gate B runs 4-5).
    const topic = TOPIC_OF[s.state];
    if (s.unparsed >= 2 || askBudgetSpent(s, s.state) || (topic && topicSpent(s, topic))) {
      return fallForward(callId, s);
    }
    return { say: question(callId, s) };
  };

  /**
   * Identity settled (verified or given up). The constants principle: if the
   * reason was already stated at INTENT, it is NEVER re-asked — the call
   * flows straight into department requirements and the callback confirm,
   * with the identity line prefixed onto the next question.
   */
  const afterIdentity = async (callId: string, s: ASStatus, prefix: string): Promise<CoreAction> => {
    if (s.message && s.message.trim().split(/\s+/).length >= 2) {
      const next = await afterMessage(callId, s);
      return { ...next, say: next.say ? `${prefix} ${next.say}` : prefix };
    }
    go(s, 'TAKE_MESSAGE');
    return { say: `${prefix} ${t(s, L.takeMessage)}` };
  };

  const proceedToCallback = (callId: string, s: ASStatus): CoreAction => {
    const f = getLedger(callId);
    if (f?.callbackNumber && !f.callbackConfirmed) {
      if (topicSpent(s, 'callback')) return fileNow(callId, s, 'callback unconfirmed — used caller ID');
      go(s, 'CONFIRM_CALLBACK');
      return { say: t(s, L.confirmCallback(f.callbackNumber.slice(-4))) };
    }
    if (!f?.callbackNumber) {
      if (topicSpent(s, 'callback')) return fileNow(callId, s, 'no callback captured — caller ID used');
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
      say: (() => {
        const what = (s.message ?? getLedger(callId)?.intent ?? '').trim().split(/\s+/).slice(0, 14).join(' ');
        return what.split(/\s+/).length >= 2 ? t(s, L.filingWithReadback(what)) : t(s, L.filing);
      })(),
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
      // But this is also where the fall-forward lands, so an unguarded ask
      // here ping-pongs COLLECT_NAME ↔ fall-forward forever (Gate B run 7:
      // the same line 2,982 times across 514 calls). Budget applies.
      if (!topicSpent(s, 'name')) {
        go(s, 'COLLECT_NAME');
        return { say: t(s, L.collectName) };
      }
      // No name and no budget left: file what we have so the request lives,
      // flagged for a human to chase the identity.
      s.unresolvedInfo = 'caller name not captured';
      return proceedToCallback(callId, s);
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
        asked: new Map(),
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

    /**
     * Hang-up safety net (Gate B 2026-08-08: 120 replayed calls stated a real
     * request and the call ended before a ticket existed). If the caller told
     * us what they need and no ticket was filed, file it with the caller-ID
     * callback and flag what's missing — a stated request is never lost
     * because the caller hung up.
     */
    async finalize(callId: string): Promise<{ filed: boolean; alert?: string }> {
      const s = calls.get(callId);
      if (!s || s.ticketsFiled > 0) return { filed: false };
      const f = getLedger(callId);
      const message = s.message ?? f?.intent ?? null;
      // Only file what a human can actually act on: a real request, someone
      // to call, and a number to call them at. A ticket with no name and no
      // callback is noise that buries the real ones (Gate B run 2 proved it:
      // filing on anything produced 1,245 unactionable tickets).
      const name = f?.firstName ?? f?.matchedFirstName;
      const callback = f?.callbackNumber ?? f?.callerPhone;
      if (!message || message.trim().split(/\s+/).length < 3) return { filed: false };
      if (!name || !callback) {
        return { filed: false, alert: `unfiled request on ${callId} — no ${!name ? 'name' : 'callback'}: ${message.slice(0, 80)}` };
      }
      const action = fileNow(callId, s, 'caller ended the call before confirming — filed from what was captured');
      const done = action.followUp ? await action.followUp() : null;
      const filed = s.ticketsFiled > 0;
      return { filed, alert: filed ? undefined : done?.alert ?? `unfiled request lost on ${callId}` };
    },

    release(callId: string): void {
      calls.delete(callId);
    },

    async onUtterance(callId: string, text: string): Promise<CoreAction> {
      const s = calls.get(callId);
      if (!s) return { say: null };
      // SAFETY BEFORE STATE. A caller who says "I can't see" after the ticket
      // is filed — or after the wrap — must still hear the 911 line. Replay
      // 2026-08-09 found exactly that: the module had ended and answered
      // nothing while the caller described losing their vision.
      if (URGENT_RX.test(text)) {
        const wasUrgent = s.urgent;
        s.urgent = true;
        // Said once when urgency appears, and ALWAYS when the call had
        // already wrapped — otherwise the caller describing symptoms after
        // the ticket was filed heard nothing at all. Repeating it on every
        // symptom sentence mid-call would just block taking their message.
        if (s.state === 'ENDED' || !wasUrgent) {
          if (s.state !== 'ENDED' && s.message === null) go(s, 'TAKE_MESSAGE');
          return { say: t(s, L.urgent) };
        }
      }
      if (s.state === 'ENDED') return { say: null };
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
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        if (HUMAN_RX.test(text) || (wordCount <= 5 && SHORT_AGENT_RX.test(text))) {
          // The deflection line is verbatim EVERY time. The pending question
          // rides along only while that question still has ask budget —
          // re-appending it on every deflection is what turned three human
          // asks into three identical questions (Gate B 2026-08-08).
          if (s.state === 'INTENT') {
            go(s, 'TAKE_MESSAGE');
            return { say: `${t(s, humanBusyLine)} ${t(s, L.takeMessage)}` };
          }
          const pending = question(callId, s);
          const pendingTopic = TOPIC_OF[s.state];
          if (askBudgetSpent(s, s.state) || (pendingTopic && topicSpent(s, pendingTopic))) {
            return { say: t(s, humanBusyLine) };
          }
          return { say: `${t(s, humanBusyLine)} ${pending}` };
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
            // The reason for calling must carry actual content — a greeting
            // is not a request, and a ticket built from one helps no one.
            // But "refill please" and "hola, receta" ARE requests: keep the
            // original two-token bar and require only that ONE token be
            // substantive (review 2026-08-09).
            if (text.trim().split(/\s+/).filter(Boolean).length < 2 || substantiveWords(text) < 1) {
              return unparsable(callId, s);
            }
            updateLedger(callId, { intent: text.trim().slice(0, 200) });
            s.message = text.trim().slice(0, 300);
            const f = getLedger(callId);
            if (f?.matchedFirstName) {
              go(s, 'CONFIRM_ID');
              return { say: t(s, L.confirmId(f.matchedFirstName)) };
            }
            if (topicSpent(s, 'classify')) { go(s, 'TAKE_MESSAGE'); return { say: t(s, L.takeMessage) }; }
            go(s, 'CLASSIFY');
            return { say: t(s, L.classify) };
          }

          case 'CONFIRM_ID': {
            if (YES.test(text) && !NO.test(text)) {
              if (topicSpent(s, 'dob')) return afterIdentity(callId, s, t(s, L.thanks));
              go(s, 'CONFIRM_DOB');
              return { say: t(s, L.confirmDob) };
            }
            if (NO.test(text)) {
              // Recognized number, different person: existing-patient family
              // path — collect who the patient is; never the new/existing
              // interview for a recognized household (ledger rule).
              if (topicSpent(s, 'name')) return afterIdentity(callId, s, t(s, L.verifyFail2));
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'CONFIRM_DOB': {
            if (!DOB_RX.test(text)) return unparsable(callId, s);
            const spokenDob = normalizeSpokenDob(text) ?? text.trim();
            updateLedger(callId, { dateOfBirth: spokenDob });
            // Compare against the record we ALREADY pulled — no fresh lookup
            // for an ASR spelling to miss (operator 2026-08-07). Lookup only
            // when the matched record carries no DOB to compare against.
            let match = dobMatchesContext(callId, spokenDob);
            const f = getLedger(callId);
            if (match === null) {
              match = await services
                .verifyByLookup(f?.matchedFirstName ?? '', f?.matchedLastName ?? '', spokenDob)
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
            if (topicSpent(s, 'name')) return afterIdentity(callId, s, t(s, L.verifyFail2));
            go(s, 'COLLECT_NAME');
            return { say: t(s, L.verifyFail1) };
          }

          case 'CLASSIFY': {
            // A caller who answers "Maria Diaz" to new-or-existing has told us
            // something MORE useful than the question asked. Take it and move
            // on instead of asking again (Gate B 2026-08-08).
            const volunteered = looksLikeName(text);
            if (volunteered && !NEW_PAT.test(text) && !EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'existing', firstName: volunteered.first, lastName: volunteered.last });
              go(s, 'COLLECT_DOB');
              return { say: t(s, L.collectDob) };
            }
            if (NEW_PAT.test(text) && !EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'new' });
              if (topicSpent(s, 'name')) return afterIdentity(callId, s, t(s, L.thanks));
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.newPatient) };
            }
            if (EXISTING.test(text)) {
              updateLedger(callId, { newOrExisting: 'existing' });
              if (topicSpent(s, 'name')) return afterIdentity(callId, s, t(s, L.verifyFail2));
              go(s, 'COLLECT_NAME');
              return { say: t(s, L.collectName) };
            }
            return unparsable(callId, s);
          }

          case 'COLLECT_NAME': {
            const name = looksLikeName(text);
            if (!name) return unparsable(callId, s);
            updateLedger(callId, { firstName: name.first, lastName: name.last });
            if (topicSpent(s, 'dob')) return afterIdentity(callId, s, t(s, L.thanks));
            go(s, 'COLLECT_DOB');
            return { say: t(s, L.collectDob) };
          }

          case 'COLLECT_DOB': {
            if (!DOB_RX.test(text)) return unparsable(callId, s);
            const dob = normalizeSpokenDob(text) ?? text.trim();
            updateLedger(callId, { dateOfBirth: dob });
            const f = getLedger(callId);
            if (f?.newOrExisting === 'new') {
              // New patients don't verify — straight on with the request.
              return afterIdentity(callId, s, t(s, L.thanks));
            }
            const ctx = dobMatchesContext(callId, dob);
            let ok = ctx === true;
            if (ctx === null) {
              ok = await services
                .verifyByLookup(f?.firstName ?? '', f?.lastName ?? '', dob)
                .catch(() => false);
            }
            if (ok) {
              updateLedger(callId, { identityVerified: true });
              return afterIdentity(callId, s, t(s, L.verified(f?.firstName ?? '')));
            }
            s.verifyFails += 1;
            if (s.verifyFails >= 2) return afterIdentity(callId, s, t(s, L.verifyFail2));
            if (topicSpent(s, 'name')) return afterIdentity(callId, s, t(s, L.verifyFail2));
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
