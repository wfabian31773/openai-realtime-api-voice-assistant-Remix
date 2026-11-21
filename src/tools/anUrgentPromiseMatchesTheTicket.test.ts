/**
 * v256 — THE CALLER IS TOLD "URGENT" ONLY WHEN THE TICKET IS.
 *
 * The tech prompt told the model to say it was marking a glaucoma request
 * urgent, and the ticket's priority is the tool's: reason 155 (Glaucoma
 * Medication Refill) or an outage files high, everything else medium. The
 * model said "urgent" of drop refills, post-op drops, prior authorizations and
 * symptoms too, and it read a glaucoma drug only when the drug was spelt right.
 *
 * Measured, grok tech calls of 2026-11-06 22:00 to 11-20 22:00 UTC whose agent
 * said "urgent": 109. 83 got a high or urgent ticket, 2 no ticket, and 24 only
 * a medium one. On the 14 of those with stored tool payloads, 10 promised
 * before the filing tool ran. Beside them, Technicians tickets of the same
 * window filed medium under a generic refill reason (153, 154, 542) whose
 * description names a glaucoma drug: 14, 13 of them misspelt ("Lomigan",
 * "terzolamide", "bromonidine", "ropressa", "simbriza", ...).
 *
 * Every row below is RESCUED (red on main, green here), or CORRECTLY MEDIUM:
 * the ticket stays medium as on main, and the tool now tells the model so.
 * The real call SIDs and ticket numbers index the rows; the words are
 * synthetic stand-ins in each call's shape (RULE THREE: transcripts and ticket
 * text stay on disk and in the Support Center).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The prompt test builds the tech agent, whose imports open the database module.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

const outbox = vi.hoisted(() => {
  interface Row { id: string; status: string; ticketNumber?: string; payload: { params: Record<string, unknown>; priorityUnconfirmed?: boolean } }
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
        const { bareReplay } = await import('../services/ticketPriority');
        row.status = 'sent';
        row.ticketNumber = res.ticketNumber;
        row.payload.priorityUnconfirmed = bareReplay(res);
      }
      return { ...res, outboxId };
    }),
    // The production rule, read from the module it lives in: a send the app
    // answered with a bare replay leaves the ticket's priority unknown.
    storedFiling: vi.fn(async (outboxId: string) => {
      const row = outbox.byId.get(outboxId);
      if (!row) return {};
      const params = row.payload.params as { priority?: string };
      return { params, priority: row.payload.priorityUnconfirmed === true ? undefined : params.priority };
    }),
  },
}));

import { runTool } from './registry';
import './sharedPatientTools';
import './techTools';
import { classifyTech, namesAGlaucomaDrug } from './techTaxonomy';
import { resetGateAttempts } from './gateAttempts';
import { buildTechPrompt } from '../agents/techAgent';

type Result = Record<string, unknown>;

const CALLER = {
  first_name: 'Testcaller',
  last_name: 'Tech',
  date_of_birth: '01/01/1950',
  callback_number: '555-555-0147',
};

const MAY_SAY = /You may tell the caller it is marked urgent/;
const MUST_NOT = /Do not tell the caller it is urgent or marked urgent/;

async function api() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

/** One filing through the real tool; returns the result and the payload sent. */
async function file(args: Record<string, unknown>, answer: Record<string, unknown> = { success: true, ticketNumber: 'VA-90001' }) {
  const client = await api();
  const create = vi.spyOn(client, 'createTicket').mockResolvedValueOnce(answer as never);
  const result = (await runTool('file_tech_ticket', { ...CALLER, ...args })) as Result;
  const sent = create.mock.calls[create.mock.calls.length - 1]?.[0] as unknown as Record<string, unknown> | undefined;
  create.mockRestore();
  return { result, sent };
}

beforeEach(() => {
  vi.restoreAllMocks();
  outbox.byKey.clear();
  outbox.byId.clear();
  // What a call has been told about its ticket's priority lives per call; two
  // tests on one corpus SID are two calls.
  resetGateAttempts();
});

