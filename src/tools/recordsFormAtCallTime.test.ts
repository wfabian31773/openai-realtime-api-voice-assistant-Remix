/**
 * THE FORM AT CALL TIME — the voice half.
 *
 * Owner, 2026-09-27: *"we need the voice agent to send SMS or emails with the
 * link whenever a patient is requesting records … log the records in the
 * medical records as Pending Auth so we can track it but it shouldn't start
 * the clock and when he does sign the auth it should attach right to that
 * original request."*
 *
 * Driven through `runTool`, the entry point the model calls, on an invented
 * caller, with the ticketing client mocked at its two methods. What is pinned:
 * the payload the app receives (`formChannel`, the `pending_authorization`
 * pathway, the clock OFF), the on-clock gate standing down for a link, the
 * email asked once, the third party untouched, what the agent is handed to
 * say, the verbal directions, and the re-send's latch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { WEBSITE_DIRECTIONS } from './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';

let sidCounter = 0x900;
const freshSid = () => `CA${(++sidCounter).toString(16).padStart(32, '0')}`;

// A patient, on the clock, WITHOUT destination or dates: the form collects those.
const PATIENT = {
  requester: 'I am the patient',
  first_name: 'Testpatient',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  callback_number: '845-531-7471',
  request_description: 'I need a copy of my medical records',
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}
type Out = Record<string, unknown>;
const filed = (n: string, form?: Record<string, unknown>) =>
  ({ success: true, ticketNumber: n, ...(form ? { form } : {}) }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('a patient who takes the link', () => {
  it('files as pending authorization, off the clock, with the channel — and the gate does not ask where or when', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      filed('VA-FORM-1', { requested: true, sent: true, channel: 'sms' }),
    );
    const r = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: freshSid() })) as Out;

    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBe('sms');
    expect(p.requestPathway).toBe('pending_authorization');
    expect(p.capClockApplies).toBe(false);
    expect(p.requestorType).toBe('patient');
    expect(String(p.description)).toContain('Send to: on the signed form');
    expect(String(p.description)).toContain('Dates needed: on the signed form');
    expect(String(p.description)).not.toContain('NOT CAPTURED');
    // What the agent is handed to say.
    expect(r.form_sent).toBe(true);
    expect(r.form_channel).toBe('sms');
    expect(String(r.message)).toContain('VA-FORM-1');
    expect(String(r.message)).toMatch(/link by text/i);
    expect(String(r.message)).toMatch(/sign at the end/i);
  });

  it('asks for the email ONCE when they chose email, then falls back to a text', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      filed('VA-FORM-2', { requested: true, sent: true, channel: 'sms' }),
    );
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'email', call_sid: sid })) as Out;
    expect(first.success).toBe(false);
    expect(first.missingFields).toEqual(['email']);
    expect(String(first.message)).toMatch(/spell it out/i);
    expect(create).not.toHaveBeenCalled();

    const second = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'email', call_sid: sid })) as Out;
    expect(second.success).toBe(true);
    expect((create.mock.calls[0][0] as unknown as Record<string, unknown>).formChannel).toBe('sms');
  });

  it('sends by email when they gave an address', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      filed('VA-FORM-3', { requested: true, sent: true, channel: 'email' }),
    );
    const r = (await runTool('file_records_ticket', {
      ...PATIENT, form_channel: 'email', email: 'patient@example.test', call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBe('email');
    expect(p.patientEmail).toBe('patient@example.test');
    expect(String(r.message)).toMatch(/email to that address/i);
  });

  it('says the team will send the form when the app could not, and offers the other channel to the model only', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      filed('VA-FORM-4', { requested: true, sent: false, channel: 'sms', error: 'No mobile number on the case.' }),
    );
    const r = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: freshSid() })) as Out;
    expect(r.success).toBe(true);
    expect(r.form_sent).toBe(false);
    expect(String(r.message)).toMatch(/records team will send/i);
    expect(String(r.message)).not.toMatch(/I've just sent/i);
    expect(String(r.fix)).toContain('send_records_form');
  });

  it('a filing the app confirmed with no `form` at all (an older app) is a filing, not a sent link', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-5'));
    const r = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: freshSid() })) as Out;
    expect(r.success).toBe(true);
    expect(r.form_sent).toBe(false);
    expect(String(r.message)).not.toMatch(/I've just sent/i);
  });
});

describe('the caller with no mobile and no email hears where the form is', () => {
  it('verbal: still asks where and when (once), files ON the clock as today, and hands over the directions', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-6'));
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'verbal', call_sid: sid })) as Out;
    expect(first.success).toBe(false);
    expect(first.missingFields).toEqual(['deliver_to', 'date_range']);

    const r = (await runTool('file_records_ticket', {
      ...PATIENT, form_channel: 'verbal', deliver_to: 'to me', date_range: 'everything', call_sid: sid,
    })) as Out;
    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p).not.toHaveProperty('formChannel');
    expect(p.requestPathway).toBe('roa_patient');
    expect(p.capClockApplies).toBe(true);
    expect(r.form_channel).toBe('verbal');
    expect(String(r.message)).toContain(WEBSITE_DIRECTIONS);
  });
});

describe('a third party never gets a form', () => {
  it('ignores form_channel from an attorney: no channel sent, pathway and clock as before', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-7'));
    const r = (await runTool('file_records_ticket', {
      ...PATIENT, requester: 'I am an attorney at Lexitas', form_channel: 'sms', call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p).not.toHaveProperty('formChannel');
    expect(p.requestPathway).not.toBe('pending_authorization');
    expect(p.capClockApplies).toBe(false);
    expect(r).not.toHaveProperty('form_sent');
  });
});

describe('the re-send is latched on a filing having succeeded on THIS call', () => {
  it('refuses, with guidance for the model and nothing for the caller, before any filing', async () => {
    const api = await client();
    const resend = vi.spyOn(api, 'sendRecordsIntakeLink');
    const r = (await runTool('send_records_form', { channel: 'sms', call_sid: freshSid() })) as Out;
    expect(r.success).toBe(false);
    expect(String(r.fix)).toMatch(/file_records_ticket/);
    expect(r).not.toHaveProperty('message');
    expect(resend).not.toHaveBeenCalled();
  });

  it('re-sends for the call that filed, by the channel asked, and carries an email the caller spelled out', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-8', { requested: true, sent: true, channel: 'sms' }));
    const resend = vi.spyOn(api, 'sendRecordsIntakeLink').mockResolvedValueOnce({ success: true, channel: 'email' });
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: sid });

    const r = (await runTool('send_records_form', { channel: 'email', email: 'patient@example.test', call_sid: sid })) as Out;
    expect(r.success).toBe(true);
    expect(resend).toHaveBeenCalledWith({ callSid: sid, channel: 'email', email: 'patient@example.test' });
    expect(r.form_sent).toBe(true);
    expect(String(r.message)).toMatch(/on its way/i);
  });

  it('asks for the email before re-sending by email', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-9', { requested: true, sent: true, channel: 'sms' }));
    const resend = vi.spyOn(api, 'sendRecordsIntakeLink');
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: sid });
    const r = (await runTool('send_records_form', { channel: 'email', call_sid: sid })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['email']);
    expect(resend).not.toHaveBeenCalled();
  });

  it('a failed re-send is a sentence to the caller and a stop to the model', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-FORM-10', { requested: true, sent: true, channel: 'sms' }));
    vi.spyOn(api, 'sendRecordsIntakeLink').mockResolvedValueOnce({ success: false, error: 'upstream 503' });
    const sid = freshSid();
    await runTool('file_records_ticket', { ...PATIENT, form_channel: 'sms', call_sid: sid });
    const r = (await runTool('send_records_form', { channel: 'sms', call_sid: sid })) as Out;
    expect(r.success).toBe(false);
    expect(String(r.message)).toMatch(/records team will send/i);
    expect(String(r.fix)).toMatch(/do not try again/i);
  });
});

describe('the plumbing', () => {
  it('the timeline can count the channel and the send, and nothing else about the form', () => {
    const src = readFileSync(join(__dirname, '..', 'services', 'toolTimeline.ts'), 'utf8');
    expect(src).toContain("'form_channel',");
    expect(src).toContain("'form_sent',");
  });

  it('the tool never sends a form on a ticket that left Medical Records', () => {
    const src = readFileSync(join(__dirname, 'medicalRecordsTools.ts'), 'utf8');
    expect(src).toMatch(/formChannel && !redirect \? 'pending_authorization' : cap\.pathway/);
    expect(src).toMatch(/\.\.\.\(formChannel && !redirect \? \{ formChannel \} : \{\}\)/);
  });
});

describe('v79 — the tool asks the channel when the model did not', () => {
  // The records lane's first business day on the runtime, 2026-09-28: four
  // real patient calls in the first hour, every create-ticket POST answering
  // `form: {requested:false}`, every patient case opened ON the clock with no
  // link, and not one funnel line in the transcripts. The model filed with no
  // channel, took the on-clock refusal for destination and dates, and walked
  // the old path. So the FIRST refusal on a patient request with no channel is
  // now the channel question itself.
  it('refuses a patient request with no channel by asking the channel question — nothing is filed', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const r = (await runTool('file_records_ticket', { ...PATIENT, call_sid: freshSid() })) as Out;

    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['form_channel']);
    expect(String(r.message)).toMatch(/mobile number that receives texts/i);
    expect(String(r.message)).toMatch(/by email/i);
    expect(String(r.fix)).toMatch(/verbal/);
    expect(String(r.fix)).toMatch(/do not ask where/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('asks ONCE: a second invocation still carrying no channel files with a text to the callback number, off the clock', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(
      filed('VA-FORM-V79', { requested: true, sent: true, channel: 'sms' }),
    );
    const sid = freshSid();
    const first = (await runTool('file_records_ticket', { ...PATIENT, call_sid: sid })) as Out;
    expect(first.missingFields).toEqual(['form_channel']);

    const r = (await runTool('file_records_ticket', { ...PATIENT, call_sid: sid })) as Out;
    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBe('sms');
    expect(p.requestPathway).toBe('pending_authorization');
    expect(p.capClockApplies).toBe(false);
    expect(String(p.description)).toContain('Send to: on the signed form');
    expect(r.form_channel).toBe('sms');
    expect(r.form_sent).toBe(true);
  });

  it('the ask is keyed on the call: another call is asked afresh', async () => {
    const a = (await runTool('file_records_ticket', { ...PATIENT, call_sid: freshSid() })) as Out;
    const b = (await runTool('file_records_ticket', { ...PATIENT, call_sid: freshSid() })) as Out;
    expect(a.missingFields).toEqual(['form_channel']);
    expect(b.missingFields).toEqual(['form_channel']);
  });

  it('a sentinel CallSid is asked every time — a shared counter would spend one caller’s ask on another', async () => {
    const a = (await runTool('file_records_ticket', { ...PATIENT, call_sid: 'unknown' })) as Out;
    const b = (await runTool('file_records_ticket', { ...PATIENT, call_sid: 'unknown' })) as Out;
    expect(a.missingFields).toEqual(['form_channel']);
    expect(b.missingFields).toEqual(['form_channel']);
  });

  it('"declined" is an answer: not asked again, the destination-and-dates gate takes over as before', async () => {
    const r = (await runTool('file_records_ticket', { ...PATIENT, form_channel: 'declined', call_sid: freshSid() })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['deliver_to', 'date_range']);
  });

  it('a lane that declares it cannot ask (on_clock_ask_exhausted — PCP) is not asked: files as today, gap noted', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-PCP-V79'));
    const r = (await runTool('file_records_ticket', { ...PATIENT, on_clock_ask_exhausted: true, call_sid: freshSid() })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBeUndefined();
    expect(p.requestPathway).toBe('roa_patient');
    expect(String(p.description)).toContain('Dates needed: NOT CAPTURED');
  });

  it('a third party is never asked: files with no channel and no question', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-3P-V79'));
    const r = (await runTool('file_records_ticket', {
      ...PATIENT,
      requester: 'I am an attorney at Lexitas',
      requester_type: 'legal',
      call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBeUndefined();
  });

  it('a caller who pressed the wrong option is not offered a form: an appointment request is redirected, not asked', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(filed('VA-HUB-V79'));
    const r = (await runTool('file_records_ticket', {
      ...PATIENT,
      request_description: 'I need to make an appointment for an eye exam',
      // The destination-and-dates gate predates v79 and still runs on a
      // redirected patient request; this test is about the CHANNEL question.
      deliver_to: 'to me',
      date_range: 'everything',
      call_sid: freshSid(),
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(p.formChannel).toBeUndefined();
    expect(p.departmentId).not.toBe(16);
  });

  it('the source: the redirect is decided BEFORE the channel ask, on the same words', () => {
    const src = readFileSync(join(__dirname, 'medicalRecordsTools.ts'), 'utf8');
    const redirectAt = src.indexOf("const redirect = detectCrossQueue(description, MEDICAL_RECORDS_DEPARTMENT_ID)");
    const askAt = src.indexOf("gateRefusalsSoFar(callSid, RECORDS_TOOL, FORM_CHANNEL_ASK)");
    expect(redirectAt).toBeGreaterThan(0);
    expect(askAt).toBeGreaterThan(redirectAt);
    // and it is decided exactly once
    expect(src.split('detectCrossQueue(description').length - 1).toBe(1);
  });
});
