/**
 * WHERE A SET OF MEDICAL RECORDS ACTUALLY GOES — one place, because there
 * were already two and they contradicted each other.
 *
 * Operator, 2026-09-08, on his own test call CAdc07bca1: the line took a
 * records request from a physician and never asked how to send them. His
 * words on what the intake should be — "if you want medical records, how
 * would you like to receive them by fax? What's the fax number? By email.
 * What's your email? ... gathering the information as we go, sort of filling
 * out a form, asking a question by question."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS MODULE EXISTS BECAUSE I BUILT THE SECOND SYSTEM WITHOUT LOOKING FOR
 * THE FIRST. Read this before adding a third.
 *
 * `gateBeforeExecution` (src/services/toolDirection.ts, 2026-08-07) already
 * enforced a delivery rule for PCP records, through the call-facts ledger:
 *
 *     if (records request && !f.contactMethod) f.contactMethod = 'fax';
 *     if (f.contactMethod === 'fax'   && !f.faxNumber) missing.push(...)
 *     if (f.contactMethod === 'email' && !f.email)     missing.push(...)
 *
 * It runs as a PRE-EXECUTION gate, so it decides before the tool handler is
 * entered at all. On 2026-09-08 I added a second, richer intake in the
 * director and asserted in a commit message that its `'unspecified'` escape
 * bounded the loop. It does not, wherever the ledger is populated: the tool
 * body never runs, so `ticketBlocksUsed` never increments and every retry
 * comes back demanding a fax number. A MAIL request fails the same way,
 * because the legacy default assumes fax.
 *
 * Codex found it (PR #273). My tests did not, and the reason is worth more
 * than the bug: they were green because `getLedger(callId)` returns nothing
 * in a unit test, so the legacy gate short-circuits and my gate is the only
 * one left standing. The harness silently exercised a code path that does
 * not exist in production.
 *
 * HOW LIVE IT IS, MEASURED RATHER THAN ASSUMED: the ledger is seeded in
 * exactly one place — `voiceAgentRoutes.ts`, the old-core SIP path. Nothing
 * under `src/runtime/` seeds it. PCP has been on the Grok runtime since
 * 2026-09-04, so today the legacy gate no-ops on this lane, which is why
 * CAdc07bca1 was never asked for a fax number at all. It is LATENT here and
 * LIVE the moment PCP touches the old core again.
 *
 * So the fix is not to delete the older gate — it is a real guard on a path
 * that still runs — but to make the two agree. The DIRECTOR is the source of
 * truth; the ledger follows it. `syncDeliveryToLedger` is that one-way write.
 */

import type { PcpConversationState } from './director';
import {
  DESTINATION_PROMPTS,
  PROMPTS as DIRECTOR_PROMPTS,
  deliveryDestinationNeeded,
} from './director';

/** The question asked when the director has no wording of its own. */
const METHOD_QUESTION = 'How would you like to receive the records — by fax, email, or mail?';

/** The one question still owed before a records request can be filed. */
export interface DeliveryAsk {
  field: 'recordsDeliveryMethod' | 'recordsDeliveryDestination';
  prompt: string;
}

/**
 * Is this call a records request at all?
 *
 * `callerIsThePatient` is deliberately NOT consulted. The records tool
 * reclassifies `callPurpose` itself, so a patient asking for their own
 * records arrives here as `patient_medical_records_request` like anyone
 * else — which is the whole point of asking the purpose rather than the
 * caller type.
 */
export function isRecordsRequest(state: PcpConversationState): boolean {
  return state.callPurpose === 'patient_medical_records_request';
}

/**
 * What still has to be asked, or null when the request may be filed.
 *
 * Two fields, in order, and never both at once — one question per turn is
 * the discipline the whole intake follows.
 */
export function deliveryAskFor(state: PcpConversationState): DeliveryAsk | null {
  if (!isRecordsRequest(state)) return null;
  if (!state.recordsDeliveryMethod) {
    return {
      field: 'recordsDeliveryMethod',
      // PROMPTS is Partial, so this cannot be assumed present. The fallback is
      // the question itself rather than a placeholder: a missing prompt must
      // still produce something sayable to a caller.
      prompt: DIRECTOR_PROMPTS.recordsDeliveryMethod ?? METHOD_QUESTION,
    };
  }
  if (deliveryDestinationNeeded(state) && !state.recordsDeliveryDestination) {
    return {
      field: 'recordsDeliveryDestination',
      prompt: DESTINATION_PROMPTS[state.recordsDeliveryMethod],
    };
  }
  return null;
}

