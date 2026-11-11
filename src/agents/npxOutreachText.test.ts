/**
 * v211: the NPX outreach lane texts. Operator, 2026-11-11: "i want them all
 * to receive a text message as well", "there is already a number that NPX
 * uses, we should use that number, wording is fine." The approved words, from
 * the number NPX already calls from, behind its own switch, linking to the
 * call's own booking.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NPX_OUTREACH_TEXTS_ENV, npxOutreachPolicy, npxOutreachText, npxOutreachTextBody } from './npxOutreachAgent';
import { npxBookingPageLane } from '../tools/npxOutreachTools';
import { bookingLinkUrl, newBookingToken, textsEnabled } from '../runtime/outbound/outreachText';
import { isGsm7 } from '../services/gsm7';

afterEach(() => vi.unstubAllEnvs());

describe('the NPX outreach text', () => {
  it('says the approved words, word for word, with the link', () => {
    expect(npxOutreachTextBody('https://h/book/T')).toBe(
      'Azul Vision: we have openings sooner than your upcoming eye appointment at a partner office near you. Book in 4 steps: https://h/book/T. Reply STOP to opt out.',
    );
  });

  it('names no one and no visit, and is plain GSM-7 so it is never sent as UCS-2', () => {
    const link = bookingLinkUrl('openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app', newBookingToken().token);
    const body = npxOutreachTextBody(link);
    expect(isGsm7(body)).toBe(true);
    // Two segments at most (153 characters each when concatenated).
    expect(body.length).toBeLessThanOrEqual(306);
  });

  it('is sent from the number the calls come from', () => {
    expect(npxOutreachPolicy.callerIdEnv).toBe('NPX_OUTREACH_CALLER_ID');
    expect(npxOutreachPolicy.textOutreach).toBe(npxOutreachText);
  });

  it('is off until NPX_OUTREACH_TEXTS is 1', () => {
    expect(NPX_OUTREACH_TEXTS_ENV).toBe('NPX_OUTREACH_TEXTS');
    expect(npxOutreachText.enableEnv).toBe('NPX_OUTREACH_TEXTS');
    expect(textsEnabled(npxOutreachText, {})).toBe(false);
    expect(textsEnabled(npxOutreachText, { NPX_OUTREACH_TEXTS: 'true' })).toBe(false);
    expect(textsEnabled(npxOutreachText, { NPX_OUTREACH_TEXTS: '1' })).toBe(true);
  });

  it('links to the call\'s own booking', () => {
    expect(npxOutreachText.page).toBe(npxBookingPageLane);
  });

  it('sends at most 10 a minute live, 2 on the demo', () => {
    vi.stubEnv('NPX_OUTREACH_MODE', 'live');
    expect(npxOutreachText.perTick).toBe(10);
    vi.stubEnv('NPX_OUTREACH_MODE', '');
    expect(npxOutreachText.perTick).toBe(2);
  });
});
