/**
 * WHAT ACTUALLY REACHES THE TICKET when the date-of-birth escape fires.
 *
 * `dobEscape.test.ts` proves the decision. This proves the PAYLOAD, by
 * capturing what the four filing tools hand to `createTicketDurable` — because
 * a source-scan would only prove a line exists, not that it behaves
 * (`.agents/memory/measurement-traps.md`), and the operator's ruling is
 * specifically about what a human sees on the ticket:
 *
 *   *"When you file it, where date of birth would be, you just put unavailable
 *   or unmatched. So this way we know what was happening, and then hopefully
 *   we can get the transcript, the voice recording."*
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

// Typed with its parameter so `mock.calls` is not inferred as an empty tuple —
// which is what silently made an earlier version of this file un-typecheckable
// while still passing at runtime.
const createTicketDurable = vi.fn(async (_payload: Record<string, unknown>) => ({
  success: true as const,
  ticketNumber: 'VA-90001',
}));
vi.mock('../services/durableTicketFiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/durableTicketFiling')>();
  return { ...actual, createTicketDurable };
});

const { runTool } = await import('./registry');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');

const LANES = [
  'file_optical_ticket',
  'file_surgery_ticket',
  'file_tech_ticket',
  'file_records_ticket',
] as const;

let n = 0;
const freshSid = () => `CA${(++n + 0xabc000).toString(16).padStart(32, '0')}`;

const file = (tool: string, sid: string, dob?: string) =>
  runTool(tool, {
    first_name: 'Testpatient', last_name: 'Example',
    callback_number: '5555550100', request_description: 'my drops ran out',
    requester: 'patient', location: 'Northridge', call_sid: sid,
    ...(dob === undefined ? {} : { date_of_birth: dob }),
  });

beforeEach(async () => {
  createTicketDurable.mockClear();
  const { resetGateAttempts } = await import('./gateAttempts');
  resetGateAttempts();
});

describe('the ticket a caller gets when we never got their date of birth', () => {
  it('is filed at all — on every lane', async () => {
    for (const tool of LANES) {
      const sid = freshSid();
      await file(tool, sid);          // asked once
      await file(tool, sid);          // and now it goes
      expect(createTicketDurable, tool).toHaveBeenCalled();
    }
  });

  /**
   * THE STATUS IS FOR STAFF, AND THE DESCRIPTION IS AN SMS BODY.
   *
   * It was prepended to `description`, which becomes the body of a
   * patient-facing text — so the caller would have been sent "Confirm
   * identity from the call recording before matching this to a chart"
   * (Codex, PR #268 round 5; BACKEND_HANDOFF section 6 lists this exact
   * mistake as one caught in review before).
   *
   * The operator's ruling is that STAFF should know what happened, and
   * callData carries it to the ticket's own call-metadata columns, which no
   * message to the patient reads.
   */
  it('says UNAVAILABLE to STAFF, and never in the patient-facing description', async () => {
    for (const tool of LANES) {
      createTicketDurable.mockClear();
      const sid = freshSid();
      await file(tool, sid);
      await file(tool, sid);
      const calls = createTicketDurable.mock.calls;
      const payload = calls[calls.length - 1]?.[0] as any;
      expect(String(payload.callData?.transcript ?? ''), tool).toContain('DATE OF BIRTH UNAVAILABLE');
      expect(String(payload.description), tool).not.toContain('DATE OF BIRTH');
      expect(String(payload.description), tool).not.toContain('recording');
      // The caller's own words are what the description carries.
      expect(String(payload.description), tool).toContain('my drops ran out');
    }
  });

  it('says UNMATCHED instead when they gave something unreadable', async () => {
    for (const tool of LANES) {
      createTicketDurable.mockClear();
      const sid = freshSid();
      await file(tool, sid, 'sometime in the seventies');
      await file(tool, sid, 'sometime in the seventies');
      const calls = createTicketDurable.mock.calls;
      const payload = calls[calls.length - 1]?.[0] as any;
      const staff = String(payload.callData?.transcript ?? '');
      expect(staff, tool).toContain('DATE OF BIRTH UNMATCHED');
      expect(staff, tool).toContain('recording');
      expect(String(payload.description), tool).not.toContain('DATE OF BIRTH');
    }
  });

  it('sends no staff note at all when the date read fine', async () => {
    for (const tool of LANES) {
      createTicketDurable.mockClear();
      await file(tool, freshSid(), 'March 17, 1973');
      const calls = createTicketDurable.mock.calls;
      const payload = calls[calls.length - 1]?.[0] as any;
      expect(payload.callData?.transcript, tool).toBeUndefined();
    }
  });

  /**
   * The columns are varchar(2)/(2)/(4) in the ticketing app, so the word could
   * not be stored there even if we sent it — and a rejected payload loses the
   * whole request, which is the opposite of the point. They are omitted.
   */
  it('sends NO birth fields rather than a word that cannot fit the column', async () => {
    for (const tool of LANES) {
      createTicketDurable.mockClear();
      const sid = freshSid();
      await file(tool, sid);
      await file(tool, sid);
      const calls = createTicketDurable.mock.calls;
      const payload = calls[calls.length - 1]?.[0] as any;
      expect(payload.patientBirthMonth, tool).toBeUndefined();
      expect(payload.patientBirthDay, tool).toBeUndefined();
      expect(payload.patientBirthYear, tool).toBeUndefined();
    }
  });

  it('still sends the birth fields normally when the date DID read', async () => {
    for (const tool of LANES) {
      createTicketDurable.mockClear();
      await file(tool, freshSid(), 'March 17, 1973');
      const calls = createTicketDurable.mock.calls;
      const payload = calls[calls.length - 1]?.[0] as any;
      expect(payload.patientBirthMonth, tool).toBe('03');
      expect(payload.patientBirthDay, tool).toBe('17');
      expect(payload.patientBirthYear, tool).toBe('1973');
      expect(String(payload.description), tool).not.toContain('DATE OF BIRTH');
    }
  });
});
