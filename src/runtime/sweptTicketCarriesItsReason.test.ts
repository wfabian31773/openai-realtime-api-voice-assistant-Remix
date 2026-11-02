/**
 * v166: the swept ticket carries its reason. Six voice tickets filed as the
 * ticketing app's "Callback needed - reason not captured" (its
 * `lib/voice-agent/no-reason.ts` keys on the sweep's placeholder description):
 *
 *   70230  tech     name + DOB validated, glaucoma med renewal, hung up mid-turn
 *   68501  tech     post-op drops question, ended during the number readback
 *   70298  records  file_records_ticket refused `requester` four times
 *   70217  records  refusal-recovery ticket (recordsRefusalIsLoggedFirst.test.ts)
 *   70265  records  insurance rep wanted the fax number, got it, said thanks
 *   70357  records  caller refused everything — the placeholder is correct
 *
 * Transcripts here are synthetic stand-ins for those shapes; no PHI.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSweptTicket,
  decideSweep,
  looksInfoOnly,
  INFO_ONLY_NOTE,
  resolveSweepReason,
  sweptTicketDescription,
  SWEPT_TICKET_DESCRIPTION,
  type SweepInput,
} from './requestSweep';
import {
  draftedRequestFor,
  noteDraftedRequestFromArgs,
  resetDraftedRequests,
  DRAFTED_REQUEST_MAX_CHARS,
} from '../tools/draftedRequest';
import { runRequestSweep, type SweepFiler } from './sweepRunner';
import { resetVerifiedIdentities, rememberVerifiedIdentity } from '../tools/verifiedIdentity';
import type { VoiceCallRecord } from './mediaStreamBridge';

const TECH_SID = 'CA0123456789abcdef0123456789abc230';
const RECORDS_SID = 'CA0123456789abcdef0123456789abc298';
const INFO_SID = 'CA0123456789abcdef0123456789abc265';
const REFUSED_SID = 'CA0123456789abcdef0123456789abc357';

const base = (over: Partial<SweepInput>): SweepInput => ({
  callSid: TECH_SID,
  slug: 'tech',
  callerPhone: '5555550142',
  transcript: '',
  toolEvents: [],
  ticketAlreadyFiled: false,
  verifiedName: { firstName: 'Synthia', lastName: 'Example' },
  ...over,
});

const record = (over: Partial<VoiceCallRecord>): VoiceCallRecord =>
  ({
    callSid: RECORDS_SID,
    slug: 'records',
    callerPhone: '5555550142',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: '',
    toolEvents: [],
    agentTurns: 3,
    interruptions: 0,
    startedAtMs: 0,
    endedAtMs: 138_000,
    ...over,
  }) as VoiceCallRecord;

function filer() {
  const calls: Parameters<SweepFiler>[0][] = [];
  const f: SweepFiler & { calls: typeof calls } = Object.assign(
    async (t: Parameters<SweepFiler>[0]) => {
      calls.push(t);
      return { success: true, ticketNumber: 'VA-TEST-1' };
    },
    { calls },
  );
  return f;
}

beforeEach(() => {
  resetDraftedRequests();
  resetVerifiedIdentities();
});

describe('70230 shape: tech, no tool ran, the reason is in the words', () => {
  const input = base({
    transcript: [
      'AGENT: How can I help?',
      'CALLER: I need to renew my glaucoma drops, the latanoprost.',
      'AGENT: Of course, and can I',
    ].join('\n'),
  });

  it('files with the classified reason NAME, never the caller words', () => {
    const d = decideSweep(input);
    if (!d.file) throw new Error('fixture must be fileable');
    const t = buildSweptTicket(input, d);
    expect(t.description).not.toBe(SWEPT_TICKET_DESCRIPTION);
    expect(t.description).toMatch(/^Callback request about: .+\. A team member will follow up with you\.$/);
    expect(t.description).not.toMatch(/latanoprost|renew my/i);
    expect(t.description).not.toContain('Synthia');
    expect(t.patientFirstName).toBe('Synthia');
  });
});

describe('70298 shape: the model drafted the request and the tool refused it', () => {
  it('the drafted request reaches the swept ticket — description and reason', async () => {
    noteDraftedRequestFromArgs('file_records_ticket', {
      call_sid: RECORDS_SID,
      request_description: 'Patient wants to confirm the time of her appointment next week.',
    });
    const file = filer();
    const out = await runRequestSweep(
      record({
        transcript: [
          'AGENT: Are you the patient yourself, or calling on someone else’s behalf?',
          "CALLER: I'm the patient.",
          'AGENT: I am hitting the same wall with the system.',
          'CALLER: I just want to know what time my appointment is.',
        ].join('\n'),
        toolEvents: [{ name: 'file_records_ticket', ok: true, succeeded: false, atMs: 1 }] as never,
      }),
      file,
    );
    expect(out.filed).toBe(true);
    expect(file.calls[0].description).toBe('Patient wants to confirm the time of her appointment next week.');
    expect(file.calls[0].description).not.toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('the drafted text wins the reason over the transcript when it is specific', () => {
    const r = resolveSweepReason({
      departmentId: 3,
      draftedRequest: 'renew glaucoma drops latanoprost',
      callerSaid: 'hello? hello?',
    });
    expect(r.source).toBe('drafted');
  });

  it('a drafted text that reads as the catch-all lets the transcript speak', () => {
    const r = resolveSweepReason({
      departmentId: 3,
      draftedRequest: 'caller has a question',
      callerSaid: 'I need to renew my glaucoma drops',
    });
    expect(r.source).toBe('transcript');
  });
});

describe('Medical Records stays conservative', () => {
  it('with no drafted request the records description stays the placeholder', () => {
    const d = sweptTicketDescription(16, { requestTypeId: 74, requestReasonId: 500, source: 'transcript' }, undefined);
    expect(d).toBe(SWEPT_TICKET_DESCRIPTION);
  });

  it('70357 shape: a caller who gave nothing still files the placeholder', async () => {
    const file = filer();
    await runRequestSweep(
      record({
        callSid: REFUSED_SID,
        transcript: [
          'AGENT: How can I help?',
          'CALLER: Transfer me to a live person.',
          'AGENT: May I have your name?',
          'CALLER: Not interested.',
        ].join('\n'),
      }),
      file,
    );
    expect(file.calls[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });
});

describe('70265 shape: an answered information call is tagged, not skipped', () => {
  const transcript = [
    'AGENT: How can I help?',
    "CALLER: This is a synthetic health plan, I just need your records fax number.",
    'AGENT: Our records fax number is 555-555-0100.',
    'CALLER: Thank you, bye.',
  ].join('\n');

  it('looksInfoOnly reads it and nothing else', () => {
    expect(looksInfoOnly({ transcript, toolEvents: [] })).toBe(true);
    expect(looksInfoOnly({ transcript, toolEvents: [{ name: 'classify_records_request', succeeded: true }] })).toBe(false);
    expect(looksInfoOnly({ transcript, toolEvents: [], draftedRequest: 'copy of records' })).toBe(false);
    expect(looksInfoOnly({ transcript: transcript.replace('Thank you, bye.', 'And can you send me my chart?'), toolEvents: [] })).toBe(false);
    expect(looksInfoOnly({ transcript: transcript.replace('is 555-555-0100', 'is on the website'), toolEvents: [] })).toBe(false);
  });

  it('still files, with the info_only line on the staff side only', async () => {
    const file = filer();
    const out = await runRequestSweep(record({ callSid: INFO_SID, transcript }), file);
    expect(out.filed).toBe(true);
    expect(file.calls[0].staffNote).toContain(INFO_ONLY_NOTE);
    expect(file.calls[0].description).not.toContain('info_only');
  });
});

describe('the drafted-request store', () => {
  it('keeps the latest request text from a request-taking tool, by call', () => {
    noteDraftedRequestFromArgs('classify_tech_request', { call_sid: TECH_SID, request_description: 'first' + ' draft' });
    noteDraftedRequestFromArgs('file_tech_ticket', { call_sid: TECH_SID, request_description: '  second\n draft ' });
    expect(draftedRequestFor(TECH_SID)).toBe('second draft');
  });

  it('ignores other tools, sentinel ids and empty text, and caps the length', () => {
    noteDraftedRequestFromArgs('lookup_patient', { call_sid: TECH_SID, request_description: 'x y z' });
    noteDraftedRequestFromArgs('file_tech_ticket', { call_sid: 'unknown', request_description: 'x y z' });
    noteDraftedRequestFromArgs('file_tech_ticket', { call_sid: TECH_SID, request_description: '  ' });
    expect(draftedRequestFor(TECH_SID)).toBeUndefined();
    noteDraftedRequestFromArgs('file_tech_ticket', { call_sid: TECH_SID, request_description: 'a'.repeat(900) });
    expect(draftedRequestFor(TECH_SID)).toHaveLength(DRAFTED_REQUEST_MAX_CHARS);
  });

  it('a certain identity still names the swept ticket beside a drafted request', async () => {
    rememberVerifiedIdentity(TECH_SID, { firstName: 'Synthia', lastName: 'Example', dateOfBirth: '1950-01-02', certain: true });
    noteDraftedRequestFromArgs('classify_tech_request', {
      call_sid: TECH_SID,
      request_description: 'Renewal of glaucoma eye drops.',
    });
    const file = filer();
    await runRequestSweep(
      record({
        callSid: TECH_SID,
        slug: 'tech',
        transcript: 'AGENT: How can I help?\nCALLER: I need my glaucoma drops renewed.',
      }),
      file,
    );
    expect(file.calls[0].patientFirstName).toBe('Synthia');
    expect(file.calls[0].description).toBe('Renewal of glaucoma eye drops.');
  });
});

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the registry notes the drafted request before it validates anything', () => {
    const registry = src('tools/registry.ts');
    const body = registry.slice(registry.indexOf('export async function runTool'));
    const note = body.indexOf('noteDraftedRequestFromArgs(name, input)');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(body.indexOf('validateInput(def, input)'));
  });

  it('the sweep reads it through a STATIC import (the v141 rule)', () => {
    const runner = src('runtime/sweepRunner.ts');
    expect(runner).toContain('import { draftedRequestFor } from "../tools/draftedRequest"');
    expect(runner).not.toMatch(/import\(["']\.\.\/tools\/draftedRequest["']\)/);
  });
});