describe('RESCUED — a glaucoma refill the ticket did not know was one', () => {
  it('VA-85790 (CA0509601fc4fb738a13ba56b11113207b): "Lomigan", passed as an eye drop refill, files high', async () => {
    const { result, sent } = await file({
      call_sid: 'CA0509601fc4fb738a13ba56b11113207b',
      request_reason_id: 154,
      request_description: 'Refill of Lomigan eye drops, patient is out of them, prescribed by the doctor.',
      medication: 'Lomigan',
    });
    expect(sent?.priority).toBe('high');
    expect(sent?.requestReasonId).toBe(155);
    expect(result).toMatchObject({ priority: 'high', marked_urgent: true, request_reason_id: 155 });
    expect(String(result.fix)).toMatch(MAY_SAY);
  });

  it('the same call (CA0509601fc4fb738a13ba56b11113207b): a drug named only in the medication field ("Rupressa") files high', async () => {
    const { result, sent } = await file({
      call_sid: 'CA0509601fc4fb738a13ba56b11113207b',
      request_reason_id: 154,
      request_description: 'Refill of eye drops, patient has no refills remaining.',
      medication: 'Rupressa',
    });
    expect(sent?.priority).toBe('high');
    expect(result).toMatchObject({ marked_urgent: true });
  });

  it('VA-87142 (CA6d12b263a324eb2f1122cf1bd5760512): "terzolamide", passed as an eye drop refill, files high', async () => {
    const { result, sent } = await file({
      call_sid: 'CA6d12b263a324eb2f1122cf1bd5760512',
      request_reason_id: 154,
      request_description: 'Needs a refill of terzolamide eye drops sent to the pharmacy on file.',
      medication: 'terzolamide',
    });
    expect(sent?.priority).toBe('high');
    expect(result).toMatchObject({ priority: 'high', marked_urgent: true });
  });

  it('VA-86906 (CA414bbdf7337063b5aaf1ea9325f91eef): glaucoma said only in a later filing raises the ticket, and only once the app confirms it', async () => {
    const SID = 'CA414bbdf7337063b5aaf1ea9325f91eef';
    const first = await file({
      call_sid: SID,
      request_reason_id: 542,
      request_description: 'Caller wants to know what her prescription is.',
    });
    expect(first.result).toMatchObject({ priority: 'medium', marked_urgent: false });
    expect(String(first.result.fix)).toMatch(MUST_NOT);

    const later = await file(
      {
        call_sid: SID,
        request_reason_id: 542,
        request_description:
          'Caller states this is about her glaucoma drops and she is nearly out, needs it today. Caller still wants to know her prescription.',
      },
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true },
    );
    // The addition carries high; the app raises the ticket to it (repeat-filing.ts).
    expect(later.sent?.priority).toBe('high');
    expect(later.result).toMatchObject({ already_filed: true, details_added: true, priority: 'high', marked_urgent: true });
    expect(String(later.result.fix)).toMatch(MAY_SAY);
  });

  it('the same shape when the app does not confirm the addition: the ticket is still known only as medium', async () => {
    const SID = 'CA414bbdf7337063b5aaf1ea9325f91eef';
    await file({ call_sid: SID, request_reason_id: 542, request_description: 'Caller wants to know what her prescription is.' });
    const later = await file(
      {
        call_sid: SID,
        request_reason_id: 542,
        request_description: 'Caller states this is about her glaucoma drops and she is nearly out, needs it today.',
      },
      { success: true, ticketNumber: 'VA-90001', cached: true },
    );
    expect(later.result).toMatchObject({ already_filed: true, details_added: false, priority: 'medium', marked_urgent: false });
    expect(String(later.result.fix)).toMatch(MUST_NOT);
  });
});

