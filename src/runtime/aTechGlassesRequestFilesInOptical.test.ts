/**
 * A TECH-LINE REQUEST ABOUT GLASSES OR CONTACT LENSES FILES IN OPTICAL — v253.
 *
 * The teardown sweep files in the lane's own department and ran no router,
 * while the tech line's own `file_tech_ticket` sends eyewear and contact
 * lenses to Optical (v202). A caller who asked the tech line for new glasses
 * and hung up before anything was filed landed in Technicians, and staff moved
 * the ticket.
 *
 * THE CORPUS: every swept tech-line agent ticket that carried a real request,
 * 2026-11-06 08:00 to 11-20 08:00 UTC (126), each description run through the
 * router. It names Optical on 5. Staff moved 4 of them to Optical and the
 * fifth to Medical Records. It names the HVA Hub on 3, and staff left all 3 in
 * Technicians, so only the Optical verdict is taken.
 *
 * The SIDs and ticket numbers are real; every word below is synthetic, in the
 * shape of the description each ticket carried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { resetDraftedRequests, noteDraftedRequestFromArgs } from '../tools/draftedRequest';
import { runRequestSweep, type SweepFiler, type NumberLookup } from './sweepRunner';
import {
  SWEPT_TICKET_DESCRIPTION,
  SWEPT_TO_OPTICAL_NOTE,
  sweptTechRequestForOptical,
  buildSweptTicket,
} from './requestSweep';
import type { RequestAsker } from './requestFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';

type Lane = 'optical' | 'surgery' | 'tech';

const GREETING: Record<Lane, string> = {
  optical: 'AGENT: Thank you for calling Azul Vision optical. I can take a message and they will follow up with you. Am I speaking with Testa?',
  surgery: 'AGENT: Thank you for calling Azul Vision surgery coordination. I can take a message and they will follow up with you. Am I speaking with Testa?',
  tech: 'AGENT: Thank you for calling Azul Vision clinical support. I can take a message and they will follow up with you. Am I speaking with Testa?',
};

function record(callSid: string, slug: Lane, callerLines: string[]): VoiceCallRecord {
  const lines = [GREETING[slug]];
  for (const said of callerLines) {
    lines.push(`CALLER: ${said}`);
    lines.push('AGENT: Thank you. Let me take a look at that for you. [interrupted]');
  }
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug,
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents: [{ name: 'lookup_patient', ok: true, succeeded: true }],
    agentTurns: callerLines.length + 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 76_000,
  } as VoiceCallRecord;
}

function filer(): SweepFiler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = (async (ticket: unknown) => {
    calls.push(ticket as Record<string, unknown>);
    return { success: true, ticketNumber: 'VA-SWEEP-1' };
  }) as SweepFiler & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

const noName = async () => null;
const onePerson: NumberLookup = async () => ({ firstName: 'Testa', lastName: 'Lake' });
const answers = (request: string | null): RequestAsker => async () => ({ request });

interface Row { sid: string; ticket: string; says: string[]; reads: string }

/** The router names Optical; staff moved each of these out of Technicians. */
const TO_OPTICAL: Row[] = [
  { sid: 'CA562b7c6dc958d262c4b906b0f007e348', ticket: 'VA-84905',
    says: ['Yes.', 'I need a prescription for computer glasses.'],
    reads: 'Requesting a prescription for computer glasses.' },
  { sid: 'CA0073d981ec1f0d93b86cea606175d8b9', ticket: 'VA-87031',
    says: ['Yes.', 'I want to talk to someone about new glasses for my son.'],
    reads: 'Requesting to speak to someone about getting new glasses for a family member.' },
  { sid: 'CA4ac2c83f89b3099175c7a34461f3e404', ticket: 'VA-87480',
    says: ['Yes.', 'I need a new prescription for my eyeglasses.'],
    reads: 'Wants a new eyeglass prescription.' },
  { sid: 'CAd11d904c897cc668a86ed96474e7fb1a', ticket: 'VA-87722',
    says: ['Yes.', 'I have a question about my contact lenses, can somebody call me?'],
    reads: 'Requesting to speak to someone about a question regarding contact lenses.' },
  // Staff moved this one to Medical Records, not Optical: it asks for copies of
  // a prescription. Either way it left Technicians; here it reaches Optical.
  { sid: 'CAd2cd5bebcf1bcb8848175b4d99469108', ticket: 'VA-81636',
    says: ['Yes.', 'Me and my husband need copies of our eyeglass prescriptions from our last visits.'],
    reads: 'Two existing patients need copies of recent eyeglass prescriptions from recent visits sent to them.' },
];

