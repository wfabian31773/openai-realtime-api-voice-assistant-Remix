/**
 * EVERY CLINIC THE CONSOLE SAYS IS OPEN IS IN THE OFFICES THE AGENT KNOWS BY HEART.
 *
 * Support Desk, 2026-11-10: on 2026-11-09 the records agent told a caller that
 * Beaumont "doesn't match any of our locations". It is one of ours.
 * `CA1169700883a2a647582fe0cd44b097ba` (records, 2026-11-09): the caller named
 * Beaumont, `resolve_location` answered `verified: true` (it reads the
 * Console's si_locations through consoleDirectory), and the agent then read
 * the office list in its Business Facts, found no Beaumont, and said so.
 *
 * The office list is AZUL_VISION_LOCATIONS, which every runtime lane gets
 * through the knowledge pack and the after-hours and answering-service bodies
 * get through buildCompactLocationReference. It held 31 offices. The Console
 * held 33 active clinics on 2026-11-10: Beaumont (320 appointments in 90 days)
 * and Fullerton (1,197) were missing. The pack's own last rule ("if it is not
 * written here, you do not know it") is what turned a missing row into a
 * wrong answer.
 *
 * This test pins the Console's active-clinic list as read on 2026-11-10
 * (`si_locations`, facility_kind 'clinic', not deleted in NextGen) and holds
 * the agent's list to it one for one, so the next clinic the Console adds
 * fails here when the pinned list is refreshed instead of on a caller. It
 * also builds the lanes through the REAL registry, because a list proven in
 * isolation proves the list and not that the call gets it.
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

const { resolveLane, defaultLaneSource } = await import('./laneRegistry');
const { buildKnowledgePack } = await import('./knowledgePack');
const { AZUL_VISION_LOCATIONS, buildCompactLocationReference } = await import('../config/azulVisionKnowledge');

const CORPUS_SID = 'CA1169700883a2a647582fe0cd44b097ba';

/**
 * The Console's active clinics on 2026-11-10, exactly as NextGen names them.
 * Refresh with:
 *   select nextgen_name from si_locations
 *    where coalesce(is_deleted_in_nextgen,false) = false and facility_kind = 'clinic'
 *    order by nextgen_name;
 */
const CONSOLE_ACTIVE_CLINICS_20261110 = [
  'Atlantis Eyecare Anaheim',
  'Atlantis Eyecare Downey',
  'Atlantis Eyecare Huntington Beach',
  'Atlantis Eyecare Laguna Hills',
  'Atlantis Eyecare Long Beach',
  'Atlantis Eyecare Montebello',
  'Atlantis Eyecare Santa Ana',
  'Atlantis Eyecare Torrance',
  'Azul Vision Beaumont',
  'Azul Vision Covina',
  'Azul Vision DTLA',
  'Azul Vision Eastvale',
  'Azul Vision Encinitas',
  'Azul Vision Fullerton',
  'Azul Vision Glendale',
  'Azul Vision Glendora',
  'Azul Vision Indio',
  'Azul Vision Mission Hlls',
  'Azul Vision Mission Viejo',
  'Azul Vision Monrovia',
  'Azul Vision Northridge',
  'Azul Vision Oceanside',
  'Azul Vision Palm Desert',
  'Azul Vision Pasadena',
  'Azul Vision Rancho Cucamonga',
  'Azul Vision Redlands',
  'Azul Vision Riverside Latham',
  'Azul Vision San Bernardino',
  'Azul Vision San Gabriel',
  'Azul Vision Tarzana',
  'Azul Vision Upland',
  'Azul Vision West Hills',
  'Azul Vision Willow',
] as const;

/** The four offices whose NextGen name is not the name callers use
 *  (consoleDirectory.LOCATION_ALIASES). Every other clinic brand-strips. */
const SPOKEN_NAME: Record<string, string> = {
  'Azul Vision DTLA': 'Los Angeles (DTLA)',
  'Azul Vision Mission Hlls': 'Mission Hills',
  'Azul Vision Riverside Latham': 'Riverside',
  'Azul Vision Willow': 'Long Beach Willow',
};

