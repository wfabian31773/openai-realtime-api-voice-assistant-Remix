/**
 * The after-hours route: which calls the operator routed himself on 2026-10-02.
 *
 * "1, no, it should record an urgent ticket in after hours" — a post-op
 * medication problem is not a reason to ring the on-call provider.
 * "same day tickets are worked in the after hours department."
 *
 * Synthetic wording throughout; the shapes are the 2026-10-01/02 corpus calls
 * named in afterHoursRouting.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  afterHoursRouteNote,
  mentionsPostOpMedication,
  minutesOf,
  pacificNow,
  recordHasAppointmentLaterToday,
  routeAfterHoursTicket,
  soundsSameDay,
} from './afterHoursRouting';

/** 2026-10-02 06:30 Pacific (PDT, UTC-7) — the morning window. */
const MORNING = new Date('2026-10-02T13:30:00Z');
/** 2026-10-01 20:00 Pacific — after the office day ended. */
const EVENING = new Date('2026-10-02T03:00:00Z');

describe('post-op medication', () => {
  it('reads the corpus shape: a procedure today and drops not at the pharmacy', () => {
    // CAb475175ff010615e82b9f6799c0fb114, in synthetic words.
    expect(
      mentionsPostOpMedication(
        'I had a surgical procedure today and my steroid eye drop prescription is not at the pharmacy',
      ),
    ).toBe(true);
    expect(mentionsPostOpMedication('Post-op patient ran out of drops')).toBe(true);
    expect(mentionsPostOpMedication('después de la cirugía no tengo las gotas en la farmacia')).toBe(true);
  });

  it('needs BOTH halves: surgery alone or a refill alone is not it', () => {
    expect(mentionsPostOpMedication('I had surgery last week and want to book my follow-up')).toBe(false);
    expect(mentionsPostOpMedication('I need a refill of my glaucoma drops at the pharmacy')).toBe(false);
  });

  it('a FUTURE operation is not post-op', () => {
    expect(mentionsPostOpMedication('My surgery is tomorrow and the pharmacy has not got my drops')).toBe(false);
  });

  it('routes URGENT to After Hours on the model flag or the words, at any hour', () => {
    for (const now of [MORNING, EVENING]) {
      expect(routeAfterHoursTicket({ postOpMedication: true, text: 'prescription problem', now })).toEqual({
        kind: 'post_op_medication',
        departmentId: 8,
        priority: 'urgent',
      });
      expect(
        routeAfterHoursTicket({ text: 'post op drops never reached the pharmacy', now }).kind,
      ).toBe('post_op_medication');
    }
  });

  it('outranks same-day', () => {
    expect(
      routeAfterHoursTicket({
        postOpMedication: true,
        appointmentToday: true,
        text: 'x',
        now: MORNING,
      }).kind,
    ).toBe('post_op_medication');
  });
});

describe('same-day', () => {
  it('reads today-plus-a-visit, and the running-late shape that never says today', () => {
    expect(soundsSameDay('Confirming an appointment for today at 2 PM')).toBe(true);
    expect(soundsSameDay('needs to be seen today for an appointment, eye pain')).toBe(true);
    expect(soundsSameDay('running about ten minutes late for the 8 o clock')).toBe(true);
    expect(soundsSameDay('estoy afuera del edificio para mi cirugía')).toBe(true);
    expect(soundsSameDay('tiene una cita hoy a las 9')).toBe(true);
  });

  it('today without a visit, or a visit without today, is not it', () => {
    expect(soundsSameDay('I called today about my glasses')).toBe(false);
    expect(soundsSameDay('I want to reschedule my appointment next week')).toBe(false);
  });

  it('routes to After Hours in the morning, with NO priority of its own', () => {
    const r = routeAfterHoursTicket({ appointmentToday: true, text: 'confirm', now: MORNING });
    expect(r).toEqual({ kind: 'same_day', departmentId: 8 });
    expect('priority' in r).toBe(false);
  });

  it('never after the office day has ended — "today" is then a day that is over', () => {
    expect(routeAfterHoursTicket({ appointmentToday: true, text: 'confirm', now: EVENING }).kind).toBe('default');
    expect(
      routeAfterHoursTicket({ text: 'question about my appointment today', now: EVENING }).kind,
    ).toBe('default');
  });

  it('the confirmed record backstops the model: an appointment LATER today', () => {
    const later = [{ isoDate: '2026-10-02', startTime: '8:00 AM' }];
    const earlier = [{ isoDate: '2026-10-02', startTime: '6:00 AM' }];
    const tomorrow = [{ isoDate: '2026-10-03', startTime: '8:00 AM' }];
    expect(recordHasAppointmentLaterToday(later, MORNING)).toBe(true);
    expect(recordHasAppointmentLaterToday(earlier, MORNING)).toBe(false);
    expect(recordHasAppointmentLaterToday(tomorrow, MORNING)).toBe(false);
    expect(recordHasAppointmentLaterToday([{ isoDate: '2026-10-02' }], MORNING)).toBe(true);
    expect(routeAfterHoursTicket({ text: 'a question', confirmedUpcoming: later, now: MORNING }).kind).toBe(
      'same_day',
    );
  });

  it('everything else is the app\'s to decide, as before', () => {
    expect(routeAfterHoursTicket({ text: 'refill of my glaucoma drops', now: MORNING })).toEqual({ kind: 'default' });
  });
});

describe('the clock is the practice\'s', () => {
  it('reads Pacific whatever the server runs', () => {
    expect(pacificNow(MORNING)).toEqual({ isoDate: '2026-10-02', minutes: 6 * 60 + 30 });
    expect(pacificNow(EVENING)).toEqual({ isoDate: '2026-10-01', minutes: 20 * 60 });
    // PST in December: UTC-8.
    expect(pacificNow(new Date('2026-12-15T14:00:00Z'))).toEqual({ isoDate: '2026-12-15', minutes: 6 * 60 });
  });

  it('reads the schedule\'s own time format', () => {
    expect(minutesOf('8:00 AM')).toBe(480);
    expect(minutesOf('12:30 PM')).toBe(750);
    expect(minutesOf('12:15 AM')).toBe(15);
    expect(minutesOf('soon')).toBeUndefined();
  });
});

describe('the staff note', () => {
  it('says what was routed and why, and never carries the caller\'s words', () => {
    expect(afterHoursRouteNote('post_op_medication')).toMatch(/URGENT/);
    expect(afterHoursRouteNote('post_op_medication')).toMatch(/not a reason to ring/);
    expect(afterHoursRouteNote('same_day')).toMatch(/SAME-DAY/);
    expect(afterHoursRouteNote('default')).toBeNull();
  });
});