describe('RESCUED — the generic refill tickets of the window that named a glaucoma drug', () => {
  // [ticket, call SID, reason the model passed, how the drug reached the ticket]
  const TICKETS: Array<[string, string, number, string]> = [
    ['VA-82397', 'CAbbfc5bd38f30dacd53506d36e4aa5266', 154, 'simbranza'],
    ['VA-82619', 'CAae465a86a7766ab8b15ad1a6bed6b02f', 153, 'simbriza'],
    ['VA-83963', 'CA175d0de621f63f6ae0401e5837ed57e5', 154, 'dorzamide'],
    ['VA-84457', 'CAb64422a3a14b68f907fb63bd9fddb00e', 153, 'benzolamide and ropressa'],
    ['VA-84475', 'CA6c9931f116520f69c9c90a372b16e911', 154, 'bromonidine'],
    ['VA-85790', 'CA0509601fc4fb738a13ba56b11113207b', 154, 'lomigan'],
    ['VA-86077', 'CA379f3e1c189a611381b6cd2918c780f0', 154, 'roxlatan'],
    ['VA-86499', 'CAfbcf6b29be442b294fbffdf5b138b08d', 154, 'salatan'],
    ['VA-86954', 'CA7298f7c6b193f6d2ab820ee023aecfb4', 154, 'brimonidine'],
    ['VA-87142', 'CA6d12b263a324eb2f1122cf1bd5760512', 154, 'terzolamide'],
    ['VA-87334', 'CA7e4e60e299ae0bd4a871ddbabda27079', 153, 'repressa'],
    ['VA-87749', 'CAd64536e792459e6410f8de46390234b8', 153, 'ropressa'],
    ['VA-87751', 'CA8fa2abcb7a1f9344003510b3fe89bfc8', 153, 'brimonide'],
    ['VA-87958', 'CA03c989324a4048810e14ecc5da95acb9', 154, 'brimonidina'],
  ];
  for (const [ticket, sid, reason, drug] of TICKETS) {
    it(`${ticket} (${sid}): a ${reason} refill of ${drug} files as a glaucoma refill, high`, async () => {
      const { result, sent } = await file({
        call_sid: sid,
        request_reason_id: reason,
        request_description: `Patient needs a refill of ${drug} eye drops sent to the pharmacy on file.`,
      });
      expect(sent?.priority).toBe('high');
      expect(sent?.requestReasonId).toBe(155);
      expect(result).toMatchObject({ marked_urgent: true });
    });
  }
});

