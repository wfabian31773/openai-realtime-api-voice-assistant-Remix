/**
 * v270: the NPX outreach agent gives the practice phone a tool holds, said in
 * three groups, and never one from memory.
 *
 * The corpus, by real SID (npx-outreach, calls of 30 s or more, the 14 days
 * to 2026-11-23): 22 calls asked for a phone number, and 15 of 85 bookings
 * asked for one after booking.
 *
 *  (A1) The partner practice's phone, asked for once the choices were read.
 *       find_sooner_exam's options carried no phone, so the agent refused
 *       ("I'm not able to give out that number") and filed a staff callback:
 *       CA2ae48079d47b3c31554023afa7b89ed3 (VA-88374),
 *       CAaee4486d7911d60fa7bc57e80510cf7e (VA-84173).
 *  (A2) Our own office's phone, asked for by a verified caller: the agent
 *       named offices from the knowledge pack and said a garbled number:
 *       CA6a7ffd6bf215505f505c66289c5ddc71 (VA-84157, office Rancho Cucamonga).
 *       Correctly refused: CA6cf7585fa87eb09518d6cc836cf6ac8b (never verified,
 *       so no number is owed).
 *  (B)  The booking confirmation read NPX's phone as stored, ten bare digits,
 *       which the voice reads as one number ("five billion…"): 50 bookings
 *       read it raw, 12 grouped. Corpus:
 *       CA91bcaafe9cb062a01efa35340ca2cced, CA63cf07b6040214749cc23fb49fd31140,
 *       CA1f1c5faa635345a854953f139d40274b, CAff5c8554f9755043ca47032e63453b1b,
 *       CAad13e739a6bbd3a526540135f6965770, CAb99be46d17c8ee40822c9e3dc962aba6,
 *       CAb84bc43b14136b999ab72eab30f62ca7, CA2d94c42669f3c07a5fc5c8fa5c513417,
 *       CAb32cba3761bad02e1afe744bec661b51, CA0824b4d82426b74333b0ee53ba9d45df.
 *  (C)  Already fixed by v247 (a booked caller hears their booking, phone in
 *       three groups): CA386f88c848dcd4d74bf07d29c314fcc8,
 *       CA905d586103b7a1fa484b1813c53bcd75, CA59e06c14429d4fadd43b73974cd9462c,
 *       CAd9744c26bc5cab62421b660cae8f9c53. Pinned in
 *       aBookedCallerHearsTheirBooking.test.ts.
 *
 * Synthetic patient, ids and partner phones (555); the Azul office phones are
 * read from the practice's own office list, never written here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from './registry';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  confirmation,
  npxBookingPageLane,
  ourOfficePhone,
  resetOutreachAvailabilityForTests,
  resetOutreachSessionsForTests,
  setNpxOutreachDepsForTests,
  spokenPhone,
  writtenPhone,
} from './npxOutreachTools';
import { AZUL_VISION_LOCATIONS } from '../config/azulVisionKnowledge';
import { createNpxOutreachAgent } from '../agents/npxOutreachAgent';
import type { OutboundContact } from '../runtime/outbound/campaign';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import type { NpxOutreachClient, NpxSlot } from '../services/npxOutreachClient';
import type { AzulCancelResult } from '../services/outreachAzulCancel';

/** A partner phone as NPX stores it on 19 of its 24 clinics: ten bare digits. */
const BARE = '5550100000';
const GROUPED = '555, 010, 0000';

function slot(id: string, startAt: string, phone: string | null = BARE): NpxSlot {
  return {
    slotId: id,
    startAt,
    endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(),
    timezone: 'America/Los_Angeles',
    day: startAt.slice(0, 10),
    partnerOrgId: 'p1',
    partnerName: 'Partner One Optometry',
    clinicId: 'clinic-1',
    clinicName: 'Clinic One',
    address: '1 Test Ave, Chino Hills, CA 91709',
    phone: (phone ?? undefined) as string,
    providerName: 'Dr Test',
    visitType: 'Comprehensive Exam',
  };
}

const FEB5 = slot('feb5', '2041-02-05T17:00:00.000Z');
const FEB6 = slot('feb6', '2041-02-06T17:00:00.000Z');

const DATA = {
  source: 'console_movable',
  appointment_id: 'appt-0001',
  person_id: 'person-0001',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  event_name: 'Dilated Exam',
  office: 'Rancho Cucamonga',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};

/** The office's phone in the practice's own list, said in three groups. */
const packPhone = (name: string) => spokenPhone(AZUL_VISION_LOCATIONS.find((l) => l.name === name)!.phone);

let store: FakeOutboundStore;
let attemptId: string;
let available: NpxSlot[];

