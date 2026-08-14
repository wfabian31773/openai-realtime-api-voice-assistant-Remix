/**
 * THE THREE TOOLS EVERY QUEUE STANDS ON, and until now the only module in the
 * library without a test file of its own.
 *
 * optical/surgery/tech/records each had one; `lookup_patient`,
 * `resolve_location` and `check_open_tickets` — the shared foundation all four
 * call first — had none. Operator, 2026-08-14: *"I want to go through the
 * process of building the library to its completeness, verified, stable, so
 * our agents can just call it."* This is the base of that.
 *
 * WHAT IS ACTUALLY UNDER TEST HERE. Not the services — `scheduleLookupService`
 * and the Console directory have their own. What these tools own, and what has
 * broken in production, is the CONTRACT AROUND those services:
 *
 *   - which refusal envelope comes back, because the model's next move depends
 *     on whether it reads as a fault or as a question to ask;
 *   - whether a value the process already holds (`caller_phone`) is used when
 *     the model forgets to pass it;
 *   - whether the answer is shaped for the queue that asked.
 *
 * Every service call is stubbed at its module boundary so these run anywhere.
 * The stubs return the SHAPES the real services return, taken from their type
 * signatures — a stub that lies is worse than no test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

// ---------------------------------------------------------------- stubs

const lookupPatient = vi.fn();
const checkOpenTickets = vi.fn();
const lookupLocation = vi.fn();
const isDirectoryConfigured = vi.fn(() => true);

vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: (...a: unknown[]) => lookupPatient(...a) },
}));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: { checkOpenTickets: (...a: unknown[]) => checkOpenTickets(...a) },
}));
vi.mock('../services/consoleDirectory', () => ({
  lookupLocation: (...a: unknown[]) => lookupLocation(...a),
  isDirectoryConfigured: () => isDirectoryConfigured(),
}));

const { getTool } = await import('./registry');
await import('./sharedPatientTools');

const run = (name: string, input: Record<string, unknown>) => getTool(name)!.handler(input) as Promise<any>;

/** A found patient, in the shape scheduleLookupService returns. */
const FOUND = {
  patientFound: true,
  patientName: 'Wayne Fabian',
  matchedBy: 'phone',
  identity: { unique: true, candidateCount: 1 },
  pastAppointments: [{ location: 'Encinitas' }, { location: 'Redlands' }],
  lastLocationSeen: 'Encinitas',
  lastProviderSeen: 'Timothy Hammill',
  lastVisitDate: '2026-07-01',
  totalAppointmentsFound: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  isDirectoryConfigured.mockReturnValue(true);
  lookupLocation.mockResolvedValue({ canonical: 'Azul Vision Encinitas', facilityKind: 'clinic' });
});

// ---------------------------------------------------------------- lookup_patient

