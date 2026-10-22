/**
 * The NPX outreach DEMO lane (v112): the same agent and the same voice as
 * `npx-outreach`, calling synthetic patients and booking in the demo NPX.
 *
 * Operator, 2026-10-22: "No way we are going to do this without testing the
 * line first, I have never heard this agent, make sure it has a good voice,
 * the main one from xai that they use, we should connect it to the demo db
 * first and run our tests there, add some seed data with <two test numbers>
 * so that we can test this first before we have it make live calls."
 *
 * What differs from the live lane, and nothing else does:
 *  - WHO IS CALLED: the synthetic patients below, on the numbers in
 *    NPX_OUTREACH_DEMO_PHONES (comma-separated, first number to the first
 *    patient). Never the Console. The numbers live in the environment, not in
 *    git. Unset, the lane rings nobody.
 *  - WHERE IT BOOKS: the demo NPX (cec-npx-demo.vercel.app, its own database)
 *    with its own key, NPX_OUTREACH_DEMO_API_KEY. Unset, the lane rings nobody.
 *  - THE AZUL CANCEL AND THE STAFF TICKET ARE SIMULATED (npxOutreachTools.ts):
 *    logged, never sent to NextGen or the ticketing app.
 *  - Test-sized caps, its own switch (OUTBOUND_CAMPAIGN_NPX_OUTREACH_DEMO) and
 *    its own caller ID (NPX_OUTREACH_DEMO_CALLER_ID), whose Twilio Voice URL
 *    must be /voice/npx-outreach-demo on the published host before the
 *    dialler rings anybody.
 *
 * The agent, the prompt, the greeting, the tools and the voice are the live
 * lane's: standing instruction 2, the thing being tested is the thing that
 * will run. The voice is the runtime's default, `eve` — the voice in every one
 * of xAI's own Voice Agent examples — unless XAI_VOICE_NAME is set; /voice/health
 * names it per lane.
 */
