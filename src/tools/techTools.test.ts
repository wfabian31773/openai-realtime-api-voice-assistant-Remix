/**
 * What file_tech_ticket must never do.
 *
 * This is the largest queue in the practice — 103 tickets a day — and it is the
 * medication queue. The failure modes are the ones that make a technician ring
 * a patient back: a reason nobody can route on, a refill with no drug named, a
 * prescription with no prescriber.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './techTools';

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

describe('patientPhone is the digits, not the raw string', () => {
  // 3 calls / 32 POSTs over 14 days filed nothing: patientPhone carried the
  // raw callback_number string, unbounded, against a receiving schema capped
  // at 20 chars. digits was already extracted and validated (>=10) two lines
  // above the old send — traced 2026-08-21.
  it('sends the stripped digits, not the caller-formatted string', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-TEST-PHONE'));

    await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'I need a refill of my Latanoprost',
    });

    expect(create.mock.calls[0][0].patientPhone).toBe('8455317471');
  });

  it('drops a leading 1, not the area code', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-TEST-PHONE-11'));

    await runTool('file_tech_ticket', {
      ...BASE,
      callback_number: '1-845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
    });

    expect(create.mock.calls[0][0].patientPhone).toBe('8455317471');
  });

  it('refuses 11 digits that do not start with 1, rather than dropping the first one', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      callback_number: '2-845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
    })) as Record<string, unknown>;

    expect(create).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect((out as { missingFields?: string[] }).missingFields).toContain('callback_number');
  });

  it('refuses a second number or an extension instead of filing a wrong one', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      callback_number: '845-531-7471 ext 202',
      request_description: 'I need a refill of my Latanoprost',
    })) as Record<string, unknown>;

    expect(create).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect((out as { missingFields?: string[] }).missingFields).toContain('callback_number');
  });
});

describe('the department is never guessed', () => {
  it('uses create-ticket and never submit-ticket', async () => {
    // VA-50811: submit-ticket re-derives the DEPARTMENT and defaults to 8.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T1'));
    const submit = vi.spyOn(api, 'submitTicket');

    await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'I need a refill of my Latanoprost',
    });

    expect(submit).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].departmentId).toBe(3);
  });
});

describe('the reason is the one the words earned', () => {
  const cases: Array<[string, number, string]> = [
    ['I need a refill of my Latanoprost', 155, 'a named glaucoma drug'],
    ['refill on the prednisolone from my surgery', 156, 'a post-surgery drop'],
    ['insurance denied my Lumigan', 210, 'an insurance block, not a refill'],
    ['my new drops are burning my eyes', 209, 'a symptom, not a refill'],
    ['I need a refill on my eye drops', 154, 'drops with no drug named'],
    ['I need to transfer my prescription to a different pharmacy', 158, 'a real transfer'],
    ['I need a copy of my medical records', 216, 'not medication at all'],
  ];

  for (const [text, reasonId, why] of cases) {
    it(`${why}: → ${reasonId}`, async () => {
      const api = await client();
      const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T2'));
      await runTool('file_tech_ticket', { ...BASE, request_description: text });
      expect(create.mock.calls[0][0].requestReasonId).toBe(reasonId);
    });
  }

  it('cannot be handed a reason from another department', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T3'));

    await runTool('file_tech_ticket', {
      ...BASE,
      request_reason_id: '42', // Surgery, New Cataract Consult
      request_description: 'I need a refill of my Latanoprost',
    });

    expect(create.mock.calls[0][0].requestReasonId).not.toBe(42);
    expect(create.mock.calls[0][0].requestReasonId).toBe(155);
  });

  it('falls to department 3 own catch-all, never to 153', async () => {
    // 153 currently carries 6,905 tickets it did not earn. It is a real reason
    // for a real request, and it is never the fallback.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T4'));
    await runTool('file_tech_ticket', { ...BASE, request_description: 'zzz qqq nothing at all' });
    expect(create.mock.calls[0][0].requestReasonId).toBe(542);
  });
});

describe('what a technician needs in front of them', () => {
  it('puts the medication and pharmacy on their own lines', async () => {
    // Both are routinely lost between the call and the ticket, and both are
    // what the refill cannot be worked without.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T5'));

    await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'I need a refill',
      medication: 'Latanoprost 0.005%',
      pharmacy: 'CVS on Foothill',
    });

    const sent = create.mock.calls[0][0].description;
    expect(sent).toMatch(/Medication: Latanoprost 0\.005%/);
    expect(sent).toMatch(/Pharmacy: CVS on Foothill/);
  });

  it('says so when no prescriber was captured', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T6'));

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'refill my drops',
    })) as Record<string, unknown>;

    expect(String(out.note)).toMatch(/no prescriber/i);
  });

  it('attaches the prescriber when one was given', async () => {
    const api = await client();
    const lookup = vi
      .spyOn(api, 'lookupProviderAndLocation')
      .mockResolvedValueOnce({ success: true, providerId: 49 } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T7'));

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'refill my drops',
      provider: 'Dwayne Logan, MD',
    })) as Record<string, unknown>;

    expect(lookup).toHaveBeenCalled();
    expect(create.mock.calls[0][0].providerId).toBe(49);
    expect(out.provider_id).toBe(49);
    expect(out.note).toBeUndefined();
  });
});

describe('priority', () => {
  it('files a glaucoma refill high — pressure rises within days', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T8'));
    await runTool('file_tech_ticket', { ...BASE, request_description: 'refill my Combigan' });
    expect(create.mock.calls[0][0].priority).toBe('high');
  });

  it('files everything else medium', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T9'));
    await runTool('file_tech_ticket', { ...BASE, request_description: 'I need a DMV form signed' });
    expect(create.mock.calls[0][0].priority).toBe('medium');
  });
});

describe('what it refuses, and what it does not', () => {
  it('refuses a partial callback number', async () => {
    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      callback_number: '845-531',
      request_description: 'refill',
    })) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(out.missingFields).toContain('callback_number');
  });

  it('files without a prescriber rather than turning the caller away', async () => {
    // A refill that reaches the queue needing a callback is recoverable. A
    // caller sent away because they cannot name their doctor is not.
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-T10'));

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'refill my glaucoma drops',
    })) as Record<string, unknown>;

    expect(out.success).toBe(true);
    expect(out.ticket_number).toBe('VA-T10');
  });

  it('reports a failed create rather than claiming success', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({
      success: false,
      error: 'Validation failed',
    } as never);

    const out = (await runTool('file_tech_ticket', {
      ...BASE,
      request_description: 'refill',
    })) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/Validation failed/);
  });
});
