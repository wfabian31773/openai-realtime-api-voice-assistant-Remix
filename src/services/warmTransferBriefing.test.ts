import { describe, it, expect } from 'vitest';
import {
  buildPcpTransferBriefing,
  buildWarmTransferScript,
  describesNonKeypressAccept,
  PRESS_PROMPT,
} from './warmTransferBriefing';

/**
 * The invariant under test is not "the wording is nice". It is that the
 * briefing cannot promise the office a way to accept that the accept handler
 * will not honour.
 *
 * `/api/voice/warm-transfer-accept` bridges on a digit and hangs up on
 * everything else. Every attempt on current code (2026-08-21, 08-27, 08-28)
 * recorded `acceptMethod: null` — nobody has pressed a key yet, so the
 * contradiction has not bitten a real staffer that we can see. It would the
 * first time one did what the recording told them.
 */
describe('the PCP warm-transfer briefing', () => {
  it('offers no way to accept except the keypress', () => {
    const briefing = buildPcpTransferBriefing({
      providerInfo: 'Care coordinator at Optum Clinic',
      reason: 'Prior authorization for a retinal exam',
    });

    const rival = describesNonKeypressAccept(briefing);
    expect(
      rival,
      `the briefing tells the office it can accept by "${rival}", but the accept ` +
        'handler hangs up on anything that is not a digit',
    ).toBeNull();
  });

  it('still says who is calling and why, so the patient does not repeat themselves', () => {
    const briefing = buildPcpTransferBriefing({
      providerInfo: 'Care coordinator at Optum Clinic',
      reason: 'Prior authorization for a retinal exam',
    });

    expect(briefing).toContain('Azul Vision PCP support assistant');
    expect(briefing).toContain('Care coordinator at Optum Clinic');
    expect(briefing).toContain('Prior authorization for a retinal exam');
  });

  it('omits the details it does not have rather than speaking empty labels', () => {
    expect(buildPcpTransferBriefing({})).toBe(
      'This is the Azul Vision PCP support assistant with a live professional caller transfer.',
    );
    expect(buildPcpTransferBriefing({ providerInfo: null, reason: null })).toBe(
      'This is the Azul Vision PCP support assistant with a live professional caller transfer.',
    );
  });
});

describe('describesNonKeypressAccept', () => {
  it('catches the exact phrasing that shipped', () => {
    expect(
      describesNonKeypressAccept('Press any key to accept, or remain on the line to connect.'),
    ).toBe('remain on the line');
  });

  it('catches the ways someone might rewrite it', () => {
    for (const text of [
      'Stay on the line and we will connect you.',
      'Hold to connect.',
      'Do nothing and the caller will be joined.',
      'No action is required to accept.',
      'Wait to be connected to the caller.',
    ]) {
      expect(describesNonKeypressAccept(text), text).not.toBeNull();
    }
  });

  it('does not fire on the keypress instruction itself', () => {
    expect(describesNonKeypressAccept('Press any key to take this caller.')).toBeNull();
  });
});

describe('the warm-transfer script the office actually hears', () => {
  const acceptUrl = 'https://example.test/api/voice/warm-transfer-accept';

  /** The whole spoken script, briefing included — what a staffer hears end to end. */
  function spokenScript(say: string): string {
    const twiml = buildWarmTransferScript({ say, acceptUrl });
    return [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]).join(' ');
  }

  it('never offers an accept the handler will not honour, briefing included', () => {
    const say = buildPcpTransferBriefing({
      providerInfo: 'Care coordinator at Optum Clinic',
      reason: 'Prior authorization',
    });
    const rival = describesNonKeypressAccept(spokenScript(say));
    expect(rival, `the office is told it can accept by "${rival}"`).toBeNull();
  });

  it('bookends the briefing with the keypress instruction', () => {
    const twiml = buildWarmTransferScript({ say: 'Briefing body.', acceptUrl });
    const said = [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]);
    expect(said.slice(0, 3)).toEqual([PRESS_PROMPT, 'Briefing body.', PRESS_PROMPT]);
  });

  it('escapes a practice name containing an ampersand instead of emitting broken XML', () => {
    const say = buildPcpTransferBriefing({
      providerInfo: 'Referral desk at Smith & Jones Medical Group',
      reason: 'Records request <urgent>',
    });
    const twiml = buildWarmTransferScript({ say, acceptUrl });

    // A bare & or < is what makes Twilio reject the document.
    const bodies = [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]);
    expect(bodies.join(' ')).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    expect(twiml).toContain('Smith &amp; Jones Medical Group');
    expect(twiml).toContain('&lt;urgent&gt;');

    // And the raw, unescaped text must not survive anywhere in the document.
    expect(twiml).not.toContain('Smith & Jones');
  });

  it('keeps the empty-result gather so silence is recorded, not dropped', () => {
    expect(buildWarmTransferScript({ say: 'x', acceptUrl })).toContain('actionOnEmptyResult="true"');
  });
});

describe('the briefing is escaped exactly once', () => {
  /**
   * Codex round 1 on this PR: the call site pre-escaped the briefing
   * (`escapeXml(briefing.slice(...))`) and buildWarmTransferScript escaped it
   * again, so "Smith & Jones" reached the office as the spoken words
   * "Smith amp; Jones". The pure-builder test above could not see it — the
   * bug lived at the call site. voiceAgentRoutes cannot be imported without
   * a database, so this is a source assertion, with the limits that implies
   * (it proves the source says the right thing, not that it does it): the
   * briefing must reach the builder RAW.
   */
  it('is not pre-escaped before buildWarmTransferScript at the call site', () => {
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const src = readFileSync(join(__dirname, '..', 'voiceAgentRoutes.ts'), 'utf8');
    // lastIndexOf: the first occurrence is the IMPORT line, which sits in a
    // window full of other imports and matches nothing — this assertion
    // itself passed vacuously against the import until the window moved.
    const callSite = src.slice(
      Math.max(0, src.lastIndexOf('buildWarmTransferScript') - 2000),
      src.lastIndexOf('buildWarmTransferScript') + 200,
    );
    expect(callSite).not.toMatch(/say = escapeXml\(/);
    expect(callSite).toMatch(/say = briefing\.slice/);
  });

  it('double-escaping is what the builder would faithfully preserve — the reason the input must be raw', () => {
    const twiml = buildWarmTransferScript({
      say: 'Smith &amp; Jones', // what a pre-escaped briefing looks like
      acceptUrl: 'https://example.test/accept',
    });
    // The builder correctly escapes the literal text it was given — which is
    // exactly why handing it pre-escaped text corrupts what is spoken.
    expect(twiml).toContain('Smith &amp;amp; Jones');
  });
});
