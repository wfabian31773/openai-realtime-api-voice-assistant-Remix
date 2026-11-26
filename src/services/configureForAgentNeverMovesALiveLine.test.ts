/**
 * "Configure for agent" on the Twilio page can never move a live line.
 *
 * Driven through the REAL TwilioPhoneManagementService with only the Twilio
 * client and the database faked. The corpus is the ten numbers that carried
 * runtime calls in the 14 days to 2026-11-26 (last four digits and lane, from
 * call_logs), each with the stale Hub row it still has (last synced
 * 2026-02-16) and the runtime URL Twilio would report. No Twilio number is
 * touched by this file: the client is a fake that records what it was asked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  endpoint: null as null | Record<string, unknown>,
  twilioVoiceUrl: null as string | null,
  twilioFetchFails: false,
  twilioFetches: [] as string[],
  twilioUpdates: [] as Array<Record<string, unknown>>,
  dbUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../server/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => (fake.endpoint ? [fake.endpoint] : []),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        fake.dbUpdates.push(values);
        return { where: () => ({ returning: async () => [{ ...fake.endpoint, ...values }] }) };
      },
    }),
  },
}));

// The real getEnvironmentConfig validates DATABASE_URL and friends; the
// write path only asks it whether this is production.
vi.mock('../config/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/environment')>()),
  getEnvironmentConfig: () => ({ isProduction: false }),
}));

vi.mock('../lib/twilioClient', () => ({
  getTwilioAccountSid: () => 'ACtest',
  getTwilioClient: async () => ({
    incomingPhoneNumbers: (sid: string) => ({
      fetch: async () => {
        fake.twilioFetches.push(sid);
        if (fake.twilioFetchFails) throw new Error('Twilio unreachable');
        return { sid, voiceUrl: fake.twilioVoiceUrl };
      },
      update: async (params: Record<string, unknown>) => {
        fake.twilioUpdates.push({ sid, ...params });
        return { sid };
      },
    }),
  }),
}));

const PUBLISHED = 'openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app';

function endpoint(last4: string, storedUrl: string | null) {
  return {
    id: `ep-${last4}`,
    twilioSid: `PN${last4.padStart(32, '0')}`,
    phoneNumber: `+1555555${last4}`,
    friendlyName: null,
    voiceWebhookUrl: storedUrl,
    voiceWebhookMethod: 'POST',
    assignedAgentId: null,
  };
}

/** The ten numbers with runtime calls, 2026-11-12..26 (call_logs.dialed_number). */
const RUNTIME_LINES: Array<[last4: string, lane: string, runtimePath: string]> = [
  ['0771', 'pcp', '/voice/pcp'],
  ['1218', 'surgery', '/voice/surgery'],
  ['8277', 'surgery', '/voice/surgery'],
  ['1543', 'no-ivr', '/voice/no-ivr'],
  ['2449', 'no-ivr', '/voice/no-ivr'],
  ['3027', 'npx-outreach', '/voice/npx-outreach'],
  ['3213', 'si-assistant', '/voice/si-assistant'],
  ['3692', 'optical', '/voice/optical'],
  ['5645', 'records', '/voice/records'],
  ['6683', 'tech', '/voice/tech'],
];

async function service() {
  const { twilioPhoneManagementService } = await import('./twilioPhoneManagementService');
  return twilioPhoneManagementService;
}

