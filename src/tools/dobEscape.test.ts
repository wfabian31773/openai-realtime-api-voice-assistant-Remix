/**
 * Ask once, then file it anyway. Operator ruling 2026-09-04, and the same one
 * he gave for optical's office on 2026-09-01.
 *
 * The measurement that makes this the highest-value change of the day: on the
 * cutover day the location gate HAD this escape and recovered 9 of 11 calls;
 * the date-of-birth gate did NOT and recovered 0 of 23. Same codebase, same
 * callers, one difference.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decideDobEscape, dobStatusNote, dobEscapeMarker } from './dobEscape';
import { resetGateAttempts } from './gateAttempts';
import { resetDobHistory } from './dobEscape';

const SID = 'CA00000000000000000000000000000077';
const TOOL = 'file_optical_ticket';

beforeEach(() => {
  resetGateAttempts();
  resetDobHistory();
});

describe('the date-of-birth escape', () => {
  it('asks the FIRST time — the caller deserves to be asked properly once', () => {
    expect(decideDobEscape(SID, TOOL, '')).toEqual({ askAgain: true });
  });

  it('files anyway the second time, rather than asking forever', () => {
    decideDobEscape(SID, TOOL, '');
    expect(decideDobEscape(SID, TOOL, '')).toEqual({
      askAgain: false,
      status: 'unavailable',
    });
  });

  /**
   * The two cases mean different things to whoever picks the ticket up.
   * "unmatched" says there IS an answer on the recording; "unavailable" says
   * there is nothing to go and listen for.
   */
  it('tells apart "never gave one" from "gave one we could not read"', () => {
    decideDobEscape(SID, TOOL, '');
    expect(decideDobEscape(SID, TOOL, '')).toMatchObject({ status: 'unavailable' });

    resetGateAttempts();
    decideDobEscape(SID, TOOL, 'the seventies sometime');
    expect(decideDobEscape(SID, TOOL, 'the seventies sometime')).toMatchObject({
      status: 'unmatched',
    });
  });

  /**
   * The caller gave an unreadable date on the first try and the model omitted
   * the argument on the retry. Deciding from the last payload alone reports
   * "never given" and sends staff looking for nothing, while the date sits on
   * the recording (Codex, PR #268 round 4).
   */
  it('remembers an EARLIER unreadable date when the retry sends nothing', () => {
    decideDobEscape(SID, TOOL, 'sometime in the seventies');
    expect(decideDobEscape(SID, TOOL, '')).toMatchObject({ status: 'unmatched' });
  });

  it('still says unavailable when no attempt ever carried one', () => {
    decideDobEscape(SID, TOOL, '');
    expect(decideDobEscape(SID, TOOL, '')).toMatchObject({ status: 'unavailable' });
  });

  it('does not let one call\'s spoken date decide another call\'s status', () => {
    const other = 'CA00000000000000000000000000000079';
    decideDobEscape(SID, TOOL, 'the seventies');
    decideDobEscape(other, TOOL, '');
    expect(decideDobEscape(other, TOOL, '')).toMatchObject({ status: 'unavailable' });
  });

  it('counts per call and per tool, so one caller cannot spend another\'s ask', () => {
    const other = 'CA00000000000000000000000000000078';
    decideDobEscape(SID, TOOL, '');
    // A different call is still on its first ask.
    expect(decideDobEscape(other, TOOL, '')).toEqual({ askAgain: true });
    // And a different tool on the same call likewise.
    expect(decideDobEscape(SID, 'file_tech_ticket', '')).toEqual({ askAgain: true });
  });
});

describe('what staff see on the ticket', () => {
  it('leads with the status and says to check the recording', () => {
    for (const status of ['unavailable', 'unmatched'] as const) {
      const note = dobStatusNote(status);
      expect(note.startsWith('DATE OF BIRTH ')).toBe(true);
      expect(note.toUpperCase()).toContain(status.toUpperCase());
      expect(note).toContain('recording');
      expect(note).toContain('before matching this to a chart');
    }
  });

  it('distinguishes the two so nobody hunts for a recording that has nothing', () => {
    expect(dobStatusNote('unavailable')).toContain('never given');
    expect(dobStatusNote('unmatched')).toContain('could not be read');
    expect(dobStatusNote('unavailable')).not.toBe(dobStatusNote('unmatched'));
  });
});

describe('the marker', () => {
  it('is a live counter of how many requests this ruling saves', () => {
    const line = dobEscapeMarker(TOOL, 'unavailable', SID);
    expect(line).toContain('[DOB ESCAPE]');
    expect(line).toContain(TOOL);
    expect(line).toContain(SID);
  });

  /**
   * The date itself is PHI and the whole reason dobShape exists. A marker that
   * printed what the caller said would put a birthday in a log.
   */
  it('carries no date and no name', () => {
    const line = dobEscapeMarker(TOOL, 'unmatched', SID);
    expect(line).not.toMatch(/\d{1,2}[\/\-. ]\d{1,2}/);
  });
});
