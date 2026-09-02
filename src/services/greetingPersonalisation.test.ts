import { describe, it, expect } from 'vitest';
import {
  personaliseGreeting,
  stripTrailingQuestion,
  greetingStyleFor,
  missingMandatoryCopy,
  lunchGreetingFor,
} from './greetingPersonalisation';

const SURGERY =
  'Thank you for calling Azul Vision surgery coordination. All of our coordinators are ' +
  'currently assisting other patients, but I can take a message and they will follow up ' +
  'with you. How can I help you today?';

describe('a recognised caller hears exactly one opening', () => {
  it('never leaves two questions back to back', () => {
    // The whole point. Two questions in one breath is what the model was
    // resolving by cutting itself off mid-greeting.
    for (const greeting of [
      SURGERY,
      'Thank you for calling. How may I assist you?',
      'Azul Vision optical, what can I do for you?',
      'Good afternoon. Are you calling about an appointment?',
    ]) {
      const out = personaliseGreeting(greeting, 'Wayne', 'append');
      expect(
        (out.match(/\?/g) ?? []).length,
        `two questions in: ${out}`,
      ).toBe(1);
      expect(out.endsWith('Am I speaking with Wayne?')).toBe(true);
    }
  });

  it('keeps the cannot-transfer framing that the queue greeting exists for', () => {
    const out = personaliseGreeting(SURGERY, 'Wayne', 'append');
    expect(out).toContain('currently assisting other patients');
    expect(out).toContain('I can take a message');
    expect(out).not.toContain('How can I help you today');
  });
});

describe('the strip does not depend on one hardcoded phrase', () => {
  // The defect Codex caught on #178: `welcome_greeting` is admin-editable and
  // outranks the configured string, so keying on "How can I help you today?"
  // meant any edit silently disabled the personalisation.
  const CUSTOMISED = [
    ['... they will follow up with you. How may I assist you?', '... they will follow up with you.'],
    ['... follow up with you. What can I do for you today?', '... follow up with you.'],
    ['... follow up with you. How can I help?', '... follow up with you.'],
    ['Thank you for calling Azul Vision.', 'Thank you for calling Azul Vision.'],
    ['Thanks for calling! Please hold.', 'Thanks for calling! Please hold.'],
  ] as const;

  for (const [input, expected] of CUSTOMISED) {
    it(`strips the trailing question from "${input.slice(0, 40)}…"`, () => {
      expect(stripTrailingQuestion(input)).toBe(expected);
    });
  }

  it('leaves nothing behind when the greeting is entirely one question', () => {
    expect(stripTrailingQuestion('How can I help you today?')).toBe('');
    expect(personaliseGreeting('How can I help you today?', 'Wayne', 'append')).toBe(
      'Am I speaking with Wayne?',
    );
  });
});

describe('what it refuses to change', () => {
  it('returns the greeting untouched when no one was recognised', () => {
    expect(personaliseGreeting(SURGERY, '', 'append')).toBe(SURGERY);
    expect(personaliseGreeting(SURGERY, '   ', 'append')).toBe(SURGERY);
  });

  it('leaves an empty greeting empty — listen-first is a deliberate state', () => {
    expect(personaliseGreeting('', 'Wayne', 'append')).toBe('');
  });
});