describe('lookup_patient', () => {
  it('uses the number the call arrived on when the model does not pass one', async () => {
    /**
     * The live failure, 2026-08-13: the transcriber heard "Thanks." and "No.
     * March 17th, 1973." for a name and date of birth, the model looked up
     * that mangled trio, and the tool answered "no record found" for a patient
     * the process had matched by phone before the caller spoke.
     *
     * `caller_phone` is injected as call context on every tool. It must never
     * depend on the model remembering to type it out.
     */
    lookupPatient.mockResolvedValue(FOUND);
    const r = await run('lookup_patient', { caller_phone: '+17605551234' });
    expect(r.found).toBe(true);
    expect(lookupPatient).toHaveBeenCalledWith(expect.objectContaining({ phone: '+17605551234' }));
  });

  it('retries on the caller phone when name+DOB misses', async () => {
    // One mis-transcribed field is far likelier than a stranger, and the
    // number is the one piece nobody misheard.
    lookupPatient
      .mockResolvedValueOnce({ patientFound: false })
      .mockResolvedValueOnce(FOUND);
    const r = await run('lookup_patient', {
      caller_phone: '+17605551234',
      first_name: 'Thanks',
      last_name: 'No',
      date_of_birth: 'March 17th 1973',
    });
    expect(r.found).toBe(true);
    expect(lookupPatient).toHaveBeenCalledTimes(2);
    expect(lookupPatient).toHaveBeenLastCalledWith({ phone: '+17605551234' });
  });

  it('does NOT mutate the object the service returned', async () => {
    // `Object.assign(ctx, byPhone)` corrupted a shared fixture once. The
    // service still owns what it handed us.
    const missObj = { patientFound: false };
    lookupPatient.mockResolvedValueOnce(missObj).mockResolvedValueOnce(FOUND);
    await run('lookup_patient', { caller_phone: '+1760', first_name: 'A', last_name: 'B', date_of_birth: 'C' });
    expect(missObj).toEqual({ patientFound: false });
  });

  it('refuses as a MISSING FIELD when it has neither a phone nor a full trio', async () => {
    // Half a trio is not a lookup. The refusal must name the fields so the
    // agent asks for them rather than reporting a technical problem.
    const r = await run('lookup_patient', { first_name: 'Wayne' });
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(expect.arrayContaining(['last_name', 'date_of_birth']));
    expect(r.missingFields).not.toContain('first_name');
    expect(lookupPatient).not.toHaveBeenCalled();
  });

  it('reports "not found" as a success, not a failure', async () => {
    // A patient we do not have is a real answer. Returning success:false here
    // makes the model narrate a system fault at the caller.
    lookupPatient.mockResolvedValue({ patientFound: false });
    const r = await run('lookup_patient', { caller_phone: '+17605551234' });
    expect(r.success).toBe(true);
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/no record found/i);
  });

  it('warns, and withholds history, when the match is one of several people', async () => {
    // Wayne's own number resolves to eight records in the mirror. An uncertain
    // match is one real person's record and still a guess among several.
    lookupPatient.mockResolvedValue({ ...FOUND, identity: { unique: false, candidateCount: 8 } });
    const r = await run('lookup_patient', { caller_phone: '+17605551234' });
    expect(r.identity_is_certain).toBe(false);
    expect(r.identity_warning).toMatch(/8 different people/);
    expect(r.identity_warning).toMatch(/do not read their history back/i);
  });

  it('shapes the usual office for the QUEUE that asked', async () => {
    /**
     * A real patient's most recent visit was a SURGERY CENTRE. Optical assigns
     * by location, so filing a glasses ticket against a building with no
     * optician never reaches anyone; for Surgery that same visit is the most
     * useful fact on the call.
     */
    lookupPatient.mockResolvedValue({
      ...FOUND,
      pastAppointments: [{ location: 'Loma Linda Surgery Center' }, { location: 'Encinitas' }],
    });
    lookupLocation.mockImplementation(async (n: string) =>
      /surgery/i.test(n)
        ? { canonical: n, facilityKind: 'surgery_center' }
        : { canonical: n, facilityKind: 'clinic' },
    );

    const optical = await run('lookup_patient', { caller_phone: '+1760', queue: 'optical' });
    expect(optical.usual_office).toBe('Encinitas');

    const surgery = await run('lookup_patient', { caller_phone: '+1760', queue: 'surgery' });
    expect(surgery.usual_office).toBe('Loma Linda Surgery Center');

    // The raw most-recent stays available to both, clearly labelled.
    expect(optical.last_location_any_kind).toBe('Encinitas');
  });

  it('asks the right question when the history has nothing this queue can use', async () => {
    lookupPatient.mockResolvedValue({ ...FOUND, pastAppointments: [{ location: 'Loma Linda Surgery Center' }] });
    lookupLocation.mockResolvedValue({ canonical: 'Loma Linda Surgery Center', facilityKind: 'surgery_center' });
    const r = await run('lookup_patient', { caller_phone: '+1760', queue: 'optical' });
    expect(r.usual_office).toBeNull();
    expect(r.message).toMatch(/glasses or contacts/i);
  });

  it('is neutral with no queue — the HTTP surface is not a queue', async () => {
    lookupPatient.mockResolvedValue({ ...FOUND, pastAppointments: [{ location: 'Loma Linda Surgery Center' }] });
    lookupLocation.mockResolvedValue({ canonical: 'Loma Linda Surgery Center', facilityKind: 'surgery_center' });
    const r = await run('lookup_patient', { caller_phone: '+1760' });
    expect(r.usual_office).toBe('Loma Linda Surgery Center');
  });

  it('falls back to the most recent visit when the directory is unreachable', async () => {
    // A best guess beats blocking the call; file_*_ticket resolves it against
    // the ticketing app before anything is written.
    isDirectoryConfigured.mockReturnValue(false);
    lookupPatient.mockResolvedValue(FOUND);
    const r = await run('lookup_patient', { caller_phone: '+1760', queue: 'optical' });
    expect(r.usual_office).toBe('Encinitas');
  });
});

// ---------------------------------------------------------------- resolve_location

