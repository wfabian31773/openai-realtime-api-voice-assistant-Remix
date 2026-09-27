/**
 * THE SINK READS THE APP'S REFUSAL IN THE APP'S OWN WORDS.
 *
 * `submitSimplifiedTicket` is the one method every hand-built `create_ticket`
 * (no-ivr, answering-service, after-hours) files through, and it is where the
 * ticketing app's refusal is turned into the shape those agents match:
 * `Missing required information: <fields>`. It wrote that shape from
 * `response.missingFields` — and on every REAL refusal that array is
 * undefined, because the client throws on a 4xx with the body's `error` text
 * and `submitTicket` catches it into `{ errorCode: 'request_failed', error }`.
 * So the branch fired on nothing, the raw text went out, and the agents' match
 * missed: CA42f5b35d3924b8a1e5e66c00ee927742, 2026-09-27, spoken as a
 * technical failure over a request that was never filed.
 *
 * Same mock preamble as syncAgentContentionWaitsForTheWriteBack.test.ts, with
 * the lock claimed so the POST is reached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { submitTicket: h.submitTicket },
}));
vi.mock('./ticketFieldSanitizers', () => ({
  resolveTicketLookupFields: h.resolveTicketLookupFields,
  sanitizeTicketLookupFields: vi.fn((x: unknown) => x),
}));

import { SyncAgentService } from './syncAgentService';

const CALL_SID = 'CA00000000000000000000000000000e01';
const params = {
  patientFullName: 'Test Caller',
  patientDOB: '1958-01-04',
  reasonForCalling: "Needs to move next week's appointment",
  preferredContactMethod: 'email' as const,
  patientPhone: '5551234567',
  callSid: CALL_SID,
};

/**
 * What `submitTicket` actually returns for the app's 400 on the corpus call:
 * the client's catch, carrying the body's `error` text and nothing else. The
 * text is verbatim from `voice_agent_api_logs.response_body`.
 */
const CLIENT_SHAPE_OF_THE_APP_REFUSAL = {
  success: false,
  errorCode: 'request_failed',
  error:
    'Missing required fields: patientEmail. Please collect these from the patient before submitting., missing: patientEmail',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.claimTicketCreation.mockResolvedValue({ claimed: true });
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.getCallLogBySid.mockResolvedValue(undefined);
  h.resolveTicketLookupFields.mockResolvedValue({});
});

describe("the app's refusal, as the client hands it over", () => {
  it('comes back in the shape every agent on this path matches', async () => {
    h.submitTicket.mockResolvedValue(CLIENT_SHAPE_OF_THE_APP_REFUSAL);
    const r = await SyncAgentService.submitSimplifiedTicket(params);

    expect(r.success).toBe(false);
    expect(r.error).toBe('Missing required information: patientEmail');
    // The model-facing message names the field in words, with the format.
    expect(r.message).toMatch(/email address/);
    expect(r.message).toMatch(/letter by letter/);
    // And the lock is given back, so the retry the question invites can file.
    expect(h.releaseTicketCreationLock).toHaveBeenCalledWith(CALL_SID);
  });

  it('the array path still works when the client DOES carry missingFields', async () => {
    h.submitTicket.mockResolvedValue({ success: false, error: 'refused', missingFields: ['patientPhone'] });
    const r = await SyncAgentService.submitSimplifiedTicket(params);
    expect(r.error).toBe('Missing required information: patientPhone');
    expect(r.message).toMatch(/ten digits/);
  });
});

/** An outage is still an outage: the generic shape survives for what is not a refusal. */
describe('what is not a refusal is not turned into one', () => {
  it.each([
    'Ticketing API timeout after 15000ms - please try again',
    'Ticketing service is temporarily unavailable. Please try again.',
    'HTTP 500 error',
  ])('%s stays a generic failure', async (error) => {
    h.submitTicket.mockResolvedValue({ success: false, errorCode: 'request_failed', error });
    const r = await SyncAgentService.submitSimplifiedTicket(params);
    expect(r.success).toBe(false);
    expect(r.error).toBe(error);
    expect(r.error).not.toMatch(/^Missing required information/);
  });
});
