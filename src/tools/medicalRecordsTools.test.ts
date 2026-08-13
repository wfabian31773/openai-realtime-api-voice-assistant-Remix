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
  requester: 'I am the patient',
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

    // note_requester is gone — the requester is now hard-required and refused
    // outright rather than noted after the fact, because a statutory clock
    // keys on it. The destination note remains advisory.
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

describe('a redirected ticket reports the reason it was actually filed under', () => {
  it('reports the destination reason, not the home classification', async () => {
    // A live curl on 2026-08-13 filed "my glasses broke at the hinge" into
    // Optical and reported request_reason_id 542 — department 3's catch-all,
    // which is neither on the ticket nor that department's. The number the
    // agent reads back has to be the number a person will find.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R10'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need to reschedule my appointment',
    })) as Record<string, unknown>;

    const filed = create.mock.calls[0][0].requestReasonId;
    expect(r.request_reason_id, 'reported a different reason than it filed').toBe(filed);
    expect(r.request_reason).toBe('Reschedule Existing Appointment');
  });

  it('still reports its own reason when nothing was redirected', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-R11'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      request_description: 'I need copy of my records',
    })) as Record<string, unknown>;

    expect(r.request_reason_id).toBe(create.mock.calls[0][0].requestReasonId);
    expect(r.request_reason_id).toBe(500);
  });
});

/**
 * THE CAP CLOCK.
 *
 * Azul Vision is under a Corrective Action Plan with HHS OCR over late medical
 * records, and must report on records timing for two years. A PATIENT's request
 * runs on a statutory clock; a health plan's or an attorney's does not.
 *
 * Measured 2026-08-13: all 470 mr_cases rows read pathway 'roa_patient', 421 of
 * them minted by the voice agent, and NOT ONE carries a requestor — every field
 * took its database default. At least 77 are demonstrably third-party. A
 * statutory clock is being set by a column default.
 *
 * The call is the only place the requester can be got, which is why the tool
 * refuses without it.
 */
describe('the CAP clock is set by who is asking, never by a default', () => {
  it('refuses to file without a requester', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const { requester, ...noRequester } = BASE;
    const r = (await runTool('file_records_ticket', {
      ...noRequester,
      request_description: 'I need a copy of my records',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.missingFields).toContain('requester');
    expect(r.message).toMatch(/are you the patient yourself/i);
    expect(create, 'filed a records ticket with no requester').not.toHaveBeenCalled();
  });

  const cases: Array<[string, string, boolean, string]> = [
    ['I am the patient', 'patient', true, 'roa_patient'],
    ['I have power of attorney for my mother', 'personal_representative', true, 'roa_patient'],
    ["I'm calling for my daughter", 'personal_representative', true, 'roa_patient'],
    ["calling from Dr. Warn's office", 'provider', false, 'third_party_treatment'],
    ['this is SCAN Health Plan, Medicare risk adjustment review', 'health_plan', false, 'third_party_plan'],
    ['I am an attorney at Lexitas', 'legal', false, 'third_party_legal'],
    ['Social Security disability determination', 'legal', false, 'third_party_legal'],
  ];

  for (const [requester, type, onClock, pathway] of cases) {
    it(`${type}: "${requester.slice(0, 40)}…" -> ${onClock ? 'ON' : 'OFF'} the clock`, async () => {
      const api = await client();
      const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-C1'));

      const r = (await runTool('file_records_ticket', {
        ...BASE,
        requester,
        request_description: 'copy of the chart please',
      })) as Record<string, unknown>;

      expect(r.requester_type, requester).toBe(type);
      expect(r.cap_clock_applies, requester).toBe(onClock);

      const sent = create.mock.calls[0][0];
      expect(sent.requestorType).toBe(type);
      expect(sent.capClockApplies).toBe(onClock);
      expect(sent.requestPathway).toBe(pathway);
    });
  }

  it('a personal representative stands in the patient\'s shoes', async () => {
    // HIPAA treats a personal representative as the individual. A daughter with
    // power of attorney is the same right being exercised, so the same clock.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-C2'));

    await runTool('file_records_ticket', {
      ...BASE,
      requester: 'I have power of attorney for my mother',
      request_description: 'her chart from the June visit',
    });

    expect(create.mock.calls[0][0].requestPathway).toBe('roa_patient');
  });

  it('keeps a patient on the clock even when the records go elsewhere', async () => {
    // A patient may direct their OWN records to somebody else. Read by
    // destination that is off the clock; read as a right of access it stays on
    // it. This is the open question for counsel, and the code takes the safer
    // side: wrongly ON costs a self-imposed deadline, wrongly OFF is a CAP
    // violation on the very obligation the CAP exists to police.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-C3'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      requester: 'I am the patient',
      deliver_to: "my new doctor's office, fax 555-1212",
      request_description: 'please send my chart to my new doctor',
    })) as Record<string, unknown>;

    expect(r.cap_clock_applies).toBe(true);
    expect(create.mock.calls[0][0].requestPathway).toBe('roa_patient');
  });

  it('puts the clock line first, where a clerk will see it', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-C4'));

    await runTool('file_records_ticket', {
      ...BASE,
      requester: 'this is SCAN Health Plan',
      request_description: 'chart review for risk adjustment',
    });

    const d = create.mock.calls[0][0].description as string;
    expect(d.startsWith('Third-party request'), d.slice(0, 60)).toBe(true);
    expect(d).toMatch(/NOT on the patient records clock/);
  });

  it('marks an unrecognised requester as third-party rather than assuming patient', async () => {
    // The default that caused this whole problem was 'patient'. When we cannot
    // tell, the honest answer is not the one that starts a statutory clock.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-C5'));

    const r = (await runTool('file_records_ticket', {
      ...BASE,
      requester: 'Barbara from the third floor',
      request_description: 'some records',
    })) as Record<string, unknown>;

    expect(r.requester_type).toBe('other');
    expect(r.cap_clock_applies).toBe(false);
  });
});
