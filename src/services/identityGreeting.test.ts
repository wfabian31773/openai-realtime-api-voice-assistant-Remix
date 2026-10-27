import { describe, expect, it } from 'vitest';
import { personaliseGreeting, recognisedFirstName } from './greetingPersonalisation';

describe('VA-76205: greeting identity', () => {
  it('keeps a phone candidate out of the spoken greeting', () => {
    const greeting = 'Thank you for calling. How can I help you today?';
    const name = recognisedFirstName({ matched: true, firstName: 'Alex' });
    expect(name).toBe('');
    expect(personaliseGreeting(greeting, name, 'append')).toBe(greeting);
  });
  it('allows a name only after explicit validation', () => {
    expect(recognisedFirstName({ matched: true, firstName: 'Alex', identityValidated: true })).toBe('Alex');
  });
});
