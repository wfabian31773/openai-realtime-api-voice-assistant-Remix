/**
 * v118 — A THIRD PARTY'S RECORDS REQUEST STAYS IN MEDICAL RECORDS.
 *
 * THE CORPUS (RULE THREE). Real CallSids, measured 2026-10-26 from the Support
 * Center's `voice_agent_api_logs` and the Hub's `call_logs`. The transcripts
 * stay on disk and out of git; what is here is the SHAPE, with invented names.
 *
 *   CAe77013ec33233fea9c9ded4a7f3b593f  10-12  -> HVA Hub, 400, swept as VA-70894
 *   CA2b1d03ebf59648776fdd3571d8ffda32  10-21  -> HVA Hub, 400, swept as VA-75037
 *   CAbf509fa34564b4d034069bdd876f5298  10-22  -> HVA Hub, 400, swept as VA-75174
 *   CA7822c22042ffda9985857dcc8cf52821  10-23  -> dept 3,  400, swept as VA-75875
 *   CAaba4327b3855f7ff301d48dfcc6bf2c1  10-23  -> HVA Hub, 400, swept as VA-76103
 *   CA59b27f8ebe0417166be03caf5fc9550e  10-26  first filing reached dept 16, later ones -> HVA Hub, 400
 *   CA63467308b45e3e7f9118cde1b67be7bf  10-26  -> HVA Hub, 400, caller told to call back, swept as VA-76533
 *
 * Every refused POST carried `requestPathway` third_party_treatment,
 * third_party_plan or third_party_other, no patient name, and HVA Hub
 * department 9 / type 32 / reason 146 (six) or department 3 (one). The app
 * answered:
 *
 *   Missing required information: patientFirstName, patientLastName
 *   (only a Medical Records request may file without a patient name)
 *
 * THE CAUSE, CONFIRMED IN CODE rather than assumed: `detectCrossQueue` checks
 * SCHEDULING FIRST and the records-line hold does not cover scheduling (on
 * purpose — the operator's ruling sends appointments to the Hub from every
 * queue). `'eye exam'` is a reason-146 cue, so "the most recent eye exam
 * REPORT" reads as "schedule an eye exam" and leaves Medical Records before
 * the word "report" is ever consulted.
 *
 * These tests drive the REAL tool through `runTool`, against a stand-in for
 * the ticketing app that applies the app's own rule
 * (`namelessRequestVerdict`, ticketing-app `lib/voice-agent/unnamed-caller.ts`):
 * both names, or neither name on Medical Records — anything else is a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { NAME_NOT_CAPTURED_NOTE } from './medicalRecordsTools';
import { namesADocument, scheduledOnlyByAnExamName, EXAM_NAME_CUES, SCHEDULING } from './queueRouting';
import { resetGateAttempts } from './gateAttempts';
import { resetVerifiedIdentities } from './verifiedIdentity';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return {
    ...actual,
    TicketOutboxService: {
      writeToOutbox: vi.fn(async () => { throw new Error('synthetic outbox outage'); }),
    },
  };
});

const MEDICAL_RECORDS = 16;
const HVA_HUB = 9;

/** The corpus, by its real SIDs. No PHI: a CallSid is not a patient. */
const CORPUS = [
  { sid: 'CAe77013ec33233fea9c9ded4a7f3b593f', day: '2026-10-12', sentTo: HVA_HUB, swept: 'VA-70894' },
  { sid: 'CA2b1d03ebf59648776fdd3571d8ffda32', day: '2026-10-21', sentTo: HVA_HUB, swept: 'VA-75037' },
  { sid: 'CAbf509fa34564b4d034069bdd876f5298', day: '2026-10-22', sentTo: HVA_HUB, swept: 'VA-75174' },
  { sid: 'CA7822c22042ffda9985857dcc8cf52821', day: '2026-10-23', sentTo: 3, swept: 'VA-75875' },
  { sid: 'CAaba4327b3855f7ff301d48dfcc6bf2c1', day: '2026-10-23', sentTo: HVA_HUB, swept: 'VA-76103' },
  { sid: 'CA59b27f8ebe0417166be03caf5fc9550e', day: '2026-10-26', sentTo: HVA_HUB, swept: null },
  { sid: 'CA63467308b45e3e7f9118cde1b67be7bf', day: '2026-10-26', sentTo: HVA_HUB, swept: 'VA-76533' },
] as const;

