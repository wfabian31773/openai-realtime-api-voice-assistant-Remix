/**
 * LISTEN-IN IS REFUSED ON A RUNTIME CALL, WITH THE TRUE REASON.
 *
 * A runtime call has no conference to join; 8,501 of 8,502 calls in the 14
 * days to 2026-11-26 were runtime calls, and the button answered that the
 * call "may have just ended". The route and the page are pinned by reading
 * their source, because both are the wiring a helper test cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listenInRefusal, RUNTIME_LISTEN_IN_REASON } from './listenIn';
import * as client from '../../client/src/lib/listenIn';

describe('listenInRefusal', () => {
  it('refuses a runtime call', () => {
    expect(listenInRefusal({ voiceProvider: 'grok' })).toBe(RUNTIME_LISTEN_IN_REASON);
  });

  it('lets an old-core call (no provider) and an unknown call try the conference', () => {
    expect(listenInRefusal({ voiceProvider: null })).toBeNull();
    expect(listenInRefusal({})).toBeNull();
    expect(listenInRefusal(undefined)).toBeNull();
  });

  it('says why, and does not say the call ended', () => {
    expect(RUNTIME_LISTEN_IN_REASON).toContain('no conference to join');
    expect(RUNTIME_LISTEN_IN_REASON).not.toContain('ended —');
  });
});

describe('the page and the route agree', () => {
  it('the client copy is the same rule and the same words', () => {
    expect(client.RUNTIME_LISTEN_IN_REASON).toBe(RUNTIME_LISTEN_IN_REASON);
    for (const v of [{ voiceProvider: 'grok' }, { voiceProvider: null }, {}, undefined]) {
      expect(client.listenInUnavailableReason(v)).toBe(listenInRefusal(v));
    }
  });

  it('the route refuses before it looks for a conference', () => {
    const routes = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    const start = routes.indexOf("app.post('/api/observatory/listen'");
    const body = routes.slice(start, start + 2500);
    const refusal = body.indexOf('listenInRefusal(await storage.getCallLogByCallSid(String(callSid)))');
    const conference = body.indexOf('client.conferences.list');
    expect(refusal).toBeGreaterThan(0);
    expect(conference).toBeGreaterThan(refusal);
    expect(body).toContain('res.status(409).json({ message: refusal })');
  });

  it('the live card hands the button the call’s provider', () => {
    const page = readFileSync(new URL('../../client/src/pages/ObservatoryPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('voiceProvider={call.voiceProvider}');
    expect(page).toContain('listenInUnavailableReason({ voiceProvider })');
  });
});
