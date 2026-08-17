/**
 * FORTY-FIVE SECONDS, THREE BEATS, AND A ROW FOR EVERY DIAL.
 *
 * Operator, 2026-08-16, giving the script directly: *"45 seconds total before
 * we give up, like this, one moment while I try to connect you to the office,
 * 15 seconds, still trying, 15 seconds, my last attempt, 15 seconds, I
 * apologize but it seems our staff are attending other calls at the moment, I
 * will have to take a message for a call back. We never relinquish the patient
 * until either of two things happen, we transfer or we create a ticket."*
 *
 * Two things are pinned here.
 *
 * THE LADDER. What shipped before told the model to "cut in with ONE short,
 * warm reassurance (vary the wording)" every ten seconds. It did not vary:
 * CAa9a11c3f heard the same sentence repeatedly, and the PCP equivalent on
 * CAdd8ab6dd was word-for-word identical three times across 49 seconds. The
 * licence bought nothing and cost control of the only script a caller hears
 * while they cannot tell us from a dead line.
 *
 * THE ROW. `recordTransferOutcome` was called from exactly two places — the
 * keypress accept and the AMD webhook — so only transfers where the office DID
 * something were ever recorded. Measured 2026-08-16: 104 rows for 278
 * azul-scheduling calls that dialled. A 37% sample biased entirely towards
 * success is the worst possible basis for an answer-rate question.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const { HOLD_LADDER, HOLD_LADDER_MS } = await import('./azulSchedulingAgent');

const agentSrc = readFileSync(new URL('./azulSchedulingAgent.ts', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');

/**
 * Comments quote the behaviour they removed — that is the point of them — so a
 * ban on a phrase has to be checked against CODE, not prose. The cost tests do
 * the same thing for the same reason.
 */
const agentCode = agentSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the hold ladder is the operator\'s script', () => {
  it('has all four beats', () => {
    expect(HOLD_LADDER.connecting).toMatch(/connect you to the office/i);
    expect(HOLD_LADDER.stillTrying).toMatch(/still trying/i);
    expect(HOLD_LADDER.lastAttempt).toMatch(/last attempt/i);
    expect(HOLD_LADDER.givingUp).toMatch(/attending other calls/i);
  });

  it('the giving-up line takes a message and promises nothing more', () => {
    // His words, and they matter: "take a message for a call back" — not a
    // time, not a name, not "within the hour".
    expect(HOLD_LADDER.givingUp).toMatch(/take a message/i);
    expect(HOLD_LADDER.givingUp).toMatch(/call ?back/i);
    expect(HOLD_LADDER.givingUp, 'must not promise a callback window').not.toMatch(/within the hour|shortly|right away|\d+ ?(minutes|hours)/i);
  });

  it('names the end before it arrives', () => {
    // "My last attempt" is what makes the wait finite. A caller who is not
    // told the attempt is bounded has no idea whether to keep holding.
    expect(HOLD_LADDER.lastAttempt).toMatch(/last/i);
  });

  it('the beats fit inside the window, in order', () => {
    expect(HOLD_LADDER_MS.stillTrying).toBe(15_000);
    expect(HOLD_LADDER_MS.lastAttempt).toBe(30_000);
    expect(HOLD_LADDER_MS.total).toBe(45_000);
    expect(HOLD_LADDER_MS.stillTrying).toBeLessThan(HOLD_LADDER_MS.lastAttempt);
    expect(HOLD_LADDER_MS.lastAttempt).toBeLessThan(HOLD_LADDER_MS.total);
  });

  it('the transport window agrees with the ladder', () => {
    /**
     * These live in two files and MUST match: if the dial window were shortened
     * below 30s the caller would be cut off mid-"last attempt", and if it were
     * lengthened the ladder would go silent for the remainder. The constant is
     * named and commented on both sides so the next person moving one finds
     * the other.
     */
    expect(routesSrc).toMatch(/const WARM_TRANSFER_WINDOW_MS = 45_000;/);
    expect(routesSrc).toMatch(/\}, WARM_TRANSFER_WINDOW_MS\);/);
    expect(routesSrc, 'the literal 45_000 must not linger at the timeout').not.toMatch(/rejectAccepted\(new Error\('Office did not accept[^)]*\)\);\s*\}, 45_000\)/);
  });
});

