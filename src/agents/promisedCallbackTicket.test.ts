/**
 * NOBODY IS PROMISED A CALLBACK AND THEN DROPPED.
 *
 * Operator's rule, 2026-08-16: *"We never relinquish the patient until either
 * of two things happen, we transfer or we create a ticket."*
 *
 * It was not holding. Two calls, both ending well from the caller's side:
 *
 *   CA880f3254  "Thanks for holding—I wasn't able to reach them directly. Our
 *                team will call you back at this number, usually within the
 *                hour."                          Kathleen Constantine, 5/18/1946
 *   CAadc456db  "Thanks for holding — I wasn't able to reach them directly. The
 *                office team will give you a call back as soon as possible."
 *                                                     David Donetz, 5/27/1969
 *
 * Neither has a ticket. Nobody knows they called.
 *
 * THREE INDEPENDENT DEFECTS, each of which alone loses the record:
 *
 *  1. `caller_declined` sat in CLEAN_END_REASONS beside ghost_call, robot_call
 *     and spam — reasons that mean no human was ever there. The model reached
 *     for it while the caller was ON HOLD, and the sweep returned early.
 *  2. `failedTransferAttempts` was set only AFTER the 45-second dial resolved,
 *     but the sweep runs the moment the call ends — and terminate_call fires
 *     DURING the dial. On CA880f3254: terminate 20:14:16, dial resolved
 *     20:14:30. The sweep looked 14 seconds too early.
 *  3. Nothing stopped `transfer_to_office` running after the call had ended.
 *     CAed3c6b49 dialled the office three more times — 40s, 40s, 41s — after
 *     terminate_call. Real phones rang at the front desk for a patient who was
 *     already gone.
 *
 * Measured blast radius before the fix: 102 calls used `caller_declined`, 40 of
 * them promised a callback in the transcript, and 28 of those have no filing
 * event at all. (Counted from the tool timeline, NOT from `ticket_number` —
 * that column is stamped on only 162 of the 231 calls whose timeline shows a
 * filing, and trusting it is what made the first count of this wrong.)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const src = readFileSync(new URL('./azulSchedulingAgent.ts', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('1 — a caller who "declined" is still a person we owe something', () => {
  it('caller_declined is out of CLEAN_END_REASONS', () => {
    expect(code).toMatch(/const CLEAN_END_REASONS = new Set\(\['ghost_call', 'robot_call', 'spam'\]\)/);
    expect(code, 'caller_declined must not be a clean end').not.toMatch(/CLEAN_END_REASONS = new Set\([^)]*caller_declined/);
  });

  it('what remains all means "no human was ever there"', () => {
    // The distinction that makes this list safe. If a future reason does not
    // meet it, it does not belong here.
    const m = code.match(/const CLEAN_END_REASONS = new Set\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const reasons = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(reasons.sort()).toEqual(['ghost_call', 'robot_call', 'spam']);
  });
});

describe('2 — an unanswered dial vetoes "clean end" whatever the reason says', () => {
  it('the veto is written against the dial, not against the reason list', () => {
    /**
     * Belt to the braces of removing caller_declined. Written as
     * `attemptedTransfer && !transferred` so a reason added to
     * CLEAN_END_REASONS later cannot reopen the hole.
     */
    expect(code).toMatch(/const attemptedTransfer = events\.some\(\(e\) => e\.tool === 'transfer_to_office'\)/);
    expect(code).toMatch(/const dialWentUnanswered = attemptedTransfer && !transferred/);
    expect(code).toMatch(/!dialWentUnanswered &&/);
  });

  it('the veto is applied before the reason is even consulted', () => {
    const at = code.indexOf('const cleanEnd =');
    const block = code.slice(at, at + 260);
    expect(block.indexOf('!dialWentUnanswered')).toBeLessThan(block.indexOf('CLEAN_END_REASONS'));
  });
});

describe('3 — the attempt is on file before the dial can outlive the call', () => {
  it('recorded up front, not in the failure branch', () => {
    const at = code.indexOf("const dial = officeTransferCallbacks.get(callId);");
    const upFront = code.slice(at, at + 900);
    // Set before the await that starts the 45-second wait.
    expect(upFront).toMatch(/failedTransferAttempts\.set\(callId/);
    const setAt = upFront.indexOf('failedTransferAttempts.set(callId');
    const awaitAt = upFront.indexOf('await dial(');
    if (awaitAt > -1) {
      expect(setAt, 'the record must exist before the dial is awaited').toBeLessThan(awaitAt);
    }
  });

  it('a connected transfer clears it', () => {
    // Otherwise the sweep files a callback for a patient already with a human,
    // which is the error the suppression branch exists to prevent.
    const at = code.indexOf('markAzulTransferAccepted(callId);');
    const block = code.slice(at, at + 500);
    expect(block).toMatch(/failedTransferAttempts\.delete\(callId\)/);
  });

  it('the already-connected error path clears it too', () => {
    const at = code.indexOf('if (transferredCalls.has(callId)) {');
    const block = code.slice(at, at + 400);
    expect(block).toMatch(/failedTransferAttempts\.delete\(callId\)/);
  });
});

describe('4 — we stop ringing the office for calls that have ended', () => {
  it('transfer_to_office refuses once the call is concluded', () => {
    expect(code).toMatch(/if \(callId && getCallConclusion\(callId\)\)/);
    expect(code).toMatch(/error: 'call_already_ended'/);
  });

  it('the guard runs before the packet lookup, so nothing dials', () => {
    const guardAt = code.indexOf('getCallConclusion(callId)');
    const dialAt = code.indexOf('const dial = officeTransferCallbacks.get(callId);');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, 'the conclusion check must come before the dial is resolved').toBeLessThan(dialAt);
  });

  it('it reuses the existing notion of a concluded call', () => {
    // markCallConcluded is already set by terminate_call and the deliberate
    // hangup path, and SIP recovery already reads it for this same class of
    // decision. A second notion of "over" would drift from the first.
    expect(code).toMatch(/import \{ markCallConcluded, getCallConclusion \} from '\.\.\/services\/callConclusion'/);
  });

  it('the refusal tells the agent to go quiet, not to explain', () => {
    const at = code.indexOf("error: 'call_already_ended'");
    const block = code.slice(at - 200, at + 300);
    expect(block).toMatch(/do not speak|Do not dial/i);
  });
});

describe('the sweep still refuses to file when the patient WAS helped', () => {
  it('a connected transfer suppresses the failure ticket', () => {
    // The opposite error, and it has its own history: 9 of 12 spurious tickets
    // on 2026-07-28 were callbacks for patients who had already been helped.
    expect(code).toMatch(/if \(failedAttempt && !transferred\)/);
    expect(src).toMatch(/had a failed dial but a later attempt connected — no ticket/);
  });
});
