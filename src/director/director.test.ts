/**
 * Director tests. The centrepiece replays the real transcript of call
 * afb1e688 (2026-08-03) turn by turn and asserts the director would have
 * stopped it — the loop guard did not, because it counts asks without knowing
 * the caller already answered, and because a system message is a suggestion
 * this model ignored four more times.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Director,
  askCount,
  classifyAskOrReadback,
  directorEnabledFor,
  extractAnswers,
  formatDob,
  isAffirmative,
  looksSpanish,
  looksForeignToEnglishAndSpanish,
  nameFromAnswer,
} from './director';

let d: Director;
beforeEach(() => {
  d = new Director();
});

describe('classifyAskOrReadback', () => {
  it('catches the date read-backs the production classifier misses', () => {
    // These two were NOT counted by conversationLoopGuard on the real call.
    expect(classifyAskOrReadback("Just to make sure I have it right, that's the fifth month, the fifth day, 1983. Is that correct?")).toBe('date of birth');
    expect(classifyAskOrReadback("Thanks for clarifying. So that's the tenth month, the fifth day, 1983. Is that correct?")).toBe('date of birth');
  });

  it('still catches plain asks', () => {
    expect(classifyAskOrReadback('Can I get your last name and your date of birth?')).toBeTruthy();
    expect(classifyAskOrReadback('Could you please spell your last name for me, letter by letter?')).toBe('last name');
  });

  it('does not classify ordinary conversation as an ask', () => {
    expect(classifyAskOrReadback('You are all set — the office will call you back.')).toBeNull();
    expect(classifyAskOrReadback('Thanks for holding.')).toBeNull();
  });
});

describe('extractAnswers', () => {
  it('banks a spoken date of birth, including corrections', () => {
    expect(extractAnswers('Ferreras, Pedro birth 5/10/1983.')['date of birth']).toBe('1983-05-10');
    expect(extractAnswers('No, October 5th, 1983.')['date of birth']).toBe('1983-10-05');
  });

  it('banks a phone number and a stated name', () => {
    expect(extractAnswers('my number is 555-201-0101')['phone number']).toContain('555');
    expect(extractAnswers('My name is Jane Doe.')['full name']).toBe('Jane Doe');
  });

  it('returns nothing for a non-answer', () => {
    expect(Object.keys(extractAnswers('uh, what?'))).toHaveLength(0);
  });
});

describe('askCount — one question at a time', () => {
  it('counts a bundled ask as more than one', () => {
    expect(askCount('Can I get your last name and your date of birth?')).toBeGreaterThanOrEqual(2);
  });
  it('counts a single ask as one', () => {
    expect(askCount('May I have your last name?')).toBe(1);
  });
});

describe('REGRESSION: call afb1e688 replayed turn by turn', () => {
  const CALL_ID = 'rtc_afb1e688';
  const AGENT = 'azul-scheduling';

  it('stops the date-of-birth loop on the first re-ask, and takes the turn when ignored', () => {
    const actions: string[] = [];
    const agent = (line: string) => {
      const a = d.observeAgent(CALL_ID, AGENT, line);
      if (a) actions.push(`${a.enforcement}:${a.code}:${a.topic}`);
      return a;
    };
    const caller = (line: string) => d.observeCaller(CALL_ID, AGENT, line);

    agent("Thanks for holding. Let's get things going smoothly now. Can I get your last name and your date of birth, please?");
    caller('Ferreras, Pedro birth 5/10/1983.');

    // ONE read-back is allowed — several prompts require it, and firing here
    // produced two false positives on the first live day (2026-08-03).
    expect(agent("Just to make sure I have it right, that's the fifth month, the fifth day, 1983. Is that correct?")).toBeNull();

    caller('No, ten months, first day, 1983.');

    // A SECOND confirmation of a field the caller has now answered twice is
    // the loop starting. Flagged here — at ask #3 of the real call's seven.
    const second = agent("Thanks for clarifying. So that's the tenth month, the fifth day, 1983. Is that correct?");
    expect(second).not.toBeNull();
    expect(second!.code).toBe('reask_answered_field');
    expect(second!.enforcement).toBe('inject');

    caller('Ja.');

    // Ignored → the director stops suggesting and authors the turn.
    const third = agent('Let me double-check. Could you confirm once more: is your date of birth October 5, 1983, or May 10, 1983?');
    expect(third).not.toBeNull();
    expect(third!.enforcement).toBe('author');
    expect(third!.speak).toBeTruthy();

    caller('Ja, October.');

    // Still looping → hard exit rather than a seventh repetition.
    const fourth = agent('Sorry, one more time — what is your date of birth?');
    expect(fourth).not.toBeNull();
    expect(fourth!.enforcement).toBe('force_exit');
    expect(fourth!.speak).toMatch(/circles|someone/i);

    // The real caller endured seven asks and hung up. The director allows one
    // legitimate confirmation, then escalates on every repeat after it —
    // ending the call at ask #5 instead of letting it reach seven.
    expect(actions).toEqual([
      'inject:bundled_questions:bundled',
      'inject:reask_answered_field:date of birth',
      'author:reask_answered_field:date of birth',
      'force_exit:reask_answered_field:date of birth',
    ]);
  });

  it('flags the verbatim "spell your last name" repetition', () => {
    const line = 'Could you please spell your last name for me, letter by letter?';
    d.observeAgent(CALL_ID, AGENT, line);
    d.observeCaller(CALL_ID, AGENT, 'That shit is tripping my mind.');
    const second = d.observeAgent(CALL_ID, AGENT, "Let's double-check the spelling on my end. Could you please spell out your last name letter by letter for me?");
    expect(second).not.toBeNull();
    expect(second!.topic).toBe('last name');
  });

  it('flags the opening bundled question', () => {
    const a = d.observeAgent(CALL_ID, AGENT, 'Can I get your last name and your date of birth, please?');
    expect(a).not.toBeNull();
    expect(a!.code).toBe('bundled_questions');
  });

  it('offers both readings once when the caller has given two different dates', () => {
    d.observeAgent(CALL_ID, AGENT, 'What is your date of birth?');
    d.observeCaller(CALL_ID, AGENT, 'birth 5/10/1983');
    d.observeCaller(CALL_ID, AGENT, 'No, October 5th, 1983');
    // First read-back is free.
    expect(d.observeAgent(CALL_ID, AGENT, 'Is that May 10th, 1983?')).toBeNull();
    d.observeCaller(CALL_ID, AGENT, 'No.');
    // The second is the re-ask; the ambiguity shows up in the authored line
    // once enforcement escalates.
    const a = d.observeAgent(CALL_ID, AGENT, 'So is that October 5th, 1983?');
    expect(a).not.toBeNull();
    expect(a!.text).toMatch(/already gave/i);
  });
});

describe('safety properties', () => {
  it('never fires on a clean, well-run call', () => {
    const id = 'clean';
    expect(d.observeAgent(id, 'answering-service', 'Thanks for calling. How can I help you tonight?')).toBeNull();
    d.observeCaller(id, 'answering-service', 'I need a refill on my eye drops.');
    expect(d.observeAgent(id, 'answering-service', 'May I have your first and last name?')).toBeNull();
    d.observeCaller(id, 'answering-service', 'My name is Jane Doe.');
    expect(d.observeAgent(id, 'answering-service', 'What is the best phone number to reach you?')).toBeNull();
    d.observeCaller(id, 'answering-service', "It's 555-201-0101.");
    expect(d.observeAgent(id, 'answering-service', "You're all set — the office will follow up.")).toBeNull();
  });

  it('is disabled unless the agent is on the allowlist', () => {
    const env = { DIRECTOR_AGENTS: 'azul-scheduling,answering-service' } as NodeJS.ProcessEnv;
    expect(directorEnabledFor('azul-scheduling', env)).toBe(true);
    expect(directorEnabledFor('answering-service', env)).toBe(true);
    expect(directorEnabledFor('no-ivr', env)).toBe(false);
    expect(directorEnabledFor('azul-scheduling', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('never throws, whatever it is fed', () => {
    for (const junk of ['', '?', ' ', 'x'.repeat(5000)]) {
      expect(() => d.observeCaller('j', 'azul-scheduling', junk)).not.toThrow();
      expect(() => d.observeAgent('j', 'azul-scheduling', junk)).not.toThrow();
    }
  });

  it('releases per-call state', () => {
    d.observeCaller('r', 'azul-scheduling', 'My name is Jane Doe.');
    expect(d.answeredFields('r')).toContain('full name');
    d.release('r');
    expect(d.answeredFields('r')).toHaveLength(0);
  });

  it('formats dates the way a person says them', () => {
    expect(formatDob('1983-10-05')).toBe('October 5th, 1983');
    expect(formatDob('1983-05-01')).toBe('May 1st, 1983');
    expect(formatDob('1952-08-22')).toBe('August 22nd, 1952');
  });
});

/**
 * REGRESSION: the three caller-ID name disclosures of 2026-08-03, replayed.
 *
 * Every prompt involved already forbade this. It happened anyway, three times
 * in one hour, on two agents — once naming the WRONG person to an outside
 * pharmacy rep. The prompt is prevention; this is the net under it.
 */
