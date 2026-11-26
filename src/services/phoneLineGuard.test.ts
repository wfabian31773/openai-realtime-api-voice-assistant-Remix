import { describe, expect, it } from 'vitest';
import {
  classifyVoiceUrl,
  configureForAgentRefusal,
  isPhoneLineRefusal,
  PhoneLineRefusal,
  webhookWriteRefusal,
} from './phoneLineGuard';

const PUBLISHED = 'https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app';
const WORKSPACE = 'https://example-00-workspace.spock.replit.dev';
const STUDIO = 'https://webhooks.twilio.com/v1/Accounts/ACxxxxxxxx/Flows/FWxxxxxxxx';
const OLD_CORE_WRITE = `${PUBLISHED}/api/voice/records/incoming`;

describe('classifyVoiceUrl', () => {
  it.each([
    [`${PUBLISHED}/voice/records`, 'records'],
    [`${PUBLISHED}/voice/no-ivr`, 'no-ivr'],
    [`${PUBLISHED}/voice/npx-outreach`, 'npx-outreach'],
    [`${WORKSPACE}/voice/tech`, 'tech'],
    [`${PUBLISHED}/Voice/Optical/`, 'optical'],
    [`${PUBLISHED}/voice/pcp?x=1`, 'pcp'],
    [`${PUBLISHED}/api/voice/operator-line/inbound`, 'operator-line'],
  ])('%s is the runtime (lane %s)', (url, lane) => {
    expect(classifyVoiceUrl(url)).toEqual({ kind: 'runtime', lane });
  });

  it.each([
    `${PUBLISHED}/api/voice/no-ivr`,
    `${PUBLISHED}/api/voice/answering-service`,
    OLD_CORE_WRITE,
    `${PUBLISHED}/api/voice/inbound?agent=optical`,
    // server/index.ts lets only the exact operator path past the proxy.
    `${PUBLISHED}/API/Voice/operator-line/inbound/`,
    `${PUBLISHED}/api/voice/operator-line/inbound/`,
  ])('%s is the retired pipeline', (url) => {
    expect(classifyVoiceUrl(url).kind).toBe('retired');
  });

  it.each([
    STUDIO,
    'https://another-app.replit.app/api/incoming',
    `${PUBLISHED}/`,
    'not a url',
    // Not a working runtime line: no route takes a new call there.
    `${PUBLISHED}/voice/records/typo`,
    `${PUBLISHED}/voice/outbound/si-assistant`,
    `${PUBLISHED}/voice/health`,
    // Express 5 routes one optional trailing slash, not two.
    `${PUBLISHED}/voice/records//`,
    `${PUBLISHED}/voice//records`,
  ])(
    '%s answers calls somewhere else',
    (url) => {
      expect(classifyVoiceUrl(url).kind).toBe('other');
    },
  );

  it.each([null, undefined, '', '   '])('%s is no Voice URL', (url) => {
    expect(classifyVoiceUrl(url)).toEqual({ kind: 'none' });
  });

  it('a path that only starts with "voice" is not the runtime', () => {
    expect(classifyVoiceUrl(`${PUBLISHED}/voicemail/x`).kind).toBe('other');
    expect(classifyVoiceUrl(`${PUBLISHED}/api/voicemail`).kind).toBe('other');
  });
});

describe('configureForAgentRefusal: the action never changes a number', () => {
  it('a runtime number is refused, named as the runtime, with its lane', () => {
    const r = configureForAgentRefusal('+19095550001', { ok: true, url: `${PUBLISHED}/voice/records` }, OLD_CORE_WRITE);
    expect(r).toBeInstanceOf(PhoneLineRefusal);
    expect(r.status).toBe(409);
    expect(r.reason).toBe('runtime_line');
    expect(r.message).toContain('voice runtime');
    expect(r.message).toContain('"records"');
    expect(r.message).toContain('retired pipeline');
    expect(r.message).toContain('Nothing was changed');
    expect(r.body()).toEqual({
      success: false,
      changed: false,
      reason: 'runtime_line',
      message: r.message,
      currentVoiceUrl: `${PUBLISHED}/voice/records`,
      wouldWrite: OLD_CORE_WRITE,
    });
  });

  it('a workspace-host runtime number is refused as the runtime too', () => {
    const r = configureForAgentRefusal('+19095550001', { ok: true, url: `${WORKSPACE}/voice/tech` }, OLD_CORE_WRITE);
    expect(r.reason).toBe('runtime_line');
  });

  it('a Studio phone-menu number is refused (it is a live line too)', () => {
    const r = configureForAgentRefusal('+16265550002', { ok: true, url: STUDIO }, OLD_CORE_WRITE);
    expect(r.reason).toBe('live_line');
    expect(r.message).toContain(STUDIO);
    expect(r.body().changed).toBe(false);
  });

  it('an old-core number is refused', () => {
    const r = configureForAgentRefusal('+16265550003', { ok: true, url: `${PUBLISHED}/api/voice/azul-scheduling` }, OLD_CORE_WRITE);
    expect(r.reason).toBe('live_line');
  });

  it('a number with no Voice URL is refused', () => {
    const r = configureForAgentRefusal('+16265550004', { ok: true, url: null }, OLD_CORE_WRITE);
    expect(r.reason).toBe('no_voice_url');
    expect(r.currentVoiceUrl).toBeNull();
  });

  it('a Voice URL Twilio would not give is refused, not assumed', () => {
    const r = configureForAgentRefusal('+16265550005', { ok: false }, OLD_CORE_WRITE);
    expect(r.reason).toBe('voice_url_unreadable');
    expect(r.message).toContain('Could not read');
  });

  it('every refusal says the URL it would have written is served by nothing', () => {
    for (const current of [
      { ok: true as const, url: `${PUBLISHED}/voice/records` },
      { ok: true as const, url: STUDIO },
      { ok: true as const, url: null },
    ]) {
      expect(configureForAgentRefusal('+1', current, OLD_CORE_WRITE).message).toContain('not served by either voice pipeline');
    }
  });
});