describe('which lines append, which replace, and which are left alone', () => {
  it('appends for the queue lines, because their greeting carries a promise', () => {
    expect(greetingStyleFor('optical')).toBe('append');
    expect(greetingStyleFor('surgery')).toBe('append');
    expect(greetingStyleFor('tech')).toBe('append');
    expect(greetingStyleFor('records')).toBe('append');
  });

  it('appends for the answering service, whose prompt is certain it did', () => {
    // "YOUR GREETING HAS ALREADY PLAYED... Go straight to the confirmation."
    // Its greeting is the same shape as a queue line's — it pre-empts the ask
    // for a human — but comma-joined throughout, which is why the strip needed
    // a comma boundary before this slug could be added. Codex, #240.
    const AS =
      'Hello, thank you for calling Azul Vision, all of our operators are ' +
      'currently on the phone assisting other patients, how may I help you today?';
    expect(greetingStyleFor('answering-service')).toBe('append');
    expect(personaliseGreeting(AS, 'Wayne', greetingStyleFor('answering-service'))).toBe(
      'Hello, thank you for calling Azul Vision, all of our operators are ' +
        'currently on the phone assisting other patients. Am I speaking with Wayne?',
    );
  });

  it('replaces on azul-scheduling, the one line that has always replaced', () => {
    expect(greetingStyleFor('azul-scheduling')).toBe('replace');
    expect(personaliseGreeting(SURGERY, 'Wayne', 'replace')).toBe(
      'Hello, thank you for calling Azul Vision. Am I speaking with Wayne?',
    );
  });

  it('personalises nothing on a line nobody has cleared for it', () => {
    // The default is verbatim, not 'replace'. Under the old default the voice
    // runtime — which fetches pre-context on EVERY lane, unlike the SIP path —
    // would have rewritten these openings the first time it recognised a
    // caller. Codex, #240.
    expect(greetingStyleFor('no-ivr')).toBeNull();
    expect(greetingStyleFor('pcp')).toBeNull();
    expect(greetingStyleFor('after-hours')).toBeNull();
    expect(greetingStyleFor(undefined)).toBeNull();
    expect(greetingStyleFor('')).toBeNull();
  });
});

describe('the after-hours greeting reaches the caller whole', () => {
  // noIvrAgent's own pre-context block: "YOUR GREETING IS NOT OPTIONAL AND
  // MUST NOT BE SHORTENED... DO NOT open with a name confirmation", citing
  // 2026-08-01 12:21 UTC, when it was cut off after "Thank you for calling"
  // and a caller was never told to dial 911 nor that the call was recorded.
  // The forced greeting is the one place the model cannot decline, so a
  // rewrite here is not a nudge — it is the incident, reproduced on purpose.
  const NO_IVR =
    'Thank you for calling Azul Vision, all of our offices are currently closed, you have ' +
    'reached the after hours call service. If this is a medical emergency, please dial 911. ' +
    'All calls are being recorded for quality assurance purposes, how can I help you?';

  it('says it verbatim to a recognised caller', () => {
    const out = personaliseGreeting(NO_IVR, 'Wayne', greetingStyleFor('no-ivr'));
    expect(out).toBe(NO_IVR);
    expect(out).toContain('dial 911');
    expect(out).toContain('being recorded');
    expect(out).toContain('currently closed');
    expect(out).not.toContain('Am I speaking with');
  });

  it('would lose the recording disclosure even to an append, which is why it is not appended', () => {
    // Not a rule being asserted — the reason the rule cannot be "append
    // everywhere instead of replace". The disclosure shares its sentence with
    // the trailing question, so stripping the question strips the disclosure.
    expect(stripTrailingQuestion(NO_IVR)).not.toContain('being recorded');
    expect(stripTrailingQuestion(NO_IVR)).toContain('dial 911');
  });

  it("keeps PCP's opening question, which is how PCP captures the call purpose", () => {
    // pcpAgent: "Your greeting already asked... you are RECORDING what they
    // just said." Replace it and the purpose on record is the caller's "yes".
    const PCP = 'Thank you for calling Azul Vision PCP Support. How can I help you today?';
    expect(personaliseGreeting(PCP, 'Wayne', greetingStyleFor('pcp'))).toBe(PCP);
  });
});

