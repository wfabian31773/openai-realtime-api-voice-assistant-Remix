/**
 * A LATER FILING ON THE SAME CALL REACHES THE TICKET (v151).
 *
 * Every later filing on a call that had already filed was answered from the
 * call's outbox row with the first ticket's number, and nothing it carried was
 * sent anywhere. On the runtime, 2026-10-20..28: 254 queue-lane calls ran a
 * second successful filing, 218 of them after the caller spoke again, and in
 * eight sampled calls the agent had told the caller it was adding something.
 * The operator's pack-01 A1 test call (`CAe121c3c176d626e8a679536788e58d63`)
 * filed twice and then told the caller "that's the same ticket".
 *
 * Driven through `runTool('file_tech_ticket')` over the real durable filing
 * path, with the outbox replaced by a fake that keeps rows by key the way the
 * real one does (`writeToOutbox` answers an existing key as `alreadyExists`).
 * Synthetic caller throughout; the SIDs are the real calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const outbox = vi.hoisted(() => {
  interface Row { id: string; status: string; ticketNumber?: string; payload: { params: Record<string, unknown> } }
  const byKey = new Map<string, Row>();
  const byId = new Map<string, Row>();
  return { byKey, byId };
});

vi.mock('../services/ticketOutboxService', () => ({
  wrapCreateTicketPayload: (params: Record<string, unknown>) => ({ kind: 'create_ticket_v1', params }),
  TicketOutboxService: {
    writeToOutbox: vi.fn(async (payload: { params: Record<string, unknown> }, key?: string) => {
      const k = `call-${key}`;
      const existing = outbox.byKey.get(k);
      if (existing) {
        return { outboxId: existing.id, alreadyExists: true, status: existing.status, ticketNumber: existing.ticketNumber };
      }
      const row = { id: `row-${outbox.byId.size}`, status: 'pending', payload };
      outbox.byKey.set(k, row);
      outbox.byId.set(row.id, row);
      return { outboxId: row.id, alreadyExists: false };
    }),
    attemptSend: vi.fn(async (outboxId: string) => {
      const row = outbox.byId.get(outboxId)!;
      const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
      const res = await ticketingApiClient.createTicket(row.payload.params as never);
      if (res.success && res.ticketNumber) {
        row.status = 'sent';
        row.ticketNumber = res.ticketNumber;
      }
      return { ...res, outboxId };
    }),
    storedCreateParams: vi.fn(async (outboxId: string) => outbox.byId.get(outboxId)?.payload.params),
  },
}));

import { runTool } from './registry';
import './sharedPatientTools';
import './techTools';
import './medicalRecordsTools';
import { filingFingerprint } from '../services/durableTicketFiling';

const SID = 'CA71d9b6af768209a1f407e9ce5bec8d33';
const BASE = {
  first_name: 'Testcaller',
  last_name: 'Tech',
  date_of_birth: '01/01/1950',
  callback_number: '555-555-0147',
  request_description: 'Refill of eye drops sent to the pharmacy on file',
  call_sid: SID,
};
const ADDED = { ...BASE, request_description: `${BASE.request_description}. Caller also asks for a text when it is ready.` };

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

type Result = Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
  outbox.byKey.clear();
  outbox.byId.clear();
});

/** The first filing, which opens the ticket. */
async function fileFirst() {
  const api = await client();
  const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce({ success: true, ticketNumber: 'VA-90001' } as never);
  const first = (await runTool('file_tech_ticket', BASE)) as Result;
  // Later assertions count only what happens after the first filing.
  create.mockClear();
  return { api, create, first };
}

describe('the same request again', () => {
  it('posts nothing, names the ticket, and gives the model no line to call it the same ticket', async () => {
    const { create, first } = await fileFirst();
    expect(first.ticket_number).toBe('VA-90001');
    expect(first.already_filed).toBeUndefined();

    const again = (await runTool('file_tech_ticket', BASE)) as Result;

    expect(create).not.toHaveBeenCalled();
    expect(again).toMatchObject({ success: true, ticket_number: 'VA-90001', already_filed: true, details_added: false });
    // The first filing's "read the ticket number back" line is replaced.
    expect(String(again.message)).not.toMatch(/Read the ticket number back/);
    expect(String(again.fix)).toMatch(/do not tell the caller it is the same or a second ticket/i);
  });
});

