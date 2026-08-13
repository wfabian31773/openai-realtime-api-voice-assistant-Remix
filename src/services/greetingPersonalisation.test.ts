import { describe, it, expect } from 'vitest';
import {
  personaliseGreeting,
  stripTrailingQuestion,
  greetingStyleFor,
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

describe('which lines append and which replace', () => {
  it('appends for the queue lines, because their greeting carries a promise', () => {
    expect(greetingStyleFor('optical')).toBe('append');
    expect(greetingStyleFor('surgery')).toBe('append');
  });

  it('replaces everywhere else, preserving azul-scheduling behaviour', () => {
    expect(greetingStyleFor('azul-scheduling')).toBe('replace');
    expect(greetingStyleFor(undefined)).toBe('replace');
    expect(personaliseGreeting(SURGERY, 'Wayne', 'replace')).toBe(
      'Hello, thank you for calling Azul Vision. Am I speaking with Wayne?',
    );
  });
});
