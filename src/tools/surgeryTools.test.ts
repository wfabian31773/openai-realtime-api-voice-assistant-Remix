/**
 * What file_surgery_ticket must never do, expressed as tests.
 *
 * The two failures this queue is built to prevent are both silent: a ticket
 * that carries a reason it did not earn, and a ticket that reaches the wrong
 * department. Neither shows up as an error anywhere — the first looks like a
 * classified ticket and the second looks like a filed one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './surgeryTools';

const BASE = {
  first_name: 'Wayne',
  last_name: 'Fabian',
  date_of_birth: '03/17/1973',
  callback_number: '845-531-7471',
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the department is never guessed', () => {
  it('uses create-ticket and never submit-ticket, even with no classification', async () => {
    // VA-50811: the Optical agent's submit-ticket fallback filed into
    // department 8, After Hours Call Service, assigned to nobody. submit-ticket
    // re-derives the DEPARTMENT, not just the reason. For Surgery the
    // unclassifiable case is the majority of calls, so this path would have
    // sent more than half the queue there.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-1' } as never);
    const submit = vi.spyOn(api, 'submitTicket');

    const out = await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'my surgery is Monday and the drops never came',
      description_prefix: 'PRE-OP DROPS / RX',
    });

    expect(submit).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].departmentId).toBe(2);
    expect(out).toMatchObject({ success: true, ticket_number: 'VA-TEST-1' });
  });
});

describe('every ticket carries a reason the request actually earned', () => {
  // THIS BLOCK USED TO TEST A PLACEHOLDER. When it was written, the only reasons
  // department 2 had were procedure boxes, create-ticket refuses an incomplete
  // triple, and so an unclassifiable call — the majority of this queue — had to
  // borrow reason 43, Surgery Scheduling, with the truth pushed into a
  // description prefix.
  //
  // Operator, 2026-08-12: "why don't you create one? Create another reason, to
  // satisfy the nulls, the ones that we can't quantify." Request type 65,
  // "Surgery Logistics", now exists on department 2 with the six measured
  // reasons (529-534) and a catch-all (535). There is nothing left to borrow
  // and nothing left to smuggle through a prefix.

  it('files a deposit question as Deposit / Balance Question, not as a cataract consult', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-2' } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'nobody has called me back about my surgery deposit',
    })) as Record<string, unknown>;

    const sent = create.mock.calls[0][0];
    expect(sent.requestTypeId).toBe(65);
    expect(sent.requestReasonId).toBe(533);
    expect(out.request_reason).toBe('Deposit / Balance Question');
  });

  it('files drops that never arrived as Pre-Op Drops / Prescription', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-3' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'my surgery is Monday and the eye drops never came',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(529);
  });

  it('does not mangle the description any more — no prefix is needed', async () => {
    // The prefix existed only because the reason id was a lie. It is gone, and
    // the description is now just what the caller said.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-4' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'I need to move my surgery to a different day',
    });

    const sent = create.mock.calls[0][0];
    expect(sent.description).toBe('I need to move my surgery to a different day');
    expect(sent.requestReasonId).toBe(531); // Reschedule / Cancel Surgery
  });

  it('falls to the catch-all only when nothing at all matches', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-5' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'zzz qqq nothing resembling any request',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(535); // Other - See Description
  });

  it('a procedure reason still beats a logistics one', async () => {
    // "move my post-op appointment" is a post-op matter that happens to involve
    // a date. The procedure reason is the more specific of the two.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-6' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'I need to move my post-op appointment to the morning',
    });

    expect(create.mock.calls[0][0].requestReasonId).toBe(46); // Post-Op Follow-Up
  });

  it('never files a reason from another department', async () => {
    // 153 is the Technicians-Support medication-refill reason that 1,443
    // surgery tickets carried until June. An agent naming it explicitly must
    // not be able to put it back.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-7' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_reason_id: '153',
      request_description: 'my surgery is Monday and the eye drops never came',
    });

    expect(create.mock.calls[0][0].requestReasonId).not.toBe(153);
    expect(create.mock.calls[0][0].requestReasonId).toBe(529);
  });
});

describe('priority', () => {
  it('files a retinal detachment as urgent without being told', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-6' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'there is a curtain over my left eye since this morning',
    });

    expect(create.mock.calls[0][0].priority).toBe('urgent');
  });

  it('files everything else as medium', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-7' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'what time should I arrive on Thursday',
    });

    expect(create.mock.calls[0][0].priority).toBe('medium');
  });
});

describe('what it refuses, and what it does not', () => {
  it('refuses a partial callback number', async () => {
    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      callback_number: '845-531',
      request_description: 'anything',
    })) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(out.missingFields).toContain('callback_number');
    expect(String(out.message)).toMatch(/ten digits/i);
  });

  it('files WITHOUT a location — unlike Optical, which refuses', async () => {
    // Optical refuses because one optician per office IS its assignment rule.
    // Surgery assigns 3,396 of 3,446 tickets and only 3 of the 50 unassigned
    // lacked a location. Copying the refusal would cost real calls to prevent
    // a failure this queue does not have.
    const api = await client();
    const lookup = vi.spyOn(api, 'lookupProviderAndLocation');
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-8' } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'I never got my clearance form',
    })) as Record<string, unknown>;

    expect(out.success).toBe(true);
    expect(out.location_id).toBeNull();
    // No name to resolve means no reason to call the resolver at all.
    expect(lookup).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].departmentId).toBe(2);
  });

  it('reports a failed create rather than claiming success', async () => {
    // The dedup case: create-ticket can return a ticket that already existed.
    // VA-50803 was reported to the operator as filed when it was not.
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({
      success: false,
      error: 'Validation failed',
    } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'anything',
    })) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/Validation failed/);
    expect(out.retryable).toBe(true);
  });
});