describe('CORRECTLY MEDIUM — the ticket stays medium, and the model is told not to say urgent', () => {
  // [ticket, call SID, reason the model passed, the shape of the request]
  const CALLS: Array<[string, string, number | undefined, string, string?]> = [
    ['VA-82553', 'CA00dc446106fa15325a05ef79a9fd1d49', 214, 'Patient never received the new prescription the doctor ordered for her eye drops.'],
    ['VA-83027', 'CAed62cfe25298777cfb48ffbfb348c2ff', 156, 'Needs a refill of her drops after her cataract surgery.'],
    ['VA-83341', 'CA262b416aba9024429ac857717ffd6e31', 154, 'Refill of his eye drops, he is running low.'],
    ['VA-83582', 'CA0c06297c961544525eca1e7bd6e34da0', undefined, 'Caller asks for a callback about her eye drops, she is almost out.'],
    ['VA-84219', 'CA6985754c1f203f614d1c0d14b8670b49', undefined, 'Caller asks for a callback about a prescription the pharmacy has not received.'],
    ['VA-84492', 'CAdf347c87385bd74ef1afbc2eb8962634', 209, 'The new drops are burning and her eye is irritated since she started them.'],
    ['VA-84725', 'CAe820bf0353d3334e90761d34c5661683', 210, 'Pharmacy says the drops need a prior authorization before they can be filled.'],
    ['VA-84903', 'CA3ef553c3b9240cc96bbbbf6c519c1fd5', 210, 'Insurance denied the prescription; it needs a prior authorization.'],
    ['VA-84955', 'CA85f833d907859e21f24cb1db75dab298', 156, 'Out of her post-op drops after surgery last week.'],
    ['VA-85350', 'CA5e900bbf9ca4428cbf63541df43685a7', 154, 'Refill of her eye drops sent to the pharmacy on file.'],
    ['VA-85853', 'CA1947b48a50755e4444dc21e9d8a375f9', 210, 'Pharmacy calling about a prior authorization for cyclosporine; says it is very urgent.', 'Cyclosporine'],
    ['VA-85935', 'CA7c327d2465b37f4f28d72792d62968bf', 211, 'After her laser surgery the doctor said twice a day, the label says four times a day; which directions are correct?', 'Prednisolone'],
    ['VA-85976', 'CAedbb1a9a26e00fa5bcd11e3ae98b6eea', 210, 'Her drops are too expensive and she cannot afford the copay; wants a cheaper alternative.'],
    ['VA-86345', 'CA9ac55dd0f137d5e2022ef348194746de', 156, 'Out of two medications after surgery and asks for an urgent refill: prednisolone drops and an ointment.', 'Prednisolone'],
    ['VA-86388', 'CA454f7ef33f36295fae6ad768704d5fd6', 542, 'The doctor ordered a medication at her visit and it has not been sent to the pharmacy.'],
    ['VA-86507', 'CAed6f030cd27c108a2c7ef3c8195891b1', 158, 'Two pharmacies could not fill her medication; she wants it sent to a different pharmacy.'],
    ['VA-86523', 'CA6de4f7b4f3420e6366235e508d06d160', 210, 'Needs a prior authorization for a refill of Cequa; asks that it be treated as urgent.', 'Cequa'],
    ['VA-86731', 'CAcf6e6e483b38a8bdaa7bda86710b2060', 542, 'A medication ordered yesterday for eye pain and redness is no longer available at the pharmacy.'],
    ['VA-87363', 'CA788e3a789f08b7c9f4f95ca5c0df3aa7', 156, 'Told this morning to continue his prednisolone drops; nearly out and asks for it urgently.', 'Prednisolone'],
    ['VA-87553', 'CAb9f05cda904280fcb35f3e47dae6ce3b', 214, 'Two prescriptions from today, a drop and a salve; does not know the names.'],
    ['VA-87998', 'CA21ec3b35f1eb9ffcbcd2f469c0254c0e', 156, 'Needs a refill of tobramycin drops after eye surgery and says it is urgent.', 'Tobramycin'],
  ];
  for (const [ticket, sid, reason, words, medication] of CALLS) {
    it(`${ticket} (${sid}) files medium, and the tool says so`, async () => {
      const { result, sent } = await file({
        call_sid: sid,
        ...(reason === undefined ? {} : { request_reason_id: reason }),
        request_description: words,
        ...(medication ? { medication } : {}),
      });
      expect(sent?.priority).toBe('medium');
      expect(result).toMatchObject({ priority: 'medium', marked_urgent: false });
      expect(String(result.fix)).toMatch(MUST_NOT);
    });
  }

  it('a glaucoma drug under a more specific reason keeps that reason: a prior authorization stays medium', async () => {
    const { result, sent } = await file({
      call_sid: 'CA0000000000000000000000000000a210',
      request_reason_id: 210,
      request_description: 'Pharmacy says Rhopressa needs a prior authorization before it can be filled.',
    });
    expect(sent?.requestReasonId).toBe(210);
    expect(result).toMatchObject({ priority: 'medium', marked_urgent: false });
  });

  it('a post-op refill and a new prescription keep their reason when they name a glaucoma drug spelt right', async () => {
    // The classifier would read either sentence as 155 (it is walked before
    // 156 and 214); the model's more specific reason stands, as on main.
    for (const [reason, words] of [
      [156, 'Needs a refill of her Rhopressa drops after her cataract surgery.'],
      [214, 'The doctor started her on Rhopressa at her visit and the pharmacy never got the new prescription.'],
    ] as const) {
      const { result, sent } = await file({ call_sid: `CA00000000000000000000000000000${reason}`, request_reason_id: reason, request_description: words });
      expect(classifyTech(words)?.requestReasonId).toBe(155);
      expect(sent?.requestReasonId).toBe(reason);
      expect(result).toMatchObject({ priority: 'medium', marked_urgent: false });
    }
  });

  it('a later medium filing never lowers a high ticket in what the agent may say', async () => {
    const SID = 'CA0000000000000000000000000000b155';
    const first = await file({ call_sid: SID, request_description: 'Out of her latanoprost and needs a refill.' });
    expect(first.result).toMatchObject({ priority: 'high', marked_urgent: true });
    const later = await file(
      { call_sid: SID, request_reason_id: 158, request_description: 'Caller also wants the prescription sent to a different pharmacy.' },
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true },
    );
    // The addition itself is medium; the ticket it reached is still high.
    expect(later.sent?.priority).toBe('medium');
    expect(later.result).toMatchObject({ already_filed: true, priority: 'high', marked_urgent: true });
  });
});