/**
 * The three third-party pathways the refused POSTs carried, with a requester
 * line that resolves to each. Invented organisations.
 */
const THIRD_PARTIES = [
  { pathway: 'third_party_treatment', requester: "Dr. Example's office, a referring provider" },
  { pathway: 'third_party_plan', requester: 'Example Health Plan, chart review team' },
  { pathway: 'third_party_other', requester: 'Example Care Coordination' },
] as const;

/** The phrase the 2026-10-26 POSTs carried, word for word. */
const EXAM_REPORT = 'requesting the most recent eye exam report for the patient';

const NAMELESS_THIRD_PARTY = {
  callback_number: '845-555-0142',
  date_of_birth: '01/02/1950',
  deliver_to: 'fax 845-555-0199',
};

type Out = Record<string, unknown>;
type Params = Record<string, unknown>;

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

const APP_NAMELESS_400 =
  'Missing required information: patientFirstName, patientLastName ' +
  '(only a Medical Records request may file without a patient name)';
const APP_PARTIAL_400 =
  'Missing required information: patientFirstName, patientLastName ' +
  '(send both names, or neither on a Medical Records request)';

/**
 * The ticketing app's create-ticket, reduced to the one rule this defect is
 * about. Transcribed from `namelessRequestVerdict`, not invented.
 */
async function fakeApp() {
  const api = await client();
  let n = 0;
  const refusals: Params[] = [];
  const spy = vi.spyOn(api, 'createTicket').mockImplementation(async (raw) => {
    const p = raw as unknown as Params;
    const first = String(p.patientFirstName ?? '').trim();
    const last = String(p.patientLastName ?? '').trim();
    if ((first || last) && !(first && last)) {
      refusals.push(p);
      return { success: false, statusCode: 400, error: APP_PARTIAL_400 } as never;
    }
    if (!first && !last && p.departmentId !== MEDICAL_RECORDS) {
      refusals.push(p);
      return { success: false, statusCode: 400, error: APP_NAMELESS_400 } as never;
    }
    n += 1;
    return { success: true, ticketNumber: `VA-TEST-${n}` } as never;
  });
  return { spy, refusals, lastParams: () => spy.mock.calls[spy.mock.calls.length - 1]?.[0] as unknown as Params };
}

