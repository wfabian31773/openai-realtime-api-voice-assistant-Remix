import { describe, expect, it } from 'vitest';
import { personaliseGreeting, recognisedFirstName } from './greetingPersonalisation';

/**
 * VA-76205 (#384) took the name out of the greeting for an unvalidated
 * caller-ID match. v170 puts it back (operator, 2026-11-03: a hard rule): the
 * greeting's question is how a candidate is validated, and nothing private is
 * said. The ticket-side half of #384 is untouched and has its own tests.
 */
describe('VA-76205 reversed: the greeting asks the candidate by first name', () => {
  it('a phone candidate is asked "Am I speaking with <name>?"', () => {
    const greeting = 'Thank you for calling. How can I help you today?';
    const name = recognisedFirstName({ matched: true, firstName: 'Alex' });
    expect(name).toBe('Alex');
    expect(personaliseGreeting(greeting, name, 'append')).toBe('Thank you for calling. Am I speaking with Alex?');
  });
  it('a validated match is named as before', () => {
    expect(recognisedFirstName({ matched: true, firstName: 'Alex', identityValidated: true })).toBe('Alex');
  });
  it('no match keeps the generic greeting', () => {
    const greeting = 'Thank you for calling. How can I help you today?';
    expect(personaliseGreeting(greeting, recognisedFirstName({ matched: false, firstName: 'Alex' }), 'append')).toBe(
      greeting,
    );
  });
});
