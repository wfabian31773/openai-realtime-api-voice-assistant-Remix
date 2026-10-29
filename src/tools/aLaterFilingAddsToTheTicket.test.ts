/**
 * A LATER FILING ON THE SAME CALL REACHES THE TICKET (v146).
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
      expect(src).toMatch(/\.\.\.repeatFilingFields\(res\),\n {4}\};/);
      expect(src.match(/repeatFilingFields\(res\)/g)).toHaveLength(1);
    },
  );
});
