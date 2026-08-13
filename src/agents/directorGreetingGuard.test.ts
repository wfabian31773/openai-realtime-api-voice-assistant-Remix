/**
 * The director must never cut the greeting.
 *
 * MEASURED ON PCP, 2026-08-06/07 — 419 calls, its only two full days:
 *
 *   heard the whole greeting        102   and 3 of those were greeted twice
 *   heard a fragment                317   and 268 of those were greeted twice
 *   caller had spoken first           5   (of the 317)
 *
 * The chain, and every link is in the code rather than inferred:
 *
 *   1. The director rules on `response.audio_transcript.done`, which fires
 *      BEFORE `response.done` — the comment above the cancel says so already.
 *      So an authored action lands while the greeting is still in flight.
 *   2. `applyDirectorAction` sends `response.cancel`, truncating it.
 *   3. A cancelled response carries no transcript, so `checkGreetingDelivered`
 *      sees an empty string, concludes the greeting never played, and resends.
 *   4. The model, having just said it, paraphrases. Two greetings.
 *
 * It is PCP-shaped because PCP is the line with a director. The answering
 * service ran 909 calls over the same two days and truncated 18.
 *
 * Wayne took PCP off Twilio over what callers heard on this line. 28% of them
 * asked for a person, which is what people do when the opening sounds broken.
 *
 * SOURCE-SCANNING, and saying so: `applyDirectorAction` is a closure inside a
 * 7,000-line route module that talks to a live transport, and there is no seam
 * to call it through. What this pins is that the cancel is gated on the
 * greeting — the behaviour itself is proven by the next PCP call whose first
 * line arrives whole.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = readFileSync(join(__dirname, '../voiceAgentRoutes.ts'), 'utf8');

/** The body of applyDirectorAction, sliced out so assertions cannot drift. */
function directorAction(): string {
  const start = ROUTES.indexOf('function applyDirectorAction(');
  expect(start, 'applyDirectorAction has moved or been renamed').toBeGreaterThan(-1);
  const end = ROUTES.indexOf('\nfunction ', start + 10);
  return ROUTES.slice(start, end === -1 ? start + 6000 : end);
}

describe('an authored director action cannot truncate the greeting', () => {
  it('reads the greeting guarantee before deciding to cancel', () => {
    const body = directorAction();
    expect(body, 'applyDirectorAction no longer consults pendingGreetings').toMatch(
      /pendingGreetings\.has\(callId\)/,
    );
  });

  it('gates the response.cancel on it, not merely logs about it', () => {
    // The failure mode this guards against is a warning that observes the
    // problem and cancels anyway.
    const body = directorAction();
    const gate = body.indexOf("action.enforcement !== 'inject' && !greetingStillSpeaking");
    expect(gate, 'the cancel is no longer gated on the greeting').toBeGreaterThan(-1);

    const cancel = body.indexOf("type: 'response.cancel'");
    expect(cancel, 'the cancel has moved').toBeGreaterThan(-1);
    expect(cancel, 'response.cancel is reachable without passing the greeting gate').toBeGreaterThan(gate);
  });

  it('still injects the director instruction while withholding the cut', () => {
    // The director's intent must survive — only the audio cut is withheld, so
    // its guidance lands on the next turn instead of being dropped.
    const body = directorAction();
    const inject = body.indexOf("type: 'conversation.item.create'");
    const gate = body.indexOf("const greetingStillSpeaking");
    expect(inject).toBeGreaterThan(-1);
    expect(inject, 'the injection was moved behind the greeting gate — the director now loses its instruction').toBeLessThan(gate);
  });
});

describe('the guarantee state this depends on', () => {
  it('is cleared on delivery, so the guard is not a fixed timer', () => {
    // pendingGreetings is deleted the moment the greeting is confirmed spoken.
    // If that ever stopped happening, this guard would silence the director for
    // the full 20-second window instead of the two or three seconds a greeting
    // actually takes.
    expect(ROUTES).toMatch(/pendingGreetings\.delete\(callId\)/);
    expect(ROUTES).toMatch(/GREETING_GUARANTEE_WINDOW_MS = 20_000/);
  });
});
