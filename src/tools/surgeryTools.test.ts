/**
 * What file_surgery_ticket must never do, expressed as tests.
 *
 * The two failures this queue is built to prevent are both silent: a ticket
 * that carries a reason it did not earn, and a ticket that reaches the wrong
 * department. Neither shows up as an error anywhere — the first looks like a
 * classified ticket and the second looks like a filed one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// The surgeon fallback reads the schedule, and that module opens a database
// client at import time. Same guard the other suites use.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool, getTool } from './registry';
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

describe('patientPhone is the digits, not the raw string', () => {
  // 3 calls / 32 POSTs over 14 days filed nothing: `patientPhone` carried the
  // raw callback_number string, which has no upper bound, against a receiving
  // schema capped at 20 chars. `digits` was already extracted and validated
  // (>=10 digits) two lines above the old send — traced 2026-08-21.
  it('sends the stripped digits, not the caller-formatted string', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-PHONE' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'a question about my upcoming procedure',
    });

    expect(create.mock.calls[0][0].patientPhone).toBe('8455317471');
  });

  it('drops a leading 1, not the area code', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-PHONE-11' } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      callback_number: '1-845-531-7471',
      request_description: 'a question about my upcoming procedure',
    });

    expect(create.mock.calls[0][0].patientPhone).toBe('8455317471');
  });

  it('refuses 11 digits that do not start with 1, rather than dropping the first one', async () => {
    // normalizePhone() is slice(-10) — correctly loose for the lookup use it
    // was written for, but silently dropping a wrong leading digit here
    // would produce a plausible, wrong, 10-digit number. Same failure shape
    // the ceiling above exists to prevent, one digit narrower.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      callback_number: '2-845-531-7471',
      request_description: 'a question about my upcoming procedure',
    })) as Record<string, unknown>;

    expect(create).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect((out as { missingFields?: string[] }).missingFields).toContain('callback_number');
  });

  it('refuses a second number or an extension instead of filing a wrong one', async () => {
    // The failure this ceiling exists to prevent: a raw digit count with no
    // upper bound would have normalized a two-number or extension capture
    // down to a plausible-looking (and wrong) 10 digits, filing a ticket
    // with a callback number nobody could reach. That is worse than the
    // loud 400 it replaces, and invisible in a ticket-count metric.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      callback_number: '845-531-7471 ext 202',
      request_description: 'a question about my upcoming procedure',
    })) as Record<string, unknown>;

    expect(create).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect((out as { missingFields?: string[] }).missingFields).toContain('callback_number');
  });
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
    // A routed ticket, so the unrouted-surgeon note is not part of this case.
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      providerId: 49,
    } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Logan',
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

describe('a surgery ticket without a surgeon', () => {
  /**
   * NOTHING INTERNAL REACHES THE PATIENT.
   *
   * `description` becomes the body of a patient-facing SMS — this file says so
   * three lines above the sanitiser. An earlier version of this fix appended
   * "NO SURGEON ON THIS TICKET ... please assign one before working it", which
   * texted a patient an internal routing instruction and told them their record
   * shows no physician. Caught in review before it shipped.
   */
  it('sends the caller\'s words and nothing else when no surgeon resolved', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-NOSURG' } as never);
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValueOnce({ success: true } as never);

    await runTool('file_surgery_ticket', { ...BASE, request_description: 'Question about my drops' });

    const sent = create.mock.calls[0][0] as { description: string; providerId?: number };
    expect(sent.description).toBe('Question about my drops');
    expect(sent.description).not.toMatch(/NO SURGEON|assign one|routes by surgeon|no physician/i);
    // The signal a coordinator works from is the empty field, not prose.
    expect(sent.providerId).toBeUndefined();
  });
  it('says nothing extra when a surgeon IS on it', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-SURG' } as never);
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      providerId: 49,
    } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Logan',
      request_description: 'Question about my drops',
    });

    expect(create.mock.calls[0][0].description).not.toMatch(/NO SURGEON ON THIS TICKET/);
  });
  it('resolves the surgeon from the patient record when the model passes none', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-REC' } as never);
    const lookup = vi
      .spyOn(api, 'lookupProviderAndLocation')
      .mockResolvedValueOnce({ success: true, providerId: 49 } as never);

    const sched = await import('../services/scheduleLookupService');
    vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB').mockResolvedValueOnce({
      patientFound: true,
      identity: { unique: true },
      lastProviderSeen: 'A-Scan',
      lastPhysicianSeen: 'Dwayne Logan, MD',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 3,
    } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'Question about my drops',
    })) as Record<string, unknown>;

    // The chart's PHYSICIAN was used — never the A-Scan machine.
    expect(lookup.mock.calls[0][0].providerName).toMatch(/Dwayne Logan/);
    expect(create.mock.calls[0][0].providerId).toBe(49);
    expect(out.provider_id).toBe(49);
    expect(out.surgeon_source).toBe('patient_record');
    expect(create.mock.calls[0][0].description).not.toMatch(/NO SURGEON ON THIS TICKET/);
  });

  it('will not borrow a surgeon when the lookup matched more than one person', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-AMBIG' } as never);

    const sched = await import('../services/scheduleLookupService');
    vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB').mockResolvedValueOnce({
      patientFound: true,
      identity: { unique: false, candidateCount: 2 },
      lastPhysicianSeen: 'Dwayne Logan, MD',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 5,
    } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'Question about my drops',
    })) as Record<string, unknown>;

    // A stranger's surgeon on this ticket is worse than none.
    expect(out.surgeon_source).toBe('none');
    expect(create.mock.calls[0][0].lastProviderSeen).toBeUndefined();
  });

  /**
   * OPERATOR, 2026-08-18: "every ticket that doesn't have a provider ends up
   * being a manual process ... nobody wants to work a ticket that's unassigned."
   *
   * 08-13 and 08-14 filed 92 and 96 tickets with a provider on every one, and
   * what produced that was the model relaying `last_provider` — optometrists
   * included. Preferring the surgeon is right; preferring a NULL over the
   * optometrist who actually saw the patient is not.
   */
  it('falls back to the last clinician when the record shows no physician', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-OD' } as never);
    // With no location and no caller-named surgeon, the first resolve
    // short-circuits without touching the API — only the clinician rung calls it.
    const lookup = vi
      .spyOn(api, 'lookupProviderAndLocation')
      .mockResolvedValue({ success: true, providerId: 45 } as never);

    const sched = await import('../services/scheduleLookupService');
    vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB').mockResolvedValueOnce({
      patientFound: true,
      identity: { unique: true },
      lastPhysicianSeen: undefined,
      lastProviderSeen: 'Todd Mishima, OD',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 2,
    } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      request_description: 'Question about my drops',
    })) as Record<string, unknown>;

    const lastCall = lookup.mock.calls[lookup.mock.calls.length - 1];
    expect(lastCall[0].providerName).toMatch(/Todd Mishima/);
    expect(create.mock.calls[0][0].providerId).toBe(45);
    expect(out.surgeon_source).toBe('last_clinician');
  });

  /**
   * THE LADDER IS JUDGED ON THE RESULT, NOT THE ARGUMENT.
   *
   * Susan Warnholtz, 2026-08-18: filed unassigned with David Choi, MD plainly
   * on her chart. A non-empty `surgeon` argument skipped the record entirely,
   * so a name that matched nobody active blocked the rung that would have
   * worked. A name is not a route; a providerId is.
   */
  it('a caller-named surgeon that resolves to nobody does not block the record', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-FALLTHRU' } as never);
    const lookup = vi
      .spyOn(api, 'lookupProviderAndLocation')
      .mockResolvedValueOnce({ success: true } as never)               // the caller's name: nobody
      .mockResolvedValueOnce({ success: true, providerId: 22 } as never); // the chart: David Choi

    const sched = await import('../services/scheduleLookupService');
    vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB').mockResolvedValueOnce({
      patientFound: true,
      identity: { unique: true },
      lastPhysicianSeen: 'David Choi, MD',
      lastProviderSeen: 'A-Scan-free clinician',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 8,
    } as never);

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'somebody who does not work here',
      request_description: 'Question about my drops before the procedure',
    })) as Record<string, unknown>;

    expect(create.mock.calls[0][0].providerId).toBe(22);
    expect(out.surgeon_source).toBe('patient_record');
    void lookup;
  });

  it('a surgeon the CALLER names beats the chart', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({
      success: true,
      ticketNumber: 'VA-TEST-CALLER',
    } as never);
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      providerId: 49,
    } as never);
    const sched = await import('../services/scheduleLookupService');
    const spy = vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB');

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Logan',
      request_description: 'Question about my drops',
    })) as Record<string, unknown>;

    expect(out.surgeon_source).toBe('caller');
    // No reason to query the schedule when the caller already answered.
    expect(spy).not.toHaveBeenCalled();
  });

  it('the tool offers the model a way to ask, and stops calling it optional', () => {
    const def = getTool('file_surgery_ticket')!;
    const surgeon = (def.input_schema.properties as Record<string, { askAs?: string; description?: string }>).surgeon;
    expect(surgeon.askAs, 'no askAs means the model has no sentence to ask with').toBeTruthy();
    expect(surgeon.description).not.toMatch(/Optional/i);
  });

  /**
   * AN OPTOMETRIST IS NOT A SURGEON, AND RELAYING last_provider MAKES ONE.
   *
   * My first version of this fix told the model to pass `last_provider` as the
   * surgeon. `lastProviderSeen` deliberately still includes ODs — "who did you
   * last see" is legitimately an optometrist — and a post-op check is very often
   * the most recent visit. A non-empty `surgeon` argument SKIPS the
   * physician-only fallback, so an active OD would resolve to a provider id and
   * be handed the surgery ticket: worse than the null it replaced, because it
   * looks routed. Found in review, 2026-08-18.
   */
  it('neither the prompt nor the schema tells the model to relay last_provider', () => {
    const def = getTool('file_surgery_ticket')!;
    const surgeon = (def.input_schema.properties as Record<string, { description?: string }>).surgeon;
    expect(surgeon.description).toMatch(/do NOT pass|Do NOT pass/);
    expect(surgeon.description).toMatch(/last_provider/);

    const src = readFileSync(new URL('../agents/surgeryAgent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/Do NOT pass last_provider/);
    expect(src).toMatch(/assigned BY SURGEON|assigned by surgeon|by SURGEON/i);
    // And still never with an unbounded hold.
    expect(src).toMatch(/do NOT hold the call hostage over/i);
  });
  /**
   * A REDIRECTED TICKET CARRIES NO SURGEON — NOT THE NOTE, NOT THE FIELDS.
   *
   * detectCrossQueue can file this call into Optical or the HVA Hub, and those
   * queues do not route by surgeon. The note was gated on the department; the
   * providerId and lastProviderSeen fields were not, so a redirected ticket
   * could still be assigned to the patient's operating physician. Review, 08-18.
   */
  it('a redirected ticket carries no surgeon fields', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-XQ' } as never);
    const lookup = vi
      .spyOn(api, 'lookupProviderAndLocation')
      .mockResolvedValue({ success: true, providerId: 49 } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Logan',
      request_description: 'I need to schedule a routine eye exam for my son, he is a new patient',
    });

    const sent = create.mock.calls[0][0] as {
      departmentId: number; providerId?: number; lastProviderSeen?: string; description: string;
    };
    if (sent.departmentId !== 2) {
      expect(sent.providerId, 'a surgeon was attached to another queue').toBeUndefined();
      expect(sent.lastProviderSeen).toBeUndefined();
      expect(sent.description).not.toMatch(/routes by surgeon/i);
    }
    void lookup;
  });
});

