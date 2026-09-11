/**
 * OPTICAL NEVER SENT THE FLAG THAT SANCTIONS AN UNASSIGNED TICKET.
 *
 * Surgery has sent `routingAskExhausted` since 2026-09-02 and
 * `surgeryUnassignedExit.test.ts` pins its narrowness. Optical has the same
 * bounded ask — `gateAttempts.ts`, 2026-09-01, the ruling surgery's exit was
 * modelled on — and has never sent the flag at all.
 *
 * MEASURED 2026-09-11 in the ticketing app's `voice_agent_api_logs`, 30 days:
 * every POST carrying `routingAskExhausted` is department 2, 56 of 56, all
 * answered 200. Department 1 sent it ZERO times, and **48 distinct optical
 * calls** in the same window were answered HTTP 400 "Missing required
 * information: office" — every business day, worst 14 calls on 2026-09-02.
 *
 * THAT 400 IS THE LOOP. The escape fires correctly and POSTs the unassigned
 * ticket; the app refuses it; `postFailureToolResult` surfaces the refusal as
 * `missingFields: ["location"]`, which in our own telemetry is
 * indistinguishable from our gate refusing a third time; the model re-asks and
 * re-runs `resolve_location` thirty-odd times into the 40-tool ceiling. Two
 * requests were lost that way on 2026-09-11, 42 minutes apart
 * (CA45263e1b…, CA0ccc14d8…), and on the second the office was never in doubt:
 * the caller was recognised by phone, her record read back to her, she
 * confirmed it and said "Glendora" again when asked.
 *
 * What these tests pin is the NARROWNESS, the same property surgery's pin.
 * Optical assigns BY location, so an unconditional flag switches the app's
 * gate off for this department — the shape that drove department 2's provider
 * fill from ~98% to 49% once already.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from './registry';
import './sharedPatientTools';
import './opticalTools';
import { resetGateAttempts } from './gateAttempts';

const SID = 'CA45263e1b3b7890aa6f640f5dc3ff8aac';

/**
 * A complete optical request with no office — the shape that gets lost.
 *
 * INVENTED, not taken from either lost call. The identity fields here only
 * have to be present and well-formed; nothing under test reads their values,
 * so there is no reason for a real caller's name, birth date or number to
 * enter the repository. (An earlier revision of this file carried the real
 * caller's first and last name from CA0ccc14d8 — corrected here.)
 */
const NO_OFFICE = {
  first_name: 'Testcaller',
  last_name: 'Optical',
  date_of_birth: '01/01/1950',
  callback_number: '555-555-0147',
  request_description: 'Order new glasses',
  call_sid: SID,
};

const OK = { success: true, ticketNumber: 'VA-99001' } as never;

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
});

describe('the first attempt still asks — the refusal IS the question', () => {
  it('does not POST at all, and so cannot claim the ask is spent', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    const res = await runTool('file_optical_ticket', NO_OFFICE);

    expect('missingFields' in (res as object)).toBe(true);
    expect((res as { missingFields: string[] }).missingFields).toContain('location');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the second attempt takes the request, and says why', () => {
  it('POSTs with routingAskExhausted so the app files it unassigned', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', NO_OFFICE); // spends the ask
    await runTool('file_optical_ticket', NO_OFFICE); // escapes

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ routingAskExhausted: true });
  });

  it('still carries the office the caller actually said, for the human routing it', async () => {
    // `locationOfLastVisit` is the manual step's only clue. An unassigned
    // ticket with no office AND no words is a ticket nobody can route.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', NO_OFFICE);
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'the one off the 60' });

    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.locationOfLastVisit).toBe('the one off the 60');
  });
});

describe('the narrowness — every guard, because the flag turns the app gate off', () => {
  /**
   * THE FIRST VERSION OF THIS BLOCK WAS DECORATION, and mutation testing is
   * the only reason that is known. Both tests asserted that `createTicket`
   * was NOT called — which is true whenever our own gate refuses first, so
   * they passed with the flag sent UNCONDITIONALLY. One was vacuous outright:
   * it looped over `create.mock.calls` to assert the flag was absent, and the
   * array was empty. A suite that proves a POST did not happen says nothing
   * about what a POST would carry (CLAUDE.md failure mode 10).
   *
   * Every test below now forces a POST and reads the payload.
   */
  it('is absent when the ask has NOT been spent — the guard that matters most', async () => {
    // Reaching a POST with the ask unspent needs the lookup to be DOWN: that
    // is the "take the request rather than lose it" path, which skips the
    // office gate entirely. Without `askedForOfficeAlready` in the condition
    // this call would tell the app the caller had been asked, when nobody
    // had asked them anything.
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('routingAskExhausted');
  });

  it('is absent once an office DID resolve, even on a call that was asked', async () => {
    // A ticket carrying a location_id needs no manual routing, so claiming
    // the routing ask is spent would be a lie the staffer acts on.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', NO_OFFICE); // spends the ask
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      locationId: 2,
      outcome: 'matched',
    } as never);
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.locationId).toBe(2);
    expect(payload).not.toHaveProperty('routingAskExhausted');
  });

  it('is absent on a DIFFERENT call that has never been asked', async () => {
    // Keyed on a real CallSid, never on a model argument. One caller's spent
    // ask must not file the next caller unassigned without ever asking them.
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', NO_OFFICE);
    await runTool('file_optical_ticket', NO_OFFICE);
    const last = create.mock.calls[create.mock.calls.length - 1][0];
    expect(last).toMatchObject({ routingAskExhausted: true });

    create.mockClear();
    await runTool('file_optical_ticket', {
      ...NO_OFFICE,
      call_sid: 'CA0ccc14d869f53c4c091fc16847dfe9e5',
      location: 'Anaheim',
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('routingAskExhausted');
  });

  it('is absent when the CallSid is a sentinel, so no counter can be shared', async () => {
    // "unknown" and "latest" are what a model sends when nothing was
    // injected. gateRefusalsSoFar refuses to key on them, so the ask is never
    // recorded and never spent — the caller is asked again, which is the
    // harmless direction to fail in. Forced to POST, or this is vacuous.
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    const sentinel = { ...NO_OFFICE, call_sid: 'unknown', location: 'Anaheim' };
    await runTool('file_optical_ticket', sentinel);
    await runTool('file_optical_ticket', sentinel);

    expect(create.mock.calls.length).toBeGreaterThan(0);
    for (const call of create.mock.calls) {
      expect(call[0]).not.toHaveProperty('routingAskExhausted');
    }
  });
});