/** Tech-line requests the router does not send to Optical; staff left each in Technicians. */
const STAYS_IN_TECH: Row[] = [
  // The router names the HVA Hub on these three; that verdict is not taken.
  { sid: 'CAf55c28bbcdcb95f0c57d37e9a37e808d', ticket: 'VA-83529',
    says: ['Yes.', 'I have a referral and want an appointment, and my reading glasses broke.'],
    reads: 'Caller has a referral and would like to make an appointment. Also reports broken reading glasses that cannot be used.' },
  { sid: 'CA5c4e37204b2f8de7b366920f39dab819', ticket: 'VA-85844',
    says: ['Yes.', 'I want to make an appointment for my mom tomorrow.'],
    reads: 'Wants to make an appointment for her mom tomorrow.' },
  { sid: 'CAd40eb3844e07d31476c47be73d5ad5b0', ticket: 'VA-86286',
    says: ['Yes.', 'When was my eye exam? I need the date.'],
    reads: 'Asking for the date of their eye examination.' },
  { sid: 'CA05ebd7080999c6e5d39f315c7a9812f8', ticket: 'VA-85518',
    says: ['Yes.', 'I need a refill on my eye drops.'],
    reads: 'Requesting a refill for eye drops medication.' },
];

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  resetDraftedRequests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function sweep(row: Row, slug: Lane = 'tech', ask: RequestAsker = answers(row.reads)) {
  const f = filer();
  const out = await runRequestSweep(record(row.sid, slug, row.says), f, noName, onePerson, ask);
  return { out, f };
}

describe('the corpus: swept tech-line tickets about glasses, 2026-11-06..19', () => {
  it('holds the 5 the router sends to Optical and 4 controls', () => {
    expect(TO_OPTICAL).toHaveLength(5);
    expect(STAYS_IN_TECH).toHaveLength(4);
    expect(new Set([...TO_OPTICAL, ...STAYS_IN_TECH].map((r) => r.sid)).size).toBe(9);
  });

  it.each(TO_OPTICAL)('$sid ($ticket) files in Optical, not Technicians', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls).toHaveLength(1);
    const t = f.calls[0];
    expect(t.departmentId).toBe(1);
    expect(t.requestTypeId).toBe(66);
    expect(t.requestReasonId).toBe(536);
    // Optical routes by office; at teardown the ask is exhausted (v92).
    expect(t.routingAskExhausted).toBe(true);
    expect(t.description).toBe(row.reads);
    expect(String(t.staffNote)).toContain(SWEPT_TO_OPTICAL_NOTE);
    expect(t.slug).toBe('tech');
  });

  it.each(STAYS_IN_TECH)('$sid ($ticket) stays in Technicians', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    const t = f.calls[0];
    expect(t.departmentId).toBe(3);
    expect(t.routingAskExhausted).toBeUndefined();
    expect(String(t.staffNote)).not.toContain(SWEPT_TO_OPTICAL_NOTE);
  });
});