describe('resolve_location', () => {
  it('refuses as a missing field when nothing matches, so the agent ASKS', async () => {
    /**
     * This returned `success: true, verified: false` until 2026-08-13. The
     * message told the agent to go and ask the caller; the envelope said the
     * call had WORKED — so the model retried it, ten times in a row on one
     * 236-second call, and five optical calls that day averaged 229s against
     * 134s without ever reaching `resolved`.
     */
    lookupLocation.mockResolvedValue(null);
    const r = await run('resolve_location', { spoken_location: 'Downtown LA', queue: 'optical' });
    expect(r.success).toBe(false);
    expect(r.missingFields).toContain('spoken_location');
    expect(r.message).toMatch(/which city/i);
  });

  it('files under the name the RECEIVER stores, not the mirror\'s', async () => {
    // "Azul Vision DTLA" in the mirror is "Los Angeles" in the ticketing app.
    // Brand-stripping alone yields "DTLA", a name the receiver never heard of.
    lookupLocation.mockResolvedValue({
      canonical: 'Azul Vision DTLA',
      facilityKind: 'clinic',
      fileAs: 'Los Angeles',
    });
    const r = await run('resolve_location', { spoken_location: 'Downtown LA' });
    expect(r.verified).toBe(true);
    expect(r.location).toBe('Los Angeles');
    expect(r.canonical_name).toBe('Azul Vision DTLA');
  });

  it('tells the queue whether it can action a request there', async () => {
    lookupLocation.mockResolvedValue({ canonical: 'Loma Linda Surgery Center', facilityKind: 'surgery_center' });
    const optical = await run('resolve_location', { spoken_location: 'Loma Linda', queue: 'optical' });
    const surgery = await run('resolve_location', { spoken_location: 'Loma Linda', queue: 'surgery' });
    expect(optical.usable_for_this_queue).toBe(false);
    expect(surgery.usable_for_this_queue).toBe(true);
  });

  it('asks for the office when given nothing usable', async () => {
    const r = await run('resolve_location', { spoken_location: '   ' });
    expect(r.success).toBe(false);
    expect(r.missingFields).toContain('spoken_location');
    expect(lookupLocation).not.toHaveBeenCalled();
  });

  it('passes the words through when the directory is unavailable', async () => {
    // No mirror is not the same as no match: blocking the call would be worse
    // than handing on what the caller said.
    isDirectoryConfigured.mockReturnValue(false);
    const r = await run('resolve_location', { spoken_location: 'Encinitas' });
    expect(r.success).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.location).toBe('Encinitas');
  });
});

// ---------------------------------------------------------------- check_open_tickets

describe('check_open_tickets', () => {
  it('reports an existing request so a second one is not opened', async () => {
    checkOpenTickets.mockResolvedValue([
      { ticketNumber: 'VA-51000', reason: 'Glasses Ready - Pickup', daysAgo: 3 },
    ]);
    const r = await run('check_open_tickets', { phone: '+17605551234' });
    expect(r.has_open_tickets).toBe(true);
    expect(r.open_tickets[0]).toEqual({
      ticket_number: 'VA-51000',
      reason: 'Glasses Ready - Pickup',
      days_ago: 3,
    });
  });

  it('says so plainly when there are none', async () => {
    checkOpenTickets.mockResolvedValue([]);
    const r = await run('check_open_tickets', { phone: '+17605551234' });
    expect(r.success).toBe(true);
    expect(r.has_open_tickets).toBe(false);
    expect(r.open_tickets).toEqual([]);
  });
});

// ---------------------------------------------------------------- the contract

describe('the library contract these three must keep', () => {
  it('registers all three as agent-facing tools', () => {
    for (const n of ['lookup_patient', 'resolve_location', 'check_open_tickets']) {
      const t = getTool(n);
      expect(t, `${n} is not registered`).toBeTruthy();
      expect(t!.layer).toBe('agent');
    }
  });

  it('never declares `queue` in a schema — the model must not be able to set it', () => {
    // It is injected as call context. If it were declared, the model could
    // choose which queue's rules to be judged by.
    for (const n of ['lookup_patient', 'resolve_location', 'check_open_tickets']) {
      const props = (getTool(n)!.input_schema as any)?.properties ?? {};
      expect(Object.keys(props), `${n} exposes queue`).not.toContain('queue');
    }
  });

  it('gives every schema field a speakable askAs', () => {
    // The refusal contract: a tool asking for something hands the agent the
    // sentence to say. A field with no askAs makes the model invent one.
    for (const n of ['lookup_patient', 'resolve_location', 'check_open_tickets']) {
      const props = (getTool(n)!.input_schema as any)?.properties ?? {};
      for (const [field, def] of Object.entries<any>(props)) {
        expect(def.askAs, `${n}.${field} has no askAs`).toBeTruthy();
      }
    }
  });
});