/** The first invocation spends the one name ask; the second files. */
async function fileNameless(args: Params): Promise<Out> {
  const asked = (await runTool('file_records_ticket', args)) as Out;
  expect(asked.success, 'the first invocation is the one name ask').toBe(false);
  expect(asked.missingFields).toEqual(['first_name', 'last_name']);
  return (await runTool('file_records_ticket', args)) as Out;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('the corpus: a third party asking for "the most recent eye exam report" files to Medical Records', () => {
  for (const call of CORPUS.filter((c) => c.sentTo === HVA_HUB)) {
    for (const tp of THIRD_PARTIES) {
      it(`${call.sid} (${call.day}) as ${tp.pathway}: department 16, no 400`, async () => {
        const app = await fakeApp();
        const r = await fileNameless({
          ...NAMELESS_THIRD_PARTY,
          requester: tp.requester,
          request_description: EXAM_REPORT,
          call_sid: call.sid,
        });

        expect(app.refusals, 'the app refused the payload').toEqual([]);
        expect(r.success, JSON.stringify(r)).toBe(true);
        expect(r.ticket_number).toMatch(/^VA-TEST-/);
        expect(r.routed_to).toBeUndefined();

        const p = app.lastParams();
        expect(p.departmentId).toBe(MEDICAL_RECORDS);
        expect(p.requestPathway).toBe(tp.pathway);
        expect(p.capClockApplies).toBe(false);
        // A records reason of department 16 — never the Hub's 146.
        expect(p.requestTypeId).not.toBe(32);
        expect(p.requestReasonId).not.toBe(146);
        expect(String(p.description)).not.toMatch(/scheduling request/i);
        // Filed AS a records request — not merely kept here because it had no
        // name (the belt-and-braces below would also land it in dept 16, and
        // this is what tells the two apart).
        expect(String((p.callData as Params).transcript ?? '')).not.toMatch(/KEPT IN MEDICAL RECORDS/);
      });
    }
  }

  it('a NAMED third party asking for the report also stays — this was never a scheduling request', async () => {
    const app = await fakeApp();
    const r = (await runTool('file_records_ticket', {
      ...NAMELESS_THIRD_PARTY,
      first_name: 'Testpatient',
      last_name: 'Example',
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: CORPUS[0].sid,
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().departmentId).toBe(MEDICAL_RECORDS);
    expect(r.routed_to).toBeUndefined();
  });

  it('holds on every document word the records line already trusts, not only "report"', async () => {
    for (const words of [
      'need the records from her last eye exam',
      'please fax the chart notes from the annual exam',
      'a copy of the dilated exam',
    ]) {
      resetGateAttempts();
      const app = await fakeApp();
      const r = (await runTool('file_records_ticket', {
        ...NAMELESS_THIRD_PARTY,
        first_name: 'Testpatient',
        last_name: 'Example',
        requester: THIRD_PARTIES[1].requester,
        request_description: words,
      })) as Out;
      expect(r.success, words).toBe(true);
      expect(app.lastParams().departmentId, words).toBe(MEDICAL_RECORDS);
      vi.restoreAllMocks();
    }
  });
});

describe('a third party\'s ordinary "note", "report" or "recorded line" is not a document (Codex P1 on #376)', () => {
  /**
   * The records-line hold matches `note`, `report` and `record` as
   * substrings. Read AHEAD of scheduling, it would keep these appointment
   * requests out of the Hub; the hold reads `namesADocument` instead.
   */
  for (const words of [
    'please note the patient needs to reschedule the eye exam',
    "I'm calling to report that the patient needs an eye exam",
    'calling on a recorded line to schedule an eye exam for our mutual patient',
    'the patient reports blurry vision and needs to schedule an eye exam',
    'leave a note for the doctor that the patient needs to reschedule',
    'for the record, the patient needs to reschedule the eye exam',
  ]) {
    it(`"${words}" still reaches the HVA Hub`, async () => {
      expect(namesADocument(words), 'ordinary speech must not count as a document').toBe(false);
      const app = await fakeApp();
      const r = (await runTool('file_records_ticket', {
        ...NAMELESS_THIRD_PARTY,
        first_name: 'Testpatient',
        last_name: 'Example',
        requester: THIRD_PARTIES[0].requester,
        request_description: words,
      })) as Out;
      expect(r.success, JSON.stringify(r)).toBe(true);
      expect(app.lastParams().departmentId, words).toBe(HVA_HUB);
    });
  }

  it('asks for the noun, and reads it as a document in a document phrase', () => {
    for (const doc of [
      EXAM_REPORT,
      'need the records from her last eye exam',
      'please fax the chart notes from the annual exam',
      'a copy of the dilated exam',
      'can you send the report from the retina consult',
      "her medical record from the last visit",
      'we need the office notes and the visit report',
      'necesitamos el expediente del paciente',
      'please send notes from her last visit',
    ]) {
      expect(namesADocument(doc), doc).toBe(true);
    }
  });
});

describe('a third party who names a document AND asks to schedule is scheduling (Codex P2 on #376)', () => {
  for (const [words, reason] of [
    ["we received the eye exam report and need to reschedule the patient's appointment", 147],
    ['we got the chart notes and need to schedule an appointment for the patient', 146],
    ['the visit report came through, please confirm my appointment for the patient', 149],
    ['we have the eye exam report, we need to cancel the appointment', 148],
    // An ask in words SCHEDULING does not list: only the exam name fires, and
    // it is not bound to the document, so the request is not held (head 48dde27).
    ['we have the chart notes and need to book an eye exam', 146],
    ['we have the chart notes and want to arrange a dilated exam', 146],
    // The exam name belongs to the report; the appointment ask is separate
    // and does not itself match a SCHEDULING cue.
    ['we received the eye exam report and need to set up a follow-up visit', 146],
    ['we received the eye exam report and want to arrange another office visit', 146],
    ['we received the eye exam report and need to book a follow-up appointment', 146],
    ['we received the eye exam report; the patient needs a return visit', 146],
    ['we would like another visit for the patient. We received the eye exam report', 146],
  ] as const) {
    it(`"${words}" reaches the HVA Hub (reason ${reason})`, async () => {
      const app = await fakeApp();
      const r = (await runTool('file_records_ticket', {
        ...NAMELESS_THIRD_PARTY,
        first_name: 'Testpatient',
        last_name: 'Example',
        requester: THIRD_PARTIES[0].requester,
        request_description: words,
      })) as Out;
      expect(r.success, JSON.stringify(r)).toBe(true);
      expect(app.lastParams().departmentId, words).toBe(HVA_HUB);
      expect(app.lastParams().requestReasonId, words).toBe(reason);
    });
  }

  it('the exam names are reason 146 cues, so the two lists cannot drift apart', () => {
    const newAppointment = SCHEDULING.find((s) => s.reasonId === 146)!;
    for (const name of EXAM_NAME_CUES) expect(newAppointment.cues, name).toContain(name);
  });

  it('an exam name alone is not an ask; an ask beside it is', () => {
    expect(scheduledOnlyByAnExamName(EXAM_REPORT)).toBe(true);
    expect(scheduledOnlyByAnExamName('necesitamos el informe del examen de la vista')).toBe(true);
    expect(scheduledOnlyByAnExamName('the eye exam report, and we need to reschedule')).toBe(false);
    expect(scheduledOnlyByAnExamName('please schedule an eye exam')).toBe(false);
    expect(scheduledOnlyByAnExamName('a copy of the chart')).toBe(false);
  });

  it('an exam name holds only when it is the document\'s subject', () => {
    for (const bound of [
      'need the records from her last eye exam',
      'please fax the chart notes from the annual exam',
      'a copy of the dilated exam',
      'the eye exam notes from last month please',
      'need the results of the most recent eye exam',
      'please send the eye exam report from the follow-up visit',
      'we need the follow-up visit report and the eye exam report',
    ]) expect(scheduledOnlyByAnExamName(bound), bound).toBe(true);
    for (const loose of [
      'we have the chart notes and need to book an eye exam',
      'the report came in; the patient is due for an eye exam',
      // bound once, loose once: the loose one is an ask
      'we have the eye exam report and the patient wants an eye exam',
      'we received the eye exam report and need to set up a follow-up visit',
      'we received the eye exam report and want to arrange another office visit',
    ]) expect(scheduledOnlyByAnExamName(loose), loose).toBe(false);
  });
});

describe('the guard: a genuine scheduling request on the records line still reaches the Hub', () => {
  it('a patient who wants to reschedule goes to the HVA Hub, as before', async () => {
    const app = await fakeApp();
    const r = (await runTool('file_records_ticket', {
      first_name: 'Testpatient',
      last_name: 'Example',
      date_of_birth: '01/02/1950',
      callback_number: '845-555-0142',
      requester: 'I am the patient',
      request_description: 'I need to reschedule my eye exam',
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().departmentId).toBe(HVA_HUB);
    expect(r.routed_to).toBe('HVA Hub');
  });

  it('a doctor\'s office booking an exam — no document named — goes to the HVA Hub', async () => {
    const app = await fakeApp();
    const r = (await runTool('file_records_ticket', {
      first_name: 'Testpatient',
      last_name: 'Example',
      date_of_birth: '01/02/1950',
      callback_number: '845-555-0142',
      requester: THIRD_PARTIES[0].requester,
      request_description: 'we need to schedule an eye exam for our mutual patient',
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().departmentId).toBe(HVA_HUB);
    expect(app.lastParams().requestReasonId).toBe(146);
  });

  it('a PATIENT is untouched: a document word beside an appointment ask still goes to the Hub (the operator\'s ruling)', async () => {
    // v118 changes the THIRD-PARTY pathways only. For a patient the
    // schedule-related-to-the-Hub ruling stands exactly as `detectCrossQueue`
    // applies it. (Whether a patient's "copy of my eye exam report" should
    // stay here too is a routing ruling for the operator, not this change.)
    const app = await fakeApp();
    const r = (await runTool('file_records_ticket', {
      first_name: 'Testpatient',
      last_name: 'Example',
      date_of_birth: '01/02/1950',
      callback_number: '845-555-0142',
      requester: 'I am the patient',
      // A phrase `namesADocument` DOES read as a document, so only the
      // third-party condition can be what sends this to the Hub.
      request_description: 'I got the visit notes you sent and I need to reschedule my appointment',
    })) as Out;
    expect(namesADocument('I got the visit notes you sent and I need to reschedule my appointment')).toBe(true);
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().departmentId).toBe(HVA_HUB);
  });

  it('a requester nobody could classify (third_party_other by default) asking to reschedule goes to the Hub', async () => {
    const app = await fakeApp();
    const r = (await runTool('file_records_ticket', {
      first_name: 'Testpatient',
      last_name: 'Example',
      date_of_birth: '01/02/1950',
      callback_number: '845-555-0142',
      requester: 'Testpatient',
      request_description: 'I have to reschedule my appointment next week',
    })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().requestPathway).toBe('third_party_other');
    expect(app.lastParams().departmentId).toBe(HVA_HUB);
  });
});

describe('belt and braces: a request still routed away with NO name files to Medical Records', () => {
  it('CA7822c22042… shape: a third party, a medication cue, no document word, no name — dept 16, no 400', async () => {
    // The department-3 POST's words are not in hand; this is the shape that
    // reaches department 3 from the records line (a medication cue with no
    // document word, so the records-line hold does not fire).
    const app = await fakeApp();
    const r = await fileNameless({
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: "the office is asking about the patient's eye drop medication",
      call_sid: CORPUS[3].sid,
    });
    expect(app.refusals).toEqual([]);
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = app.lastParams();
    expect(p.departmentId).toBe(MEDICAL_RECORDS);
    expect(r.routed_to).toBeUndefined();
    // The clerk is told why it is here and where it reads as belonging —
    // in the staff column, never the SMS body.
    const staff = String((p.callData as Params).transcript);
    expect(staff).toContain(NAME_NOT_CAPTURED_NOTE);
    expect(staff).toMatch(/Clinical Tech Support/);
    expect(staff).toMatch(/kept in Medical Records/i);
    expect(String(p.description)).not.toMatch(/kept in medical records|routed here/i);
    // Who asked is still stated: off the clock, and off the § V.B report.
    expect(p.requestPathway).toBe('third_party_treatment');
    expect(p.capClockApplies).toBe(false);
  });

  it('a nameless PATIENT who wants an appointment is filed in Medical Records — and is not asked for a form or records destination', async () => {
    const app = await fakeApp();
    const sid = 'CA' + 'a'.repeat(32);
    const args = {
      callback_number: '845-555-0142',
      date_of_birth: '01/02/1950',
      requester: 'I am the patient',
      request_description: 'I need to reschedule my appointment',
      call_sid: sid,
    };
    const r = await fileNameless(args);
    expect(app.refusals).toEqual([]);
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = app.lastParams();
    expect(p.departmentId).toBe(MEDICAL_RECORDS);
    // It still reads as the Hub's, so no signing link and no pending-auth case.
    expect(p.formChannel).toBeUndefined();
    expect(r.form_applies).toBe(false);
    // THE CAP PATH. The app opens a case for any dept-16 voice ticket, and a
    // stated pathway is taken with no review — so a stated `roa_patient`
    // here would put an appointment request on the statutory clock and the
    // § V.B population with nobody having looked. Left off, the app's
    // `pathway_review` gate makes a person decide.
    expect(p).not.toHaveProperty('requestPathway');
    expect(p).not.toHaveProperty('capClockApplies');
    expect(p).not.toHaveProperty('requestorType');
  });

  it('the re-send then refuses with a TRUE line: no form, and not "another team" — it stayed here', async () => {
    const app = await fakeApp();
    const api = await client();
    const resend = vi.spyOn(api, 'sendRecordsIntakeLink');
    const sid = 'CA' + '9'.repeat(32);
    await fileNameless({
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: "the office is asking about the patient's eye drop medication",
      call_sid: sid,
    });
    expect(app.lastParams().departmentId).toBe(MEDICAL_RECORDS);

    const r = (await runTool('send_records_form', { channel: 'sms', call_sid: sid })) as Out;
    expect(r.success).toBe(false);
    expect(resend).not.toHaveBeenCalled();
    expect(String(r.message)).toMatch(/no form to sign/i);
    expect(String(r.message)).not.toMatch(/another team/i);
    expect(String(r.fix)).toMatch(/do not call send_records_form again/i);
  });
});

describe('a refusal the caller cannot fix, and a transport failure', () => {
  // The refusal itself — the recovery ticket filed before the assurance — is
  // driven in recordsRefusalIsLoggedFirst.test.ts, which controls the outbox.
  it('a transport failure (not a refusal) is unchanged: retryable, and the outbox is the safety net', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValueOnce({ success: false, error: 'upstream 503' } as never);
    const r = (await runTool('file_records_ticket', {
      first_name: 'Testpatient',
      last_name: 'Example',
      date_of_birth: '01/02/1950',
      callback_number: '845-555-0142',
      requester: 'I am the patient',
      form_channel: 'declined',
      deliver_to: 'to me',
      date_range: 'everything',
      request_description: 'copy of my records',
    })) as Out;
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
  });
});

describe('the name the caller gave reaches the payload, whichever invocation it arrived in', () => {
  /**
   * CA63467308b45e3e7f9118cde1b67be7bf, the shape: the caller SPELLED the last
   * name, gave the date of birth twice, and gave the first name later. Each
   * half can reach the tool in a different invocation. Before v118 the tool
   * held neither across invocations, and once the one name ask was spent it
   * blanked a half name to nothing — so a name given in two parts reached the
   * POST as no name at all.
   */
  it('last name in one invocation, first name in a later one: the POST carries both', async () => {
    const app = await fakeApp();
    const sid = CORPUS[6].sid;
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: sid,
    };
    const asked = (await runTool('file_records_ticket', { ...base, last_name: 'Examplé' })) as Out;
    expect(asked.success).toBe(false);
    expect(asked.missingFields).toEqual(['first_name']);

    const r = (await runTool('file_records_ticket', { ...base, first_name: 'Testpatient' })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    const p = app.lastParams();
    expect(p.patientFirstName).toBe('Testpatient');
    expect(p.patientLastName).toBe('Examplé');
    expect(p.departmentId).toBe(MEDICAL_RECORDS);
  });

  it('a half name that never became whole still reaches the clerk, on the staff line', async () => {
    const app = await fakeApp();
    const sid = 'CA' + 'b'.repeat(32);
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: sid,
    };
    await runTool('file_records_ticket', base); // the one ask
    const r = (await runTool('file_records_ticket', { ...base, last_name: 'Examplé' })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.refusals, 'a half name is a 400 on the app').toEqual([]);
    const p = app.lastParams();
    expect(p).not.toHaveProperty('patientFirstName');
    expect(p).not.toHaveProperty('patientLastName');
    expect(String((p.callData as Params).transcript)).toMatch(/last name given on the call: Examplé/);
    expect(String(p.description)).not.toContain('Examplé');
  });

  it('a name carried on one call never reaches another call', async () => {
    const app = await fakeApp();
    const a = 'CA' + 'c'.repeat(32);
    const b = 'CA' + 'd'.repeat(32);
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
    };
    await runTool('file_records_ticket', { ...base, last_name: 'Examplé', call_sid: a });
    const other = (await runTool('file_records_ticket', { ...base, first_name: 'Otherpatient', call_sid: b })) as Out;
    expect(other.success).toBe(false);
    expect(other.missingFields).toEqual(['last_name']);
    expect(app.spy).not.toHaveBeenCalled();
  });

  it('a name carried for one patient never fills another patient on the same call (PCP patient_scope)', async () => {
    const app = await fakeApp();
    const sid = 'CA' + 'e'.repeat(32);
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: sid,
    };
    await runTool('file_records_ticket', { ...base, last_name: 'Examplé' });
    // The name ask is counted per CALL (a pre-existing rule this does not
    // touch), so the second patient may file without a name — but never
    // under the first patient's surname.
    await runTool('file_records_ticket', {
      ...base,
      first_name: 'Otherpatient',
      patient_scope: '-p2',
    });
    for (const [raw] of app.spy.mock.calls) {
      const p = raw as unknown as Params;
      expect(p.patientLastName).not.toBe('Examplé');
      expect(JSON.stringify(p.callData ?? {})).not.toContain('Examplé');
    }
  });

  it('a filed request forgets its halves — a later patient on the call never inherits the surname', async () => {
    const app = await fakeApp();
    const sid = 'CA' + '8'.repeat(32);
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: sid,
    };
    const filed = (await runTool('file_records_ticket', { ...base, first_name: 'Testpatient', last_name: 'Example' })) as Out;
    expect(filed.success).toBe(true);
    await runTool('file_records_ticket', { ...base, first_name: 'Otherpatient' });
    for (const [raw] of app.spy.mock.calls.slice(1)) {
      expect((raw as unknown as Params).patientLastName).not.toBe('Example');
    }
  });

  it('a name the model sends again replaces the carried half — the caller corrected it', async () => {
    const app = await fakeApp();
    const sid = 'CA' + 'f'.repeat(32);
    const base = {
      ...NAMELESS_THIRD_PARTY,
      requester: THIRD_PARTIES[0].requester,
      request_description: EXAM_REPORT,
      call_sid: sid,
    };
    const noDob = { ...base, date_of_birth: undefined };
    // 1. the misheard surname; the tool asks for the first name
    await runTool('file_records_ticket', { ...noDob, last_name: 'Exampel' });
    // 2. both halves, the surname corrected; refused for the date of birth
    const dobAsk = (await runTool('file_records_ticket', { ...noDob, first_name: 'Testpatient', last_name: 'Example' })) as Out;
    expect(dobAsk.missingFields).toEqual(['date_of_birth']);
    // 3. the date of birth, and the model leaves the surname out
    const r = (await runTool('file_records_ticket', { ...base, first_name: 'Testpatient' })) as Out;
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(app.lastParams().patientLastName).toBe('Example');
  });
});

describe('the source: one decision, before the channel ask', () => {
  it('the cross-queue redirect is still decided exactly once, on the same words', () => {
    const src = readFileSync(join(__dirname, 'medicalRecordsTools.ts'), 'utf8');
    expect(src.split('detectCrossQueue(description').length - 1).toBe(1);
  });
});
