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
