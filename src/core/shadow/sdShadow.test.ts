/**
 * The SD shadow's two promises, tested as properties rather than trusted as
 * intentions: it cannot write anything, and it cannot affect the call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

const FILE = join(__dirname, 'sdShadow.ts');

describe('SD shadow — structural guarantees', () => {
  it('never imports anything that can write: no ticketing, no twilio, no db', async () => {
    const src = await readFile(FILE, 'utf8');
    const forbidden = [
      /from\s+['"].*syncAgentService['"]/,
      /from\s+['"].*ticketingApiClient['"]/,
      /from\s+['"].*twilioClient['"]/,
      /from\s+['"]twilio['"]/,
      /from\s+['"].*server\/storage['"]/,
      /from\s+['"].*server\/db['"]/,
      /from\s+['"]drizzle-orm/,
    ];
    for (const rx of forbidden) {
      expect(rx.test(src), `sdShadow.ts must not match ${rx}`).toBe(false);
    }
    // The dynamic imports it DOES make, named explicitly so adding another is
    // a deliberate act that fails this test first.
    const dynamic = [...src.matchAll(/await import\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
    expect(dynamic).toEqual(['../../agents/azulSchedulingAgent', '../../services/scheduleLookupService']);
  });

  it('calls only sage_availability — never sage_book or a transfer tool', async () => {
    const src = await readFile(FILE, 'utf8');
    const tools = [...src.matchAll(/callEyecareTool\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(tools).toEqual(['sage_availability']);
    // Comments are allowed to discuss booking; CODE is not allowed to do it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/sage_book|sage_reschedule/.test(code)).toBe(false);
  });
});

describe('SD shadow — behaviour', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SD_SHADOW = '1';
  });
  afterEach(() => {
    delete process.env.SD_SHADOW;
  });

  it('is off unless SD_SHADOW is set, and subscribing to a dead tap cannot throw', async () => {
    delete process.env.SD_SHADOW;
    const { initSdShadow, sdShadowEnabled } = await import('./sdShadow');
    expect(sdShadowEnabled()).toBe(false);
    expect(initSdShadow()).toEqual({ enabled: false });
  });

  it('records that the line would have booked, without booking', async () => {
    const bookedForReal = vi.fn();
    vi.doMock('../../agents/azulSchedulingAgent', () => ({
      callEyecareTool: vi.fn(async (tool: string) => {
        if (tool === 'sage_book') bookedForReal(); // must never happen
        return JSON.stringify({
          say: 'I have Tuesday the 12th at 9:00 AM, or Wednesday the 13th at 2:30 PM — which works better?',
          options: [{ time: '09:00' }, { time: '14:30' }],
        });
      }),
    }));
    vi.doMock('../../services/scheduleLookupService', () => ({
      scheduleLookupService: { lookupByNameAndDOB: vi.fn(async () => ({ patientFound: true })) },
    }));

    const { shadowTap } = await import('../../shadow/tap');
    vi.spyOn(shadowTap, 'isCaptured').mockReturnValue(true);
    const { initSdShadow, sdShadowReport, _resetSdShadow } = await import('./sdShadow');
    _resetSdShadow();
    expect(initSdShadow().enabled).toBe(true);

    const S = 'sd-shadow-call-1';
    const say = async (type: 'session_started' | 'user_transcript' | 'session_completed', text?: string) => {
      shadowTap.emit(type, S, 'azul-scheduling', text ? { text } : {}, { component: 'transcript' });
      shadowTap.drainNow();
      await new Promise((r) => setTimeout(r, 30));
    };

    await say('session_started');
    await say('user_transcript', 'I need to book an appointment');
    await say('user_transcript', 'existing patient');
    await say('user_transcript', 'Wayne Fabian');
    await say('user_transcript', 'March 17 1973');
    await say('user_transcript', 'Tuesday morning');
    await say('user_transcript', 'the first one');
    await say('session_completed');

    const report = sdShadowReport();
    expect(report.completed).toBe(1);
    // The evidence Gate B could not produce: it got a LIVE offer and reached
    // the point of booking against it.
    expect(report.runs[0].availabilityCalls).toBeGreaterThan(0);
    expect(report.runs[0].liveOffers).toBeGreaterThan(0);
    expect(report.runs[0].wouldBook).toBe(true);
    expect(report.runs[0].wouldBookOption).toBe(1);
    expect(report.reachedBooking).toBe(1);
    // And the thing that must never happen, did not.
    expect(bookedForReal).not.toHaveBeenCalled();
  });

  it('ignores every line that is not azul-scheduling', async () => {
    const { shadowTap } = await import('../../shadow/tap');
    vi.spyOn(shadowTap, 'isCaptured').mockReturnValue(true);
    const { initSdShadow, sdShadowReport, _resetSdShadow } = await import('./sdShadow');
    _resetSdShadow();
    initSdShadow();

    shadowTap.emit('session_started', 'pcp-call', 'pcp', {});
    shadowTap.emit('user_transcript', 'pcp-call', 'pcp', { text: 'book an appointment' });
    shadowTap.emit('session_completed', 'pcp-call', 'pcp', {});
    shadowTap.drainNow();
    await new Promise((r) => setTimeout(r, 20));

    expect(sdShadowReport().completed).toBe(0);
  });
});
