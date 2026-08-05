import { describe, expect, it } from 'vitest';
import { resolveAppDomain, isDevCallbackUrl } from './environment';

/**
 * The callback domain is recomputed on every boot, so a wrong value re-applies itself
 * on every publish. That is how a published deployment ends up telling Twilio and
 * OpenAI to call back an old development workspace: Replit still exports
 * REPLIT_DEV_DOMAIN inside a deployment, and the old resolution
 * (`DOMAIN || REPLIT_DEV_DOMAIN || localhost`) took it silently.
 */
const PUBLISHED = 'azul-voice.replit.app';
const DEV = 'dcf9f10f-5436-45b2-9ddd-3056216aaa94-00-10mvu4n0j43c2.worf.replit.dev';

describe('callback domain resolution', () => {
  it('always prefers an explicit DOMAIN secret', () => {
    expect(resolveAppDomain({ domain: 'voice.azulvision.com', replitDevDomain: DEV, isProduction: true }))
      .toEqual({ domain: 'voice.azulvision.com', source: 'DOMAIN' });
  });

  it('never uses the dev workspace in production when a published host exists', () => {
    // The regression: DOMAIN unset in a deployment that still exports REPLIT_DEV_DOMAIN.
    const resolved = resolveAppDomain({
      replitDomains: `${DEV},${PUBLISHED}`,
      replitDevDomain: DEV,
      isProduction: true,
    });
    expect(resolved.domain).toBe(PUBLISHED);
    expect(resolved.warning).toBeUndefined();
  });

  it('reports the misconfiguration instead of silently using the dev host', () => {
    const resolved = resolveAppDomain({ replitDevDomain: DEV, isProduction: true });
    expect(resolved.domain).toBe(DEV);
    expect(resolved.warning).toMatch(/DOMAIN is not set/);
  });

  it('still resolves the dev domain in development', () => {
    expect(resolveAppDomain({ replitDevDomain: DEV, isProduction: false }))
      .toEqual({ domain: DEV, source: 'REPLIT_DEV_DOMAIN' });
  });

  it('treats a blank DOMAIN as unset rather than building https:// with nothing', () => {
    expect(resolveAppDomain({ domain: '   ', replitDomains: PUBLISHED, isProduction: true }).domain)
      .toBe(PUBLISHED);
  });

  it('falls back to localhost only when nothing else is known', () => {
    expect(resolveAppDomain({ isProduction: false })).toEqual({ domain: 'localhost:8000', source: 'fallback' });
  });
});

describe('dev callback detection', () => {
  it('recognizes the hosts that must never be written onto a live number', () => {
    expect(isDevCallbackUrl(`https://${DEV}/api/voice/incoming`)).toBe(true);
    expect(isDevCallbackUrl('http://localhost:8000/api/voice/incoming')).toBe(true);
    expect(isDevCallbackUrl('https://127.0.0.1:8000/api/voice/incoming')).toBe(true);
  });

  it('accepts published and custom hosts', () => {
    expect(isDevCallbackUrl(`https://${PUBLISHED}/api/voice/incoming`)).toBe(false);
    expect(isDevCallbackUrl('https://voice.azulvision.com/api/voice/incoming')).toBe(false);
  });

  it('is not fooled by a dev host appearing in the path', () => {
    expect(isDevCallbackUrl(`https://${PUBLISHED}/api/voice/proxy?to=${DEV}`)).toBe(false);
  });
});