/**
 * The line the agent says once the ticket has filed.
 *
 * `'unspecified'` is the escape a caller earns by not knowing or not saying,
 * and it is an INTERNAL enum. Speaking it produced "Confirm we will send them
 * by unspecified" — an instruction to confirm a route nobody chose, in a word
 * no caller uses (Codex P2, PR #273). It gets its own sentence instead.
 */
export function spokenDeliveryLine(state: PcpConversationState): string {
  const method = state.recordsDeliveryMethod;
  if (!method) return '';
  if (method === 'unspecified') {
    return ' Tell them our records team will be in touch to arrange how the records are sent.';
  }
  return (
    ` Confirm we will send them by ${method}` +
    (state.recordsDeliveryDestination ? ` to ${state.recordsDeliveryDestination}.` : '.')
  );
}

/**
 * The delivery instruction written ON the ticket.
 *
 * Appended to the narrative rather than added to the API payload: the ticket
 * schema has no field for it and inventing one would need the other team.
 * Says plainly when something is absent, so nobody reads a blank as an answer.
 */
export function ticketDeliveryNote(state: PcpConversationState): string {
  const method = state.recordsDeliveryMethod;
  if (!method) return '\n\nDelivery method NOT captured — ask the requester before sending anything.';
  if (method === 'unspecified') {
    return '\n\nDelivery method NOT chosen — the requester was asked and did not specify. Confirm with them before sending anything.';
  }
  return (
    `\n\nDeliver by ${method.toUpperCase()}` +
    (state.recordsDeliveryDestination ? ` to ${state.recordsDeliveryDestination}.` : ' — destination NOT captured.')
  );
}

/**
 * Push what the director knows into the call-facts ledger, so the older
 * pre-execution gate sees the same call this one does.
 *
 * IT MUST NEVER CREATE A LEDGER, and that is the whole subtlety.
 *
 * `updateLedger` falls back to `seedLedger(callId, {})`, so a bare call
 * BRINGS A LEDGER INTO EXISTENCE. `gateBeforeExecution` opens with
 * `if (!f) return null` — no ledger means the legacy gate is dormant for that
 * call. The runtime never seeds one, so on PCP today that gate does nothing.
 * Creating a ledger here to write a fax number into would therefore switch the
 * whole legacy gate ON for every runtime records call, and its FIRST
 * requirement is `medicalGroup`, which nothing under `src/runtime/` populates.
 * The fix for a blocked-on-fax loop would have shipped a blocked-on-
 * organisation loop in its place, on the lane that is actually live.
 *
 * Caught by `recordsDeliveryIntake.test.ts` rather than by review: adding the
 * sync gave those tests a ledger for the first time, and three of them
 * immediately failed with the legacy gate's own refusal text. The suite had
 * been green precisely because no ledger existed — the same blind spot that
 * hid the original bug, firing in the opposite direction.
 *
 * So: write only into a ledger somebody else already opened.
 *
 * WHY THE ORGANISATION RIDES ALONG. Synchronising the delivery fields alone
 * would fix the fax half and leave the gate's other requirement reading empty
 * on the same call — the director has `callerOrganization` from its own
 * intake, and the gate would still refuse for want of `medicalGroup`. Two
 * systems disagreeing about one call is the defect; halving it is not fixing
 * it.
 *
 * ONE WAY, deliberately. The ledger harvests `contactMethod` passively from
 * any caller line containing the word "fax" (`harvestCallerLine`), which is a
 * guess; the director's value came from the model classifying an answer to a
 * question we asked. Letting the guess write back would let "no, don't fax it"
 * set the method to fax.
 *
 * `mail` and `unspecified` are new to the ledger's vocabulary. Every existing
 * reader tests `=== 'fax'` or `=== 'email'`, so both simply fail those
 * equality checks and the legacy gate stops demanding a number it was never
 * going to get — which is exactly the bug, since a MAIL request was being
 * asked for a fax number forever.
 *
 * Never throws: a bookkeeping write must not be able to end a call.
 */
export async function syncDirectorFactsToLedger(
  callId: string,
  state: PcpConversationState,
): Promise<void> {
  try {
    const { getLedger, updateLedger } = await import('../services/callFactsLedger');
    // The load-bearing line. See above: no ledger means the legacy gate is
    // dormant, and it must stay that way.
    if (!getLedger(callId)) return;

    const method = state.recordsDeliveryMethod;
    const destination = state.recordsDeliveryDestination;
    updateLedger(callId, {
      ...(state.callerOrganization ? { medicalGroup: state.callerOrganization } : {}),
      ...(state.callerRole ? { callerRole: state.callerRole } : {}),
      ...(method ? { contactMethod: method } : {}),
      ...(method === 'fax' && destination ? { faxNumber: destination } : {}),
      ...(method === 'email' && destination ? { email: destination } : {}),
    });
  } catch {
    /* the ledger is an aid, never a dependency */
  }
}
