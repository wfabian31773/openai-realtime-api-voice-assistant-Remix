/**
 * v220: an NPX staff-callback ticket stays in the HVA Hub.
 *
 * `request_staff_callback` files to the HVA Hub (department 9) and writes the
 * patient's appointment into the ticket's description. It wrote the visit as
 * the caller hears it, and for a Refraction Only that is "a vision test for
 * glasses". The ticketing app re-classifies a Hub request by its words
 * (`correctSurgeryIntake`; this repo's mirror is `requestClassification.ts`):
 * "glasses" with no medication word is Optical (1/66/536). So the ticket was
 * created in Optical Support.
 *
 * Measured, every NPX staff-callback ticket to 2026-11-13 (`voice_agent_api_logs`
 * against `tickets`): 29 tickets, every POST sent department 9; 6 were created
 * in Optical, every one a Refraction Only, every one with "glasses" only in
 * the appointment line. One was then moved by staff to Technicians.
 *
 * The corpus, by real SID. Synthetic patient, ids and offices only; the
 * transcripts stay in `call_logs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  DESCRIBE_TOOL_NAME,
  STAFF_CALLBACK_TOOL_NAME,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  spokenVisit,
} from './npxOutreachTools';
import { correctSurgeryIntake } from './requestClassification';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient } from '../services/npxOutreachClient';

/** [sid, what the caller asked, in the shape the model wrote it]. */
const CORPUS: Array<[string, string]> = [
  ['CAa73b9fea680caad6b075c32167464f2c', 'wants to reschedule the appointment'],
  ['CA88f3348bc2aa2e9b2df48a8850276532', 'wants to move the appointment to another day'],
  ['CA6878fcf194ffc25cb1e41b5f6dc32a9b', 'would like a person to call about the appointment'],
  ['CA2d3c9ad8a9f410b80d11082c2591d095', 'wants the details of the appointment'],
  ['CA39b3285a45b8d97ca664f5573e48e2c4', 'has a question about the vision test appointment'],
  ['CA7bf07cb867742ba99fe012b8c2330a8e', 'patient wants to cancel'],
];

/** NextGen event names on the campaign's contacts, 2026-11-13. */
const EVENTS = ['Dilated Exam', 'Refraction Only', 'Consult', 'New Patient Exam', 'Ref+DFE', 'Diabetic Exam', 'GLE'];

const data = (event: string) => ({
  source: 'console_movable',
  appointment_id: 'appt-0001',
  person_id: 'person-0001',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  event_name: event,
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
});

let store: FakeOutboundStore;
let attemptId: string;
let fileTicket: ReturnType<typeof vi.fn>;

async function setUp(event: string) {
  store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: data(event) });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  fileTicket = vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' }));
  setNpxOutreachDepsForTests({
    npx: {
      configured: true,
      availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [], truncated: false })),
      offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: [] })),
    } as unknown as NpxOutreachClient,
    cancel: vi.fn() as never,
    store: async () => store,
    fileTicket: fileTicket as never,
  });
}