describe('a later filing that carries something new', () => {
  // Codex P1 on #404: a later filing that only corrects who the request is
  // about (a spelled surname, a name given after the first filing went out
  // unnamed) used to read as the same request and was never sent.
  it('a later filing that only adds a callback extension is sent on', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true } as never,
    );

    const later = (await runTool('file_tech_ticket', { ...BASE, callback_number: '555-555-0147 ext 22' })) as Result;

    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0][0] as unknown as { callData?: { transcript?: string } };
    expect(sent.callData?.transcript).toMatch(/Callback extension: 22/);
    expect(later).toMatchObject({ already_filed: true, details_added: true });
  });

  it('a later filing that only corrects the name is sent on', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true } as never,
    );

    const later = (await runTool('file_tech_ticket', { ...BASE, last_name: 'Techman' })) as Result;

    expect(create).toHaveBeenCalledTimes(1);
    expect(later).toMatchObject({ already_filed: true, details_added: true });
  });

  it('is sent on with the call’s own key, and is told it was added when the app says so', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true } as never,
    );

    const later = (await runTool('file_tech_ticket', ADDED)) as Result;

    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    // The call's own key: the app must treat it as the same request.
    expect(sent.idempotencyKey).toBe(`call-${SID}`);
    expect(String(sent.description)).toMatch(/text when it is ready/);
    expect(later).toMatchObject({ already_filed: true, details_added: true, message: 'Added to VA-90001.' });
    expect(String(later.fix)).toMatch(/not a new ticket/);
  });

  it('rides its own outbox row, so the first row is untouched and a repeat of the addition is one row', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true } as never,
    );
    await runTool('file_tech_ticket', ADDED);
    const keys = [...outbox.byKey.keys()];
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(new RegExp(`^call-${SID}-add-[0-9a-f]{12}$`));

    create.mockClear();
    const again = (await runTool('file_tech_ticket', ADDED)) as Result;
    expect(create).not.toHaveBeenCalled();
    expect(outbox.byKey.size).toBe(2);
    expect(again).toMatchObject({ already_filed: true, details_added: false });
  });

  it('an app that does not confirm it (no detailsAdded) is NOT told it was added', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-90001', cached: true } as never);

    const later = (await runTool('file_tech_ticket', ADDED)) as Result;

    expect(later).toMatchObject({ already_filed: true, details_added: false });
    expect(String(later.fix)).toMatch(/Do not say it was added to the ticket/);
    expect(String(later.message)).not.toMatch(/Added to/);
  });

  it('an app that read it and found nothing new answers as the same request', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: false } as never,
    );

    const later = (await runTool('file_tech_ticket', ADDED)) as Result;

    expect(later).toMatchObject({ already_filed: true, details_added: false });
    expect(String(later.fix)).toMatch(/already filed on this call/);
  });

  it('a send that fails is queued and not claimed; the caller still hears about the ticket that exists', async () => {
    const { create } = await fileFirst();
    create.mockResolvedValueOnce({ success: false, error: 'timeout' } as never);

    const later = (await runTool('file_tech_ticket', ADDED)) as Result;

    expect(later).toMatchObject({ success: true, ticket_number: 'VA-90001', details_added: false });
    expect(String(later.fix)).toMatch(/did not confirm/);
  });

  it('an outbox that cannot take the addition never throws the tool', async () => {
    await fileFirst();
    // The call's own row answers as already sent; the addition's write fails.
    const write = (await import('../services/ticketOutboxService')).TicketOutboxService.writeToOutbox as unknown as {
      mockImplementationOnce: (f: unknown) => void;
    };
    const real = outbox.byKey.get(`call-${SID}`)!;
    write.mockImplementationOnce(async () => ({ outboxId: real.id, alreadyExists: true, status: 'sent', ticketNumber: 'VA-90001' }));
    write.mockImplementationOnce(async () => { throw new Error('outbox down'); });

    const later = (await runTool('file_tech_ticket', ADDED)) as Result;

    expect(later).toMatchObject({ success: true, ticket_number: 'VA-90001', details_added: false });
  });
});

describe('a later records filing that asks for the signing form', () => {
  // Codex P2 on #404. The ticketing app sends the form only when it OPENS a
  // case; a repeat filing just adds its details. So a later filing that asks
  // for the link by email must tell the model the link was not sent, and how
  // to send it, instead of a bare "Added to".
  const RECORDS_SID = 'CA0b2c8e1f3a4d5c6b7a8f9e0d1c2b3a4f';
  const RECORDS = {
    requester: 'I am the patient',
    first_name: 'Testpatient',
    last_name: 'Example',
    date_of_birth: '01/02/1950',
    location: 'Synthetic Clinic',
    callback_number: '202-555-0142',
    request_description: 'I need a copy of my medical records',
    call_sid: RECORDS_SID,
  };

  it('an identical retry of a filing that already sent the link is told not to send it again', async () => {
    // Codex P2 on #404: a re-send mints a new single-use token and kills the
    // link the caller just received.
    const sid = 'CA1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f';
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90003', form: { requested: true, sent: true, channel: 'sms' } } as never,
    );
    await runTool('file_records_ticket', { ...RECORDS, call_sid: sid, form_channel: 'sms' });
    create.mockClear();

    const again = (await runTool('file_records_ticket', { ...RECORDS, call_sid: sid, form_channel: 'sms' })) as Result;

    expect(create).not.toHaveBeenCalled();
    expect(String(again.fix)).toMatch(/already sent by text earlier on this call/);
    expect(String(again.fix)).not.toMatch(/call send_records_form/);
  });

  it('says this filing sent no form and names send_records_form with the channel asked for', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90002', form: { requested: true, sent: true, channel: 'sms' } } as never,
    );
    const first = (await runTool('file_records_ticket', { ...RECORDS, form_channel: 'sms' })) as Result;
    expect(first.form_sent).toBe(true);

    create.mockResolvedValueOnce(
      { success: true, ticketNumber: 'VA-90002', cached: true, detailsAdded: true } as never,
    );
    const later = (await runTool('file_records_ticket', {
      ...RECORDS,
      form_channel: 'email',
      email: 'synthetic.patient@example.test',
      request_description: 'I need a copy of my medical records, and I would rather get the form by email',
    })) as Result;

    expect(later).toMatchObject({ already_filed: true, details_added: true, form_sent: false });
    expect(String(later.message)).toBe('Added to VA-90002.');
    // The repeat copy stays; the form line is added to it, not put in its place.
    expect(String(later.fix)).toMatch(/added to the request already filed on this call as VA-90002/);
    expect(String(later.fix)).toMatch(/did not send a signing form/);
    expect(String(later.fix)).toMatch(/send_records_form once with channel "email"/);
  });
});