describe('the priority said is the one SENT, not the one asked for (Codex P1 and github-actions P1 on #504)', () => {
  const SID = 'CA0000000000000000000000000000c504';

  it('a retry that asks for high while the outbox still holds the medium payload says medium', async () => {
    // The first filing's POST does not land: its medium payload stays in the
    // outbox for the worker, and the caller has been told nothing about urgency.
    const first = await file(
      { call_sid: SID, request_reason_id: 542, request_description: 'Caller wants to know what her prescription is.' },
      { success: false, error: 'The ticketing system did not answer in time' },
    );
    expect(first.sent?.priority).toBe('medium');
    expect(first.result).not.toHaveProperty('marked_urgent', true);
    // The retry asks for high, and the row still holds the payload it was
    // first written with, which is what goes out.
    const retry = await file({
      call_sid: SID,
      request_reason_id: 542,
      request_description: 'Caller is out of her latanoprost and needs a refill today.',
    });
    expect(retry.sent?.priority).toBe('medium');
    expect(retry.result).toMatchObject({ success: true, priority: 'medium', marked_urgent: false });
    expect(String(retry.result.fix)).toMatch(MUST_NOT);
  });

  it('a high filing on a ticket another process filed medium, with the addition unconfirmed, says medium', async () => {
    // The ticket exists (the worker, or another process, sent it) and this
    // process holds nothing about the call: no priority was ever noted here.
    const row = {
      id: 'row-elsewhere',
      status: 'sent',
      ticketNumber: 'VA-90002',
      payload: { params: { priority: 'medium', description: 'Caller wants to know what her prescription is.' } },
    };
    outbox.byKey.set(`call-${SID}`, row);
    outbox.byId.set(row.id, row);
    const later = await file(
      { call_sid: SID, request_reason_id: 542, request_description: 'Caller is out of her latanoprost and needs a refill today.' },
      { success: true, ticketNumber: 'VA-90002', cached: true },
    );
    expect(later.sent?.priority).toBe('high');
    expect(later.result).toMatchObject({ already_filed: true, details_added: false, priority: 'medium', marked_urgent: false });
    expect(String(later.result.fix)).toMatch(MUST_NOT);
  });

  it('the same ticket, the addition confirmed: the app raised it, so it may be called urgent', async () => {
    const row = {
      id: 'row-elsewhere',
      status: 'sent',
      ticketNumber: 'VA-90002',
      payload: { params: { priority: 'medium', description: 'Caller wants to know what her prescription is.' } },
    };
    outbox.byKey.set(`call-${SID}`, row);
    outbox.byId.set(row.id, row);
    const later = await file(
      { call_sid: SID, request_reason_id: 542, request_description: 'Caller is out of her latanoprost and needs a refill today.' },
      { success: true, ticketNumber: 'VA-90002', cached: true, detailsAdded: true },
    );
    expect(later.result).toMatchObject({ already_filed: true, details_added: true, priority: 'high', marked_urgent: true });
    expect(String(later.result.fix)).toMatch(MAY_SAY);
  });

  it('a ticket an addition raised stays high when a later filing is not confirmed', async () => {
    await file({ call_sid: SID, request_reason_id: 542, request_description: 'Caller wants to know what her prescription is.' });
    const raised = await file(
      { call_sid: SID, request_reason_id: 542, request_description: 'Caller is out of her latanoprost and needs a refill today.' },
      { success: true, ticketNumber: 'VA-90001', cached: true, detailsAdded: true },
    );
    expect(raised.result).toMatchObject({ priority: 'high', marked_urgent: true });
    // The outbox's first row still holds the medium payload; the call knows
    // the app raised the ticket, so a third filing does not call it normal.
    const third = await file(
      { call_sid: SID, request_reason_id: 158, request_description: 'Caller also wants it sent to a different pharmacy.' },
      { success: true, ticketNumber: 'VA-90001', cached: true },
    );
    expect(third.result).toMatchObject({ already_filed: true, details_added: false, priority: 'high', marked_urgent: true });
  });

  it('a call with no usable CallSid files unkeyed, and says the priority it sent', async () => {
    const high = await file({ call_sid: 'unknown', request_reason_id: 155, request_description: 'Caller is out of her latanoprost.' });
    expect(high.sent?.priority).toBe('high');
    expect(high.result).toMatchObject({ success: true, priority: 'high', marked_urgent: true });
    const medium = await file({ call_sid: 'unknown', request_reason_id: 542, request_description: 'Caller wants to know her prescription.' });
    expect(medium.result).toMatchObject({ success: true, priority: 'medium', marked_urgent: false });
  });

  it('a ticket whose stored payload cannot be read is not called urgent', async () => {
    const row = { id: 'row-unreadable', status: 'sent', ticketNumber: 'VA-90003', payload: undefined as never };
    outbox.byKey.set(`call-${SID}`, row);
    outbox.byId.set(row.id, row);
    const later = await file(
      { call_sid: SID, request_reason_id: 155, request_description: 'Caller is out of her latanoprost.' },
      { success: true, ticketNumber: 'VA-90003', cached: true },
    );
    expect(later.result).toMatchObject({ already_filed: true, priority: 'unknown', marked_urgent: false });
    expect(String(later.result.fix)).toMatch(MUST_NOT);
  });
});