describe('copy a lane must say whatever the database holds', () => {
  // Not hypothetical: on 2026-08-31 the LIVE no-ivr row carried 911 and the
  // closed-office notice but no recording disclosure, while the code's
  // version had all three. Letting the configured greeting outrank the
  // registry — which is correct in general — would have taken the
  // disclosure off the runtime too. Codex, #240.
  const LIVE_ROW =
    'Thank you for calling Azul Vision. Our offices are currently closed. If this is a ' +
    "medical emergency, please hang up and dial 911. Otherwise, I'm happy to help — how " +
    'may I assist you?';
  const BUILT_IN =
    'Thank you for calling Azul Vision, all of our offices are currently closed, you have ' +
    'reached the after hours call service. If this is a medical emergency, please dial 911. ' +
    'All calls are being recorded for quality assurance purposes, how can I help you?';

  it('spots the disclosure missing from the greeting that is live today', () => {
    expect(missingMandatoryCopy('no-ivr', LIVE_ROW)).toEqual(['recording disclosure']);
  });

  it('passes the built-in greeting, which carries both', () => {
    expect(missingMandatoryCopy('no-ivr', BUILT_IN)).toEqual([]);
  });

  it('names every statement a greeting has dropped', () => {
    expect(missingMandatoryCopy('no-ivr', 'Thanks for calling, how can I help?')).toEqual([
      'closed-office notice',
      '911 direction',
      'recording disclosure',
    ]);
  });

  it('catches a greeting that has only lost the closed-office notice', () => {
    // The case the first version of this validator let through: it checked
    // 911 and recording only, so this passed and outranked the complete
    // built-in greeting, taking the line's after-hours status off every
    // call. Codex, #240.
    expect(
      missingMandatoryCopy('no-ivr', 'For emergencies dial 911. Calls are recorded. How can I help?'),
    ).toEqual(['closed-office notice']);
  });

  it('requires nothing of a lane with no mandated copy', () => {
    // Deliberately narrow. Every other line's wording is the operator's.
    expect(missingMandatoryCopy('optical', 'Thanks for calling!')).toEqual([]);
    expect(missingMandatoryCopy('pcp', '')).toEqual([]);
    expect(missingMandatoryCopy(undefined, '')).toEqual([]);
  });

  it('treats an empty or absent greeting as missing everything', () => {
    expect(missingMandatoryCopy('no-ivr', '')).toHaveLength(3);
    expect(missingMandatoryCopy('no-ivr', null)).toHaveLength(3);
  });
});

describe('lunchGreetingFor — the lunch hour is not after hours', () => {
  const WEEKDAY_NOON = { hour: 12, shortDay: 'Tue' };

  /**
   * Operator, 2026-09-01: "no-ivr callers are any hours outside of business
   * hours — a 7am call is no-ivr, our offices are still closed. If it is
   * during lunch, our offices are closed between 12-1, so that should be
   * said." A caller at 12:30 is not an after-hours caller and must not be
   * told they have reached the after-hours service.
   */
  it('returns the lunch greeting on a weekday at noon', () => {
    const g = lunchGreetingFor('no-ivr', WEEKDAY_NOON);
    expect(g).toBeTruthy();
    expect(g).toMatch(/closed for lunch between twelve and one/i);
    expect(g).not.toMatch(/after hours/i);
  });

  it('says nothing about lunch at 7am, which really is after hours', () => {
    expect(lunchGreetingFor('no-ivr', { hour: 7, shortDay: 'Tue' })).toBeNull();
  });

  it('does not treat a weekend noon as lunch — that is just closed', () => {
    expect(lunchGreetingFor('no-ivr', { hour: 12, shortDay: 'Sat' })).toBeNull();
    expect(lunchGreetingFor('no-ivr', { hour: 12, shortDay: 'Sun' })).toBeNull();
  });

  it('is scoped to the lane that has legally-shaped copy', () => {
    expect(lunchGreetingFor('optical', WEEKDAY_NOON)).toBeNull();
    expect(lunchGreetingFor('surgery', WEEKDAY_NOON)).toBeNull();
    expect(lunchGreetingFor(undefined, WEEKDAY_NOON)).toBeNull();
  });

  /**
   * The whole reason this is a separate constant rather than surgery on the
   * configured string: an alternative greeting is another place the three
   * mandatory statements can go missing. It is checked by the same rule the
   * database row is checked by.
   */
  it('carries the closed notice, the 911 direction and the recording disclosure', () => {
    const g = lunchGreetingFor('no-ivr', WEEKDAY_NOON);
    expect(missingMandatoryCopy('no-ivr', g)).toEqual([]);
  });
});


