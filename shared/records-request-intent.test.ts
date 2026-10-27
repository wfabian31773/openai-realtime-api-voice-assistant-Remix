import { describe, expect, it } from 'vitest';
import { recordsLinePurpose, recordsLineRedirect, recordsRequestText } from './records-request-intent';

describe('item #8 request evidence, independent of the model taxonomy', () => {
  it.each([
    'Please fax the notes before the appointment',
    'We have not received the records for our patient',
    'A health plan requests the chart for a risk adjustment audit',
    'The vendor requests copies of the medical records',
    'Necesito una copia de mi historial para mi cita',
    'the notes from the surgery, her PCP has not gotten the report',
    "I need a doctor's note",
    'Please email my results to my PCP',
    'Please provide my prescription',
    'I need my glasses prescription',
    'Copy of my records. Also, please reschedule my appointment.',
  ])('keeps the actual records request: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });
  it.each([
    ['I do not need records; please reschedule my appointment', 'scheduling'],
    ['I called the medical records office to cancel my appointment', 'scheduling'],
    ['Please note that I need to change my appointment', 'scheduling'],
    ['I need someone to explain my test results', 'clinical'],
    ['Reprogramar mi cita por favor', 'scheduling'],
    ['The vendor has an insurance eligibility question', 'professional'],
    ['I have an office question', 'unknown'],
    ['Our surgery center is checking insurance eligibility', 'professional'],
    ['Our surgical center has a referral authorization question', 'referral'],
    ['I called the surgery center to reschedule my eye exam', 'scheduling'],
    ['REASON FOR CALL: PATIENT REQUEST - on the records clock (CAP reportable).\n\nPlease reschedule my appointment', 'scheduling'],
  ])('does not create a records request: %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
    expect(recordsLineRedirect(text)?.departmentId).not.toBe(16);
  });
  it('removes only generated CAP fields and preserves the request', () => {
    const request = 'Please move my appointment to Friday';
    expect(recordsRequestText(`PATIENT REQUEST — on the records clock (CAP reportable).\n\n${request}\n\nRequested by: patient [patient]\nSend to: on the signed form\nDates needed: on the signed form`)).toBe(request);
  });
});


describe('self-review: preserve the supported records workflows', () => {
  it.each([
    'Please fax my OCT images to my doctor',
    'I need copies of the visual field test',
    'ROI request',
    'Send me everything',
    'I need a letter for work',
    'Revisar mi expediente',
    'I want to inspect my file',
    'I need a work note',
    'Please complete my DMV form',
    'Necesito mis registros medicos',
    'I need my records before I schedule an appointment',
    'I do not need my chart, but please fax my operative report',
  ])('keeps genuine records work: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    ['Do not send any records; please reschedule my appointment', 'scheduling'],
    ["Don't fax my chart. Please cancel my appointment", 'scheduling'],
    ['No need to send records; I have a billing question', 'billing'],
    ['I need to review my test results with the doctor', 'clinical'],
  ])('does not infer access from a refused or clinical request: %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
  });

  it.each([
    ['I need to be seen today', 151],
    ['Do you have any openings?', 150],
    ['I need an earlier appointment', 151],
    ['Confirmación de la cita', 149],
    ['Cancelación de la cita', 148],
    ['Quiero mover mi cita', 147],
  ])('preserves the established scheduling reason: %s', (text, reason) => {
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: reason });
  });
});


describe('review regressions: records evidence follows the caller request', () => {
  it.each([
    'test results', 'lab results', 'exam results', 'diagnostic results',
    'progress notes', 'consultation notes', 'visit notes', 'office notes',
    'surgery notes', 'surgical notes', 'operative notes', 'notes',
    'operative report', 'surgical report', 'optometry report', 'consultation report', 'op report', 'reports',
    'imaging', 'OCT images', 'visual field', 'VF', 'DRS', 'fundus images', 'topography',
    'documentation', 'historial', 'informes', 'results',
  ])('honors a refusal to send %s', document => {
    const text = `Don't send my ${document}; please reschedule my appointment`;
    expect(recordsLinePurpose(text)).toBe('scheduling');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
  });

  it.each([
    'Can someone explain the test results that were sent to me?',
    'Please interpret the lab results that were emailed to me',
    'I have a question about my exam results that were faxed',
    'I need to review the results that were mailed with my doctor',
  ])('keeps delivered results interpretation in clinical: %s', text => {
    expect(recordsLinePurpose(text)).toBe('clinical');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 3 });
  });

  it.each([
    "I don't need my whole chart, just send the operative report",
    "I don't need my chart, only fax the consultation notes",
    "I don't need my chart, but please send my test results",
    "I don't need my chart; please send my imaging",
    'I need documentation from my last visit',
    'Please send documentation from my last visit',
    'Documentation from my last visit',
  ])('preserves the affirmative document request: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });
});
