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
    expect(fn).toMatch(/meta\?\.twilioCallSid/);
    expect(fn, 'must not bail when only the callSid is known').not.toMatch(/if \(!callLogId\) return;/);
  });
});