/**
 * THE FALLBACK ITSELF HAS TO BE COMPLIANT — Codex, PR #244.
 *
 * When the database row fails the mandatory-copy check, `voiceAgentRoutes`
 * falls back to `WELCOME_GREETING`, the registry string this line has always
 * used. That is only safe while the string carries all three phrases, and the
 * string lives in another file that nothing stopped anyone editing. This is
 * what stops it quietly ceasing to be a safe fallback.
 *
 * The failure it guards is specific: metadata is lost when a webhook lands on
 * a different instance (diagnosed 2026-08-06, four live SD calls), and if the
 * database row is also bad there is nothing left to say. The check further
 * down voiceAgentRoutes then falls through to a bare `response.create` and the
 * model opens the call itself — which is how the recording disclosure went
 * missing to begin with.
 */
describe('the greeting used when the database row is rejected', () => {
  it('carries every phrase the lane is required to say', async () => {
    // Read as text rather than imported: `afterHoursAgent` pulls in the whole
    // agent module and, through it, the database. The string is what matters,
    // and this still fails the moment somebody edits it.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../agents/afterHoursAgent.ts', import.meta.url), 'utf8');
    const literal = /return\s+"([^"]+)";/.exec(
      src.slice(src.indexOf('function getUrgentTriageGreeting')),
    );
    expect(literal, 'could not find the greeting literal').toBeTruthy();
    expect(missingMandatoryCopy('no-ivr', literal![1])).toEqual([]);
  });

  it('and the lunch greeting does too, since it replaces the same opening', async () => {
    const lunch = lunchGreetingFor('no-ivr', { hour: 12, shortDay: 'Mon' });
    expect(lunch).toBeTruthy();
    expect(missingMandatoryCopy('no-ivr', lunch)).toEqual([]);
  });
});


/**
 * A DISCLOSURE THAT SAYS THE OPPOSITE STILL CONTAINS THE KEYWORD — Codex, #244.
 *
 * These predicates were bare keyword tests, and this check is the compliance
 * boundary for a field an admin can edit. "Calls are not being recorded" would
 * have reported the recording disclosure as present, and the row would have
 * outranked the known-safe code greeting on a line that records from start.
 *
 * The second half of this block matters as much as the first: a negation test
 * that is too loose rejects legitimate wording, and a rejected row falls back
 * to the code greeting with only a log line — an operator edit that returns
 * success and changes nothing, which is this repo's other recurring failure.
 */
