/**
 * PCP Support — new-core line module (script-listing §3, capability matrix).
 *
 * Professionals calling on behalf of patients. This line ROUTES schedule
 * requests to the human PCP queue (say-and-act: the promise and the dial are
 * one unit — the 88-mentions/7-transfers failure cannot recur) and files
 * tasks for everything else with the contact method MATCHING the request:
 * fax request → fax number, email request → email address, callback default
 * (operator rule 2026-08-07). A referenced patient is attached SILENTLY —
 * the professional is never blocked or interrogated about it.
 */
import { getLedger, updateLedger, harvestCallerLine } from '../services/callFactsLedger';
import type { CoreAction, LineModule } from './types';

export interface ProfessionalLineServices {
  /** Durable ticket THEN dial the PCP queue; falls back to a task on failure. */
  routeToQueue(callId: string, input: {
    narrative: string;
    urgency: 'normal' | 'high' | 'urgent';
    organization?: string;
    callbackNumber?: string;
    patientRef?: string;
  }): Promise<{ connected: boolean; ticketNumber?: string }>;
  fileTask(callId: string, input: {
    narrative: string;
    contactMethod: 'callback' | 'fax' | 'email';
    faxNumber?: string;
    email?: string;
    callbackNumber?: string;
    organization?: string;
    patientRef?: string;
  }): Promise<{ ok: boolean; ticketNumber?: string }>;
}

type PcpState =
  | 'INTENT'
  | 'COLLECT_CALLER'
  | 'COLLECT_FAX'
  | 'CONFIRM_FAX'
  | 'COLLECT_EMAIL'
  | 'CONFIRM_EMAIL'
  | 'CONFIRM_CALLBACK'
  | 'COLLECT_CALLBACK'
  | 'WRAP_QUERY'
  | 'ENDED';

interface PcpStatus {
  state: PcpState;
  lang: 'en' | 'es';
  unparsed: number;
  urgent: boolean;
  spanishHits: number;
  request: string | null;
  pendingFax: string | null;
  pendingEmail: string | null;
  unresolvedInfo: string | null;
}

