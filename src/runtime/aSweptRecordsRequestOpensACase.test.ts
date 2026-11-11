/**
 * v203: A SWEPT RECORDS REQUEST OPENS A CASE ON PATHWAY REVIEW.
 *
 * Operator, 2026-11-11, asked whether a records request the teardown sweep
 * files (the agent did not file it, the caller had hung up) should open a
 * records case: "yes ... open it on pathway review."
 *
 * Before: v201 read what the caller asked from the recording and put it on
 * the staff side only for Medical Records, keeping the placeholder as the
 * description, and the ticketing app opens no case on the placeholder.
 * Department 16, 2026-10-30..11-10: 64 swept records tickets, 0 cases.
 *
 * Now the sentence is the description there too. What the app does with it,
 * read from the ticketing app's `main` on 2026-11-11:
 *
 *   - `ensureCaseForTicket` opens a case only when `recordsLinePurpose` of
 *     the description reads 'records' (`looksLikeVoiceRecordsRequest`);
 *   - the swept ticket sends no requestorType, requestPathway or
 *     capClockApplies, so `decidePathway` takes its text-only steps, and
 *     every one of them sets `needsReview`: the case opens with
 *     compliance_review_status 'pathway_review';
 *   - a sentence about something else is re-routed by the app's records-line
 *     classifier (`normalizeRecordsVoiceIntake`); a nameless one is then
 *     refused (only Medical Records files without a name), and the sweep's
 *     default filer files it again with the placeholder, which is what
 *     `main` filed.
 *
 * The corpus is the three records-lane calls in v201's corpus of 2026-11-10,
 * by their real SIDs. Every word below is synthetic. The app's own copy of
 * the classifier was run on each sentence here and agrees with this repo's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

const posts: Record<string, unknown>[] = [];
vi.mock('../services/durableTicketFiling', () => ({
  createTicketDurable: async (payload: Record<string, unknown>) => {
    posts.push(payload);
    // The app's behaviour for this shape: a records-line description that is
    // not a records request is routed out of Medical Records, and only
    // Medical Records files without a patient name.
    const description = String(payload.description);
    const placeholder = description === SWEPT_TICKET_DESCRIPTION;
    const nameless = !payload.patientFirstName;
    if (!placeholder && nameless && recordsLinePurpose(description) !== 'records') {
      return {
        success: false,
        statusCode: 400,
        error: 'Missing required information: patientFirstName, patientLastName (only a Medical Records request may file without a patient name)',
      };
    }
    return { success: true, ticketNumber: `VA-SWEEP-${posts.length}` };
  },
}));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities, rememberVerifiedIdentity } from '../tools/verifiedIdentity';
import { resetDraftedRequests } from '../tools/draftedRequest';
import { runRequestSweep } from './sweepRunner';
import { SWEPT_TICKET_DESCRIPTION, REQUEST_FROM_RECORDING_NOTE } from './requestSweep';
import type { RequestAsker } from './requestFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { recordsLinePurpose } from '../../shared/records-request-intent';

function record(callSid: string, callerLines: string[]): VoiceCallRecord {
  const lines = ['AGENT: Thank you for calling Azul Vision medical records. How can I help you today?'];
  for (const said of callerLines) {
    lines.push(`CALLER: ${said}`);
    lines.push('AGENT: Thank you. Let me take that down for you. [interrupted]');
  }
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug: 'records',
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents: [],
    agentTurns: callerLines.length + 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 76_000,
  } as VoiceCallRecord;
}

const noName = async () => null;
const noNumber = async () => null;
const answers = (request: string | null): RequestAsker => async () => ({ request });

const RECORDS_REQUEST = {
  sid: 'CAc7e03692de805890935841eaceebe36f',
  says: ['His wife.', 'I need his medical records sent to his new eye doctor out of state, we moved, and I already sent a request online.'],
  reads: 'Wants medical records sent to a new eye doctor out of state.',
};
const NOT_RECORDS = [
  {
    sid: 'CAdd8ebea9bd4608b0a9c72754b932e90b',
    says: ['Sí.', 'Cambio de cita, por favor.'],
    reads: 'Wants to change an upcoming appointment.',
  },
  {
    sid: 'CA9866028a713777fd6870455eeedecb4f',
    says: ['Yes.', 'Is the office going to be open for my appointment, because of the holiday?'],
    reads: 'Asking whether the office will be open for their appointment on the holiday.',
  },
];

beforeEach(() => {
  posts.length = 0;
  resetStatedNames();
  resetVerifiedIdentities();
  resetDraftedRequests();
});

describe('a swept records request opens a case on pathway review', () => {
  it(`${RECORDS_REQUEST.sid} — the description is the request, and it reads as a records request`, async () => {
    const out = await runRequestSweep(record(RECORDS_REQUEST.sid, RECORDS_REQUEST.says), undefined, noName, noNumber, answers(RECORDS_REQUEST.reads));
    expect(out.filed).toBe(true);
    expect(posts).toHaveLength(1);
    const p = posts[0];
    expect(p.departmentId).toBe(16);
    expect(p.description).toBe(RECORDS_REQUEST.reads);
    // The app opens a case only on this.
    expect(recordsLinePurpose(String(p.description))).toBe('records');
    expect(String((p.callData as Record<string, unknown>).transcript)).toContain(`${REQUEST_FROM_RECORDING_NOTE} ${RECORDS_REQUEST.reads}`);
  });

  it('states no requester, so the case opens on pathway review and never on a stated pathway', async () => {
    await runRequestSweep(record(RECORDS_REQUEST.sid, RECORDS_REQUEST.says), undefined, noName, noNumber, answers(RECORDS_REQUEST.reads));
    for (const key of ['requestorType', 'requestPathway', 'capClockApplies', 'requestorName', 'formChannel']) {
      expect(posts[0]).not.toHaveProperty(key);
    }
  });

  it('with nothing read from the recording, the placeholder files and opens no case, as before', async () => {
    await runRequestSweep(record(RECORDS_REQUEST.sid, RECORDS_REQUEST.says), undefined, noName, noNumber, answers(null));
    expect(posts).toHaveLength(1);
    expect(posts[0].description).toBe(SWEPT_TICKET_DESCRIPTION);
  });
});

describe('a swept records-lane call about something else', () => {
  it.each(NOT_RECORDS)('$sid — nameless, refused once routed away, filed again with the placeholder on the same key', async (row) => {
    const out = await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, answers(row.reads));
    expect(recordsLinePurpose(row.reads)).not.toBe('records');
    expect(out.filed).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[0].description).toBe(row.reads);
    expect(posts[1].description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
    expect(posts[1].departmentId).toBe(16);
  });

  it('named, it files once with the sentence, for the app to route where it is worked', async () => {
    const row = NOT_RECORDS[0];
    rememberVerifiedIdentity(row.sid, { firstName: 'Testa', lastName: 'Lake', certain: true });
    const out = await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, answers(row.reads));
    expect(out.filed).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].description).toBe(row.reads);
  });
});

describe('the corpus, as the classifier reads it', () => {
  it('one of the three records-lane calls of 2026-11-10 is a records request', () => {
    const purposes = [RECORDS_REQUEST, ...NOT_RECORDS].map((r) => recordsLinePurpose(r.reads));
    expect(purposes.filter((p) => p === 'records')).toHaveLength(1);
  });
});