async function setUp(sid: string, office: string | undefined = DATA.office) {
  resetOutreachSessionsForTests();
  resetOutreachAvailabilityForTests();
  store = new FakeOutboundStore();
  const customData: Record<string, unknown> = { ...DATA };
  if (office === undefined) delete customData.office;
  else customData.office = office;
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData });
  attemptId = await store.startAttempt('c1', store.campaignId, 1);
  setNpxOutreachDepsForTests({
    npx: {
      configured: true,
      availability: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: available, truncated: false })),
      offer: vi.fn(async () => ({ ok: true, latestDay: '2041-02-27', slots: available })),
      book: vi.fn(async (req: { slotId: string }) => ({
        ok: true,
        bookingId: `booking-${req.slotId}`,
        alreadyBooked: false,
        recordGroupDiffers: false,
        slot: available.find((s) => s.slotId === req.slotId),
      })),
      reportCancel: vi.fn(async () => ({ ok: true })),
    } as unknown as NpxOutreachClient,
    cancel: vi.fn(async (): Promise<AzulCancelResult> => ({ cancelled: true, alreadyCancelled: false })) as never,
    store: async () => store,
    fileTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-90001' })) as never,
  });
  return (name: string, extra: Record<string, unknown> = {}) =>
    getTool(name)!.handler({
      outbound_contact_id: 'c1',
      outbound_attempt_id: attemptId,
      outbound_phone: '+15555550111',
      outbound_campaign: 'npx-outreach',
      outbound_call_sid: sid,
      ...extra,
    }) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.stubEnv('NPX_OUTREACH_MODE', 'live');
  available = [FEB5, FEB6];
});

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  vi.unstubAllEnvs();
});

type Option = { date: string; time: string; phone?: string };

describe('(A1) the partner practice phone is in the choices the agent read', () => {
  it.each([
    ['CA2ae48079d47b3c31554023afa7b89ed3', 'Riverside Latham'],
    ['CAaee4486d7911d60fa7bc57e80510cf7e', 'Riverside Latham'],
  ])('%s: every choice carries its practice phone in three groups, and the next step says to give it', async (sid, office) => {
    const run = await setUp(sid, office);
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    const found = await run(FIND_SOONER_TOOL_NAME, { from_date: '2041-02-05', to_date: '2041-02-06' });
    const options = found.options as Option[];
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.phone).toBe(GROUPED);
    expect(JSON.stringify(options)).not.toContain(BARE);
    expect(String(found.next)).toMatch(/If they ask for a practice's phone number, say that choice's phone exactly as written here, never any other number/);
  });

  it('a choice with no phone on file carries none, and no other number stands in', async () => {
    available = [slot('nophone', '2041-02-05T17:00:00.000Z', null)];
    const run = await setUp('CA2ae48079d47b3c31554023afa7b89ed3');
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    const found = await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05' });
    expect((found.options as Option[])[0]).not.toHaveProperty('phone');
  });
});

describe('(A2) our own office phone, once the date of birth matches', () => {
  it('CA6a7ffd6bf215505f505c66289c5ddc71 (Rancho Cucamonga): the verified answer carries that office\'s phone from the office list', async () => {
    const run = await setUp('CA6a7ffd6bf215505f505c66289c5ddc71', 'Rancho Cucamonga');
    const r = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    expect(r.verified).toBe(true);
    expect(r.our_office_phone).toBe(packPhone('Rancho Cucamonga'));
  });

  it('a repeat confirmation after the match still carries it', async () => {
    const run = await setUp('CA6a7ffd6bf215505f505c66289c5ddc71', 'Rancho Cucamonga');
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    const again = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    expect(again.our_office_phone).toBe(packPhone('Rancho Cucamonga'));
  });

  it('CA6cf7585fa87eb09518d6cc836cf6ac8b (Covina, never verified): no office phone before the date of birth matches', async () => {
    const run = await setUp('CA6cf7585fa87eb09518d6cc836cf6ac8b', 'Covina');
    const wrong = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'March 3rd, 1961' });
    expect(wrong.verified).not.toBe(true);
    expect(wrong).not.toHaveProperty('our_office_phone');
    expect(JSON.stringify(wrong)).not.toContain(packPhone('Covina'));
  });

  it.each([
    ['Riverside Latham', 'Riverside'],
    ['DTLA', 'Los Angeles (DTLA)'],
    ['Mission Hlls', 'Mission Hills'],
    ['Willow', 'Long Beach Willow'],
    ['Redlands', 'Redlands'],
    ['redlands ', 'Redlands'],
    ['Upland', 'Upland'],
  ])('the movable list\'s "%s" reads the office list\'s %s', (movable, listed) => {
    const c = { data: { office: movable } } as unknown as OutboundContact;
    expect(ourOfficePhone(c)).toBe(packPhone(listed));
  });

  it.each([['Atlantis Eyecare Downey'], ['Atlantis Eyecare'], ['Montebello West'], ['Test Office'], [''], ['   '], ['constructor'], ['__proto__']])(
    '"%s" reads no phone: never one taken from a near name',
    async (office) => {
      expect(ourOfficePhone({ data: { office } } as unknown as OutboundContact)).toBeUndefined();
      const run = await setUp('CA6a7ffd6bf215505f505c66289c5ddc71', office);
      const r = await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
      expect(r.verified).toBe(true);
      expect(r).not.toHaveProperty('our_office_phone');
    },
  );

  it('a contact with no office reads none', () => {
    expect(ourOfficePhone({ data: {} } as unknown as OutboundContact)).toBeUndefined();
  });
});

