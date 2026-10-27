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