describe('a request routed OFF the optical queue never spends this exemption', () => {
  it('does not claim the office ask is spent on a cross-queued ticket', async () => {
    // detectCrossQueue sends a surgery-date request to department 2, which is
    // ALSO in the app's DEPARTMENTS_WITH_UNASSIGNED_EXIT — so an unguarded
    // flag would tell surgery that ITS gate's question had been asked and
    // answered, on a call where nobody was ever asked about a surgeon.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OK);

    await runTool('file_optical_ticket', NO_OFFICE); // spends the OFFICE ask
    await runTool('file_optical_ticket', {
      ...NO_OFFICE,
      request_description: 'I need the date of my cataract surgery',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    if (payload.departmentId !== 1) {
      expect(payload).not.toHaveProperty('routingAskExhausted');
    } else {
      // Not cross-queued on this build: the guard is real but unexercised.
      expect(payload.departmentId).toBe(1);
    }
  });
});

describe("the SERVER's refusal spends the ask too — Codex P1 on #288", () => {
  /**
   * The hole the local gate leaves. Our office gate is skipped whenever the
   * caller DID name something, and skipped entirely when the lookup is
   * unavailable — so on those calls nothing local ever spends the ask, the
   * exemption is never attached, and the app answers the same missing-office
   * 400 on every retry, indefinitely.
   *
   * The test directly above ("is absent when the ask has NOT been spent")
   * pinned the FIRST attempt of exactly that path as correct, and it still
   * is: nobody has been asked yet. What was missing is the second attempt.
   */
  const OFFICE_400 = {
    success: false,
    statusCode: 400,
    error:
      'Missing required information: office. Optical tickets are assigned by office — ' +
      'ask which Azul Vision office the patient visits.',
  } as never;

  it('ONE 400 is not enough — the immediate identical retry must not spend it', async () => {
    /**
     * Round 2 of the same review, and the reason the server's refusals are
     * counted on their own key. The model is documented to repeat the tool
     * call within seconds, unchanged, before it says anything to the caller
     * — CA101be0fe842e77fd83a6024ae06df244, refused at 15:25:24.064 and
     * called again at 15:25:25.270 with an identical payload. If one 400
     * spent the ask, THIS attempt would file unassigned on the strength of a
     * question nobody asked.
     */
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OFFICE_400);

    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('routingAskExhausted');
  });

  it('TWO 400s do spend it — the third attempt files unassigned', async () => {
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(OFFICE_400)
      .mockResolvedValueOnce(OFFICE_400)
      .mockResolvedValue(OK);

    // Lookup down, caller named an office: our own gate never fires, so
    // before this fix nothing on the call could ever spend the ask and the
    // app answered the same 400 forever.
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).toMatchObject({ routingAskExhausted: true });
  });

  it('the server counter is SEPARATE — a 400 does not silence our own gate', async () => {
    /**
     * `askedForOfficeAlready` decides whether the LOCAL gate asks as well as
     * whether the exemption attaches. Folding the server's 400 into it would
     * make a 400 on one attempt suppress our own question on the next, so a
     * caller who then said nothing would never be asked at all.
     */
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(OFFICE_400);

    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    expect(create).toHaveBeenCalledTimes(1);

    // Same call, and now the caller has named no office at all. The local
    // gate has still never fired, so it must fire here rather than POST.
    const res = (await runTool('file_optical_ticket', NO_OFFICE)) as {
      missingFields?: string[];
    };

    expect(res.missingFields).toEqual(['location']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a refusal for a DIFFERENT field does not spend the office ask', async () => {
    /**
     * Only an OFFICE refusal puts the office question to the caller. A
     * surgeon or date-of-birth 400 has asked nothing about it.
     *
     * Three attempts, matching the test above exactly, so the two differ in
     * one variable: the field the server named. Two attempts would prove
     * nothing here now that the threshold is two — the flag would be absent
     * on attempt 2 whatever field was refused.
     */
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      outcome: 'unavailable',
    } as never);
    const SURGEON_400 = {
      success: false,
      statusCode: 400,
      error: 'Missing required information: surgeon.',
    } as never;
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_400)
      .mockResolvedValueOnce(SURGEON_400)
      .mockResolvedValue(OK);

    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });
    await runTool('file_optical_ticket', { ...NO_OFFICE, location: 'Anaheim' });

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty('routingAskExhausted');
  });
});
