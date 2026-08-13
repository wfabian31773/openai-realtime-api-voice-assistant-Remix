/**
 * What file_records_ticket must never do.
 *
 * 453 of this department's 495 tickets carry no reason at all, so almost any
 * classification is an improvement — which is exactly the condition under which
 * a wrong one slips through unnoticed. These tests pin the behaviours that
 * would matter to a records clerk holding the ticket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';

const BASE = {
  first_name: 'Wayne',
  last_name: 'Fabian',
  date_of_birth: '03/17/1973',
  callback_number: '845-531-7471',
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

function ok(n: string) {
  return { success: true, ticketNumber: n } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the department is never guessed', () => {
  it('uses create-ticket and never submit-ticket', async () => {
    // submit-ticket re-derives the DEPARTMENT server-side and defaults to 8.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R1'));
    const submit = vi.spyOn(api, 'submitTicket');

    await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need a copy of my medical records',
    });

    expect(submit).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].departmentId).toBe(16);
  });

  it('only ever files a department 16 reason', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(ok('VA-R2'));

    for (const text of [
      'copy of my records',
      'fax my chart to Dr. Warn',
      'records for my attorney',
      "I need a doctor's note",
      'I want to review my chart',
      'something else entirely',
    ]) {
      await runTool('file_records_ticket', { ...BASE, request_description: text });
    }

    for (const call of create.mock.calls) {
      expect([500, 501, 502, 503, 504, 547]).toContain(call[0].requestReasonId);
    }
  });

  it('ignores a reason id belonging to another department', async () => {
    // 153 is department 3's. An agent that names it must not be obeyed.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R3'));

    await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need a copy of my records',
      request_reason_id: '153',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(500);
  });
});

describe('the reason is the one the words earned', () => {
  const cases: Array<[string, number, string]> = [
    ['Medical records request for Social Security office', 503, 'a benefits requester'],
    ['Please fax the records to Dr. Warn', 502, 'a clinician destination'],
    ["Patient needs a doctor's note for injection days", 504, 'a note, not a chart copy'],
    ['I would like to come in and review my chart', 501, 'reading, not receiving'],
    ['I need copy of my records', 500, 'the plain patient request'],
  ];

  for (const [text, reasonId, why] of cases) {
    it(`${why}: "${text.slice(0, 40)}…" -> ${reasonId}`, async () => {
      const api = await client();
      const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R4'));

      await runTool('file_records_ticket', { ...BASE, request_description: text });

      expect(create.mock.calls[0][0].requestReasonId).toBe(reasonId);
    });
  }
});

describe('the two facts this queue turns on reach the clerk', () => {
  it('puts the requester, destination and dates on their own lines', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R5'));

    await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'Needs the chart from the July visit',
      requester: "Dr. Warn's office, Oklahoma",
      deliver_to: 'fax 580-250-5808',
      date_range: 'July 2026 visit only',
    });

    const d = create.mock.calls[0][0].description as string;
    expect(d).toMatch(/Requested by: Dr\. Warn's office/);
    expect(d).toMatch(/Send to: fax 580-250-5808/);
    expect(d).toMatch(/Dates needed: July 2026/);
  });

  it('says plainly when they are missing, so the agent can still ask', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R6'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need my records',
    })) as Record<string, unknown>;

    expect(r.note_requester).toMatch(/who is asking/i);
    expect(r.note_destination).toMatch(/where these should be sent/i);
  });

  it('does not tell the agent to promise anything', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R7'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need my records',
    })) as Record<string, unknown>;

    // Release requires a signed authorization, which this agent does not
    // handle. The closing line must not imply the records are on their way.
    expect(r.message).toMatch(/do not promise a date/i);
  });
});

describe('a caller who reached the wrong line is not sent away', () => {
  it('routes an appointment request to the HVA Hub', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R8'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'while I have you, I need to reschedule my appointment',
    })) as Record<string, unknown>;

    expect(create.mock.calls[0][0].departmentId).toBe(9);
    expect(create.mock.calls[0][0].requestTypeId).toBe(32);
    expect(r.routed_to).toBe('HVA Hub');
    expect(create.mock.calls[0][0].description).toMatch(/routed here/i);
  });

  it('does NOT route a records request away just because it names a surgery', async () => {
    // Real department 16 ticket: "requesting the notes from the sx she had on
    // 7/30/26… as pcp has not gotten the report". A keyword-happy detector
    // would hand this to Surgery Coordination and the records team would never
    // see it.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R9'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'the notes from the surgery she had on 7/30, her pcp has not gotten the report',
    })) as Record<string, unknown>;

    expect(create.mock.calls[0][0].departmentId).toBe(16);
    expect(r.routed_to).toBeUndefined();
  });
});

describe('the things that make a clerk ring the patient back', () => {
  it('refuses a partial callback number with a speakable line', async () => {
    const r = (await runTool('file_records_ticket', {
      ...BASE,
      callback_number: '845-531',
      request_description: 'copy of my records',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.missingFields).toContain('callback_number');
    expect(r.message).toMatch(/ten digits/i);
  });

  it('refuses a date of birth it could not read', async () => {
    const r = (await runTool('file_records_ticket', {
      ...BASE,
      date_of_birth: 'sometime in the spring',
      request_description: 'copy of my records',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.missingFields).toContain('date_of_birth');
  });

  it('reports a failed filing rather than claiming a ticket', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({ success: false, error: 'upstream 503' } as never);

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'copy of my records',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
  });
});
