/**
 * THE TICKET LEARNS WHAT THE DIAL DID — the v14 reversal's measurement half.
 *
 * Operator, 2026-09-15: "yes to the v14 reversal." The 09-13 ruling withheld
 * the ticket from anyone who chose the live queue; Rosa's 09-08 design, now
 * restored, files it with a status that does not claim a person was reached.
 *
 * Filing it is only half. Before this, the ticket said `DIALING` FOREVER:
 * `handoff_to_pcp` returns while the queue is still ringing, and Twilio's
 * `<Dial action>` callback arrives minutes later on its own HTTP request,
 * reaching `call_logs.transfer_outcome` and nothing else. So the row a
 * staffer opens looked identical whether the queue answered in four seconds
 * or never picked up.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE TESTS THE CHAIN, NOT JUST ITS LAST LINK.
 *
 * CLAUDE.md failure mode 10 — "testing the sink instead of the source" — is
 * the exact hazard here, and v20 is the worked example: both ENDS of the
 * blind-transfer method flag had tests, the two links BETWEEN them had none,
 * and the live behaviour could revert with every test green.
 *
 * There are four links and each gets its own assertion:
 *
 *   1. `handoffAfterQueueDial` maps an outcome onto a handoff block.
 *   2. `handleBlindDialResult` CALLS the registered callback.
 *   3. `runtimeTransfer` SNAPSHOTS it onto the pending dial.
 *   4. `pcpAgent` REGISTERS it before the redirect.
 *
 * Links 3 and 4 are pinned by reading the source, the device
 * `ticketRequirements.test.ts` already uses for the sweep's wiring: they are
 * single lambdas inside a live dial path that no unit test can reach without
 * standing up Twilio.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import twilio from 'twilio';
import { handoffAfterQueueDial } from './queueDialSettlement';
import {
  handleBlindDialResult,
  type DialResultDeps,
  type PendingBlindDial,
} from '../runtime/blindTransferDialResult';
import type { WebhookRequest } from '../runtime/voiceWebhook';
import type { BlindDialSettlement } from '../services/escalationStore';

const AUTH_TOKEN = 'test-auth-token';
const HOST = 'example.test';
const PATH = '/voice/transfer-dial-result';

function req(body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: HOST,
      'x-forwarded-proto': 'https',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        `https://${HOST}${PATH}`,
        body,
      ),
    },
    body,
    originalUrl: PATH,
  };
}

const CONTEXT = {
  requestedAt: '2026-09-15T17:00:00.000Z',
  attemptedAt: '2026-09-15T17:00:05.000Z',
};

function settlement(over: Partial<BlindDialSettlement> = {}): BlindDialSettlement {
  return {
    outcome: 'queue_answered',
    status: 'COMPLETED',
    connected: true,
    talkSeconds: 62,
    ringSeconds: 33,
    dialedNumber: '+17149564300',
    ...over,
  };
}

// ── link 1 ─────────────────────────────────────────────────────────────────

describe('an answered queue is still not a human', () => {
  /**
   * THE LOAD-BEARING ASSERTION OF THE WHOLE FILE.
   *
   * The ticketing app computes `humanHandoffOccurred = finalStatus ===
   * 'CONNECTED'`. A staffer who reads "handoff occurred" assumes the
   * conversation happened and skips the callback — the one thing Rosa's
   * ticket exists to prevent, and the defect v20 fixed on 20 tickets of
   * 2026-09-14. `queue_answered` means the ACD picked up; the caller may
   * have spent every second of it in hold music.
   */
  it('leaves finalStatus at DIALING when the queue picks up', () => {
    const { handoff, disposition } = handoffAfterQueueDial(settlement(), CONTEXT);

    expect(handoff.finalStatus, 'an ACD answering is not a person speaking').toBe('DIALING');
    expect(handoff.connectedAt).toBeUndefined();
    expect(disposition).toBe('HAND_OFF');
  });

  /**
   * The bridge duration is the ONLY thing that separates a real conversation
   * from a caller who gave up in hold music, so it must survive onto the
   * ticket rather than being collapsed into the word "answered".
   */
  it('carries the bridge duration a staffer needs to read it', () => {
    const { handoff } = handoffAfterQueueDial(settlement({ talkSeconds: 2 }), CONTEXT);

    expect(handoff.humanAnswerStatus).toMatch(/QUEUE_ANSWERED/);
    expect(handoff.humanAnswerStatus).toMatch(/\b2s\b/);
  });

  it('never invents a connectedAt on any outcome', () => {
    for (const s of [
      settlement(),
      settlement({ outcome: 'no_answer', status: 'NO-ANSWER', connected: false, talkSeconds: undefined }),
      settlement({ outcome: 'failed', status: 'FAILED', connected: false, talkSeconds: undefined }),
    ]) {
      const { handoff } = handoffAfterQueueDial(s, CONTEXT);
      expect(handoff.connectedAt).toBeUndefined();
      expect(handoff.finalStatus).not.toBe('CONNECTED');
    }
  });
});