describe('the ladder cannot outrun the tool it lives in', () => {
  /**
   * Each /lookup is bounded at 15s and this tool at 30s, and runTool RACES the
   * handler rather than cancelling it. Three slow rungs would hand the agent a
   * retryable timeout while the handler kept going and filed anyway — a ticket
   * number nobody hears, or a duplicate on retry. Review, 2026-08-18.
   */
  it('stops walking the record once the resolve budget is spent', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST-BUDGET' } as never);
    // Every lookup burns 6s and resolves nobody.
    const lookup = vi.spyOn(api, 'lookupProviderAndLocation').mockImplementation(
      (async () => {
        await new Promise((r) => setTimeout(r, 6000));
        return { success: true } as never;
      }) as never,
    );

    const sched = await import('../services/scheduleLookupService');
    vi.spyOn(sched.scheduleLookupService, 'lookupByNameAndDOB').mockResolvedValueOnce({
      patientFound: true,
      identity: { unique: true },
      lastPhysicianSeen: 'David Choi, MD',
      lastProviderSeen: 'Todd Mishima, OD',
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 4,
    } as never);

    await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'nobody at all',
      request_description: 'Question about my drops before the procedure',
    });

    // Caller rung + one record rung, then the budget stops it — never all three.
    expect(lookup.mock.calls.length).toBeLessThan(3);
    // And the ticket still files.
    expect(create).toHaveBeenCalledOnce();
  }, 30000);
});