beforeEach(() => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

const run = (sid: string, name: string, extra: Record<string, unknown> = {}) =>
  getTool(name)!.handler({
    outbound_contact_id: 'c1',
    outbound_attempt_id: attemptId,
    outbound_phone: '+15555550111',
    outbound_campaign: 'npx-outreach',
    outbound_call_sid: sid,
    ...extra,
  });

/** What the ticketing app would do with the department-9 ticket we sent. */
const landsIn = (payload: { departmentId: number; description: string }) =>
  correctSurgeryIntake(payload.description, payload.departmentId)?.departmentId ?? payload.departmentId;

describe('the corpus: Refraction Only staff callbacks created in Optical (6 SIDs to 2026-11-13)', () => {
  it.each(CORPUS)('%s: the ticket names the NextGen visit and stays in the HVA Hub', async (sid, request) => {
    await setUp('Refraction Only');
    const r = (await run(sid, STAFF_CALLBACK_TOOL_NAME, { request })) as Record<string, unknown>;
    expect(r).toMatchObject({ success: true, ticket_number: 'VA-90001' });
    const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
    expect(payload.departmentId).toBe(9);
    expect(payload.description).toContain('Their appointment: Refraction Only on ');
    expect(payload.description).not.toMatch(/glasses/i);
    expect(landsIn(payload)).toBe(9);
  });

  // Operator, 2026-11-13: every NPX staff ticket says what it is on its first
  // line, and the words do not move it out of the Hub.
  it.each(CORPUS)('%s: the first line says NPX Recall', async (sid, request) => {
    await setUp('Refraction Only');
    await run(sid, STAFF_CALLBACK_TOOL_NAME, { request });
    const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
    expect(payload.description.split('\n')[0]).toMatch(/^NPX Recall: /);
    expect(landsIn({ departmentId: 9, description: payload.description.split('\n')[0] })).toBe(9);
  });
});

describe('every visit on the campaign stays in the Hub', () => {
  it.each(EVENTS)('%s', async (event) => {
    await setUp(event);
    await run('CA00000000000000000000000000000001', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
    const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
    expect(payload.description).toContain(`Their appointment: ${event} on `);
    expect(landsIn(payload)).toBe(9);
  });

  // Codex P2 on #467: the event name is a live database value, so a name
  // NextGen adds later is checked with the same classifier.
  it.each(['Glasses Check', 'CL Fit', 'Contact Lens Fitting', 'Frame Selection', 'Optical Pickup'])(
    'a future event name the classifier would route out of the Hub (%s) is written as an appointment',
    async (event) => {
      expect(landsIn({ departmentId: 9, description: event })).not.toBe(9);
      await setUp(event);
      await run('CA00000000000000000000000000000004', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
      const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
      expect(payload.description).toContain('Their appointment: An appointment on ');
      expect(payload.description).not.toContain(event);
      expect(landsIn(payload)).toBe(9);
    },
  );

  // Codex P2 on #467, round 2: the body is SMS-normalised before it is sent,
  // so the name is checked after the same normalisation.
  it.each(['Contact\u2011Lens Fitting', 'Contact\u00a0Lens Fitting', 'Contact\u2010Lens Fit'])(
    'a name that routes out only after SMS normalisation (%j) is written as an appointment',
    async (event) => {
      expect(landsIn({ departmentId: 9, description: event })).toBe(9);
      await setUp(event);
      await run('CA00000000000000000000000000000006', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
      const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
      expect(payload.description).toContain('Their appointment: An appointment on ');
      expect(landsIn(payload)).toBe(9);
    },
  );

  // Codex P2 on #467, round 3: a field-style name passes on its own, because
  // the classifier strips field prefixes at the start of a line, and routes
  // out once it sits inside the appointment line. The line is checked as sent.
  it.each(['Department: Glasses', 'Request Type: Contact Lens Fitting'])(
    'a field-style name that routes out only inside the line (%j) is written as an appointment',
    async (event) => {
      expect(landsIn({ departmentId: 9, description: event })).toBe(9);
      await setUp(event);
      await run('CA00000000000000000000000000000007', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
      const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
      expect(payload.description).toContain('Their appointment: An appointment on ');
      expect(payload.description).not.toContain(event);
      expect(landsIn(payload)).toBe(9);
    },
  );

  it('an event name the classifier keeps in the Hub is written as it is', async () => {
    expect(landsIn({ departmentId: 9, description: 'Eye Exam' })).toBe(9);
    await setUp('Eye Exam');
    await run('CA00000000000000000000000000000005', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
    const payload = fileTicket.mock.calls[0][0] as { departmentId: number; description: string };
    expect(payload.description).toContain('Their appointment: Eye Exam on ');
    expect(landsIn(payload)).toBe(9);
  });

  it('a contact with no event name still reads as an appointment, with its day, time and office', async () => {
    await setUp('');
    await run('CA00000000000000000000000000000002', STAFF_CALLBACK_TOOL_NAME, { request: 'wants to reschedule' });
    const payload = fileTicket.mock.calls[0][0] as { description: string };
    expect(payload.description).toMatch(/Their appointment: An appointment on \w+, \w+ \d+ at 9(:00)? ?AM at our Test Office office\./i);
  });
});

describe('what does not change', () => {
  it('the caller still hears the visit in plain words', async () => {
    await setUp('Refraction Only');
    const r = (await run('CA00000000000000000000000000000003', DESCRIBE_TOOL_NAME)) as Record<string, unknown>;
    expect(JSON.stringify(r)).toContain(spokenVisit('Refraction Only'));
    expect(spokenVisit('Refraction Only')).toBe('a vision test for glasses');
  });

  it('the old wording is what sent the ticket to Optical (the control)', () => {
    const old = 'The patient asked to speak with a person.\nTheir appointment: a vision test for glasses on Wednesday, March 20.';
    expect(landsIn({ departmentId: 9, description: old })).toBe(1);
  });
});