describe('REGRESSION: record-sourced name disclosure (2026-08-03)', () => {
  it('12:35 no-ivr — greets an unverified caller by name before they speak', () => {
    d.seedRecordNames('c1', 'no-ivr', ['Fulvia']);
    const a = d.observeAgent('c1', 'no-ivr', "Hi Fulvia, I see you've called us before. What can I help you with today?");
    expect(a).not.toBeNull();
    expect(a!.code).toBe('record_name_disclosed');
    // First fire INJECTS (changed 2026-08-04). The words already reached the
    // caller's ear either way — `author` cannot un-say them, it can only cancel
    // the agent mid-sentence, which is what a false positive here costs. The
    // escalation ladder still handles an agent that ignores the correction.
    expect(a!.enforcement).toBe('inject');
  });

  it('12:48 no-ivr — DELIBERATELY not caught: "Am I speaking with X?" is sanctioned', () => {
    // This one named the WRONG person to a CenterWell pharmacy rep, and the
    // rule no longer catches it. That is a deliberate trade, not an
    // oversight: excluding the confirm-first question is what stopped the
    // director wrecking 48 real calls between 15:00 and 17:00, and every
    // prompt instructs the pattern on purpose so a known patient is not
    // interrogated from scratch.
    //
    // The residual risk is real and belongs to the practice, not the
    // director: asking "Am I speaking with Mildred?" still tells whoever
    // holds the handset that the number is associated with a Mildred.
    // Closing it means changing the prompts to confirm without naming
    // ("Am I speaking with the patient this number is registered to?"),
    // which is an operator decision.
    d.seedRecordNames('c2', 'no-ivr', ['Mildred']);
    d.observeCaller('c2', 'no-ivr', '9/19/1957');
    const a = d.observeAgent('c2', 'no-ivr', 'Am I speaking with Mildred? And could you confirm your last name as well?');
    expect(a?.code).not.toBe('record_name_disclosed');
  });

  it('11:58 answering-service — volunteers the matched patient by name', () => {
    d.seedRecordNames('c3', 'answering-service', ['Wayne', 'Fabian']);
    d.observeCaller('c3', 'answering-service', "Hi, I'm calling about my mother, Elena Ruiz.");
    const a = d.observeAgent('c3', 'answering-service',
      'It looks like we found records linked to the phone number, but for a different patient, Wayne Fabian.');
    expect(a!.code).toBe('record_name_disclosed');
  });

  it('escalates to a hard exit if the agent keeps using the name', () => {
    d.seedRecordNames('c4', 'no-ivr', ['Fulvia']);
    expect(d.observeAgent('c4', 'no-ivr', 'Hi Fulvia!')!.enforcement).toBe('inject');
    d.observeCaller('c4', 'no-ivr', 'who?');
    // Ignored once → take the turn.
    expect(d.observeAgent('c4', 'no-ivr', 'Fulvia, can you confirm?')!.enforcement).toBe('author');
    d.observeCaller('c4', 'no-ivr', 'I said who?');
    // Ignored twice → end it.
    expect(d.observeAgent('c4', 'no-ivr', 'Fulvia, your file is open.')!.enforcement).toBe('force_exit');
  });

  it('allows the name once the caller has given name AND date of birth', () => {
    d.seedRecordNames('c5', 'azul-scheduling', ['Wayne', 'Fabian']);
    d.observeCaller('c5', 'azul-scheduling', 'My name is Wayne Fabian.');
    d.observeCaller('c5', 'azul-scheduling', 'March 17, 1973.');
    expect(d.observeAgent('c5', 'azul-scheduling', 'Thanks for that, Wayne. What can I do for you?')).toBeNull();
  });

  it('does not guard names too ordinary to be identifiers', () => {
    d.seedRecordNames('c6', 'no-ivr', ['May', 'Bill']);
    expect(d.guardedNames('c6')).toHaveLength(0);
    expect(d.observeAgent('c6', 'no-ivr', 'You may get a bill in the mail.')).toBeNull();
  });
});

