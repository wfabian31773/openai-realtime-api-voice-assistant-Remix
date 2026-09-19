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

/**
 * Written onto a narrative whose excerpt had to be cut, so a staffer reading
 * a sentence that stops mid-word knows it was us and not the caller.
 */
export const TRUNCATION_NOTE =
  '\n  […] excerpt trimmed to fit — the full conversation is on this ticket’s transcript.';

/**
 * Cut `text` so that it plus `TRUNCATION_NOTE` fits in `budget` characters.
 *
 * Returns the text unchanged when it already fits, so the note never appears
 * on a ticket that was not actually cut. A budget too small to hold even the
 * note yields the note alone: the staffer is still told to read the
 * transcript, which is the one thing they must not be left guessing about.
 *
 * Cuts at the last LINE boundary that fits where there is one, because the
 * excerpt is a bulleted list of the caller's turns and half a turn is worse
 * than one fewer turn.
 */
export function trimToBudget(text: string, budget: number): string {
  if (budget <= 0) return TRUNCATION_NOTE.trimStart();
  if (text.length <= budget) return text;
  const room = budget - TRUNCATION_NOTE.length;
  if (room <= 0) return TRUNCATION_NOTE.trimStart();
  const hard = text.slice(0, room);
  const lastLine = hard.lastIndexOf('\n');
  return (lastLine > 0 ? hard.slice(0, lastLine) : hard) + TRUNCATION_NOTE;
}

/**
 * HOW LONG THE SETTLEMENT UPDATE KEEPS TRYING — Codex P1, #313, found after
 * the merge and correct.
 *
 * `handleBlindDialResult` fires the lane callback and forgets the pending
 * dial, then answers Twilio 200. So a transient failure on this POST had no
 * second chance anywhere: Twilio has no reason to retry a 200, the pending
 * entry is gone, and the ticket stays at `DIALING` / `HAND_OFF`. On a
 * `no_answer` that is the whole point of v30 lost — the request is never
 * reopened as an OPEN task and a caller who sat in hold music and gave up is
 * never called back.
 *
 * THE RETRY LIVES IN THE LANE, NOT THE TRANSPORT, and that is deliberate.
 * `blindTransferDialResult` knows about dials and TwiML; it has no business
 * knowing that a ticket POST can fail transiently or what to do about it.
 * Its own contract is unchanged — fire and forget, never block the webhook —
 * and this runs INSIDE the callback it already forgets, so Twilio still gets
 * its TwiML immediately.
 *
 * ~26 seconds over four attempts. Long enough for a restart or a blip on the
 * ticketing app, short enough that a redeploy is unlikely to land in the
 * middle of it.
 */
export const SETTLE_RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

/**
 * A refusal `submitPcpTicket` produced ITSELF, before the wire.
 *
 * `invalid_payload:` and `disposition_not_allowed:` come from its own
 * safeParse and disposition assertion, which are pure functions of the
 * payload — retrying sends the identical bytes to the identical check and
 * gets the identical answer. Everything else (a timeout, a 5xx, a socket
 * reset, an HTTP error carried up as a message) may succeed on a second try,
 * so it is retried. Erring toward retrying an unknown costs a few POSTs on a
 * path that fires rarely; erring the other way loses the request.
 */
export function settlementIsWorthRetrying(error: string | undefined): boolean {
  if (!error) return true;
  return !/^(invalid_payload|disposition_not_allowed):/.test(error);
}

export interface SettlementAttempt {
  success: boolean;
  error?: string;
}

/**
 * Post the settlement, retrying a transient failure on a bounded schedule.
 *
 * WHAT THIS DOES NOT PROMISE, stated because the alternative is believing it
 * does: it is IN-PROCESS. A deploy or a crash inside the retry window loses
 * the update, and the ticket stays at `DIALING` — the pre-v30 reading, which
 * is wrong but not a lie about a human. Making it survive that means putting
 * PCP payloads through `ticketOutboxService`, which today wraps only
 * `createTicket` shapes (`wrapCreateTicketPayload`); that is a real change to
 * the durable filing path and `docs/BACKEND_HANDOFF.md` applies to it, so it
 * is named here rather than smuggled in behind a P1 fix.
 */
export async function persistSettlement(
  post: () => Promise<SettlementAttempt>,
  deps: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<{ ok: boolean; attempts: number; lastError?: string }> {
  const delays = deps.delaysMs ?? SETTLE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => console.warn(line));

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
    let res: SettlementAttempt;
    try {
      res = await post();
    } catch (err) {
      // A THROW IS A TRANSIENT FAILURE, not a verdict. submitPcpTicket returns
      // a structured failure for everything it decides itself, so anything
      // that escapes as an exception came from below it.
      res = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.success) return { ok: true, attempts: attempt };
    lastError = res.error;
    if (!settlementIsWorthRetrying(res.error)) {
      log(`[PCP] settlement refused and not retryable (${res.error ?? 'no reason given'})`);
      return { ok: false, attempts: attempt, lastError };
    }
    const delay = delays[attempt - 1];
    if (delay === undefined) break;
    await sleep(delay);
  }
  log(
    `[PCP] settlement update FAILED after ${delays.length + 1} attempts ` +
      `(${lastError ?? 'no reason given'}) — the ticket still reads DIALING`,
  );
  return { ok: false, attempts: delays.length + 1, lastError };
}