describe('a bare replay says nothing about priority (github-actions P1 on #504, head e84d94b7)', () => {
  const SID = 'CA0000000000000000000000000000d504';
  const HIGH = { request_reason_id: 155, request_description: 'Caller is out of her latanoprost and needs a refill today.' };

  it('a first filing the app answers as a replay of an earlier POST, details not added, is not called urgent', async () => {
    const r = await file({ call_sid: SID, ...HIGH }, { success: true, ticketNumber: 'VA-90004', cached: true });
    expect(r.sent?.priority).toBe('high');
    expect(r.result).toMatchObject({ success: true, priority: 'unknown', marked_urgent: false });
    expect(String(r.result.fix)).toMatch(MUST_NOT);
  });

  it('the same replay with the details added: the app raised the ticket, so it may be called urgent', async () => {
    const r = await file({ call_sid: SID, ...HIGH }, { success: true, ticketNumber: 'VA-90004', cached: true, detailsAdded: true });
    expect(r.result).toMatchObject({ success: true, priority: 'high', marked_urgent: true });
    expect(String(r.result.fix)).toMatch(MAY_SAY);
  });

  it('a filing consolidated onto an earlier ticket says the priority it sent (the app raises on consolidation)', async () => {
    const r = await file({ call_sid: SID, ...HIGH }, { success: true, ticketNumber: 'VA-90005', consolidated: true });
    expect(r.result).toMatchObject({ success: true, priority: 'high', marked_urgent: true });
  });

  it('an unkeyed filing answered as a bare replay is not called urgent either', async () => {
    const r = await file({ call_sid: 'unknown', ...HIGH }, { success: true, ticketNumber: 'VA-90006', cached: true });
    expect(r.sent?.priority).toBe('high');
    expect(r.result).toMatchObject({ success: true, priority: 'unknown', marked_urgent: false });
  });

  it('VA-83575 (CAf091561502223f2c9fb51162938a580a), the accepted cost: a high ticket answered as a bare replay is not called urgent', async () => {
    // One of the 3 bare replays on tech's own keys in the 14 days to
    // 2026-11-20 22:00 UTC, and the only one that asked for high. The ticket
    // is high; the agent now says nothing about urgency on it.
    const r = await file(
      { call_sid: 'CAf091561502223f2c9fb51162938a580a', ...HIGH },
      { success: true, ticketNumber: 'VA-83575', cached: true, detailsAdded: false },
    );
    expect(r.result).toMatchObject({ priority: 'unknown', marked_urgent: false });
  });
});

