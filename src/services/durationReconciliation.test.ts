/**
 * WHICH DURATION DO WE BELIEVE — Twilio's, or our own?
 *
 * For a simple call, Twilio's. For a diverted conference call, ours.
 *
 * The operator pulled CA04e33c56cfe458d6b26070ceee675aba in the Twilio
 * console on 2026-08-14:
 *
 *     Status       No Answer
 *     Duration     0 sec
 *     Start / End  18:11:29 / 18:11:29   (identical)
 *     Stir/Shaken  Failed-C-Diverted
 *
 * That call carried FIVE conversational turns. Its TwiML is
 * `<Dial><Conference>conf_CA04e33c…</Conference></Dial>`: the conversation
 * happens inside the conference, and on a Nextiva-forwarded leg Twilio can
 * finalise the parent call resource as no-answer/0 while the media session
 * ran normally. 45 of 534 after-hours calls in 7 days (8.4%) landed that way.
 *
 * The rule is deliberately narrow. Twilio stays authoritative everywhere it
 * is plausible; we only override when it is contradicting a conversation we
 * measured ourselves, and we flag the disagreement rather than hiding it.
 */
import { describe, it, expect } from 'vitest';

/**
 * The decision, extracted verbatim from callCostService.reconcileTwilioCallData
 * so it can be tested without a Twilio client or a database. If the rule there
 * changes, this must change with it — that is the point of pinning it.
 */
function twilioLooksWrong(localMeasured: number | null, actualDuration: number): boolean {
  return (
    localMeasured != null && localMeasured >= 30 && actualDuration < Math.min(10, localMeasured * 0.2)
  );
}

const chosen = (localMeasured: number | null, actualDuration: number) =>
  twilioLooksWrong(localMeasured, actualDuration) ? localMeasured : actualDuration;

describe('the calls that started this', () => {
  it('keeps our measurement when Twilio reports a no-answer zero on a real conversation', () => {
    // CA04e33c56: ten minutes of wallclock, Twilio says 0.
    expect(twilioLooksWrong(609, 0)).toBe(true);
    expect(chosen(609, 0)).toBe(609);
  });

  it('covers the whole observed range of 0-3 second reports', () => {
    for (const twilio of [0, 1, 2, 3]) {
      expect(twilioLooksWrong(600, twilio), `twilio=${twilio}`).toBe(true);
      expect(chosen(600, twilio)).toBe(600);
    }
  });
});

describe('Twilio stays authoritative wherever it is plausible', () => {
  it('accepts a normal call unchanged', () => {
    expect(twilioLooksWrong(196, 190)).toBe(false);
    expect(chosen(196, 190)).toBe(190);
  });

  it('accepts Twilio being somewhat SHORTER — ringing and setup are ours, not theirs', () => {
    // Our clock starts at the webhook; Twilio's at answer. A gap is normal
    // and must not be mistaken for the conference bug.
    expect(twilioLooksWrong(120, 100)).toBe(false);
    expect(twilioLooksWrong(120, 60)).toBe(false);
    expect(twilioLooksWrong(120, 25)).toBe(false);
  });

  it('accepts Twilio being LONGER', () => {
    // The caller stayed on after we finalised. Twilio knows better here.
    expect(twilioLooksWrong(60, 300)).toBe(false);
    expect(chosen(60, 300)).toBe(300);
  });

  it('never overrides a genuinely short call', () => {
    // A 12-second hangup is a real 12-second hangup. The floor exists so the
    // rule cannot manufacture duration for calls that never happened.
    expect(twilioLooksWrong(12, 0)).toBe(false);
    expect(twilioLooksWrong(29, 1)).toBe(false);
    expect(chosen(12, 0)).toBe(0);
  });

  it('does nothing when we have no local measurement', () => {
    expect(twilioLooksWrong(null, 0)).toBe(false);
    expect(chosen(null, 45)).toBe(45);
  });
});

describe('the boundary', () => {
  it('turns on at 30 seconds of measured conversation', () => {
    expect(twilioLooksWrong(29, 0)).toBe(false);
    expect(twilioLooksWrong(30, 0)).toBe(true);
  });

  it('caps the absolute threshold at 10s so long calls do not widen it', () => {
    // At 600s local, 20% would be 120s — far too permissive. The min() keeps
    // the override to cases where Twilio reports essentially nothing.
    expect(twilioLooksWrong(600, 60)).toBe(false);
    expect(twilioLooksWrong(600, 9)).toBe(true);
  });
});
