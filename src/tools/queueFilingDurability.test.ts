/**
 * THE WIRING, not the mechanism.
 *
 * `durableTicketFiling.test.ts` proves that a failed POST is captured. This
 * proves the four tools that take every live queue call actually go through it
 * — which is the half that rots. The four filing tools were written at
 * different times from a copy of each other, and the block being replaced here
 * (`const res = await ticketingApiClient.createTicket({...})` followed by a
 * bare `retryable: true`) is duplicated in all four. A fifth queue is coming.
 *
 * Read as text on purpose, in the idiom of agentWiring.test.ts: the thing being
 * checked is whether one file still calls what another file provides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const writeToOutbox = vi.fn();
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox } };
});

const QUEUE_TOOL_FILES: Array<[file: string, toolName: string]> = [
  ['opticalTools.ts', 'file_optical_ticket'],
  ['surgeryTools.ts', 'file_surgery_ticket'],
  ['techTools.ts', 'file_tech_ticket'],
  ['medicalRecordsTools.ts', 'file_records_ticket'],
];

describe('every queue filing tool files durably', () => {
  for (const [file, toolName] of QUEUE_TOOL_FILES) {
    const src = readFileSync(join(__dirname, file), 'utf8');

    it(`${file} files through createTicketDurable`, () => {
      expect(src).toMatch(/await createTicketDurable\(\{/);
    });

    it(`${file} does not POST a ticket around it`, () => {
      // The lookup calls on this client are fine and expected; only the create
      // is routed, because only the create carries a request that can be lost.
      expect(src).not.toMatch(/ticketingApiClient\.createTicket\(/);
    });

    it(`${file} answers a failed POST with postFailureToolResult`, () => {
      // Its OWN name, because that is how the refusal reaches the caller in
      // the tool's own askAs wording rather than a generic sentence. Passing a
      // neighbour's name would silently ask the wrong question.
      expect(src).toContain(`return postFailureToolResult(res, '${toolName}');`);
    });
  }
});

// Clinical Tech Support: 9,288 tickets in 90 days, 103 a day, and it is the
// medication queue.
const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./techTools');

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

describe('the largest queue, end to end', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    writeToOutbox.mockReset();
    writeToOutbox.mockResolvedValue({ outboxId: 'ob-tech-1', alreadyExists: false });
  });

  it('captures the request when create-ticket fails, and says so without a number', async () => {
    const api = await client();
    // The 2026-08-31 signature: HTTP 200, body was not JSON.
    vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: false,
      error: 'Invalid JSON response from ticketing API: 200',
    } as never);

    const res = (await runTool('file_tech_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
      call_sid: 'CA00000000000000000000000000000009',
    })) as Record<string, unknown>;

    // Before this wiring the caller's refill request existed only in a local
    // variable that had already gone out of scope.
    expect(writeToOutbox).toHaveBeenCalledOnce();
    const [payload, callSid] = writeToOutbox.mock.calls[0];
    expect(payload.params.departmentId).toBe(3);
    expect(payload.params.description).toMatch(/Latanoprost/);
    expect(payload.params.callData.agentUsed).toBe('tech');
    expect(callSid).toBe('CA00000000000000000000000000000009');

    expect(res.success).toBe(true);
    expect(res.filed_pending).toBe(true);
    expect(res.ticket_number).toBeUndefined();
  });

  it('does not touch the outbox on a normal filing', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: true,
      ticketNumber: 'VA-52200',
    } as never);

    const res = (await runTool('file_tech_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
    })) as Record<string, unknown>;

    expect(res.ticket_number).toBe('VA-52200');
    expect(writeToOutbox).not.toHaveBeenCalled();
  });
});

/**
 * OPTICAL READS WHAT resolve_location ALREADY RESOLVED — AND ONLY IT.
 *
 * 2026-09-02: an optical request died in the outbox after this exact sequence
 * on one call —
 *
 *     file_optical_ticket    -> refused, "Missing required information: office"
 *     resolve_location       -> { success: true, verified: true }
 *     file_optical_ticket    -> refused AGAIN, same missing office
 *
 * Surgery is deliberately NOT given this carry (Cursor, PR #253): it does not
 * gate on location at all, so a missing office was never why its four requests
 * died that afternoon — and a carried office would AND itself into every
 * provider lookup in `resolveWith`, narrowing the surgeon ladder on the one
 * queue that lost four requests for a missing surgeon.
 *
 * Read as source text for the same reason the durability checks above are:
 * running these tools end to end needs the ticketing client, the lookups and a
 * database, and this pins the lines that would silently undo the decision.
 */
describe('the office carry survives the model forgetting it', () => {
  it('resolve_location actually WRITES what it resolved', () => {
    // The read side is worthless if nothing fills the store. Deleting this
    // one line broke nothing on the first mutation pass.
    const shared = readFileSync(join(__dirname, 'sharedPatientTools.ts'), 'utf8');
    expect(shared).toMatch(/rememberResolvedOffice\(str\(input\.call_sid\), fileable, verified && usable\)/);
  });

  it('stores only an office THIS QUEUE can file to, not merely a verified one', () => {
    // `verified` is the Console directory hit; `usable_for_this_queue` is
    // whether optical can action it. A surgery centre is the first and not the
    // second, and storing it would let optical fill in a building the tool had
    // just told the model not to use.
    const shared = readFileSync(join(__dirname, 'sharedPatientTools.ts'), 'utf8');
    expect(shared).not.toMatch(/rememberResolvedOffice\([^)]*,\s*true\s*\)/);
  });

  it('opticalTools.ts falls back to resolvedOfficeFor', () => {
    const src = readFileSync(join(__dirname, 'opticalTools.ts'), 'utf8');
    expect(src).toMatch(/resolvedOfficeFor\(callSid\)/);
  });

  it("opticalTools.ts carries only AFTER the gate has already asked", () => {
    // A carried office is last-write-wins with no "is this still what the
    // caller said" check. On the FIRST attempt the ask is what surfaces a
    // correction; the carry belongs to the second, which is the case that
    // actually died. Unassigned is sanctioned, a wrong building is not.
    const src = readFileSync(join(__dirname, 'opticalTools.ts'), 'utf8');
    expect(src).toMatch(/if \(!cleanLocation && askedForOfficeAlready\) \{[\s\S]{0,600}?resolvedOfficeFor/);
    // ...and actually USES it. Reading the store and dropping the value on the
    // floor passed the block check: a mutation replacing the assignment with a
    // no-op survived the first pass.
    expect(src).toMatch(/const carried = [\s\S]{0,200}?cleanLocation = carried;/);
  });

  it('surgeryTools.ts does NOT carry an office', () => {
    // It would narrow the surgeon ladder: resolveWith ANDs cleanLocation into
    // every /lookup, so a carried office turns a provider-only search into
    // provider+location and a surgeon not at that building stops matching.
    const src = readFileSync(join(__dirname, 'surgeryTools.ts'), 'utf8');
    expect(src).not.toMatch(/resolvedOfficeFor/);
  });
});
