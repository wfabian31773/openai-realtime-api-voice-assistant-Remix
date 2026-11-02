/**
 * v166: a caller-stated time for TODAY's appointment that disagrees with the
 * confirmed record files high with a conflict line. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import { sameDayTimeConflict, sameDayTimeConflictNote, spokenTimeOf } from './afterHoursRouting';

/** 2026-10-02 06:30 Pacific. */
const NOW = new Date('2026-10-02T13:30:00Z');
const TODAY_9AM = [{ isoDate: '2026-10-02', startTime: '9:00 AM' }];

describe('spokenTimeOf', () => {
  it('reads the shapes a model writes a time in', () => {
    expect(spokenTimeOf('8:00 AM')).toEqual({ minutes: 480, meridiemStated: true });
    expect(spokenTimeOf('today at 2:15pm')).toEqual({ minutes: 855, meridiemStated: true });
    expect(spokenTimeOf('8 a.m.')).toEqual({ minutes: 480, meridiemStated: true });
    expect(spokenTimeOf('at 9')).toEqual({ minutes: 540, meridiemStated: false });
    expect(spokenTimeOf('9:30')).toEqual({ minutes: 570, meridiemStated: false });
    expect(spokenTimeOf('14:30')).toEqual({ minutes: 870, meridiemStated: true });
  });

  it('a bare number or a date is not a time', () => {
    expect(spokenTimeOf('8')).toBeUndefined();
    expect(spokenTimeOf('11/02')).toBeUndefined();
    expect(spokenTimeOf('this morning')).toBeUndefined();
    expect(spokenTimeOf(undefined)).toBeUndefined();
  });
});

describe('sameDayTimeConflict', () => {
  it('a different time today is a conflict, and the note says both', () => {
    const c = sameDayTimeConflict({ callerTime: '8:00 AM', confirmedUpcoming: TODAY_9AM, now: NOW });
    expect(c).toEqual({ callerTime: '8:00 AM', recordTimes: ['9:00 AM'] });
    const note = sameDayTimeConflictNote(c!);
    expect(note).toMatch(/^APPOINTMENT TIME CONFLICT — TODAY/);
    expect(note).toContain('8:00 AM');
    expect(note).toContain('9:00 AM');
  });

  it('the same time is no conflict, with or without a.m./p.m.', () => {
    expect(sameDayTimeConflict({ callerTime: '9:00 AM', confirmedUpcoming: TODAY_9AM, now: NOW })).toBeNull();
    expect(sameDayTimeConflict({ callerTime: 'at 9', confirmedUpcoming: TODAY_9AM, now: NOW })).toBeNull();
  });

  it('no record appointment TODAY, or no readable time, is no conflict', () => {
    expect(
      sameDayTimeConflict({ callerTime: '8:00 AM', confirmedUpcoming: [{ isoDate: '2026-10-03', startTime: '9:00 AM' }], now: NOW }),
    ).toBeNull();
    expect(sameDayTimeConflict({ callerTime: 'this morning', confirmedUpcoming: TODAY_9AM, now: NOW })).toBeNull();
    expect(
      sameDayTimeConflict({ callerTime: '8:00 AM', confirmedUpcoming: [{ isoDate: '2026-10-02' }], now: NOW }),
    ).toBeNull();
    expect(sameDayTimeConflict({ callerTime: '8:00 AM', confirmedUpcoming: undefined, now: NOW })).toBeNull();
  });

  it('matches any of several appointments today', () => {
    const two = [...TODAY_9AM, { isoDate: '2026-10-02', startTime: '2:00 PM' }];
    expect(sameDayTimeConflict({ callerTime: '2:00 PM', confirmedUpcoming: two, now: NOW })).toBeNull();
    expect(sameDayTimeConflict({ callerTime: '3:00 PM', confirmedUpcoming: two, now: NOW })?.recordTimes).toEqual([
      '9:00 AM',
      '2:00 PM',
    ]);
  });
});