describe('the mandatory copy has to be affirmative', () => {
  const COMPLIANT =
    'Thank you for calling Azul Vision, all of our offices are currently closed. ' +
    'If this is a medical emergency, please dial 911. All calls are being recorded ' +
    'for quality assurance purposes, how can I help you?';

  it('accepts the real greeting', () => {
    expect(missingMandatoryCopy('no-ivr', COMPLIANT)).toEqual([]);
  });

  it('rejects each phrase turned on its head', () => {
    expect(missingMandatoryCopy('no-ivr', COMPLIANT.replace('are currently closed', 'are not closed')))
      .toEqual(['closed-office notice']);
    expect(missingMandatoryCopy('no-ivr', COMPLIANT.replace('please dial 911', 'please do not dial 911')))
      .toEqual(['911 direction']);
    expect(missingMandatoryCopy('no-ivr', COMPLIANT.replace('are being recorded', 'are not being recorded')))
      .toEqual(['recording disclosure']);
  });

  it('does not reject an innocent "not" that belongs to another clause', () => {
    // A real way to word this line. The negation attaches to "an emergency",
    // not to dialling 911, and the greeting is entirely compliant.
    const legitimate =
      'Thank you for calling Azul Vision, our offices are closed. If this is not an ' +
      'emergency I can take a message; if it is a medical emergency, please dial 911. ' +
      'All calls are being recorded for quality assurance purposes.';
    expect(missingMandatoryCopy('no-ivr', legitimate)).toEqual([]);
  });

  /**
   * ROUND FIVE, one step narrower than round four: a negation that matches only
   * the literal word `not` still lets "calls aren't being recorded" through.
   * An admin typing into a web form writes contractions, and gets whichever
   * apostrophe their keyboard produces.
   */
  it('rejects the contracted forms too', () => {
    for (const negated of [
      "Calls aren't being recorded",
      'Calls aren\u2019t being recorded',
      'Calls are never recorded',
    ]) {
      expect(
        missingMandatoryCopy('no-ivr', COMPLIANT.replace('All calls are being recorded', negated)),
        negated,
      ).toEqual(['recording disclosure']);
    }
    expect(missingMandatoryCopy('no-ivr', COMPLIANT.replace("are currently closed", "aren't closed")))
      .toEqual(['closed-office notice']);
  });

  it('does not reject a contraction that belongs to another clause', () => {
    // The over-tightening guard, in contracted form. "don't hesitate" has
    // nothing to do with the recording disclosure that follows it.
    const legitimate =
      "Thank you for calling Azul Vision, our offices are closed. If this is a medical " +
      "emergency, please dial 911. Please don't hesitate to leave a message — all calls " +
      'are being recorded for quality assurance purposes.';
    expect(missingMandatoryCopy('no-ivr', legitimate)).toEqual([]);
  });

  it('still catches a phrase that is simply absent', () => {
    // The failure that actually happened on 2026-08-31: the disclosure was not
    // negated, it was gone.
    // The clause ends in a comma, not a full stop — the first version of this
    // test removed nothing and passed for the wrong reason.
    const withoutDisclosure = COMPLIANT.replace(
      'All calls are being recorded for quality assurance purposes, ',
      '',
    );
    expect(withoutDisclosure).not.toMatch(/record/i);
    expect(missingMandatoryCopy('no-ivr', withoutDisclosure)).toEqual(['recording disclosure']);
  });
});

/**
 * THE NUMBER IS NOT THE DIRECTION — Codex, PR #244, round seven.
 *
 * The check required `\b911\b` and then subtracted a fixed list of negations.
 * That shape accepts anything containing the token unless a reversal is
 * recognised, so "911 is not available" and "please don't use 911" both
 * passed: neither contains `dial|call|contact|phone`, so neither could be
 * caught by negating those verbs. Chasing it with more negations is unbounded,
 * and every phrasing nobody anticipated is a false accept — which here means
 * an emergency caller is never told where to go, on the line that carries
 * every overnight call.
 *
 * Inverted to state what the clause must SAY. Both live greetings satisfy it.
 */