describe('only the tech line, and only a request read from the call', () => {
  it('an optical-line or surgery-line request about glasses keeps its own department', async () => {
    const row = TO_OPTICAL[2];
    for (const [slug, dept] of [['optical', 1], ['surgery', 2]] as const) {
      resetDraftedRequests();
      const { f } = await sweep({ ...row, sid: row.sid.replace(/.$/, slug === 'optical' ? '1' : '2') }, slug);
      expect(f.calls[0].departmentId).toBe(dept);
      expect(String(f.calls[0].staffNote)).not.toContain(SWEPT_TO_OPTICAL_NOTE);
    }
  });

  it('a call with no sentence read from it stays in Technicians, whatever the caller said', async () => {
    const row = TO_OPTICAL[0];
    const { out, f } = await sweep(row, 'tech', answers(null));
    expect(out.filed).toBe(true);
    expect(f.calls[0].departmentId).toBe(3);
    expect(f.calls[0].description).not.toContain('glasses');
  });

  it('a request the model drafted on the call routes the same way', async () => {
    const row = TO_OPTICAL[0];
    noteDraftedRequestFromArgs('classify_tech_request', {
      call_sid: row.sid,
      request_description: 'Caller wants a prescription for computer glasses.',
    });
    const { f } = await sweep(row, 'tech', answers(null));
    expect(f.calls[0].departmentId).toBe(1);
    expect(f.calls[0].description).toBe('Caller wants a prescription for computer glasses.');
    expect(String(f.calls[0].staffNote)).toContain(SWEPT_TO_OPTICAL_NOTE);
  });

  it('the drafted request decides over the sentence read from the recording', async () => {
    const row = TO_OPTICAL[0];
    noteDraftedRequestFromArgs('classify_tech_request', {
      call_sid: row.sid,
      request_description: 'Needs a refill on eye drops.',
    });
    const { f } = await sweep(row, 'tech', answers('Requesting a prescription for computer glasses.'));
    expect(f.calls[0].departmentId).toBe(3);
  });

  it('a swept glasses request with a symptom files in Technicians with no Optical note', async () => {
    const row: Row = {
      sid: 'CA00000000000000000000000000000c01', ticket: 'synthetic',
      says: ['Yes.', 'My glasses broke and my eye hurts.'],
      reads: 'My glasses broke and I have eye pain.',
    };
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].departmentId).toBe(3);
    expect(f.calls[0].routingAskExhausted).toBeUndefined();
    expect(String(f.calls[0].staffNote)).not.toContain(SWEPT_TO_OPTICAL_NOTE);
  });

  it('a placeholder description never routes', () => {
    expect(SWEPT_TICKET_DESCRIPTION).toBeTruthy();
    expect(sweptTechRequestForOptical('tech', undefined)).toBeNull();
    expect(sweptTechRequestForOptical('tech', '   ')).toBeNull();
  });
});