describe('FALSE POSITIVES found on the first live day (2026-08-03)', () => {
  it('12:01/12:58 — one confirmation read-back is good practice, not a re-ask', () => {
    d.observeAgent('f1', 'azul-scheduling', "What's your date of birth?");
    d.observeCaller('f1', 'azul-scheduling', '3/17/73');
    expect(d.observeAgent('f1', 'azul-scheduling', 'Just to make sure I have it right, is that March 17, 1973?')).toBeNull();
  });

  it('but a SECOND confirmation of the same field is the loop', () => {
    d.observeAgent('f2', 'azul-scheduling', "What's your date of birth?");
    d.observeCaller('f2', 'azul-scheduling', '3/17/73');
    d.observeAgent('f2', 'azul-scheduling', 'Just to make sure, is that March 17, 1973?');
    d.observeCaller('f2', 'azul-scheduling', 'Yes.');
    expect(d.observeAgent('f2', 'azul-scheduling', 'Let me double-check — is that March 17, 1973?')).not.toBeNull();
  });

  it('a fresh open re-ask still fires immediately — that one is always wrong', () => {
    d.observeCaller('f3', 'azul-scheduling', 'My date of birth is March 17, 1973.');
    const a = d.observeAgent('f3', 'azul-scheduling', 'What is your date of birth?');
    expect(a!.code).toBe('reask_answered_field');
  });

  it('12:01 — "Fabian, March 17, 1973" is not a full name', () => {
    expect(extractAnswers('Fabian, March 17, 1973')['full name']).toBeUndefined();
    expect(extractAnswers('Fabian, March 17, 1973')['date of birth']).toBe('1973-03-17');
    // The real "Surname, Firstname" form still works.
    expect(extractAnswers('Ferreras, Pedro')['full name']).toBe('Ferreras');
  });
});