describe('the 911 clause has to direct someone to 911', () => {
  const base = 'Thank you for calling Azul Vision. Our offices are currently closed. ';
  const tail = ' All calls are being recorded for quality assurance purposes.';
  const check = (g: string) => missingMandatoryCopy('no-ivr', g);

  it('accepts the registry greeting', () => {
    expect(check(base + 'If this is a medical emergency, please dial 911.' + tail)).toEqual([]);
  });

  it('accepts the live database row, which words it differently', () => {
    // "please hang up and dial 911" — read out of agents.welcome_greeting.
    expect(check(base + 'If this is a medical emergency, please hang up and dial 911.' + tail)).toEqual([]);
  });

  it.each([
    ['911 is not available',      'the token with no direction at all'],
    ['please don\'t use 911',      'a reversal the old verb list could not see'],
    ['do not dial 911',           'the plain negation'],
    ['for emergencies, 911',      'the number offered without telling anyone to use it'],
  ])('rejects "%s" — %s', (clause) => {
    expect(check(base + clause + '.' + tail)).toContain('911 direction');
  });

  it('does NOT catch a direction talked out of at a distance, and that is the limit', () => {
    // "there is no reason to contact 911" contains an affirmative "contact
    // 911", and the negator is not adjacent to it, so this passes. Recorded
    // rather than hidden: the check is a guard on operator-authored text, not
    // a general reader of intent, and the alternative is the unbounded
    // negation-chasing this inversion was meant to end.
    //
    // What bounds the risk is that the rejected path is the SAFE one — a
    // greeting that fails falls back to the compliant code string. The failure
    // mode left here needs someone to deliberately write a compliant-looking
    // sentence that means the opposite, which is a different problem from the
    // accidental omission this was built for.
    expect(check(base + 'there is no reason to contact 911.' + tail)).toEqual([]);
  });

  it('still rejects a greeting that never mentions 911 at all', () => {
    expect(check(base + 'How can I help you?' + tail)).toContain('911 direction');
  });
});

/**
 * "CANNOT" IS A NEGATION — Codex, PR #244 round ten, and one more it did not name.
 *
 * `\bnot\b` cannot match the `not` inside `cannot`, so "calls cannot be
 * recorded" and "you cannot call 911 from this line" both read as compliant.
 *
 * Checking that against the live wording turned up a SECOND hole in the same
 * line: **"calls can not be recorded" also passed**, and there the negator
 * matches perfectly well. What failed was the phrase — it allowed "being
 * recorded" but not "be recorded", so nothing lined up after the negator. One
 * fix, `cannot` plus an optional copula, closes both; fixing only what was
 * reported would have left the two-word form live.
 */
describe('cannot, and the copula that hid beside it', () => {
  const base = 'Thank you for calling Azul Vision. Our offices are currently closed. ';
  const emerg = 'If this is a medical emergency, please dial 911. ';
  const rec = 'All calls are being recorded for quality assurance purposes.';
  const check = (g: string) => missingMandatoryCopy('no-ivr', g);

  it.each([
    'Calls cannot be recorded',
    'Calls can not be recorded',
    'Calls cannot be recorded on this line',
  ])('rejects the recording disclosure reversed by "%s"', (clause) => {
    expect(check(base + emerg + clause + '.')).toContain('recording disclosure');
  });

  it.each([
    'You cannot call 911 from this line',
    'You can not dial 911 from here',
  ])('rejects the 911 direction reversed by "%s"', (clause) => {
    expect(check(base + clause + '. ' + rec)).toContain('911 direction');
  });

  it('rejects a closed-office notice reversed with cannot', () => {
    expect(
      check('Thank you for calling. Our offices cannot be closed. ' + emerg + rec),
    ).toContain('closed-office notice');
  });

  it('still accepts both live greetings unchanged', () => {
    // The registry string and the agents.welcome_greeting row. A guard that is
    // too tight rejects the row and falls back silently, which is an operator
    // edit that returns success and changes nothing.
    expect(check(base + emerg + rec)).toEqual([]);
    expect(
      check('Thank you for calling Azul Vision. Our offices are currently closed. '
        + 'If this is a medical emergency, please hang up and dial 911. ' + rec),
    ).toEqual([]);
  });

  it('does not treat a copula as licence to reach across the sentence', () => {
    // The negator plus ONE short auxiliary, not arbitrary distance. "not an
    // emergency" keeps its `not`, so the 911 direction beside it still counts.
    expect(
      check('Thank you for calling. Our offices are currently closed. '
        + 'If this is not an emergency I can take a message; if it is a medical emergency, please dial 911. '
        + rec),
    ).toEqual([]);
  });
});