/**
 * THE 2026-08-31 OUTAGE, ON DEPARTMENT 2.
 *
 * `lookupProviderAndLocation` used to catch its own error and return
 * `{success:false}` — byte-identical to what it returns for a name that
 * matched nobody. Optical read only `locationId`, collapsed the two, and told
 * 43 callers their real office did not exist; one call ran 19 tool calls over
 * 8 minutes. Optical was fixed on 2026-09-01. Surgery had the same conflation
 * in a quieter place: the `SURGEON DID NOT RESOLVE` log fires for both states,
 * so an outage and an unknown surgeon leave the same trace and the same
 * medium-priority unrouted ticket.
 *
 * Dept 2 routes BY SURGEON. A ticket the outage left unrouted is a manual
 * NextGen lookup nobody volunteers for (operator, 2026-08-18), so it has to
 * be visible as such — and the two signals are the ones optical already uses:
 * the caller's own words kept in `lastProviderSeen`, and a raised priority.
 * Never the description: `docs/BACKEND_HANDOFF.md` lists annotating an
 * unrouted ticket's description under changes that made things worse, because
 * that field becomes the body of a patient-facing SMS.
 */
describe('a lookup that never ran is not a surgeon who does not exist', () => {
  it('takes the request and surfaces it when the lookup service is down', async () => {
    const api = await client();
    // The verbatim shape of a lookup that threw and was swallowed. Every rung
    // of the ladder gets the same answer, because the service is down.
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      success: false,
      outcome: 'unavailable',
      error: 'Invalid JSON response from ticketing API: 200',
    } as never);
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-SURG-OUTAGE' } as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Dwayne Logan, MD',
      location: 'Eastvale',
      request_description: 'what time should I arrive on Thursday',
    })) as Record<string, unknown>;

    // The caller named their surgeon correctly. Nothing they said is in doubt,
    // so nothing they said may be questioned back at them.
    expect(out.success).toBe(true);
    expect((out.missingFields as string[] | undefined) ?? []).not.toContain('surgeon');
    expect(JSON.stringify(out)).not.toMatch(/not find|no such|not finding|do not have a/i);

    // The request is TAKEN. Losing it is the worse outcome — a call ends in a
    // ticket, never in nothing.
    expect(create).toHaveBeenCalledTimes(1);
    const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;

    // The caller's own words survive in the text field this queue already
    // reads, so the manual step is "resolve this name", not "ring them back".
    expect(filed.lastProviderSeen).toBe('Dwayne Logan'); // sanitizeProviderName drops the credential suffix
    expect(filed.locationOfLastVisit).toBe('Eastvale');
    // OMITTED, never sent null — null is what files a ticket unassigned.
    expect(filed).not.toHaveProperty('providerId');
    expect(filed).not.toHaveProperty('locationId');
    // Raised, so an unrouted dept-2 ticket is not sitting at the bottom of a
    // queue view sorted by priority. Asserted on the payload, because a
    // comment in optical once claimed a raise the payload never sent.
    expect(filed.priority).toBe('high');
    // The instruction to staff does not go in patient-readable free text.
    expect(String(filed.description)).not.toMatch(/unavailable|unrouted|assign|lookup/i);

    // Greppable, and distinct from the unknown-surgeon log below — an outage
    // that leaves the same trace as a bad name is an outage nobody finds.
    expect(errors.join('\n')).toMatch(/SURGEON LOOKUP UNAVAILABLE/);
  }, 30000);

  /**
   * THE CONTROL, and the behaviour that must NOT regress.
   *
   * Here the lookup RAN and matched nobody. That is not a transient error and
   * it is not the caller's problem to solve either: surgery does not gate on a
   * surgeon (see 'files WITHOUT a location' above and the module header — only
   * optical refuses, because dept 1 assigns BY location), so this files
   * unrouted at its normal priority with the existing loud log. Turning this
   * into a refusal would relinquish a caller, which the operator's rulings in
   * docs/BACKEND_HANDOFF.md forbid outright.
   */
  it('files a surgeon the lookup ran and matched to nothing exactly as before', async () => {
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      success: true,
      outcome: 'no_match',
      providerId: undefined,
      locationMatches: [],
    } as never);
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-SURG-NOMATCH' } as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    const out = (await runTool('file_surgery_ticket', {
      ...BASE,
      surgeon: 'Doctor Nobody',
      request_description: 'what time should I arrive on Thursday',
    })) as Record<string, unknown>;

    expect(out.success).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(filed).not.toHaveProperty('providerId');
    // NOT raised. A name that matches nobody is an ordinary fact about the
    // call; raising every one of them would make the raise mean nothing.
    expect(filed.priority).toBe('medium');
    // The existing signal, unchanged.
    expect(errors.join('\n')).toMatch(/SURGEON DID NOT RESOLVE/);
    // And emphatically NOT the outage marker — that is the whole point of
    // having two.
    expect(errors.join('\n')).not.toMatch(/SURGEON LOOKUP UNAVAILABLE/);
  }, 30000);
});