describe('a later filing after a bare replay (github-actions P1 and P2 on #504, head 5065f2d4)', () => {
  const SID = 'CA0000000000000000000000000000e504';
  const HIGH = { request_reason_id: 155, request_description: 'Caller is out of her latanoprost and needs a refill today.' };
  const BARE = { success: true, ticketNumber: 'VA-90007', cached: true };

  it('the same request filed again is not called urgent: the first send never confirmed the priority', async () => {
    await file({ call_sid: SID, ...HIGH }, BARE);
    const r = await file({ call_sid: SID, ...HIGH });
    expect(r.result).toMatchObject({ already_filed: true, priority: 'unknown', marked_urgent: false });
    expect(String(r.result.fix)).toMatch(MUST_NOT);
  });

  it('an addition the app did not confirm is not called urgent either', async () => {
    await file({ call_sid: SID, ...HIGH }, BARE);
    const r = await file(
      { call_sid: SID, ...HIGH, request_description: `${HIGH.request_description} She also asks for a text when it is ready.` },
      { success: true, ticketNumber: 'VA-90007' },
    );
    expect(r.result).toMatchObject({ already_filed: true, details_added: false, priority: 'unknown', marked_urgent: false });
  });

  it('control: an addition the app confirmed raised the ticket, so it may be called urgent', async () => {
    await file({ call_sid: SID, ...HIGH }, BARE);
    const r = await file(
      { call_sid: SID, ...HIGH, request_description: `${HIGH.request_description} She also asks for a text when it is ready.` },
      { success: true, ticketNumber: 'VA-90007', cached: true, detailsAdded: true },
    );
    expect(r.result).toMatchObject({ already_filed: true, details_added: true, priority: 'high', marked_urgent: true });
  });

  it('control: a first send that was not a replay still makes the repeat high', async () => {
    await file({ call_sid: SID, ...HIGH }, { success: true, ticketNumber: 'VA-90008' });
    const r = await file({ call_sid: SID, ...HIGH });
    expect(r.result).toMatchObject({ already_filed: true, priority: 'high', marked_urgent: true });
  });

  it('an unknown priority is not called normal: the fix says no priority at all', async () => {
    const first = await file({ call_sid: SID, ...HIGH }, BARE);
    const again = await file({ call_sid: SID, ...HIGH });
    for (const r of [first.result, again.result]) {
      expect(String(r.fix)).toMatch(MUST_NOT);
      expect(String(r.fix)).toMatch(/do not say what priority it has/);
      expect(String(r.fix)).not.toMatch(/normal priority/);
    }
  });

  it('a known medium ticket is not called normal either: the medium is only a floor (github-actions P2 on #504, head 07e615b6)', async () => {
    const r = await file({ call_sid: SID, request_reason_id: 154, request_description: 'Refill of artificial tears drops.' });
    expect(r.result).toMatchObject({ priority: 'medium', marked_urgent: false });
    expect(String(r.result.fix)).toMatch(MUST_NOT);
    expect(String(r.result.fix)).toMatch(/do not say what priority it has/);
    expect(String(r.result.fix)).not.toMatch(/normal priority/);
  });
});