async function refusalFrom(promise: Promise<unknown>) {
  const { isPhoneLineRefusal } = await import('./phoneLineGuard');
  try {
    await promise;
  } catch (error) {
    if (isPhoneLineRefusal(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal, the call went through');
}

beforeEach(() => {
  fake.endpoint = null;
  fake.twilioVoiceUrl = null;
  fake.twilioFetchFails = false;
  fake.twilioFetches = [];
  fake.twilioUpdates = [];
  fake.dbUpdates = [];
});

describe('configurePhoneForAgent changes nothing', () => {
  it.each(RUNTIME_LINES)('%s (%s): a runtime line is refused, read live from Twilio', async (last4, lane, path) => {
    // The Hub's copy says the old core; Twilio says the runtime. Twilio wins.
    fake.endpoint = endpoint(last4, `https://${PUBLISHED}/api/voice/${lane}`);
    fake.twilioVoiceUrl = `https://${PUBLISHED}${path}`;
    const svc = await service();
    const refusal = await refusalFrom(svc.configurePhoneForAgent(`ep-${last4}`, 'agent-1', lane, PUBLISHED));
    expect(refusal.reason).toBe('runtime_line');
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain(`"${lane}"`);
    expect(refusal.currentVoiceUrl).toBe(`https://${PUBLISHED}${path}`);
    expect(refusal.wouldWrite).toBe(`https://${PUBLISHED}/api/voice/${lane}/incoming`);
    expect(fake.twilioFetches).toEqual([fake.endpoint.twilioSid]);
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('a Studio phone-menu number is refused and not touched', async () => {
    fake.endpoint = endpoint('3570', null);
    fake.twilioVoiceUrl = 'https://webhooks.twilio.com/v1/Accounts/ACx/Flows/FWx';
    const refusal = await refusalFrom((await service()).configurePhoneForAgent('ep-3570', 'a', 'optical', PUBLISHED));
    expect(refusal.reason).toBe('live_line');
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('a number with no Voice URL is refused and not touched', async () => {
    fake.endpoint = endpoint('4677', null);
    fake.twilioVoiceUrl = null;
    const refusal = await refusalFrom((await service()).configurePhoneForAgent('ep-4677', 'a', 'optical', PUBLISHED));
    expect(refusal.reason).toBe('no_voice_url');
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('when Twilio cannot be read, it refuses rather than assume', async () => {
    fake.endpoint = endpoint('5645', `https://${PUBLISHED}/api/voice/answering-service`);
    fake.twilioFetchFails = true;
    const refusal = await refusalFrom((await service()).configurePhoneForAgent('ep-5645', 'a', 'records', PUBLISHED));
    expect(refusal.reason).toBe('voice_url_unreadable');
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('with no DOMAIN set it still refuses, and says it would have written nothing', async () => {
    fake.endpoint = endpoint('6683', null);
    fake.twilioVoiceUrl = `https://${PUBLISHED}/voice/tech`;
    const refusal = await refusalFrom((await service()).configurePhoneForAgent('ep-6683', 'a', 'tech', undefined));
    expect(refusal.reason).toBe('runtime_line');
    expect(refusal.wouldWrite).toBeNull();
    expect(fake.twilioUpdates).toEqual([]);
  });

  it('an unknown endpoint is not found, and Twilio is not asked', async () => {
    fake.endpoint = null;
    await expect((await service()).configurePhoneForAgent('missing', 'a', 'tech', PUBLISHED)).rejects.toThrow(
      'Phone endpoint not found',
    );
    expect(fake.twilioFetches).toEqual([]);
    expect(fake.twilioUpdates).toEqual([]);
  });
});

describe('updatePhoneEndpointWebhook (the update-webhook route) on a runtime line', () => {
  it('refuses to point a runtime number at the old core', async () => {
    fake.endpoint = endpoint('5645', null);
    fake.twilioVoiceUrl = `https://${PUBLISHED}/voice/records`;
    const refusal = await refusalFrom(
      (await service()).updatePhoneEndpointWebhook('ep-5645', `https://${PUBLISHED}/api/voice/records`, { updateTwilio: true }),
    );
    expect(refusal.reason).toBe('runtime_line');
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('refuses even a move to another runtime lane: repoints are done in the Twilio console', async () => {
    fake.endpoint = endpoint('8277', null);
    fake.twilioVoiceUrl = `https://${PUBLISHED}/voice/surgery`;
    const refusal = await refusalFrom(
      (await service()).updatePhoneEndpointWebhook('ep-8277', `https://${PUBLISHED}/voice/records`, { updateTwilio: true }),
    );
    expect(refusal.reason).toBe('runtime_line');
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toEqual([]);
  });

  it('a number the runtime does not answer is still written', async () => {
    fake.endpoint = endpoint('3570', null);
    fake.twilioVoiceUrl = 'https://webhooks.twilio.com/v1/Accounts/ACx/Flows/FWx';
    await (await service()).updatePhoneEndpointWebhook('ep-3570', `https://${PUBLISHED}/voice/records`, { updateTwilio: true });
    expect(fake.twilioUpdates).toEqual([
      { sid: fake.endpoint.twilioSid, voiceUrl: `https://${PUBLISHED}/voice/records`, voiceMethod: 'POST' },
    ]);
  });

  it('refuses when Twilio cannot be read', async () => {
    fake.endpoint = endpoint('8277', null);
    fake.twilioFetchFails = true;
    const refusal = await refusalFrom(
      (await service()).updatePhoneEndpointWebhook('ep-8277', `https://${PUBLISHED}/voice/records`, { updateTwilio: true }),
    );
    expect(refusal.reason).toBe('voice_url_unreadable');
    expect(fake.twilioUpdates).toEqual([]);
  });

  it('a save that does not touch Twilio does not ask Twilio', async () => {
    fake.endpoint = endpoint('8277', null);
    await (await service()).updatePhoneEndpointWebhook('ep-8277', `https://${PUBLISHED}/api/voice/records`);
    expect(fake.twilioFetches).toEqual([]);
    expect(fake.twilioUpdates).toEqual([]);
    expect(fake.dbUpdates).toHaveLength(1);
  });
});

describe('the routes and the page say what happens', () => {
  const routes = readFileSync(join(__dirname, '../../server/routes.ts'), 'utf8');
  const handler = (path: string) => {
    const start = routes.indexOf(`app.post('${path}'`);
    expect(start).toBeGreaterThan(-1);
    return routes.slice(start, routes.indexOf('\n  });', start));
  };

  it('configure-for-agent answers the refusal with its own status and body', () => {
    const body = handler('/api/phone-endpoints/:id/configure-for-agent');
    expect(body).toContain('configurePhoneForAgent(');
    expect(body).toContain('isPhoneLineRefusal(error)');
    expect(body).toContain('res.status(error.status).json(error.body())');
    expect(body).not.toContain('assignAgentToPhoneEndpoint');
    expect(body).not.toContain('success: true');
  });

  it('update-webhook answers the refusal with its own status and body', () => {
    const body = handler('/api/phone-endpoints/:id/update-webhook');
    expect(body).toContain('isPhoneLineRefusal(error)');
    expect(body).toContain('res.status(error.status).json(error.body())');
  });

  it('the dialog no longer says it will update Twilio', () => {
    const page = readFileSync(join(__dirname, '../../client/src/pages/TwilioPage.tsx'), 'utf8');
    expect(page).not.toContain('This will update the Twilio webhook');
    expect(page).not.toContain('Configure & Update Twilio');
    expect(page).toContain('This does not change the number.');
    expect(page).toContain("error?.response?.status === 409");
  });
});
