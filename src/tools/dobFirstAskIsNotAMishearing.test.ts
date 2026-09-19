/**
 * A FIRST DATE-OF-BIRTH ASK MUST NOT OPEN BY BLAMING THE CALLER.
 *
 * `refuseDob` has two branches and, until this change, one spoken line. `fix`
 * — the channel only the MODEL reads — was always correctly split, and its own
 * wording is the argument for splitting `message` too:
 *
 *   "You did not send the date_of_birth argument at all — that, not the
 *    caller, is why this was refused. ... Only say the message if they have
 *    not given it yet."
 *
 * The spoken line said *"I did not catch that"* on BOTH. On the omitted-argument
 * branch nothing was mis-heard, and on most calls the caller had never been
 * asked — so the agent opened by blaming them for a turn that never happened.
 *
 * MEASURED BEFORE THE CHANGE, every lane that files a ticket, substantive calls:
 * 2026-09-15 carried the false line on 25 calls (surgery 11, pcp 8, optical 4,
 * tech 2) and 10 of those ended with NO ticket of any provenance. 2026-09-16
 * had 9 more by 17:30 UTC.
 *
 * The worked example is `CA48a7238f2381ae130d73c9f9221181bb` (pcp, 2026-09-16,
 * 81s): a medical-records request whose purpose, caller, organisation, patient,
 * delivery method, fax number and title were ALL captured — then this line, then
 * the caller hung up, and nothing filed. No PHI here: the shape is the point and
 * the words live in `call_logs`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { dobRefusalCopy } = await import('./registry');

const LANE_FILES = [
  'src/tools/opticalTools.ts',
  'src/tools/surgeryTools.ts',
  'src/tools/techTools.ts',
  'src/tools/medicalRecordsTools.ts',
];

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the branch where the model sent nothing', () => {
  it('does not claim we mis-heard anybody', () => {
    const { message } = dobRefusalCopy(undefined);
    expect(message.toLowerCase()).not.toContain('did not catch');
    expect(message.toLowerCase()).not.toContain("didn't catch");
  });

  it('still carries the format inside the question — RULE ZERO 2b', () => {
    const { message } = dobRefusalCopy(undefined);
    expect(message).toContain('starting with the month');
    expect(message).toContain('then the day');
    expect(message).toContain('then the year');
    expect(message.trim().endsWith('?')).toBe(true);
  });

  it('tells the model the omission was ITS fault, not the caller’s', () => {
    const { fix } = dobRefusalCopy(undefined);
    expect(fix).toContain('did not send the date_of_birth argument');
    expect(fix).toContain('that, not the caller');
    // The half that stops a re-ask loop when the caller already answered.
    expect(fix).toContain('do NOT ask them again');
  });
});

describe('the branch where the model sent something unreadable', () => {
  /**
   * Deliberately UNCHANGED. Here the parser really did refuse an answer we
   * were given, so "I did not catch that" describes what happened.
   */
  it('still says we did not catch it', () => {
    const { message } = dobRefusalCopy('the fourteenth of nineteen-forty');
    expect(message).toContain('I did not catch that');
    expect(message).toContain('starting with the month');
  });

  it('tells the model the VALUE was the problem', () => {
    const { fix } = dobRefusalCopy('nonsense');
    expect(fix).toContain('could not be read as a date');
    expect(fix).not.toContain('did not send the date_of_birth argument');
  });
});

describe('the two branches are actually different', () => {
  it('speaks a different line depending on what the model sent', () => {
    expect(dobRefusalCopy(undefined).message).not.toBe(dobRefusalCopy('x').message);
  });

  it('treats an empty string like nothing sent, because it is nothing sent', () => {
    expect(dobRefusalCopy('').message).toBe(dobRefusalCopy(undefined).message);
  });
});

/**
 * ONE COPY, NOT FOUR — and this is the half that goes red when somebody
 * re-inlines the literal. Each of these four files held a byte-identical
 * message and `fix` ternary before this change. That is the `explicitAsk.ts`
 * shape that cost the operator his own transfer when two noun lists drifted
 * apart, and the recognition block that was written four times and ended up
 * contradicting itself.
 */
describe('no lane carries its own copy of the refusal', () => {
  it.each(LANE_FILES)('%s asks the registry for the copy', (file) => {
    const src = read(file);
    expect(src).toContain('dobRefusalCopy(dob)');
  });

  it.each(LANE_FILES)('%s does not inline the spoken line', (file) => {
    const src = read(file);
    expect(src).not.toContain('I did not catch that — may I please have the date of birth');
  });

  it.each(LANE_FILES)('%s does not inline the model-facing fix either', (file) => {
    const src = read(file);
    expect(src).not.toContain('You did not send the date_of_birth argument at all');
  });
});