describe('the fingerprint', () => {
  const params = (over: Record<string, unknown> = {}) => ({
    departmentId: 3, requestTypeId: 1, requestReasonId: 1,
    patientPhone: '5555550147', description: 'Refill of eye drops', ...over,
  }) as never;

  it('ignores spacing and phone format, and sees a new word, number, office or surgeon', () => {
    const base = filingFingerprint(params());
    expect(filingFingerprint(params({ description: '  Refill  of eye drops ', patientPhone: '(555) 555-0147' }))).toBe(base);
    expect(filingFingerprint(params({ description: 'Refill of eye drops, and text me' }))).not.toBe(base);
    expect(filingFingerprint(params({ patientPhone: '5555550199' }))).not.toBe(base);
    expect(filingFingerprint(params({ locationId: 4401 }))).not.toBe(base);
    expect(filingFingerprint(params({ providerId: 77 }))).not.toBe(base);
  });

  it('sees who the request is about: a name, a date of birth, the requester', () => {
    const named = filingFingerprint(params({ patientFirstName: 'Testcaller', patientLastName: 'Tech' }));
    expect(filingFingerprint(params({ patientFirstName: 'TESTCALLER ', patientLastName: 'tech' }))).toBe(named);
    expect(named).not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(params({ patientLastName: 'Techman' }))).not.toBe(filingFingerprint(params({ patientLastName: 'Tech' })));
    expect(filingFingerprint(params({ patientBirthYear: '1950', patientBirthMonth: '01', patientBirthDay: '01' })))
      .not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(params({ requestorType: 'personal_representative' }))).not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(params({ requestPathway: 'pending_authorization' }))).not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(params({ capClockApplies: false }))).not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(params({ requestorName: 'Example Health Plan' })))
      .not.toBe(filingFingerprint(params({ requestorName: 'Example Medical Group' })));
    expect(filingFingerprint(params({ requestorName: ' example health plan ' })))
      .toBe(filingFingerprint(params({ requestorName: 'Example Health Plan' })));
    expect(filingFingerprint(params({ validatedPatient: { personId: 'person-1' } })))
      .not.toBe(filingFingerprint(params()));
  });

  it('sees a callback extension, which rides in the staff note, and nothing else in that note', () => {
    const withNote = (transcript: string) => params({ callData: { transcript } });
    expect(filingFingerprint(withNote('Callback extension: 22'))).not.toBe(filingFingerprint(params()));
    expect(filingFingerprint(withNote('Callback extension: 22'))).not.toBe(filingFingerprint(withNote('Callback extension: 23')));
    expect(filingFingerprint(withNote('DATE OF BIRTH UNAVAILABLE\nCallback extension: 22')))
      .toBe(filingFingerprint(withNote('Callback extension: 22')));
  });
});

describe('every queue filing tool answers a repeat the same way', () => {
  // Tech is driven above; the other three are read from source, because a
  // tool that forgets the spread hands the model the first filing's "read the
  // ticket number back" line again, which is what the A1 agent obeyed.
  it.each(['opticalTools', 'surgeryTools', 'techTools', 'medicalRecordsTools'])(
    '%s spreads repeatFilingFields last over its success result',
    async (file) => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const src = readFileSync(join(__dirname, `${file}.ts`), 'utf8');
      // A tool may add its own line to the repeat copy (records: the form).
      expect(src).toMatch(/\.\.\.repeatFilingFields\(res(?:, \w+)?\),\n {4}\};/);
      expect(src.match(/repeatFilingFields\(res\b/g)).toHaveLength(1);
    },
  );
});
