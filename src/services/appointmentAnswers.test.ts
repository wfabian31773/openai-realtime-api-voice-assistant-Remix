/**
 * Reading an appointment back to the caller.
 *
 * Operator, 2026-08-10: "when there's something as simple as when was my last
 * appointment? That should be the easiest thing." The risk in answering is
 * saying something WRONG — a cancelled slot read back as a visit, or a
 * stranger's dates read to whoever happens to be on the line.
 */
import { describe, it, expect } from 'vitest';
import { speakTime, speakDate, describeAppointment } from './appointmentAnswers';

describe('saying a time out loud', () => {
  it('turns the stored 24-hour string into something a person says', () => {
    expect(speakTime('0800')).toBe('8:00 AM');
    expect(speakTime('1530')).toBe('3:30 PM');
    expect(speakTime('1200')).toBe('12:00 PM');
    expect(speakTime('0005')).toBe('12:05 AM');
  });

  it('says nothing rather than something wrong', () => {
    // A garbled time read aloud sends a patient in at the wrong hour.
    for (const bad of ['', '9', '930', 'noon', '2500', '1275', null, undefined]) {
      expect(speakTime(bad as string)).toBeNull();
    }
  });
});

describe('saying a date out loud', () => {
  const today = new Date('2026-08-10T12:00:00Z');

  it('leaves out the year when it is this year — nobody says it', () => {
    expect(speakDate('2026-07-13', today)).toBe('Monday, July 13');
  });

  it('includes the year when it is not', () => {
    expect(speakDate('2025-11-04', today)).toBe('Tuesday, November 4, 2025');
  });
});

describe('the sentence a caller hears', () => {
  const today = new Date('2026-08-10T12:00:00Z');

  it('includes the doctor and office when we have them', () => {
    expect(
      describeAppointment(
        { date: '2026-07-13', time: '1530', provider: 'Dwayne Logan, MD', office: 'Redlands' },
        today,
      ),
    ).toBe('Monday, July 13 at 3:30 PM with Dwayne Logan, MD at our Redlands office');
  });

  it('leaves out what we do not have instead of saying null', () => {
    const said = describeAppointment(
      { date: '2026-07-13', time: null, provider: null, office: null },
      today,
    );
    expect(said).toBe('Monday, July 13');
    expect(said).not.toMatch(/null|undefined|with\s*$|at our\s/);
  });
});
