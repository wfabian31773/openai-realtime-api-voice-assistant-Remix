/**
 * The SI Assistant lane's own registry tool. Bound by the runtime on a
 * call the lane dialled and on a call made back to it
 * (OutboundLanePolicy.tools). Registry tool, not a hand-built `tool()`.
 *
 * take_si_assistant_message — persist the caller's words in the durable
 * outbox first. Only then say the message was taken. A webhook miss is
 * a retry, not a lost promise. If persist itself fails, say so and
 * offer the callback number.
 */
import { registerTool, type ToolResult } from './registry';
import { callbackSessionFor } from './outboundTools';
import type { OutboundStore } from '../runtime/outbound/store';
import { bindOutboundStore, bindPluginStore, boundOutboundStore, boundPluginStore } from '../plugin/bindings';
import { createCallbackReporter, type CallbackReporter } from '../plugin/callbackReport';
import type { PluginStore } from '../plugin/store';
import { attachmentForSiAssistant, type TicketAttachment } from '../plugin/returnedCaller';
import { flushOutboxRow, persistTakenMessage, reattachTakenMessages } from '../plugin/messageOutbox';
import { siAssistantNumber } from '../plugin/siAssistantConstants';
import { MAX_SI_DOB_TRIES, noteSiAssistantIdentity, siAssistantIdentityFor } from '../plugin/siAssistantIdentity';
import { formatPhoneForSpeech } from '../utils/timeAware';
import { dobOnFile } from '../runtime/outbound/callback';
import { readDobQuietly } from './dobParts';

export const TAKE_MESSAGE_TOOL_NAME = 'take_si_assistant_message';
export const CONFIRM_IDENTITY_TOOL_NAME = 'confirm_si_assistant_identity';
export const SI_ASSISTANT_TOOLS = [CONFIRM_IDENTITY_TOOL_NAME, TAKE_MESSAGE_TOOL_NAME] as const;

let storeOverride: OutboundStore | null = null;
let reporterOverride: CallbackReporter | null | undefined;

export function setSiAssistantToolStoreForTests(store: OutboundStore | null): void {
  storeOverride = store;
  bindOutboundStore(store);
}

export function setSiAssistantReporterForTests(reporter: CallbackReporter | null | undefined): void {
  reporterOverride = reporter;
}

export function setSiAssistantPluginStoreForTests(store: PluginStore | null): void {
  bindPluginStore(store);
}

async function outboundStore(): Promise<OutboundStore> {
  if (storeOverride) return storeOverride;
  const bound = boundOutboundStore();
  if (bound) return bound;
  const { createDbOutboundStore } = await import('../runtime/outbound/store');
  return createDbOutboundStore();
}

function reporter(): CallbackReporter | null {
  if (reporterOverride !== undefined) return reporterOverride;
  return createCallbackReporter();
}

function callerPhoneOf(input: Record<string, unknown>, sessionPhone?: string): string {
  if (typeof input.outbound_phone === 'string' && input.outbound_phone) return input.outbound_phone;
  if (typeof input.caller_phone === 'string' && input.caller_phone) return input.caller_phone;
  return sessionPhone ?? '';
}

/** Callback injects outbound_callback_sid; a dialled call injects outbound_call_sid. */
function callSidOf(input: Record<string, unknown>): string {
  if (typeof input.outbound_callback_sid === 'string' && input.outbound_callback_sid) {
    return input.outbound_callback_sid;
  }
  if (typeof input.outbound_call_sid === 'string' && input.outbound_call_sid) {
    return input.outbound_call_sid;
  }
  return '';
}