describe('REGRESSION: appointment detail disclosed before verification (14:24, no-ivr)', () => {
  it('flags an appointment read out to an unidentified caller', () => {
    const a = d.observeAgent('ap1', 'no-ivr',
      'I see you have an upcoming appointment today, on August 3rd, at 8:25 AM in Glendale with Dr. Daniel Choi. Would you like me to confirm that appointment?');
    expect(a).not.toBeNull();
    expect(a!.code).toBe('record_detail_disclosed');
    // Injects on the first fire (changed 2026-08-04) — see the note on
    // record_name_disclosed. It still escalates if the agent keeps going.
    expect(a!.enforcement).toBe('inject');
  });

  it('flags the ABSENCE of an appointment, WITHOUT needing a date', () => {
    // An absence never carries a date. The original version of this test was
    // padded with "Tuesday or otherwise" to satisfy CONCRETE_WHEN, which made
    // the whole branch dead code in production.
    d.observeCaller('ap2', 'no-ivr', 'I wanna cancel my appointment.');
    const a = d.observeAgent('ap2', 'no-ivr',
      "It looks like there's no upcoming appointment currently on record for you.");
    expect(a!.code).toBe('record_detail_disclosed');
    expect(d.observeAgent('ap2b', 'no-ivr', 'You have no upcoming appointments on record.')!.code)
      .toBe('record_detail_disclosed');
  });

  it('does NOT flag offering availability — that reveals nothing about the caller', () => {
    expect(d.observeAgent('ap3', 'azul-scheduling',
      'I could do Tuesday at 9:00 AM, or Thursday at 2:30 PM. Which works better?')).toBeNull();
  });

  it('allows appointment detail once name AND date of birth are established', () => {
    d.observeCaller('ap4', 'no-ivr', 'My name is Jane Doe.');
    d.observeCaller('ap4', 'no-ivr', 'January 9, 1948.');
    expect(d.observeAgent('ap4', 'no-ivr',
      'You have an appointment on August 3rd at 8:25 AM in Glendale.')).toBeNull();
  });
});

/**
 * REGRESSION: the director's own worst hour (2026-08-03 15:00–17:00).
 *
 * The name rule fired on 48 real patient calls at `author` enforcement,
 * cancelling the agent mid-sentence to substitute "Sorry — before we go on,
 * may I get your full name?" — because it could not tell ASKING whether the
 * caller is Elena from ASSERTING that they are. The cure was worse than the
 * disease. These pin the three exclusions that fixed it.
 */