describe('a queue that did not answer re-opens the request', () => {
  /**
   * The caller asked for the queue, was put through, and nobody picked up —
   * so the request needs a person now. `fallbackTicketStatus: OPEN` is what
   * says so, and CREATE_TASK is what the ticketing app permits against a
   * HAND_OFF-default purpose for exactly these statuses.
   */
  it('files NO_ANSWER as an open task, not a completed handoff', () => {
    const { handoff, disposition } = handoffAfterQueueDial(
      settlement({ outcome: 'no_answer', status: 'NO-ANSWER', connected: false, talkSeconds: undefined }),
      CONTEXT,
    );

    expect(handoff.finalStatus).toBe('NO_ANSWER');
    expect(handoff.humanAnswerStatus).toBe('QUEUE_NO_ANSWER');
    expect(handoff.fallbackTicketStatus).toBe('OPEN');
    expect(disposition).toBe('CREATE_TASK');
  });

  it('keeps Twilio\'s own word on the failure, so our reading can be checked', () => {
    const { handoff } = handoffAfterQueueDial(
      settlement({ outcome: 'failed', status: 'QUANTUM', connected: false, talkSeconds: undefined }),
      CONTEXT,
    );

    expect(handoff.finalStatus).toBe('FAILED');
    expect(handoff.failureReason).toMatch(/QUANTUM/);
    expect(handoff.fallbackTicketStatus).toBe('OPEN');
  });

  it('preserves what the pre-dial write established', () => {
    const { handoff } = handoffAfterQueueDial(settlement(), CONTEXT);

    expect(handoff.requested).toBe(true);
    expect(handoff.requestedAt).toBe(CONTEXT.requestedAt);
    expect(handoff.attempted).toBe(true);
    expect(handoff.attemptedAt).toBe(CONTEXT.attemptedAt);
    expect(handoff.destination, 'the number the runtime actually dialled').toBe('+17149564300');
  });
});

// ── link 2 ─────────────────────────────────────────────────────────────────

describe('the webhook actually calls the lane back', () => {
  function harness(pending: PendingBlindDial | undefined) {
    const recorded: unknown[] = [];
    const deps: DialResultDeps = {
      env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
      pendingFor: () => pending,
      forget: () => undefined,
      record: (_sid, outcome) => void recorded.push(outcome),
      now: () => 1_000_000 + 95_000,
      log: () => undefined,
    };
    return { deps, recorded };
  }

  const base: PendingBlindDial = {
    attemptId: 7,
    destination: '+17149564300',
    redirectedAtMs: 1_000_000,
  };

  it('hands the lane what the dial did', async () => {
    const onSettled = vi.fn();
    const { deps } = harness({ ...base, onSettled });

    handleBlindDialResult(
      req({ CallSid: 'CAcaller', DialCallStatus: 'completed', DialCallDuration: '62' }),
      deps,
    );
    await Promise.resolve();

    expect(onSettled).toHaveBeenCalledTimes(1);
    const got = onSettled.mock.calls[0][0] as BlindDialSettlement;
    expect(got.outcome).toBe('queue_answered');
    expect(got.connected).toBe(true);
    expect(got.talkSeconds).toBe(62);
    expect(got.dialedNumber).toBe('+17149564300');
    expect(got.status, "Twilio's own word, verbatim").toBe('COMPLETED');
  });

  it('tells the lane about a dial that rang out too', async () => {
    const onSettled = vi.fn();
    const { deps } = harness({ ...base, onSettled });

    handleBlindDialResult(req({ CallSid: 'CAcaller', DialCallStatus: 'no-answer' }), deps);
    await Promise.resolve();

    expect(onSettled).toHaveBeenCalledTimes(1);
    const got = onSettled.mock.calls[0][0] as BlindDialSettlement;
    expect(got.outcome).toBe('no_answer');
    expect(got.connected).toBe(false);
    expect(got.talkSeconds, 'nothing was bridged, so there is no duration to report').toBeUndefined();
  });

  /**
   * THE MEASUREMENT OUTRANKS THE LANE. `deps.record` writes
   * `call_logs.transfer_outcome` and is this handler's first job; a lane
   * callback that throws must not be able to cost us it, and must not turn a
   * webhook Twilio is waiting on into a 500.
   */
  it('records the outcome even when the lane callback throws', async () => {
    const { deps, recorded } = harness({
      ...base,
      onSettled: () => {
        throw new Error('ticketing is down');
      },
    });

    const res = handleBlindDialResult(
      req({ CallSid: 'CAcaller', DialCallStatus: 'completed', DialCallDuration: '10' }),
      deps,
    );
    await Promise.resolve();

    expect(recorded, 'the record is written before the lane is told').toHaveLength(1);
    expect(res.status).toBe(200);
  });

  it('does not fall over when no lane registered a callback', () => {
    const { deps, recorded } = harness(base);

    const res = handleBlindDialResult(req({ CallSid: 'CAcaller', DialCallStatus: 'completed' }), deps);

    expect(recorded).toHaveLength(1);
    expect(res.status).toBe(200);
  });
});

// ── links 3 and 4 ──────────────────────────────────────────────────────────

describe('the callback is wired from the agent to the webhook', () => {
  /**
   * Both of these are single lambdas on a live dial path. A unit test cannot
   * reach them without standing up Twilio, and v20 is the record of what that
   * costs: the two middle links of an identical chain were uncovered, so the
   * behaviour could revert with every test still green.
   */
  it('runtimeTransfer snapshots the lane callback onto the pending dial', () => {
    const src = readFileSync('src/runtime/runtimeTransfer.ts', 'utf8');
    expect(
      src,
      'the side channel is deleted in attempt()\'s finally — it must be copied, not read later',
    ).toMatch(/onSettled:\s*details\.onBlindDialSettled/);
  });

  it('pcpAgent registers it BEFORE the redirect', () => {
    const src = readFileSync('src/agents/pcpAgent.ts', 'utf8');
    expect(src).toMatch(/onBlindDialSettled:/);
    expect(src, 'the settle update re-posts the payload the pre-dial write used').toMatch(
      /handoffAfterQueueDial\(settlement,/,
    );
    /**
     * ONLY WHEN THE PRE-DIAL WRITE SUCCEEDED. The ticketing app INSERTS when
     * it cannot find the callSid, so registering after a failed write could
     * open a second ticket minutes later carrying a dial outcome and no
     * intake.
     */
    expect(src).toMatch(/onBlindDialSettled:\s*initial\.success/);
  });
});
