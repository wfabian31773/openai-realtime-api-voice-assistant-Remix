/**
 * WHAT THE TICKET SAYS ONCE TWILIO TELLS US HOW THE QUEUE DIAL ENDED.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: THE TICKET USED TO STOP AT `DIALING` FOREVER.
 *
 * `handoff_to_pcp` writes its ticket and returns while the dial is still
 * ringing, because on the blind path the redirect has already ended the Media
 * Stream and the agent is gone. Twilio's `<Dial action>` callback arrives
 * minutes later on its own HTTP request. Until now it reached
 * `call_logs.transfer_outcome` and NOTHING ELSE — so the row a staffer opens
 * said `DIALING` whether the queue answered in four seconds or never picked
 * up at all, and `tickets.pcp_handoff_*` is the instrument CLAUDE.md says to
 * measure PCP transfers from.
 *
 * The ticketing app upserts on `callSid` and updates the handoff columns
 * whenever a payload carries a `handoff` block, so this needs no new endpoint
 * and nothing from that team.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `queue_answered` IS NOT `CONNECTED`, AND THAT IS THE WHOLE CARE HERE.
 *
 * Rosa's design, 2026-09-08: the caller is dropped into an ACD and we let go
 * of the leg, so nothing on this path observes a human. `DialCallStatus:
 * completed` means the far end PICKED UP — against a call centre that is the
 * auto-attendant, and the caller may have spent every one of those seconds in
 * hold music before giving up.
 *
 * So an answered queue dial LEAVES `finalStatus` AT `DIALING`. The ticketing
 * app computes `humanHandoffOccurred = finalStatus === 'CONNECTED'`, and a
 * staffer who reads "handoff occurred" skips the callback — the one thing
 * this ticket exists to prevent (v20, 2026-09-15). What we learned goes in
 * `humanAnswerStatus`, which is free text, WITH the bridge duration: a
 * two-second bridge is a caller who gave up, and only the number can say so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A DIAL THAT DID NOT LAND RE-OPENS THE REQUEST.
 *
 * `no_answer` and `failed` flip the disposition to `CREATE_TASK` and set
 * `fallbackTicketStatus: 'OPEN'`, because the request now needs working by a
 * person: the caller asked for the queue, was put through, and the queue did
 * not answer. The ticketing app permits CREATE_TASK against a HAND_OFF-default
 * purpose for exactly these three statuses and no others, which is why the
 * status and the disposition are decided together here rather than apart.
 */
import type { PcpDisposition } from './policy';
import type { PcpTicketPayload } from './pcpTicketing';
import type { BlindDialSettlement } from '../services/escalationStore';

type Handoff = NonNullable<PcpTicketPayload['handoff']>;

/** What the pre-dial write already established, and this one must preserve. */
export interface SettlementContext {
  requestedAt?: string;
  attemptedAt?: string;
  destination?: string;
}

export function handoffAfterQueueDial(
  settlement: BlindDialSettlement,
  context: SettlementContext,
): { handoff: Handoff; disposition: PcpDisposition } {
  const destination = settlement.dialedNumber ?? context.destination;
  const base = {
    requested: true,
    requestedAt: context.requestedAt,
    attempted: true,
    attemptedAt: context.attemptedAt,
    destination,
    /**
     * NEVER SET, on any branch of this function. There is no instant at which
     * a human was observed to answer, and writing one would put a timestamp
     * on an event nobody saw.
     */
    connectedAt: undefined,
  };

  if (settlement.connected) {
    return {
      disposition: 'HAND_OFF',
      handoff: {
        ...base,
        // Still DIALING. The ACD answered; a person may never have.
        finalStatus: 'DIALING',
        humanAnswerStatus: `QUEUE_ANSWERED (bridged ${settlement.talkSeconds ?? 0}s)`,
      },
    };
  }

  const noAnswer = settlement.outcome === 'no_answer';
  return {
    disposition: 'CREATE_TASK',
    handoff: {
      ...base,
      finalStatus: noAnswer ? 'NO_ANSWER' : 'FAILED',
      humanAnswerStatus: noAnswer ? 'QUEUE_NO_ANSWER' : 'QUEUE_DIAL_FAILED',
      // Twilio's own word rides along, so our reading can be checked later.
      failureReason: `queue_${settlement.outcome}:${settlement.status}`,
      // The request is live again and a person has to work it.
      fallbackTicketStatus: 'OPEN',
    },
  };
}
