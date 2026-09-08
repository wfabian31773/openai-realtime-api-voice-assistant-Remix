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

  it('names the caller — the field the office was never given', () => {
    /**
     * Added 2026-09-08. `callerName` was not on `PcpBriefingDetails` at all, so
     * the one thing a staffer needs first — who am I about to speak to — was
     * the one thing never sent. The operator named it first of three when
     * asked what a transfer must carry.
     */
    const briefing = buildPcpTransferBriefing({
      callerName: 'Dr Joseph Perez',
      providerInfo: 'Primary care provider, De La Pena Family Medicine',
      reason: 'Records for a mutual patient',
    });

    expect(briefing).toContain('Caller: Dr Joseph Perez.');
  });

  it('speaks no empty labels, and no placeholder text', () => {
    /**
     * THE LIVE DEFECT, 2026-09-08. `pcpAgent` built providerInfo as a template
     * literal over two optional fields, and a template literal stringifies
     * `undefined` — so a caller who said only "representative" produced
     * "undefined, undefined", which is a non-empty string, therefore truthy,
     * therefore straight past the `? :` guard and into a staffer's ear as
     * "Caller organization and role: undefined, undefined."
     *
     * Fixed at the source too. This is the floor: four different agents write
     * this field and this builder is the last thing before a person hears it.
     */
    const briefing = buildPcpTransferBriefing({ providerInfo: 'undefined, undefined', reason: undefined });

    expect(briefing.toLowerCase()).not.toContain('undefined');
    expect(briefing).not.toContain('Caller organization and role:');
    // A half-known value keeps the half that is real, and drops the rest.
    expect(buildPcpTransferBriefing({ providerInfo: 'undefined, Optum' })).toContain(
      'Caller organization and role: Optum.',
    );
  });

  it('keeps a caller actually named Nan', () => {
    /**
     * Codex P2, PR #273. The placeholder filter listed `nan` case-insensitively
     * to catch JavaScript's NaN — and **Nan is a name**, short for Nancy. She
     * would have been discarded and the office told she gave no name, which is
     * the exact failure this filter exists to prevent, aimed at a real person
     * instead of a stringified `undefined`.
     *
     * Nothing on this path interpolates a NUMBER, so `NaN` was never reachable
     * here: it was defensiveness against a case that does not exist, paid for
     * with somebody's name. The list is now the two tokens that can actually
     * arise — `undefined` and `null`.
     */
    const briefing = buildPcpTransferBriefing({ callerName: 'Nan', providerInfo: 'Referral coordinator, Optum' });

    expect(briefing).toContain('Caller: Nan.');
    expect(briefing).not.toMatch(/did not give a name/);
  });

  it('still drops the tokens that a missing value really does produce', () => {
    expect(buildPcpTransferBriefing({ callerName: 'undefined' })).toMatch(/did not give a name/);
    expect(buildPcpTransferBriefing({ callerName: 'null' })).toMatch(/did not give a name/);
  });

  it('when it knows nothing, it says so and hands over — it does not go quiet', () => {
    /**
     * REPLACES an assertion that the empty briefing is the bare header.
     *
     * That was deliberate once — "omit what you do not have" — and it is the
     * wrong default here. Operator, 2026-09-08: "if someone just says, you
     * know, representative, you don't know, you... how can you warm transfer?"
     * A briefing that omits every unknown is indistinguishable from one that
     * was never built, so the staffer accepts a caller with no idea they are
     * starting from zero. The empty-label rule is still kept — the test above
     * — but silence is not the way to keep it.
     */
    for (const empty of [{}, { callerName: null, providerInfo: null, reason: null }]) {
      const briefing = buildPcpTransferBriefing(empty);
      expect(briefing).toContain('did not give a name');
      expect(briefing, 'tell them to start by asking').toMatch(/asking who they are and what they need/);
    }
  });

  it('a reason without an identity STILL hands over — the reason is often just the ask', () => {
    /**
     * REPLACES an assertion that any known field suppressed the handover line.
     *
     * On the live path `reason` is the handoff narrative and `handoff_to_pcp`
     * requires one, so it is ALWAYS set — an all-three-absent condition is
     * unreachable from the agent and the sentence would only ever have fired
     * from a direct builder call like this one. And on a bare ask the
     * narrative IS the ask ("Caller asked to speak to a representative"), so
     * the briefing reads as though it carries a reason while telling the
     * staffer nothing about who is on the phone. That is the case the sentence
     * exists for, not the case it should skip.
     *
     * So the condition is IDENTITY: no name and no role/organisation.
     */
    const briefing = buildPcpTransferBriefing({ reason: 'Caller asked to speak to a representative' });

    expect(briefing).toMatch(/asking who they are and what they need/);
  });

  it('but once we know who they are, the office is not told to start from zero', () => {
    const known = buildPcpTransferBriefing({
      providerInfo: 'Care coordinator at Optum Clinic',
      reason: 'Prior authorization for a retinal exam',
    });

    expect(known).toContain('Prior authorization for a retinal exam');
    expect(known, 'they have what they need').not.toMatch(/asking who they are and what they need/);
    // A name alone is enough to place the caller, too.
    expect(buildPcpTransferBriefing({ callerName: 'Dr Perez', reason: 'Records' })).not.toMatch(
      /asking who they are and what they need/,
    );
  });

  it('does not stumble over a narrative that already ends in a full stop', () => {
    // "…to speak to a representative.." — spoken aloud to a staffer.
    const briefing = buildPcpTransferBriefing({ reason: 'Caller asked to speak to a representative.' });

    expect(briefing).not.toContain('..');
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