describe('(B) the booking confirmation says the practice phone in three groups', () => {
  it.each([
    ['CA91bcaafe9cb062a01efa35340ca2cced'],
    ['CA63cf07b6040214749cc23fb49fd31140'],
    ['CA1f1c5faa635345a854953f139d40274b'],
    ['CAff5c8554f9755043ca47032e63453b1b'],
    ['CAad13e739a6bbd3a526540135f6965770'],
    ['CAb99be46d17c8ee40822c9e3dc962aba6'],
    ['CAb84bc43b14136b999ab72eab30f62ca7'],
    ['CA2d94c42669f3c07a5fc5c8fa5c513417'],
    ['CAb32cba3761bad02e1afe744bec661b51'],
    ['CA0824b4d82426b74333b0ee53ba9d45df'],
  ])('%s: "Their phone number is 555, 010, 0000.", never the bare digits', async (sid) => {
    const run = await setUp(sid);
    await run(CONFIRM_DOB_TOOL_NAME, { date_of_birth: 'January 2nd, 1950' });
    const found = await run(FIND_SOONER_TOOL_NAME, { on_date: '2041-02-05' });
    const pick = (found.options as Option[])[0];
    const booked = await run(BOOK_SOONER_TOOL_NAME, { date: pick.date, time: pick.time });
    expect(booked.success).toBe(true);
    const said = String(booked.say);
    expect(said).toContain(`Their phone number is ${GROUPED}.`);
    expect(said).not.toContain(BARE);
  });

  it('a slot with no phone says no phone sentence at all', () => {
    const said = confirmation(slot('x', '2041-02-05T17:00:00.000Z', null), 'held', 'Wednesday, March 20');
    expect(said).not.toMatch(/phone/i);
    expect(said).not.toContain('undefined');
  });

  it('a phone NPX stores already punctuated, or with a leading 1, reads the same three groups', () => {
    for (const p of ['555-010-0000', '(555) 010-0000', '+15550100000', '15550100000']) {
      expect(confirmation(slot('x', '2041-02-05T17:00:00.000Z', p), 'held', 'Wednesday, March 20')).toContain(
        `Their phone number is ${GROUPED}.`,
      );
    }
  });

  it('the text link\'s page shows the phone written for a screen: (555) 010-0000', async () => {
    await setUp('text-link');
    const contact: OutboundContact = {
      contactId: 'c1',
      campaignId: store.campaignId,
      attemptId: '',
      phone: '+15555550111',
      firstName: 'Testa',
      lastName: 'Synthetic',
      data: DATA,
    };
    const r = await npxBookingPageLane.book({ contact, demo: false, openingId: 'feb5', callRef: 'text-link-c1', deadline: Date.now() + 36_000 });
    expect(r.ok).toBe(true);
    const shown = r.ok ? r.confirmation : '';
    expect(shown).toContain('Their phone number is (555) 010-0000.');
    expect(shown).not.toContain(GROUPED);
    expect(shown).not.toContain(BARE);
  });

  it('writtenPhone and spokenPhone leave a number that is not ten digits as it was', () => {
    expect(writtenPhone('555-0100')).toBe('555-0100');
    expect(spokenPhone('555-0100')).toBe('555-0100');
    expect(writtenPhone('+1 (555) 010-0000')).toBe('(555) 010-0000');
  });
});

describe('the prompt: a phone is said only as a tool gave it', () => {
  it('names where a phone may come from, and to file a staff callback for any other', async () => {
    await setUp('CA6a7ffd6bf215505f505c66289c5ddc71');
    const contact: OutboundContact = {
      contactId: 'c1',
      campaignId: store.campaignId,
      attemptId,
      phone: '+15555550111',
      firstName: 'Testa',
      lastName: 'Synthetic',
      data: DATA,
    };
    const agent = createNpxOutreachAgent(async () => undefined, { outbound: contact });
    const p = String((agent as unknown as { instructions: unknown }).instructions);
    expect(p).toMatch(/Say a phone number only as a tool gave it to you: a partner practice's from its choice in find_sooner_exam or from a booking book_sooner_exam or confirm_patient_birthdate reads back, or our office's \(our_office_phone\) once confirm_patient_birthdate answers verified\./);
    expect(p).toMatch(/Never give one from memory or make one up\. If no tool gave you the one they want, call request_staff_callback with what they want\./);
  });
});
