/**
 * A CALL WITH NO REQUEST FILES NOTHING — v242, HELD FOR THE OPERATOR.
 *
 * The policy question this answers is the operator's (standing instruction
 * 1), so the PR that carries it stays a draft until he rules. The proposal:
 * when the teardown sweep's reader (v201, `requestFromTheRecording.ts`) asks
 * the model what the caller asked and the model answers that they asked for
 * NOTHING, a queue lane files no ticket. The records lane still files (the
 * Corrective Action Plan SOP: every access request logged on day one, and a
 * "nothing" there is the reader's word against a statutory clock). A caller
 * who asked only for a person still files: whether v204's PCP rule extends to
 * the queue lanes is a second question for him, not this one.
 *
 * THE CORPUS: every queue-lane agent ticket whose description was the sweep's
 * placeholder ("Callback request taken during your call…") on the Pacific days
 * 2026-11-12 and 2026-11-13 — 24 tickets, read call by call:
 *
 *                       optical/surgery/tech   records
 *   no request at all            3                2
 *   asked only for a person      6                4
 *   borderline                   2                0
 *   a real request               5                2
 *
 * Under this build the 3 no-request tickets on the queue lanes file nothing;
 * the 2 on the records lane, the 10 person-only, the 2 borderline and the 7
 * real requests file as before (the real ones are v241's to rescue).
 *
 * WHAT IS NOT MEASURED, and is why it is held: the model's split between
 * "nothing was asked" (null) and "wants to speak with someone" (no_topic) on
 * the person-only calls. If the model answers null there too, this also stops
 * those callbacks. v241's `the model read no request (<sid>)` log lines read
 * that split back by SID; a day of them is the before-number this needs.
 *
 * The model is faked with the answer a correct reading gives. The SIDs and
 * ticket numbers are real; every word below is synthetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));
/** What the mocked model answers on the production asker's path (the review of #488). */
const modelReply = vi.hoisted(() => ({ content: '{"request": null}' }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: async () => ({ choices: [{ message: { content: modelReply.content } }] }) } };
  },
}));

import { readFileSync } from 'node:fs';
import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { resetDraftedRequests } from '../tools/draftedRequest';
import { runRequestSweep, FILES_WHEN_NOTHING_WAS_READ, type SweepFiler, type NumberLookup } from './sweepRunner';
import { SWEPT_TICKET_DESCRIPTION } from './requestSweep';
import { readTheRequest, askModelForTheRequest, concludesNothingWasAsked, type RequestAsker } from './requestFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';

type Lane = 'optical' | 'surgery' | 'tech' | 'records';

