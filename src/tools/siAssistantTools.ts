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
import {
  createCallbackReporter,
  extrasFromContactData,
  type CallbackReporter,
} from '../plugin/callbackReport';
import type { PluginStore } from '../plugin/store';
import { extrasForReturnedCaller, extrasFromRecentContacts, hasTicketKeys } from '../plugin/returnedCaller';
import { flushOutboxRow, persistTakenMessage } from '../plugin/messageOutbox';
import { siAssistantNumber } from '../plugin/siAssistantConstants';
import { formatPhoneForSpeech } from '../utils/timeAware';

export const TAKE_MESSAGE_TOOL_NAME = 'take_si_assistant_message';
export const SI_ASSISTANT_TOOLS = [TAKE_MESSAGE_TOOL_NAME] as const;

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

async function extrasFor(input: Record<string, unknown>): Promise<{
  ticketNumber?: string | null;
  approvalId?: string | null;
  ticketId?: string | null;
}> {
  const contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
  const attemptId = typeof input.outbound_attempt_id === 'string' ? input.outbound_attempt_id : '';
  if (contactId && attemptId) {
    const store = await outboundStore();
    const contact = await store.loadCallContact(contactId, attemptId);
    const extras = extrasFromContactData(contact?.data);
    if (hasTicketKeys(extras)) return extras;
  }
  const sid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
  if (sid) {
    const session = callbackSessionFor(sid);
    if (session?.chosen && session.attemptId) {
      const contact = await session.store.loadCallContact(session.chosen.contactId, session.attemptId);
      const extras = extrasFromContactData(contact?.data);
      if (hasTicketKeys(extras)) return extras;
    }
    if (session?.candidates?.length) {
      const fromSession = extrasFromRecentContacts(session.candidates);
      if (hasTicketKeys(fromSession)) return fromSession;
    }
    const phone = callerPhoneOf(input, session?.callerPhone);
    if (phone) return extrasForReturnedCaller(phone, new Date(), session?.store ?? (await outboundStore()), boundPluginStore());
  }
  const phone = callerPhoneOf(input);
  if (phone) return extrasForReturnedCaller(phone, new Date(), await outboundStore(), boundPluginStore());
  return {};
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
    const extras = await extrasFor(input);
    const callSid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : null;
    const persisted = await persistTakenMessage({
      callSid,
      ticketId: extras.ticketId ?? null,
      ticketNumber: extras.ticketNumber ?? null,
      approvalId: extras.approvalId ?? null,
      message,
    });
    if (!persisted) return persistFailedResult();
    try {
      await flushOutboxRow(persisted, boundPluginStore(), reporter());
    } catch {
      console.error('[si-assistant] outbox flush failed');
    }
    return takenResult();
  },
});
