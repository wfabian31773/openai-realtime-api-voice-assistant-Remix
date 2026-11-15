/**
 * THE READER ASKS AGAIN — v241.
 *
 * The teardown sweep reads what the caller asked for from the recording when
 * the agent wrote nothing down (v201, `requestFromTheRecording.ts`), checks
 * the model's sentence in code, and drops it on any number, date, address,
 * title or held name. Measured in the deployment log, 2026-11-12..15: 75
 * sentences came back and 16 (21%) failed a check. Every one of the 16 filed
 * the placeholder, and nothing was asked again.
 *
 * THE CORPUS: the placeholder tickets ("Callback needed - reason not
 * captured") of 2026-11-12/13 on optical, surgery, tech and records, 37 of
 * them, read against their calls. 26 carried no request (the placeholder is
 * the truth there), and on at least 5 the caller said a real request plainly,
 * in words a sentence would carry with a doctor's name, a visit date, a
 * date of birth or a pharmacy's street in it, which the checks are right to
 * drop. Four of them are here by real SID and ticket number:
 *
 *   CAcc950b50b6cfa80f938863187a2659a9  VA-84611  tech     a named doctor to approve a drug before surgery
 *   CAa3e52f603acbb87e284c24b255a2a2fb  VA-84823  records  records from a dated visit with a named doctor
 *   CA1f32004624cf617a49e117ab488e3cdb  VA-84692  optical  a glasses order changed, a date of birth said with it
 *   CA71e543d036e3e169ac14fa6d21346779  VA-84899  tech     a prescription the pharmacy does not have
 *
 * WHAT IS NOT RECOVERABLE, stated: the log line had no SID and no sentence
 * until this build, so which of the 16 dropped sentences belonged to which
 * call cannot be read back, and a call whose model answered null is not
 * reached by this change at all. The first answers below are therefore
 * synthetic stand-ins of the kinds the checks drop, one per content kind; the
 * model is faked. What this pins is the CODE: a content failure gets one more
 * ask naming that kind, the second answer goes through the same checks, a
 * clean second answer is the description, and anything else files exactly
 * what main files. The after-number is the new log line.
 *
 * The control is CA699eb58314cd6d7660b8aa34b82ff168 (VA-84592, records): the
 * caller asked only for a person, so a sentence saying so names no topic and
 * is never asked again.
 *
 * The SIDs and ticket numbers are real; every word below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { readFileSync } from 'node:fs';
import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { resetDraftedRequests } from '../tools/draftedRequest';
import { runRequestSweep, type SweepFiler, type NumberLookup } from './sweepRunner';
import { SWEPT_TICKET_DESCRIPTION } from './requestSweep';
import {
  requestFromTheRecording,
  requestMessages,
  retryCorrection,
  whyUnusable,
  usableRequest,
  LEAVE_OUT,
  RETRYABLE_KINDS,
  REQUEST_INSTRUCTIONS,
  type RequestAsker,
  type RequestRetry,
  type UnusableKind,
} from './requestFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';

type Lane = 'optical' | 'surgery' | 'tech' | 'records';

const GREETING: Record<Lane, string> = {
  optical: 'AGENT: Thank you for calling Azul Vision optical. I can take a message and they will follow up with you. How can I help you today?',
  surgery: 'AGENT: Thank you for calling Azul Vision surgery coordination. I can take a message and they will follow up with you. How can I help you today?',
  tech: 'AGENT: Thank you for calling Azul Vision clinical support. I can take a message and they will follow up with you. Am I speaking with Testa?',
  records: 'AGENT: Thank you for calling Azul Vision medical records. I can take the details and they will follow up with you. How can I help you today?',
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
    endedAtMs: 61_000,
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
/** A synthetic one-person number, so the queue lanes' name gate passes. */
const onePerson: NumberLookup = async () => ({ firstName: 'Testa', lastName: 'Lake' });

