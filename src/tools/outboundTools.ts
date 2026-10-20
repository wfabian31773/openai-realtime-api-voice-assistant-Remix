/**
 * Tools every OUTBOUND lane carries, bound by the runtime rather than listed
 * by the lane (src/runtime/laneRegistry.ts, RUNTIME_OUTBOUND_TOOLS) — the
 * 2026-09-15 rule: what applies to every conversation of a kind belongs to
 * the runtime, what applies to one agent belongs to its prompt.
 *
 *   opt_out_of_calls     the person asked not to be called. Phone-wide and
 *                        campaign-wide: the number goes on do_not_contact,
 *                        which every outbound dial checks first.
 *   record_call_outcome  how the call ended, for the campaign's queue: a
 *                        wrong number, call back later, not interested, done.
 *
 * WHO THE CALL IS ABOUT IS INJECTED, NEVER ASKED. The contact id and the
 * number dialled arrive as context the adapter merges UNDER the model's
 * arguments (the `lane` shape on lookup_patient): not schema fields, so the
 * model can neither set them nor be asked for them. A call with no injected
 * contact is refused, so these tools do nothing on a lane that was not dialled.
 */
import { registerTool, type ToolFailure, type ToolResult } from './registry';
import type { ContactStatus, OutboundStore } from '../runtime/outbound/store';

let storeOverride: OutboundStore | null = null;
let storePromise: Promise<OutboundStore> | null = null;

/** Tests only: answer from an in-memory store instead of the Hub. */
export function setOutboundToolStoreForTests(store: OutboundStore | null): void {
  storeOverride = store;
}

async function outboundStore(): Promise<OutboundStore> {
  if (storeOverride) return storeOverride;
  storePromise ??= import('../runtime/outbound/store').then((m) => m.createDbOutboundStore());
  return storePromise;
}

export const OPT_OUT_TOOL_NAME = 'opt_out_of_calls';
export const RECORD_OUTCOME_TOOL_NAME = 'record_call_outcome';

interface Injected {
  contactId: string;
  phone: string;
  campaignKey: string;
}

function injected(input: Record<string, unknown>): Injected | null {
  const contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
  const phone = typeof input.outbound_phone === 'string' ? input.outbound_phone : '';
  const campaignKey = typeof input.outbound_campaign === 'string' ? input.outbound_campaign : '';
  return contactId && phone && campaignKey ? { contactId, phone, campaignKey } : null;
}

/** A refusal that tells the model what to do next; `fix` is the model's
 * channel, never spoken (v43). */
interface OutboundRefusal extends ToolFailure {
  fix: string;
}

const NOT_AN_OUTBOUND_CALL: OutboundRefusal = {
  success: false,
  error: 'not_an_outbound_call',
  fix: 'This tool only works on a call this line placed. Do not call it again.',
};

registerTool({
  name: OPT_OUT_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 5000,
  description:
    'The person asked not to be called again, to be taken off the list, or to stop these calls — ' +
    'in any words, in any language. Call this AT ONCE, whatever else is happening on the call. ' +
    'Then say only what the result tells you to say and end the call politely. Never argue, ' +
    'never make the offer again after they have asked.',
  input_schema: { type: 'object', properties: {} },
  handler: async (input): Promise<ToolResult> => {
    const who = injected(input);
    if (!who) return NOT_AN_OUTBOUND_CALL;
    const store = await outboundStore();
    // The do-not-contact row FIRST: it is the one every future dial reads,
    // so it must land even if settling this campaign's row then fails.
    await store.stampDoNotContact(who.phone, `voice:${who.campaignKey}`);
    await store.settleContact(who.contactId, 'do_not_call');
    return {
      success: true,
      message: "Understood. You won't receive these calls from us again. Thank you, goodbye.",
      fix: 'Say the message, then end the call. Do not make any offer again.',
    };
  },
});

/** What the model may report, and what the campaign queue records for it. */
export const CALL_OUTCOMES: Record<string, ContactStatus> = {
  wrong_person: 'wrong_number',
  call_back_later: 'callback_scheduled',
  not_interested: 'declined',
  done: 'completed',
};

registerTool({
  name: RECORD_OUTCOME_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 5000,
  description:
    "Record how this call ended, once, before you say goodbye. wrong_person: the person you are " +
    "calling for is not at this number. call_back_later: they asked to be called another time. " +
    'not_interested: they said no to what you offered. done: what this call was for is finished. ' +
    'If they asked not to be called at all, use opt_out_of_calls instead.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: Object.keys(CALL_OUTCOMES),
        description: 'How the call ended.',
        askAs: 'How did the call end?',
      },
    },
    required: ['outcome'],
  },
  handler: async (input): Promise<ToolResult> => {
    const who = injected(input);
    if (!who) return NOT_AN_OUTBOUND_CALL;
    const outcome = String(input.outcome ?? '');
    const status = CALL_OUTCOMES[outcome];
    if (!status) {
      const refusal: OutboundRefusal = {
        success: false,
        error: 'unknown_outcome',
        fix: `outcome must be one of ${Object.keys(CALL_OUTCOMES).join(', ')}.`,
      };
      return refusal;
    }
    const store = await outboundStore();
    // "Call back later" is the one outcome the queue tries again — tomorrow,
    // inside the window, through the same caps as every other attempt.
    const nextAttemptAt =
      status === 'callback_scheduled' ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
    await store.settleContact(who.contactId, status, { nextAttemptAt });
    return { success: true, recorded: outcome };
  },
});

export const END_CALL_TOOL_NAME = 'end_call';

/**
 * Hang up. The voice runtime intercepts this NAME (mediaStreamBridge.ts,
 * DEFAULT_END_CALL_TOOL_NAMES): the tool runs, and a success lets the bridge
 * end the call — but never while the model is still holding a tool answer it
 * has not put into words (v56), so a goodbye is always heard first.
 *
 * Inbound lanes end calls through their own tools and guards (PCP's
 * terminate_call waits for a durable disposition). A dialled call has no
 * caller who will hang up when they are done, so every outbound lane gets
 * this one.
 */
registerTool({
  name: END_CALL_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 2000,
  description:
    'End this call. Only after you have said goodbye and the person has had the chance to say ' +
    'anything else. Never in the middle of a sentence, never instead of answering them.',
  input_schema: { type: 'object', properties: {} },
  handler: async (input): Promise<ToolResult> => {
    if (!injected(input)) return NOT_AN_OUTBOUND_CALL;
    return { success: true, ended: true };
  },
});