import type { ContactSource, OutboundLanePolicy, SourceContact } from '../runtime/outbound/campaign';
import { DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import { e164, pacificToday } from '../runtime/outbound/consoleMovable';
import { createNpxOutreachDemoClient } from '../services/npxOutreachClient';
import { NPX_OUTREACH_DEMO_CAMPAIGN_KEY, NPX_OUTREACH_DEMO_SOURCE, NPX_OUTREACH_TOOLS } from '../tools/npxOutreachTools';
import { NPX_OUTREACH_CALLBACK_PURPOSE, NPX_OUTREACH_VOICEMAIL, npxOutreachGreeting } from './npxOutreachAgent';

export const npxOutreachDemoAgentConfig = {
  slug: NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  name: 'NPX Outreach Agent (demo)',
  description:
    'Outbound DEMO: the NPX outreach call on synthetic patients, booking in the demo NPX; ' +
    'the Azul cancel and the staff ticket are simulated.',
  version: '1.0.0',
  voice: 'sage',
  language: 'en',
} as const;

/** The demo practice in reach of every demo patient (cec-npx-demo's one
 * active partner). */
export const DEMO_PARTNER = 'Premier Vision Associates';

interface DemoPatient {
  key: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD — what the person on the phone must say back. */
  dateOfBirth: string;
  /** NextGen's event name, as the movable list carries it. */
  eventName: string;
  /** The Azul appointment, this many days from today (Pacific), so the seed
   * never goes stale: always far enough out for a slot three weeks sooner. */
  daysAhead: number;
  beginTime: string;
  office: string;
  providerName: string;
  /** Credentialed at the demo practice in cec-npx-demo. */
  medicalGroup: string;
}

/**
 * Synthetic people, nobody's record. Two shapes on purpose: a dilated exam
 * ("a dilated eye exam"), and a diabetic exam, which is said as "an eye exam"
 * so a household member is never told the patient is diabetic.
 */
export const DEMO_PATIENTS: readonly DemoPatient[] = [
  {
    key: 'a',
    firstName: 'Alex',
    lastName: 'Rivera',
    dateOfBirth: '1980-03-15',
    eventName: 'Dilated Exam',
    daysAhead: 42,
    beginTime: '10:30',
    office: 'Riverside',
    providerName: 'Dr. Sample',
    medicalGroup: 'Inland Valley Medical Group',
  },
  {
    key: 'b',
    firstName: 'Jordan',
    lastName: 'Lee',
    dateOfBirth: '1975-07-04',
    eventName: 'Diabetic Exam',
    daysAhead: 49,
    beginTime: '14:00',
    office: 'Corona',
    providerName: 'Dr. Sample',
    medicalGroup: 'Corona Health IPA',
  },
];

/** A demo contact's NextGen-shaped ids, by its place in the list: fixed, one
 * per test number, and plainly not real. */
export function demoId(kind: 'person' | 'appointment', index: number): string {
  return `00000000-0000-4000-8000-0000${kind === 'person' ? 'd1' : 'd2'}${String(index + 1).padStart(6, '0')}`;
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The test numbers, E.164, in the order given; anything unreadable dropped. */
export function demoPhones(env: Record<string, string | undefined> = process.env): string[] {
  return (env.NPX_OUTREACH_DEMO_PHONES ?? '')
    .split(',')
    .map((p) => e164(p))
    .filter((p): p is string => p !== null);
}

/** Each test number paired with a demo patient, in order (the patients repeat
 * when there are more numbers than patients). */
export function demoContacts(now: Date, env: Record<string, string | undefined> = process.env): SourceContact[] {
  const today = pacificToday(now);
  return demoPhones(env).map((phone, i) => {
    const p = DEMO_PATIENTS[i % DEMO_PATIENTS.length];
    const ref = `demo-${i + 1}-${p.key}`;
    return {
      externalRef: ref,
      phone,
      firstName: p.firstName,
      lastName: p.lastName,
      data: {
        source: NPX_OUTREACH_DEMO_SOURCE,
        appointment_id: demoId('appointment', i),
        person_id: demoId('person', i),
        date_of_birth: p.dateOfBirth,
        appointment_date: addDays(today, p.daysAhead),
        begin_time: p.beginTime,
        office: p.office,
        event_name: p.eventName,
        provider_name: p.providerName,
        partners: [DEMO_PARTNER],
        medical_group: p.medicalGroup,
      },
    };
  });
}

let warned = false;

/**
 * The demo lane's people, or null — and null means the dialler rings nobody:
 * without test numbers there is nobody to ring, and without the demo key no
 * slot could be offered (the live lane's rule, v110 Codex P1).
 */
export async function npxOutreachDemoSource(
  env: Record<string, string | undefined> = process.env,
): Promise<ContactSource | null> {
  const missing = [
    demoPhones(env).length === 0 ? 'NPX_OUTREACH_DEMO_PHONES' : null,
    createNpxOutreachDemoClient(env).configured ? null : 'NPX_OUTREACH_DEMO_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    if (!warned) {
      warned = true;
      console.warn(`[NPX OUTREACH DEMO] NOT dialling: ${missing.join(' and ')} not set`);
    }
    return null;
  }
  return {
    name: NPX_OUTREACH_DEMO_SOURCE,
    refreshEveryMs: 5 * 60 * 1000,
    parkMs: 60 * 60 * 1000,
    async list(now) {
      return demoContacts(now, env);
    },
    async recheck(externalRef, now) {
      const contact = demoContacts(now, env).find((c) => c.externalRef === externalRef);
      return contact ? { state: 'current', contact } : { state: 'off_list' };
    },
  };
}

export const npxOutreachDemoPolicy: OutboundLanePolicy = {
  campaignKey: NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  enableEnv: 'OUTBOUND_CAMPAIGN_NPX_OUTREACH_DEMO',
  callerIdEnv: 'NPX_OUTREACH_DEMO_CALLER_ID',
  window: DEFAULT_CALLING_WINDOW,
  // Sized for testing: a missed call rings again after half an hour, at most
  // four times a day. A finished call is not rung again until it is reset.
  caps: { perDay: 4, perWeek: 20, total: 60, minHoursBetween: 0.5 },
  concurrency: 1,
  greeting: npxOutreachGreeting,
  voicemail: () => NPX_OUTREACH_VOICEMAIL,
  callbackPurpose: NPX_OUTREACH_CALLBACK_PURPOSE,
  source: () => npxOutreachDemoSource(),
  tools: NPX_OUTREACH_TOOLS,
};