function packName(nextgen: string): string {
  return SPOKEN_NAME[nextgen] ?? nextgen.replace(/^(Azul Vision|Atlantis Eyecare)\s+/, '');
}

/** Address and phone as the Console holds them on 2026-11-10, for the two
 *  rows this change adds. The digits are compared, not the punctuation. */
const ADDED = [
  { name: 'Beaumont', street: '831', zip: '92223', phoneDigits: '9518215196' },
  { name: 'Fullerton', street: '333', zip: '92835', phoneDigits: '7145918132' },
] as const;

const LANES = ['optical', 'surgery', 'tech', 'records', 'pcp', 'no-ivr'] as const;
const NEEDS_A_TRANSFER = new Set(['pcp', 'no-ivr']);

async function bound(slug: string): Promise<string> {
  const source = await defaultLaneSource();
  const lane = await resolveLane(
    slug,
    { callSid: CORPUS_SID, callId: `clinics-${slug}`, callerPhone: '+15555550100', dialedNumber: '+15555550199', pipeline: 'runtime' },
    { source, env: {}, ...(NEEDS_A_TRANSFER.has(slug) ? { handoff: () => async () => ({ ok: true }) } : {}) },
  );
  expect(lane, `${slug} should resolve`).not.toBeNull();
  return String(lane!.agent.instructions);
}

describe(`every clinic the Console says is open is an office the agent knows (${CORPUS_SID})`, () => {
  it('maps each of the 33 active Console clinics to exactly one office row', () => {
    for (const nextgen of CONSOLE_ACTIVE_CLINICS_20261110) {
      const rows = AZUL_VISION_LOCATIONS.filter((l) => l.name === packName(nextgen));
      expect(rows.length, `${nextgen} should be one office row (looked for "${packName(nextgen)}")`).toBe(1);
    }
  });

  it('lists no office the Console does not hold as an active clinic', () => {
    const fromConsole = new Set(CONSOLE_ACTIVE_CLINICS_20261110.map(packName));
    const extra = AZUL_VISION_LOCATIONS.map((l) => l.name).filter((n) => !fromConsole.has(n));
    expect(extra).toEqual([]);
    expect(AZUL_VISION_LOCATIONS.length).toBe(CONSOLE_ACTIVE_CLINICS_20261110.length);
  });

  it.each(ADDED)('carries $name with the Console\'s address and phone', ({ name, street, zip, phoneDigits }) => {
    const row = AZUL_VISION_LOCATIONS.find((l) => l.name === name)!;
    expect(row, `${name} must be on the list`).toBeTruthy();
    expect(row.address.startsWith(street)).toBe(true);
    expect(row.zip).toBe(zip);
    expect(row.phone.replace(/\D/g, '')).toBe(phoneDigits);
    expect(row.hours).toBe('Mon-Fri 8am-5pm, closed 12pm-1pm');
  });

  it('says a fax is not on file rather than leaving it blank', () => {
    const pack = buildKnowledgePack();
    for (const { name } of ADDED) {
      const line = pack.split('\n').find((l) => l.startsWith(`${name}: `));
      expect(line, `${name} should have a line in the pack`).toBeTruthy();
      expect(line).toContain('| fax not on file |');
    }
    expect(pack).not.toMatch(/\| fax\s*\|/);
    // An office that has a fax still prints it.
    expect(pack).toMatch(/^Anaheim: .*\| fax \(714\) 533-6800 \|/m);
  });

  it.each(LANES)('%s: both offices reach the bound prompt the runtime hands the model', async (slug) => {
    const p = await bound(slug);
    const facts = p.slice(p.indexOf('## Business Facts'), p.indexOf('## Objective'));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts).toMatch(/^Beaumont: 831 N\. Highland Springs Avenue, Beaumont, CA 92223 \| phone \(951\) 821-5196/m);
    expect(facts).toMatch(/^Fullerton: 333 W\. Bastanchury Road, Suite 110, Fullerton, CA 92835 \| phone \(714\) 591-8132/m);
  }, 30_000);

  it('the legacy office reference (after-hours and answering-service bodies) lists both', () => {
    const ref = buildCompactLocationReference({ includeHours: true });
    expect(ref).toContain('Beaumont');
    expect(ref).toContain('Fullerton');
  });
});