async function attachmentFor(input: Record<string, unknown>): Promise<TicketAttachment> {
  const contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
  const attemptId = typeof input.outbound_attempt_id === 'string' ? input.outbound_attempt_id : '';
  const sid = callSidOf(input);
  const session = sid ? callbackSessionFor(sid) : null;
  let outboundContactData: Record<string, unknown> | null | undefined;
  if (contactId && attemptId) {
    try {
      const store = session?.store ?? (await outboundStore());
      const contact = await store.loadCallContact(contactId, attemptId);
      outboundContactData = contact?.data;
    } catch {
      console.error('[si-assistant] identified-contact load failed');
    }
  }
  const identity = siAssistantIdentityFor(sid);
  return attachmentForSiAssistant({
    outboundContactData,
    chosen: session?.chosen,
    candidates: session?.candidates,
    store: session?.store,
    attemptId: session?.attemptId ?? (attemptId || null),
    phone: callerPhoneOf(input, session?.callerPhone),
    greetingAffirmed: identity?.greetingAffirmed,
    dobMatched: identity?.dobMatched,
    wrongPerson: identity?.wrongPerson,
  });
}

function takenResult(): ToolResult {
  return {
    success: true,
    message_taken: true,
    say: "I've taken your message for the support team. They will follow up.",
    fix:
      'Say that, ask if there is anything else, then thank them, call record_call_outcome with done, ' +
      'say goodbye and call end_call.',
  };
}

function persistFailedResult(): ToolResult {
  const spoken = formatPhoneForSpeech(siAssistantNumber()) || '909-255-3213';
  return {
    success: false,
    missingFields: [],
    message: `I wasn't able to save that message. Please call us back at ${spoken}.`,
    fix: `Say that you could not save the message and they should call us back at ${spoken}. Do not say the message was taken.`,
  };
}

registerTool({
  name: TAKE_MESSAGE_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 8_000,
  description:
    'File a short message for the support team. Call this when they ask for a person, ' +
    'or have something they want the team to know. This call cannot transfer. Say only what it tells you.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Their message, in a few words of their own.',
        askAs: 'What would you like me to tell the support team?',
      },
    },
    required: ['message'],
  },
  handler: async (input): Promise<ToolResult> => {
    const message = String(input.message ?? '').trim();
    if (!message) {
      return {
        success: false,
        error: 'empty_message',
        fix: 'Ask what they would like the support team to know, then call this again with their words.',
      };
    }
    const attachment = await attachmentFor(input);
    const persisted = await persistTakenMessage({
      callSid: callSidOf(input) || null,
      ticketId: attachment.extras.ticketId ?? null,
      ticketNumber: attachment.extras.ticketNumber ?? null,
      approvalId: attachment.extras.approvalId ?? null,
      message,
      suggestions: attachment.identityConfirmed ? [] : attachment.suggestions,
    });
    if (!persisted) return persistFailedResult();
    if (attachment.identityConfirmed) {
      void reattachTakenMessages(callSidOf(input), attachment.extras, boundPluginStore(), reporter()).catch(() => {
        console.error('[si-assistant] outbox reattach failed');
      });
    }
    void flushOutboxRow(persisted, boundPluginStore(), reporter()).catch(() => {
      console.error('[si-assistant] outbox flush failed');
    });
    return takenResult();
  },
});