describe('the model no longer writes the hold lines', () => {
  it('the improvisation licence is gone', () => {
    expect(agentCode, '"vary the wording" must not survive in code').not.toMatch(/vary the wording/i);
    expect(agentCode, 'the old ad-lib example must not survive in code').not.toMatch(/hang tight/i);
  });

  it('the cut-ins are handed over as exact text', () => {
    expect(agentCode).toMatch(/Say EXACTLY this to the caller, in their language/);
    expect(agentCode).toMatch(/do not rephrase it/i);
  });

  it('the tool tells the model the lines are given, not invented', () => {
    const at = agentCode.indexOf("name: 'transfer_to_office'");
    const desc = agentCode.slice(at, at + 1800);
    expect(desc).toMatch(/two scripted cut-ins/i);
    expect(desc).toMatch(/Do not improvise a hold line/i);
    // The pre-dial line is INTERPOLATED from the constant rather than copied,
    // so the description cannot drift from the ladder.
    expect(desc).toMatch(/\$\{HOLD_LADDER\.connecting\}/);
  });

  it('the caller is never told they are on hold for an unbounded time', () => {
    // Nothing in the ladder may suggest indefinite waiting.
    for (const line of Object.values(HOLD_LADDER)) {
      expect(line, `"${line}" suggests an open-ended wait`).not.toMatch(/please continue to hold|stay on the line as long|indefinitel/i);
    }
  });
});

