/**
 * The seam between "an agent's tool wants a transfer" and "this call's
 * transport can perform one".
 *
 * A registry tool is a name plus a handler — it exists before any call and
 * belongs to no lane. A transfer is the most call-bound thing there is: it
 * needs THIS caller's Twilio leg and THIS deployment's Twilio client. The
 * broker joins the two the same way the azul office-transfer callback does
 * (`registerAzulOfficeTransferCallback`): the factory registers the per-call
 * callback at construction, keyed by callId, and the tool looks it up at
 * invoke time through the `call_sid` the adapter injects under the model's
 * arguments.
 *
 * When no callback is registered — the lane was served without a transfer, or
 * the deployment has none configured — the tool REFUSES with a structured
 * error instead of throwing, which is the pattern that lets the agent say
 * plainly it cannot transfer and file a ticket instead (azul's
 * `transfer_unavailable`; refusals memory: a blocked handoff must never read
 * as success).
 */
import { escalationDetailsMap } from "../services/escalationStore";
import { registerTool, type ToolResult } from "./registry";

const handoffs = new Map<string, () => Promise<void>>();

/** Entries are released by the runtime at teardown; the cap is the backstop
 * for calls torn down by paths that never reach it. FIFO by insertion. */
const MAX_ENTRIES = 200;

export function registerCallHandoff(callId: string, handoff: () => Promise<void>): void {
  if (handoffs.size >= MAX_ENTRIES && !handoffs.has(callId)) {
    const oldest = handoffs.keys().next().value;
    if (oldest !== undefined) handoffs.delete(oldest);
  }
  handoffs.set(callId, handoff);
}

export function releaseCallHandoff(callId: string): void {
  handoffs.delete(callId);
}

/** For tests and health — never contains call content. */
export function registeredHandoffCount(): number {
  return handoffs.size;
}

registerTool({
  name: "request_human_handoff",
  description:
    "Transfer this caller to a live person, warm: a staff member is dialled, hears who is " +
    "calling and why, and must accept before the caller is moved. Use ONLY when the caller's " +
    "situation genuinely requires a person now (urgent symptoms, an unresponsive or distressed " +
    "caller, a healthcare professional who must speak to staff). On failure — nobody answered, " +
    "or transfer is not available on this line — tell the caller plainly and file a ticket for " +
    "a callback instead; never promise a transfer that did not happen.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Why this caller needs a person, in one sentence. The staff member hears this " +
          "before accepting, so the caller does not repeat themselves.",
      },
      caller_type: {
        type: "string",
        enum: [
          "patient_urgent",
          "patient_urgent_medical",
          "patient_unresponsive",
          "healthcare_provider",
        ],
        description: "What kind of caller this is. Decides where the transfer is allowed to go.",
      },
      caller_requested_human: {
        type: "string",
        enum: ["true", "false"],
        description: "Did the caller ask, in words, to speak to a person?",
      },
    },
    required: ["reason", "caller_type"],
  },
  layer: "agent",
  // A warm transfer rings for 45s and waits up to 45s for the keypress.
  timeoutMs: 100_000,
  handler: async (input): Promise<ToolResult> => {
    const callId = String(input.call_sid ?? "");
    const handoff = callId ? handoffs.get(callId) : undefined;
    if (!handoff) {
      return {
        success: false,
        error:
          "transfer_unavailable: this line cannot transfer calls. Tell the caller plainly " +
          "and create a ticket for a callback instead.",
      };
    }

    // The same side channel the SIP path's escalate tools write, read by the
    // same policy (resolveHandoffDestination) at dial time.
    escalationDetailsMap.set(callId, {
      agentSlug: String(input.agent_slug ?? "runtime-proof"),
      reason: String(input.reason ?? ""),
      callerType: String(input.caller_type ?? ""),
      callerRequestedHuman: input.caller_requested_human === "true",
    });

    try {
      await handoff();
      // Resolved means a human pressed a key and the caller was moved —
      // the transport enforces that ordering, not this tool.
      handoffs.delete(callId);
      return { success: true, transferred: true };
    } catch (err) {
      const slug = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error:
          `${slug}. The caller was NOT transferred and still hears you. Say so plainly ` +
          "and file a ticket for a callback — do not retry more than once.",
        retryable: slug.endsWith("NO_ANSWER"),
      };
    } finally {
      escalationDetailsMap.delete(callId);
    }
  },
});