describe('REGRESSION: disclosure rule false positives (2026-08-03 15:00–17:00)', () => {
  it('does NOT fire on the sanctioned confirm-first opener', () => {
    d.seedRecordNames('x1', 'answering-service', ['Elena']);
    expect(d.observeAgent('x1', 'answering-service', 'Am I speaking with Elena?')).toBeNull();
  });

  it('does NOT fire on other interrogative forms of the same question', () => {
    d.seedRecordNames('x2', 'azul-scheduling', ['Monique']);
    expect(d.observeAgent('x2', 'azul-scheduling', 'Is this Monique?')).toBeNull();
  });

  it('does NOT fire when repeating back a name the caller just gave', () => {
    // azul 16:56: fired on "Thanks, Gary Raskin" one turn after the caller
    // said "Gary Raskin, R-A-S-K-I-N".
    d.seedRecordNames('x3', 'azul-scheduling', ['Gary', 'Raskin']);
    d.observeCaller('x3', 'azul-scheduling', 'Gary Raskin, R-A-S-K-I-N');
    expect(d.observeAgent('x3', 'azul-scheduling', 'Thanks, Gary Raskin. Could you share your date of birth?')).toBeNull();
  });

  it('does not fire twice before the caller has had a chance to answer', () => {
    // 17:00: "Sorry — before we go on, may I get your full name?" twice in a row.
    d.seedRecordNames('x4', 'answering-service', ['Fulvia']);
    expect(d.observeAgent('x4', 'answering-service', 'Hi Fulvia!')).not.toBeNull();
    expect(d.observeAgent('x4', 'answering-service', 'Fulvia, are you there?')).toBeNull();
    // Once the caller speaks, the guard is armed again.
    d.observeCaller('x4', 'answering-service', 'What?');
    expect(d.observeAgent('x4', 'answering-service', 'Fulvia, can you hear me?')).not.toBeNull();
  });

  it('STILL catches every assertive leak from the morning', () => {
    const leaks: Array<[string, string, string]> = [
      ['y1', 'Fulvia', "Hi Fulvia, I see you've called us before. What can I help you with today?"],
      ['y2', 'Norma', 'Good morning, Norma. I’m here to help.'],
      ['y3', 'Antone', "Hi Antone, I see you've called us before."],
      ['y4', 'Wilhelmina', "Hi Wilhelmina, I'm glad to hear from you."],
      ['y5', 'Wayne', 'It looks like we found records linked to the phone number, but for a different patient, Wayne Fabian.'],
    ];
    for (const [id, name, line] of leaks) {
      d.seedRecordNames(id, 'no-ivr', [name]);
      const a = d.observeAgent(id, 'no-ivr', line);
      expect(a, line).not.toBeNull();
      expect(a!.code).toBe('record_name_disclosed');
    }
  });
});

/** Codex review, PR #69 — three false-negative/false-positive holes. */
describe('REGRESSION: Codex findings on the disclosure rules (PR #69)', () => {
  it('P1 — an ordinary availability question is not an appointment disclosure', () => {
    // "you have" + a weekday matched, so this cancelled a harmless turn at
    // author enforcement — the same mistake that cost 48 calls.
    expect(d.observeAgent('cx1', 'azul-scheduling', 'Do you have availability Tuesday at 9:00 AM?')).toBeNull();
    expect(d.observeAgent('cx2', 'azul-scheduling', 'Do you have a preference for Monday or Thursday?')).toBeNull();
  });

  it('P1 — a confirm question does not license a disclosure later in the same turn', () => {
    d.seedRecordNames('cx3', 'answering-service', ['Elena']);
    const a = d.observeAgent('cx3', 'answering-service',
      'Am I speaking with Elena? I see you have an appointment Tuesday at 9:00 AM.');
    expect(a).not.toBeNull();
    expect(a!.code).toBe('record_detail_disclosed');
  });

  it('P1 — a name asserted in a later clause is still a disclosure', () => {
    d.seedRecordNames('cx4', 'no-ivr', ['Fulvia']);
    const a = d.observeAgent('cx4', 'no-ivr', 'Am I speaking with the account holder? Fulvia, I have your file open.');
    expect(a!.code).toBe('record_name_disclosed');
  });

  it('P2 — absence phrasings fire without any date present', () => {
    for (const [id, line] of [
      ['cx5', 'You have no upcoming appointments on record.'],
      ['cx6', "I don't see any appointments scheduled for you."],
      ['cx7', "There's nothing on record for you at the moment — no appointments."],
    ] as Array<[string, string]>) {
      expect(d.observeAgent(id, 'no-ivr', line), line).not.toBeNull();
    }
  });
});

/**
 * REGRESSION: 2026-08-04 — the director interrupted callers the SERVER had
 * already verified.
 *
 * 21 of 23 azul calls were touched, zero booked, and the day's transcripts
 * carry patients giving up mid-call ("I hate this", "What the hell do I know?").
 * Cause was not the detector's aim but its source of truth: identityEstablished
 * read only `answered`, which extractAnswers fills from a volunteered "my name
 * is X". The prompts require the agent to collect first and last name in
 * SEPARATE turns, nothing merged them, so 'full name' was unreachable through
 * the sanctioned flow and every later use of the caller's own name scored as a
 * record disclosure.
 */
