/**
 * The carry that would have saved five requests on 2026-09-02.
 *
 * Its sibling `verifiedIdentity.test.ts` covers the same rules for the date of
 * birth; this covers the office and the provider, and the guards are the same
 * ones because the failure they prevent is the same.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberResolvedOffice,
  rememberResolvedProvider,
  resolvedOfficeFor,
  resolvedProviderFor,
  resetResolvedContext,
  resolvedContextSize,
} from './resolvedContext';

const SID = 'CA747908b5d46b7ed25cffe733fb792738';
const OTHER = 'CAcf07a0202a54d64eb10fbc2e4525d668';

beforeEach(() => {
  resetResolvedContext();
});

describe('carrying what a tool already resolved', () => {
  it('hands back the office resolve_location verified', () => {
    rememberResolvedOffice(SID, 'Redlands', true);
    expect(resolvedOfficeFor(SID)).toBe('Redlands');
  });

  it('refuses to carry an UNVERIFIED guess', () => {
    // resolve_location returns `verified: false` when the caller's words
    // matched no real office. Routing a ticket to a guessed office is worse
    // than leaving it for a human — that is a patient sent to the wrong
    // building.
    rememberResolvedOffice(SID, 'the one near the freeway', false);
    expect(resolvedOfficeFor(SID)).toBeUndefined();
  });

  it('never crosses calls', () => {
    rememberResolvedOffice(SID, 'Redlands', true);
    expect(resolvedOfficeFor(OTHER)).toBeUndefined();
  });

  /**
   * THE KEY MUST BE A REAL CALLSID. Found by Codex on PR #244 for the identity
   * carry and it is the same hazard here: `call_sid` is a declared property on
   * the filing tools, so a missing injected value becomes a model-supplied
   * sentinel — "unknown", "none", "latest". A truthiness check accepts those
   * and every call emitting the same sentinel shares one entry, which here
   * means filing one caller's request against another caller's office.
   */
  it.each(['unknown', 'none', 'latest', 'N/A', '', undefined])(
    'stores nothing under the sentinel %p',
    (sentinel) => {
      rememberResolvedOffice(sentinel as string | undefined, 'Redlands', true);
      expect(resolvedOfficeFor(sentinel as string | undefined)).toBeUndefined();
    },
  );

  it('does not let two sentinel calls share an office', () => {
    // The failure the rule above exists to stop, stated as behaviour.
    rememberResolvedOffice('unknown', 'Redlands', true);
    expect(resolvedOfficeFor('unknown')).toBeUndefined();
  });

  it('stores NOTHING under a sentinel — the write guard, not just the read', () => {
    // The read guard alone makes a sentinel entry unreachable, so relaxing
    // the WRITE to a truthiness check is invisible to every public read and
    // survived the mutation check. This looks at the store itself.
    for (const sentinel of ['unknown', 'none', 'latest', 'N/A']) {
      rememberResolvedOffice(sentinel, 'Redlands', true);
      rememberResolvedProvider(sentinel, 'David Choi, MD');
    }
    expect(resolvedContextSize()).toBe(0);
  });

  it('keeps the office and the provider side by side', () => {
    rememberResolvedOffice(SID, 'Redlands', true);
    rememberResolvedProvider(SID, 'David Choi, MD');
    expect(resolvedOfficeFor(SID)).toBe('Redlands');
    expect(resolvedProviderFor(SID)).toBe('David Choi, MD');
  });

  it('lets a later resolution replace an earlier one', () => {
    // A caller who corrects themselves — "no, sorry, the Redlands one" — must
    // not have the first answer outrank the second.
    rememberResolvedOffice(SID, 'Encinitas', true);
    rememberResolvedOffice(SID, 'Redlands', true);
    expect(resolvedOfficeFor(SID)).toBe('Redlands');
  });

  it('ignores blanks rather than erasing what it holds', () => {
    rememberResolvedOffice(SID, 'Redlands', true);
    rememberResolvedOffice(SID, '   ', true);
    expect(resolvedOfficeFor(SID)).toBe('Redlands');
  });
});
