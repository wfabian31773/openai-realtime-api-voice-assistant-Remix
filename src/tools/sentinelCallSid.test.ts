/**
 * "unknown" IS NOT A CALL — the P1 Codex found on PR #244.
 *
 * Both per-call stores added by this branch key on the CallSid, and both
 * accepted any non-empty string. `call_sid` is a DECLARED property on the
 * filing tools, so a model with no injected value supplies a sentinel:
 * between 2026-08-24 and 09-01 the literal strings "unknown", "none",
 * "undefined", "N/A", "latest" and "automated_xxx_placeholder" reached
 * create-ticket on 137 live POSTs.
 *
 * Every call emitting the same sentinel therefore shared one map entry.
 *
 *  - `verifiedIdentity` — the dangerous one. Two callers with the same
 *    normalized name (a father and son; these lines get them constantly) and
 *    the same sentinel are ONE key, so the second caller's ticket is filed
 *    with the FIRST caller's date of birth. The name guard cannot catch it —
 *    matching names is exactly the condition under which it fires.
 *  - `gateAttempts` — one optical caller refused for a missing office makes
 *    the next sentinel-bearing call look already-asked, so the agent skips the
 *    question and files unassigned without ever asking.
 *
 * The fix is one predicate, `isTwilioCallSid`, applied on reads and writes in
 * both stores. A call with no usable SID keeps the OLD behaviour — nothing
 * remembered, ask every time — which is the safe direction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberVerifiedIdentity,
  verifiedDobFor,
  resetVerifiedIdentities,
} from './verifiedIdentity';
import { gateRefusalsSoFar, noteGateRefusal, resetGateAttempts } from './gateAttempts';

/** Real, and shaped exactly as Twilio issues them. */
const REAL_A = 'CA' + 'a'.repeat(32);
const REAL_B = 'CA' + 'b'.repeat(32);

/** Every sentinel actually observed on a live create-ticket POST. */
const SENTINELS = ['unknown', 'none', 'undefined', 'N/A', 'latest', 'automated_xxx_placeholder'];

beforeEach(() => {
  resetVerifiedIdentities();
  resetGateAttempts();
});

describe('verifiedIdentity refuses to key on a sentinel', () => {
  const WAYNE = { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '1973-03-17' };

  it.each(SENTINELS)('does not remember an identity under %s', (sentinel) => {
    rememberVerifiedIdentity(sentinel, WAYNE);
    expect(verifiedDobFor(sentinel, 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('cannot hand one caller the date of birth of another with the same name', () => {
    // The father calls. His record is certain, and under the old truthiness
    // check this was stored under the key "unknown".
    rememberVerifiedIdentity('unknown', WAYNE);

    // The son calls later. Same name, same missing SID, different person and a
    // different date of birth — and nothing about the names distinguishes them.
    expect(verifiedDobFor('unknown', 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('still works normally for a real CallSid', () => {
    rememberVerifiedIdentity(REAL_A, WAYNE);
    expect(verifiedDobFor(REAL_A, 'Wayne', 'Fabian')).toBe('1973-03-17');
  });

  it('keeps each real call separate', () => {
    rememberVerifiedIdentity(REAL_A, WAYNE);
    expect(verifiedDobFor(REAL_B, 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('rejects a uuid, which is what the old metadata fallback produced', () => {
    rememberVerifiedIdentity('3f2a9c1e-7b44-4d51-9e02-6c8f1a2b3d4e', WAYNE);
    expect(verifiedDobFor('3f2a9c1e-7b44-4d51-9e02-6c8f1a2b3d4e', 'Wayne', 'Fabian')).toBeUndefined();
  });
});

describe('gateAttempts refuses to key on a sentinel', () => {
  it.each(SENTINELS)('does not carry a refusal count across calls under %s', (sentinel) => {
    noteGateRefusal(sentinel, 'file_optical_ticket', 'location');
    // The next caller on the same sentinel must still be ASKED, which is the
    // documented fallback — not silently filed unassigned.
    expect(gateRefusalsSoFar(sentinel, 'file_optical_ticket', 'location')).toBe(0);
  });

  it('still counts refusals within one real call', () => {
    expect(gateRefusalsSoFar(REAL_A, 'file_optical_ticket', 'location')).toBe(0);
    noteGateRefusal(REAL_A, 'file_optical_ticket', 'location');
    expect(gateRefusalsSoFar(REAL_A, 'file_optical_ticket', 'location')).toBe(1);
  });

  it('keeps two real calls apart', () => {
    noteGateRefusal(REAL_A, 'file_optical_ticket', 'location');
    expect(gateRefusalsSoFar(REAL_B, 'file_optical_ticket', 'location')).toBe(0);
  });
});
