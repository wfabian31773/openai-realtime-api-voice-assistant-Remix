import { describe, it, expect } from 'vitest';
import { directionFor, withToolDirection, releaseDirectionState, acknowledgeDayMismatch } from './toolDirection';

describe('toolDirection', () => {
  it('appends the approved filed line on ticket success (answering service)', async () => {
    const exec = withToolDirection('answering-service', 'call1', 'create_ticket', async () => 'VA-1700000000000-456');
    const out = (await exec()) as string;
    expect(out).toContain('VA-1700000000000-456');
    expect(out).toContain("You're all set");
  });

  it('first error directs a silent retry; second error directs the noted line', () => {
    releaseDirectionState('call2');
    const d1 = directionFor('answering-service', 'create_ticket', 'ERROR: timeout', 'call2')!;
    expect(d1).toContain('Silently call create_ticket again ONCE');
    const d2 = directionFor('answering-service', 'create_ticket', 'ERROR: timeout', 'call2')!;
    expect(d2).toContain("I've noted everything");
  });

  it('success resets the attempt counter', () => {
    releaseDirectionState('call3');
    directionFor('pcp', 'create_ticket', 'ERROR: x', 'call3');
    directionFor('pcp', 'create_ticket', 'VA-1', 'call3');
    const d = directionFor('pcp', 'create_ticket', 'ERROR: y', 'call3')!;
    expect(d).toContain('Silently');
  });

  it('unknown tools pass through untouched', async () => {
    const exec = withToolDirection('pcp', 'c', 'lookup_location', async () => '{"city":"Encinitas"}');
    expect(await exec()).toBe('{"city":"Encinitas"}');
  });

  it('pcp success uses the office follow-up line', () => {
    const d = directionFor('pcp', 'create_ticket', 'VA-2', 'call4')!;
    expect(d).toContain('follow up with your office');
  });
});

describe('acknowledgeDayMismatch — S6', () => {
  const say = (t: string) => JSON.stringify({ result: { say: t, options: 2 } });

  it('prefixes the admission when the offer is on a different day', () => {
    const out = acknowledgeDayMismatch(say('I have Wednesday, August 12 at 1:40 PM with Dr. Kim.'), '2026-08-11');
    expect(JSON.parse(out).result.say).toMatch(/^I don't have anything on Tuesday — the closest I have is:/);
  });

  it('leaves matching-day offers untouched', () => {
    const raw = say('I have Tuesday, August 11 at 3:10 PM with Dr. Kim.');
    expect(acknowledgeDayMismatch(raw, '2026-08-11')).toBe(raw);
  });

  it('leaves no-availability messages and malformed results untouched', () => {
    const raw = say('I have no openings for that visit type right now.');
    expect(acknowledgeDayMismatch(raw, '2026-08-11')).toBe(raw);
    expect(acknowledgeDayMismatch('not json', '2026-08-11')).toBe('not json');
  });
});
