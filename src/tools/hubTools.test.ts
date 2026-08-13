/**
 * What file_hub_ticket must never do.
 *
 * Two failures matter more than the rest on this line:
 *
 *   1. Filing a reason that is not department 9's. 224 tickets carry reason 153
 *      today, which belongs to department 3, put there by a hardcoded fallback.
 *   2. Implying the appointment is booked. This queue takes requests; it cannot
 *      see the schedule and cannot hold a slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './hubTools';

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

describe('reason 153 cannot happen here', () => {
  it('ignores it when the agent names it explicitly', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H1'));

    await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need to reschedule my appointment',
      request_reason_id: '153',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(147);
  });

  it('only ever files a department 9 reason', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(ok('VA-H2'));

    for (const text of [
      'I need a new appointment',
      'cancel my appointment',
      'cornea specialist consultation',
      'pre-authorization request',
      'she needs an interpreter',
      'something with no category at all',
    ]) {
      await runTool('file_hub_ticket', { ...BASE, request_description: text });
    }

    const allowed = new Set([146, 147, 148, 149, 150, 151, 152, 178, 179, 180, 181, 182, 183, 193, 196, 293, 294, 539]);
    for (const call of create.mock.calls) {
      expect(allowed, `reason ${call[0].requestReasonId}`).toContain(call[0].requestReasonId);
    }
  });

  it('uses create-ticket and never submit-ticket', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H3'));
    const submit = vi.spyOn(api, 'submitTicket');

    await runTool('file_hub_ticket', { ...BASE, request_description: 'I need an appointment' });

    expect(submit).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].departmentId).toBe(9);
  });
});

describe('it does not let the agent claim a booking', () => {
  it('tells the agent to say the team will call, not that it is booked', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H4'));

    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need an appointment next week',
    })) as Record<string, unknown>;

    expect(r.message).toMatch(/do NOT say the appointment is booked/i);
    expect(r.message).toMatch(/scheduling team will call/i);
  });
});

describe('a same-day request is time-critical by definition', () => {
  it('files it high', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H5'));

    await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'can I be seen today, my eye is bothering me',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(151);
    expect(create.mock.calls[0][0].priority).toBe('high');
  });

  it('files an ordinary booking at medium', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H6'));

    await runTool('file_hub_ticket', { ...BASE, request_description: 'I need an appointment sometime next month' });

    expect(create.mock.calls[0][0].priority).toBe('medium');
  });
});

describe('the three facts a scheduler works from reach the ticket', () => {
  it('puts the doctor, availability and interpreter language on their own lines', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H7'));

    await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'New patient wants an eye exam',
      provider: 'Dr. Nuha',
      location: 'Redlands',
      availability: 'weekday mornings, not Fridays',
      interpreter_language: 'Spanish',
    });

    const d = create.mock.calls[0][0].description as string;
    expect(d).toMatch(/Doctor requested: Dr\. Nuha/);
    expect(d).toMatch(/Availability: weekday mornings/);
    expect(d).toMatch(/Interpreter needed: Spanish/);
  });

  it('says plainly when the office or availability is missing', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H8'));

    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need an appointment',
    })) as Record<string, unknown>;

    expect(r.note_location).toMatch(/which office/i);
    expect(r.note_availability).toMatch(/which days or times/i);
  });
});

describe('a caller who reached the wrong line is not sent away', () => {
  it('routes a refill to Clinical Tech Support', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H9'));

    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need a refill on my eye drops',
    })) as Record<string, unknown>;

    expect(create.mock.calls[0][0].departmentId).toBe(3);
    expect(r.routed_to).toBe('Clinical Tech Support');
  });

  it('keeps a scheduling request here rather than redirecting to itself', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-H10'));

    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need to reschedule my appointment',
    })) as Record<string, unknown>;

    expect(create.mock.calls[0][0].departmentId).toBe(9);
    expect(r.routed_to).toBeUndefined();
  });
});

describe('the things that make a scheduler ring the patient back', () => {
  it('refuses a partial callback number with a speakable line', async () => {
    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      callback_number: '845-531',
      request_description: 'I need an appointment',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/ten digits/i);
  });

  it('reports a failed filing rather than claiming a ticket', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({ success: false, error: 'upstream 503' } as never);

    const r = (await runTool('file_hub_ticket', {
      ...BASE,
      request_description: 'I need an appointment',
    })) as Record<string, unknown>;

    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
  });
});