/** A fake model that answers each ask in turn and keeps what it was asked. */
function model(...replies: (string | null | Error)[]) {
  const asked: (RequestRetry | undefined)[] = [];
  const ask: RequestAsker = async (_transcript, retry) => {
    asked.push(retry);
    const reply = replies[Math.min(asked.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { request: reply };
  };
  return { ask, asked };
}

interface Row {
  sid: string;
  ticket: string;
  lane: Lane;
  says: string[];
  first: string;
  kind: UnusableKind;
  second: string;
}

const CORPUS: Row[] = [
  {
    sid: 'CAcc950b50b6cfa80f938863187a2659a9',
    ticket: 'VA-84611',
    lane: 'tech',
    says: ['Yes.', 'I need Dr. Quill to approve my eye drops for my upcoming surgery as soon as possible.'],
    first: 'Wants Dr. Quill to approve eye drops before an upcoming surgery.',
    kind: 'person',
    second: 'Wants the doctor to approve eye drops before an upcoming surgery.',
  },
  {
    sid: 'CAa3e52f603acbb87e284c24b255a2a2fb',
    ticket: 'VA-84823',
    lane: 'records',
    says: [
      'Need to speak to an agent.',
      'Need records from Wednesday, November 4th with the doctor, a printout of what was discussed, and why her eyes bother her every couple of months.',
    ],
    first: 'Requesting records of the November 4 visit and asking why her eyes bother her.',
    kind: 'number_or_date',
    second: "Requesting records of a recent visit and asking why the patient's eyes bother her.",
  },
  {
    sid: 'CA1f32004624cf617a49e117ab488e3cdb',
    ticket: 'VA-84692',
    lane: 'optical',
    says: ['I would like to decline the upgraded lenses, she just wants her regular glasses, so put the order in as is.'],
    first: 'Declining the upgraded lenses for the patient born 8/5/12; wants the regular glasses ordered.',
    kind: 'number_or_date',
    second: 'Declining the upgraded lenses and wants the regular glasses ordered as is.',
  },
  {
    sid: 'CA71e543d036e3e169ac14fa6d21346779',
    ticket: 'VA-84899',
    lane: 'tech',
    says: ['Yes.', 'I called yesterday to get a prescription sent to the pharmacy and they still do not have it.'],
    first: "Wants yesterday's prescription sent to the pharmacy at 120 Elm Street.",
    kind: 'address',
    second: 'Wants the prescription called in yesterday sent to the pharmacy, which does not have it.',
  },
];

const PERSON_ONLY = {
  sid: 'CA699eb58314cd6d7660b8aa34b82ff168',
  ticket: 'VA-84592',
  lane: 'records' as Lane,
  says: ['Yes.', 'Speak to a human.'],
  first: 'Wants to speak with a human.',
};

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  resetDraftedRequests();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const logged = () => [...warn.mock.calls, ...info.mock.calls].flat().map(String).join('\n');

describe('the corpus: placeholder tickets of 2026-11-12/13 whose caller asked for something', () => {
  it('holds four calls, one per content kind the checks drop, and the person-only control', () => {
    expect(CORPUS.map((r) => r.ticket)).toEqual(['VA-84611', 'VA-84823', 'VA-84692', 'VA-84899']);
    expect(new Set(CORPUS.map((r) => r.kind))).toEqual(new Set(['person', 'number_or_date', 'address']));
    for (const row of CORPUS) {
      expect(whyUnusable(row.first, ['Testa', 'Lake'])).toBe(row.kind);
      expect(usableRequest(row.second, ['Testa', 'Lake'])).toBe(row.second);
    }
  });

  it.each(CORPUS)('$ticket ($lane): the first sentence fails a $kind check, the second ask is the description', async (row) => {
    const m = model(row.first, row.second);
    const f = filer();
    const out = await runRequestSweep(record(row.sid, row.lane, row.says), f, noName, onePerson, m.ask);
    expect(out.filed).toBe(true);
    expect(m.asked).toHaveLength(2);
    expect(m.asked[0]).toBeUndefined();
    expect(m.asked[1]).toEqual({ previous: row.first, leaveOut: LEAVE_OUT[row.kind] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].description).toBe(row.second);
    expect(f.calls[0].description).not.toBe(SWEPT_TICKET_DESCRIPTION);
    // The log names the kind and the call, never the sentence.
    expect(logged()).toContain(`failed a check (${row.kind}) — asking once more (${row.sid})`);
    expect(logged()).toContain(`the second answer was used (${row.sid})`);
    expect(logged()).not.toContain(row.first);
    expect(logged()).not.toContain(row.second);
  });

  it.each(CORPUS)('$ticket: a second answer that fails too files what main files', async (row) => {
    // What main files when the reader gives nothing usable: the taxonomy
    // label where the lane classifies one, else the placeholder. The baseline
    // reader never asks (v242: a model that ANSWERS null now files nothing on
    // these lanes, which is a different call from a sentence that failed).
    const baseline = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says), baseline, noName, onePerson, async () => null);
    resetVerifiedIdentities();
    resetStatedNames();
    resetDraftedRequests();
    const m = model(row.first, row.first);
    const f = filer();
    await runRequestSweep(record(row.sid, row.lane, row.says), f, noName, onePerson, m.ask);
    expect(m.asked).toHaveLength(2);
    expect(f.calls[0].description).toBe(baseline.calls[0].description);
    expect(f.calls[0].description).not.toContain(row.first);
    expect(logged()).toContain(`the second answer failed a check too (${row.kind}) — not used (${row.sid})`);
  });

  it('the person-only control: a sentence naming no topic is not asked again', async () => {
    expect(whyUnusable(PERSON_ONLY.first)).toBe('no_topic');
    const m = model(PERSON_ONLY.first, 'Wants the records team to call back about a records request.');
    const f = filer();
    await runRequestSweep(record(PERSON_ONLY.sid, PERSON_ONLY.lane, PERSON_ONLY.says), f, noName, onePerson, m.ask);
    expect(m.asked.length).toBeLessThanOrEqual(1);
    for (const t of f.calls) expect(t.description).toBe(SWEPT_TICKET_DESCRIPTION);
  });
});

