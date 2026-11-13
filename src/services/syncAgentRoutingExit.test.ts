/**
 * v186 — THE SINK READS A ROUTING REFUSAL IN EITHER WORDING AND CARRIES THE
 * EXIT FLAG. See src/agents/noIvrRoutingFieldAskedOnce.test.ts for the corpus.
 *
 * /submit-ticket names a routing field two ways: "Missing required
 * information: surgeon name" / "…: location", and, when the caller DID name
 * one the app could not match, "The surgeon "X" was not found in our system"
 * or "The office "X" was not recognized / matches more than one". The second
 * wording carried no field the client could read, so it fell to the
 * technical-issue apology: CA93323bf5677ec2d8fad28ff0c014f0b1 (2026-10-27).
 * Same mock preamble as syncAgentReadsTheAppsRefusal.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// v223: syncAgentService imports the tool timeline, which opens the database
// at import (server/db). Nothing in this file reaches the database.
vi.mock('../../server/db', () => ({ db: {} }));

const h = vi.hoisted(() => ({
  claimTicketCreation: vi.fn(),
  releaseTicketCreationLock: vi.fn(),
  getCallLogBySid: vi.fn(),
  submitTicket: vi.fn(),
  resolveTicketLookupFields: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    claimTicketCreation: h.claimTicketCreation,
    releaseTicketCreationLock: h.releaseTicketCreationLock,
    getCallLogBySid: h.getCallLogBySid,
  },
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: { submitTicket: h.submitTicket } }));
vi.mock('./ticketFieldSanitizers', () => ({
  resolveTicketLookupFields: h.resolveTicketLookupFields,
  sanitizeTicketLookupFields: vi.fn((x: unknown) => x),
}));

import { SyncAgentService } from './syncAgentService';
import { missingFieldsFromRefusal, routingFieldFromRefusal } from './missingFieldsRefusal';

const params = {
  patientFullName: 'Test Sample',
  patientDOB: '1958-01-04',
  reasonForCalling: 'A question about surgery aftercare',
  preferredContactMethod: 'phone' as const,
  patientPhone: '5551234567',
  callSid: 'CA00000000000000000000000000000e86',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.claimTicketCreation.mockResolvedValue({ claimed: true });
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.getCallLogBySid.mockResolvedValue(undefined);
  h.resolveTicketLookupFields.mockResolvedValue({});
});

/** The app's words, verbatim from lib/services/voice-agent-ticket-service.ts. */
const NOT_FOUND = {
  surgeon: 'The surgeon "Dr. Notonfile" was not found in our system — please confirm the surgeon\'s name.',
  office: 'The office "Nowhere" was not recognized — please confirm which Azul Vision office the patient visits (e.g. the city).',
  ambiguous: 'The office "Twin City" matches more than one Azul Vision office (A or B) — please ask which one the patient visits.',
};

describe('the refusal reader', () => {
  it('reads both routing wordings, and nothing else as routing', () => {
    expect(routingFieldFromRefusal('Missing required information: surgeon name. Surgery tickets are assigned by surgeon')).toBe('surgeon name');
    expect(routingFieldFromRefusal('Missing required information: location. Optical tickets are assigned by office')).toBe('location');
    expect(routingFieldFromRefusal(NOT_FOUND.surgeon)).toBe('surgeon name');
    expect(routingFieldFromRefusal(NOT_FOUND.office)).toBe('location');
    expect(routingFieldFromRefusal(NOT_FOUND.ambiguous)).toBe('location');
    expect(routingFieldFromRefusal('Missing required information: patientPhone')).toBeNull();
    expect(routingFieldFromRefusal('Request timed out')).toBeNull();
    expect(routingFieldFromRefusal(undefined)).toBeNull();
  });

  it('a combined refusal keeps every field, wherever the routing one sits (Codex P2, #436)', () => {
    expect(missingFieldsFromRefusal('Missing required information: location, patientEmail')).toEqual(['location', 'patientEmail']);
    expect(routingFieldFromRefusal('Missing required information: location, patientEmail')).toBe('location');
    expect(missingFieldsFromRefusal('Missing required information: patientEmail, surgeon name. Surgery tickets are assigned by surgeon')).toEqual(['patientEmail', 'surgeon name']);
    expect(routingFieldFromRefusal('Missing required information: patientEmail, surgeon name. Surgery tickets are assigned by surgeon')).toBe('surgeon name');
  });

  it('a not-found name is a missing field, not an outage', () => {
    expect(missingFieldsFromRefusal(NOT_FOUND.surgeon)).toEqual(['surgeon name']);
    expect(missingFieldsFromRefusal(NOT_FOUND.office)).toEqual(['location']);
    expect(missingFieldsFromRefusal('Ticketing service is temporarily unavailable. Please try again.')).toBeNull();
  });
});

describe('the sink', () => {
  it('turns the not-found wording into the shape the after-hours agent matches', async () => {
    h.submitTicket.mockResolvedValue({ success: false, errorCode: 'request_failed', error: NOT_FOUND.surgeon });
    const r = await SyncAgentService.submitSimplifiedTicket(params);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Missing required information: surgeon name');
  });

  it('carries the exit flag to the client only when it is set', async () => {
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST' });
    await SyncAgentService.submitSimplifiedTicket({ ...params, routingAskExhausted: true });
    expect(h.submitTicket.mock.calls[0][0].routingAskExhausted).toBe(true);
    await SyncAgentService.submitSimplifiedTicket(params);
    expect('routingAskExhausted' in h.submitTicket.mock.calls[1][0]).toBe(false);
  });
});