describe('REGRESSION: verified callers are not interrogated (2026-08-04)', () => {
  it('the tool layer verdict ends the disclosure rule outright', () => {
    d.seedRecordNames('v1', 'azul-scheduling', ['Irma', 'Allen']);
    d.markIdentityVerified('v1', 'azul-scheduling', ['Irma', 'Allen']);
    expect(d.isIdentityVerified('v1')).toBe(true);
    expect(
      d.observeAgent('v1', 'azul-scheduling', 'Thanks for your patience, Irma. How can I assist you today?'),
    ).toBeNull();
    // Appointment detail is theirs to hear too, once the server matched them.
    expect(
      d.observeAgent('v1', 'azul-scheduling', 'I see you have an appointment on August 13 at 10:20 AM.'),
    ).toBeNull();
  });

  it('call 13ecb51d — first + last collected separately establish identity', () => {
    // The exact turn order of the 09:42 call, which fired twice at `author`.
    d.seedRecordNames('v2', 'azul-scheduling', ['Irma', 'Allen']);
    d.observeAgent('v2', 'azul-scheduling', 'Thanks for calling Azul Vision. Am I speaking with Irma?');
    d.observeCaller('v2', 'azul-scheduling', 'Mm-hmm.');
    d.observeAgent('v2', 'azul-scheduling', 'Could you please tell me your last name?');
    d.observeCaller('v2', 'azul-scheduling', 'Allen, A-l-l-e-n');
    d.observeAgent('v2', 'azul-scheduling', 'Thank you. And your date of birth?');
    d.observeCaller('v2', 'azul-scheduling', '11/17/44');
    expect(d.answeredFields('v2')).toContain('full name');
    expect(d.answeredFields('v2')).toContain('date of birth');
    // This is the line that was cancelled mid-sentence, twice.
    expect(
      d.observeAgent('v2', 'azul-scheduling', 'Thanks for your patience, Irma. How can I assist you today?'),
    ).toBeNull();
  });

  it('confirming a caller-ID name with "mm-hmm" claims that name', () => {
    d.seedRecordNames('v3', 'azul-scheduling', ['Vivian']);
    d.observeAgent('v3', 'azul-scheduling', 'Thanks for calling Azul Vision. Am I speaking with Vivian?');
    d.observeCaller('v3', 'azul-scheduling', 'Yes.');
    expect(d.observeAgent('v3', 'azul-scheduling', 'Thanks, Vivian. And your last name?')).toBeNull();
  });

  it('a spelled-only name counts as said — call 458c029c', () => {
    // The caller spelled and never pronounced it, so callerWords held no plain
    // token and the courtesy exemption missed the identifying turn. That call
    // then looped for 228s and never reached the human it opened by asking for.
    d.seedRecordNames('v4', 'azul-scheduling', ['Boutsalee']);
    d.observeCaller('v4', 'azul-scheduling', 'B-O-U-T-S-A-L-E-E');
    expect(
      d.observeAgent('v4', 'azul-scheduling', 'Thank you, Boutsalee. Let me pull that up.'),
    ).toBeNull();
  });

  it('still fires for a caller who has NOT identified themselves', () => {
    // The whole point of the rule survives all of the above.
    d.seedRecordNames('v5', 'azul-scheduling', ['Fulvia']);
    const a = d.observeAgent('v5', 'azul-scheduling', "Hi Fulvia, I see you've called us before.");
    expect(a).not.toBeNull();
    expect(a!.code).toBe('record_name_disclosed');
  });

  it('a shrug never banks a name', () => {
    d.seedRecordNames('v6', 'azul-scheduling', ['Fulvia']);
    d.observeAgent('v6', 'azul-scheduling', 'Could you tell me your last name?');
    d.observeCaller('v6', 'azul-scheduling', 'uh, what?');
    expect(d.answeredFields('v6')).not.toContain('last name');
    expect(d.observeAgent('v6', 'azul-scheduling', 'Fulvia, I have your file open.')!.code)
      .toBe('record_name_disclosed');
  });
});

describe('nameFromAnswer', () => {
  it('reads a bare answer to a name question', () => {
    expect(nameFromAnswer('Allen')).toBe('Allen');
    expect(nameFromAnswer("It's Garcia.")).toBe('Garcia');
    expect(nameFromAnswer('Ramirez')).toBe('Ramirez');
  });

  it('collapses a spelled name', () => {
    expect(nameFromAnswer('Allen, A-l-l-e-n')).toContain('Allen');
    expect(nameFromAnswer('R A S K I N')).toBe('Raskin');
  });

  it('returns null for a non-answer', () => {
    expect(nameFromAnswer('uh, what?')).toBeNull();
    expect(nameFromAnswer('I have no idea')).toBeNull();
    expect(nameFromAnswer('')).toBeNull();
  });
});