function record(callSid: string, slug: Lane, callerLines: string[]): VoiceCallRecord {
  const lines = [`AGENT: Thank you for calling Azul Vision ${slug}. I can take a message and they will follow up with you. Am I speaking with Testa?`];
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
/** A synthetic one-person number, so the queue lanes' name gate passes and only the request decides. */
const onePerson: NumberLookup = async () => ({ firstName: 'Testa', lastName: 'Lake' });
const answers = (request: string | null): RequestAsker => async () => ({ request });

interface Row { sid: string; ticket: string; lane: Lane; says: string[]; reads: string | null }

/** The model reads nothing asked, on a queue lane: the placeholder was filed in production, nothing is filed now. */
const NOTHING_ASKED: Row[] = [
  { sid: 'CA2c07eb19acdbc3dc31972009165cd704', ticket: 'VA-84735', lane: 'surgery',
    says: ['I did not call this number.', 'Who is this?'], reads: null },
  { sid: 'CAbc6b0d2074b9071739f6957351a30091', ticket: 'VA-83801', lane: 'optical',
    says: ['Yeah, just for the.', 'Espera, primero yo y luego tú.'], reads: null },
  { sid: 'CA0b5fb6fb9821d14742b3f6c1dad5d298', ticket: 'VA-84358', lane: 'surgery',
    says: ['Yes.', 'Somebody called me, I do not know what for.', 'En español, por favor.', '¿Me puede repetir?'], reads: null },
];

/** The same reading on the records lane: it still files, the CAP SOP's rule. */
const RECORDS_NOTHING_ASKED: Row[] = [
  { sid: 'CAc0e3b932ba0a9d30ca781379e69929c8', ticket: 'VA-84562', lane: 'records',
    says: ['Sí, tengo que ir a trabajar.', 'Sí, es cierto, había mucho trabajo ahí.'], reads: null },
  { sid: 'CAd6c62ec519f6f1a1ab3ee37057ccb928', ticket: 'VA-84810', lane: 'records',
    says: ['No sé.', 'No.', 'Alguien llamó a este número, pero yo no soy paciente.'], reads: null },
];

/** Asked only for a person: the reader drops it as no_topic and the sweep still files, as before. */
const PERSON_ONLY: Row[] = [
  { sid: 'CA01e27332715686046f6a478264a4aef8', ticket: 'VA-84621', lane: 'tech',
    says: ['Yes.', 'Talk to somebody. A person. Customer service.'], reads: 'Wants to speak with someone.' },
  { sid: 'CAd4492424e49b48cc7a13fae674eca005', ticket: 'VA-84387', lane: 'surgery',
    says: ['Yes.', 'Alguien que hable español.', 'Quiero hablar con un agente.'], reads: 'Wants to speak with a person.' },
  { sid: 'CA699eb58314cd6d7660b8aa34b82ff168', ticket: 'VA-84592', lane: 'records',
    says: ['I want to talk to a real person.'], reads: 'Wants to speak with a person.' },
];

/** A real request: v241's to rescue, untouched here. */
const REAL: Row[] = [
  { sid: 'CAf59eb16dbc9d92d46d937178c94cdf5c', ticket: 'VA-84269', lane: 'surgery',
    says: ['Yes.', 'I need a callback about rescheduling my eye surgery.'], reads: 'Wants a callback to reschedule an upcoming eye surgery.' },
  { sid: 'CA4a7560ad2ee2e0a2e2c7ffce3cdbe3f9', ticket: 'VA-84644', lane: 'optical',
    says: ['Yes.', 'Español, por favor.', 'Mis lentes.', 'La oficina de los lentes.'], reads: 'Asking where to pick up their glasses.' },
];

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  resetDraftedRequests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function sweep(row: Row, ask: RequestAsker = answers(row.reads)) {
  const f = filer();
  const out = await runRequestSweep(record(row.sid, row.lane, row.says), f, noName, onePerson, ask);
  return { out, f };
}

describe('the corpus: queue-lane placeholder tickets of 2026-11-12/13 where nothing was asked', () => {
  it('holds 3 queue-lane and 2 records-lane calls with no request, 3 person-only and 2 real controls', () => {
    expect(NOTHING_ASKED).toHaveLength(3);
    expect(RECORDS_NOTHING_ASKED).toHaveLength(2);
    const all = [...NOTHING_ASKED, ...RECORDS_NOTHING_ASKED, ...PERSON_ONLY, ...REAL];
    expect(new Set(all.map((r) => r.sid)).size).toBe(all.length);
    expect(new Set(all.map((r) => r.ticket)).size).toBe(all.length);
  });

  it.each(NOTHING_ASKED)('$sid / $ticket ($lane) — the model read no request: nothing is filed', async (row) => {
    const { out, f } = await sweep(row);
    expect(out).toEqual({ filed: false, reason: 'no-request-read' });
    expect(f.calls).toHaveLength(0);
  });

  it.each(NOTHING_ASKED)('$sid / $ticket — main filed the placeholder (the before)', async (row) => {
    // An asker that never asks is main's behaviour on every call the reader cannot reach.
    const { out, f } = await sweep(row, async () => null);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it.each(RECORDS_NOTHING_ASKED)('$sid / $ticket (records) — the records lane still files', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it.each(PERSON_ONLY)('$sid / $ticket ($lane) — asked only for a person: still files the placeholder', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it.each(REAL)('$sid / $ticket ($lane) — a real request still files the sentence', async (row) => {
    const { out, f } = await sweep(row);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(row.reads);
  });
});

describe('only the model saying "nothing" stops a filing', () => {
  const row = NOTHING_ASKED[0];

  it('a model that throws still files the placeholder', async () => {
    const { out, f } = await sweep(row, async () => {
      throw new Error('timeout');
    });
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('no key, or the reader switched off, still files the placeholder', async () => {
    const { out } = await sweep(row, async () => null);
    expect(out.filed).toBe(true);
  });

  it('a blank answer reads as nothing', async () => {
    const { out, f } = await sweep(row, async () => ({ request: '   ' }));
    expect(out).toEqual({ filed: false, reason: 'no-request-read' });
    expect(f.calls).toHaveLength(0);
  });

  it('an answer with no request field, or a request that is not a string, is a format failure: it files the placeholder (review of #488)', async () => {
    for (const a of [async () => ({}), async () => ({ request: 42 })] as unknown as RequestAsker[]) {
      const { out, f } = await sweep(row, a);
      expect(out.filed).toBe(true);
      expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
    }
  });

  it('a real request carrying a says-nothing word files as main does, never suppressed (review of #488)', async () => {
    for (const said of [
      'Wants clarification of unclear pre-surgery instructions.',
      'Asking why the pharmacy says the prescription is unknown to them.',
      'Caller did not say which office, wants their glasses order status.',
    ]) {
      const { out, f } = await sweep(row, answers(said));
      expect(out.filed).toBe(true);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('a model that says in words that nothing was asked reads as nothing', async () => {
    const { out } = await sweep(row, answers('Caller did not state a specific request.'));
    expect(out).toEqual({ filed: false, reason: 'no-request-read' });
  });

  it('a first answer that fails a check, then nothing on the second ask, still files (the reader was not sure)', async () => {
    let n = 0;
    const ask: RequestAsker = async () => (++n === 1 ? { request: 'Wants a call back at 714 555 0100 about glasses.' } : { request: null });
    const { out, f } = await sweep(row, ask);
    expect(n).toBe(2);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('a drafted request is never second-guessed by the reader', async () => {
    const { noteDraftedRequestFromArgs } = await import('../tools/draftedRequest');
    noteDraftedRequestFromArgs('classify_surgery_request', { call_sid: row.sid, request_description: 'Asking about a pre-surgery test, drafted on the call.' });
    let asked = 0;
    const { out, f } = await sweep(row, async () => {
      asked += 1;
      return { request: null };
    });
    expect(asked).toBe(0);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe('Asking about a pre-surgery test, drafted on the call.');
  });

  it('logs the call it did not file, by SID only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await sweep(row);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('the model read no request — nothing filed') && l.includes(row.sid))).toBe(true);
  });
});

describe('the reader says why it read nothing', () => {
  const t = 'CALLER: Hello?';
  it.each([
    ['nothing_asked', answers(null)],
    ['nothing_asked', answers('Caller did not state a specific request.')],
    ['person_only', answers('Wants to speak with someone.')],
    ['failed', (async () => { throw new Error('x'); }) as RequestAsker],
    ['failed', (async () => null) as RequestAsker],
  ] as const)('%s', async (verdict, ask) => {
    expect((await readTheRequest(t, ask)).verdict).toBe(verdict);
  });

  it('only the records lane files when nothing was read', () => {
    expect([...FILES_WHEN_NOTHING_WAS_READ]).toEqual(['records']);
  });

  it.each([
    'Caller did not state a specific request.',
    'No request.',
    'No clear reason for the call was given.',
    "The caller's reason for calling is unclear.",
    'Unknown.',
    'Caller did not say what they wanted.',
  ])('"%s" is a whole no-request conclusion', (said) => {
    expect(concludesNothingWasAsked(said)).toBe(true);
  });

  it.each([
    'Wants clarification of unclear pre-surgery instructions.',
    'Asking why the pharmacy says the prescription is unknown to them.',
    'Caller did not say which office, wants their glasses order status.',
    'Unclear whether the drops were sent to the pharmacy.',
    'Wants to reschedule; the date is not stated.',
    // No says-nothing phrase at all: made only of conclusion words, still not one.
    'The caller called about the request.',
  ])('"%s" carries a topic, so it is not a conclusion', (said) => {
    expect(concludesNothingWasAsked(said)).toBe(false);
  });

  it('a says-nothing word inside a request reads as dropped, not nothing asked', async () => {
    const reading = await readTheRequest(t, answers('Wants clarification of unclear pre-surgery instructions.'));
    expect(reading.verdict).toBe('dropped');
  });
});

describe('the production asker reads only {"request": string | null} as an answer (review of #488)', () => {
  const t = 'CALLER: Hello?';
  const key = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-key';
    delete process.env.REQUEST_FROM_RECORDING_DISABLED;
  });
  afterEach(() => {
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  });

  it.each([
    ['{}', 'failed'],
    ['{"request": 42}', 'failed'],
    ['{"request": {"text": "x"}}', 'failed'],
    ['["Asking about glasses."]', 'failed'],
    ['null', 'failed'],
    ['not json', 'failed'],
    ['{"request": null}', 'nothing_asked'],
    ['{"request": ""}', 'nothing_asked'],
    ['{"request": "Asking whether contact lenses have arrived."}', 'read'],
  ] as const)('%s reads as %s', async (content, verdict) => {
    modelReply.content = content;
    expect((await readTheRequest(t, askModelForTheRequest)).verdict).toBe(verdict);
  });

  it('a malformed answer on a queue lane files the placeholder', async () => {
    modelReply.content = '{}';
    const { out, f } = await sweep(NOTHING_ASKED[0], askModelForTheRequest);
    expect(out.filed).toBe(true);
    expect(f.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('the sweep reads the verdict, not just the sentence', () => {
    const runner = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/reading\.verdict === "nothing_asked" && !FILES_WHEN_NOTHING_WAS_READ\.has\(record\.slug\)/);
  });
});
