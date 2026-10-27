/**
 * THE AFTER-HOURS LINE STATES THE OFFICE HOURS — on either pipeline.
 *
 * The corpus call, `CA2a1f76ebec78912a86ccd36ec8b72a94` (after-hours, Grok
 * runtime, 2026-10-01 13:25 UTC, the operator's own test): "at what time does
 * the Pasadena office open this morning?" was answered "I don't want to give
 * you the wrong time for that office — I can have someone confirm it when
 * they're back in." The practice facts in that call's prompt carried the
 * office's hours; a rule written in August told the model to withhold them,
 * because the hardcoded table was thought to disagree with live data. On
 * 2026-10-01 the operator confirmed every office keeps the same hours, and
 * every other lane has stated them from the same table all along.
 *
 * This test drives the REAL agent (`createNoIvrAgent`) on the SIP core's
 * metadata and on the runtime's, and the REAL lane registry for the bound
 * runtime prompt, because a helper proven in isolation proves the helper and
 * not that the call gets it (failure mode 10). The office used is a real
 * practice office — business facts, not PHI.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
process.env.XAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: async () => ({ success: true, ticketNumber: 'VA-TEST' }),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resolveLane, defaultLaneSource } = await import('../runtime/laneRegistry');
const { AZUL_VISION_LOCATIONS } = await import('../config/azulVisionKnowledge');

const base = {
  callId: 'noivr-hours-1',
  callSid: 'CA00000000000000000000000000000ab1',
  callerPhone: '+15555550100',
} as const;

async function prompt(meta: Record<string, unknown>): Promise<string> {
  const agent = await createNoIvrAgent(async () => {}, { ...base, ...meta } as any);
  return String((agent as any).instructions);
}

/** The runtime's prompt, bound the way voiceRuntime binds it: the practice facts are the binding's, not the body's. */
async function boundRuntimePrompt(): Promise<string> {
  const source = await defaultLaneSource();
  const lane = await resolveLane(
    'no-ivr',
    { callSid: 'CA00000000000000000000000000000ab2', callId: 'noivr-hours-2', callerPhone: '+15555550100', dialedNumber: '+15555550199', pipeline: 'runtime' },
    { source, env: {}, handoff: () => async () => ({ ok: true }) },
  );
  expect(lane, 'no-ivr should resolve').not.toBeNull();
  return String(lane!.agent.instructions);
}

const HEDGE = /wrong time for that office/;
const WITHHOLD = /Do not state an exact per-office time|WITHHOLD ONLY THE EXACT TIMES|DO NOT STATE EXACT PER-OFFICE TIMES/;
const STATES_THEM = /(?:state its opening, closing and lunch hours exactly|including the office's own opening and closing time, exactly as written\s*there)/i;

/** A real office and its hours, read from the one table every lane states them from. */
const office = AZUL_VISION_LOCATIONS.find((l) => l.name === 'Pasadena')!;
const officeHoursLine = new RegExp(`${office.name}[^\\n]*${office.hours.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

describe('the after-hours line states the office hours', () => {
  it('the Grok body no longer tells the model to withhold the time, and tells it to state it', async () => {
    const grok = await prompt({ pipeline: 'runtime' });
    expect(grok).not.toMatch(HEDGE);
    expect(grok).not.toMatch(WITHHOLD);
    expect(grok).toMatch(STATES_THEM);
  });

  it('the legacy body (the SIP core) states the hours too, and its escalation tool no longer withholds them', async () => {
    // On the old core the withhold rule lived in the escalate_to_human tool's
    // DESCRIPTION, not the prompt body — which is why the body never carried
    // the hedge and never carried the hours either. Both are read here.
    const agent = await createNoIvrAgent(async () => {}, { ...base } as any);
    const legacy = String((agent as any).instructions);
    const escalate = (agent as any).tools.find((t: any) => t.name === 'escalate_to_human');
    expect(escalate, 'the legacy agent must still carry escalate_to_human').toBeTruthy();
    const description = String(escalate.description);
    for (const text of [legacy, description]) {
      expect(text).not.toMatch(HEDGE);
      expect(text).not.toMatch(WITHHOLD);
    }
    expect(legacy).toMatch(/hours printed on each office's row are the authoritative clinic hours/i);
    expect(legacy).toContain(office.hours);
    expect(description).toMatch(/NEVER file a ticket whose only content is "caller asked about office hours"/);
  });

  it('the Grok body still says no ticket for an hours question, and every office is closed right now', async () => {
    const grok = await prompt({ pipeline: 'runtime' });
    expect(grok).toMatch(/Hours, an address or fax:.*?Fully answered, no callback: do not file/s);
    expect(grok).toMatch(/Every office is closed/);
  });

  it('the hours the model is told to state are actually in the bound runtime prompt, office by office', async () => {
    const runtime = await boundRuntimePrompt();
    expect(office.hours, 'the fixture office must carry hours').toMatch(/\d/);
    expect(runtime).toMatch(officeHoursLine);
    expect(runtime).toMatch(STATES_THEM);
    expect(runtime).not.toMatch(HEDGE);
  });

  it('the hours the legacy body states are the one constant every lane states them from', async () => {
    const { AZUL_VISION_KNOWLEDGE } = await import('../config/azulVisionKnowledge');
    const legacy = await prompt({});
    expect(legacy).toContain(AZUL_VISION_KNOWLEDGE.businessHours.standard);
    expect(legacy).toContain(office.hours);
    expect(legacy).not.toContain('Hours, every office:');
  });

  it.each([
    ['morning', new Date('2026-10-27T17:00:00Z')],
    ['lunch closure', new Date('2026-10-27T19:30:00Z')],
    ['after close', new Date('2026-10-28T00:30:00Z')],
  ])('uses each clinic record as the hours source at %s', async (_label, instant) => {
    const clinics = ['Pasadena', 'Indio', 'West Hills'].map((name) => {
      const clinic = AZUL_VISION_LOCATIONS.find((location) => location.name === name);
      expect(clinic, `fixture clinic ${name} must exist`).toBeTruthy();
      return clinic!;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    try {
      const legacy = await prompt({});
      const runtime = await boundRuntimePrompt();
      for (const clinic of clinics) {
        const escapedHours = clinic.hours.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const locationLine = new RegExp(`${clinic.name}[^\\n]*${escapedHours}`);
        expect(legacy, `legacy prompt missing ${clinic.name} hours`).toMatch(locationLine);
        expect(runtime, `runtime knowledge missing ${clinic.name} hours`).toMatch(locationLine);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
