/**
 * NPX outreach in DEMO mode (v112): one lane, `npx-outreach`, and one
 * environment variable, NPX_OUTREACH_MODE, between the demo and production
 * (operator, 2026-10-22: "switching over to production should be a env
 * switch"). In demo: synthetic patients on the operator's test numbers, the
 * demo NPX, and a simulated Azul cancel and staff ticket. Through the REAL lane
 * and agent registries where the wiring is the claim (failure mode 10).
 * Synthetic patients and placeholder numbers only — the real test numbers live
 * in the environment, never here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgres://stub:stub@ci-stub.invalid:5432/stub';
});
const movable = vi.hoisted(() => ({ source: null as unknown, reads: 0 }));
vi.mock('../runtime/outbound/consoleMovable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/outbound/consoleMovable')>()),
  consoleMovableContactSource: vi.fn(async () => {
    movable.reads += 1;
    return movable.source;
  }),
}));

import { resolveLane, RUNTIME_CALLBACK_TOOLS, RUNTIME_OUTBOUND_TOOLS, type LaneConfig } from '../runtime/laneRegistry';
import type { ContactSource, OutboundContact } from '../runtime/outbound/campaign';
import type { CallbackContext } from '../runtime/outbound/callback';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import { pacificToday } from '../runtime/outbound/consoleMovable';
import { getTool } from '../tools/registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  NPX_OUTREACH_DEMO_SOURCE,
  NPX_OUTREACH_LIVE_CAMPAIGN_KEY,
  NPX_OUTREACH_TOOLS,
  STAFF_CALLBACK_TOOL_NAME,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
} from '../tools/npxOutreachTools';
import { callbackSessionFor, openCallbackSession } from '../tools/outboundTools';
import {
  createNpxOutreachDemoClient,
  NPX_OUTREACH_DEMO_DEFAULT_BASE_URL,
  type NpxOutreachClient,
  type NpxSlot,
} from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';
import {
  DEMO_PARTNER,
  DEMO_PATIENTS,
  demoContacts,
  demoId,
  demoPhones,
  npxOutreachDemoSource,
} from './npxOutreachDemo';
import { createNpxOutreachAgent, npxOutreachPolicy } from './npxOutreachAgent';

const PHONES = '555-555-0101, (555) 555-0102';
const ENV = { NPX_OUTREACH_DEMO_PHONES: PHONES, NPX_OUTREACH_DEMO_API_KEY: 'demo-key' };
const NOW = new Date('2041-02-01T18:00:00Z');

async function registry() {
  const { agentRegistry } = await import('../config/agents');
  return agentRegistry as unknown as { getAgentConfig(id: string): LaneConfig | undefined };
}
type BoundTool = { name?: string };
const names = (tools: unknown) => (tools as BoundTool[]).map((t) => t.name);

describe('who the demo calls', () => {
  it('reads the test numbers from the environment, as E.164, and drops what it cannot read', () => {
    expect(demoPhones({ NPX_OUTREACH_DEMO_PHONES: `${PHONES}, 12, 1-555-555-0103` })).toEqual([
      '+15555550101',
      '+15555550102',
      '+15555550103',
    ]);
    expect(demoPhones({})).toEqual([]);
  });

  it('gives each number a synthetic patient, in order, shaped exactly like a movable-list row', () => {
    const [a, b] = demoContacts(NOW, ENV);
    const today = pacificToday(NOW);
    expect(a).toMatchObject({ externalRef: 'demo-1-a', phone: '+15555550101', firstName: 'Alex', lastName: 'Rivera' });
    expect(b).toMatchObject({ externalRef: 'demo-2-b', phone: '+15555550102', firstName: 'Jordan', lastName: 'Lee' });
    for (const [c, p] of [
      [a, DEMO_PATIENTS[0]],
      [b, DEMO_PATIENTS[1]],
    ] as const) {
      expect(Object.keys(c.data).sort()).toEqual(
        ['appointment_date', 'appointment_id', 'begin_time', 'date_of_birth', 'event_name', 'medical_group', 'office', 'partners', 'person_id', 'provider_name', 'source'].sort(),
      );
      expect(c.data).toMatchObject({ source: NPX_OUTREACH_DEMO_SOURCE, partners: [DEMO_PARTNER], medical_group: p.medicalGroup });
      // Always far enough out for a slot three weeks sooner, whatever day it is.
      const days = (Date.parse(String(c.data.appointment_date)) - Date.parse(today)) / 86_400_000;
      expect(days).toBe(p.daysAhead);
      expect(p.daysAhead).toBeGreaterThanOrEqual(35);
    }
  });

  it('gives every test number its own appointment and person, never a real-looking one', () => {
    const many = demoContacts(NOW, { NPX_OUTREACH_DEMO_PHONES: '5555550101,5555550102,5555550103' });
    const ids = many.flatMap((c) => [c.data.appointment_id, c.data.person_id]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(demoId('appointment', 0)).toMatch(/^00000000-0000-4000-8000-0000d2000001$/);
    expect(many[2].firstName).toBe(DEMO_PATIENTS[0].firstName);
  });

  it('rings nobody without test numbers, or without the demo NPX key', async () => {
    expect(await npxOutreachDemoSource({ NPX_OUTREACH_DEMO_API_KEY: 'demo-key' })).toBeNull();
    expect(await npxOutreachDemoSource({ NPX_OUTREACH_DEMO_PHONES: PHONES })).toBeNull();
    // The live key is not the demo key.
    expect(await npxOutreachDemoSource({ NPX_OUTREACH_DEMO_PHONES: PHONES, NPX_OUTREACH_API_KEY: 'live-key' })).toBeNull();
  });

  it('lists the seed, and re-checks a number at the dial against it', async () => {
    const source = (await npxOutreachDemoSource(ENV))!;
    expect((await source.list(NOW)).map((c) => c.externalRef)).toEqual(['demo-1-a', 'demo-2-b']);
    expect(await source.recheck('demo-2-b', NOW)).toMatchObject({ state: 'current', contact: { phone: '+15555550102' } });
    expect(await source.recheck('demo-9-a', NOW)).toEqual({ state: 'off_list' });
  });
});

describe('the demo NPX client', () => {
  it('goes to the demo deployment with the demo key, never the live key or the live URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, latestDay: '2041-02-20', slots: [] }), { status: 200 }));
    const client = createNpxOutreachDemoClient(
      { NPX_OUTREACH_DEMO_API_KEY: 'demo-key', NPX_OUTREACH_API_KEY: 'live-key', NPX_OUTREACH_BASE_URL: 'https://cec-npx.vercel.app' },
      fetchImpl as unknown as typeof fetch,
    );
    await client.offer({ medicalGroupName: 'G', partnerNames: ['P'], replacedAppointmentDate: '2041-03-01' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${NPX_OUTREACH_DEMO_DEFAULT_BASE_URL}/api/exchange/outreach/offer`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer demo-key');
  });

  it('is not configured by the live key alone', () => {
    expect(createNpxOutreachDemoClient({ NPX_OUTREACH_API_KEY: 'live-key' }).configured).toBe(false);
  });
});

// ── The tools on a demo call ────────────────────────────────────────────────

const SID = 'CA00000000000000000000000000000112';
const SLOT: NpxSlot = {
  slotId: 'slot-a', startAt: '2041-02-04T17:00:00.000Z', endAt: '2041-02-04T17:30:00.000Z',
  timezone: 'America/Los_Angeles', day: '2041-02-04', partnerOrgId: 'p1', partnerName: DEMO_PARTNER,
  clinicId: 'c1', clinicName: 'Demo Clinic', address: '1 Test St, Testville, CA 90000', phone: '555-010-0000',
  providerName: 'Dr Test', visitType: 'Comprehensive Exam',
};

function fakeNpx() {
  return {
    configured: true,
    offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [SLOT] })),
    book: vi.fn(async () => ({ ok: true, bookingId: 'booking-1', alreadyBooked: false, recordGroupDiffers: false, slot: SLOT })),
    reportCancel: vi.fn(async () => ({ ok: true })),
  };
}

let store: FakeOutboundStore;
let attemptId: string;
let live: ReturnType<typeof fakeNpx>;
let demo: ReturnType<typeof fakeNpx>;
let cancel: ReturnType<typeof vi.fn>;
let fileTicket: ReturnType<typeof vi.fn>;

function seed(source: string) {
  store = new FakeOutboundStore();
  const [c] = demoContacts(NOW, ENV);
  store.addContact({ id: 'c1', phone: c.phone!, status: 'calling', firstName: c.firstName, lastName: c.lastName, customData: { ...c.data, source } });
}

beforeEach(async () => {
  resetOutreachSessionsForTests();
  seed(NPX_OUTREACH_DEMO_SOURCE);
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  live = fakeNpx();
  demo = fakeNpx();
  cancel = vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false }));
  fileTicket = vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' }));
  setNpxOutreachDepsForTests({
    npx: live as unknown as NpxOutreachClient,
    npxDemo: demo as unknown as NpxOutreachClient,
    cancel: cancel as never,
    store: async () => store,
    fileTicket: fileTicket as never,
  });
});
afterEach(() => {
  setNpxOutreachDepsForTests(null);
  resetOutreachSessionsForTests();
  vi.unstubAllEnvs();
  movable.source = null;
  movable.reads = 0;
});

const dialled = (campaign: string) => ({
  outbound_contact_id: 'c1',
  outbound_attempt_id: attemptId,
  outbound_phone: '+15555550101',
  outbound_campaign: campaign,
  outbound_call_sid: SID,
});
const run = (campaign: string, name: string, args: Record<string, unknown> = {}) =>
  getTool(name)!.handler({ ...dialled(campaign), ...args });

async function bookThrough(campaign: string) {
  expect(await run(campaign, CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'March 15th, 1980' })).toMatchObject({ verified: true });
  expect(await run(campaign, FIND_SOONER_TOOL_NAME)).toMatchObject({ success: true });
  return (await run(campaign, BOOK_SOONER_TOOL_NAME, { option: '1' })) as Record<string, unknown>;
}

describe('a demo call books in the demo NPX and touches nothing live', () => {
  it('offers and books through the demo NPX, simulates the Azul cancel, and reports it to the demo NPX', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = await bookThrough(NPX_OUTREACH_DEMO_CAMPAIGN_KEY);
    expect(r).toMatchObject({ success: true, booked: true });
    expect(demo.offer).toHaveBeenCalledTimes(1);
    expect(demo.book).toHaveBeenCalledTimes(1);
    expect(demo.reportCancel).toHaveBeenCalledWith('booking-1', 'cancelled');
    expect(demo.offer.mock.calls[0]).toEqual([
      expect.objectContaining({ medicalGroupName: DEMO_PATIENTS[0].medicalGroup, partnerNames: [DEMO_PARTNER] }),
    ]);
    // Nothing live: not production NPX, not NextGen.
    expect(live.offer).not.toHaveBeenCalled();
    expect(live.book).not.toHaveBeenCalled();
    expect(live.reportCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(' ')).toMatch(/Azul cancel SIMULATED .* nothing was sent to NextGen/);
    info.mockRestore();
  });

  it('simulates the staff ticket: nothing reaches the ticketing app, and the text a scheduler would read is logged', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = await run(NPX_OUTREACH_DEMO_CAMPAIGN_KEY, STAFF_CALLBACK_TOOL_NAME, { request: 'wants to talk to someone' });
    expect(r).toMatchObject({ success: true, ticket_number: 'DEMO-STAFF' });
    expect(fileTicket).not.toHaveBeenCalled();
    const logged = info.mock.calls.flat().join(' ');
    expect(logged).toMatch(/staff callback ticket SIMULATED — nothing was filed/);
    expect(logged).toContain('What they asked: wants to talk to someone');
    info.mockRestore();
  });

  // Any ONE of the three makes it a demo call, so a demo call never reaches a
  // live system because one of the three was missing. Each row turns on
  // exactly one.
  it.each([
    ['demo mode alone', undefined, NPX_OUTREACH_LIVE_CAMPAIGN_KEY, 'console_movable'],
    ['the demo campaign alone', 'live', NPX_OUTREACH_DEMO_CAMPAIGN_KEY, 'console_movable'],
    ['a demo-seeded contact alone', 'live', NPX_OUTREACH_LIVE_CAMPAIGN_KEY, NPX_OUTREACH_DEMO_SOURCE],
  ])('%s makes it a demo call', async (_label, mode, campaign, source) => {
    if (mode) vi.stubEnv('NPX_OUTREACH_MODE', mode);
    seed(source);
    attemptId = await store.startAttempt('c1', store.campaignId, 1);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await bookThrough(campaign);
    expect(demo.book).toHaveBeenCalledTimes(1);
    expect(live.offer).not.toHaveBeenCalled();
    expect(live.book).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await run(campaign, STAFF_CALLBACK_TOOL_NAME, { request: 'a person please' });
    expect(fileTicket).not.toHaveBeenCalled();
  });

  it('live mode, the live campaign and a Console contact: production NPX, the real cancel and ticket, never the demo', async () => {
    vi.stubEnv('NPX_OUTREACH_MODE', 'live');
    seed('console_movable');
    attemptId = await store.startAttempt('c1', store.campaignId, 1);
    await bookThrough(NPX_OUTREACH_LIVE_CAMPAIGN_KEY);
    expect(live.book).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(demo.offer).not.toHaveBeenCalled();
    expect(demo.book).not.toHaveBeenCalled();
    await run(NPX_OUTREACH_LIVE_CAMPAIGN_KEY, STAFF_CALLBACK_TOOL_NAME, { request: 'a person please' });
    expect(fileTicket).toHaveBeenCalledTimes(1);
  });
});

// ── One lane, one switch ────────────────────────────────────────────────────

const CONTACT: OutboundContact = {
  contactId: 'c1',
  campaignId: 'campaign-1',
  attemptId: 'a1',
  phone: '+15555550101',
  firstName: 'Alex',
  lastName: 'Rivera',
  data: demoContacts(NOW, ENV)[0].data,
};
const META = {
  callSid: SID,
  callId: SID,
  callerPhone: '+15555550101',
  dialedNumber: '+15555550100',
};
const CONSOLE: ContactSource = {
  name: 'console_movable',
  refreshEveryMs: 1,
  parkMs: 1,
  list: async () => [{ externalRef: 'appt-1', phone: '+15555550199', firstName: 'Real', lastName: 'Patient', data: {} }],
  recheck: async () => ({ state: 'off_list' }),
};

describe('one lane in both modes: going live is the environment variable and nothing else', () => {
  it('registers one NPX lane — no separate demo lane, caller ID or Voice URL to move at the switch', async () => {
    const r = await registry();
    const config = r.getAgentConfig('npx-outreach') as LaneConfig & { factory: unknown };
    expect(config).toMatchObject({ agentType: 'outbound', enabled: true });
    expect(config.outbound).toBe(npxOutreachPolicy);
    expect(config.factory).toBe(createNpxOutreachAgent);
    expect(r.getAgentConfig('npx-outreach-demo')).toBeUndefined();
    for (const mode of ['demo', 'live']) {
      vi.stubEnv('NPX_OUTREACH_MODE', mode);
      expect(config.outbound!.callerIdEnv).toBe('NPX_OUTREACH_CALLER_ID');
      expect(config.outbound!.enableEnv).toBe('OUTBOUND_CAMPAIGN_NPX_OUTREACH');
      expect(config.outbound!.tools).toEqual(NPX_OUTREACH_TOOLS);
    }
  });

  it('demo (the default): the dialler is handed the test numbers and the Console is never read', async () => {
    movable.source = CONSOLE;
    vi.stubEnv('NPX_OUTREACH_DEMO_PHONES', PHONES);
    vi.stubEnv('NPX_OUTREACH_DEMO_API_KEY', 'demo-key');
    vi.stubEnv('NPX_OUTREACH_API_KEY', 'live-key');
    const src = (await npxOutreachPolicy.source!())!;
    expect(src.name).toBe(NPX_OUTREACH_DEMO_SOURCE);
    expect((await src.list(NOW)).map((c) => c.phone)).toEqual(['+15555550101', '+15555550102']);
    expect(movable.reads).toBe(0);
  });

  it('demo without its own key rings nobody, even with the live key set', async () => {
    movable.source = CONSOLE;
    vi.stubEnv('NPX_OUTREACH_DEMO_PHONES', PHONES);
    vi.stubEnv('NPX_OUTREACH_API_KEY', 'live-key');
    expect(await npxOutreachPolicy.source!()).toBeNull();
    expect(movable.reads).toBe(0);
  });

  it('live: the Console\'s list, never the test numbers', async () => {
    movable.source = CONSOLE;
    vi.stubEnv('NPX_OUTREACH_MODE', 'live');
    vi.stubEnv('NPX_OUTREACH_DEMO_PHONES', PHONES);
    vi.stubEnv('NPX_OUTREACH_DEMO_API_KEY', 'demo-key');
    vi.stubEnv('NPX_OUTREACH_API_KEY', 'live-key');
    const src = (await npxOutreachPolicy.source!())!;
    expect(movable.reads).toBe(1);
    expect((await src.list(NOW)).map((c) => c.phone)).toEqual(['+15555550199']);
  });

  it('live without the live key rings nobody, even with the demo key set', async () => {
    movable.source = CONSOLE;
    vi.stubEnv('NPX_OUTREACH_MODE', 'live');
    vi.stubEnv('NPX_OUTREACH_DEMO_PHONES', PHONES);
    vi.stubEnv('NPX_OUTREACH_DEMO_API_KEY', 'demo-key');
    expect(await npxOutreachPolicy.source!()).toBeNull();
  });

  it('speaks in eve on grok-voice-3.0 in both modes, with the same prompt and tools', async () => {
    const source = await registry();
    const prompts: string[] = [];
    for (const mode of ['demo', 'live']) {
      vi.stubEnv('NPX_OUTREACH_MODE', mode);
      const lane = await resolveLane('npx-outreach', { ...META, outbound: { ...CONTACT, campaignKey: npxOutreachPolicy.campaignKey } }, { source, env: {} });
      expect(lane!.voice.voiceName).toBe('eve');
      expect(lane!.voice.model).toBe('grok-voice-3.0');
      prompts.push(String(lane!.agent.instructions));
      const bound = names(lane!.agent.tools);
      for (const t of [...RUNTIME_OUTBOUND_TOOLS, ...NPX_OUTREACH_TOOLS]) expect(bound).toContain(t);
    }
    expect(prompts[0]).toBe(prompts[1]);
  });

  it('a returned call carries the campaign it was resolved under, so a demo callback still reaches the demo NPX', async () => {
    const callback: CallbackContext = {
      campaignKey: npxOutreachPolicy.campaignKey,
      campaignId: store.campaignId,
      callerPhone: '+15555550101',
      match: { kind: 'none' },
      purpose: npxOutreachPolicy.callbackPurpose!,
    };
    // Resolved in demo mode, so the runtime injects the demo campaign...
    const lane = await resolveLane('npx-outreach', { ...META, callback }, { source: await registry(), env: {} });
    const bound = names(lane!.agent.tools);
    for (const t of [...RUNTIME_CALLBACK_TOOLS, ...NPX_OUTREACH_TOOLS]) expect(bound).toContain(t);
    // ...and with the process now live and a Console contact, only that
    // injected campaign can make it a demo call.
    vi.stubEnv('NPX_OUTREACH_MODE', 'live');
    seed('console_movable');
    openCallbackSession({
      callSid: SID,
      campaignKey: NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
      campaignId: store.campaignId,
      callerPhone: '+15555550101',
      candidates: [],
      candidatesLoaded: true,
      purpose: callback.purpose,
      store,
    });
    const cb = callbackSessionFor(SID)!;
    cb.chosen = { contactId: 'c1', phone: '+15555550101', firstName: 'Alex' };
    cb.attemptId = await store.openCallbackAttempt('c1', store.campaignId, SID);
    // The runtime's own dispatch path: the model sends only what it heard.
    const dispatch = (n: string, a: object) =>
      (lane!.agent as unknown as { dispatch(n: string, a: object): Promise<{ output: string }> }).dispatch(n, a);
    expect(JSON.parse((await dispatch(CONFIRM_DOB_TOOL_NAME, { date_of_birth: '03/15/1980' })).output)).toMatchObject({ verified: true });
    await dispatch(FIND_SOONER_TOOL_NAME, {});
    expect(demo.offer).toHaveBeenCalledTimes(1);
    expect(live.offer).not.toHaveBeenCalled();
  });
});