describe('what is asked again, and what is not', () => {
  const content: [UnusableKind, string][] = [
    ['person', 'Wants Dr. Quill to call back about the drops.'],
    ['person', "Wants Testa Lake's glasses order status checked."],
    ['number_or_date', 'Wants to move the appointment on March 3 to the afternoon.'],
    ['number_or_date', 'Wants a refill and gave a date of birth for the chart.'],
    ['contact', 'Wants the visit summary emailed to someone@example.com today.'],
    ['address', 'Wants the new glasses mailed to Apt 4 at home please.'],
    ['address', 'Wants the records mailed home to West Foothill Boulevard.'],
    ['address', 'Wants the glasses left at the front desk, desk #12.'],
    ['too_long', `Wants ${'the frames repaired and '.repeat(8)}picked up.`],
    ['too_short', 'Glasses.'],
    ['too_few_words', 'Frames repaired.'],
  ];

  it.each(content)('%s: "%s" is asked once more, naming what to leave out', async (kind, sentence) => {
    expect(whyUnusable(sentence, ['Testa', 'Lake'])).toBe(kind);
    expect(RETRYABLE_KINDS.has(kind)).toBe(true);
    const m = model(sentence, 'Wants the glasses order status checked.');
    await expect(requestFromTheRecording('CALLER: synthetic.', m.ask, ['Testa', 'Lake'], 'CA0000')).resolves.toBe(
      'Wants the glasses order status checked.',
    );
    expect(m.asked).toEqual([undefined, { previous: sentence, leaveOut: LEAVE_OUT[kind] }]);
    expect(LEAVE_OUT[kind].length).toBeGreaterThan(10);
  });

  const correct: [UnusableKind, string][] = [
    ['says_nothing', 'No specific request was stated.'],
    ['says_nothing', 'The caller did not say what they wanted.'],
    ['placeholder', 'Callback request taken by the agent.'],
    ['no_topic', 'Wants to speak with someone.'],
    ['no_topic', 'Requesting a call back.'],
    // A sentence with no topic is not asked again even when it also carries a number.
    ['no_topic', 'Wants a call back at 714 555 0100.'],
  ];

  it.each(correct)('%s: "%s" is a correct drop and is never asked again', async (kind, sentence) => {
    expect(whyUnusable(sentence)).toBe(kind);
    expect(RETRYABLE_KINDS.has(kind)).toBe(false);
    const m = model(sentence, 'Wants the glasses order status checked.');
    await expect(requestFromTheRecording('CALLER: synthetic.', m.ask, [], 'CA0000')).resolves.toBeNull();
    expect(m.asked).toHaveLength(1);
    expect(logged()).toContain(`failed a check (${kind}) — not used (CA0000)`);
    expect(logged()).not.toContain(sentence);
  });

  it('a model that answers nothing, or fails, the second time files nothing new', async () => {
    const first = 'Wants Dr. Quill to call back about the drops.';
    for (const second of [null, '', new Error('timeout')]) {
      const m = model(first, second as string | null | Error);
      await expect(requestFromTheRecording('CALLER: synthetic.', m.ask, [], 'CA0000')).resolves.toBeNull();
      expect(m.asked).toHaveLength(2);
    }
    expect(logged()).toContain('the model did not answer the second ask (Error) (CA0000)');
  });

  it('a model that reads no request says so in the log, by SID, on either ask', async () => {
    await expect(requestFromTheRecording('CALLER: synthetic.', model(null).ask, [], 'CA0001')).resolves.toBeNull();
    expect(logged()).toContain('the model read no request (CA0001)');
    await expect(
      requestFromTheRecording('CALLER: synthetic.', model('Wants Dr. Quill to call.', null).ask, [], 'CA0002'),
    ).resolves.toBeNull();
    expect(logged()).toContain('the model read no request on the second ask (CA0002)');
  });

  it('a clean first answer is used as it was, with no second ask', async () => {
    const m = model('Wants the glasses order status checked.');
    await expect(requestFromTheRecording('CALLER: synthetic.', m.ask, [], 'CA0000')).resolves.toBe(
      'Wants the glasses order status checked.',
    );
    expect(m.asked).toEqual([undefined]);
  });

  it('asks at most twice, whatever the model answers', async () => {
    const m = model('Wants Dr. Quill to call.', 'Wants Dr. Quill to call.', 'Wants the doctor to call about drops.');
    await expect(requestFromTheRecording('CALLER: synthetic.', m.ask, [], 'CA0000')).resolves.toBeNull();
    expect(m.asked).toHaveLength(2);
  });
});