describe('the priority the tool knows is a floor (github-actions P2s on #504, head 07e615b6)', () => {
  const SID = 'CA0000000000000000000000000000f504';
  const MEDIUM = { request_reason_id: 154, request_description: 'Refill of artificial tears drops.' };
  const HIGH = { request_reason_id: 155, request_description: 'Caller is out of her latanoprost and needs a refill today.' };

  it('a medium filing consolidated onto a ticket that may already be high is never called normal', async () => {
    // Measured, department 3 create-ticket POSTs answered 200, 2026-11-06 22:00
    // to 11-20 22:00 UTC: 88 consolidated, 55 of them asking for medium, and 29
    // of those 55 landed on a ticket that now reads high or urgent.
    const r = await file({ call_sid: SID, ...MEDIUM }, { success: true, ticketNumber: 'VA-90009', consolidated: true });
    expect(r.result).toMatchObject({ success: true, priority: 'medium', marked_urgent: false });
    expect(String(r.result.fix)).toMatch(MUST_NOT);
    expect(String(r.result.fix)).not.toMatch(/normal priority/);
  });

  it('a high addition the worker sent and the app confirmed makes the next identical filing high', async () => {
    await file({ call_sid: SID, ...MEDIUM }, { success: true, ticketNumber: 'VA-90010' });
    // The high addition's live send fails, so the outbox keeps it for the worker.
    const queued = await file({ call_sid: SID, ...HIGH }, { success: false, error: 'The ticketing system did not answer in time' });
    expect(queued.result).toMatchObject({ already_filed: true, marked_urgent: false });
    // The worker sends it and the app confirms it reached the ticket.
    const addition = [...outbox.byId.values()].find((row) => row.status === 'pending')!;
    addition.status = 'sent';
    addition.ticketNumber = 'VA-90010';
    addition.payload.priorityUnconfirmed = false;
    const again = await file({ call_sid: SID, ...HIGH });
    expect(again.sent).toBeUndefined();
    expect(again.result).toMatchObject({ already_filed: true, priority: 'high', marked_urgent: true });
    expect(String(again.result.fix)).toMatch(MAY_SAY);
  });

  it('control: the worker\'s send answered as a bare replay leaves the ticket at its floor', async () => {
    await file({ call_sid: SID, ...MEDIUM }, { success: true, ticketNumber: 'VA-90010' });
    await file({ call_sid: SID, ...HIGH }, { success: false, error: 'The ticketing system did not answer in time' });
    const addition = [...outbox.byId.values()].find((row) => row.status === 'pending')!;
    addition.status = 'sent';
    addition.ticketNumber = 'VA-90010';
    addition.payload.priorityUnconfirmed = true;
    const again = await file({ call_sid: SID, ...HIGH });
    expect(again.result).toMatchObject({ already_filed: true, priority: 'medium', marked_urgent: false });
    expect(String(again.result.fix)).toMatch(MUST_NOT);
  });
});

describe('the misspelling reader', () => {
  it('reads every misspelling the window carried as a glaucoma drug', () => {
    for (const w of ['lomigan', 'rupressa', 'terzolamide', 'simbranza', 'simbriza', 'dorzamide', 'benzolamide', 'ropressa',
      'repressa', 'bromonidine', 'brimonide', 'brimonidina', 'roxlatan', 'salatan', 'latanaprost', 'dorzolamida', 'alfagan']) {
      expect(classifyTech(`Refill of ${w} drops`)?.requestReasonId, w).toBe(155);
    }
  });
  it('does not read the near words the vocabularies held', () => {
    for (const w of ['alphaeon', 'cambian', 'colbian', 'viroptic', 'combinan', 'install', 'luminal', 'timothy', 'costco']) {
      expect(namesAGlaucomaDrug(`Caller mentioned ${w} on the call`), w).toBe(false);
    }
  });
  it('a word under six letters is never stretched to a drug ("azop" is not Azopt)', () => {
    expect(namesAGlaucomaDrug('the azop drops')).toBe(false);
  });
});

describe('the prompt', () => {
  const prompt = buildTechPrompt({ callerPhone: '+17605551234' });
  it('no longer tells the model to say a glaucoma request is marked urgent', () => {
    expect(prompt).not.toMatch(/tell them you are marking it urgent/);
  });
  it('says urgency is the filing tool’s to say', () => {
    expect(prompt).toMatch(/Call a request urgent only when the filing tool says it is\./);
  });
});