const YES = /\b(yes|yeah|yep|ok|okay|correct|right|perfect|that's (right|correct|it)|sure|si|sí|claro|correcto)\b/i;
const NO = /\b(no|nope|not|wrong|incorrect|nothing|that's (all|it)|nada|eso es todo)\b/i;
const SCHEDULE_RX = /\b(schedul\w*|appointment\w*|book(ing)?|slot|get (them|him|her) in|be seen|referral for an? (appointment|visit)|cita|agendar)\b/i;
const RECORDS_RX = /\b(records?|fax(ed|ing)?|charts?|notes?|results?|documentation|clinical summar\w*|expedientes?)\b/i;
const EMAIL_REQ_RX = /\be-?mail\b/i;
const URGENT_RX = /\b(urgent|stat|emergency|today|right away|asap|urgente|emergencia)\b/i;
const HUMAN_RX = /\b(representative|operator|supervisor|(real|actual|live) (person|human)|(talk|speak|connect me|transfer me).{0,20}\b(human|agent|person|somebody|someone)\b)\b/i;
const PHONE_RX = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RX = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
const SPANISH_WORDS = /\b(hola|gracias|necesito|quiero|por favor|buenos|buenas|español|cita|ayuda|expediente|clínica|consultorio)\b/gi;
const PATIENT_REF_RX = /\b(?:patient(?:'s)?(?: name)?(?: is)?|regarding|calling about|for (?:a |our )?patient)[,:\s]+([a-záéíóúñ'-]+ [a-záéíóúñ'-]+)/i;

const L = {
  collectCaller: {
    en: "Of course — may I have your name and the office or medical group you're calling from?",
    es: 'Por supuesto — ¿me da su nombre y el consultorio o grupo médico del que llama?',
  },
  howHelp: {
    en: 'How can I help you today?',
    es: '¿Cómo puedo ayudarle hoy?',
  },
  route: {
    en: "I'll get that over to our PCP scheduling queue right away — one moment.",
    es: 'Le comunico con nuestra línea de citas PCP de inmediato — un momento.',
  },
  routeFailed: {
    en: "The team isn't picking up right now — I'll make sure they get your information and call your office back.",
    es: 'El equipo no contesta en este momento — me aseguraré de que reciban su información y llamen a su consultorio.',
  },
  collectFax: {
    en: "What's the best fax number to send that to?",
    es: '¿Cuál es el mejor número de fax para enviarlo?',
  },
  confirmFax: (fax: string) => ({
    en: `That's ${fax} — correct?`,
    es: `Es ${fax} — ¿correcto?`,
  }),
  collectEmail: {
    en: "What's the best email address for that?",
    es: '¿Cuál es el mejor correo electrónico para eso?',
  },
  confirmEmail: (email: string) => ({
    en: `That's ${email} — correct?`,
    es: `Es ${email} — ¿correcto?`,
  }),
  collectCallback: {
    en: "I'll make sure that gets to the right team — what's the best callback number for your office?",
    es: 'Me aseguraré de que llegue al equipo correcto — ¿cuál es el mejor número de contacto de su consultorio?',
  },
  confirmCallback: (last4: string) => ({
    en: `Is this number ending in ${last4} the best one for your office?`,
    es: `¿Este número que termina en ${last4} es el mejor para su consultorio?`,
  }),
  filing: {
    en: 'One moment while I get that over to the team.',
    es: 'Un momento mientras se lo paso al equipo.',
  },
  filed: {
    en: 'Done — the team will follow up with your office. Anything else I can help with?',
    es: 'Listo — el equipo dará seguimiento con su consultorio. ¿Algo más en que pueda ayudar?',
  },
  filedFallback: {
    en: "I've noted everything and the team will follow up with your office. Anything else I can help with?",
    es: 'He anotado todo y el equipo dará seguimiento con su consultorio. ¿Algo más?',
  },
  anythingElse: {
    en: 'Is there anything else I can help you with?',
    es: '¿Hay algo más en que pueda ayudarle?',
  },
  wrap: {
    en: 'Thanks for calling Azul Vision — have a great day.',
    es: 'Gracias por llamar a Azul Vision — que tenga buen día.',
  },
} as const;

type Localized = { en: string; es: string };

export function createPcpLine(services: ProfessionalLineServices): LineModule {
  const calls = new Map<string, PcpStatus>();
  const t = (s: PcpStatus, line: Localized): string => line[s.lang];
  const go = (s: PcpStatus, state: PcpState): void => {
    s.state = state;
    s.unparsed = 0;
  };

  const question = (callId: string, s: PcpStatus): string => {
    switch (s.state) {
      case 'COLLECT_CALLER': return t(s, L.collectCaller);
      case 'COLLECT_FAX': return t(s, L.collectFax);
      case 'CONFIRM_FAX': return s.pendingFax ? t(s, L.confirmFax(s.pendingFax)) : t(s, L.collectFax);
      case 'COLLECT_EMAIL': return t(s, L.collectEmail);
      case 'CONFIRM_EMAIL': return s.pendingEmail ? t(s, L.confirmEmail(s.pendingEmail)) : t(s, L.collectEmail);
      case 'CONFIRM_CALLBACK': {
        const cb = getLedger(callId)?.callbackNumber;
        return cb ? t(s, L.confirmCallback(cb.slice(-4))) : t(s, L.collectCallback);
      }
      case 'COLLECT_CALLBACK': return t(s, L.collectCallback);
      case 'WRAP_QUERY': return t(s, L.anythingElse);
      default: return t(s, L.howHelp);
    }
  };

  /** Say-and-act: the task is filed in code; the confirmation rides the result. */
  const fileNow = (callId: string, s: PcpStatus, note?: string): CoreAction => {
    go(s, 'WRAP_QUERY');
    return {
      say: t(s, L.filing),
      followUp: async () => {
        const f = getLedger(callId);
        const narrative = [
          s.request ?? f?.intent ?? 'Professional request (details in transcript)',
          s.unresolvedInfo ? `UNRESOLVED: ${s.unresolvedInfo}` : null,
          note ? `NOTE: ${note}` : null,
        ].filter(Boolean).join(' — ');
        const input = {
          narrative,
          contactMethod: (f?.contactMethod ?? 'callback') as 'callback' | 'fax' | 'email',
          faxNumber: f?.faxNumber ?? undefined,
          email: f?.email ?? undefined,
          callbackNumber: f?.callbackNumber ?? f?.callerPhone ?? undefined,
          organization: f?.medicalGroup ?? undefined,
          patientRef: f?.patientReferenced ?? undefined,
        };
        let r = await services.fileTask(callId, input).catch(() => ({ ok: false }));
        if (!r.ok) r = await services.fileTask(callId, input).catch(() => ({ ok: false }));
        if (r.ok) return { say: t(s, L.filed) };
        return {
          say: t(s, L.filedFallback),
          alert: `PCP TASK FILING FAILED after retry for ${callId} — sweep must recover: ${narrative.slice(0, 120)}`,
        };
      },
    };
  };

  /** Say-and-act: promise and dial in ONE unit; the failure line rides the result. */
  const routeNow = (callId: string, s: PcpStatus): CoreAction => {
    go(s, 'WRAP_QUERY');
    return {
      say: t(s, L.route),
      followUp: async () => {
        const f = getLedger(callId);
        const r = await services
          .routeToQueue(callId, {
            narrative: s.request ?? f?.intent ?? 'Scheduling request from a professional',
            urgency: s.urgent ? 'urgent' : 'high',
            organization: f?.medicalGroup ?? undefined,
            callbackNumber: f?.callbackNumber ?? f?.callerPhone ?? undefined,
            patientRef: f?.patientReferenced ?? undefined,
          })
          .catch(() => ({ connected: false }));
        if (r.connected) {
          go(s, 'ENDED'); // the human queue owns the call now
          return { say: null };
        }
        return { say: t(s, L.routeFailed) };
      },
    };
  };

  /** Request captured and caller identified → branch by request type (§3). */
  const dispatch = (callId: string, s: PcpStatus): CoreAction => {
    const f = getLedger(callId);
    const req = s.request ?? f?.intent ?? '';
    if (SCHEDULE_RX.test(req)) return routeNow(callId, s);
    if (RECORDS_RX.test(req) && !EMAIL_REQ_RX.test(req)) {
      updateLedger(callId, { contactMethod: 'fax' });
      if (f?.faxNumber) return fileNow(callId, s); // harvested already
      go(s, 'COLLECT_FAX');
      return { say: t(s, L.collectFax) };
    }
    if (EMAIL_REQ_RX.test(req)) {
      updateLedger(callId, { contactMethod: 'email' });
      if (f?.email) return fileNow(callId, s);
      go(s, 'COLLECT_EMAIL');
      return { say: t(s, L.collectEmail) };
    }
    updateLedger(callId, { contactMethod: 'callback' });
    const cb = f?.callbackNumber;
    if (cb && !f?.callbackConfirmed) {
      go(s, 'CONFIRM_CALLBACK');
      return { say: t(s, L.confirmCallback(cb.slice(-4))) };
    }
    if (!cb) {
      go(s, 'COLLECT_CALLBACK');
      return { say: t(s, L.collectCallback) };
    }
    return fileNow(callId, s);
  };

  const fallForward = (callId: string, s: PcpStatus): CoreAction => {
    // Professionals are NEVER trapped: two misses anywhere → the request is
    // filed with what is known and the gap flagged.
    switch (s.state) {
      case 'COLLECT_FAX':
      case 'CONFIRM_FAX':
        s.unresolvedInfo = 'fax number not captured — confirm by phone';
        updateLedger(callId, { contactMethod: 'callback' });
        return fileNow(callId, s);
      case 'COLLECT_EMAIL':
      case 'CONFIRM_EMAIL':
        s.unresolvedInfo = 'email not captured — confirm by phone';
        updateLedger(callId, { contactMethod: 'callback' });
        return fileNow(callId, s);
      case 'CONFIRM_CALLBACK':
      case 'COLLECT_CALLBACK':
        return fileNow(callId, s, 'callback unconfirmed — used caller ID');
      case 'WRAP_QUERY':
        go(s, 'ENDED');
        return { say: t(s, L.wrap), endCall: true };
      default:
        return fileNow(callId, s, 'details incomplete — see transcript');
    }
  };

  const unparsable = (callId: string, s: PcpStatus): CoreAction => {
    s.unparsed += 1;
    if (s.unparsed >= 2) return fallForward(callId, s);
    return { say: question(callId, s) };
  };

  return {
    slug: 'pcp',

    start(callId: string): void {
      calls.set(callId, {
        state: 'INTENT',
        lang: 'en',
        unparsed: 0,
        urgent: false,
        spanishHits: 0,
        request: null,
        pendingFax: null,
        pendingEmail: null,
        unresolvedInfo: null,
      });
      updateLedger(callId, { callerRole: 'healthcare professional' });
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
        // Silent patient attach: noticed, recorded, never spoken about.
        const pref = text.match(PATIENT_REF_RX);
        if (pref && !getLedger(callId)?.patientReferenced) {
          updateLedger(callId, { patientReferenced: pref[1] });
        }
        if (URGENT_RX.test(text)) s.urgent = true;

        s.spanishHits += (text.match(SPANISH_WORDS) ?? []).length;
        if (s.lang === 'en' && (s.spanishHits >= 2 || /\b(en español|habla español)\b/i.test(text))) {
          s.lang = 'es';
          updateLedger(callId, { language: 'Spanish' });
        }

        // A professional asking for a human gets the QUEUE — this line can.
        if (HUMAN_RX.test(text) && s.state !== 'WRAP_QUERY') {
          if (!s.request) s.request = text.trim().slice(0, 300);
          return routeNow(callId, s);
        }

        switch (s.state) {
          case 'INTENT': {
            if (text.trim().split(/\s+/).length < 2) return unparsable(callId, s);
            s.request = text.trim().slice(0, 300);
            updateLedger(callId, { intent: text.trim().slice(0, 200) });
            go(s, 'COLLECT_CALLER');
            return { say: t(s, L.collectCaller) };
          }

          case 'COLLECT_CALLER': {
            if (text.trim().split(/\s+/).length < 2) return unparsable(callId, s);
            updateLedger(callId, { medicalGroup: text.trim().slice(0, 160) });
            return dispatch(callId, s);
          }

          case 'COLLECT_FAX': {
            const fax = text.match(PHONE_RX);
            if (!fax) return unparsable(callId, s);
            s.pendingFax = fax[0].replace(/[^\d+]/g, '');
            go(s, 'CONFIRM_FAX');
            return { say: t(s, L.confirmFax(s.pendingFax.split('').join(' '))) };
          }

          case 'CONFIRM_FAX': {
            if (YES.test(text) && !NO.test(text)) {
              updateLedger(callId, { faxNumber: s.pendingFax ?? undefined });
              return fileNow(callId, s);
            }
            if (NO.test(text) || PHONE_RX.test(text)) {
              const fax = text.match(PHONE_RX);
              if (fax) {
                s.pendingFax = fax[0].replace(/[^\d+]/g, '');
                return { say: t(s, L.confirmFax(s.pendingFax.split('').join(' '))) };
              }
              s.pendingFax = null;
              go(s, 'COLLECT_FAX');
              return { say: t(s, L.collectFax) };
            }
            return unparsable(callId, s);
          }

          case 'COLLECT_EMAIL': {
            const email = text.match(EMAIL_RX);
            if (!email) return unparsable(callId, s);
            s.pendingEmail = email[0];
            go(s, 'CONFIRM_EMAIL');
            return { say: t(s, L.confirmEmail(s.pendingEmail)) };
          }

          case 'CONFIRM_EMAIL': {
            if (YES.test(text) && !NO.test(text)) {
              updateLedger(callId, { email: s.pendingEmail ?? undefined });
              return fileNow(callId, s);
            }
            if (NO.test(text) || EMAIL_RX.test(text)) {
              const email = text.match(EMAIL_RX);
              if (email) {
                s.pendingEmail = email[0];
                return { say: t(s, L.confirmEmail(s.pendingEmail)) };
              }
              s.pendingEmail = null;
              go(s, 'COLLECT_EMAIL');
              return { say: t(s, L.collectEmail) };
            }
            return unparsable(callId, s);
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
            const stripped = text.replace(/\b(actually|yes|yeah|yep|sure|please|also|sí|si|claro)\b/gi, ' ').trim();
            if (stripped.split(/\s+/).filter(Boolean).length >= 4 || YES.test(text)) {
              s.request = null;
              s.unresolvedInfo = null;
              s.pendingFax = null;
              s.pendingEmail = null;
              updateLedger(callId, { contactMethod: undefined });
              if (stripped.split(/\s+/).filter(Boolean).length >= 4) {
                s.request = text.trim().slice(0, 300);
                return dispatch(callId, s);
              }
              go(s, 'INTENT');
              return { say: t(s, L.howHelp) };
            }
            return unparsable(callId, s);
          }

          default:
            return { say: null };
        }
      } catch (err) {
        console.warn(`[NEW-CORE][pcp] error for ${callId}:`, err);
        return { say: t(s, L.filedFallback), alert: `pcp core error for ${callId}: ${String(err)}` };
      }
    },
  };
}
