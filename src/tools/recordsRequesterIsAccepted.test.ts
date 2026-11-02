/**
 * v166, ticket 70298: the caller said "I'm the patient", and
 * `file_records_ticket` refused the `requester` field on every attempt — the
 * model had put the answer in `requester_type` and left `requester` empty
 * ("The system wants that in the requester field itself"). And a bare
 * `requester: "patient"` classified as `other`, off the records clock.
 * Synthetic names and numbers only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const stored = new Map<string, { params: Record<string, unknown> }>();
const writeToOutbox = vi.fn();
const attemptSend = vi.fn();
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox, attemptSend } };
});

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./medicalRecordsTools');
const { resetGateAttempts } = await import('./gateAttempts');
const { resetVerifiedIdentities } = await import('./verifiedIdentity');
const { classifyRequester, normalizeRequesterType, requesterProseFor, resolveRequesterType } = await import(
  './medicalRecordsTaxonomy'
);

const SID = 'CA0123456789abcdef0123456789abc298';

const PATIENT_REQUEST = {
  first_name: 'Synthia',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  callback_number: '845-555-0142',
  request_description: 'a copy of my records from the last visit',
  form_channel: 'declined',
  deliver_to: 'to the patient',
  date_range: 'the last visit',
  call_sid: SID,
};

async function app() {
  const api = (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
  const spy = vi.spyOn(api, 'createTicket').mockResolvedValue({ success: true, ticketNumber: 'VA-REQ-1' } as never);
  return () => spy.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  stored.clear();
  writeToOutbox.mockReset();
  attemptSend.mockReset();
  writeToOutbox.mockImplementation(async (payload: { params: Record<string, unknown> }) => {
    const outboxId = `ob-${stored.size}`;
    stored.set(outboxId, payload);
    return { outboxId, alreadyExists: false };
  });
  attemptSend.mockImplementation(async (outboxId: string) => {
    const api = (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
    const res = await api.createTicket(stored.get(outboxId)!.params as never);
    return { ...res, outboxId };
  });
});

describe('the requester as the model actually sends it', () => {
  it('70298: requester_type "patient" with no requester files, on the clock', async () => {
    const posts = await app();
    const r = (await runTool('file_records_ticket', { ...PATIENT_REQUEST, requester_type: 'patient' })) as Record<
      string,
      unknown
    >;
    expect(r.missingFields).toBeUndefined();
    expect(r.success).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].requestorType).toBe('patient');
    expect(posts()[0].capClockApplies).toBe(true);
  });

  it('requester_type "self" is the patient too', async () => {
    const posts = await app();
    await runTool('file_records_ticket', { ...PATIENT_REQUEST, requester_type: 'self' });
    expect(posts()[0].requestorType).toBe('patient');
  });

  it('a bare requester "patient" is the patient, not "other" off the clock', async () => {
    const posts = await app();
    await runTool('file_records_ticket', { ...PATIENT_REQUEST, requester: 'patient' });
    expect(posts()[0].requestorType).toBe('patient');
    expect(posts()[0].capClockApplies).toBe(true);
  });

  it('with neither field the requester is still asked, once', async () => {
    const posts = await app();
    const r = (await runTool('file_records_ticket', PATIENT_REQUEST)) as Record<string, unknown>;
    expect(r.missingFields).toEqual(['requester']);
    expect(posts()).toHaveLength(0);
  });
});

describe('normalizeRequesterType', () => {
  it('maps what models write onto the enum', () => {
    expect(normalizeRequesterType('patient')).toBe('patient');
    expect(normalizeRequesterType('Self')).toBe('patient');
    expect(normalizeRequesterType('the patient yourself')).toBe('patient');
    expect(normalizeRequesterType('personal representative')).toBe('personal_representative');
    expect(normalizeRequesterType('family member')).toBe('personal_representative');
    expect(normalizeRequesterType("doctor's office")).toBe('provider');
    expect(normalizeRequesterType('health_plan')).toBe('health_plan');
    expect(normalizeRequesterType('insurance')).toBe('health_plan');
    expect(normalizeRequesterType('attorney')).toBe('legal');
    expect(normalizeRequesterType('')).toBeUndefined();
    expect(normalizeRequesterType('banana')).toBeUndefined();
  });

  it("never reads a possessive as the patient: the patient's attorney is legal", () => {
    expect(normalizeRequesterType("the patient's attorney")).toBe('legal');
    expect(classifyRequester("the patient's attorney")).toBe('legal');
  });

  it('the prose a type stands for classifies back to the same type', () => {
    for (const t of ['patient', 'personal_representative', 'provider', 'health_plan', 'legal'] as const) {
      expect(classifyRequester(requesterProseFor(t)), t).toBe(t);
    }
  });

  it('a stated off-clock type still cannot take a patient off the clock', () => {
    expect(resolveRequesterType(normalizeRequesterType('attorney'), classifyRequester('I am the patient'))).toBe(
      'patient',
    );
  });
});