describe('the second ask the model is sent', () => {
  it('carries its own first answer and one correction naming what to leave out', () => {
    const retry = { previous: 'Wants Dr. Quill to call back.', leaveOut: LEAVE_OUT.person };
    const messages = requestMessages('CALLER: synthetic.', retry);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'system', content: REQUEST_INSTRUCTIONS });
    expect(messages[1]).toEqual({ role: 'user', content: 'CALLER: synthetic.' });
    expect(messages[2]).toEqual({ role: 'assistant', content: JSON.stringify({ request: retry.previous }) });
    expect(messages[3]).toEqual({ role: 'user', content: retryCorrection(LEAVE_OUT.person) });
    expect(messages[3].content).toContain(LEAVE_OUT.person);
    expect(messages[3].content).toMatch(/did not say what they wanted, return null\. Do not guess\./);
    expect(messages[3].content).toMatch(/Refer to people only by their role/);
    expect(messages[3].content).toMatch(/Answer with JSON only/);
    // The first ask is the system prompt and the transcript, as before.
    expect(requestMessages('CALLER: synthetic.')).toEqual(messages.slice(0, 2));
  });

  it('never names a held name in the correction', () => {
    for (const kind of RETRYABLE_KINDS) {
      const c = retryCorrection(LEAVE_OUT[kind]);
      expect(c).not.toMatch(/Testa|Lake/);
    }
  });

  it('the production asker sends these messages', () => {
    const src = readFileSync(new URL('./requestFromTheRecording.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/askModelForTheRequest: RequestAsker = async \(transcript, retry\) =>/);
    expect(src).toMatch(/messages: requestMessages\(transcript, retry\)/);
  });

  it('the sweep hands the reader the call\'s SID for its log lines', () => {
    const runner = readFileSync(new URL('./sweepRunner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/readTheRequest\(record\.transcript, askRequest, held, record\.callSid\)/);
  });
});
