/**
 * Every case below is real department 16 ticket text from the 90 days to
 * 2026-08-13, or a close paraphrase of one. 453 of those 495 tickets carry no
 * reason at all, so "what would this have been filed as" has a real answer for
 * each of them: nothing.
 *
 * The hard part of this taxonomy is that EVERY request here is, literally, a
 * request for medical records. The tests that matter are the ordering ones —
 * the sentence that contains both the generic phrase and a specific one.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRecords,
  classifyRecordsRequest,
  recordsReasonById,
  RECORDS_CATCHALL,
  RECORDS_CLASSIFICATIONS,
  RECORDS_REASON_IDS,
} from './medicalRecordsTaxonomy';

const reason = (t: string) => classifyRecords(t)?.requestReasonId;

describe('a legal or plan requester outranks the generic phrase', () => {
  // All six contain "medical records" and would land on 500 if order were wrong.
  const cases: Array<[string, string]> = [
    ['Medical records request for Social Security office', 'SSA'],
    ['Medical Records Request for Medicare Risk Adjustment Review', 'risk adjustment'],
    ['Medical records request for patient from SCAN Health Plan', 'health plan'],
    ['Request for medical records fax number — Blue Shield of California', 'plan'],
    ['Medical Records Request from Lexitas', 'records-retrieval firm'],
    ['Medical records request involving power of attorney', 'legal'],
  ];
  for (const [text, why] of cases) {
    it(`${why}: "${text.slice(0, 46)}…"`, () => {
      expect(reason(text), text).toBe(503);
    });
  }

  it('catches an immigration attorney asking for proof of treatment', () => {
    // Real ticket: "request a form with proof that the pt is receiving medical
    // attention with us, as requested by his lawyer for immigration procedure".
    // Both 503 and 504 have a claim; the legal process is the stronger one.
    expect(reason('a form with proof that the patient is receiving medical attention, requested by his lawyer for immigration')).toBe(503);
  });
});

describe('records going to a clinician are not a patient copy', () => {
  const cases: string[] = [
    'Records for pcp request — please send to FAX 714 586-9011',
    'Request for patient consult notes for the referring doctor',
    'Requesting medical records to be faxed to Dr. Ann Warn\'s office',
    'Request to Fax Progress Note',
    'Request for latest progress note from March visit',
    'Patient wants the operative report sent to her primary care doctor',
  ];
  for (const text of cases) {
    it(`"${text.slice(0, 46)}…"`, () => {
      expect(reason(text), text).toBe(502);
    });
  }
});

describe('a letter or a form is not a chart copy', () => {
  it('a doctor\'s note', () => {
    // Real ticket: "request doctor's note for injection days. Day of and day
    // after if possible". Filing this as a records release sends it down a
    // release-of-information path it does not belong in.
    expect(reason("Patient called in to request doctor's note for injection days")).toBe(504);
  });

  it('a form to be filled out', () => {
    expect(reason('Patient needs us to fill out a form for her school')).toBe(504);
  });

  it('a work note', () => {
    expect(reason('She needs a note for work after her procedure')).toBe(504);
  });
});

describe('reading is not receiving', () => {
  it('an in-person review', () => {
    expect(reason('I would like to come in and review my chart')).toBe(501);
  });
  it('in Spanish', () => {
    expect(reason('Quiere revisar mi expediente')).toBe(501);
  });
});

describe('the plain patient request', () => {
  const cases: string[] = [
    'I need copy of my records',
    'Requesting copy of eye exam records',
    'Request for copy of most recent visit records',
    'Patient is requesting a copy of her medical records',
    'Caller requested their medical report',
  ];
  for (const text of cases) {
    it(`"${text.slice(0, 46)}…"`, () => {
      expect(reason(text), text).toBe(500);
    });
  }

  it('in Spanish, with and without accents', () => {
    expect(reason('Solicitud de copias impresas de récord médico')).toBe(500);
    expect(reason('Solicitud de copias impresas de record medico')).toBe(500);
  });
});

describe('it never refuses', () => {
  it('falls to department 16\'s own catch-all, not to another department\'s reason', () => {
    const r = classifyRecordsRequest('I have a question about something else entirely');
    expect(r.isCatchAll).toBe(true);
    expect(r.classification.requestReasonId).toBe(547);
    expect(r.classification.requestTypeId).toBe(77);
  });

  it('treats empty and whitespace as unclassifiable rather than throwing', () => {
    expect(classifyRecords('')).toBeNull();
    expect(classifyRecords('   ')).toBeNull();
    expect(classifyRecordsRequest('').isCatchAll).toBe(true);
  });
});

describe('the table itself', () => {
  it('only uses department 16 reasons', () => {
    // 500-504 plus the catch-all. A reason from another department here is the
    // bug that put 224 medication reasons in the HVA Hub.
    for (const id of RECORDS_REASON_IDS) {
      expect([500, 501, 502, 503, 504, 547]).toContain(id);
    }
  });

  it('puts the generic "copies" bucket last', () => {
    // The ordering this whole file depends on. If 500 ever moves up, every
    // test above starts passing for the wrong reason.
    const last = RECORDS_CLASSIFICATIONS[RECORDS_CLASSIFICATIONS.length - 1];
    expect(last.requestReasonId).toBe(500);
  });

  it('has no duplicate reason ids', () => {
    const ids = RECORDS_CLASSIFICATIONS.map((c) => c.requestReasonId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a pair up by id, and refuses one it does not own', () => {
    expect(recordsReasonById(503)?.requestReason).toBe('Records for Legal or Insurance');
    expect(recordsReasonById(547)).toBe(RECORDS_CATCHALL);
    expect(recordsReasonById(153)).toBeNull(); // a department 3 reason
  });
});