describe('the patient is never relinquished', () => {
  it('the failure path hands over a `say` line rather than leaving it open', () => {
    const block = agentSrc.slice(agentSrc.indexOf("error: 'office_no_answer'"), agentSrc.indexOf("error: 'office_no_answer'") + 1600);
    expect(block).toMatch(/say: HOLD_LADDER\.givingUp/);
    expect(block).toMatch(/never end the call without either a completed transfer or that message|ticket is filed automatically/i);
  });

  it('a failed dial is still recorded for the sweep to file against', () => {
    // The sweep is what guarantees the ticket; it needs the attempt recorded.
    expect(agentSrc).toMatch(/failedTransferAttempts\.set\(callId/);
  });
});

describe('every dial now leaves a row', () => {
  it('the timeout records an outcome instead of only rejecting', () => {
    // Anchor on the acceptance-window timer specifically — there is more than
    // one `setTimeout` in this file and indexOf found the wrong one first.
    const at = routesSrc.indexOf('warmTransferAccepts.delete(dialedSid);');
    expect(at, 'the acceptance-window timer moved').toBeGreaterThan(-1);
    const block = routesSrc.slice(at, at + 1800);
    expect(block).toMatch(/recordTransferOutcome\(dialedSid, 'timeout'\)/);
    // And it must STILL settle the promise — an early edit of mine dropped
    // this, which would have hung every timed-out transfer forever.
    expect(block, 'the promise must still reject').toMatch(/rejectAccepted\(new Error/);
  });

  it('a dial that errors records one too', () => {
    expect(routesSrc).toMatch(/recordTransferOutcome\(officeCallSid, 'dial_failed', \{ detail \}\)/);
  });

  it('the outcome union covers the new terminal states', () => {
    expect(routesSrc).toMatch(/'no_keypress' \| 'timeout' \| 'dial_failed'/);
  });

  it('recording twice for one leg is harmless', () => {
    /**
     * The 45s timeout and a late Twilio status callback race routinely. The
     * lookup-then-delete happens before any await, so the first writer wins
     * and the second becomes a no-op — last-write-wins would have let a
     * trailing 'completed' overwrite the real 'timeout'.
     */
    const fn = routesSrc.slice(routesSrc.indexOf('async function recordTransferOutcome'), routesSrc.indexOf('function sendLoopGuardDirective'));
    const guard = fn.indexOf('if (!dial) return;');
    const del = fn.indexOf('officeLegDials.delete(officeCallSid);');
    const firstAwait = fn.indexOf('await ');
    expect(guard).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(guard);
    expect(del, 'the delete must happen before any await, or the race reopens').toBeLessThan(firstAwait);
  });

  it('an outcome that arrives before the call log id still lands', () => {
    /**
     * dbCallLogId is written by a BACKGROUND task. The old code returned when
     * it was absent — AFTER deleting the dial entry, so the row was
     * unrecoverable. The timeline flush already resolves by callSid; this now
     * does the same.
     */
    const fn = routesSrc.slice(routesSrc.indexOf('async function recordTransferOutcome'), routesSrc.indexOf('function sendLoopGuardDirective'));
    expect(fn).toMatch(/meta\?\.dbCallLogId/);
    // The caller's callSid rides on the DIAL record. CallMetadata.twilioCallSid
    // is declared and never written, so reading it there was a no-op.
    expect(fn).toMatch(/dial\.callerCallSid/);
    expect(fn, 'must not bail when only the callSid is known').not.toMatch(/if \(!callLogId\) return;/);
  });
});

describe('a skipped hold beat is retried, not lost', () => {
  /**
   * Found in review, 2026-08-17. The two cut-ins were one-shot setTimeouts.
   * The holding callback SKIPS when the agent is mid-response — correctly,
   * there is no silence to fill — so a one-shot landing in that window was
   * gone for good, leaving the caller silent until the 45s giving-up line.
   *
   * The code this replaced used a repeating interval and retried by accident;
   * the rewrite lost that without noticing.
   */
  const src = readFileSync(new URL('./azulSchedulingAgent.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('ticks until the beat lands', () => {
    expect(code).toMatch(/setInterval\(/);
    expect(code).toMatch(/const spoken = \{ stillTrying: false, lastAttempt: false, stillTryingAt: 0 \}/);
    // And the two beats cannot bunch: a late stillTrying holds lastAttempt off.
    expect(code).toMatch(/const tooSoon = spoken\.stillTryingAt > 0 &&/);
  });

  it('only marks a beat spoken when the callback actually sent it', () => {
    // `hb()` returns false when it skipped. Marking spoken regardless is the
    // bug wearing a retry loop.
    expect(code).toMatch(/hb\(sayExactly\(HOLD_LADDER\.lastAttempt\)\) !== false/);
    expect(code).toMatch(/hb\(sayExactly\(HOLD_LADDER\.stillTrying\)\) !== false/);
  });

  it('the callback contract reports whether it sent', () => {
    const routes = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');
    expect(code).toMatch(/\(instructionOverride\?: string\) => boolean \| void/);
    expect(routes).toMatch(/registerAzulHoldingCallback\(callId, \(instructionOverride\?: string\): boolean =>/);
  });

  it('never speaks a beat twice, and stops at the window', () => {
    const at = code.indexOf('const holdStartedAt');
    const block = code.slice(at, at + 900);
    expect(block).toMatch(/!spoken\.lastAttempt/);
    expect(block).toMatch(/!spoken\.stillTrying/);
    expect(code).toMatch(/clearInterval\(holdTick\)/);
  });
});

describe('the handoff ladder fails open and stays measurable', () => {
  const src = readFileSync(new URL('./azulSchedulingAgent.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('keys the offer on callId, falling back to callSid', () => {
    /**
     * The offer is spent by adding a key to `handoffOfferMade`. With no key
     * there is nowhere to record it, so `offerAlreadyMade` would be false
     * forever and a patient_requested_human + schedulable handoff would return
     * offer_first on every attempt and NEVER transfer.
     *
     * The FIRST fix disabled the whole ladder when callId was missing, which
     * threw away the intent gate too. That gate is stateless and cannot loop;
     * skipping it means a handoff reaching the front desk with an empty
     * briefing — the thing the warm transfer exists to prevent. callSid is the
     * same fallback the transcript provider and the sweep already use.
     * Found on the second review pass, 2026-08-17.
     */
    expect(code).toMatch(/const ladderKey = ladderCallId \?\? metadata\?\.callSid;/);
    expect(code, 'the ladder must still run without a callId').not.toMatch(/const verdict = ladderCallId\s*\?\s*ladderVerdict\(/);
  });

  it('only the loopable half is disabled when there is no key at all', () => {
    // offerAlreadyMade: true means "do not offer" — the intent gate still runs.
    expect(code).toMatch(/offerAlreadyMade: ladderKey \? handoffOfferMade\.has\(ladderKey\) : true/);
  });

  it('records a timeline row for every refusal', () => {
    /**
     * This work was justified by counting refusals in tool_timeline — 237 of
     * 455 handoffs were patient_requested_human. Returning without recording
     * meant the NEW gate produced no rows, so the measurement that argued for
     * it could not be repeated against it. The measurement trap, a third time.
     */
    const at = code.indexOf('if (!verdict.allow)');
    const block = code.slice(at, at + 1200);
    expect(block).toMatch(/recordAzulToolEvent\(/);
    expect(block).toMatch(/handoffReason/);
    expect(block).toMatch(/schedulableHere/);
  });

  it('telemetry failure cannot break the call', () => {
    const at = code.indexOf('if (!verdict.allow)');
    const block = code.slice(at, at + 1200);
    expect(block).toMatch(/try \{[\s\S]*recordAzulToolEvent[\s\S]*\} catch/);
  });
});

describe('a transfer outcome that lands nowhere says so', () => {
  /**
   * Found in review, 2026-08-17. The by-callSid fallback logged "outcome
   * recorded" even when the update matched ZERO rows — the call-log row not
   * written yet — AFTER officeLegDials had already been deleted, so the
   * outcome was unrecoverable and the log claimed success. A coverage fix that
   * fails silently is worse than the gap it replaced.
   */
  const routes = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');

  it('checks whether the update matched anything', () => {
    const fn = routes.slice(routes.indexOf('async function recordTransferOutcome'), routes.indexOf('function sendLoopGuardDirective'));
    expect(fn).toMatch(/\.returning\(\{ id: callLogsTable\.id \}\)/);
    expect(fn).toMatch(/if \(!written\.length\)/);
  });

  it('and warns instead of claiming success', () => {
    const fn = routes.slice(routes.indexOf('async function recordTransferOutcome'), routes.indexOf('function sendLoopGuardDirective'));
    const lostAt = fn.indexOf('LOST for');
    const recordedAt = fn.indexOf('outcome recorded:');
    expect(lostAt, 'the miss must be logged').toBeGreaterThan(-1);
    expect(lostAt, 'and must return before the success line').toBeLessThan(recordedAt);
  });
});