describe('sweptTechRequestForOptical', () => {
  it('names Optical for eyewear and contact lenses on the tech line', () => {
    expect(sweptTechRequestForOptical('tech', 'Wants a new eyeglass prescription.')?.departmentId).toBe(1);
    expect(sweptTechRequestForOptical('tech', '  Wants a new eyeglass prescription.  ')?.departmentId).toBe(1);
    const lens = sweptTechRequestForOptical('tech', 'Requesting to speak to someone about a question regarding contact lenses.');
    expect(lens?.departmentId).toBe(1);
  });

  it('takes no other verdict', () => {
    expect(sweptTechRequestForOptical('tech', 'Wants to make an appointment for her mom tomorrow.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Requesting a refill for eye drops medication.')).toBeNull();
  });

  it('reads no lane but tech', () => {
    expect(sweptTechRequestForOptical('optical', 'Wants a new eyeglass prescription.')).toBeNull();
    expect(sweptTechRequestForOptical('surgery', 'Wants a new eyeglass prescription.')).toBeNull();
    expect(sweptTechRequestForOptical('records', 'Wants a new eyeglass prescription.')).toBeNull();
  });

  // github-actions on #499 (head c354002), a P1: a symptom must reach clinical
  // triage, so eyewear beside a clinical complaint stays in Technicians.
  it('keeps a glasses request that carries a clinical complaint in Technicians', () => {
    expect(sweptTechRequestForOptical('tech', 'My glasses broke and I have eye pain.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Caller needs new glasses and reports blurry vision since yesterday.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Question about contact lenses; the eye is red and painful.')).toBeNull();
    // Words only the shared complaint list knows, so neither arm stands in for the other.
    expect(sweptTechRequestForOptical('tech', 'Needs new glasses and has light sensitivity since yesterday.')).toBeNull();
  });

  // github-actions on #499 (head cc93940), round 2, a P1: a sight change said
  // without a word hasClinicalComplaint knows. The veto now also reads the
  // after-hours gate's caller-symptom lexicon, and "seeing double".
  it('keeps a glasses request with a sudden sight change in Technicians', () => {
    expect(sweptTechRequestForOptical('tech',
      'I need a new eyeglass prescription and suddenly started seeing double.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Needs new glasses; sees double since this morning.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Wants new glasses and reports double vision.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Needs new glasses and has been seeing flashes and floaters.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Contact lens question; a shadow came over her vision.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Question about contact lenses, the eye is itchy and watering.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Necesita lentes nuevos y veo doble desde ayer.')).toBeNull();
    // Read in any case, and with a curly apostrophe.
    expect(sweptTechRequestForOptical('tech', 'Seeing double since this morning, needs new glasses.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', 'Needs new glasses and can\u2019t see out of the left eye.')).toBeNull();
  });

  it('the wider veto still lets an ordinary glasses request through', () => {
    expect(sweptTechRequestForOptical('tech', 'Wants a second pair of glasses, double-checking the price.')?.departmentId).toBe(1);
    expect(sweptTechRequestForOptical('tech', 'Needs new reading glasses to see better up close.')?.departmentId).toBe(1);
  });

  it('a swept glasses request that sees double files in Technicians', async () => {
    const row: Row = {
      sid: 'CA00000000000000000000000000000c02', ticket: 'synthetic',
      says: ['Yes.', 'I need new glasses and all of a sudden I see double.'],
      reads: 'I need a new eyeglass prescription and suddenly started seeing double.',
    };
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].departmentId).toBe(3);
    expect(String(f.calls[0].staffNote)).not.toContain(SWEPT_TO_OPTICAL_NOTE);
  });

  it('none of the 5 corpus requests carries a complaint, so the guard costs no rescue', () => {
    for (const row of TO_OPTICAL) {
      expect(sweptTechRequestForOptical('tech', row.reads)?.departmentId).toBe(1);
    }
  });

  // v254, the safety-direction P1 on #499 (merged before its fix): the model's
  // sentence can leave out a symptom the caller said, so the caller's own
  // lines are read too. Agent lines are not.
  it('keeps a glasses request in Technicians when only the caller\'s own words name a symptom', () => {
    const plain = 'Wants a new eyeglass prescription.';
    expect(sweptTechRequestForOptical('tech', plain,
      'Yes. I need new glasses and my eye has been red and painful since yesterday.')).toBeNull();
    // Words only CALLER_SYMPTOM knows, and the one only SEES_DOUBLE knows.
    expect(sweptTechRequestForOptical('tech', plain, 'Contacts question. My eye is itchy and watering.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', plain, 'New glasses please. I keep seeing double.')).toBeNull();
    // A word only the shared complaint list knows.
    expect(sweptTechRequestForOptical('tech', plain, 'New glasses, and I have light sensitivity.')).toBeNull();
    expect(sweptTechRequestForOptical('tech', plain, 'Necesito lentes nuevos, me duele el ojo.')).toBeNull();
  });

  it('caller words with no symptom, or none at all, change nothing', () => {
    const plain = 'Wants a new eyeglass prescription.';
    expect(sweptTechRequestForOptical('tech', plain, 'Yes. I need a new prescription for my eyeglasses.')?.departmentId).toBe(1);
    expect(sweptTechRequestForOptical('tech', plain, '')?.departmentId).toBe(1);
    expect(sweptTechRequestForOptical('tech', plain)?.departmentId).toBe(1);
    // Never a reason to route anywhere it would not have gone.
    expect(sweptTechRequestForOptical('tech', 'Requesting a refill for eye drops medication.', 'Yes.')).toBeNull();
    expect(sweptTechRequestForOptical('optical', plain, 'Yes.')).toBeNull();
  });

  it('a swept call whose caller said a symptom the sentence left out files in Technicians', async () => {
    const row: Row = {
      sid: 'CA00000000000000000000000000000c03', ticket: 'synthetic',
      says: ['Yes.', 'I need new glasses, and my eye has been red and painful since yesterday.'],
      reads: 'Wants a new eyeglass prescription.',
    };
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].departmentId).toBe(3);
    expect(f.calls[0].routingAskExhausted).toBeUndefined();
    expect(String(f.calls[0].staffNote)).not.toContain(SWEPT_TO_OPTICAL_NOTE);
  });

  it('a symptom word in the agent\'s line does not keep the request out of Optical', async () => {
    const row = TO_OPTICAL[2];
    const rec = record(row.sid, 'tech', row.says);
    rec.transcript = rec.transcript.replace(
      'AGENT: Thank you. Let me take a look at that for you. [interrupted]',
      'AGENT: Any pain, redness or blurry vision with that eye?',
    );
    const f = filer();
    await runRequestSweep(rec, f, noName, onePerson, answers(row.reads));
    expect(f.calls[0].departmentId).toBe(1);
    expect(String(f.calls[0].staffNote)).toContain(SWEPT_TO_OPTICAL_NOTE);
  });

  it('the 5 corpus calls\' caller lines carry no symptom, so the caller-words check costs no rescue', () => {
    for (const row of TO_OPTICAL) {
      expect(sweptTechRequestForOptical('tech', row.reads, row.says.join(' '))?.departmentId).toBe(1);
    }
  });

  it('is what buildSweptTicket reads', () => {
    expect(buildSweptTicket.toString()).toContain('sweptTechRequestForOptical');
  });
});