registerTool({
  name: CONFIRM_IDENTITY_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 5_000,
  description:
    'Record whether the person on the line said yes to "Am I speaking with" the named patient, ' +
    'and match their date of birth to the patient on file. Call this after they answer. ' +
    'Ticket keys attach only when they said yes AND the date matches.',
  input_schema: {
    type: 'object',
    properties: {
      speaking_with_named_patient: {
        type: 'boolean',
        description: 'True only when they explicitly said yes they are the named patient.',
        askAs: 'Are you speaking with the person we called for?',
      },
      date_of_birth: {
        type: 'string',
        description: 'Their date of birth, as they said it, month then day then year.',
        askAs: 'And your date of birth, starting with the month, then the day, then the year?',
      },
    },
    required: ['speaking_with_named_patient'],
  },
  handler: async (input): Promise<ToolResult> => {
    const sid = callSidOf(input);
    if (!sid) {
      return { success: false, error: 'no_call', fix: 'This tool only works on an SI Assistant call.' };
    }
    if (siAssistantIdentityFor(sid)?.wrongPerson) {
      return {
        success: true,
        confirmed: false,
        fix:
          'They are not the patient. Call record_call_outcome with wrong_person, apologise, say goodbye and call end_call. Do not attach a ticket.',
      };
    }
    const speaking = input.speaking_with_named_patient === true;
    if (!speaking) {
      noteSiAssistantIdentity(sid, { greetingAffirmed: false, dobMatched: false, wrongPerson: true });
      return {
        success: true,
        confirmed: false,
        fix:
          'They are not the patient. Call record_call_outcome with wrong_person, apologise, say goodbye and call end_call. Do not attach a ticket.',
      };
    }
    // Spent tries stay spent (v115): a third guess must not unlock what two
    // wrong dates of birth have already refused, whatever it says.
    const prior = siAssistantIdentityFor(sid);
    if (prior && !prior.dobMatched && prior.dobTries >= MAX_SI_DOB_TRIES) {
      return {
        success: true,
        confirmed: false,
        locked: true,
        fix:
          'Two dates of birth did not match the patient on file. Do not ask for it again and do not treat them as identified. Take a message if they have one.',
      };
    }
    const spoken = typeof input.date_of_birth === 'string' ? readDobQuietly(input.date_of_birth) : null;
    if (!spoken) {
      return {
        success: false,
        error: 'need_date_of_birth',
        fix:
          'They said yes. Ask for their date of birth, starting with the month, then the day, then the year, then call this again with speaking_with_named_patient true and the date.',
      };
    }
    let onFile: { month: string; day: string; year: string } | null = null;
    const contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
    const attemptId = typeof input.outbound_attempt_id === 'string' ? input.outbound_attempt_id : '';
    if (contactId && attemptId) {
      try {
        const store = await outboundStore();
        const contact = await store.loadCallContact(contactId, attemptId);
        onFile = contact ? dobOnFile({ data: contact.data ?? {} }) : null;
      } catch {
        console.error('[si-assistant] confirm-identity contact load failed');
        return {
          success: false,
          missingFields: [],
          error: 'contact_load_failed',
          message: 'I cannot verify who you are right now.',
          fix:
            'The patient record could not be loaded. Do not say there is no date of birth on file. Do not say the date of birth does not match. Say you cannot verify who they are right now and offer to take a message.',
        };
      }
    }
    const session = callbackSessionFor(sid);
    if (!onFile && session?.chosen) {
      const match = session.candidates.find((c) => c.contactId === session.chosen!.contactId);
      onFile = match ? dobOnFile(match) : null;
    }
    if (!onFile) {
      noteSiAssistantIdentity(sid, { greetingAffirmed: true, dobMatched: false });
      return {
        success: true,
        confirmed: false,
        cannot_verify: true,
        fix:
          'There is no date of birth on file, so you cannot verify identity. Do not say it does not match. Say you cannot verify who they are and offer to take a message.',
      };
    }
    const matched = spoken.year === onFile.year && spoken.month === onFile.month && spoken.day === onFile.day;
    const tries = prior?.dobTries ?? 0;
    noteSiAssistantIdentity(sid, { greetingAffirmed: true, dobMatched: matched, dobTries: matched ? tries : tries + 1 });
    if (!matched) {
      return {
        success: true,
        confirmed: false,
        fix:
          'They said yes but the date of birth does not match the patient on file. Take a message if they have one; do not treat them as identified.',
      };
    }
    const attachment = await attachmentFor(input);
    if (attachment.identityConfirmed) {
      void reattachTakenMessages(sid, attachment.extras, boundPluginStore(), reporter()).catch(() => {
        console.error('[si-assistant] outbox reattach failed');
      });
    }
    return {
      success: true,
      confirmed: true,
      fix: 'They are the patient. Carry on with the request.',
    };
  },
});
