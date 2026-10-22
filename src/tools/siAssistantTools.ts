/**
 * The SI Assistant lane's own registry tool. Bound by the runtime on a
 * call the lane dialled and on a call made back to it
 * (OutboundLanePolicy.tools). Registry tool, not a hand-built `tool()`.
 *
 * take_si_assistant_message — the prompt promises to take a message for
 * the support team. This is what files that promise: a `message` event
 * on the ticketing callback webhook, keyed by the ticket / approval on
 * the contact. The message text goes to the ticketing app only and is
 * never written to plugin_audit_log or console.
 */
import { registerTool, type ToolResult } from './registry';
import { callbackSessionFor } from './outboundTools';
import type { OutboundStore } from '../runtime/outbound/store';
import {
  createCallbackReporter,
  extrasFromContactData,
  type CallbackReporter,
} from '../plugin/callbackReport';
import { SI_ASSISTANT_SLUG } from '../plugin/siAssistantConstants';

export const TAKE_MESSAGE_TOOL_NAME = 'take_si_assistant_message';
export const SI_ASSISTANT_TOOLS = [TAKE_MESSAGE_TOOL_NAME] as const;

let storeOverride: OutboundStore | null = null;
let reporterOverride: CallbackReporter | null | undefined;

export function setSiAssistantToolStoreForTests(store: OutboundStore | null): void {
  storeOverride = store;
}

export function setSiAssistantReporterForTests(reporter: CallbackReporter | null | undefined): void {
  reporterOverride = reporter;
}

async function outboundStore(): Promise<OutboundStore> {
  if (storeOverride) return storeOverride;
  const { createDbOutboundStore } = await import('../runtime/outbound/store');
  return createDbOutboundStore();
}

function reporter(): CallbackReporter | null {
  if (reporterOverride !== undefined) return reporterOverride;
  return createCallbackReporter();
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
    return extrasFromContactData(contact?.data);
  }
  const sid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
  if (sid) {
    const session = callbackSessionFor(sid);
    if (session?.chosen) {
      const contact = await session.store.loadCallContact(
        session.chosen.contactId,
        session.attemptId ?? '',
      );
      return extrasFromContactData(contact?.data);
    }
  }
  return {};
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
    const dest = reporter();
    if (dest) {
      try {
        const result = await dest.report({
          event: 'message',
          slug: SI_ASSISTANT_SLUG,
          ticketNumber: extras.ticketNumber ?? null,
          approvalId: extras.approvalId ?? null,
          ticketId: extras.ticketId ?? null,
          message,
        });
        if (!result.ok) {
          console.error(`[si-assistant] take-message webhook returned ${result.status ?? 'unknown'}`);
        }
      } catch {
        console.error('[si-assistant] take-message webhook failed');
      }
    }
    return {
      success: true,
      message_taken: true,
      say: "I've taken your message for the support team. They will follow up.",
      fix:
        'Say that, ask if there is anything else, then thank them, call record_call_outcome with done, ' +
        'say goodbye and call end_call.',
    };
  },
});