describe('isAffirmative', () => {
  it('recognises the ways a caller says yes', () => {
    for (const y of ['Yes.', 'yeah', 'Mm-hmm.', 'mhm', 'uh huh', "That's me", 'Speaking.', 'Correct']) {
      expect(isAffirmative(y), y).toBe(true);
    }
  });
  it('does not treat a refusal or a name as assent', () => {
    for (const n of ['No, no.', 'Ramirez', 'I need to schedule an appointment.']) {
      expect(isAffirmative(n), n).toBe(false);
    }
  });
});

/**
 * REGRESSION: 2026-08-04 — the agent answered a Russian speaker in Spanish.
 *
 * Call ecd0b233, 09:13, dead at 53s having helped nobody. Same shape on
 * 3c07d83a, where one unintelligible token ("Aynı.") sent a whole call into
 * Spanish. The prompt already forbids both ("Any unrecognized or ambiguous
 * utterance stays in English") — which is the point: it is an instruction the
 * model treats as a suggestion, so it needs a deterministic backstop.
 */
describe('REGRESSION: unwarranted language switch (2026-08-04)', () => {
  it('call ecd0b233 — Russian in, Spanish out', () => {
    d.observeCaller('l1', 'azul-scheduling', 'Блядь, дайте поговорить по телефону.');
    const a = d.observeAgent('l1', 'azul-scheduling',
      '¡Claro que sí! Puedo hablar en español. Solo necesito saber quién necesita ayuda.');
    expect(a).not.toBeNull();
    expect(a!.code).toBe('language_switch_unwarranted');
    // Never starts at author — a language misread costs a sentence, not a call.
    expect(a!.enforcement).toBe('inject');
  });

  it('call 3c07d83a — one garbled token is not Spanish', () => {
    d.observeCaller('l2', 'no-ivr', 'Aynı.');
    const a = d.observeAgent('l2', 'no-ivr',
      'Claro, estoy aquí para ayudar. Por favor, cuéntame qué necesitas.');
    expect(a!.code).toBe('language_switch_unwarranted');
  });

  it('does NOT fire when the caller actually spoke Spanish', () => {
    d.observeCaller('l3', 'no-ivr', 'Sí, mire, yo tengo una cita para mañana pero no me siento bien.');
    expect(d.observeAgent('l3', 'no-ivr', 'Claro, vamos a ayudarle con eso. ¿Podría decirme su nombre?')).toBeNull();
  });

  it('does NOT fire when the caller asked for Spanish in English', () => {
    d.observeCaller('l4', 'answering-service', 'Do you speak Spanish?');
    expect(d.observeAgent('l4', 'answering-service', '¡Claro que sí! ¿En qué le puedo ayudar?')).toBeNull();
  });

  it('does NOT fire on garbled ASCII that is plausibly mangled Spanish', () => {
    // "Bon tardis" is a mangled "buenas tardes" — call 88d2c270 switched to
    // Spanish on it and was RIGHT. Transcription garbles Spanish into
    // English-looking ASCII constantly, so "the caller has not demonstrably
    // spoken Spanish" is not a safe trigger. This is the false positive that
    // set the rule's shape: it requires a POSITIVELY foreign script or letter.
    d.observeCaller('l5', 'no-ivr', 'Bon tardis.');
    expect(d.observeAgent('l5', 'no-ivr', 'Buenas tardes. ¿En qué le puedo ayudar hoy?')).toBeNull();
  });

  it('LIMITATION — plain-ASCII nonsense is left to the model', () => {
    // Deliberate. We cannot tell "Hallo?" from a garbled "hola" in a
    // transcript, and the model has the audio. Documented so the next person
    // to widen this rule knows the trade was made on purpose.
    d.observeCaller('l6', 'no-ivr', 'Hallo? Hallo?');
    expect(d.observeAgent('l6', 'no-ivr', '¡Hola! ¿En qué le puedo ayudar?')).toBeNull();
  });

  it('identifies foreign scripts and letters, not Spanish ones', () => {
    expect(looksForeignToEnglishAndSpanish('Блядь, дайте поговорить')).toBe(true);
    expect(looksForeignToEnglishAndSpanish('Aynı.')).toBe(true);
    expect(looksForeignToEnglishAndSpanish('请给我打电话')).toBe(true);
    // Spanish's own accents are NOT foreign.
    expect(looksForeignToEnglishAndSpanish('Sí, mañana. ¿Está bien?')).toBe(false);
    expect(looksForeignToEnglishAndSpanish('Bon tardis.')).toBe(false);
    expect(looksForeignToEnglishAndSpanish('My name is Jerry Perez.')).toBe(false);
  });

  it('does not mistake ordinary English for Spanish', () => {
    for (const line of [
      'Thanks for calling Azul Vision — how can I help you today?',
      'I see you have an appointment on August 13 at 10:20 AM.',
      'No problem, we can do that. Could you tell me your date of birth?',
      'Let me get you to someone on our team who can help.',
    ]) {
      expect(looksSpanish(line), line).toBe(false);
    }
  });

  it('recognises Spanish by inverted punctuation or by two markers', () => {
    expect(looksSpanish('¿Podría decirme su nombre?')).toBe(true);
    expect(looksSpanish('Necesito su fecha de nacimiento')).toBe(true);
  });
});

