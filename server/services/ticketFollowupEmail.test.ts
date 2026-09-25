/**
 * THE FOLLOW-UP NOTICE IS A WARNING, NOT AN OUTAGE.
 *
 * 2026-09-25: three 400s re-fired ticket_filing_stalled every five minutes
 * while tickets were still landing. This body is the other channel — one
 * email listing the refused rows, no PHI, no cooldown.
 */
import { describe, it, expect } from 'vitest';
import {
  TICKET_NEEDS_FOLLOWUP,
  buildFollowupEmail,
  followupFactsFromPayload,
  type FollowupNoticeRow,
} from './ticketFollowupEmail';

const CREATED = new Date('2026-09-25T18:11:00.000Z');

function row(over: Partial<FollowupNoticeRow> = {}): FollowupNoticeRow {
  return {
    id: 'ob-1',
    callSid: 'CAf1c375ee5dc57dd6d705939a7f15cee7',
    createdAt: CREATED,
    lastError: 'Missing required information: office',
    refusalStatusCode: 400,
    departmentId: '1',
    agentUsed: 'optical',
    ...over,
  };
}

describe('followupFactsFromPayload', () => {
  it('reads department and agent from a create_ticket_v1 payload', () => {
    expect(
      followupFactsFromPayload({
        kind: 'create_ticket_v1',
        params: {
          departmentId: 2,
          callData: { agentUsed: 'surgery' },
        },
      }),
    ).toEqual({ departmentId: '2', agentUsed: 'surgery' });
  });

  it('reads the legacy unmarked shape the same way', () => {
    expect(
      followupFactsFromPayload({
        departmentId: 1,
        callData: { agentUsed: 'optical' },
      }),
    ).toEqual({ departmentId: '1', agentUsed: 'optical' });
  });

  it('does not invent a department or an agent when the payload is empty', () => {
    expect(followupFactsFromPayload(null)).toEqual({
      departmentId: 'unknown',
      agentUsed: 'unknown',
    });
    expect(followupFactsFromPayload({})).toEqual({
      departmentId: 'unknown',
      agentUsed: 'unknown',
    });
  });
});

describe('buildFollowupEmail', () => {
  it('names the type, the call, the department and the refusal', () => {
    const mail = buildFollowupEmail([row()]);
    expect(mail.to).toBe('wfabian@azulvision.com');
    expect(mail.subject).toContain('CAf1c375ee5dc57dd6d705939a7f15cee7');
    expect(mail.html).toContain(TICKET_NEEDS_FOLLOWUP);
    expect(mail.html).toContain('optical / dept 1');
    expect(mail.html).toContain('HTTP 400');
    expect(mail.html).toContain('Missing required information: office');
    expect(mail.html).toContain('2026-09-25T18:11:00.000Z');
    expect(mail.text).toContain('CAf1c375ee5dc57dd6d705939a7f15cee7');
    expect(mail.html).toMatch(/needs follow-up/i);
    expect(mail.html).not.toMatch(/TICKET FILING HAS STOPPED/);
    expect(mail.html).not.toMatch(/critical/i);
  });

  it('batches several rows into one email', () => {
    const mail = buildFollowupEmail([
      row(),
      row({
        id: 'ob-2',
        callSid: 'CA4707e391198147df5032f2e72884e998',
        lastError: 'Missing required information: surgeon',
        departmentId: '2',
        agentUsed: 'surgery',
      }),
    ]);
    expect(mail.subject).toBe('[Azul Vision] 2 tickets need follow-up');
    expect(mail.html).toContain('CAf1c375ee5dc57dd6d705939a7f15cee7');
    expect(mail.html).toContain('CA4707e391198147df5032f2e72884e998');
    expect(mail.text).toContain('surgeon');
  });

  it('does not put a patient name on the page even when one is sitting in the payload facts', () => {
    // The row type has no name field. This pins the body against the words
    // a leak would have to invent — if someone later interpolates payload
    // first/last, this is the assertion that goes red.
    const mail = buildFollowupEmail([row()]);
    expect(mail.html).not.toMatch(/Wayne|Fabian|patient/i);
    expect(mail.text).not.toMatch(/Wayne|Fabian/);
  });

  it('escapes HTML in the refusal reason', () => {
    const mail = buildFollowupEmail([
      row({ lastError: '<script>alert(1)</script> Missing office' }),
    ]);
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
  });
});