describe('webhookWriteRefusal: the dashboard writes a Voice URL only onto a number that has none', () => {
  const TARGETS = [
    `${PUBLISHED}/api/voice/records`,
    STUDIO,
    `${PUBLISHED}/voice/records/incoming`,
    `${PUBLISHED}/voice/records//`,
    'https://unrelated-host.example.com/voice/records',
    `${WORKSPACE}/voice/records`,
    `${PUBLISHED}/voice/recrods`,
    `${PUBLISHED}/voice/surgery`,
    `${PUBLISHED}/voice/records`,
  ];

  it.each(TARGETS)('refuses moving a runtime number to %s', (target) => {
    const r = webhookWriteRefusal('+1', { ok: true, url: `${PUBLISHED}/voice/records` }, target);
    expect(r?.reason).toBe('runtime_line');
    expect(r?.message).toContain('"records"');
    expect(r?.message).toContain('only onto a number that has none');
    expect(r?.message).toContain('Twilio console');
    expect(r?.body()).toMatchObject({ success: false, changed: false, wouldWrite: target });
  });

  it.each([
    // Codex on #528, round 4: Express decodes the lane, so this reaches
    // records; the wording does not decode it, and the write is refused anyway.
    `${PUBLISHED}/voice/%72ecords`,
    STUDIO,
    `${PUBLISHED}/api/voice/no-ivr`,
    // Broken URLs are repaired in the Twilio console too.
    `${PUBLISHED}/voice/records/typo`,
    `${PUBLISHED}/voice/records//`,
    `${PUBLISHED}/api/voice/operator-line/inbound/`,
    'not a url',
  ])('refuses overwriting a number already on %s', (current) => {
    const r = webhookWriteRefusal('+1', { ok: true, url: current }, `${PUBLISHED}/voice/records`);
    expect(r?.reason).toBe('live_line');
    expect(r?.message).toContain(current);
    expect(r?.message).toContain('only onto a number that has none');
    expect(r?.body()).toMatchObject({ success: false, changed: false, currentVoiceUrl: current });
  });

  it.each([`${WORKSPACE}/voice/tech`, `${PUBLISHED}/Voice/Tech/`, `${PUBLISHED}/api/voice/operator-line/inbound`])(
    'names the runtime when the number is on %s',
    (current) => {
      expect(webhookWriteRefusal('+1', { ok: true, url: current }, STUDIO)?.reason).toBe('runtime_line');
    },
  );

  it.each([null, '', '   '])('lets a number with no Voice URL (%s) be given one', (current) => {
    expect(webhookWriteRefusal('+1', { ok: true, url: current }, `${PUBLISHED}/voice/records`)).toBeNull();
  });

  it('refuses when the current URL cannot be read', () => {
    expect(webhookWriteRefusal('+1', { ok: false }, `${PUBLISHED}/voice/records`)?.reason).toBe('voice_url_unreadable');
  });
});

describe('isPhoneLineRefusal reads the shape, not the class', () => {
  it('accepts a refusal and a structural copy of one', () => {
    const r = configureForAgentRefusal('+1', { ok: true, url: null }, null);
    expect(isPhoneLineRefusal(r)).toBe(true);
    // What a second copy of the module would throw on Node 20.
    const copy = Object.assign(new Error('x'), { name: 'PhoneLineRefusal', status: 409, body: () => ({}) });
    expect(isPhoneLineRefusal(copy)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isPhoneLineRefusal(new Error('Phone endpoint not found'))).toBe(false);
    expect(isPhoneLineRefusal(null)).toBe(false);
    expect(isPhoneLineRefusal({ name: 'PhoneLineRefusal' })).toBe(false);
  });
});