/**
 * REGRESSION: live call 6bd612c1, 2026-08-04 14:23 — the first
 * language_switch_unwarranted fire in production.
 *
 * It fired CORRECTLY (the caller emitted a CJK glyph mid-call and the agent kept
 * going in Spanish; the injected directive worked — the agent's next turn asked
 * "Would you prefer English or Spanish?", the caller said "Español", and the call
 * resolved). But it should never have been reachable: the caller opened in
 * Spanish, which should have licensed it.
 *
 * `\b` without /u treats an accented vowel as a NON-word character, so `\bque\b`
 * missed "qué" and `\bs[íi]\b` missed "sé". The opening line scored ONE marker
 * instead of three.
 */
describe('REGRESSION: accented Spanish is Spanish (live call 6bd612c1)', () => {
  it('recognises the exact line that was missed', () => {
    expect(looksSpanish('Yo no, no sé por qué no contestan.')).toBe(true);
  });

  it('recognises short accented Spanish generally', () => {
    for (const line of [
      '¿Podría decirme su nombre completo?',
      'Sí, necesito una cita para mañana.',
      'Gracias, ahora entiendo.',
    ]) {
      expect(looksSpanish(line), line).toBe(true);
    }
  });

  it('LIMITATION — recall is deliberately incomplete, and that is safe', () => {
    // "Los encargue unos lentes y no he recibido ninguna respuesta" is Spanish
    // but hits only ONE marker ("unos"). Chasing the rest would mean adding
    // 'los'/'las'/'de'/'y' — which appear in English transcripts ("Los Angeles"
    // is in this very call) and would cost false positives in the expensive
    // direction.
    //
    // It does not matter, and this test records why: licensing is per CALL, not
    // per line. One recognised Spanish line unlocks the whole call, and the rule
    // additionally requires a positively-foreign glyph before it will contradict
    // the agent at all.
    // Two-word utterances cannot clear a two-distinct-marker bar at all
    // ("Ella habla." hits only "habla"), and longer lines can still miss on
    // vocabulary.
    expect(looksSpanish('Ella habla.')).toBe(false);
    expect(looksSpanish('Los encargue unos lentes y no he recibido ninguna respuesta.')).toBe(false);
    d.observeCaller('sp3', 'answering-service', 'Yo no, no sé por qué no contestan.');
    d.observeCaller('sp3', 'answering-service', 'Los encargue unos lentes y no he recibido ninguna respuesta.');
    expect(d.observeAgent('sp3', 'answering-service', '¿Podría decirme su nombre completo?')).toBeNull();
  });

  it('so the caller licenses Spanish and the rule stays quiet', () => {
    d.observeCaller('sp1', 'answering-service', 'Yo no, no sé por qué no contestan.');
    expect(
      d.observeAgent('sp1', 'answering-service',
        'Parece que ha habido algo de demora, lamento mucho la espera.'),
    ).toBeNull();
    // Even after an unintelligible glyph later in the call, Spanish stays licensed.
    d.observeCaller('sp1', 'answering-service', '六');
    expect(
      d.observeAgent('sp1', 'answering-service',
        'Entiendo, por favor disculpe la confusión. ¿Me podría decir su nombre completo?'),
    ).toBeNull();
  });

  it('still fires when the caller never spoke Spanish at all', () => {
    d.observeCaller('sp2', 'answering-service', 'Блядь, дайте поговорить по телефону.');
    const a = d.observeAgent('sp2', 'answering-service',
      '¡Claro que sí! Puedo hablar en español.');
    expect(a!.code).toBe('language_switch_unwarranted');
  });

  it('does not mistake ordinary English for Spanish after normalisation', () => {
    for (const line of [
      'Thanks for calling Azul Vision — how can I help you today?',
      'I see you have an appointment on August 13 at 10:20 AM.',
      "No problem, we can do that. Could you tell me your date of birth?",
      'Let me get you to someone on our team who can help.',
      'Is that correct? Just to make sure I have it right.',
      'I have Monday, August 10 at 09:30 AM with Ashlynne Kim at Encinitas.',
      "Sorry, I wasn't able to reach them directly. Our team will call you back.",
    ]) {
      expect(looksSpanish(line), line).toBe(false);
    }
  });
});
